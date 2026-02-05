import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ActivityMemberRole } from '@pkg/entities';

/**
 * Один участник для добавления.
 */
export class AddMemberItemDto {
  /**
   * ID сущности (Entity UUID)
   */
  @IsUUID()
  entityId: string;

  /**
   * Роль участника (по умолчанию MEMBER)
   */
  @IsOptional()
  @IsEnum(ActivityMemberRole)
  role?: ActivityMemberRole;

  /**
   * Заметки о роли участника
   */
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * DTO для добавления участников к активности.
 */
export class AddMembersDto {
  /**
   * Массив участников для добавления
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AddMemberItemDto)
  members: AddMemberItemDto[];
}
