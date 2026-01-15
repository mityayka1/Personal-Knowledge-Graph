import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { PkgCoreApiService, RecallSource } from '../../api/pkg-core-api.service';

@Injectable()
export class RecallHandler {
  private readonly logger = new Logger(RecallHandler.name);

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  async handle(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const query = message.text.replace(/^\/recall\s*/, '').trim();

    if (!query) {
      await ctx.reply(
        'Укажите поисковый запрос.\n\nИспользование: /recall <ваш вопрос>\nПример: /recall кто советовал хорошего стоматолога?',
      );
      return;
    }

    // Send "searching" message that we'll update later
    const statusMessage = await ctx.reply('🔍 Ищу в переписке...');

    try {
      this.logger.log(`Recall request: "${query}" from user ${ctx.from?.id}`);

      const response = await this.pkgCoreApi.recall(query);

      if (!response.success) {
        await this.editMessage(ctx, statusMessage.message_id, '❌ Ошибка поиска. Попробуйте позже.');
        return;
      }

      const { answer, sources } = response.data;
      const formattedResponse = this.formatResponse(answer, sources);

      await this.editMessage(ctx, statusMessage.message_id, formattedResponse);
      this.logger.log(`Recall completed for user ${ctx.from?.id}`);
    } catch (error) {
      this.logger.error(`Recall error for query "${query}":`, (error as Error).message);

      const errorMessage = this.isTimeoutError(error)
        ? '⏱ Поиск занимает слишком много времени. Попробуйте уточнить запрос.'
        : '❌ Ошибка при поиске. Попробуйте ещё раз.';

      await this.editMessage(ctx, statusMessage.message_id, errorMessage);
    }
  }

  private formatResponse(answer: string, sources: RecallSource[]): string {
    let result = `📋 <b>Результат поиска</b>\n\n${answer}`;

    if (sources.length > 0) {
      result += '\n\n📎 <b>Источники:</b>';
      for (const source of sources.slice(0, 5)) {
        const preview = this.truncate(source.preview, 80);
        result += `\n• ${preview}`;
      }
    }

    return result;
  }

  private async editMessage(ctx: Context, messageId: number, text: string): Promise<void> {
    // Convert markdown to Telegram HTML format
    const htmlText = this.markdownToTelegramHtml(text);

    try {
      await ctx.telegram.editMessageText(ctx.chat?.id, messageId, undefined, htmlText, {
        parse_mode: 'HTML',
      });
    } catch (error) {
      // If HTML parsing fails, try plain text
      this.logger.warn('HTML parse failed, falling back to plain text');
      try {
        const plainText = htmlText.replace(/<[^>]+>/g, '');
        await ctx.telegram.editMessageText(ctx.chat?.id, messageId, undefined, plainText);
      } catch {
        this.logger.error('Failed to edit message:', (error as Error).message);
      }
    }
  }

  /**
   * Convert Markdown to Telegram HTML format
   */
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
      // Links: [text](url) → <a href="url">text</a>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // List items: - text → • text
      .replace(/^- /gm, '• ')
      // Clean up multiple newlines
      .replace(/\n{3,}/g, '\n\n');
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
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
