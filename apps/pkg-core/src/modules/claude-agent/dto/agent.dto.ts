import {
  IsString,
  MinLength,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request DTO for POST /agent/recall
 */
export class RecallRequestDto {
  @ApiProperty({
    description: 'Natural language query for searching conversations',
    example: 'что обсуждали с Иваном на прошлой неделе?',
    minLength: 3,
  })
  @IsString()
  @MinLength(3, { message: 'Query must be at least 3 characters' })
  query: string;

  @ApiPropertyOptional({
    description: 'Filter results to specific entity (person/organization) by UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsUUID('4', { message: 'entityId must be a valid UUID' })
  entityId?: string;

  @ApiPropertyOptional({
    description: 'Maximum agent iterations (turns)',
    minimum: 1,
    maximum: 20,
    default: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxTurns?: number;

  @ApiPropertyOptional({
    description: 'Claude model to use',
    enum: ['haiku', 'sonnet', 'opus'],
    default: 'sonnet',
  })
  @IsOptional()
  @IsIn(['haiku', 'sonnet', 'opus'], { message: 'model must be haiku, sonnet, or opus' })
  model?: 'haiku' | 'sonnet' | 'opus';

  @ApiPropertyOptional({
    description: 'User ID for session ownership (multi-user safety)',
    example: '864381617',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}

/**
 * Source reference in recall response
 */
export class RecallSourceDto {
  @ApiProperty({
    enum: ['message', 'interaction'],
    description: 'Type of source',
  })
  type: 'message' | 'interaction';

  @ApiProperty({ description: 'Source UUID' })
  id: string;

  @ApiProperty({
    description: 'Short preview/quote from source (up to 200 chars)',
  })
  preview: string;
}

/**
 * Response data for recall endpoint
 */
export class RecallResponseDataDto {
  @ApiProperty({
    description: 'Session ID for follow-up operations (extract, continue conversation)',
    example: 'rs_a1b2c3d4e5f6',
  })
  sessionId: string;

  @ApiProperty({ description: 'Agent answer in natural language (Russian)' })
  answer: string;

  @ApiProperty({
    type: [RecallSourceDto],
    description: 'Sources used to generate the answer',
  })
  sources: RecallSourceDto[];

  @ApiProperty({
    type: [String],
    description: 'Tools invoked during agent execution',
  })
  toolsUsed: string[];
}

/**
 * Full response for recall endpoint
 */
export class RecallResponseDto {
  @ApiProperty({ description: 'Operation success flag' })
  success: boolean;

  @ApiProperty({ type: RecallResponseDataDto })
  data: RecallResponseDataDto;
}

/**
 * Response data for prepare endpoint
 */
export class PrepareResponseDataDto {
  @ApiProperty({ description: 'Entity UUID' })
  entityId: string;

  @ApiProperty({ description: 'Entity display name' })
  entityName: string;

  @ApiProperty({ description: 'Structured markdown brief about the entity' })
  brief: string;

  @ApiProperty({ description: 'Number of recent interactions found' })
  recentInteractions: number;

  @ApiProperty({
    type: [String],
    description: 'Open questions or pending action items',
  })
  openQuestions: string[];
}

/**
 * Full response for prepare endpoint
 */
export class PrepareResponseDto {
  @ApiProperty({ description: 'Operation success flag' })
  success: boolean;

  @ApiProperty({ type: PrepareResponseDataDto })
  data: PrepareResponseDataDto;
}

// =====================================================
// Act endpoint DTOs
// =====================================================

/**
 * Request DTO for POST /agent/act
 */
export class ActRequestDto {
  @ApiProperty({
    description: 'Natural language instruction for action',
    example: 'напиши Сергею что встреча переносится на завтра',
    minLength: 5,
  })
  @IsString()
  @MinLength(5, { message: 'Instruction must be at least 5 characters' })
  instruction: string;

  @ApiPropertyOptional({
    description: 'Maximum agent iterations (turns)',
    minimum: 1,
    maximum: 15,
    default: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(15)
  maxTurns?: number;
}

/**
 * Action taken during act execution
 */
export class ActActionDto {
  @ApiProperty({
    description: 'Action type',
    enum: ['draft_created', 'message_sent', 'approval_rejected', 'followup_created'],
  })
  type: 'draft_created' | 'message_sent' | 'approval_rejected' | 'followup_created';

  @ApiPropertyOptional({ description: 'Entity ID involved' })
  entityId?: string;

  @ApiPropertyOptional({ description: 'Entity name' })
  entityName?: string;

  @ApiPropertyOptional({ description: 'Additional details' })
  details?: string;
}

/**
 * Response data for act endpoint
 */
export class ActResponseDataDto {
  @ApiProperty({ description: 'Result summary from agent' })
  result: string;

  @ApiProperty({
    type: [ActActionDto],
    description: 'Actions taken during execution',
  })
  actions: ActActionDto[];

  @ApiProperty({
    type: [String],
    description: 'Tools invoked during agent execution',
  })
  toolsUsed: string[];
}

/**
 * Full response for act endpoint
 */
export class ActResponseDto {
  @ApiProperty({ description: 'Operation success flag' })
  success: boolean;

  @ApiProperty({ type: ActResponseDataDto })
  data: ActResponseDataDto;
}

// =====================================================
// Daily Extract endpoint DTOs
// =====================================================

/**
 * Request DTO for POST /agent/daily/extract
 */
export class DailyExtractRequestDto {
  @ApiProperty({
    description: 'Daily synthesis text to extract structured data from',
    example: 'Сегодня работал над Хабом для Панавто с Машей...',
    minLength: 10,
  })
  @IsString()
  @MinLength(10, { message: 'Synthesis text must be at least 10 characters' })
  synthesisText: string;

  @ApiPropertyOptional({
    description: 'Date of the daily (ISO format or human readable)',
    example: '2026-01-30',
  })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiPropertyOptional({
    description: 'Focus topic if daily was focused on specific area',
    example: 'Панавто',
  })
  @IsOptional()
  @IsString()
  focusTopic?: string;
}

/**
 * Extracted project from daily synthesis
 */
export class ExtractedProjectDto {
  @ApiProperty({ description: 'Project name as mentioned' })
  name: string;

  @ApiProperty({ description: 'Is this a new project or existing?' })
  isNew: boolean;

  @ApiPropertyOptional({ description: 'Matched existing activity UUID' })
  existingActivityId?: string;

  @ApiProperty({ type: [String], description: 'Participant names' })
  participants: string[];

  @ApiPropertyOptional({ description: 'Client name if mentioned' })
  client?: string;

  @ApiPropertyOptional({ description: 'Status if mentioned' })
  status?: string;

  @ApiPropertyOptional({ description: 'Source quote from text' })
  sourceQuote?: string;

  @ApiProperty({ description: 'Extraction confidence (0-1)' })
  confidence: number;
}

/**
 * Extracted task from daily synthesis
 */
export class ExtractedTaskDto {
  @ApiProperty({ description: 'Task title' })
  title: string;

  @ApiPropertyOptional({ description: 'Parent project name' })
  projectName?: string;

  @ApiPropertyOptional({ description: 'Deadline in ISO format' })
  deadline?: string;

  @ApiPropertyOptional({ description: 'Assignee: "self" or person name' })
  assignee?: string;

  @ApiProperty({
    enum: ['pending', 'in_progress', 'done'],
    description: 'Task status',
  })
  status: 'pending' | 'in_progress' | 'done';

  @ApiPropertyOptional({
    enum: ['high', 'medium', 'low'],
    description: 'Priority',
  })
  priority?: 'high' | 'medium' | 'low';

  @ApiProperty({ description: 'Extraction confidence (0-1)' })
  confidence: number;
}

/**
 * Extracted commitment from daily synthesis
 */
export class ExtractedCommitmentDto {
  @ApiProperty({ description: 'What was promised/agreed' })
  what: string;

  @ApiProperty({ description: 'Who made the promise' })
  from: string;

  @ApiProperty({ description: 'Promise recipient' })
  to: string;

  @ApiPropertyOptional({ description: 'Due date in ISO format' })
  deadline?: string;

  @ApiProperty({
    enum: ['promise', 'request', 'agreement', 'deadline', 'reminder'],
    description: 'Commitment type',
  })
  type: 'promise' | 'request' | 'agreement' | 'deadline' | 'reminder';

  @ApiPropertyOptional({
    enum: ['high', 'medium', 'low'],
    description: 'Priority',
  })
  priority?: 'high' | 'medium' | 'low';

  @ApiProperty({ description: 'Extraction confidence (0-1)' })
  confidence: number;
}

/**
 * Inferred relation from daily synthesis
 */
export class InferredRelationDto {
  @ApiProperty({
    enum: ['project_member', 'works_on', 'client_of', 'responsible_for'],
    description: 'Relation type',
  })
  type: 'project_member' | 'works_on' | 'client_of' | 'responsible_for';

  @ApiProperty({ type: [String], description: 'Entity names involved' })
  entities: string[];

  @ApiPropertyOptional({ description: 'Activity name if applicable' })
  activityName?: string;

  @ApiProperty({ description: 'Inference confidence (0-1)' })
  confidence: number;
}

/**
 * Response data for daily extract endpoint
 */
export class DailyExtractResponseDataDto {
  @ApiProperty({
    type: [ExtractedProjectDto],
    description: 'Extracted projects',
  })
  projects: ExtractedProjectDto[];

  @ApiProperty({
    type: [ExtractedTaskDto],
    description: 'Extracted tasks',
  })
  tasks: ExtractedTaskDto[];

  @ApiProperty({
    type: [ExtractedCommitmentDto],
    description: 'Extracted commitments',
  })
  commitments: ExtractedCommitmentDto[];

  @ApiProperty({
    type: [InferredRelationDto],
    description: 'Inferred entity-activity relations',
  })
  inferredRelations: InferredRelationDto[];

  @ApiProperty({ description: 'Brief summary of extraction' })
  extractionSummary: string;

  @ApiProperty({ description: 'Tokens used for extraction' })
  tokensUsed: number;

  @ApiProperty({ description: 'Extraction duration in ms' })
  durationMs: number;
}

/**
 * Full response for daily extract endpoint
 */
export class DailyExtractResponseDto {
  @ApiProperty({ description: 'Operation success flag' })
  success: boolean;

  @ApiProperty({ type: DailyExtractResponseDataDto })
  data: DailyExtractResponseDataDto;
}

// =====================================================
// Recall Session DTOs
// =====================================================

/**
 * Recall session data for GET /agent/recall/session/:sessionId
 */
export class RecallSessionDataDto {
  @ApiProperty({ description: 'Session ID', example: 'rs_a1b2c3d4e5f6' })
  sessionId: string;

  @ApiProperty({ description: 'Original query' })
  query: string;

  @ApiProperty({ description: 'Date string (YYYY-MM-DD)' })
  dateStr: string;

  @ApiProperty({ description: 'LLM synthesis answer' })
  answer: string;

  @ApiProperty({
    type: [RecallSourceDto],
    description: 'Sources used in the answer',
  })
  sources: RecallSourceDto[];

  @ApiPropertyOptional({
    enum: ['haiku', 'sonnet', 'opus'],
    description: 'Model used for synthesis',
  })
  model?: 'haiku' | 'sonnet' | 'opus';

  @ApiProperty({ description: 'Session creation timestamp' })
  createdAt: number;
}

/**
 * Response for GET /agent/recall/session/:sessionId
 */
export class RecallSessionResponseDto {
  @ApiProperty({ description: 'Operation success flag' })
  success: boolean;

  @ApiProperty({ type: RecallSessionDataDto })
  data: RecallSessionDataDto;
}

/**
 * Request DTO for POST /agent/recall/session/:sessionId/followup
 */
export class RecallFollowupRequestDto {
  @ApiProperty({
    description: 'Follow-up query in context of the session',
    example: 'А что насчёт дедлайнов?',
    minLength: 2,
  })
  @IsString()
  @MinLength(2, { message: 'Query must be at least 2 characters' })
  query: string;

  @ApiPropertyOptional({
    description: 'Claude model to use (inherits from session if not specified)',
    enum: ['haiku', 'sonnet', 'opus'],
  })
  @IsOptional()
  @IsIn(['haiku', 'sonnet', 'opus'], { message: 'model must be haiku, sonnet, or opus' })
  model?: 'haiku' | 'sonnet' | 'opus';

  @ApiPropertyOptional({
    description: 'User ID for verification (multi-user safety)',
    example: '864381617',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}

/**
 * Request DTO for POST /agent/recall/session/:sessionId/save
 */
export class RecallSaveRequestDto {
  @ApiPropertyOptional({
    description: 'User ID for verification (multi-user safety)',
    example: '864381617',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}

/**
 * Response for save endpoint
 */
export class RecallSaveResponseDto {
  @ApiProperty({ description: 'Operation success flag' })
  success: boolean;

  @ApiPropertyOptional({ description: 'Created fact ID (if newly saved)' })
  factId?: string;

  @ApiPropertyOptional({ description: 'Whether this session was already saved' })
  alreadySaved?: boolean;

  @ApiPropertyOptional({ description: 'Error message if failed' })
  error?: string;
}

/**
 * Request DTO for POST /agent/recall/session/:sessionId/extract
 */
export class RecallExtractRequestDto {
  @ApiPropertyOptional({
    description: 'Focus topic for extraction (optional)',
    example: 'Панавто',
  })
  @IsOptional()
  @IsString()
  focusTopic?: string;

  @ApiPropertyOptional({
    description: 'Model to use for extraction',
    enum: ['haiku', 'sonnet', 'opus'],
    default: 'sonnet',
  })
  @IsOptional()
  @IsIn(['haiku', 'sonnet', 'opus'], { message: 'model must be haiku, sonnet, or opus' })
  model?: 'haiku' | 'sonnet' | 'opus';

  @ApiPropertyOptional({
    description: 'User ID for verification (multi-user safety)',
    example: '864381617',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}
