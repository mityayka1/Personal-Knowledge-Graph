import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { PkgCoreApiService } from '../../api/pkg-core-api.service';

/**
 * Handles callback queries from extracted event notification buttons
 * Callback data format: "event_<action>:<eventId>"
 * Actions: confirm, reject, reschedule, remind
 */
@Injectable()
export class EventCallbackHandler {
  private readonly logger = new Logger(EventCallbackHandler.name);

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  /**
   * Check if this handler can process the callback
   */
  canHandle(callbackData: string): boolean {
    return callbackData.startsWith('event_') || callbackData.startsWith('digest_');
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

    // Handle digest batch actions
    if (callbackData.startsWith('digest_')) {
      return this.handleDigestAction(ctx, callbackData);
    }

    // Handle single event actions
    const [actionPart, eventId] = callbackData.split(':');
    const action = actionPart.replace('event_', '');

    if (!eventId) {
      await ctx.answerCbQuery('Invalid callback data');
      return;
    }

    this.logger.log(`Event callback: action=${action}, eventId=${eventId}`);

    switch (action) {
      case 'confirm':
        await this.handleConfirm(ctx, eventId);
        break;
      case 'reject':
        await this.handleReject(ctx, eventId);
        break;
      case 'reschedule':
        await this.handleReschedule(ctx, eventId);
        break;
      case 'remind':
        await this.handleRemind(ctx, eventId);
        break;
      default:
        await ctx.answerCbQuery('Unknown action');
    }
  }

  /**
   * Handle digest batch actions (confirm_all, reject_all)
   */
  private async handleDigestAction(ctx: Context, callbackData: string): Promise<void> {
    const [action, idsString] = callbackData.split(':');
    const ids = idsString?.split(',').filter(Boolean) || [];

    if (ids.length === 0) {
      await ctx.answerCbQuery('No events to process');
      return;
    }

    this.logger.log(`Digest action: ${action} for ${ids.length} events`);

    if (action === 'digest_confirm_all') {
      let successCount = 0;
      for (const id of ids) {
        try {
          const result = await this.pkgCoreApi.confirmExtractedEvent(id);
          if (result.success) successCount++;
        } catch (error) {
          this.logger.warn(`Failed to confirm event ${id}:`, error);
        }
      }
      await ctx.answerCbQuery(`Подтверждено ${successCount}/${ids.length}`);
      await this.updateMessageWithResult(ctx, `Подтверждено ${successCount} событий`);
    } else if (action === 'digest_reject_all') {
      let successCount = 0;
      for (const id of ids) {
        try {
          const result = await this.pkgCoreApi.rejectExtractedEvent(id);
          if (result.success) successCount++;
        } catch (error) {
          this.logger.warn(`Failed to reject event ${id}:`, error);
        }
      }
      await ctx.answerCbQuery(`Отклонено ${successCount}/${ids.length}`);
      await this.updateMessageWithResult(ctx, `Отклонено ${successCount} событий`);
    } else {
      await ctx.answerCbQuery('Unknown digest action');
    }
  }

  private async handleConfirm(ctx: Context, eventId: string): Promise<void> {
    try {
      const result = await this.pkgCoreApi.confirmExtractedEvent(eventId);

      if (result.success) {
        await ctx.answerCbQuery('Событие подтверждено');
        await this.updateMessageWithResult(ctx, 'Событие подтверждено и добавлено в календарь');
      } else {
        await ctx.answerCbQuery(result.error || 'Ошибка при подтверждении');
      }
    } catch (error) {
      this.logger.error(`Failed to confirm event ${eventId}:`, error);
      await ctx.answerCbQuery('Ошибка сервера');
    }
  }

  private async handleReject(ctx: Context, eventId: string): Promise<void> {
    try {
      const result = await this.pkgCoreApi.rejectExtractedEvent(eventId);

      if (result.success) {
        await ctx.answerCbQuery('Событие отклонено');
        await this.updateMessageWithResult(ctx, 'Событие отклонено');
      } else {
        await ctx.answerCbQuery(result.error || 'Ошибка');
      }
    } catch (error) {
      this.logger.error(`Failed to reject event ${eventId}:`, error);
      await ctx.answerCbQuery('Ошибка сервера');
    }
  }

  private async handleReschedule(ctx: Context, eventId: string): Promise<void> {
    // For now, just show a message that this feature is coming
    await ctx.answerCbQuery('Функция в разработке');
    // TODO: Implement rescheduling flow with inline date/time picker
  }

  private async handleRemind(ctx: Context, eventId: string): Promise<void> {
    // For now, just show a message that this feature is coming
    await ctx.answerCbQuery('Функция в разработке');
    // TODO: Implement remind later flow with time selection
  }

  private async updateMessageWithResult(ctx: Context, resultText: string): Promise<void> {
    try {
      const message = ctx.callbackQuery?.message;
      if (message && 'text' in message) {
        // Update message text and remove buttons
        await ctx.editMessageText(`${message.text}\n\n_${resultText}_`, {
          parse_mode: 'Markdown',
        });
      }
    } catch (error) {
      // Ignore errors from editing message (might be too old, etc.)
      this.logger.warn('Could not update message:', error);
    }
  }
}
