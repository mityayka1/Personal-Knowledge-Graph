import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EntityRecord } from './entity.entity';
import { Interaction } from './interaction.entity';

export enum FactType {
  // Personal
  BIRTHDAY = 'birthday',
  NAME_FULL = 'name_full',
  NICKNAME = 'nickname',

  // Contact
  PHONE_WORK = 'phone_work',
  PHONE_PERSONAL = 'phone_personal',
  EMAIL_WORK = 'email_work',
  EMAIL_PERSONAL = 'email_personal',
  ADDRESS = 'address',
  TELEGRAM = 'telegram',

  // Professional
  POSITION = 'position',
  DEPARTMENT = 'department',
  COMPANY = 'company',
  SPECIALIZATION = 'specialization',

  // Business (Organization)
  INN = 'inn',
  KPP = 'kpp',
  OGRN = 'ogrn',
  LEGAL_ADDRESS = 'legal_address',
  ACTUAL_ADDRESS = 'actual_address',
  BANK_ACCOUNT = 'bank_account',

  // Preferences
  COMMUNICATION_PREFERENCE = 'communication_preference',
  TIMEZONE = 'timezone',
  LANGUAGE = 'language',

  // AI-generated
  DAILY_SUMMARY = 'daily_summary',
}

export enum FactCategory {
  PERSONAL = 'personal',
  CONTACT = 'contact',
  PROFESSIONAL = 'professional',
  BUSINESS = 'business',
  LEGAL = 'legal',
  FINANCIAL = 'financial',
  PREFERENCES = 'preferences',
}

export enum FactSource {
  MANUAL = 'manual',
  EXTRACTED = 'extracted',
  IMPORTED = 'imported',
}

/**
 * Workflow status for draft entities pattern.
 * - draft: Created but not yet approved by user
 * - active: Approved and visible in queries
 */
export enum EntityFactStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
}

@Entity('entity_facts')
@Index(['entityId', 'factType'])
export class EntityFact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  @Index()
  entityId: string;

  @ManyToOne(() => EntityRecord, (entity) => entity.facts, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;

  @Column({ name: 'fact_type', length: 50 })
  @Index()
  factType: FactType | string;

  @Column({ length: 50 })
  category: FactCategory;

  @Column({ type: 'varchar', length: 500, nullable: true })
  value: string | null;

  @Column({ name: 'value_date', type: 'date', nullable: true })
  valueDate: Date | null;

  @Column({ name: 'value_json', type: 'jsonb', nullable: true })
  valueJson: Record<string, unknown> | null;

  @Column({ length: 20, default: FactSource.MANUAL })
  source: FactSource;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  // pgvector column - 1536 dimensions for OpenAI text-embedding-3-small
  // Used for semantic deduplication of facts
  @Column({ type: 'vector', length: 1536, nullable: true })
  embedding: number[] | null;

  @Column({ name: 'source_interaction_id', type: 'uuid', nullable: true })
  sourceInteractionId: string | null;

  @ManyToOne(() => Interaction, { nullable: true })
  @JoinColumn({ name: 'source_interaction_id' })
  sourceInteraction: Interaction | null;

  @Column({ name: 'source_segment_id', type: 'uuid', nullable: true })
  sourceSegmentId: string | null;

  // Ranking (Wikidata-style): preferred > normal > deprecated
  @Column({ type: 'varchar', length: 20, default: 'normal' })
  rank: 'preferred' | 'normal' | 'deprecated';

  // Fact linking - points to newer version of this fact
  @Column({ name: 'superseded_by', type: 'uuid', nullable: true })
  supersededById: string | null;

  @ManyToOne(() => EntityFact, { nullable: true })
  @JoinColumn({ name: 'superseded_by' })
  supersededBy: EntityFact | null;

  // Conflict tracking
  @Column({ name: 'needs_review', type: 'boolean', default: false })
  needsReview: boolean;

  @Column({ name: 'review_reason', type: 'text', nullable: true })
  reviewReason: string | null;

  // Confirmation tracking - how many times this fact was confirmed from different sources
  @Column({ name: 'confirmation_count', type: 'integer', default: 1 })
  confirmationCount: number;

  @Column({ name: 'valid_from', type: 'date', nullable: true })
  validFrom: Date | null;

  @Column({ name: 'valid_until', type: 'date', nullable: true })
  validUntil: Date | null;

  /**
   * Workflow status for draft entities pattern.
   * - draft: Created by extraction, pending user approval
   * - active: Approved and visible in normal queries
   *
   * Default is 'active' for backward compatibility with existing data.
   */
  @Column({ length: 10, default: EntityFactStatus.ACTIVE })
  @Index()
  status: EntityFactStatus;

  /**
   * Soft delete timestamp for rejected drafts.
   * Set when user rejects extracted fact.
   * Cleanup job hard-deletes after retention period.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  @Index()
  deletedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
