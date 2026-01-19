import {
  IsString,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsEnum,
  ValidateNested,
  IsNumber,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MediaType, ChatType } from '@pkg/entities';

export class TelegramUserInfoDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isBot?: boolean;

  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @IsOptional()
  @IsBoolean()
  isPremium?: boolean;

  @IsOptional()
  @IsString()
  photoBase64?: string;

  /**
   * Birthday in format "YYYY-MM-DD" or "MM-DD" (if year not shared by user)
   */
  @IsOptional()
  @IsString()
  birthday?: string;
}

export class CreateMessageDto {
  @IsString()
  source: string;

  @IsString()
  telegram_chat_id: string;

  @IsString()
  telegram_user_id: string;

  @IsOptional()
  @IsString()
  telegram_username?: string;

  @IsOptional()
  @IsString()
  telegram_display_name?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TelegramUserInfoDto)
  telegram_user_info?: TelegramUserInfoDto;

  @IsString()
  message_id: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsDateString()
  timestamp: string;

  @IsBoolean()
  is_outgoing: boolean;

  @IsOptional()
  @IsString()
  reply_to_message_id?: string;

  @IsOptional()
  @IsEnum(MediaType)
  media_type?: MediaType;

  @IsOptional()
  @IsString()
  media_url?: string;

  @IsOptional()
  @IsObject()
  media_metadata?: {
    id: string;
    accessHash: string;
    fileReference: string;
    dcId: number;
    sizes?: Array<{ type: string; width: number; height: number; size: number }>;
    mimeType?: string;
    size?: number;
    fileName?: string;
    duration?: number;
    width?: number;
    height?: number;
    hasThumb?: boolean;
  };

  /**
   * Type of chat: private, group, supergroup, channel, forum.
   * Private chats trigger automatic Entity creation for the contact.
   */
  @IsOptional()
  @IsEnum(ChatType)
  chat_type?: ChatType;

  /**
   * Forum topic ID. Each topic in a forum is treated as a separate thread.
   * Limit during import is applied per topic.
   */
  @IsOptional()
  @IsNumber()
  topic_id?: number;

  /**
   * Forum topic name for display (e.g., "General", "Support").
   */
  @IsOptional()
  @IsString()
  topic_name?: string;

  /**
   * Number of participants in the chat.
   * Used for categorization (working group <= 20, mass group > 20).
   */
  @IsOptional()
  @IsNumber()
  participants_count?: number;

  /**
   * Chat title (for groups/channels) or contact name (for private chats).
   * Used for display in the dashboard.
   */
  @IsOptional()
  @IsString()
  chat_title?: string;

  /**
   * Recipient user ID for outgoing messages in private chats.
   * Used to identify the contact entity to update.
   */
  @IsOptional()
  @IsString()
  recipient_user_id?: string;

  /**
   * Recipient user info for outgoing messages in private chats.
   * Contains name, photo, birthday etc. for entity updates.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => TelegramUserInfoDto)
  recipient_user_info?: TelegramUserInfoDto;
}
