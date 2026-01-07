import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum JobType {
  TRANSCRIPTION = 'transcription',
  EMBEDDING = 'embedding',
  SUMMARIZATION = 'summarization',
  FACT_EXTRACTION = 'fact_extraction',
  ENTITY_RESOLUTION = 'entity_resolution',
}

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 50 })
  @Index()
  type: JobType;

  @Column({ length: 20, default: JobStatus.PENDING })
  @Index()
  status: JobStatus;

  @Column({ type: 'jsonb' })
  payload: {
    audio_file_path?: string;
    interaction_id?: string;
    message_id?: string;
    segment_id?: string;
    content?: string;
    entity_id?: string;
    message_ids?: string[];
    pending_resolution_id?: string;
    [key: string]: unknown;
  };

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'timestamp with time zone', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null;
}
