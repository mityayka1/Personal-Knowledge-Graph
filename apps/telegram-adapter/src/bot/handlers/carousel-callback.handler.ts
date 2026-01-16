import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Context } from 'telegraf';
import { PkgCoreApiService, CarouselNavResponse } from '../../api/pkg-core-api.service';
import { BotService } from '../bot.service';

/**
 * Handles callback queries from carousel navigation buttons.
 *
 * Callback data format:
 * - car_p:<carouselId> — previous event
 * - car_n:<carouselId> — next event
 * - car_c:<carouselId> — confirm current event
 * - car_r:<carouselId> — reject current event
 */
@Injectable()
export class CarouselCallbackHandler {
  private readonly logger = new Logger(CarouselCallbackHandler.name);

  constructor(
    private readonly pkgCoreApi: PkgCoreApiService,
    @Inject(forwardRef(() => BotService))
    private readonly botService: BotService,
  ) {}

  /**
   * Check if this handler can process the callback
   */
  canHandle(callbackData: string): boolean {
    return (
      callbackData.startsWith('car_p:') ||
      callbackData.startsWith('car_n:') ||
      callbackData.startsWith('car_c:') ||
      callbackData.startsWith('car_r:')
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

    // Parse action and carousel ID
    const action = callbackData.substring(0, 5); // car_p, car_n, car_c, car_r
    const carouselId = callbackData.substring(6); // Everything after "car_X:"

    this.logger.log(`Carousel action: ${action}, carouselId=${carouselId}`);

    try {
      let response: CarouselNavResponse;

      switch (action) {
        case 'car_p':
          response = await this.pkgCoreApi.carouselPrev(carouselId);
          break;
        case 'car_n':
          response = await this.pkgCoreApi.carouselNext(carouselId);
          break;
        case 'car_c':
          response = await this.pkgCoreApi.carouselConfirm(carouselId);
          break;
        case 'car_r':
          response = await this.pkgCoreApi.carouselReject(carouselId);
          break;
        default:
          await ctx.answerCbQuery('Unknown action');
          return;
      }

      if (!response.success) {
        await ctx.answerCbQuery(response.error || 'Ошибка');
        return;
      }

      if (response.complete) {
        // Carousel is complete - update message with final text (no buttons)
        await ctx.editMessageText(response.message || 'Все события обработаны', {
          parse_mode: 'HTML',
        });
        await ctx.answerCbQuery(`Обработано ${response.processedCount} событий`);
      } else {
        // Update message with new event card
        await ctx.editMessageText(response.message || '', {
          parse_mode: 'HTML',
          reply_markup: response.buttons
            ? {
                inline_keyboard: response.buttons.map((row) =>
                  row.map((btn) => ({
                    text: btn.text,
                    callback_data: btn.callback_data,
                  })),
                ),
              }
            : undefined,
        });

        // Feedback for action
        const feedbackText = this.getActionFeedback(action);
        await ctx.answerCbQuery(feedbackText);
      }
    } catch (error) {
      this.logger.error(`Failed to process carousel action:`, error);

      // Check if it's a "message not modified" error (user clicked same button twice quickly)
      if (this.isMessageNotModifiedError(error)) {
        await ctx.answerCbQuery();
        return;
      }

      await ctx.answerCbQuery('Ошибка сервера');
    }
  }

  private getActionFeedback(action: string): string {
    switch (action) {
      case 'car_p':
        return '◀️';
      case 'car_n':
        return '▶️';
      case 'car_c':
        return '✅ Подтверждено';
      case 'car_r':
        return '❌ Отклонено';
      default:
        return '';
    }
  }

  private isMessageNotModifiedError(error: unknown): boolean {
    if (error instanceof Error) {
      return error.message.includes('message is not modified');
    }
    return false;
  }
}
