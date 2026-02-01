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
import { Activity } from './activity.entity';
import { Message } from './message.entity';
import { ExtractedEvent } from './extracted-event.entity';

/**
 * Тип обязательства
 */
export enum CommitmentType {
  /** Обещание что-то сделать */
  PROMISE = 'promise',
  /** Запрос на действие (от другого человека) */
  REQUEST = 'request',
  /** Взаимное соглашение */
  AGREEMENT = 'agreement',
  /** Дедлайн */
  DEADLINE = 'deadline',
  /** Напоминание */
  REMINDER = 'reminder',
  /** Периодическая задача */
  RECURRING = 'recurring',
}

/**
 * Статус обязательства
 */
export enum CommitmentStatus {
  /** Черновик — ожидает подтверждения пользователем */
  DRAFT = 'draft',
  /** Ожидает выполнения */
  PENDING = 'pending',
  /** В процессе выполнения */
  IN_PROGRESS = 'in_progress',
  /** Выполнено */
  COMPLETED = 'completed',
  /** Отменено */
  CANCELLED = 'cancelled',
  /** Просрочено */
  OVERDUE = 'overdue',
  /** Отложено */
  DEFERRED = 'deferred',
}

/**
 * Приоритет обязательства
 */
export enum CommitmentPriority {
  /** Критически важно */
  CRITICAL = 'critical',
  /** Высокий приоритет */
  HIGH = 'high',
  /** Средний приоритет */
  MEDIUM = 'medium',
  /** Низкий приоритет */
  LOW = 'low',
}

/**
 * Commitment — обещания, соглашения и обязательства между людьми.
 *
 * Отслеживает:
 * - Кто кому что обещал
 * - Когда должно быть выполнено
 * - Текущий статус выполнения
 * - Связь с активностью (проектом/задачей)
 * - Источник (сообщение, из которого извлечено)
 *
 * Примеры:
 * - "Я пришлю отчёт до пятницы" → PROMISE, от меня к коллеге
 * - "Вася обещал позвонить завтра" → PROMISE, от Васи ко мне
 * - "Договорились встретиться в 15:00" → AGREEMENT, взаимное
 */
@Entity('commitments')
@Index('idx_commitments_from', ['fromEntityId'])
@Index('idx_commitments_to', ['toEntityId'])
@Index('idx_commitments_status', ['status'])
@Index('idx_commitments_due', ['dueDate'])
@Index('idx_commitments_activity', ['activityId'])
export class Commitment {
  /**
   * Уникальный идентификатор обязательства
   */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Тип обязательства
   */
  @Column({
    type: 'varchar',
    length: 20,
    comment: 'Тип: promise, request, agreement, deadline, reminder, recurring',
  })
  type: CommitmentType;

  /**
   * Краткое описание обязательства
   */
  @Column({
    length: 500,
    comment: 'Краткое описание обязательства',
  })
  @Index()
  title: string;

  /**
   * Подробное описание (опционально)
   */
  @Column({
    type: 'text',
    nullable: true,
    comment: 'Подробное описание обязательства',
  })
  description: string | null;

  /**
   * Текущий статус
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: CommitmentStatus.PENDING,
    comment: 'Статус: draft, pending, in_progress, completed, cancelled, overdue, deferred',
  })
  status: CommitmentStatus;

  /**
   * Приоритет
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: CommitmentPriority.MEDIUM,
    comment: 'Приоритет: critical, high, medium, low',
  })
  priority: CommitmentPriority;

  // ─────────────────────────────────────────────────────────────
  // Участники обязательства
  // ─────────────────────────────────────────────────────────────

  /**
   * ID того, кто дал обещание (источник обязательства)
   */
  @Column({
    name: 'from_entity_id',
    type: 'uuid',
    comment: 'ID того, кто дал обещание (источник)',
  })
  fromEntityId: string;

  /**
   * Сущность, давшая обещание
   */
  @ManyToOne(() => EntityRecord, { nullable: false })
  @JoinColumn({ name: 'from_entity_id' })
  fromEntity: EntityRecord;

  /**
   * ID того, кому дано обещание (получатель)
   */
  @Column({
    name: 'to_entity_id',
    type: 'uuid',
    comment: 'ID того, кому дано обещание (получатель)',
  })
  toEntityId: string;

  /**
   * Сущность-получатель обещания
   */
  @ManyToOne(() => EntityRecord, { nullable: false })
  @JoinColumn({ name: 'to_entity_id' })
  toEntity: EntityRecord;

  // ─────────────────────────────────────────────────────────────
  // Связи с другими сущностями
  // ─────────────────────────────────────────────────────────────

  /**
   * ID связанной активности (проект/задача)
   */
  @Column({
    name: 'activity_id',
    type: 'uuid',
    nullable: true,
    comment: 'ID связанной активности (проект/задача)',
  })
  activityId: string | null;

  /**
   * Связанная активность
   */
  @ManyToOne(() => Activity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity | null;

  /**
   * ID исходного сообщения (источник извлечения)
   */
  @Column({
    name: 'source_message_id',
    type: 'uuid',
    nullable: true,
    comment: 'ID сообщения, из которого извлечено обязательство',
  })
  sourceMessageId: string | null;

  /**
   * Исходное сообщение
   */
  @ManyToOne(() => Message, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_message_id' })
  sourceMessage: Message | null;

  /**
   * ID связанного ExtractedEvent (если создано из extraction)
   */
  @Column({
    name: 'extracted_event_id',
    type: 'uuid',
    nullable: true,
    comment: 'ID ExtractedEvent, из которого создано (связь с extraction pipeline)',
  })
  extractedEventId: string | null;

  /**
   * Связанное извлечённое событие
   */
  @ManyToOne(() => ExtractedEvent, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'extracted_event_id' })
  extractedEvent: ExtractedEvent | null;

  // ─────────────────────────────────────────────────────────────
  // Временные характеристики
  // ─────────────────────────────────────────────────────────────

  /**
   * Срок выполнения
   */
  @Column({
    name: 'due_date',
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Срок выполнения обязательства',
  })
  dueDate: Date | null;

  /**
   * Дата фактического выполнения
   */
  @Column({
    name: 'completed_at',
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Дата фактического выполнения',
  })
  completedAt: Date | null;

  /**
   * Для периодических обязательств: cron-выражение
   */
  @Column({
    name: 'recurrence_rule',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: 'Cron-выражение для периодических обязательств',
  })
  recurrenceRule: string | null;

  /**
   * Следующее напоминание
   */
  @Column({
    name: 'next_reminder_at',
    type: 'timestamp with time zone',
    nullable: true,
    comment: 'Дата/время следующего напоминания',
  })
  @Index()
  nextReminderAt: Date | null;

  /**
   * Количество отправленных напоминаний
   */
  @Column({
    name: 'reminder_count',
    type: 'int',
    default: 0,
    comment: 'Количество отправленных напоминаний',
  })
  reminderCount: number;

  // ─────────────────────────────────────────────────────────────
  // Метаданные
  // ─────────────────────────────────────────────────────────────

  /**
   * Уверенность извлечения (0-1)
   */
  @Column({
    type: 'float',
    nullable: true,
    comment: 'Уверенность извлечения 0-1 (для автоматически извлечённых)',
  })
  confidence: number | null;

  /**
   * Дополнительные метаданные
   */
  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'Дополнительные метаданные: context, extracted_phrases, etc.',
  })
  metadata: Record<string, unknown> | null;

  /**
   * Заметки (ручные пометки пользователя)
   */
  @Column({
    type: 'text',
    nullable: true,
    comment: 'Ручные заметки пользователя',
  })
  notes: string | null;

  // ─────────────────────────────────────────────────────────────
  // Timestamps
  // ─────────────────────────────────────────────────────────────

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

  /**
   * Soft delete timestamp.
   * Записи с deletedAt != null считаются удалёнными.
   * Используется для rejected draft entities в approval workflow.
   */
  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamptz',
    comment: 'Soft delete: rejected drafts и отменённые обязательства',
  })
  @Index()
  deletedAt: Date | null;
}
