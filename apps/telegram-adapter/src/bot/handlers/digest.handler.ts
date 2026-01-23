import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { PkgCoreApiService } from '../../api/pkg-core-api.service';

type DigestType = 'morning' | 'hourly' | 'daily';

interface DigestConfig {
  emoji: string;
  name: string;
  trigger: () => Promise<{ success: boolean; message: string }>;
}

/**
 * Handler for digest/brief commands:
 * - /morning — morning brief (upcoming meetings, birthdays, overdue tasks)
 * - /digest — hourly digest of pending extracted events
 * - /daily — daily summary digest
 */
@Injectable()
export class DigestHandler {
  private readonly logger = new Logger(DigestHandler.name);

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  /**
   * Handle /morning command — trigger morning brief
   */
  async handleMorning(ctx: Context): Promise<void> {
    await this.triggerDigest(ctx, 'morning');
  }

  /**
   * Handle /digest command — trigger hourly digest
   */
  async handleDigest(ctx: Context): Promise<void> {
    await this.triggerDigest(ctx, 'hourly');
  }

  /**
   * Handle /daily command — trigger daily digest
   */
  async handleDaily(ctx: Context): Promise<void> {
    await this.triggerDigest(ctx, 'daily');
  }

  private async triggerDigest(ctx: Context, type: DigestType): Promise<void> {
    const config = this.getDigestConfig(type);

    const statusMessage = await ctx.reply(`${config.emoji} Готовлю ${config.name}...`);

    try {
      this.logger.log(`Triggering ${type} digest for user ${ctx.from?.id}`);

      const response = await config.trigger();

      if (response.success) {
        // The digest is sent separately by the notification system
        // Just update the status message
        await this.editMessage(
          ctx,
          statusMessage.message_id,
          `${config.emoji} ${config.name} отправлен`,
        );
      } else {
        await this.editMessage(
          ctx,
          statusMessage.message_id,
          `❌ Не удалось отправить ${config.name.toLowerCase()}`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to trigger ${type} digest:`, (error as Error).message);

      const errorMessage = this.isTimeoutError(error)
        ? `⏱ Подготовка ${config.name.toLowerCase()} занимает слишком много времени.`
        : `❌ Ошибка при подготовке ${config.name.toLowerCase()}.`;

      await this.editMessage(ctx, statusMessage.message_id, errorMessage);
    }
  }

  private getDigestConfig(type: DigestType): DigestConfig {
    switch (type) {
      case 'morning':
        return {
          emoji: '🌅',
          name: 'Утренний бриф',
          trigger: () => this.pkgCoreApi.triggerMorningBrief(),
        };
      case 'hourly':
        return {
          emoji: '📋',
          name: 'Дайджест событий',
          trigger: () => this.pkgCoreApi.triggerHourlyDigest(),
        };
      case 'daily':
        return {
          emoji: '📊',
          name: 'Дневной дайджест',
          trigger: () => this.pkgCoreApi.triggerDailyDigest(),
        };
    }
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
