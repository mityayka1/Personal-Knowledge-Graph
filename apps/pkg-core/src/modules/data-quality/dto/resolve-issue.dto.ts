import { IsNumber, IsString, Min, MaxLength } from 'class-validator';

export class ResolveIssueDto {
  @IsNumber()
  @Min(0)
  issueIndex: number;

  @IsString()
  @MaxLength(500)
  action: string;
}
