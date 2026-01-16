import { Controller, Post, Body, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { BotService, SendNotificationOptions } from './bot.service';

export class SendNotificationDto {
  chatId?: number | string;
  message: string;
  parseMode?: 'Markdown' | 'HTML';
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
}

export interface NotificationResponse {
  success: boolean;
  error?: string;
}

@Controller('notifications')
export class NotificationController {
  private readonly logger = new Logger(NotificationController.name);

  constructor(private readonly botService: BotService) {}

  /**
   * Send notification to a specific chat or to the owner
   * POST /notifications/send
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async sendNotification(@Body() dto: SendNotificationDto): Promise<NotificationResponse> {
    this.logger.log(`Received notification request: ${dto.message.substring(0, 50)}...`);

    let success: boolean;

    if (dto.chatId) {
      // Send to specific chat
      success = await this.botService.sendNotification({
        chatId: dto.chatId,
        message: dto.message,
        parseMode: dto.parseMode,
        buttons: dto.buttons,
      });
    } else {
      // Send to owner
      success = await this.botService.sendNotificationToOwner(dto.message, {
        parseMode: dto.parseMode,
        buttons: dto.buttons,
      });
    }

    if (!success) {
      return {
        success: false,
        error: 'Failed to send notification. Check logs for details.',
      };
    }

    return { success: true };
  }

  /**
   * Get notification service status
   * POST /notifications/status (using POST to allow internal calls)
   */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  async getStatus(): Promise<{ ready: boolean; ownerChatId: number | null }> {
    return {
      ready: this.botService.isReady(),
      ownerChatId: this.botService.getOwnerChatId(),
    };
  }
}
