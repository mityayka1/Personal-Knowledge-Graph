import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  UseGuards,
  Get,
} from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

/**
 * DTO for sending message as user
 */
export class SendAsUserDto {
  chatId: string;
  text: string;
  replyToMsgId?: number;
}

/**
 * Response from send-as-user endpoint
 */
export interface SendAsUserResponse {
  success: boolean;
  messageId?: number;
  date?: number;
  error?: string;
}

/**
 * Controller for sending messages via userbot (GramJS).
 *
 * IMPORTANT: This sends messages FROM THE USER'S ACCOUNT, not from the bot.
 * Use this only after user approval via the approval flow.
 *
 * Endpoint: POST /api/v1/telegram/send-as-user
 */
@Controller('telegram')
@UseGuards(ApiKeyGuard)
export class SendAsUserController {
  private readonly logger = new Logger(SendAsUserController.name);

  constructor(private readonly telegramService: TelegramService) {}

  /**
   * Send message as user via userbot
   * POST /api/v1/telegram/send-as-user
   */
  @Post('send-as-user')
  @HttpCode(HttpStatus.OK)
  async sendAsUser(@Body() dto: SendAsUserDto): Promise<SendAsUserResponse> {
    this.logger.log(
      `Received send-as-user request to ${dto.chatId}: ${dto.text.substring(0, 50)}...`,
    );

    const result = await this.telegramService.sendMessage(
      dto.chatId,
      dto.text,
      dto.replyToMsgId,
    );

    if (!result.success) {
      this.logger.warn(`Failed to send message to ${dto.chatId}: ${result.error}`);
    }

    return result;
  }

  /**
   * Check userbot status
   * GET /api/v1/telegram/status
   */
  @Get('status')
  async getStatus(): Promise<{ connected: boolean }> {
    return {
      connected: this.telegramService.isClientConnected(),
    };
  }
}
