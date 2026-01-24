import {
  IsEnum,
  IsString,
  IsOptional,
  IsUUID,
  IsArray,
  ValidateNested,
  IsNumber,
  Min,
  Max,
  ArrayMinSize,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RelationType, RelationSource } from '@pkg/entities';

/**
 * DTO для участника связи.
 */
export class RelationMemberDto {
  @IsUUID()
  entityId: string;

  @IsString()
  @MaxLength(50)
  role: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  properties?: Record<string, unknown>;
}

/**
 * DTO для создания связи между сущностями.
 *
 * Примеры:
 * - EMPLOYMENT: [{ entityId: 'person', role: 'employee' }, { entityId: 'org', role: 'employer' }]
 * - MARRIAGE: [{ entityId: 'p1', role: 'spouse' }, { entityId: 'p2', role: 'spouse' }]
 */
export class CreateRelationDto {
  @IsEnum(RelationType)
  relationType: RelationType;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RelationMemberDto)
  @ArrayMinSize(2)
  members: RelationMemberDto[];

  @IsOptional()
  @IsEnum(RelationSource)
  source?: RelationSource;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  metadata?: Record<string, unknown>;
}

/**
 * DTO для добавления участника в существующую связь.
 */
export class AddMemberDto {
  @IsUUID()
  entityId: string;

  @IsString()
  @MaxLength(50)
  role: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  properties?: Record<string, unknown>;
}
