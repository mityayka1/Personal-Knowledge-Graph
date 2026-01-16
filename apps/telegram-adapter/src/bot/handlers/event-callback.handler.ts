import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { PkgCoreApiService } from '../../api/pkg-core-api.service';

/**
 * Handles callback queries from extracted event notification buttons.
 *
 * Callback data format (unified):
 * - d_c:<shortId> — confirm event(s)
 * - d_r:<shortId> — reject event(s)
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
    return callbackData.startsWith('d_c:') || callbackData.startsWith('d_r:');
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
