import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { PkgCoreApiService, RecallSource } from '../../api/pkg-core-api.service';

/**
 * Handler for /daily command — comprehensive daily summary using LLM recall
 *
 * Unlike the digest handler (which shows extracted events),
 * this handler generates a full AI-powered summary of the day's interactions.
 */
@Injectable()
export class DailySummaryHandler {
  private readonly logger = new Logger(DailySummaryHandler.name);

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  async handle(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const args = message.text.replace(/^\/daily\s*/, '').trim();

    // Build the date string
    const today = new Date();
    const dateStr = today.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // Build the query - user can optionally specify a focus topic
    let query = `Подготовь подробное саммари за сегодня (${dateStr}): `;
    query += 'все взаимодействия, выполненные задачи с описанием, новые задачи которые появились, ';
    query += 'договорённости, обещания, важные детали и моменты. ';
    query += 'Сгруппируй по контактам или проектам.';

    if (args) {
      query += ` Особый фокус на: ${args}`;
    }

    // Send "searching" message
    const statusMessage = await ctx.reply('📊 Готовлю саммари дня...');

    try {
      this.logger.log(`Daily summary request from user ${ctx.from?.id}, focus: ${args || 'none'}`);

      // Call recall API with extended timeout (3 min)
      const response = await this.pkgCoreApi.recall(query, 180000);

      if (!response.success) {
        await this.editMessage(ctx, statusMessage.message_id, '❌ Ошибка при подготовке саммари.');
        return;
      }

      const { answer, sources } = response.data;
      const formattedResponse = this.formatResponse(answer, sources, dateStr);

      // Delete status message and send the full report
      await ctx.telegram.deleteMessage(ctx.chat!.id, statusMessage.message_id);
      await this.sendLongMessage(ctx, formattedResponse);

      this.logger.log(`Daily summary completed for user ${ctx.from?.id}`);
    } catch (error) {
      this.logger.error(`Daily summary error:`, (error as Error).message);

      const errorMessage = this.isTimeoutError(error)
        ? '⏱ Подготовка саммари занимает слишком много времени. Попробуйте позже.'
        : '❌ Ошибка при подготовке саммари. Попробуйте ещё раз.';

      await this.editMessage(ctx, statusMessage.message_id, errorMessage);
    }
  }

  private formatResponse(answer: string, sources: RecallSource[], dateStr: string): string {
    let result = `📊 <b>Саммари за ${dateStr}</b>\n\n`;
    result += answer;

    if (sources.length > 0) {
      result += '\n\n━━━━━━━━━━━━━━━━━━━━━━\n';
      result += `📎 <i>Источников: ${sources.length}</i>`;
    }

    return result;
  }

  /**
   * Send a long message, splitting if necessary (Telegram limit is 4096 chars)
   */
  private async sendLongMessage(ctx: Context, text: string): Promise<void> {
    const MAX_LENGTH = 4000; // Leave some margin
    const htmlText = this.markdownToTelegramHtml(text);

    if (htmlText.length <= MAX_LENGTH) {
      await ctx.reply(htmlText, { parse_mode: 'HTML' });
      return;
    }

    // Split by double newlines to preserve formatting
    const parts: string[] = [];
    let currentPart = '';

    for (const line of htmlText.split('\n')) {
      if (currentPart.length + line.length + 1 > MAX_LENGTH) {
        parts.push(currentPart);
        currentPart = line;
      } else {
        currentPart += (currentPart ? '\n' : '') + line;
      }
    }

    if (currentPart) {
      parts.push(currentPart);
    }

    // Send each part
    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'HTML' });
      } catch {
        // If HTML fails, try plain text
        await ctx.reply(part.replace(/<[^>]+>/g, ''));
      }
    }
  }

  private markdownToTelegramHtml(text: string): string {
    return text
      // Remove backslash escapes first
      .replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, '$1')
      // Headers → bold with emoji
      .replace(/^### (.+)$/gm, '📌 <b>$1</b>')
      .replace(/^## (.+)$/gm, '\n📋 <b>$1</b>')
      .replace(/^# (.+)$/gm, '\n🔷 <b>$1</b>')
      // Bold: **text** → <b>text</b>
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      // Italic: *text* or _text_ → <i>text</i>
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
      .replace(/_(.+?)_/g, '<i>$1</i>')
      // Inline code: `code` → <code>code</code>
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // List items: - text → • text
      .replace(/^- /gm, '• ')
      // Numbered lists: keep as is
      // Clean up multiple newlines
      .replace(/\n{3,}/g, '\n\n');
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
