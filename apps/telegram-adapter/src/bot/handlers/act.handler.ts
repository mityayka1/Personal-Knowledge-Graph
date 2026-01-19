import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { PkgCoreApiService, ActActionDto } from '../../api/pkg-core-api.service';

@Injectable()
export class ActHandler {
  private readonly logger = new Logger(ActHandler.name);

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  async handle(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const instruction = message.text.replace(/^\/act\s*/, '').trim();

    if (!instruction) {
      await ctx.reply(
        'Укажите действие для выполнения.\n\n' +
          'Использование: /act <инструкция>\n' +
          'Примеры:\n' +
          '• /act напиши Сергею что встреча переносится\n' +
          '• /act напомни Маше про документы\n' +
          '• /act спроси у Петра как дела с проектом',
      );
      return;
    }

    // Send "processing" message that we'll update later
    const statusMessage = await ctx.reply('🤖 Обрабатываю запрос...');

    try {
      this.logger.log(`Act request: "${instruction}" from user ${ctx.from?.id}`);

      const response = await this.pkgCoreApi.act(instruction);

      if (!response.success) {
        const errorMsg = response.error || 'Неизвестная ошибка';
        await this.editMessage(
          ctx,
          statusMessage.message_id,
          `❌ Не удалось выполнить действие: ${errorMsg}`,
        );
        return;
      }

      const { result, actions, toolsUsed } = response.data;
      const formattedResponse = this.formatResponse(result, actions, toolsUsed);

      await this.editMessage(ctx, statusMessage.message_id, formattedResponse);
      this.logger.log(`Act completed for user ${ctx.from?.id}, actions: ${actions.length}, tools: ${toolsUsed.join(', ')}`);
    } catch (error) {
      this.logger.error(`Act error for instruction "${instruction}":`, (error as Error).message);

      const errorMessage = this.isTimeoutError(error)
        ? '⏱ Операция занимает слишком много времени. Попробуйте упростить запрос.'
        : '❌ Ошибка при выполнении. Попробуйте ещё раз.';

      await this.editMessage(ctx, statusMessage.message_id, errorMessage);
    }
  }

  private formatResponse(result: string, actions: ActActionDto[], toolsUsed: string[]): string {
    let response = `📋 <b>Результат</b>\n\n${result}`;

    if (actions.length > 0) {
      response += '\n\n<b>Действия:</b>';
      for (const action of actions) {
        const icon = this.getActionIcon(action.type);
        const target = action.entityName ? ` (${action.entityName})` : '';
        response += `\n${icon} ${this.getActionLabel(action.type)}${target}`;
        if (action.details) {
          response += `: ${action.details}`;
        }
      }
    }

    if (toolsUsed.length > 0) {
      response += `\n\n🛠 <i>Инструменты: ${toolsUsed.join(', ')}</i>`;
    }

    return response;
  }

  private getActionIcon(type: ActActionDto['type']): string {
    switch (type) {
      case 'draft_created':
        return '📝';
      case 'message_sent':
        return '✅';
      case 'approval_rejected':
        return '❌';
      case 'followup_created':
        return '⏰';
      default:
        return '•';
    }
  }

  private getActionLabel(type: ActActionDto['type']): string {
    switch (type) {
      case 'draft_created':
        return 'Черновик создан';
      case 'message_sent':
        return 'Сообщение отправлено';
      case 'approval_rejected':
        return 'Отклонено';
      case 'followup_created':
        return 'Напоминание создано';
      default:
        return type;
    }
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
