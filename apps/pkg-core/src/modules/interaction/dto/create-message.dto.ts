import { IsString, IsOptional, IsBoolean, IsDateString, IsEnum } from 'class-validator';
import { MediaType } from '@pkg/entities';

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
}
