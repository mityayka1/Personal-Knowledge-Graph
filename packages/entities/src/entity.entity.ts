import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { EntityIdentifier } from './entity-identifier.entity';
import { EntityFact } from './entity-fact.entity';
import { InteractionParticipant } from './interaction-participant.entity';

export enum EntityType {
  PERSON = 'person',
  ORGANIZATION = 'organization',
}

export enum CreationSource {
  MANUAL = 'manual',
  PRIVATE_CHAT = 'private_chat',
  WORKING_GROUP = 'working_group',
  /** Created from extracted facts (e.g., when user selects "Create new" in subject resolution) */
  EXTRACTED = 'extracted',
}

@Entity('entities')
export class EntityRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: EntityType,
  })
  type: EntityType;

  @Column({ length: 255 })
  @Index()
  name: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  @Index()
  organizationId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization: EntityRecord | null;

  @OneToMany(() => EntityRecord, (entity) => entity.organization)
  employees: EntityRecord[];

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'profile_photo', type: 'text', nullable: true })
  profilePhoto: string | null;

  @Column({ name: 'creation_source', type: 'varchar', length: 20, default: CreationSource.MANUAL })
  creationSource: CreationSource;

  @Column({ name: 'is_bot', type: 'boolean', default: false })
  @Index('idx_entities_is_bot', { where: '"is_bot" = true' })
  isBot: boolean;

  /**
   * Marks this entity as the system owner ("me").
   * Only one entity can have isOwner = true (enforced by partial unique index).
   */
  @Column({ name: 'is_owner', type: 'boolean', default: false })
  @Index('idx_entities_is_owner', { unique: true, where: '"is_owner" = true' })
  isOwner: boolean;

  @OneToMany(() => EntityIdentifier, (identifier) => identifier.entity)
  identifiers: EntityIdentifier[];

  @OneToMany(() => EntityFact, (fact) => fact.entity)
  facts: EntityFact[];

  @OneToMany(() => InteractionParticipant, (participant) => participant.entity)
  participations: InteractionParticipant[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * Soft delete timestamp.
   * When set, entity is considered deleted but data is preserved.
   * TypeORM automatically excludes soft-deleted entities from queries.
   * Use { withDeleted: true } to include them.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  @Index('idx_entities_deleted_at')
  deletedAt: Date | null;

  /**
   * Check if entity is soft-deleted.
   */
  get isDeleted(): boolean {
    return this.deletedAt !== null;
  }
}
