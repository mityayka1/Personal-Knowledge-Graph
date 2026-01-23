import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import {
  BriefResponse,
  BRIEF_CALLBACKS,
  BriefCallbackAction,
  isBriefCallback,
  parseBriefCallback,
  actionRequiresIndex,
  escapeHtml,
} from '@pkg/entities';
import { PkgCoreApiService } from '../../api/pkg-core-api.service';
import { BriefFormatterService } from '../services/brief-formatter.service';

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
    private readonly briefFormatter: BriefFormatterService,
  ) {}

  /**
   * Check if this handler can process the callback
   */
  canHandle(callbackData: string): boolean {
    return isBriefCallback(callbackData);
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

    // Parse and validate callback data
    const parsed = parseBriefCallback(callbackData);
    if (!parsed) {
      this.logger.warn(`Invalid callback data format: ${callbackData}`);
      await ctx.answerCbQuery('Invalid request');
      return;
    }

    const { action, briefId, index } = parsed;

    // Validate index for actions that require it
    if (actionRequiresIndex(action) && index === undefined) {
      this.logger.warn(`Missing index for action ${action}: ${callbackData}`);
      await ctx.answerCbQuery('Invalid index');
      return;
    }

    this.logger.log(`Brief action: ${action}, briefId=${briefId}, index=${index}`);

    try {
      let response: BriefResponse;

      switch (action) {
        case BRIEF_CALLBACKS.EXPAND:
          response = await this.pkgCoreApi.briefExpand(briefId, index!);
          break;

        case BRIEF_CALLBACKS.COLLAPSE:
          response = await this.pkgCoreApi.briefCollapse(briefId);
          break;

        case BRIEF_CALLBACKS.DONE:
          response = await this.pkgCoreApi.briefMarkDone(briefId, index!);
          break;

        case BRIEF_CALLBACKS.DISMISS:
          response = await this.pkgCoreApi.briefMarkDismissed(briefId, index!);
          break;

        case BRIEF_CALLBACKS.WRITE:
          await this.handleWriteAction(ctx, briefId, index!);
          return;

        case BRIEF_CALLBACKS.REMIND:
          await this.handleRemindAction(ctx, briefId, index!);
          return;

        case BRIEF_CALLBACKS.PREPARE:
          await this.handlePrepareAction(ctx, briefId, index!);
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

      // Format message and buttons locally using BriefFormatterService
      // This follows Source-Agnostic principle: pkg-core returns data, telegram-adapter handles presentation
      if (response.state) {
        const isAllDone = response.state.items.length === 0 && action === BRIEF_CALLBACKS.DONE;
        const isAllProcessed = response.state.items.length === 0 && action === BRIEF_CALLBACKS.DISMISS;

        let formattedMessage: string;
        let buttons: Array<Array<{ text: string; callback_data: string }>>;

        if (isAllDone) {
          formattedMessage = this.briefFormatter.formatAllDoneMessage();
          buttons = [];
        } else if (isAllProcessed) {
          formattedMessage = this.briefFormatter.formatAllProcessedMessage();
          buttons = [];
        } else {
          formattedMessage = this.briefFormatter.formatMessage(response.state);
          buttons = this.briefFormatter.getButtons(response.state);
        }

        await ctx.editMessageText(formattedMessage, {
          parse_mode: 'HTML',
          reply_markup: buttons.length
            ? {
                inline_keyboard: buttons.map((row) =>
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to process brief action: ${errorMessage}`, error);

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
        `💬 Чтобы написать сообщение для <b>${escapeHtml(item.entityName)}</b>, ` +
          `используй команду:\n\n<code>/act напиши ${escapeHtml(item.entityName)} ...</code>`,
        { parse_mode: 'HTML' },
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to handle write action: ${errorMessage}`, error);
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
        `🔔 Чтобы напомнить <b>${escapeHtml(item.entityName)}</b>, ` +
          `используй команду:\n\n<code>/act напомни ${escapeHtml(item.entityName)} о ...</code>`,
        { parse_mode: 'HTML' },
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to handle remind action: ${errorMessage}`, error);
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
          `📋 Готовлю brief для <b>${escapeHtml(item.entityName)}</b>...\n\n` +
            `Используй команду <code>/prepare ${escapeHtml(item.entityName)}</code> для полного brief.`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.reply(
          `📋 Чтобы получить brief для <b>${escapeHtml(item.entityName)}</b>, ` +
            `используй команду:\n\n<code>/prepare ${escapeHtml(item.entityName)}</code>`,
          { parse_mode: 'HTML' },
        );
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to handle prepare action: ${errorMessage}`, error);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  private getActionFeedback(action: BriefCallbackAction, message?: string): string {
    if (message) {
      return message.length > 50 ? message.substring(0, 47) + '...' : message;
    }

    switch (action) {
      case BRIEF_CALLBACKS.EXPAND:
        return '📖';
      case BRIEF_CALLBACKS.COLLAPSE:
        return '📋';
      case BRIEF_CALLBACKS.DONE:
        return '✅ Готово';
      case BRIEF_CALLBACKS.DISMISS:
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
}
