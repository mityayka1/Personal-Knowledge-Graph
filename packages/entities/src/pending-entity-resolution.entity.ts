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

/**
 * Metadata for pending entity resolution.
 * Base fields are Telegram-specific, extraction-specific fields are added
 * for context-aware extraction workflow.
 * Index signature allows additional fields for future extensions.
 */
export interface PendingResolutionMetadata {
  // Telegram-specific fields
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  about?: string;
  isBot?: boolean;
  isVerified?: boolean;
  isPremium?: boolean;
  photoBase64?: string;
  birthday?: string;

  // Extraction-specific fields
  mentionedAs?: string;
  relatedToEntityId?: string;
  sourceMessageId?: string | null;
  sourceInteractionId?: string | null;

  // Allow additional fields for future extensions
  [key: string]: unknown;
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

  @Column({ name: 'display_name', type: 'varchar', length: 255, nullable: true })
  displayName: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: PendingResolutionMetadata | null;

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
