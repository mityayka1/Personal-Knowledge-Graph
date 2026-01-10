import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Interaction } from './interaction.entity';

// Structured types for decisions and action items
export interface Decision {
  description: string;
  date: string | null;
  importance: 'high' | 'medium' | 'low';
  quote?: string;
}

export interface ActionItem {
  description: string;
  owner: 'self' | 'them' | 'both';
  status: 'open' | 'closed';
  dueDate?: string;
  closedAt?: string;
}

export interface ImportantMessageRef {
  messageId: string;
  content: string;
  timestamp: string;
  reason: 'decision' | 'agreement' | 'deadline' | 'important_info';
}

export type ToneType = 'positive' | 'neutral' | 'negative' | 'formal' | 'informal';

@Entity('interaction_summaries')
export class InteractionSummary {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'interaction_id', type: 'uuid', unique: true })
  interactionId: string;

  @OneToOne(() => Interaction, (i) => i.summary, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'interaction_id' })
  interaction: Interaction;

  @Column({ name: 'summary_text', type: 'text' })
  summaryText: string;

  @Column({ name: 'key_points', type: 'jsonb', default: [] })
  keyPoints: string[];

  // Emotional tone of the interaction
  @Column({ type: 'varchar', length: 20, nullable: true })
  tone: ToneType | null;

  // Structured decisions (was string[], now Decision[])
  @Column({ type: 'jsonb', default: [] })
  decisions: Decision[];

  // Structured action items (was string[], now ActionItem[])
  @Column({ name: 'action_items', type: 'jsonb', default: [] })
  actionItems: ActionItem[];

  // References to important messages
  @Column({ name: 'important_messages', type: 'jsonb', default: [] })
  importantMessages: ImportantMessageRef[];

  @Column({ name: 'facts_extracted', type: 'jsonb', nullable: true })
  factsExtracted: Array<{
    type: string;
    value: string;
    confidence: number;
  }> | null;

  // Summarization metrics
  @Column({ name: 'message_count', type: 'int', nullable: true })
  messageCount: number | null;

  @Column({ name: 'source_token_count', type: 'int', nullable: true })
  sourceTokenCount: number | null;

  @Column({ name: 'summary_token_count', type: 'int', nullable: true })
  summaryTokenCount: number | null;

  @Column({ name: 'compression_ratio', type: 'decimal', precision: 5, scale: 2, nullable: true })
  compressionRatio: number | null;

  // Model and cost tracking
  @Column({ name: 'model_version', type: 'varchar', length: 50, nullable: true })
  modelVersion: string | null;

  @Column({ name: 'generation_cost_usd', type: 'decimal', precision: 10, scale: 6, nullable: true })
  generationCostUsd: number | null;

  // Revision tracking
  @Column({ name: 'revision_count', type: 'int', default: 1 })
  revisionCount: number;

  // pgvector column for semantic search
  @Column({ type: 'vector', length: 1536, nullable: true })
  embedding: number[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
