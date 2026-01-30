import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import {
  PkgCoreApiService,
  RecallSource,
  ExtractionCarouselNavResponse,
} from '../../api/pkg-core-api.service';
import { DailyContextCacheService } from '../../common/cache';

/** Callback prefix for daily summary actions */
const DAILY_CALLBACK_PREFIX = 'ds_';

/** Callback prefix for extraction carousel actions */
const EXTRACTION_CAROUSEL_PREFIX = 'exc_';

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
    this.miniAppUrl = this.configService.get<string>('MINI_APP_URL');
  }

  /**
   * Generate Mini App URL for deep linking.
   * Format: https://t.me/BotUsername/app?startapp=<type>_<id>
   */
  private getMiniAppButton(
    type: 'extraction' | 'brief' | 'recall' | 'entity',
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
      callbackData.startsWith(EXTRACTION_CAROUSEL_PREFIX)
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
    } else if (callbackData.startsWith('exc_')) {
      await this.handleCarouselCallback(ctx, callbackData);
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
   * Handle extract callback — extract structured data from synthesis and show carousel
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

    await ctx.answerCbQuery('📈 Извлекаю структуру...');

    try {
      // Step 1: Extract structured data from session (via sessionId)
      const extractResult = await this.pkgCoreApi.extractFromSession(
        sessionId,
        undefined, // focusTopic
        session.model, // use same model as recall
      );

      if (!extractResult.success) {
        await ctx.reply('❌ Ошибка извлечения структуры');
        this.logger.error('Failed to extract daily synthesis');
        return;
      }

      const { projects, tasks, commitments } = extractResult.data;
      const totalItems = projects.length + tasks.length + commitments.length;

      if (totalItems === 0) {
        await this.updateButtonStatus(ctx, messageId, 'extracted');
        await ctx.reply('ℹ️ Структурированных данных не обнаружено.');
        return;
      }

      this.logger.log(
        `Daily extraction completed: ${projects.length} projects, ` +
          `${tasks.length} tasks, ${commitments.length} commitments`,
      );

      // Step 2: Show summary first
      const summaryText = this.formatExtractionSummary(extractResult.data);
      await ctx.reply(summaryText, { parse_mode: 'HTML' });

      // Step 3: Create carousel with extracted items
      // Send placeholder message first to get message ID
      const carouselMessage = await ctx.reply('⏳ Создаю карусель для подтверждения...') as Message.TextMessage;

      const carouselResult = await this.pkgCoreApi.createExtractionCarousel({
        chatId: String(chatId),
        messageId: carouselMessage.message_id,
        projects,
        tasks,
        commitments,
        synthesisDate: session.dateStr,
      });

      if (!carouselResult.success) {
        await ctx.telegram.editMessageText(
          chatId,
          carouselMessage.message_id,
          undefined,
          `❌ Ошибка создания карусели: ${carouselResult.error}`,
        );
        return;
      }

      // Step 4: Update message with first carousel item + Mini App button
      await this.updateButtonStatus(ctx, messageId, 'extracted');

      // Add Mini App button if URL is configured and carouselId exists
      const miniAppButton = carouselResult.carouselId
        ? this.getMiniAppButton('extraction', carouselResult.carouselId)
        : null;
      const buttonsWithMiniApp = miniAppButton
        ? [...(carouselResult.buttons || []), [miniAppButton]]
        : carouselResult.buttons;

      await this.updateCarouselMessage(ctx, chatId, carouselMessage.message_id, {
        success: true,
        complete: false,
        message: carouselResult.message,
        buttons: buttonsWithMiniApp,
        chatId: String(chatId),
        messageId: carouselMessage.message_id,
      });

      this.logger.log(`Created extraction carousel ${carouselResult.carouselId} with ${totalItems} items`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Extract daily synthesis error: ${errorMessage}`);
      await ctx.reply('❌ Ошибка при извлечении');
    }
  }

  /**
   * Handle carousel navigation callbacks (prev/next/confirm/skip)
   */
  private async handleCarouselCallback(ctx: Context, callbackData: string): Promise<void> {
    // Parse: exc_action:carouselId
    const match = callbackData.match(/^exc_(prev|next|confirm|skip):(.+)$/);
    if (!match) {
      await ctx.answerCbQuery('Неверный формат');
      return;
    }

    const [, action, carouselId] = match;
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message?.message_id
      : undefined;

    if (!chatId || !messageId) {
      await ctx.answerCbQuery('Ошибка контекста');
      return;
    }

    await ctx.answerCbQuery();

    try {
      let result: ExtractionCarouselNavResponse;

      switch (action) {
        case 'prev':
          result = await this.pkgCoreApi.extractionCarouselPrev(carouselId);
          break;
        case 'next':
          result = await this.pkgCoreApi.extractionCarouselNext(carouselId);
          break;
        case 'confirm':
          result = await this.pkgCoreApi.extractionCarouselConfirm(carouselId);
          break;
        case 'skip':
          result = await this.pkgCoreApi.extractionCarouselSkip(carouselId);
          break;
        default:
          return;
      }

      if (!result.success) {
        await ctx.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          `❌ Ошибка: ${result.error || 'Unknown error'}`,
        );
        return;
      }

      await this.updateCarouselMessage(ctx, chatId, messageId, result);

      // If complete, show final summary and persist confirmed items
      if (result.complete) {
        await this.handleCarouselComplete(ctx, carouselId);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Carousel ${action} error: ${errorMessage}`);
      await ctx.reply('❌ Ошибка при обработке');
    }
  }

  /**
   * Update carousel message with new content and buttons
   */
  private async updateCarouselMessage(
    ctx: Context,
    chatId: number,
    messageId: number,
    result: ExtractionCarouselNavResponse,
  ): Promise<void> {
    const text = result.message || (result.complete ? '✅ Обработка завершена' : '⏳ Загрузка...');

    // If complete, remove buttons
    const replyMarkup = result.complete
      ? undefined
      : result.buttons
        ? { inline_keyboard: result.buttons }
        : undefined;

    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } catch (error) {
      // Ignore "message is not modified" error
      if (!(error instanceof Error) || !error.message.includes('not modified')) {
        this.logger.debug(`Could not update carousel message: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Handle carousel completion - persist confirmed items
   */
  private async handleCarouselComplete(ctx: Context, carouselId: string): Promise<void> {
    try {
      const statsResult = await this.pkgCoreApi.getExtractionCarouselStats(carouselId);

      if (!statsResult.success || !statsResult.stats) {
        return;
      }

      const { confirmed, skipped, confirmedByType } = statsResult.stats;

      if (confirmed === 0) {
        if (skipped > 0) {
          await ctx.reply(`⏭️ Все ${skipped} элементов пропущены.`);
        }
        return;
      }

      // Get owner entity for persistence
      const owner = await this.pkgCoreApi.getOwnerEntity();
      if (!owner) {
        this.logger.warn('Owner entity not found, cannot persist extraction results');
        await ctx.reply(
          `⚠️ Подтверждено ${confirmed} элементов, но не найден владелец для сохранения.\n` +
            'Используйте /settings для настройки.',
          { parse_mode: 'HTML' },
        );
        return;
      }

      // Persist confirmed items as Activity/Commitment entities
      const persistResult = await this.pkgCoreApi.persistExtractionCarousel(
        carouselId,
        owner.id,
      );

      if (!persistResult.success) {
        this.logger.error(`Failed to persist carousel: ${persistResult.error}`);
        await ctx.reply(`❌ Ошибка сохранения: ${persistResult.error}`);
        return;
      }

      // Format success message
      const result = persistResult.result!;
      const lines: string[] = ['✅ <b>Сохранено в базу:</b>'];

      if (result.projectsCreated > 0) {
        lines.push(`  🏗 Проектов: ${result.projectsCreated}`);
      }
      if (result.tasksCreated > 0) {
        lines.push(`  📋 Задач: ${result.tasksCreated}`);
      }
      if (result.commitmentsCreated > 0) {
        lines.push(`  🤝 Обязательств: ${result.commitmentsCreated}`);
      }

      if (skipped > 0) {
        lines.push(`\n⏭️ Пропущено: ${skipped}`);
      }

      if (result.errors.length > 0) {
        lines.push(`\n⚠️ Ошибки (${result.errors.length}):`);
        for (const err of result.errors.slice(0, 3)) {
          lines.push(`  • ${err.item}: ${err.error}`);
        }
        if (result.errors.length > 3) {
          lines.push(`  • ...и ещё ${result.errors.length - 3}`);
        }
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });

      this.logger.log(
        `Carousel ${carouselId} persisted: ${result.projectsCreated} projects, ` +
          `${result.tasksCreated} tasks, ${result.commitmentsCreated} commitments ` +
          `(${result.errors.length} errors)`,
      );
    } catch (error) {
      this.logger.error(`Failed to complete carousel: ${(error as Error).message}`);
      await ctx.reply('❌ Ошибка при завершении карусели');
    }
  }

  /**
   * Format extraction summary (brief overview before carousel)
   */
  private formatExtractionSummary(data: {
    projects: Array<{ name: string }>;
    tasks: Array<{ title: string }>;
    commitments: Array<{ what: string }>;
    extractionSummary: string;
    tokensUsed: number;
    durationMs: number;
  }): string {
    const lines: string[] = [];

    lines.push('📈 <b>Извлечённая структура</b>\n');

    if (data.projects.length > 0) {
      lines.push(`🏗 Проекты: ${data.projects.length}`);
    }
    if (data.tasks.length > 0) {
      lines.push(`📋 Задачи: ${data.tasks.length}`);
    }
    if (data.commitments.length > 0) {
      lines.push(`🤝 Обязательства: ${data.commitments.length}`);
    }

    lines.push('');
    lines.push(`<i>${data.extractionSummary}</i>`);
    lines.push(`<i>⚡ ${data.durationMs}ms • ${data.tokensUsed} tokens</i>`);
    lines.push('');
    lines.push('👇 <b>Подтвердите каждый элемент в карусели ниже</b>');

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
   * Format extraction result for Telegram message
   */
  private formatExtractionResult(data: {
    projects: Array<{
      name: string;
      isNew: boolean;
      participants: string[];
      client?: string;
      confidence: number;
    }>;
    tasks: Array<{
      title: string;
      projectName?: string;
      status: string;
      priority?: string;
      confidence: number;
    }>;
    commitments: Array<{
      what: string;
      from: string;
      to: string;
      type: string;
      deadline?: string;
      confidence: number;
    }>;
    inferredRelations: Array<{
      type: string;
      entities: string[];
      activityName?: string;
      confidence: number;
    }>;
    extractionSummary: string;
    tokensUsed: number;
    durationMs: number;
  }): string {
    const lines: string[] = [];

    lines.push('📈 <b>Извлечённая структура</b>\n');

    // Projects
    if (data.projects.length > 0) {
      lines.push('<b>🏗 Проекты:</b>');
      for (const p of data.projects) {
        const status = p.isNew ? '🆕' : '📁';
        const participants = p.participants.length > 0 ? ` (${p.participants.join(', ')})` : '';
        const client = p.client ? ` • ${p.client}` : '';
        lines.push(`${status} ${p.name}${participants}${client}`);
      }
      lines.push('');
    }

    // Tasks
    if (data.tasks.length > 0) {
      lines.push('<b>📋 Задачи:</b>');
      for (const t of data.tasks) {
        const statusIcon =
          t.status === 'done' ? '✅' : t.status === 'in_progress' ? '🔄' : '⏳';
        const priority =
          t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '';
        const project = t.projectName ? ` → ${t.projectName}` : '';
        lines.push(`${statusIcon}${priority} ${t.title}${project}`);
      }
      lines.push('');
    }

    // Commitments
    if (data.commitments.length > 0) {
      lines.push('<b>🤝 Обязательства:</b>');
      for (const c of data.commitments) {
        const typeIcon =
          c.type === 'promise'
            ? '🎯'
            : c.type === 'request'
              ? '📨'
              : c.type === 'agreement'
                ? '🤝'
                : c.type === 'deadline'
                  ? '⏰'
                  : '💭';
        const deadline = c.deadline ? ` (до ${c.deadline})` : '';
        const direction = c.from === 'self' ? `→ ${c.to}` : `${c.from} →`;
        lines.push(`${typeIcon} ${direction}: ${c.what}${deadline}`);
      }
      lines.push('');
    }

    // Relations (brief)
    if (data.inferredRelations.length > 0) {
      lines.push('<b>🔗 Связи:</b>');
      for (const r of data.inferredRelations) {
        const activity = r.activityName ? ` (${r.activityName})` : '';
        lines.push(`• ${r.entities.join(' ↔ ')}${activity}`);
      }
      lines.push('');
    }

    // Summary
    lines.push('━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`<i>${data.extractionSummary}</i>`);
    lines.push(`<i>⚡ ${data.durationMs}ms • ${data.tokensUsed} tokens</i>`);

    return lines.join('\n');
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
