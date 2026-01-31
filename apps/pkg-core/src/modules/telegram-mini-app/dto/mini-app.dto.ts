import { IsString, IsOptional, IsObject } from 'class-validator';

export class BriefItemActionDto {
  @IsString()
  action: string;
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
