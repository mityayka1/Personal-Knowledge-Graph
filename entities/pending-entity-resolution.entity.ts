import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm';
import { EntityRecord } from './entity.entity';

export enum ResolutionStatus {
  PENDING = 'pending',
  RESOLVED = 'resolved',
  IGNORED = 'ignored',
}

@Entity('pending_entity_resolutions')
@Unique(['identifierType', 'identifierValue'])
export class PendingEntityResolution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'identifier_type', length: 50 })
  @Index()
  identifierType: string;

  @Column({ name: 'identifier_value', length: 255 })
  identifierValue: string;

  @Column({ name: 'display_name', length: 255, nullable: true })
  displayName: string | null;

  @Column({ length: 20, default: ResolutionStatus.PENDING })
  @Index()
  status: ResolutionStatus;

  @Column({ name: 'resolved_entity_id', type: 'uuid', nullable: true })
  resolvedEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'resolved_entity_id' })
  resolvedEntity: EntityRecord | null;

  @Column({ type: 'jsonb', nullable: true })
  suggestions: Array<{
    entity_id: string;
    name: string;
    confidence: number;
    reason: string;
  }> | null;

  @Column({ name: 'sample_message_ids', type: 'jsonb', nullable: true })
  sampleMessageIds: string[] | null;

  @Column({ name: 'first_seen_at', type: 'timestamp with time zone' })
  firstSeenAt: Date;

  @Column({ name: 'resolved_at', type: 'timestamp with time zone', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
