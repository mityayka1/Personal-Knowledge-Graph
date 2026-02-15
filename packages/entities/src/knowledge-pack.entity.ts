import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Activity } from './activity.entity';
import { EntityRecord } from './entity.entity';

/**
 * Тип упаковки знаний.
 */
export enum PackType {
  /** По Activity (проект, направление) */
  ACTIVITY = 'activity',
  /** По Entity (человек, организация) */
  ENTITY = 'entity',
  /** По теме (без привязки к activity) */
  TOPIC = 'topic',
  /** Временной период */
  PERIOD = 'period',
}

/**
 * Статус пакета знаний.
 */
export enum PackStatus {
  /** Черновик — формируется */
  DRAFT = 'draft',
  /** Активный — актуальные знания */
  ACTIVE = 'active',
  /** Устаревший — есть более новый пакет */
  SUPERSEDED = 'superseded',
  /** Архивный */
  ARCHIVED = 'archived',
}

/**
 * KnowledgePack — сжатые, консолидированные знания.
 *
 * Объединяет несколько TopicalSegment в компактное представление.
 * Формируется периодически (еженедельно/ежемесячно) или по запросу.
 */
@Entity('knowledge_packs')
export class KnowledgePack {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ==================== Идентификация ====================

  /** Название пакета знаний */
  @Column({ length: 500 })
  @Index()
  title: string;

  /** Тип упаковки */
  @Column({ name: 'pack_type', type: 'varchar', length: 20 })
  @Index()
  packType: PackType;

  // ==================== Привязки ====================

  /** Activity, к которой относится пакет (для packType=activity) */
  @Column({ name: 'activity_id', type: 'uuid', nullable: true })
  @Index()
  activityId: string | null;

  @ManyToOne(() => Activity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity | null;

  /** Entity, к которой относится пакет (для packType=entity) */
  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  @Index()
  entityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord | null;

  /** Тема (для packType=topic) */
  @Column({ length: 500, nullable: true })
  topic: string | null;

  // ==================== Временной период ====================

  /** Начало периода, который покрывает пакет */
  @Column({ name: 'period_start', type: 'timestamp with time zone' })
  @Index()
  periodStart: Date;

  /** Конец периода */
  @Column({ name: 'period_end', type: 'timestamp with time zone' })
  @Index()
  periodEnd: Date;

  // ==================== Контент ====================

  /** Сжатое summary всех знаний */
  @Column({ type: 'text' })
  summary: string;

  /** Ключевые решения */
  @Column({ type: 'jsonb', default: '[]' })
  decisions: Array<{
    what: string;
    when: string;
    context?: string;
    sourceSegmentId?: string;
  }>;

  /** Открытые вопросы */
  @Column({ name: 'open_questions', type: 'jsonb', default: '[]' })
  openQuestions: Array<{
    question: string;
    raisedAt: string;
    context?: string;
    sourceSegmentId?: string;
  }>;

  /** Ключевые факты (консолидированные) */
  @Column({ name: 'key_facts', type: 'jsonb', default: '[]' })
  keyFacts: Array<{
    factType: string;
    value: string;
    confidence: number;
    sourceSegmentIds: string[];
    lastUpdated: string;
  }>;

  /** Участники обсуждений */
  @Column({ name: 'participant_ids', type: 'uuid', array: true, default: '{}' })
  participantIds: string[];

  // ==================== Источники ====================

  /** IDs сегментов, вошедших в этот пакет */
  @Column({ name: 'source_segment_ids', type: 'uuid', array: true })
  sourceSegmentIds: string[];

  /** Количество сегментов */
  @Column({ name: 'segment_count', type: 'int', default: 0 })
  segmentCount: number;

  /** Общее количество сообщений во всех сегментах */
  @Column({ name: 'total_message_count', type: 'int', default: 0 })
  totalMessageCount: number;

  // ==================== Конфликты и валидация ====================

  /** Обнаруженные конфликты */
  @Column({ type: 'jsonb', default: '[]' })
  conflicts: Array<{
    type: 'fact_contradiction' | 'decision_change' | 'timeline_inconsistency';
    description: string;
    segmentIds: string[];
    resolved: boolean;
    resolution?: string;
  }>;

  /** Пакет верифицирован пользователем? */
  @Column({ name: 'is_verified', type: 'boolean', default: false })
  isVerified: boolean;

  /** Дата верификации */
  @Column({ name: 'verified_at', type: 'timestamp with time zone', nullable: true })
  verifiedAt: Date | null;

  // ==================== Статус ====================

  @Column({ type: 'varchar', length: 20, default: PackStatus.DRAFT })
  @Index()
  status: PackStatus;

  /** ID пакета, который заменил этот (если status=superseded) */
  @Column({ name: 'superseded_by_id', type: 'uuid', nullable: true })
  supersededById: string | null;

  // ==================== Метаданные ====================

  @Column({ type: 'jsonb', nullable: true })
  metadata: {
    packingVersion?: string;
    tokensUsed?: number;
    debugInfo?: Record<string, unknown>;
  } | null;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
