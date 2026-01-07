import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Interaction } from './interaction.entity';

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

  @Column({ name: 'key_points', type: 'jsonb', nullable: true })
  keyPoints: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  decisions: string[] | null;

  @Column({ name: 'action_items', type: 'jsonb', nullable: true })
  actionItems: string[] | null;

  @Column({ name: 'facts_extracted', type: 'jsonb', nullable: true })
  factsExtracted: Array<{
    type: string;
    value: string;
    confidence: number;
  }> | null;

  @Column({ type: 'vector', length: 1536, nullable: true })
  embedding: number[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
