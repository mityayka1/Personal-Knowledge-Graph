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
import { Message } from './message.entity';
import { PendingFact } from './pending-fact.entity';
import { ExtractedEvent } from './extracted-event.entity';

/**
 * Types of confirmations that can be requested from user
 */
export enum PendingConfirmationType {
  /** Link identifier to existing or new entity */
  IDENTIFIER_ATTRIBUTION = 'identifier_attribution',
  /** Merge two entities */
  ENTITY_MERGE = 'entity_merge',
  /** Determine subject of a fact (who the fact is about) */
  FACT_SUBJECT = 'fact_subject',
  /** Confirm fact value */
  FACT_VALUE = 'fact_value',
}

/**
 * Status of pending confirmation
 */
export enum PendingConfirmationStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  DECLINED = 'declined',
  EXPIRED = 'expired',
}

/**
 * How the confirmation was resolved
 */
export enum PendingConfirmationResolvedBy {
  USER = 'user',
  AUTO = 'auto',
  EXPIRED = 'expired',
}

/**
 * Context information displayed to user
 */
export interface ConfirmationContext {
  /** Title displayed in UI */
  title: string;
  /** Description/explanation */
  description: string;
  /** Original quote from message */
  sourceQuote?: string;
}

/**
 * Option that user can select
 */
export interface ConfirmationOption {
  /** Unique option ID */
  id: string;
  /** Main label */
  label: string;
  /** Secondary label (e.g., phone number, email) */
  sublabel?: string;
  /** Entity ID if option represents existing entity */
  entityId?: string;
  /** Is this a "create new" option */
  isCreateNew?: boolean;
  /** Is this a "decline/skip" option */
  isDecline?: boolean;
  /** Is this an "other" option for custom input */
  isOther?: boolean;
}

/**
 * Unified confirmation entity for all user confirmation flows.
 *
 * Used for:
 * - Identifier attribution (link phone/telegram to entity)
 * - Entity merge (combine duplicate entities)
 * - Fact subject (who the fact is about)
 * - Fact value (confirm extracted value)
 */
@Entity('pending_confirmations')
export class PendingConfirmation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Type of confirmation */
  @Column({ length: 50 })
  @Index()
  type: PendingConfirmationType;

  /** Context for user display */
  @Column({ type: 'jsonb' })
  context: ConfirmationContext;

  /** Available options for user to choose */
  @Column({ type: 'jsonb' })
  options: ConfirmationOption[];

  /** AI confidence in suggested option (0.00-1.00) */
  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  /** Current status */
  @Column({ length: 20, default: PendingConfirmationStatus.PENDING })
  @Index()
  status: PendingConfirmationStatus;

  // ==================== Source References ====================

  /** Source message that triggered this confirmation */
  @Column({ name: 'source_message_id', type: 'uuid', nullable: true })
  sourceMessageId: string | null;

  @ManyToOne(() => Message, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_message_id' })
  sourceMessage: Message | null;

  /** Source entity related to confirmation */
  @Column({ name: 'source_entity_id', type: 'uuid', nullable: true })
  @Index()
  sourceEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_entity_id' })
  sourceEntity: EntityRecord | null;

  /** Source pending fact (for FACT_SUBJECT and FACT_VALUE types) */
  @Column({ name: 'source_pending_fact_id', type: 'uuid', nullable: true })
  sourcePendingFactId: string | null;

  @ManyToOne(() => PendingFact, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_pending_fact_id' })
  sourcePendingFact: PendingFact | null;

  /** Source extracted event (for FACT_SUBJECT when using SecondBrainExtraction) */
  @Column({ name: 'source_extracted_event_id', type: 'uuid', nullable: true })
  sourceExtractedEventId: string | null;

  @ManyToOne(() => ExtractedEvent, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_extracted_event_id' })
  sourceExtractedEvent: ExtractedEvent | null;

  // ==================== Resolution ====================

  /** ID of selected option */
  @Column({ name: 'selected_option_id', type: 'varchar', length: 100, nullable: true })
  selectedOptionId: string | null;

  /** Additional resolution data (e.g., custom input for "other") */
  @Column({ type: 'jsonb', nullable: true })
  resolution: Record<string, unknown> | null;

  /** How was it resolved */
  @Column({ name: 'resolved_by', length: 20, nullable: true })
  resolvedBy: PendingConfirmationResolvedBy | null;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /** When this confirmation expires */
  @Column({ name: 'expires_at', type: 'timestamp with time zone', nullable: true })
  expiresAt: Date | null;

  /** When user/auto resolved this confirmation */
  @Column({ name: 'resolved_at', type: 'timestamp with time zone', nullable: true })
  resolvedAt: Date | null;
}
