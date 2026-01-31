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
  Tree,
  TreeParent,
  TreeChildren,
} from 'typeorm';
import { EntityRecord } from './entity.entity';

/**
 * Тип активности — определяет семантику узла в иерархии.
 * Расширяемый enum: новые типы добавляются без изменения схемы.
 */
export enum ActivityType {
  /** Сфера жизни (Работа, Семья, Здоровье) */
  AREA = 'area',
  /** Бизнес/организация которой владеешь */
  BUSINESS = 'business',
  /** Направление деятельности внутри бизнеса */
  DIRECTION = 'direction',
  /** Проект с целью и сроками */
  PROJECT = 'project',
  /** Инициатива/эпик внутри проекта */
  INITIATIVE = 'initiative',
  /** Конкретная задача */
  TASK = 'task',
  /** Веха/milestone */
  MILESTONE = 'milestone',
  /** Повторяющаяся привычка */
  HABIT = 'habit',
  /** Обучение/курс */
  LEARNING = 'learning',
  /** Серия событий (еженедельные встречи) */
  EVENT_SERIES = 'event_series',
}

/**
 * Статус активности
 */
export enum ActivityStatus {
  /** Черновик — ожидает подтверждения пользователем */
  DRAFT = 'draft',
  /** Идея, не начата */
  IDEA = 'idea',
  /** Активна, в работе */
  ACTIVE = 'active',
  /** На паузе */
  PAUSED = 'paused',
  /** Завершена успешно */
  COMPLETED = 'completed',
  /** Отменена */
  CANCELLED = 'cancelled',
  /** В архиве */
  ARCHIVED = 'archived',
}

/**
 * Приоритет активности
 */
export enum ActivityPriority {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  NONE = 'none',
}

/**
 * Контекст активности — когда уместно напоминать
 */
export enum ActivityContext {
  /** Рабочее время */
  WORK = 'work',
  /** Личное время */
  PERSONAL = 'personal',
  /** В любое время */
  ANY = 'any',
  /** Только в определённой локации */
  LOCATION_BASED = 'location_based',
}

/**
 * Activity — универсальная сущность для всех "дел" человека.
 *
 * Использует ТРИ паттерна иерархии одновременно:
 * 1. **Closure-table** (@Tree) — для findAncestors/findDescendants через activities_closure
 * 2. **Adjacency List** (parentId) — для прямого доступа к родителю
 * 3. **Materialized Path** — для быстрого LIKE-поиска потомков
 *
 * ВАЖНО: При перемещении узлов необходимо вызывать cascadeUpdateDescendantPaths()
 * для синхронизации depth/materializedPath с closure-table.
 *
 * ВАЖНО: Из-за бага TypeORM 0.3.x с ClosureSubjectExecutor, для создания
 * новых Activity используй QueryBuilder.insert() вместо repository.save().
 * @see https://github.com/typeorm/typeorm/issues/9658
 *
 * Примеры иерархий:
 * - Работа (AREA) → ГуглШитс.ру (BUSINESS) → Канал (DIRECTION) → Видео про формулы (PROJECT)
 * - Работа (AREA) → Панавто (PROJECT) → Хаб для Битрикс24 (INITIATIVE) → Настроить webhooks (TASK)
 */
@Entity('activities')
@Tree('closure-table')
@Index('idx_activities_owner', ['ownerEntityId'])
@Index('idx_activities_client', ['clientEntityId'])
@Index('idx_activities_type', ['activityType'])
@Index('idx_activities_status', ['status'])
@Index('idx_activities_deadline', ['deadline'])
export class Activity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Название активности
   */
  @Column({ length: 500, comment: 'Название активности' })
  @Index()
  name: string;

  /**
   * Тип активности — определяет семантику в иерархии
   */
  @Column({
    name: 'activity_type',
    type: 'varchar',
    length: 30,
    comment: 'Тип активности (area, business, project, task, etc.)',
  })
  activityType: ActivityType;

  /**
   * Описание (опционально)
   */
  @Column({ type: 'text', nullable: true, comment: 'Подробное описание активности' })
  description: string | null;

  /**
   * Статус активности
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: ActivityStatus.ACTIVE,
    comment: 'Статус: draft, idea, active, paused, completed, cancelled, archived',
  })
  status: ActivityStatus;

  /**
   * Приоритет
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: ActivityPriority.MEDIUM,
    comment: 'Приоритет: critical, high, medium, low, none',
  })
  priority: ActivityPriority;

  /**
   * Контекст — когда уместно напоминать
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: ActivityContext.ANY,
    comment: 'Контекст для напоминаний: work, personal, any, location_based',
  })
  context: ActivityContext;

  // ─────────────────────────────────────────────────────────────
  // Иерархия (closure-table)
  // ─────────────────────────────────────────────────────────────

  /**
   * ID родительской активности
   */
  @Column({
    name: 'parent_id',
    type: 'uuid',
    nullable: true,
    comment: 'ID родительской активности (closure-table hierarchy)',
  })
  parentId: string | null;

  /**
   * Родительская активность
   */
  @TreeParent()
  @ManyToOne(() => Activity, (activity) => activity.children, { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Activity | null;

  /**
   * Дочерние активности
   */
  @TreeChildren()
  children: Activity[];

  /**
   * Глубина в дереве (0 = корень)
   * Вычисляется и кэшируется для быстрых запросов
   */
  @Column({ type: 'int', default: 0, comment: 'Глубина в дереве (0 = корень)' })
  depth: number;

  /**
   * Materialized path для быстрого поиска предков
   * Формат: "uuid1/uuid2/uuid3" (от корня к текущему)
   */
  @Column({
    name: 'materialized_path',
    type: 'text',
    nullable: true,
    comment: 'Materialized path: uuid1/uuid2/uuid3 от корня к текущему',
  })
  @Index()
  materializedPath: string | null;

  // ─────────────────────────────────────────────────────────────
  // Связи с Entity (люди/организации)
  // ─────────────────────────────────────────────────────────────

  /**
   * Владелец активности (обычно "я")
   */
  @Column({
    name: 'owner_entity_id',
    type: 'uuid',
    comment: 'ID владельца активности (обычно isOwner=true entity)',
  })
  ownerEntityId: string;

  @ManyToOne(() => EntityRecord, { nullable: false })
  @JoinColumn({ name: 'owner_entity_id' })
  ownerEntity: EntityRecord;

  /**
   * Клиент (для клиентских проектов)
   */
  @Column({
    name: 'client_entity_id',
    type: 'uuid',
    nullable: true,
    comment: 'ID клиента/заказчика (для клиентских проектов)',
  })
  clientEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'client_entity_id' })
  clientEntity: EntityRecord | null;

  // ─────────────────────────────────────────────────────────────
  // Временные характеристики
  // ─────────────────────────────────────────────────────────────

  /**
   * Дедлайн (если есть)
   */
  @Column({
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Дедлайн выполнения',
  })
  deadline: Date | null;

  /**
   * Дата начала (для проектов с известным стартом)
   */
  @Column({
    name: 'start_date',
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Дата начала работы над активностью',
  })
  startDate: Date | null;

  /**
   * Дата завершения (фактическая)
   */
  @Column({
    name: 'end_date',
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Фактическая дата завершения',
  })
  endDate: Date | null;

  /**
   * Для повторяющихся активностей (habits, event_series)
   * Cron-выражение: "0 9 * * 1-5" = каждый будний день в 9:00
   */
  @Column({
    name: 'recurrence_rule',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: 'Cron-выражение для повторяющихся активностей',
  })
  recurrenceRule: string | null;

  // ─────────────────────────────────────────────────────────────
  // Метаданные
  // ─────────────────────────────────────────────────────────────

  /**
   * Расширяемые метаданные (tags, color, external_ids, etc.)
   */
  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'Расширяемые метаданные: tags, color, external_ids, etc.',
  })
  metadata: Record<string, unknown> | null;

  /**
   * Теги для быстрой фильтрации (дублируются из metadata для индексации)
   */
  @Column({
    type: 'text',
    array: true,
    nullable: true,
    comment: 'Теги для быстрой фильтрации (GIN index)',
  })
  @Index('idx_activities_tags', { synchronize: false })
  tags: string[] | null;

  /**
   * Прогресс выполнения (0-100, для tasks/projects)
   */
  @Column({
    type: 'int',
    nullable: true,
    comment: 'Прогресс выполнения 0-100%',
  })
  progress: number | null;

  // ─────────────────────────────────────────────────────────────
  // Timestamps
  // ─────────────────────────────────────────────────────────────

  @CreateDateColumn({ name: 'created_at', comment: 'Дата создания записи' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', comment: 'Дата последнего обновления' })
  updatedAt: Date;

  /**
   * Последняя активность (обновляется при любом действии)
   */
  @Column({
    name: 'last_activity_at',
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Timestamp последней активности (сообщение, коммит, etc.)',
  })
  @Index()
  lastActivityAt: Date | null;

  /**
   * Soft delete timestamp.
   * Записи с deletedAt != null считаются удалёнными.
   * Используется для rejected draft entities в approval workflow.
   */
  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamptz',
    comment: 'Soft delete: rejected drafts и отменённые активности',
  })
  @Index()
  deletedAt: Date | null;
}
