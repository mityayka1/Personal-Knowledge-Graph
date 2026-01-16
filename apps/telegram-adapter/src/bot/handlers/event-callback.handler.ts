import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { PkgCoreApiService } from '../../api/pkg-core-api.service';

/**
 * Handles callback queries from extracted event notification buttons.
 *
 * Callback data format (unified):
 * - d_c:<shortId> — confirm event(s)
 * - d_r:<shortId> — reject event(s)
 * - d_rm:<shortId> — create reminder (+7 days)
 * - d_rs:<shortId> — show reschedule options
 * - d_rsd:<shortId>:<days> — apply reschedule with specific days
 *
 * Short ID is resolved to event UUIDs via Redis through pkg-core API.
 */
@Injectable()
export class EventCallbackHandler {
  private readonly logger = new Logger(EventCallbackHandler.name);

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  /**
   * Check if this handler can process the callback
   */
  canHandle(callbackData: string): boolean {
    return (
      callbackData.startsWith('d_c:') ||
      callbackData.startsWith('d_r:') ||
      callbackData.startsWith('d_rm:') ||
      callbackData.startsWith('d_rs:') ||
      callbackData.startsWith('d_rsd:')
    );
  }

  /**
   * Handle callback query
   */
  async handle(ctx: Context): Promise<void> {
    const callbackQuery = ctx.callbackQuery;
    if (!callbackQuery || !('data' in callbackQuery)) {
      return;
    }

    const callbackData = callbackQuery.data;

    if (!this.canHandle(callbackData)) {
      this.logger.warn(`Unknown callback data format: ${callbackData}`);
      await ctx.answerCbQuery('Unknown action');
      return;
    }

    // Handle reschedule with days: d_rsd:<shortId>:<days>
    if (callbackData.startsWith('d_rsd:')) {
      await this.handleRescheduleWithDays(ctx, callbackData);
      return;
    }

    // Handle show reschedule options: d_rs:<shortId>
    if (callbackData.startsWith('d_rs:')) {
      await this.handleShowRescheduleOptions(ctx, callbackData);
      return;
    }

    // Handle remind: d_rm:<shortId>
    if (callbackData.startsWith('d_rm:')) {
      await this.handleRemind(ctx, callbackData);
      return;
    }

    // Handle confirm/reject: d_c: or d_r:
    const isConfirm = callbackData.startsWith('d_c:');
    const shortId = callbackData.substring(4); // Remove 'd_c:' or 'd_r:'

    this.logger.log(`Digest action: ${isConfirm ? 'confirm' : 'reject'}, shortId=${shortId}`);

    try {
      // Get event IDs from Redis via pkg-core API
      const eventIds = await this.pkgCoreApi.getDigestEventIds(shortId);

      if (!eventIds || eventIds.length === 0) {
        await ctx.answerCbQuery('Действие истекло. Повторите запрос.');
        return;
      }

      let successCount = 0;
      for (const eventId of eventIds) {
        try {
          const result = isConfirm
            ? await this.pkgCoreApi.confirmExtractedEvent(eventId)
            : await this.pkgCoreApi.rejectExtractedEvent(eventId);
          if (result.success) successCount++;
        } catch (error) {
          this.logger.warn(`Failed to ${isConfirm ? 'confirm' : 'reject'} event ${eventId}:`, error);
        }
      }

      const actionText = isConfirm ? 'Подтверждено' : 'Отклонено';
      const countText = eventIds.length === 1 ? '' : ` ${successCount}/${eventIds.length}`;

      await ctx.answerCbQuery(`${actionText}${countText}`);
      await this.updateMessageWithResult(
        ctx,
        eventIds.length === 1
          ? actionText
          : `${actionText} ${successCount} событий`,
      );
    } catch (error) {
      this.logger.error(`Failed to process digest action:`, error);
      await ctx.answerCbQuery('Ошибка сервера');
    }
  }

  /**
   * Handle remind action - create reminder +7 days
   */
  private async handleRemind(ctx: Context, callbackData: string): Promise<void> {
    const shortId = callbackData.substring(5); // Remove 'd_rm:'
    this.logger.log(`Remind action, shortId=${shortId}`);

    try {
      const eventIds = await this.pkgCoreApi.getDigestEventIds(shortId);

      if (!eventIds || eventIds.length === 0) {
        await ctx.answerCbQuery('Действие истекло. Повторите запрос.');
        return;
      }

      // Remind only first event (remind is typically for single events)
      const eventId = eventIds[0];
      const result = await this.pkgCoreApi.remindExtractedEvent(eventId);

      if (result.success) {
        await ctx.answerCbQuery('Напоминание создано');
        await this.updateMessageWithResult(ctx, 'Напоминание через 7 дней');
      } else {
        await ctx.answerCbQuery('Не удалось создать напоминание');
      }
    } catch (error) {
      this.logger.error(`Failed to create reminder:`, error);
      await ctx.answerCbQuery('Ошибка сервера');
    }
  }

  /**
   * Show reschedule options (inline keyboard with presets)
   */
  private async handleShowRescheduleOptions(ctx: Context, callbackData: string): Promise<void> {
    const shortId = callbackData.substring(5); // Remove 'd_rs:'
    this.logger.log(`Show reschedule options, shortId=${shortId}`);

    try {
      // Show inline keyboard with reschedule presets
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [
            { text: 'Завтра', callback_data: `d_rsd:${shortId}:1` },
            { text: '+2 дня', callback_data: `d_rsd:${shortId}:2` },
            { text: '+7 дней', callback_data: `d_rsd:${shortId}:7` },
          ],
          [
            { text: '« Назад', callback_data: `d_c:${shortId}` }, // Back to original buttons
          ],
        ],
      });
      await ctx.answerCbQuery('Выберите новую дату');
    } catch (error) {
      this.logger.error(`Failed to show reschedule options:`, error);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  /**
   * Apply reschedule with specific days
   */
  private async handleRescheduleWithDays(ctx: Context, callbackData: string): Promise<void> {
    // Format: d_rsd:<shortId>:<days>
    const parts = callbackData.split(':');
    if (parts.length !== 3) {
      await ctx.answerCbQuery('Неверный формат');
      return;
    }

    const shortId = parts[1];
    const days = parseInt(parts[2], 10);

    if (isNaN(days) || days < 1) {
      await ctx.answerCbQuery('Неверное количество дней');
      return;
    }

    this.logger.log(`Reschedule action, shortId=${shortId}, days=${days}`);

    try {
      const eventIds = await this.pkgCoreApi.getDigestEventIds(shortId);

      if (!eventIds || eventIds.length === 0) {
        await ctx.answerCbQuery('Действие истекло. Повторите запрос.');
        return;
      }

      // Reschedule only first event
      const eventId = eventIds[0];
      const result = await this.pkgCoreApi.rescheduleExtractedEvent(eventId, days);

      if (result.success) {
        const dateText = this.formatDateText(days);
        await ctx.answerCbQuery(`Перенесено на ${dateText}`);
        await this.updateMessageWithResult(ctx, `Перенесено на ${dateText}`);
      } else {
        await ctx.answerCbQuery('Не удалось перенести');
      }
    } catch (error) {
      this.logger.error(`Failed to reschedule:`, error);
      await ctx.answerCbQuery('Ошибка сервера');
    }
  }

  private formatDateText(days: number): string {
    if (days === 1) return 'завтра';
    if (days === 2) return 'послезавтра';
    if (days === 7) return 'через неделю';
    return `через ${days} дней`;
  }

  private async updateMessageWithResult(ctx: Context, resultText: string): Promise<void> {
    try {
      const message = ctx.callbackQuery?.message;
      if (message && 'text' in message) {
        // Update message text and remove buttons
        await ctx.editMessageText(`${message.text}\n\n<i>${resultText}</i>`, {
          parse_mode: 'HTML',
        });
      }
    } catch (error) {
      // Ignore errors from editing message (might be too old, etc.)
      this.logger.warn('Could not update message:', error);
    }
  }
}
