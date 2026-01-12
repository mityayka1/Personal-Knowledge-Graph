import { IsEnum } from 'class-validator';
import { ChatCategory } from '@pkg/entities';

export class UpdateChatCategoryDto {
  @IsEnum(ChatCategory)
  category: ChatCategory;
}
