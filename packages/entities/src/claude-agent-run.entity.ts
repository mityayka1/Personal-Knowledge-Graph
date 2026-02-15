import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type ClaudeTaskType =
  | 'summarization'
  | 'profile_aggregation'
  | 'context_synthesis'
  | 'fact_extraction'
  | 'event_extraction'
  | 'context_enrichment'
  | 'fact_fusion'
  | 'recall'
  | 'meeting_prep'
  | 'daily_brief'
  | 'action'
  | 'draft_generation'
  | 'message_regeneration'
  | 'unified_extraction'
  | 'group_extraction'
  | 'fact_dedup_review'
  | 'description_enrichment'
  | 'event_cleanup_dedup'
  | 'event_activity_match'
  | 'activity_semantic_dedup';

export type ExecutionMode = 'oneshot' | 'agent';

export type ReferenceType = 'interaction' | 'entity' | 'message' | 'extracted_event' | null;

@Entity('claude_agent_runs')
export class ClaudeAgentRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'task_type', type: 'varchar', length: 50 })
  @Index()
  taskType: ClaudeTaskType;

  @Column({ type: 'varchar', length: 20, default: 'oneshot' })
  mode: ExecutionMode;

  @Column({ type: 'varchar', length: 50 })
  model: string; // 'claude-sonnet-4-5-20250514', etc.

  @Column({ name: 'tokens_in', type: 'int', nullable: true })
  tokensIn: number | null;

  @Column({ name: 'tokens_out', type: 'int', nullable: true })
  tokensOut: number | null;

  @Column({ name: 'cost_usd', type: 'decimal', precision: 10, scale: 6, nullable: true })
  costUsd: number | null;

  @Column({ name: 'duration_ms', type: 'int' })
  durationMs: number;

  @Column({ name: 'turns_count', type: 'int', default: 1 })
  turnsCount: number;

  @Column({ name: 'tools_used', type: 'jsonb', nullable: true })
  toolsUsed: string[] | null;

  @Column({ type: 'boolean' })
  success: boolean;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  // Reference to processed entity/interaction/message
  @Column({ name: 'reference_type', type: 'varchar', length: 50, nullable: true })
  referenceType: ReferenceType;

  @Column({ name: 'reference_id', type: 'uuid', nullable: true })
  @Index()
  referenceId: string | null;

  @Column({ name: 'input_preview', type: 'text', nullable: true })
  inputPreview: string | null; // First 500 chars of input

  @Column({ name: 'output_preview', type: 'text', nullable: true })
  outputPreview: string | null; // First 500 chars of output

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Date field for analytics grouping
  @Index()
  @Column({ name: 'created_date', type: 'date' })
  createdDate: Date;
}
