import { IsOptional, IsString } from 'class-validator';

export class UpdateSettingDto {
  @IsOptional()
  value?: unknown;

  @IsOptional()
  @IsString()
  description?: string;
}

export class CreateSettingDto {
  @IsString()
  key: string;

  value: unknown;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: string;
}
