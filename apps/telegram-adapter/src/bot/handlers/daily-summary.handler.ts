import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { PkgCoreApiService, RecallSource } from '../../api/pkg-core-api.service';

interface DailyContext {
  dateStr: string;
  lastAnswer: string;
  sources: RecallSource[];
}

/**
 * Handler for /daily command — comprehensive daily summary using LLM recall
 *
 * Features:
 * - AI-powered daily summary via /agent/recall
 * - Optional focus topic: /daily [topic]
 * - Reply-based follow-up: reply to any bot message to continue dialog
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
   * Handle /daily command
   */
  async handle(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const args = message.text.replace(/^\/daily\s*/, '').trim();

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

    await this.executeQuery(ctx, chatId, query, dateStr, true);
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

    await this.executeQuery(ctx, chatId, query, dailyContext.dateStr, false);
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
  ): Promise<void> {
    const statusEmoji = isInitial ? '📊' : '🔍';
    const statusText = isInitial ? 'Готовлю саммари дня...' : 'Ищу информацию...';
    const statusMessage = await ctx.reply(`${statusEmoji} ${statusText}`);

    try {
      this.logger.log(`Daily ${isInitial ? 'summary' : 'follow-up'} request from user ${ctx.from?.id}`);

      const response = await this.pkgCoreApi.recall(query, 180000);

      if (!response.success) {
        await this.editMessage(ctx, statusMessage.message_id, '❌ Ошибка при обработке запроса.');
        return;
      }

      const { answer, sources } = response.data;

      // Format and send response
      const formattedResponse = this.formatResponse(answer, sources, dateStr, isInitial);

      await ctx.telegram.deleteMessage(chatId, statusMessage.message_id);
      const sentMessages = await this.sendMessage(ctx, formattedResponse);

      // Save context for each sent message (for reply-based follow-up)
      const dailyContext: DailyContext = { dateStr, lastAnswer: answer, sources };
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
   */
  private async sendMessage(ctx: Context, text: string): Promise<Message.TextMessage[]> {
    const MAX_LENGTH = 4000;
    const sentMessages: Message.TextMessage[] = [];

    if (text.length <= MAX_LENGTH) {
      const msg = await this.trySendHtml(ctx, text);
      if (msg) sentMessages.push(msg);
      return sentMessages;
    }

    // Split by paragraphs
    const parts = this.splitMessage(text, MAX_LENGTH);

    for (const part of parts) {
      const msg = await this.trySendHtml(ctx, part);
      if (msg) sentMessages.push(msg);
    }

    return sentMessages;
  }

  private async trySendHtml(ctx: Context, text: string): Promise<Message.TextMessage | null> {
    try {
      return (await ctx.reply(text, { parse_mode: 'HTML' })) as Message.TextMessage;
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
