import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { PkgCoreApiService, RecallSource } from '../../api/pkg-core-api.service';

interface DailySession {
  dateStr: string;
  lastAnswer: string;
  sources: RecallSource[];
  createdAt: number;
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Handler for /daily command — comprehensive daily summary using LLM recall
 *
 * Features:
 * - AI-powered daily summary via /agent/recall
 * - Optional focus topic: /daily [topic]
 * - Follow-up questions support (reply to continue dialog)
 */
@Injectable()
export class DailySummaryHandler {
  private readonly logger = new Logger(DailySummaryHandler.name);

  /** Active sessions by chatId for follow-up questions */
  private sessions = new Map<number, DailySession>();

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
   * Handle follow-up message (text reply after /daily)
   * @returns true if handled, false if no active session
   */
  async handleFollowUp(ctx: Context, text: string): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (!chatId) return false;

    const session = this.sessions.get(chatId);
    if (!session) return false;

    // Check session timeout
    if (Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
      this.sessions.delete(chatId);
      return false;
    }

    // Build follow-up query with context
    const query = `Контекст: ранее ты подготовил саммари за ${session.dateStr}.

Предыдущий ответ (краткое содержание):
${this.truncate(session.lastAnswer, 500)}

Уточняющий вопрос/инструкция пользователя: "${text}"

Используй поиск чтобы найти дополнительную информацию и ответить на вопрос. Отвечай конкретно на вопрос пользователя.`;

    await this.executeQuery(ctx, chatId, query, session.dateStr, false);
    return true;
  }

  /**
   * Check if chat has active daily session
   */
  hasActiveSession(chatId: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;

    if (Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
      this.sessions.delete(chatId);
      return false;
    }

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

      // Save session for follow-up
      this.sessions.set(chatId, {
        dateStr,
        lastAnswer: answer,
        sources,
        createdAt: Date.now(),
      });

      // Format and send response
      const formattedResponse = this.formatResponse(answer, sources, dateStr, isInitial);

      await ctx.telegram.deleteMessage(chatId, statusMessage.message_id);
      await this.sendMessage(ctx, formattedResponse);

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

    // Add hint for follow-up
    result += '\n\n💬 <i>Можешь задать уточняющий вопрос</i>';

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
   * Send message, splitting if too long
   */
  private async sendMessage(ctx: Context, text: string): Promise<void> {
    const MAX_LENGTH = 4000;

    if (text.length <= MAX_LENGTH) {
      await this.trySendHtml(ctx, text);
      return;
    }

    // Split by paragraphs
    const parts = this.splitMessage(text, MAX_LENGTH);

    for (const part of parts) {
      await this.trySendHtml(ctx, part);
    }
  }

  private async trySendHtml(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: 'HTML' });
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
      await ctx.reply(plainText);
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
