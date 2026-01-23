import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EntityRecord } from './entity.entity';
import { Message } from './message.entity';

export enum EventType {
  MEETING = 'meeting',
  DEADLINE = 'deadline',
  COMMITMENT = 'commitment',
  FOLLOW_UP = 'follow_up',
}

export enum EventStatus {
  SCHEDULED = 'scheduled',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  DISMISSED = 'dismissed',
}

@Entity('entity_events')
export class EntityEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  @Index()
  entityId: string;

  @ManyToOne(() => EntityRecord)
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;

  @Column({ name: 'related_entity_id', type: 'uuid', nullable: true })
  @Index()
  relatedEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'related_entity_id' })
  relatedEntity: EntityRecord | null;

  @Column({ name: 'event_type', type: 'varchar', length: 20 })
  eventType: EventType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'event_date', type: 'timestamp with time zone', nullable: true })
  @Index()
  eventDate: Date | null;

  @Column({ type: 'varchar', length: 20, default: EventStatus.SCHEDULED })
  @Index()
  status: EventStatus;

  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  @Column({ name: 'source_message_id', type: 'uuid', nullable: true })
  sourceMessageId: string | null;

  @ManyToOne(() => Message, { nullable: true })
  @JoinColumn({ name: 'source_message_id' })
  sourceMessage: Message | null;

  @Column({ name: 'source_quote', type: 'text', nullable: true })
  sourceQuote: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
