import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import {
  PkgCoreApiService,
  RecallSource,
  PendingApprovalItem,
} from '../../api/pkg-core-api.service';
import { DailyContextCacheService } from '../../common/cache';

/** Callback prefix for daily summary actions */
const DAILY_CALLBACK_PREFIX = 'ds_';

/** Callback prefix for pending approval actions */
const PENDING_APPROVAL_PREFIX = 'pa_';

/** Valid model values */
type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

/**
 * Handler for /daily command — comprehensive daily summary using LLM recall
 *
 * Features:
 * - AI-powered daily summary via /agent/recall
 * - Optional focus topic: /daily [topic]
 * - Reply-based follow-up: reply to any bot message to continue dialog
 * - Save insights: save conclusions as facts to owner entity
 */
@Injectable()
export class DailySummaryHandler {
  private readonly logger = new Logger(DailySummaryHandler.name);
  private readonly miniAppUrl: string | undefined;

  constructor(
    private readonly pkgCoreApi: PkgCoreApiService,
    private readonly dailyContextCache: DailyContextCacheService,
    private readonly configService: ConfigService,
  ) {
    // Support both MINI_APP_URL and TELEGRAM_MINI_APP_URL for backward compatibility
    this.miniAppUrl =
      this.configService.get<string>('MINI_APP_URL') ||
      this.configService.get<string>('TELEGRAM_MINI_APP_URL');
  }

  /**
   * Generate Mini App URL for deep linking.
   * Format: https://t.me/BotUsername/app?startapp=<type>_<id>
   */
  private getMiniAppButton(
    type: 'extraction' | 'brief' | 'recall' | 'entity' | 'approval',
    id: string,
    text = '📱 Открыть в приложении',
  ): { text: string; web_app: { url: string } } | null {
    if (!this.miniAppUrl) {
      return null;
    }

    const startParam = `${type}_${id}`;
    return {
      text,
      web_app: { url: `${this.miniAppUrl}?startapp=${startParam}` },
    };
  }

  /**
   * Check if this handler can process the callback
   */
  canHandle(callbackData: string): boolean {
    return (
      callbackData.startsWith(DAILY_CALLBACK_PREFIX) ||
      callbackData.startsWith(PENDING_APPROVAL_PREFIX)
    );
  }

  /**
   * Handle callback query (save or extract action)
   */
  async handleCallback(ctx: Context): Promise<void> {
    const callbackQuery = ctx.callbackQuery;
    if (!callbackQuery || !('data' in callbackQuery)) {
      return;
    }

    const callbackData = callbackQuery.data;

    // Route to appropriate handler
    if (callbackData.startsWith('ds_save:')) {
      await this.handleSaveCallback(ctx, callbackData);
    } else if (callbackData.startsWith('ds_extract:')) {
      await this.handleExtractCallback(ctx, callbackData);
    } else if (callbackData.startsWith('pa_')) {
      await this.handlePendingApprovalCallback(ctx, callbackData);
    } else if (callbackData === 'ds_noop') {
      await ctx.answerCbQuery();
    } else {
      this.logger.warn(`Invalid daily summary callback: ${callbackData}`);
      await ctx.answerCbQuery('Неверный формат');
    }
  }

  /**
   * Handle save callback — uses idempotent save API to prevent duplicate saves
   */
  private async handleSaveCallback(ctx: Context, callbackData: string): Promise<void> {
    const match = callbackData.match(/^ds_save:(\d+)$/);
    if (!match) {
      await ctx.answerCbQuery('Неверный формат');
      return;
    }

    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id?.toString();
    if (!chatId) {
      await ctx.answerCbQuery('Ошибка контекста');
      return;
    }

    const messageId = parseInt(match[1], 10);
    const sessionId = await this.dailyContextCache.getSessionId(chatId, messageId);

    if (!sessionId) {
      await ctx.answerCbQuery('Саммари не найден (возможно, устарел)');
      return;
    }

    await ctx.answerCbQuery('💾 Сохраняю...');

    try {
      // Use atomic save API - PKG Core creates fact and marks session in one operation
      // This is idempotent (prevents duplicate saves) and atomic (fact + session mark together)
      const result = await this.pkgCoreApi.saveRecallSession(sessionId, userId);

      if (result.success) {
        await this.updateButtonStatus(ctx, messageId, 'saved');
        if (result.alreadySaved) {
          this.logger.log(`Daily summary already saved, factId: ${result.factId}`);
        } else {
          this.logger.log(`Daily summary saved, factId: ${result.factId}`);
        }
      } else {
        await ctx.reply(`❌ Ошибка сохранения: ${result.error}`);
        this.logger.error(`Failed to save daily summary: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Save daily summary error: ${errorMessage}`);
      await ctx.reply('❌ Ошибка при сохранении');
    }
  }

  /**
   * Handle extract callback — extract structured data and create draft entities.
   * Uses new PendingApproval-based flow (DB instead of Redis carousel).
   */
  private async handleExtractCallback(ctx: Context, callbackData: string): Promise<void> {
    const match = callbackData.match(/^ds_extract:(\d+)$/);
    if (!match) {
      await ctx.answerCbQuery('Неверный формат');
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCbQuery('Ошибка контекста');
      return;
    }

    const messageId = parseInt(match[1], 10);
    const sessionId = await this.dailyContextCache.getSessionId(chatId, messageId);

    if (!sessionId) {
      await ctx.answerCbQuery('Саммари не найден (возможно, устарел)');
      return;
    }

    // Fetch session data from PKG Core
    const sessionResponse = await this.pkgCoreApi.getRecallSession(sessionId);
    if (!sessionResponse?.data) {
      await ctx.answerCbQuery('Сессия не найдена (возможно, истекла)');
      return;
    }

    const session = sessionResponse.data;

    // Get owner entity for extraction
    const owner = await this.pkgCoreApi.getOwnerEntity();
    if (!owner) {
      await ctx.answerCbQuery('Владелец не найден');
      await ctx.reply('⚠️ Не найден владелец (entity "me"). Используйте /settings для настройки.');
      return;
    }

    await ctx.answerCbQuery('📈 Извлекаю структуру...');

    try {
      // Use new extractAndSave flow — creates draft entities + pending approvals in DB
      const result = await this.pkgCoreApi.extractAndSave({
        synthesisText: session.answer,
        ownerEntityId: owner.id,
        date: session.dateStr,
        messageRef: `telegram:chat:${chatId}:msg:${messageId}`,
        sourceInteractionId: undefined, // No specific interaction
      });

      const totalItems = result.counts.projects + result.counts.tasks + result.counts.commitments;

      if (totalItems === 0) {
        await this.updateButtonStatus(ctx, messageId, 'extracted');
        await ctx.reply('ℹ️ Структурированных данных не обнаружено.');
        return;
      }

      this.logger.log(
        `Daily extraction completed (new flow): batchId=${result.batchId}, ` +
          `${result.counts.projects} projects, ${result.counts.tasks} tasks, ` +
          `${result.counts.commitments} commitments`,
      );

      // Show summary with approve/reject buttons
      const summaryText = this.formatNewExtractionSummary(result);
      await this.updateButtonStatus(ctx, messageId, 'extracted');

      await ctx.reply(summaryText, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Подтвердить все', callback_data: `pa_approve_all:${result.batchId}` },
              { text: '❌ Отклонить все', callback_data: `pa_reject_all:${result.batchId}` },
            ],
            [
              { text: '📋 Просмотреть по одному', callback_data: `pa_list:${result.batchId}:0` },
            ],
            // Mini App button if available (use 'approval' type for DB-based pending approval flow)
            ...(this.miniAppUrl
              ? [[this.getMiniAppButton('approval', result.batchId, '📱 Открыть в приложении')!]]
              : []),
          ],
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Extract daily synthesis error: ${errorMessage}`);
      await ctx.reply('❌ Ошибка при извлечении');
    }
  }

  /**
   * Handle pending approval callbacks (new DB-based flow)
   */
  private async handlePendingApprovalCallback(ctx: Context, callbackData: string): Promise<void> {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message?.message_id
      : undefined;

    if (!chatId || !messageId) {
      await ctx.answerCbQuery('Ошибка контекста');
      return;
    }

    try {
      // Parse callback: pa_action:params
      if (callbackData.startsWith('pa_approve_all:')) {
        const batchId = callbackData.replace('pa_approve_all:', '');
        await this.handleApproveAllBatch(ctx, batchId, messageId);
      } else if (callbackData.startsWith('pa_reject_all:')) {
        const batchId = callbackData.replace('pa_reject_all:', '');
        await this.handleRejectAllBatch(ctx, batchId, messageId);
      } else if (callbackData.startsWith('pa_list:')) {
        const [, batchId, offsetStr] = callbackData.split(':');
        const offset = parseInt(offsetStr, 10);
        await this.handleListPendingItems(ctx, batchId, offset, messageId);
      } else if (callbackData.startsWith('pa_approve:')) {
        const itemId = callbackData.replace('pa_approve:', '');
        await this.handleApproveItem(ctx, itemId, messageId);
      } else if (callbackData.startsWith('pa_reject:')) {
        const itemId = callbackData.replace('pa_reject:', '');
        await this.handleRejectItem(ctx, itemId, messageId);
      } else if (callbackData.startsWith('pa_next:')) {
        const [, batchId, offsetStr] = callbackData.split(':');
        const offset = parseInt(offsetStr, 10);
        await this.handleListPendingItems(ctx, batchId, offset, messageId);
      } else {
        await ctx.answerCbQuery('Неизвестное действие');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Pending approval callback error: ${errorMessage}`);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  /**
   * Approve all pending items in a batch
   */
  private async handleApproveAllBatch(
    ctx: Context,
    batchId: string,
    messageId: number,
  ): Promise<void> {
    await ctx.answerCbQuery('✅ Подтверждаю все...');

    const result = await this.pkgCoreApi.approvePendingBatch(batchId);

    const lines: string[] = ['✅ <b>Все элементы подтверждены</b>\n'];
    lines.push(`Обработано: ${result.processed}`);
    if (result.failed > 0) {
      lines.push(`Ошибок: ${result.failed}`);
      if (result.errors?.length) {
        for (const err of result.errors.slice(0, 3)) {
          lines.push(`  • ${err}`);
        }
      }
    }

    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      lines.join('\n'),
      { parse_mode: 'HTML' },
    );

    this.logger.log(`Batch ${batchId} approved: ${result.processed} items, ${result.failed} failed`);
  }

  /**
   * Reject all pending items in a batch
   */
  private async handleRejectAllBatch(
    ctx: Context,
    batchId: string,
    messageId: number,
  ): Promise<void> {
    await ctx.answerCbQuery('❌ Отклоняю все...');

    const result = await this.pkgCoreApi.rejectPendingBatch(batchId);

    const lines: string[] = ['❌ <b>Все элементы отклонены</b>\n'];
    lines.push(`Обработано: ${result.processed}`);
    if (result.failed > 0) {
      lines.push(`Ошибок: ${result.failed}`);
    }

    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      lines.join('\n'),
      { parse_mode: 'HTML' },
    );

    this.logger.log(`Batch ${batchId} rejected: ${result.processed} items`);
  }

  /**
   * List pending items for review (one by one)
   */
  private async handleListPendingItems(
    ctx: Context,
    batchId: string,
    offset: number,
    messageId: number,
  ): Promise<void> {
    await ctx.answerCbQuery();

    const result = await this.pkgCoreApi.listPendingApprovals({
      batchId,
      status: 'pending',
      limit: 1,
      offset,
    });

    if (result.items.length === 0) {
      // No more pending items
      const stats = await this.pkgCoreApi.getPendingApprovalBatchStats(batchId);

      await ctx.telegram.editMessageText(
        ctx.chat?.id,
        messageId,
        undefined,
        `✅ <b>Обработка завершена</b>\n\n` +
          `Подтверждено: ${stats.approved}\n` +
          `Отклонено: ${stats.rejected}\n` +
          `Ожидает: ${stats.pending}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const item = result.items[0];
    const itemText = this.formatPendingApprovalItem(item, offset + 1, result.total);

    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      itemText,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Подтвердить', callback_data: `pa_approve:${item.id}` },
              { text: '❌ Отклонить', callback_data: `pa_reject:${item.id}` },
            ],
            [
              { text: '⏭️ Пропустить', callback_data: `pa_next:${batchId}:${offset + 1}` },
            ],
          ],
        },
      },
    );
  }

  /**
   * Approve a single pending item
   */
  private async handleApproveItem(
    ctx: Context,
    itemId: string,
    messageId: number,
  ): Promise<void> {
    await ctx.answerCbQuery('✅ Подтверждаю...');

    const result = await this.pkgCoreApi.approvePendingItem(itemId);

    if (result.success) {
      // Get item to find batchId and continue to next
      const item = await this.pkgCoreApi.getPendingApproval(itemId);
      if (item) {
        // Continue to next item
        await this.handleListPendingItems(ctx, item.batchId, 0, messageId);
      }
    }
  }

  /**
   * Reject a single pending item
   */
  private async handleRejectItem(
    ctx: Context,
    itemId: string,
    messageId: number,
  ): Promise<void> {
    await ctx.answerCbQuery('❌ Отклоняю...');

    const result = await this.pkgCoreApi.rejectPendingItem(itemId);

    if (result.success) {
      // Get item to find batchId and continue to next
      const item = await this.pkgCoreApi.getPendingApproval(itemId);
      if (item) {
        // Continue to next item
        await this.handleListPendingItems(ctx, item.batchId, 0, messageId);
      }
    }
  }

  /**
   * Format a single pending approval item for display
   */
  private formatPendingApprovalItem(
    item: PendingApprovalItem,
    current: number,
    total: number,
  ): string {
    const typeIcon =
      item.itemType === 'project' ? '🏗' :
      item.itemType === 'task' ? '📋' : '🤝';

    const typeLabel =
      item.itemType === 'project' ? 'Проект' :
      item.itemType === 'task' ? 'Задача' : 'Обязательство';

    const lines = [
      `<b>${typeIcon} ${typeLabel}</b> (${current}/${total})`,
      '',
    ];

    if (item.sourceQuote) {
      lines.push(`<i>"${item.sourceQuote}"</i>`);
      lines.push('');
    }

    lines.push(`Уверенность: ${Math.round(item.confidence * 100)}%`);

    return lines.join('\n');
  }

  /**
   * Format extraction summary for new flow
   */
  private formatNewExtractionSummary(result: {
    batchId: string;
    counts: { projects: number; tasks: number; commitments: number };
    extraction: {
      projectsExtracted: number;
      tasksExtracted: number;
      commitmentsExtracted: number;
      summary: string;
      tokensUsed: number;
      durationMs: number;
    };
    errors?: string[];
  }): string {
    const lines: string[] = [];

    lines.push('📈 <b>Извлечённая структура</b>\n');

    if (result.counts.projects > 0) {
      lines.push(`🏗 Проектов: ${result.counts.projects}`);
    }
    if (result.counts.tasks > 0) {
      lines.push(`📋 Задач: ${result.counts.tasks}`);
    }
    if (result.counts.commitments > 0) {
      lines.push(`🤝 Обязательств: ${result.counts.commitments}`);
    }

    lines.push('');
    lines.push(`<i>${result.extraction.summary}</i>`);
    lines.push(`<i>⚡ ${result.extraction.durationMs}ms • ${result.extraction.tokensUsed} tokens</i>`);

    if (result.errors?.length) {
      lines.push('');
      lines.push(`⚠️ Ошибок: ${result.errors.length}`);
    }

    lines.push('');
    lines.push('👇 <b>Выберите действие:</b>');

    return lines.join('\n');
  }

  /**
   * Update message button status after action
   */
  private async updateButtonStatus(
    ctx: Context,
    messageId: number,
    action: 'saved' | 'extracted',
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    try {
      const buttons = [];
      if (action === 'saved') {
        buttons.push({ text: '✅ Сохранено', callback_data: 'ds_noop' });
        buttons.push({ text: '📈 Извлечь структуру', callback_data: `ds_extract:${messageId}` });
      } else if (action === 'extracted') {
        buttons.push({ text: '💾 Сохранить выводы', callback_data: `ds_save:${messageId}` });
        buttons.push({ text: '✅ Извлечено', callback_data: 'ds_noop' });
      }

      await ctx.telegram.editMessageReplyMarkup(chatId, messageId, undefined, {
        inline_keyboard: [buttons],
      });
    } catch (error) {
      this.logger.debug(`Could not update button: ${(error as Error).message}`);
    }
  }

  /**
   * Handle /daily command
   * Supports: /daily [topic] [--model haiku|sonnet|opus]
   */
  async handle(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    let args = message.text.replace(/^\/daily\s*/, '').trim();

    // Parse --model flag
    let model: ClaudeModel | undefined;
    const modelMatch = args.match(/--model\s+(haiku|sonnet|opus)/i);
    if (modelMatch) {
      model = modelMatch[1].toLowerCase() as ClaudeModel;
      args = args.replace(/--model\s+(haiku|sonnet|opus)/i, '').trim();
    }

    // Build the date string
    const today = new Date();
    const dateStr = today.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // Build the query
    let query = `Подготовь подробное саммари за сегодня (${dateStr}): `;
    query += 'все взаимодействия, выполненные задачи с описанием, новые задачи которые появились, ';
    query += 'договорённости, обещания, важные детали и моменты. ';
    query += 'Сгруппируй по контактам или проектам.';

    if (args) {
      query += ` Особый фокус на: ${args}`;
    }

    await this.executeQuery(ctx, chatId, query, dateStr, true, model);
  }

  /**
   * Handle reply to a bot message (follow-up question)
   * Uses PKG Core session API for context-aware follow-up.
   * @returns true if this was a reply to a daily message, false otherwise
   */
  async handleReply(ctx: Context): Promise<boolean> {
    const message = ctx.message as Message.TextMessage;
    if (!message?.reply_to_message) return false;

    const chatId = ctx.chat?.id;
    if (!chatId) return false;

    const replyToMessageId = message.reply_to_message.message_id;
    const sessionId = await this.dailyContextCache.getSessionId(chatId, replyToMessageId);

    if (!sessionId) return false;

    const text = message.text;
    if (!text) return false;

    // Execute follow-up via PKG Core session API
    await this.executeFollowup(ctx, chatId, sessionId, text);
    return true;
  }

  /**
   * Execute follow-up query using existing session
   */
  private async executeFollowup(
    ctx: Context,
    chatId: number,
    sessionId: string,
    query: string,
  ): Promise<void> {
    const statusMessage = await ctx.reply('🔍 Ищу информацию...');

    try {
      this.logger.log(`Daily follow-up request from user ${ctx.from?.id}, sessionId=${sessionId}`);

      const response = await this.pkgCoreApi.followupRecall(sessionId, query);

      if (!response.success) {
        await this.editMessage(ctx, statusMessage.message_id, '❌ Ошибка при обработке запроса.');
        return;
      }

      const { sessionId: newSessionId, answer, sources } = response.data;

      // Get session data for dateStr
      const sessionResponse = await this.pkgCoreApi.getRecallSession(newSessionId);
      const dateStr = sessionResponse?.data?.dateStr || new Date().toISOString().split('T')[0];

      // Format and send response
      const formattedResponse = this.formatResponse(answer, sources, dateStr, false);

      await ctx.telegram.deleteMessage(chatId, statusMessage.message_id);
      const sentMessages = await this.sendMessage(ctx, formattedResponse, false);

      // Store new sessionId mapping for continued follow-ups
      for (const sentMessage of sentMessages) {
        await this.dailyContextCache.setSessionId(chatId, sentMessage.message_id, newSessionId);
      }

      this.logger.log(`Daily follow-up completed for user ${ctx.from?.id}`);
    } catch (error) {
      this.logger.error(`Daily follow-up error:`, (error as Error).message);

      const errorMessage = this.isTimeoutError(error)
        ? '⏱ Запрос занимает слишком много времени. Попробуйте позже.'
        : '❌ Ошибка при обработке запроса.';

      await this.editMessage(ctx, statusMessage.message_id, errorMessage);
    }
  }

  /**
   * Execute recall query and send response
   */
  private async executeQuery(
    ctx: Context,
    chatId: number,
    query: string,
    dateStr: string,
    isInitial: boolean,
    model?: ClaudeModel,
  ): Promise<void> {
    const statusEmoji = isInitial ? '📊' : '🔍';
    const modelNote = model ? ` (${model})` : '';
    const statusText = isInitial ? `Готовлю саммари дня${modelNote}...` : `Ищу информацию${modelNote}...`;
    const statusMessage = await ctx.reply(`${statusEmoji} ${statusText}`);

    try {
      this.logger.log(`Daily ${isInitial ? 'summary' : 'follow-up'} request from user ${ctx.from?.id}${model ? `, model=${model}` : ''}`);

      const response = await this.pkgCoreApi.recall(query, 180000, model);

      if (!response.success) {
        await this.editMessage(ctx, statusMessage.message_id, '❌ Ошибка при обработке запроса.');
        return;
      }

      const { sessionId, answer, sources } = response.data;

      // Format and send response
      const formattedResponse = this.formatResponse(answer, sources, dateStr, isInitial);

      await ctx.telegram.deleteMessage(chatId, statusMessage.message_id);
      const sentMessages = await this.sendMessage(ctx, formattedResponse, isInitial);

      // Store sessionId mapping for each sent message (for reply-based follow-up and save action)
      // Actual session data is stored in PKG Core (RecallSessionService)
      for (const sentMessage of sentMessages) {
        await this.dailyContextCache.setSessionId(chatId, sentMessage.message_id, sessionId);
      }

      this.logger.log(`Daily ${isInitial ? 'summary' : 'follow-up'} completed for user ${ctx.from?.id}`);
    } catch (error) {
      this.logger.error(`Daily query error:`, (error as Error).message);

      const errorMessage = this.isTimeoutError(error)
        ? '⏱ Запрос занимает слишком много времени. Попробуйте позже.'
        : '❌ Ошибка при обработке запроса.';

      await this.editMessage(ctx, statusMessage.message_id, errorMessage);
    }
  }

  private formatResponse(
    answer: string,
    sources: RecallSource[],
    dateStr: string,
    isInitial: boolean,
  ): string {
    let result = '';

    if (isInitial) {
      result += `📊 <b>Саммари за ${dateStr}</b>\n\n`;
    }

    // Convert markdown to HTML
    result += this.markdownToHtml(answer);

    // Add sources count and hint
    if (sources.length > 0) {
      result += '\n\n━━━━━━━━━━━━━━━━━━━━━━';
      result += `\n📎 <i>Источников: ${sources.length}</i>`;
    }

    // Add hint for follow-up (reply-based)
    result += '\n\n💬 <i>Ответь на это сообщение чтобы задать уточняющий вопрос</i>';

    return result;
  }

  /**
   * Convert Markdown to Telegram HTML
   */
  private markdownToHtml(text: string): string {
    return (
      text
        // Escape HTML entities first
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Headers → bold
        .replace(/^###\s+(.+)$/gm, '\n<b>$1</b>')
        .replace(/^##\s+(.+)$/gm, '\n<b>$1</b>')
        .replace(/^#\s+(.+)$/gm, '\n<b>$1</b>')
        // Bold: **text**
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        // Italic: *text* (but not inside bold)
        .replace(/(?<![*])\*([^*]+)\*(?![*])/g, '<i>$1</i>')
        // Inline code: `code`
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // List items: - text → • text
        .replace(/^[-*]\s+/gm, '• ')
        // Numbered lists: keep numbers
        .replace(/^(\d+)\.\s+/gm, '$1. ')
        // Clean up excessive newlines
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }

  /**
   * Send message, splitting if too long. Returns all sent messages.
   * Adds save button to the last message if isInitial is true.
   */
  private async sendMessage(
    ctx: Context,
    text: string,
    addSaveButton: boolean,
  ): Promise<Message.TextMessage[]> {
    const MAX_LENGTH = 4000;
    const sentMessages: Message.TextMessage[] = [];

    if (text.length <= MAX_LENGTH) {
      const msg = await this.trySendHtml(ctx, text, addSaveButton);
      if (msg) sentMessages.push(msg);
      return sentMessages;
    }

    // Split by paragraphs
    const parts = this.splitMessage(text, MAX_LENGTH);

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const msg = await this.trySendHtml(ctx, parts[i], addSaveButton && isLast);
      if (msg) sentMessages.push(msg);
    }

    return sentMessages;
  }

  private async trySendHtml(
    ctx: Context,
    text: string,
    addActionButtons: boolean,
  ): Promise<Message.TextMessage | null> {
    const replyMarkup = addActionButtons
      ? {
          inline_keyboard: [
            [
              { text: '💾 Сохранить выводы', callback_data: 'ds_save:PLACEHOLDER' },
              { text: '📈 Извлечь структуру', callback_data: 'ds_extract:PLACEHOLDER' },
            ],
          ],
        }
      : undefined;

    try {
      const msg = (await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      })) as Message.TextMessage;

      // Update callback_data with actual messageId (need to edit message)
      if (addActionButtons && msg) {
        try {
          await ctx.telegram.editMessageReplyMarkup(ctx.chat?.id, msg.message_id, undefined, {
            inline_keyboard: [
              [
                { text: '💾 Сохранить выводы', callback_data: `ds_save:${msg.message_id}` },
                { text: '📈 Извлечь структуру', callback_data: `ds_extract:${msg.message_id}` },
              ],
            ],
          });
        } catch (editError) {
          this.logger.debug(`Could not update callback_data: ${(editError as Error).message}`);
        }
      }

      return msg;
    } catch (error) {
      // If HTML parsing fails, send as plain text
      this.logger.warn(`HTML parse failed, sending plain text: ${(error as Error).message}`);
      const plainText = text
        .replace(/<b>|<\/b>/g, '')
        .replace(/<i>|<\/i>/g, '')
        .replace(/<code>|<\/code>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      return (await ctx.reply(plainText)) as Message.TextMessage;
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const parts: string[] = [];
    let current = '';

    for (const line of text.split('\n')) {
      if (current.length + line.length + 1 > maxLength && current) {
        parts.push(current.trim());
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }

    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts;
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  private async editMessage(ctx: Context, messageId: number, text: string): Promise<void> {
    try {
      await ctx.telegram.editMessageText(ctx.chat?.id, messageId, undefined, text);
    } catch (error) {
      this.logger.error('Failed to edit message:', (error as Error).message);
    }
  }

  private isTimeoutError(error: unknown): boolean {
    if (error instanceof Error) {
      return (
        error.message.includes('timeout') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ECONNABORTED')
      );
    }
    return false;
  }
}
