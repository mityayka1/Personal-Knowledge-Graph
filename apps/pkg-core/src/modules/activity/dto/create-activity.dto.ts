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
 * DTO для создания активности.
 */
export class CreateActivityDto {
  /**
   * Название активности
   */
  @IsString()
  @MaxLength(500)
  name: string;

  /**
   * Тип активности
   */
  @IsEnum(ActivityType)
  activityType: ActivityType;

  /**
   * Описание (опционально)
   */
  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Статус (по умолчанию ACTIVE)
   */
  @IsOptional()
  @IsEnum(ActivityStatus)
  status?: ActivityStatus;

  /**
   * Приоритет (по умолчанию MEDIUM)
   */
  @IsOptional()
  @IsEnum(ActivityPriority)
  priority?: ActivityPriority;

  /**
   * Контекст (по умолчанию ANY)
   */
  @IsOptional()
  @IsEnum(ActivityContext)
  context?: ActivityContext;

  /**
   * ID родительской активности (для вложенных)
   */
  @IsOptional()
  @IsUUID()
  parentId?: string;

  /**
   * ID владельца (обычно "я")
   */
  @IsUUID()
  ownerEntityId: string;

  /**
   * ID клиента (для клиентских проектов)
   */
  @IsOptional()
  @IsUUID()
  clientEntityId?: string;

  /**
   * Дедлайн
   */
  @IsOptional()
  @IsDateString()
  deadline?: string;

  /**
   * Дата начала
   */
  @IsOptional()
  @IsDateString()
  startDate?: string;

  /**
   * Cron-выражение для повторяющихся активностей
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  recurrenceRule?: string;

  /**
   * Теги для фильтрации
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /**
   * Прогресс выполнения (0-100)
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  /**
   * Дополнительные метаданные
   */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
