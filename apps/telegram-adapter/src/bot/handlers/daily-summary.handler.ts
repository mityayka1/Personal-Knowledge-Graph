import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { PkgCoreApiService, RecallSource } from '../../api/pkg-core-api.service';

/** Callback prefix for daily summary actions */
const DAILY_CALLBACK_PREFIX = 'ds_';

/** Valid model values */
type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

interface DailyContext {
  dateStr: string;
  lastAnswer: string;
  sources: RecallSource[];
  model?: ClaudeModel;
}

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

  /**
   * Context stored by bot's messageId.
   * Allows reply to any message in the conversation chain.
   */
  private contextByMessageId = new Map<number, DailyContext>();

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  /**
   * Check if this handler can process the callback
   */
  canHandle(callbackData: string): boolean {
    return callbackData.startsWith(DAILY_CALLBACK_PREFIX);
  }

  /**
   * Handle callback query (save action)
   */
  async handleCallback(ctx: Context): Promise<void> {
    const callbackQuery = ctx.callbackQuery;
    if (!callbackQuery || !('data' in callbackQuery)) {
      return;
    }

    const callbackData = callbackQuery.data;

    // Parse callback: ds_save:{messageId}
    const match = callbackData.match(/^ds_save:(\d+)$/);
    if (!match) {
      this.logger.warn(`Invalid daily summary callback: ${callbackData}`);
      await ctx.answerCbQuery('Неверный формат');
      return;
    }

    const messageId = parseInt(match[1], 10);
    const dailyContext = this.contextByMessageId.get(messageId);

    if (!dailyContext) {
      await ctx.answerCbQuery('Саммари не найден (возможно, устарел)');
      return;
    }

    await ctx.answerCbQuery('💾 Сохраняю...');

    try {
      const result = await this.pkgCoreApi.saveDailySummary(
        dailyContext.lastAnswer,
        dailyContext.dateStr,
      );

      if (result.success) {
        // Update message to show saved status
        await this.updateButtonToSaved(ctx, messageId);
        this.logger.log(`Daily summary saved, factId: ${result.factId}`);
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
   * Update message to show saved status (remove save button)
   */
  private async updateButtonToSaved(ctx: Context, messageId: number): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    try {
      // Remove the inline keyboard (button was pressed)
      await ctx.telegram.editMessageReplyMarkup(chatId, messageId, undefined, {
        inline_keyboard: [[{ text: '✅ Сохранено', callback_data: 'ds_noop' }]],
      });
    } catch (error) {
      // Message might not be modifiable, that's okay
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
   * @returns true if this was a reply to a daily message, false otherwise
   */
  async handleReply(ctx: Context): Promise<boolean> {
    const message = ctx.message as Message.TextMessage;
    if (!message?.reply_to_message) return false;

    const replyToMessageId = message.reply_to_message.message_id;
    const dailyContext = this.contextByMessageId.get(replyToMessageId);

    if (!dailyContext) return false;

    const chatId = ctx.chat?.id;
    if (!chatId) return false;

    const text = message.text;
    if (!text) return false;

    // Build follow-up query with context
    const query = `Контекст: ранее ты подготовил саммари за ${dailyContext.dateStr}.

Предыдущий ответ (краткое содержание):
${this.truncate(dailyContext.lastAnswer, 500)}

Уточняющий вопрос/инструкция пользователя: "${text}"

Используй поиск чтобы найти дополнительную информацию и ответить на вопрос. Отвечай конкретно на вопрос пользователя.`;

    // Use same model as initial request
    await this.executeQuery(ctx, chatId, query, dailyContext.dateStr, false, dailyContext.model);
    return true;
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

      const { answer, sources } = response.data;

      // Format and send response
      const formattedResponse = this.formatResponse(answer, sources, dateStr, isInitial);

      await ctx.telegram.deleteMessage(chatId, statusMessage.message_id);
      const sentMessages = await this.sendMessage(ctx, formattedResponse, isInitial);

      // Save context for each sent message (for reply-based follow-up and save action)
      const dailyContext: DailyContext = { dateStr, lastAnswer: answer, sources, model };
      for (const sentMessage of sentMessages) {
        this.contextByMessageId.set(sentMessage.message_id, dailyContext);
      }

      // Cleanup old contexts (keep last 100)
      this.cleanupOldContexts();

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
    addSaveButton: boolean,
  ): Promise<Message.TextMessage | null> {
    const replyMarkup = addSaveButton
      ? {
          inline_keyboard: [[{ text: '💾 Сохранить выводы', callback_data: 'ds_save:PLACEHOLDER' }]],
        }
      : undefined;

    try {
      const msg = (await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      })) as Message.TextMessage;

      // Update callback_data with actual messageId (need to edit message)
      if (addSaveButton && msg) {
        try {
          await ctx.telegram.editMessageReplyMarkup(ctx.chat?.id, msg.message_id, undefined, {
            inline_keyboard: [[{ text: '💾 Сохранить выводы', callback_data: `ds_save:${msg.message_id}` }]],
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

  /**
   * Cleanup old contexts to prevent memory leak.
   * Keeps only the last 100 message contexts.
   */
  private cleanupOldContexts(): void {
    const MAX_CONTEXTS = 100;
    if (this.contextByMessageId.size > MAX_CONTEXTS) {
      const keysToDelete = Array.from(this.contextByMessageId.keys())
        .slice(0, this.contextByMessageId.size - MAX_CONTEXTS);
      for (const key of keysToDelete) {
        this.contextByMessageId.delete(key);
      }
    }
  }
}
