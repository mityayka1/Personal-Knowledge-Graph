import { IsNumber, IsString, IsNotEmpty, Min, MaxLength } from 'class-validator';

export class ResolveIssueDto {
  @IsNumber()
  @Min(0)
  issueIndex: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  action: string;
}
