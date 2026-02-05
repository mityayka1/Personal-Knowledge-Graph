import {
  IsString,
  IsOptional,
  IsObject,
  IsDateString,
  IsUUID,
  IsEnum,
} from 'class-validator';
import { ActivityPriority } from '@pkg/entities';

export class BriefItemActionDto {
  @IsString()
  action: string;
}

/**
 * DTO for updating a pending approval's target entity.
 * All fields are optional - only provided fields will be updated.
 */
export class UpdatePendingApprovalTargetDto {
  /**
   * Name/title of the entity.
   * For Activity: name field. For Commitment: title field.
   */
  @IsString()
  @IsOptional()
  name?: string;

  /**
   * Description of the entity.
   */
  @IsString()
  @IsOptional()
  description?: string;

  /**
   * Priority level.
   */
  @IsEnum(ActivityPriority)
  @IsOptional()
  priority?: ActivityPriority;

  /**
   * Deadline/due date (ISO 8601 string).
   * Null to clear the deadline.
   */
  @IsDateString()
  @IsOptional()
  deadline?: string | null;

  /**
   * Parent activity ID (for tasks/projects hierarchy).
   * Null to make it a root activity.
   */
  @IsUUID()
  @IsOptional()
  parentId?: string | null;
}

export class ConfirmExtractionDto {
  @IsObject()
  @IsOptional()
  edits?: Record<string, unknown>;
}

export class SkipExtractionDto {
  @IsString()
  @IsOptional()
  reason?: string;
}
