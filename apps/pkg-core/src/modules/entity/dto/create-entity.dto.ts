import { IsEnum, IsString, IsOptional, IsUUID, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { EntityType, IdentifierType, FactType, FactCategory, FactSource } from '@pkg/entities';

export class CreateIdentifierDto {
  @IsEnum(IdentifierType)
  type: IdentifierType;

  @IsString()
  value: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class CreateFactDto {
  @IsEnum(FactType)
  type: FactType;

  @IsOptional()
  @IsEnum(FactCategory)
  category?: FactCategory;

  @IsOptional()
  @IsString()
  value?: string;

  @IsOptional()
  valueDate?: Date;

  @IsOptional()
  valueJson?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(FactSource)
  source?: FactSource;
}

export class CreateEntityDto {
  @IsEnum(EntityType)
  type: EntityType;

  @IsString()
  name: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateIdentifierDto)
  identifiers?: CreateIdentifierDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateFactDto)
  facts?: CreateFactDto[];
}
