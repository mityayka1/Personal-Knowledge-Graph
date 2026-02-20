import {
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  IsNumber,
  Min,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  ActivityType,
  ActivityStatus,
  ActivityContext,
} from '@pkg/entities';

/**
 * DTO для query-параметров списка активностей.
 */
export class ActivityQueryDto {
  /**
   * Фильтр по типу активности
   */
  @IsOptional()
  @IsEnum(ActivityType)
  activityType?: ActivityType;

  /**
   * Фильтр по статусу
   */
  @IsOptional()
  @IsEnum(ActivityStatus)
  status?: ActivityStatus;

  /**
   * Фильтр по контексту (work/personal/any)
   */
  @IsOptional()
  @IsEnum(ActivityContext)
  context?: ActivityContext;

  /**
   * Фильтр по родительской активности.
   * Передайте UUID для конкретного родителя или "null" для root activities (parentId IS NULL).
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'null' ? null : value))
  @ValidateIf((o) => o.parentId !== null)
  @IsUUID()
  parentId?: string | null;

  /**
   * Фильтр по владельцу
   */
  @IsOptional()
  @IsUUID()
  ownerEntityId?: string;

  /**
   * Фильтр по клиенту
   */
  @IsOptional()
  @IsUUID()
  clientEntityId?: string;

  /**
   * Поиск по названию (ILIKE)
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /**
   * Максимальное количество записей
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;

  /**
   * Смещение (для пагинации)
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  offset?: number;
}
