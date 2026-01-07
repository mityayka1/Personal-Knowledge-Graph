import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EntityRecord } from './entity.entity';
import { Interaction } from './interaction.entity';
import { Message } from './message.entity';

export enum PendingFactStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Entity('pending_facts')
export class PendingFact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  @Index()
  entityId: string;

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;

  @Column({ name: 'fact_type', length: 50 })
  factType: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  value: string | null;

  @Column({ name: 'value_date', type: 'date', nullable: true })
  valueDate: Date | null;

  @Column({ type: 'decimal', precision: 3, scale: 2 })
  confidence: number;

  @Column({ name: 'source_quote', type: 'text', nullable: true })
  sourceQuote: string | null;

  @Column({ name: 'source_interaction_id', type: 'uuid', nullable: true })
  sourceInteractionId: string | null;

  @ManyToOne(() => Interaction, { nullable: true })
  @JoinColumn({ name: 'source_interaction_id' })
  sourceInteraction: Interaction | null;

  @Column({ name: 'source_message_id', type: 'uuid', nullable: true })
  sourceMessageId: string | null;

  @ManyToOne(() => Message, { nullable: true })
  @JoinColumn({ name: 'source_message_id' })
  sourceMessage: Message | null;

  @Column({ length: 20, default: PendingFactStatus.PENDING })
  @Index()
  status: PendingFactStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'reviewed_at', type: 'timestamp with time zone', nullable: true })
  reviewedAt: Date | null;
}
