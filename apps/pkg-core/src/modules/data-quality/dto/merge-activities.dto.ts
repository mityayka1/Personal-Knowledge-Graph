import {
  IsString,
  IsUUID,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';

export class MergeActivitiesDto {
  @IsString()
  @IsUUID()
  keepId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  mergeIds: string[];
}
