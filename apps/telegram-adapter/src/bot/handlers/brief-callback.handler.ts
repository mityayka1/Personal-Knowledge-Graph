import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Context } from 'telegraf';
import { PkgCoreApiService, BriefResponse } from '../../api/pkg-core-api.service';
import { BotService } from '../bot.service';

/**
 * Handles callback queries from Morning Brief accordion buttons.
 *
 * Callback data format:
 * - br_e:<briefId>:<index> — expand item
 * - br_c:<briefId>         — collapse all
 * - br_d:<briefId>:<index> — mark done
 * - br_x:<briefId>:<index> — mark dismissed
 * - br_w:<briefId>:<index> — write message
 * - br_r:<briefId>:<index> — remind (follow-up)
 * - br_p:<briefId>:<index> — prepare brief
 */
@Injectable()
export class BriefCallbackHandler {
  private readonly logger = new Logger(BriefCallbackHandler.name);

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
      callbackData.startsWith('br_e:') ||
      callbackData.startsWith('br_c:') ||
      callbackData.startsWith('br_d:') ||
      callbackData.startsWith('br_x:') ||
      callbackData.startsWith('br_w:') ||
      callbackData.startsWith('br_r:') ||
      callbackData.startsWith('br_p:')
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

    // Parse action and parameters
    const parts = callbackData.split(':');
    const action = parts[0]; // br_e, br_c, br_d, br_x, br_w, br_r, br_p
    const briefId = parts[1];
    const index = parts[2] ? parseInt(parts[2], 10) : undefined;

    this.logger.log(`Brief action: ${action}, briefId=${briefId}, index=${index}`);

    try {
      let response: BriefResponse;

      switch (action) {
        case 'br_e':
          // Expand item
          if (index === undefined) {
            await ctx.answerCbQuery('Invalid index');
            return;
          }
          response = await this.pkgCoreApi.briefExpand(briefId, index);
          break;

        case 'br_c':
          // Collapse all
          response = await this.pkgCoreApi.briefCollapse(briefId);
          break;

        case 'br_d':
          // Mark as done
          if (index === undefined) {
            await ctx.answerCbQuery('Invalid index');
            return;
          }
          response = await this.pkgCoreApi.briefMarkDone(briefId, index);
          break;

        case 'br_x':
          // Mark as dismissed
          if (index === undefined) {
            await ctx.answerCbQuery('Invalid index');
            return;
          }
          response = await this.pkgCoreApi.briefMarkDismissed(briefId, index);
          break;

        case 'br_w':
          // Write message action
          if (index === undefined) {
            await ctx.answerCbQuery('Invalid index');
            return;
          }
          await this.handleWriteAction(ctx, briefId, index);
          return;

        case 'br_r':
          // Remind action
          if (index === undefined) {
            await ctx.answerCbQuery('Invalid index');
            return;
          }
          await this.handleRemindAction(ctx, briefId, index);
          return;

        case 'br_p':
          // Prepare brief action
          if (index === undefined) {
            await ctx.answerCbQuery('Invalid index');
            return;
          }
          await this.handlePrepareAction(ctx, briefId, index);
          return;

        default:
          await ctx.answerCbQuery('Unknown action');
          return;
      }

      // Process response from expand/collapse/done/dismiss
      if (!response.success) {
        await ctx.answerCbQuery(response.error || 'Ошибка');
        return;
      }

      // Update message with new state
      if (response.formattedMessage) {
        await ctx.editMessageText(response.formattedMessage, {
          parse_mode: 'HTML',
          reply_markup: response.buttons?.length
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
      }

      // Feedback for action
      const feedbackText = this.getActionFeedback(action, response.message);
      await ctx.answerCbQuery(feedbackText);
    } catch (error) {
      this.logger.error(`Failed to process brief action:`, error);

      // Check if it's a "message not modified" error
      if (this.isMessageNotModifiedError(error)) {
        await ctx.answerCbQuery();
        return;
      }

      await ctx.answerCbQuery('Ошибка сервера');
    }
  }

  /**
   * Handle "write message" action - initiate message composition
   */
  private async handleWriteAction(ctx: Context, briefId: string, index: number): Promise<void> {
    try {
      const response = await this.pkgCoreApi.briefAction(briefId, index, 'write');

      if (!response.success) {
        await ctx.answerCbQuery(response.error || 'Ошибка');
        return;
      }

      // Get item info for context
      const item = response.state?.items[index];
      if (!item) {
        await ctx.answerCbQuery('Элемент не найден');
        return;
      }

      // Notify user that write action is triggered
      // In full implementation, this would integrate with the Act command
      await ctx.answerCbQuery(`💬 Написать ${item.entityName}`);

      // Send a separate message with prompt to use /act command
      await ctx.reply(
        `💬 Чтобы написать сообщение для <b>${this.escapeHtml(item.entityName)}</b>, ` +
          `используй команду:\n\n<code>/act напиши ${this.escapeHtml(item.entityName)} ...</code>`,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      this.logger.error('Failed to handle write action:', error);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  /**
   * Handle "remind" action - create follow-up reminder
   */
  private async handleRemindAction(ctx: Context, briefId: string, index: number): Promise<void> {
    try {
      const response = await this.pkgCoreApi.briefAction(briefId, index, 'remind');

      if (!response.success) {
        await ctx.answerCbQuery(response.error || 'Ошибка');
        return;
      }

      const item = response.state?.items[index];
      if (!item) {
        await ctx.answerCbQuery('Элемент не найден');
        return;
      }

      await ctx.answerCbQuery(`🔔 Напоминание для ${item.entityName}`);

      // Send prompt for /act remind command
      await ctx.reply(
        `🔔 Чтобы напомнить <b>${this.escapeHtml(item.entityName)}</b>, ` +
          `используй команду:\n\n<code>/act напомни ${this.escapeHtml(item.entityName)} о ...</code>`,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      this.logger.error('Failed to handle remind action:', error);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  /**
   * Handle "prepare brief" action - generate meeting brief
   */
  private async handlePrepareAction(ctx: Context, briefId: string, index: number): Promise<void> {
    try {
      const response = await this.pkgCoreApi.briefAction(briefId, index, 'prepare');

      if (!response.success) {
        await ctx.answerCbQuery(response.error || 'Ошибка');
        return;
      }

      const item = response.state?.items[index];
      if (!item) {
        await ctx.answerCbQuery('Элемент не найден');
        return;
      }

      await ctx.answerCbQuery(`📋 Подготовка brief...`);

      // Trigger /prepare command for this entity
      if (item.entityId) {
        await ctx.reply(
          `📋 Готовлю brief для <b>${this.escapeHtml(item.entityName)}</b>...\n\n` +
            `Используй команду <code>/prepare ${this.escapeHtml(item.entityName)}</code> для полного brief.`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.reply(
          `📋 Чтобы получить brief для <b>${this.escapeHtml(item.entityName)}</b>, ` +
            `используй команду:\n\n<code>/prepare ${this.escapeHtml(item.entityName)}</code>`,
          { parse_mode: 'HTML' },
        );
      }
    } catch (error) {
      this.logger.error('Failed to handle prepare action:', error);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  private getActionFeedback(action: string, message?: string): string {
    if (message) {
      return message.length > 50 ? message.substring(0, 47) + '...' : message;
    }

    switch (action) {
      case 'br_e':
        return '📖';
      case 'br_c':
        return '📋';
      case 'br_d':
        return '✅ Готово';
      case 'br_x':
        return '➖ Не актуально';
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

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
