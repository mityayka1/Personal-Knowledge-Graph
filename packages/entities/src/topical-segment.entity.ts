import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinTable,
  JoinColumn,
  Index,
} from 'typeorm';
import { EntityRecord } from './entity.entity';
import { Activity } from './activity.entity';
import { Message } from './message.entity';
import { Interaction } from './interaction.entity';

/**
 * Статусы сегмента.
 */
export enum SegmentStatus {
  /** Активный — можно добавлять сообщения */
  ACTIVE = 'active',
  /** Закрытый — обсуждение завершено */
  CLOSED = 'closed',
  /** Упакованный — вошёл в KnowledgePack */
  PACKED = 'packed',
  /** Объединённый с другим сегментом */
  MERGED = 'merged',
}

/**
 * TopicalSegment — семантическая единица обсуждения.
 *
 * Группа сообщений, объединённых общей темой.
 * Один чат может содержать много сегментов.
 * Одна Interaction (техническая сессия) может содержать несколько сегментов.
 */
@Entity('topical_segments')
export class TopicalSegment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ==================== Тема ====================

  /** Название темы обсуждения */
  @Column({ length: 500 })
  @Index()
  topic: string;

  /** Ключевые слова темы (для поиска) */
  @Column({ type: 'text', array: true, nullable: true })
  keywords: string[] | null;

  /** Краткое описание (авто-генерируется) */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  // ==================== Источник ====================

  /** Telegram chat ID (источник сообщений) */
  @Column({ name: 'chat_id', length: 100 })
  @Index()
  chatId: string;

  /** Техническая сессия, в рамках которой сегмент */
  @Column({ name: 'interaction_id', type: 'uuid', nullable: true })
  @Index()
  interactionId: string | null;

  @ManyToOne(() => Interaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'interaction_id' })
  interaction: Interaction | null;

  // ==================== Связь с Activity ====================

  /** Activity, к которой относится обсуждение (если определено) */
  @Column({ name: 'activity_id', type: 'uuid', nullable: true })
  @Index()
  activityId: string | null;

  @ManyToOne(() => Activity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity | null;

  // ==================== Участники ====================

  /** Участники обсуждения (Entity IDs) */
  @Column({ name: 'participant_ids', type: 'uuid', array: true })
  participantIds: string[];

  /** Основной собеседник (с кем идёт чат) */
  @Column({ name: 'primary_participant_id', type: 'uuid', nullable: true })
  primaryParticipantId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'primary_participant_id' })
  primaryParticipant: EntityRecord | null;

  // ==================== Сообщения ====================

  /** Сообщения в этом сегменте (many-to-many через segment_messages) */
  @ManyToMany(() => Message)
  @JoinTable({
    name: 'segment_messages',
    joinColumn: { name: 'segment_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'message_id', referencedColumnName: 'id' },
  })
  messages: Message[];

  /** Количество сообщений (денормализовано для быстрых запросов) */
  @Column({ name: 'message_count', type: 'int', default: 0 })
  messageCount: number;

  // ==================== Временные рамки ====================

  /** Время первого сообщения в сегменте */
  @Column({ name: 'started_at', type: 'timestamp with time zone' })
  @Index()
  startedAt: Date;

  /** Время последнего сообщения в сегменте */
  @Column({ name: 'ended_at', type: 'timestamp with time zone' })
  @Index()
  endedAt: Date;

  // ==================== Извлечённые сущности ====================

  /** IDs извлечённых фактов из этого сегмента */
  @Column({ name: 'extracted_fact_ids', type: 'uuid', array: true, default: '{}' })
  extractedFactIds: string[];

  /** IDs извлечённых задач из этого сегмента */
  @Column({ name: 'extracted_task_ids', type: 'uuid', array: true, default: '{}' })
  extractedTaskIds: string[];

  /** IDs извлечённых обязательств из этого сегмента */
  @Column({ name: 'extracted_commitment_ids', type: 'uuid', array: true, default: '{}' })
  extractedCommitmentIds: string[];

  // ==================== Статус и метаданные ====================

  @Column({ type: 'varchar', length: 20, default: SegmentStatus.ACTIVE })
  @Index()
  status: SegmentStatus;

  /** ID KnowledgePack, в который упакован (если status=packed) */
  @Column({ name: 'knowledge_pack_id', type: 'uuid', nullable: true })
  knowledgePackId: string | null;

  /** ID сегмента, с которым объединён (если status=merged) */
  @Column({ name: 'merged_into_id', type: 'uuid', nullable: true })
  mergedIntoId: string | null;

  /** Уверенность в корректности сегментации (0-1) */
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.8 })
  confidence: number;

  /** Метаданные сегмента */
  @Column({ type: 'jsonb', nullable: true })
  metadata: {
    segmentationReason?: 'topic_change' | 'time_gap' | 'manual' | 'explicit_marker';
    rawTopic?: string;
    isPersonal?: boolean;
    isWorkRelated?: boolean;
    debugInfo?: Record<string, unknown>;
  } | null;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
