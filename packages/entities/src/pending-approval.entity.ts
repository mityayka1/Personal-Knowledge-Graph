import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Interaction } from './interaction.entity';
import { EntityRecord } from './entity.entity';

/**
 * Types of items that can go through approval workflow.
 * Maps to target entity types in the system.
 */
export enum PendingApprovalItemType {
  FACT = 'fact',
  PROJECT = 'project',
  TASK = 'task',
  COMMITMENT = 'commitment',
}

/**
 * Status of the approval workflow.
 */
export enum PendingApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * PendingApproval - thin reference layer for draft entity approval workflow.
 *
 * Design:
 * - Target entities (EntityFact, Activity, Commitment) are created with status='draft'
 * - PendingApproval links to target via itemType + targetId (polymorphic, no FK)
 * - On approve: target.status → 'active', approval.status → 'approved'
 * - On reject: target.deletedAt = now() (soft delete), approval.status → 'rejected'
 * - Cleanup job hard-deletes rejected items after retention period
 *
 * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
 */
@Entity('pending_approvals')
@Index(['batchId', 'status']) // For batch operations
@Index(['status', 'reviewedAt']) // For cleanup job
export class PendingApproval {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Type of the target entity.
   * Used together with targetId for polymorphic reference.
   */
  @Column({ name: 'item_type', length: 20 })
  @Index()
  itemType: PendingApprovalItemType;

  /**
   * UUID of the target entity (EntityFact, Activity, Commitment).
   * No FK constraint - polymorphic reference.
   */
  @Column({ name: 'target_id', type: 'uuid' })
  @Index()
  targetId: string;

  /**
   * Groups items from the same extraction session.
   * Used for batch approve/reject operations.
   */
  @Column({ name: 'batch_id', type: 'uuid' })
  @Index()
  batchId: string;

  @Column({ length: 20, default: PendingApprovalStatus.PENDING })
  @Index()
  status: PendingApprovalStatus;

  /**
   * Extraction confidence score (0.00 - 1.00).
   * Used for display and sorting in UI.
   */
  @Column({ type: 'decimal', precision: 3, scale: 2 })
  confidence: number;

  /**
   * Quote from the source message that led to this extraction.
   * Shown in UI for user verification.
   */
  @Column({ name: 'source_quote', type: 'text', nullable: true })
  sourceQuote: string | null;

  /**
   * Link to the interaction (chat session) where item was extracted.
   */
  @Column({ name: 'source_interaction_id', type: 'uuid', nullable: true })
  @Index()
  sourceInteractionId: string | null;

  @ManyToOne(() => Interaction, { nullable: true })
  @JoinColumn({ name: 'source_interaction_id' })
  sourceInteraction: Interaction | null;

  /**
   * Entity this approval relates to (denormalized for fast filtering/display).
   * For FACT: the entity the fact describes.
   * For PROJECT/TASK: the owner entity.
   * For COMMITMENT: the owner entity (extraction perspective).
   */
  @Column({ name: 'source_entity_id', type: 'uuid', nullable: true })
  @Index()
  sourceEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'source_entity_id' })
  sourceEntity: EntityRecord | null;

  /**
   * Human-readable one-liner describing what was extracted.
   * Examples: "work: маркетолог", "Проект: Разработка сайта", "Задача: Подготовить отчёт"
   */
  @Column({ type: 'text', nullable: true })
  context: string | null;

  /**
   * Telegram message reference for updating inline keyboards.
   * Format: "chatId:messageId"
   */
  @Column({ name: 'message_ref', type: 'varchar', length: 100, nullable: true })
  messageRef: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /**
   * When the item was approved or rejected.
   * Used by cleanup job to determine retention period.
   */
  @Column({
    name: 'reviewed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  reviewedAt: Date | null;
}
