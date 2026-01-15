import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { PkgCoreApiService, PrepareResponseData } from '../../api/pkg-core-api.service';

@Injectable()
export class PrepareHandler {
  private readonly logger = new Logger(PrepareHandler.name);

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  async handle(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const searchName = message.text.replace(/^\/prepare\s*/, '').trim();

    if (!searchName) {
      await ctx.reply(
        'Укажите имя контакта.\n\nИспользование: /prepare <имя>\nПример: /prepare Иван Петров',
      );
      return;
    }

    // Send "searching" message
    const statusMessage = await ctx.reply(`🔍 Ищу "${searchName}"...`);

    try {
      this.logger.log(`Prepare request: "${searchName}" from user ${ctx.from?.id}`);

      // First, search for the entity by name
      const searchResponse = await this.pkgCoreApi.searchEntities(searchName, 5);

      if (searchResponse.items.length === 0) {
        await this.editMessage(
          ctx,
          statusMessage.message_id,
          `❌ Контакт "${searchName}" не найден. Проверьте имя и попробуйте снова.`,
        );
        return;
      }

      // If multiple results, show selection
      if (searchResponse.items.length > 1) {
        const options = searchResponse.items
          .map((item, idx) => `${idx + 1}. ${item.name} (${item.type})`)
          .join('\n');

        await this.editMessage(
          ctx,
          statusMessage.message_id,
          `Найдено несколько контактов:\n${options}\n\nУточните полное имя.`,
        );
        return;
      }

      // Single match - prepare briefing
      const entity = searchResponse.items[0];
      await this.editMessage(ctx, statusMessage.message_id, `📝 Готовлю бриф для ${entity.name}...`);

      const response = await this.pkgCoreApi.prepare(entity.id);

      if (!response.success) {
        await this.editMessage(ctx, statusMessage.message_id, '❌ Не удалось подготовить бриф. Попробуйте ещё раз.');
        return;
      }

      const formattedResponse = this.formatBriefing(response.data);
      await this.editMessage(ctx, statusMessage.message_id, formattedResponse);

      this.logger.log(`Prepare completed for entity ${entity.id} (${entity.name})`);
    } catch (error) {
      this.logger.error(`Prepare error for "${searchName}":`, (error as Error).message);

      const errorMessage = this.isTimeoutError(error)
        ? '⏱ Подготовка брифа занимает слишком много времени. Попробуйте ещё раз.'
        : '❌ Ошибка при подготовке брифа. Попробуйте ещё раз.';

      await this.editMessage(ctx, statusMessage.message_id, errorMessage);
    }
  }

  private formatBriefing(data: PrepareResponseData): string {
    // Note: brief from API is already formatted in Markdown, don't escape it
    let result = `📋 *Бриф: ${data.entityName}*\n\n`;

    // The brief content is pre-formatted, use as-is
    result += `${data.brief}\n\n`;

    result += `💬 *Взаимодействий:* ${data.recentInteractions}\n`;

    if (data.openQuestions.length > 0) {
      result += '\n❓ *Открытые вопросы:*\n';
      for (const question of data.openQuestions) {
        result += `• ${question}\n`;
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
        // Strip HTML tags for fallback
        const plainText = htmlText.replace(/<[^>]+>/g, '');
        await ctx.telegram.editMessageText(ctx.chat?.id, messageId, undefined, plainText);
      } catch {
        this.logger.error('Failed to edit message:', (error as Error).message);
      }
    }
  }

  /**
   * Convert Markdown to Telegram HTML format
   * Supports: bold, italic, links, code, headers
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
      // Escape HTML special chars in remaining text (but not in tags)
      .replace(/&(?!amp;|lt;|gt;)/g, '&amp;')
      // Clean up multiple newlines
      .replace(/\n{3,}/g, '\n\n');
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
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
