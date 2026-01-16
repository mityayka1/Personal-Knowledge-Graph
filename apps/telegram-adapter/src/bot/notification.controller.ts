import { Controller, Post, Body, HttpCode, HttpStatus, Logger, UseGuards } from '@nestjs/common';
import { BotService, SendNotificationOptions } from './bot.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

export class SendNotificationDto {
  chatId?: number | string;
  message: string;
  parseMode?: 'Markdown' | 'HTML';
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
}

export interface NotificationResponse {
  success: boolean;
  error?: string;
  messageId?: number;
}

export class EditMessageDto {
  chatId: number | string;
  messageId: number;
  message: string;
  parseMode?: 'Markdown' | 'HTML';
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
}

@Controller('notifications')
@UseGuards(ApiKeyGuard)
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
   * Send notification and return message ID (for carousel tracking)
   * POST /notifications/send-with-id
   */
  @Post('send-with-id')
  @HttpCode(HttpStatus.OK)
  async sendNotificationWithId(@Body() dto: SendNotificationDto): Promise<NotificationResponse> {
    this.logger.log(`Received notification with ID request: ${dto.message.substring(0, 50)}...`);

    const chatId = dto.chatId || this.botService.getOwnerChatId();
    if (!chatId) {
      return {
        success: false,
        error: 'No chat ID provided and owner chat ID not configured.',
      };
    }

    const result = await this.botService.sendNotificationWithId({
      chatId,
      message: dto.message,
      parseMode: dto.parseMode,
      buttons: dto.buttons,
    });

    if (!result.success) {
      return {
        success: false,
        error: 'Failed to send notification. Check logs for details.',
      };
    }

    return { success: true, messageId: result.messageId };
  }

  /**
   * Edit an existing message (for carousel navigation)
   * POST /notifications/edit
   */
  @Post('edit')
  @HttpCode(HttpStatus.OK)
  async editMessage(@Body() dto: EditMessageDto): Promise<NotificationResponse> {
    this.logger.log(`Received edit message request for messageId: ${dto.messageId}`);

    const success = await this.botService.editMessage(
      dto.chatId,
      dto.messageId,
      dto.message,
      {
        parseMode: dto.parseMode,
        buttons: dto.buttons,
      },
    );

    if (!success) {
      return {
        success: false,
        error: 'Failed to edit message. Check logs for details.',
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
