import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { EntityRelation } from './entity-relation.entity';
import { EntityRecord } from './entity.entity';

/**
 * EntityRelationMember — участник связи с ролью.
 *
 * Composite Primary Key: (relation_id, entity_id, role)
 * Это позволяет одной сущности участвовать в связи с разными ролями
 * (редкий кейс, но возможный для TEAM связей).
 *
 * Примеры:
 * - { entityId: 'ivan-uuid', role: 'spouse', label: 'Ваня' }
 * - { entityId: 'tinkoff-uuid', role: 'employer', label: 'Тинькофф Банк' }
 */
@Entity('entity_relation_members')
@Index('idx_relation_members_entity', ['entityId'])
@Index('idx_relation_members_valid', ['entityId'], {
  where: '"valid_until" IS NULL',
})
export class EntityRelationMember {
  @PrimaryColumn({ name: 'relation_id', type: 'uuid' })
  relationId: string;

  @PrimaryColumn({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  role: string;

  /**
   * Человекочитаемая метка участника.
   * Примеры: 'Маша', 'директор', 'муж'.
   * Используется для отображения в контексте.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  label: string | null;

  /**
   * Дополнительные свойства участника в этой связи.
   * Примеры: { position: 'CEO', since: '2020' }
   */
  @Column({ type: 'jsonb', nullable: true })
  properties: Record<string, unknown> | null;

  /**
   * Soft delete для участия в связи.
   * Когда участник покидает связь (уволился, развёлся),
   * ставится validUntil вместо удаления.
   */
  @Column({ name: 'valid_until', type: 'timestamp', nullable: true })
  validUntil: Date | null;

  @ManyToOne(() => EntityRelation, (relation) => relation.members, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'relation_id' })
  relation: EntityRelation;

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;
}
