import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm';
import { EntityRecord } from './entity.entity';

@Entity('dismissed_merge_suggestions')
@Unique(['primaryEntityId', 'dismissedEntityId'])
export class DismissedMergeSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'primary_entity_id', type: 'uuid' })
  @Index()
  primaryEntityId: string;

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'primary_entity_id' })
  primaryEntity: EntityRecord;

  @Column({ name: 'dismissed_entity_id', type: 'uuid' })
  dismissedEntityId: string;

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dismissed_entity_id' })
  dismissedEntity: EntityRecord;

  @Column({ name: 'dismissed_by', length: 50, default: 'user' })
  dismissedBy: string;

  @CreateDateColumn({ name: 'dismissed_at' })
  dismissedAt: Date;
}
