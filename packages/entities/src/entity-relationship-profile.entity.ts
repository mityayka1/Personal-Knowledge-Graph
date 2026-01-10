import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EntityRecord } from './entity.entity';

// Types for profile data
export type RelationshipType =
  | 'client'
  | 'partner'
  | 'colleague'
  | 'friend'
  | 'acquaintance'
  | 'vendor'
  | 'other';

export type CommunicationFrequency =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'rare';

export interface RelationshipMilestone {
  date: string;
  title: string;
  description: string;
}

export interface KeyDecision {
  date: string;
  description: string;
  quote?: string | null;
}

export interface OpenActionItem {
  description: string;
  owner: 'self' | 'them' | 'both';
}

@Entity('entity_relationship_profiles')
export class EntityRelationshipProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'entity_id', type: 'uuid', unique: true })
  @Index()
  entityId: string;

  @OneToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;

  // Relationship Overview
  @Column({ name: 'relationship_type', type: 'varchar', length: 30 })
  relationshipType: RelationshipType;

  @Column({ name: 'communication_frequency', type: 'varchar', length: 20 })
  communicationFrequency: CommunicationFrequency;

  @Column({ name: 'relationship_summary', type: 'text' })
  relationshipSummary: string;

  @Column({ name: 'relationship_timeline', type: 'text', nullable: true })
  relationshipTimeline: string | null;

  // Aggregated Stats
  @Column({ name: 'first_interaction_date', type: 'timestamp with time zone' })
  firstInteractionDate: Date;

  @Column({ name: 'last_meaningful_contact', type: 'timestamp with time zone' })
  lastMeaningfulContact: Date;

  @Column({ name: 'total_interactions', type: 'int' })
  totalInteractions: number;

  @Column({ name: 'total_messages', type: 'int' })
  totalMessages: number;

  // Key Information (Cold Tier)
  @Column({ name: 'top_topics', type: 'jsonb', default: [] })
  topTopics: string[];

  @Column({ type: 'jsonb', default: [] })
  milestones: RelationshipMilestone[];

  @Column({ name: 'key_decisions', type: 'jsonb', default: [] })
  keyDecisions: KeyDecision[];

  @Column({ name: 'open_action_items', type: 'jsonb', default: [] })
  openActionItems: OpenActionItem[];

  // Metadata
  @Column({ name: 'summarized_interactions_count', type: 'int' })
  summarizedInteractionsCount: number;

  @Column({ name: 'coverage_start', type: 'timestamp with time zone' })
  coverageStart: Date;

  @Column({ name: 'coverage_end', type: 'timestamp with time zone' })
  coverageEnd: Date;

  @Column({ name: 'model_version', type: 'varchar', length: 50, nullable: true })
  modelVersion: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
