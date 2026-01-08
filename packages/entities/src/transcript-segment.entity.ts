import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Interaction } from './interaction.entity';
import { EntityRecord } from './entity.entity';

@Entity('transcript_segments')
export class TranscriptSegment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'interaction_id', type: 'uuid' })
  @Index()
  interactionId: string;

  @ManyToOne(() => Interaction, (i) => i.transcriptSegments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'interaction_id' })
  interaction: Interaction;

  @Column({ name: 'speaker_entity_id', type: 'uuid', nullable: true })
  @Index()
  speakerEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'speaker_entity_id' })
  speakerEntity: EntityRecord | null;

  @Column({ name: 'speaker_label', length: 50 })
  speakerLabel: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'start_time', type: 'decimal', precision: 10, scale: 3 })
  @Index()
  startTime: number;

  @Column({ name: 'end_time', type: 'decimal', precision: 10, scale: 3 })
  endTime: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  @Column({ type: 'vector', length: 1536, nullable: true })
  embedding: number[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
