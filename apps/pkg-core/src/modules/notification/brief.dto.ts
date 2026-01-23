import { IsOptional, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for action requests
 */
export class BriefActionDto {
  @ApiPropertyOptional({
    description: 'Type of action to trigger',
    enum: ['write', 'remind', 'prepare'],
  })
  @IsOptional()
  @IsIn(['write', 'remind', 'prepare'])
  actionType?: 'write' | 'remind' | 'prepare';
}
