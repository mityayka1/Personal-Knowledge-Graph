import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { EntityRecord } from './entity.entity';
import { Activity } from './activity.entity';

/**
 * Роль участника в активности
 */
export enum ActivityMemberRole {
  /** Владелец/ответственный */
  OWNER = 'owner',
  /** Участник */
  MEMBER = 'member',
  /** Наблюдатель (только чтение) */
  OBSERVER = 'observer',
  /** Исполнитель (assignee) */
  ASSIGNEE = 'assignee',
  /** Ревьюер */
  REVIEWER = 'reviewer',
  /** Клиент/заказчик */
  CLIENT = 'client',
  /** Консультант */
  CONSULTANT = 'consultant',
}

/**
 * ActivityMember — связь между Activity и Entity (человек/организация).
 *
 * Позволяет связывать несколько людей с одной активностью в разных ролях.
 * Например: Проект "Хаб для Битрикс24" может иметь:
 * - owner: Я
 * - client: Панавто
 * - member: Коллега Вася
 * - reviewer: Тимлид
 */
@Entity('activity_members')
@Unique('uq_activity_member', ['activityId', 'entityId', 'role'])
@Index('idx_activity_members_activity', ['activityId'])
@Index('idx_activity_members_entity', ['entityId'])
export class ActivityMember {
  /**
   * Уникальный идентификатор записи
   */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * ID активности
   */
  @Column({
    name: 'activity_id',
    type: 'uuid',
    comment: 'ID связанной активности',
  })
  activityId: string;

  /**
   * Связанная активность
   */
  @ManyToOne(() => Activity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity;

  /**
   * ID сущности (человек или организация)
   */
  @Column({
    name: 'entity_id',
    type: 'uuid',
    comment: 'ID участника (Entity: person или organization)',
  })
  entityId: string;

  /**
   * Связанная сущность (человек/организация)
   */
  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;

  /**
   * Роль участника в активности
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: ActivityMemberRole.MEMBER,
    comment: 'Роль: owner, member, observer, assignee, reviewer, client, consultant',
  })
  role: ActivityMemberRole;

  /**
   * Заметки о роли участника
   */
  @Column({
    type: 'text',
    nullable: true,
    comment: 'Заметки о роли/обязанностях участника',
  })
  notes: string | null;

  /**
   * Активен ли участник (для временного исключения без удаления)
   */
  @Column({
    name: 'is_active',
    type: 'boolean',
    default: true,
    comment: 'Активен ли участник (false = временно исключён)',
  })
  isActive: boolean;

  /**
   * Дата присоединения к активности
   */
  @Column({
    name: 'joined_at',
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Дата присоединения к активности',
  })
  joinedAt: Date | null;

  /**
   * Дата выхода из активности
   */
  @Column({
    name: 'left_at',
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Дата выхода из активности',
  })
  leftAt: Date | null;

  /**
   * Дополнительные метаданные (permissions, preferences, etc.)
   */
  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'Дополнительные метаданные: permissions, preferences, etc.',
  })
  metadata: Record<string, unknown> | null;

  /**
   * Дата создания записи
   */
  @CreateDateColumn({ name: 'created_at', comment: 'Дата создания записи' })
  createdAt: Date;

  /**
   * Дата последнего обновления
   */
  @UpdateDateColumn({ name: 'updated_at', comment: 'Дата последнего обновления' })
  updatedAt: Date;
}
