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
  | 'fact_extraction';

export type ReferenceType = 'interaction' | 'entity' | 'message' | null;

@Entity('claude_cli_runs')
export class ClaudeCliRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'task_type', type: 'varchar', length: 50 })
  taskType: ClaudeTaskType;

  @Column({ type: 'varchar', length: 50 })
  model: string; // 'claude-3-5-sonnet', 'claude-3-haiku', etc.

  @Column({ name: 'agent_name', type: 'varchar', length: 50, nullable: true })
  agentName: string | null; // 'summarizer', 'profile-aggregator', etc.

  @Column({ name: 'tokens_in', type: 'int', nullable: true })
  tokensIn: number | null;

  @Column({ name: 'tokens_out', type: 'int', nullable: true })
  tokensOut: number | null;

  @Column({ name: 'cost_usd', type: 'decimal', precision: 10, scale: 6, nullable: true })
  costUsd: number | null;

  @Column({ name: 'duration_ms', type: 'int' })
  durationMs: number;

  @Column({ type: 'boolean' })
  success: boolean;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  // Reference to processed entity
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
