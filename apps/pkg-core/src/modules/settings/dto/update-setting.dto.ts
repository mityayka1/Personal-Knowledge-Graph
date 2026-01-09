import { IsOptional, IsString, IsDefined } from 'class-validator';

export class UpdateSettingDto {
  @IsDefined({ message: 'value is required' })
  value: string | number | boolean | object;

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
