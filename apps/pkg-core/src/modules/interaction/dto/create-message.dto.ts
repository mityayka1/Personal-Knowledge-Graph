import { IsString, IsOptional, IsBoolean, IsDateString, IsEnum, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MediaType } from '@pkg/entities';

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
}
