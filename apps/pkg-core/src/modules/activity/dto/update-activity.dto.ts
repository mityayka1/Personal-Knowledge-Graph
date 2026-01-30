import {
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  IsDateString,
  IsInt,
  IsArray,
  Min,
  Max,
  MaxLength,
  IsObject,
} from 'class-validator';
import {
  ActivityType,
  ActivityStatus,
  ActivityPriority,
  ActivityContext,
} from '@pkg/entities';

/**
 * DTO для обновления активности.
 * Все поля опциональны.
 */
export class UpdateActivityDto {
  /**
   * Название активности
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  /**
   * Тип активности
   */
  @IsOptional()
  @IsEnum(ActivityType)
  activityType?: ActivityType;

  /**
   * Описание
   */
  @IsOptional()
  @IsString()
  description?: string | null;

  /**
   * Статус
   */
  @IsOptional()
  @IsEnum(ActivityStatus)
  status?: ActivityStatus;

  /**
   * Приоритет
   */
  @IsOptional()
  @IsEnum(ActivityPriority)
  priority?: ActivityPriority;

  /**
   * Контекст
   */
  @IsOptional()
  @IsEnum(ActivityContext)
  context?: ActivityContext;

  /**
   * ID родительской активности
   */
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  /**
   * ID владельца
   */
  @IsOptional()
  @IsUUID()
  ownerEntityId?: string;

  /**
   * ID клиента
   */
  @IsOptional()
  @IsUUID()
  clientEntityId?: string | null;

  /**
   * Дедлайн
   */
  @IsOptional()
  @IsDateString()
  deadline?: string | null;

  /**
   * Дата начала
   */
  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  /**
   * Фактическая дата завершения
   */
  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  /**
   * Cron-выражение для повторяющихся активностей
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  recurrenceRule?: string | null;

  /**
   * Теги для фильтрации
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[] | null;

  /**
   * Прогресс выполнения (0-100)
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number | null;

  /**
   * Дополнительные метаданные
   */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown> | null;
}
