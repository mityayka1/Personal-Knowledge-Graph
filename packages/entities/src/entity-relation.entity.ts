import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { EntityRelationMember } from './entity-relation-member.entity';
import { RelationType, RelationSource } from './relation-type.enum';

/**
 * EntityRelation — контейнер связи между сущностями.
 *
 * Вариант 4 (связь как пара с ролями):
 * - Поддержка N-арных связей (команды, семьи)
 * - Нет дублирования типа связи
 * - Роли явные и валидируемые
 *
 * Примеры:
 * - MARRIAGE: [spouse: Иван, spouse: Мария]
 * - EMPLOYMENT: [employee: Иван, employer: Тинькофф]
 * - TEAM: [lead: Пётр, member: Иван, member: Мария]
 */
@Entity('entity_relations')
export class EntityRelation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'relation_type', type: 'varchar', length: 50 })
  relationType: RelationType;

  /**
   * Дополнительные метаданные связи.
   * Примеры: { since: '2020-01', note: 'познакомились на конференции' }
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 20, default: RelationSource.EXTRACTED })
  source: RelationSource;

  /**
   * Уверенность в связи (0.0 - 1.0).
   * Для extracted связей — confidence от LLM.
   * Для manual — всегда 1.0.
   */
  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * Участники связи с ролями.
   * Минимум 2 участника, максимум зависит от типа связи.
   */
  @OneToMany(() => EntityRelationMember, (member) => member.relation, {
    cascade: true,
    eager: true,
  })
  members: EntityRelationMember[];
}
