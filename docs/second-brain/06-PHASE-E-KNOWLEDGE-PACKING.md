# Phase E: Knowledge Segmentation & Packing

> Спецификация системы семантической сегментации и упаковки знаний

**Статус:** Draft v1
**Дата:** 2026-02-05
**Зависимости:** Phase C (Extract & React), Phase D (Jarvis Foundation)

---

## Executive Summary

Текущая система PKG хранит знания "размазанно" — факты и задачи извлекаются из сообщений, но **контекст обсуждения теряется**. Невозможно ответить на вопросы:
- "В каком контексте был упомянут этот факт?"
- "Покажи все обсуждения по проекту X"
- "Что мы решили по архитектуре за январь?"

Phase E решает эту проблему через:
1. **TopicalSegment** — семантическая единица обсуждения (группа сообщений на одну тему)
2. **KnowledgePack** — сжатые, верифицированные знания (объединение сегментов)
3. **Segmentation Pipeline** — автоматическое определение границ тем
4. **Packing Pipeline** — периодическая упаковка и валидация

---

## Часть 1: Проблема

### 1.1 Текущая архитектура

```
Сообщения (плоский поток)
    ↓
[Extraction]
    ↓
ExtractedFact / ExtractedTask / ExtractedCommitment
    ↓
sourceMessageId (одно сообщение)
```

**Проблемы:**
1. **Потеря контекста** — факт привязан к одному сообщению, не к обсуждению
2. **Нет ретроспективы** — нельзя показать "все обсуждения по теме X"
3. **Дубликаты накапливаются** — одна тема обсуждалась 10 раз, 10 разных записей
4. **Конфликты не выявляются** — противоречащие факты не сопоставляются
5. **Нет "упаковки"** — знания не консолидируются со временем

### 1.2 Ключевое различие понятий

| Понятие | Текущее использование | Правильное понимание |
|---------|----------------------|---------------------|
| **Chat** | Telegram chat | Канал связи (техническая сущность) |
| **Interaction** | Session by 4h gap | Техническая сессия, не семантическая |
| **TopicalSegment** | ❌ Не существует | Семантическая единица — обсуждение темы |

**Пример одной технической сессии (Interaction):**
```
10:00 [PKG архитектура]    "Давай обсудим микросервисы"
10:15 [PKG архитектура]    "Думаю, NestJS подойдёт"
10:30 [Сбер]               "Кстати, Сбер написал про бюджет"
10:35 [Сбер]               "Говорят, 600к, не 500к"
10:45 [PKG тесты]          "Вернёмся к PKG — что с тестами?"
11:00 [PKG тесты]          "Jest настроен, coverage 70%"
```

**Одна Interaction, три TopicalSegment:**
1. PKG/Архитектура (10:00-10:30)
2. Сбер/Бюджет (10:30-10:45)
3. PKG/Тестирование (10:45-11:00)

---

## Часть 2: Решение — Пирамида знаний

```
                    ┌─────────────────────┐
                    │   KnowledgePack     │  ← Сжатые, верифицированные
                    │  "PKG за январь"    │     знания (месяц/квартал)
                    └──────────┬──────────┘
                               │ упаковка
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │ Segment 1  │   │ Segment 2  │   │ Segment 3  │  ← Семантические
       │ Архитектура│   │ Архитектура│   │ Баги       │     единицы с
       └─────┬──────┘   └─────┬──────┘   └─────┬──────┘     контекстом
             │                │                │
     ┌───────┴───────┐       ...              ...
     ▼       ▼       ▼
   [msg1] [msg2] [msg3]                                 ← Сырые сообщения
     │
     ▼
  ExtractedFact: "Выбрали NestJS"                       ← Извлечённые
    └── sourceSegmentId: segment_1                         сущности с
                                                           трассировкой
```

---

## Часть 3: Core Entities

### 3.1 TopicalSegment

```typescript
// packages/entities/src/topical-segment.entity.ts

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

  /**
   * Название темы обсуждения.
   * Генерируется автоматически или редактируется.
   * Примеры: "Архитектура PKG", "Бюджет Сбер", "Планы на отпуск"
   */
  @Column({ length: 500 })
  @Index()
  topic: string;

  /**
   * Ключевые слова темы (для поиска).
   */
  @Column({ type: 'text', array: true, nullable: true })
  keywords: string[] | null;

  /**
   * Краткое описание (авто-генерируется).
   */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  // ==================== Источник ====================

  /**
   * Telegram chat ID (источник сообщений).
   */
  @Column({ name: 'chat_id', length: 100 })
  @Index()
  chatId: string;

  /**
   * Техническая сессия, в рамках которой сегмент.
   * Один Interaction может содержать несколько сегментов.
   */
  @Column({ name: 'interaction_id', type: 'uuid', nullable: true })
  @Index()
  interactionId: string | null;

  @ManyToOne(() => Interaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'interaction_id' })
  interaction: Interaction | null;

  // ==================== Связь с Activity ====================

  /**
   * Activity, к которой относится обсуждение (если определено).
   * NULL для личных тем, общих вопросов.
   */
  @Column({ name: 'activity_id', type: 'uuid', nullable: true })
  @Index()
  activityId: string | null;

  @ManyToOne(() => Activity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity | null;

  // ==================== Участники ====================

  /**
   * Участники обсуждения (Entity IDs).
   */
  @Column({ name: 'participant_ids', type: 'uuid', array: true })
  participantIds: string[];

  /**
   * Основной собеседник (с кем идёт чат).
   */
  @Column({ name: 'primary_participant_id', type: 'uuid', nullable: true })
  primaryParticipantId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'primary_participant_id' })
  primaryParticipant: EntityRecord | null;

  // ==================== Сообщения ====================

  /**
   * Сообщения в этом сегменте (many-to-many).
   * Одно сообщение может быть в нескольких сегментах (редко).
   */
  @ManyToMany(() => Message)
  @JoinTable({
    name: 'segment_messages',
    joinColumn: { name: 'segment_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'message_id', referencedColumnName: 'id' },
  })
  messages: Message[];

  /**
   * Количество сообщений (денормализовано для быстрых запросов).
   */
  @Column({ name: 'message_count', type: 'int', default: 0 })
  messageCount: number;

  // ==================== Временные рамки ====================

  /**
   * Время первого сообщения в сегменте.
   */
  @Column({ name: 'started_at', type: 'timestamp with time zone' })
  @Index()
  startedAt: Date;

  /**
   * Время последнего сообщения в сегменте.
   */
  @Column({ name: 'ended_at', type: 'timestamp with time zone' })
  @Index()
  endedAt: Date;

  // ==================== Извлечённые сущности ====================

  /**
   * IDs извлечённых фактов из этого сегмента.
   */
  @Column({ name: 'extracted_fact_ids', type: 'uuid', array: true, default: '{}' })
  extractedFactIds: string[];

  /**
   * IDs извлечённых задач из этого сегмента.
   */
  @Column({ name: 'extracted_task_ids', type: 'uuid', array: true, default: '{}' })
  extractedTaskIds: string[];

  /**
   * IDs извлечённых обязательств из этого сегмента.
   */
  @Column({ name: 'extracted_commitment_ids', type: 'uuid', array: true, default: '{}' })
  extractedCommitmentIds: string[];

  // ==================== Статус и метаданные ====================

  @Column({ type: 'varchar', length: 20, default: SegmentStatus.ACTIVE })
  @Index()
  status: SegmentStatus;

  /**
   * ID KnowledgePack, в который упакован (если status=packed).
   */
  @Column({ name: 'knowledge_pack_id', type: 'uuid', nullable: true })
  knowledgePackId: string | null;

  /**
   * ID сегмента, с которым объединён (если status=merged).
   */
  @Column({ name: 'merged_into_id', type: 'uuid', nullable: true })
  mergedIntoId: string | null;

  /**
   * Уверенность в корректности сегментации (0-1).
   */
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.8 })
  confidence: number;

  /**
   * Метаданные сегмента.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: {
    /** Причина сегментации */
    segmentationReason?: 'topic_change' | 'time_gap' | 'manual' | 'explicit_marker';
    /** Оригинальная тема до нормализации */
    rawTopic?: string;
    /** Флаги */
    isPersonal?: boolean;
    isWorkRelated?: boolean;
    /** Для отладки */
    debugInfo?: Record<string, unknown>;
  } | null;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

### 3.2 KnowledgePack

```typescript
// packages/entities/src/knowledge-pack.entity.ts

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

  /**
   * Название пакета знаний.
   * Примеры: "PKG/Архитектура (Январь 2026)", "Иван — рабочие вопросы"
   */
  @Column({ length: 500 })
  @Index()
  title: string;

  /**
   * Тип упаковки.
   */
  @Column({ type: 'varchar', length: 20 })
  @Index()
  packType: PackType;

  // ==================== Привязки ====================

  /**
   * Activity, к которой относится пакет (для packType=activity).
   */
  @Column({ name: 'activity_id', type: 'uuid', nullable: true })
  @Index()
  activityId: string | null;

  @ManyToOne(() => Activity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity | null;

  /**
   * Entity, к которой относится пакет (для packType=entity).
   */
  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  @Index()
  entityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord | null;

  /**
   * Тема (для packType=topic).
   */
  @Column({ length: 500, nullable: true })
  topic: string | null;

  // ==================== Временной период ====================

  /**
   * Начало периода, который покрывает пакет.
   */
  @Column({ name: 'period_start', type: 'timestamp with time zone' })
  @Index()
  periodStart: Date;

  /**
   * Конец периода.
   */
  @Column({ name: 'period_end', type: 'timestamp with time zone' })
  @Index()
  periodEnd: Date;

  // ==================== Контент ====================

  /**
   * Сжатое summary всех знаний.
   */
  @Column({ type: 'text' })
  summary: string;

  /**
   * Ключевые решения.
   */
  @Column({ type: 'jsonb', default: '[]' })
  decisions: Array<{
    what: string;
    when: string;
    context?: string;
    sourceSegmentId?: string;
  }>;

  /**
   * Открытые вопросы.
   */
  @Column({ name: 'open_questions', type: 'jsonb', default: '[]' })
  openQuestions: Array<{
    question: string;
    raisedAt: string;
    context?: string;
    sourceSegmentId?: string;
  }>;

  /**
   * Ключевые факты (консолидированные).
   */
  @Column({ name: 'key_facts', type: 'jsonb', default: '[]' })
  keyFacts: Array<{
    factType: string;
    value: string;
    confidence: number;
    sourceSegmentIds: string[];
    lastUpdated: string;
  }>;

  /**
   * Участники обсуждений.
   */
  @Column({ name: 'participant_ids', type: 'uuid', array: true, default: '{}' })
  participantIds: string[];

  // ==================== Источники ====================

  /**
   * IDs сегментов, вошедших в этот пакет.
   */
  @Column({ name: 'source_segment_ids', type: 'uuid', array: true })
  sourceSegmentIds: string[];

  /**
   * Количество сегментов.
   */
  @Column({ name: 'segment_count', type: 'int', default: 0 })
  segmentCount: number;

  /**
   * Общее количество сообщений во всех сегментах.
   */
  @Column({ name: 'total_message_count', type: 'int', default: 0 })
  totalMessageCount: number;

  // ==================== Конфликты и валидация ====================

  /**
   * Обнаруженные конфликты.
   */
  @Column({ type: 'jsonb', default: '[]' })
  conflicts: Array<{
    type: 'fact_contradiction' | 'decision_change' | 'timeline_inconsistency';
    description: string;
    segmentIds: string[];
    resolved: boolean;
    resolution?: string;
  }>;

  /**
   * Пакет верифицирован пользователем?
   */
  @Column({ name: 'is_verified', type: 'boolean', default: false })
  isVerified: boolean;

  /**
   * Дата верификации.
   */
  @Column({ name: 'verified_at', type: 'timestamp with time zone', nullable: true })
  verifiedAt: Date | null;

  // ==================== Статус ====================

  @Column({ type: 'varchar', length: 20, default: PackStatus.DRAFT })
  @Index()
  status: PackStatus;

  /**
   * ID пакета, который заменил этот (если status=superseded).
   */
  @Column({ name: 'superseded_by_id', type: 'uuid', nullable: true })
  supersededById: string | null;

  // ==================== Метаданные ====================

  @Column({ type: 'jsonb', nullable: true })
  metadata: {
    /** Версия алгоритма упаковки */
    packingVersion?: string;
    /** Токены, использованные на генерацию summary */
    tokensUsed?: number;
    /** Отладочная информация */
    debugInfo?: Record<string, unknown>;
  } | null;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

### 3.3 Обновление существующих сущностей

```typescript
// Добавить в EntityFact
@Column({ name: 'source_segment_id', type: 'uuid', nullable: true })
@Index()
sourceSegmentId: string | null;

// Добавить в Activity (task)
@Column({ name: 'source_segment_id', type: 'uuid', nullable: true })
sourceSegmentId: string | null;

// Добавить в Commitment
@Column({ name: 'source_segment_id', type: 'uuid', nullable: true })
sourceSegmentId: string | null;
```

---

## Часть 4: Segmentation Pipeline

### 4.1 Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                    SEGMENTATION PIPELINE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Messages   │───►│  Segmenter   │───►│  Segments    │      │
│  │   (batch)    │    │   Service    │    │   (new)      │      │
│  └──────────────┘    └──────┬───────┘    └──────────────┘      │
│                             │                                    │
│                    ┌────────▼────────┐                          │
│                    │  Topic Detector │                          │
│                    │  (Claude Agent) │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│         ┌───────────────────┼───────────────────┐               │
│         ▼                   ▼                   ▼               │
│  ┌────────────┐      ┌────────────┐      ┌────────────┐        │
│  │  Activity  │      │  Keyword   │      │  Summary   │        │
│  │  Matcher   │      │  Extractor │      │  Generator │        │
│  └────────────┘      └────────────┘      └────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 SegmentationService

```typescript
// apps/pkg-core/src/modules/knowledge/segmentation.service.ts

@Injectable()
export class SegmentationService {
  private readonly logger = new Logger(SegmentationService.name);

  constructor(
    @InjectRepository(TopicalSegment)
    private readonly segmentRepo: Repository<TopicalSegment>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly activityService: ActivityService,
  ) {}

  /**
   * Сегментировать новые сообщения в чате.
   * Вызывается периодически или по событию.
   */
  async segmentChat(chatId: string, since?: Date): Promise<TopicalSegment[]> {
    // 1. Получить несегментированные сообщения
    const messages = await this.getUnsegmentedMessages(chatId, since);
    if (messages.length === 0) return [];

    // 2. Получить активные сегменты чата (для продолжения)
    const activeSegments = await this.getActiveSegments(chatId);

    // 3. Определить границы тем через Claude
    const topicBoundaries = await this.detectTopicBoundaries(messages, activeSegments);

    // 4. Создать/обновить сегменты
    const segments = await this.createSegments(chatId, messages, topicBoundaries);

    // 5. Связать с Activity где возможно
    await this.linkSegmentsToActivities(segments);

    return segments;
  }

  /**
   * Определить границы тем в потоке сообщений.
   */
  private async detectTopicBoundaries(
    messages: Message[],
    activeSegments: TopicalSegment[],
  ): Promise<TopicBoundary[]> {
    const activeTopics = activeSegments.map(s => ({
      id: s.id,
      topic: s.topic,
      lastMessageTime: s.endedAt,
    }));

    const result = await this.claudeAgentService.call<TopicDetectionResponse>({
      mode: 'oneshot',
      prompt: `
Проанализируй поток сообщений и определи смену тем.

АКТИВНЫЕ ТЕМЫ (можно продолжить):
${JSON.stringify(activeTopics, null, 2)}

СООБЩЕНИЯ:
${messages.map(m => `[${m.timestamp}] ${m.senderName}: ${m.content}`).join('\n')}

Для каждой группы сообщений определи:
1. topic — название темы (кратко, но понятно)
2. messageIndices — индексы сообщений [0, 1, 2...]
3. continuesSegmentId — ID существующего сегмента, если это продолжение
4. activityHint — название проекта/задачи, если упоминается
5. confidence — уверенность в корректности сегментации (0-1)

Критерии смены темы:
- Явный переход ("кстати", "а ещё", "вернёмся к")
- Смена предмета обсуждения
- Временной разрыв > 30 минут без связи
`,
      outputFormat: {
        type: 'json_schema',
        schema: TOPIC_DETECTION_SCHEMA,
        strict: true,
      },
    });

    return result.data.segments;
  }

  /**
   * Связать сегменты с Activity через fuzzy matching.
   */
  private async linkSegmentsToActivities(segments: TopicalSegment[]): Promise<void> {
    for (const segment of segments) {
      if (segment.activityId) continue; // Уже связан

      // Попробовать найти Activity по теме
      const activity = await this.activityService.findByMention(segment.topic);
      if (activity) {
        segment.activityId = activity.id;
        await this.segmentRepo.save(segment);
        this.logger.debug(`Linked segment "${segment.topic}" to activity "${activity.name}"`);
      }
    }
  }
}
```

### 4.3 Topic Detection Schema

```typescript
const TOPIC_DETECTION_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Topic name, concise but descriptive',
          },
          messageIndices: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Indices of messages belonging to this topic',
          },
          continuesSegmentId: {
            type: 'string',
            description: 'UUID of existing segment if this continues it',
          },
          activityHint: {
            type: 'string',
            description: 'Project/task name if mentioned',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Key terms for search',
          },
          isPersonal: {
            type: 'boolean',
            description: 'Is this a personal (non-work) topic?',
          },
          confidence: {
            type: 'number',
            description: 'Confidence in segmentation 0-1',
          },
        },
        required: ['topic', 'messageIndices', 'confidence'],
      },
    },
  },
  required: ['segments'],
};
```

---

## Часть 5: Packing Pipeline

### 5.1 Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                      PACKING PIPELINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Segments    │───►│   Packer     │───►│ KnowledgePack│      │
│  │  (closed)    │    │   Service    │    │   (new)      │      │
│  └──────────────┘    └──────┬───────┘    └──────────────┘      │
│                             │                                    │
│         ┌───────────────────┼───────────────────┐               │
│         ▼                   ▼                   ▼               │
│  ┌────────────┐      ┌────────────┐      ┌────────────┐        │
│  │  Grouper   │      │ Summarizer │      │  Conflict  │        │
│  │            │      │  (Claude)  │      │  Detector  │        │
│  └────────────┘      └────────────┘      └────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 PackingService

```typescript
// apps/pkg-core/src/modules/knowledge/packing.service.ts

@Injectable()
export class PackingService {
  private readonly logger = new Logger(PackingService.name);

  constructor(
    @InjectRepository(KnowledgePack)
    private readonly packRepo: Repository<KnowledgePack>,
    @InjectRepository(TopicalSegment)
    private readonly segmentRepo: Repository<TopicalSegment>,
    private readonly claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * Упаковать сегменты по Activity за период.
   */
  async packByActivity(
    activityId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<KnowledgePack> {
    // 1. Получить все закрытые сегменты по Activity за период
    const segments = await this.segmentRepo.find({
      where: {
        activityId,
        status: In([SegmentStatus.CLOSED, SegmentStatus.ACTIVE]),
        startedAt: MoreThanOrEqual(periodStart),
        endedAt: LessThanOrEqual(periodEnd),
      },
      order: { startedAt: 'ASC' },
    });

    if (segments.length === 0) {
      throw new Error('No segments to pack');
    }

    // 2. Сгенерировать сводку
    const packContent = await this.generatePackContent(segments);

    // 3. Обнаружить конфликты
    const conflicts = await this.detectConflicts(segments);

    // 4. Создать KnowledgePack
    const pack = this.packRepo.create({
      title: packContent.title,
      packType: PackType.ACTIVITY,
      activityId,
      periodStart,
      periodEnd,
      summary: packContent.summary,
      decisions: packContent.decisions,
      openQuestions: packContent.openQuestions,
      keyFacts: packContent.keyFacts,
      participantIds: [...new Set(segments.flatMap(s => s.participantIds))],
      sourceSegmentIds: segments.map(s => s.id),
      segmentCount: segments.length,
      totalMessageCount: segments.reduce((sum, s) => sum + s.messageCount, 0),
      conflicts,
      status: PackStatus.DRAFT,
    });

    const savedPack = await this.packRepo.save(pack);

    // 5. Обновить статус сегментов
    await this.segmentRepo.update(
      { id: In(segments.map(s => s.id)) },
      { status: SegmentStatus.PACKED, knowledgePackId: savedPack.id },
    );

    this.logger.log(
      `Created KnowledgePack "${savedPack.title}" from ${segments.length} segments`,
    );

    return savedPack;
  }

  /**
   * Сгенерировать контент пакета через Claude.
   */
  private async generatePackContent(
    segments: TopicalSegment[],
  ): Promise<PackContent> {
    const segmentSummaries = segments.map(s => ({
      topic: s.topic,
      summary: s.summary,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      keywords: s.keywords,
    }));

    const result = await this.claudeAgentService.call<PackContent>({
      mode: 'oneshot',
      prompt: `
Создай сводку знаний из нескольких обсуждений.

СЕГМЕНТЫ ОБСУЖДЕНИЙ:
${JSON.stringify(segmentSummaries, null, 2)}

Создай:
1. title — название пакета знаний
2. summary — общая сводка (2-3 абзаца)
3. decisions — ключевые решения (что решили, когда)
4. openQuestions — нерешённые вопросы
5. keyFacts — ключевые факты (консолидированные, без дубликатов)

Фокусируйся на:
- Что было решено и почему
- Что осталось нерешённым
- Какие факты важны для будущего контекста
`,
      outputFormat: {
        type: 'json_schema',
        schema: PACK_CONTENT_SCHEMA,
        strict: true,
      },
    });

    return result.data;
  }

  /**
   * Обнаружить конфликты между сегментами.
   */
  private async detectConflicts(segments: TopicalSegment[]): Promise<Conflict[]> {
    // Собрать все факты из сегментов
    const allFactIds = segments.flatMap(s => s.extractedFactIds);
    if (allFactIds.length < 2) return [];

    // Загрузить факты
    const facts = await this.factRepo.find({
      where: { id: In(allFactIds) },
    });

    // Группировать по factType + entityId
    const factGroups = this.groupFactsByTypeAndEntity(facts);

    // Найти противоречия
    const conflicts: Conflict[] = [];
    for (const [key, groupFacts] of factGroups) {
      if (groupFacts.length > 1) {
        const values = [...new Set(groupFacts.map(f => f.value))];
        if (values.length > 1) {
          conflicts.push({
            type: 'fact_contradiction',
            description: `Разные значения для ${key}: ${values.join(' vs ')}`,
            segmentIds: groupFacts.map(f => f.sourceSegmentId).filter(Boolean),
            resolved: false,
          });
        }
      }
    }

    return conflicts;
  }
}
```

---

## Часть 6: API и Tools

### 6.1 REST API

```typescript
// KnowledgeController

@Controller('knowledge')
export class KnowledgeController {
  /**
   * GET /knowledge/segments?activityId=...&chatId=...&from=...&to=...
   * Получить сегменты по фильтрам.
   */
  @Get('segments')
  async listSegments(@Query() query: ListSegmentsDto) { ... }

  /**
   * GET /knowledge/segments/:id
   * Получить сегмент с сообщениями.
   */
  @Get('segments/:id')
  async getSegment(@Param('id') id: string) { ... }

  /**
   * GET /knowledge/segments/:id/messages
   * Получить сообщения сегмента.
   */
  @Get('segments/:id/messages')
  async getSegmentMessages(@Param('id') id: string) { ... }

  /**
   * GET /knowledge/packs?activityId=...&entityId=...
   * Получить пакеты знаний.
   */
  @Get('packs')
  async listPacks(@Query() query: ListPacksDto) { ... }

  /**
   * GET /knowledge/packs/:id
   * Получить пакет знаний.
   */
  @Get('packs/:id')
  async getPack(@Param('id') id: string) { ... }

  /**
   * POST /knowledge/packs/:id/verify
   * Пометить пакет как верифицированный.
   */
  @Post('packs/:id/verify')
  async verifyPack(@Param('id') id: string) { ... }

  /**
   * POST /knowledge/packs/:id/conflicts/:conflictIndex/resolve
   * Разрешить конфликт в пакете.
   */
  @Post('packs/:id/conflicts/:conflictIndex/resolve')
  async resolveConflict(
    @Param('id') id: string,
    @Param('conflictIndex') conflictIndex: number,
    @Body() resolution: ResolveConflictDto,
  ) { ... }
}
```

### 6.2 Claude Agent Tools

```typescript
// KnowledgeToolsProvider

const knowledgeTools = [
  tool(
    'search_discussions',
    'Search for past discussions by topic, activity, or participant',
    {
      query: z.string().describe('Search query or topic name'),
      activityId: z.string().uuid().optional().describe('Filter by activity'),
      entityId: z.string().uuid().optional().describe('Filter by participant'),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async (args) => {
      const segments = await this.knowledgeService.searchSegments(args);
      return toolSuccess(segments.map(s => ({
        id: s.id,
        topic: s.topic,
        summary: s.summary,
        activityName: s.activity?.name,
        startedAt: s.startedAt,
        messageCount: s.messageCount,
      })));
    }
  ),

  tool(
    'get_discussion_context',
    'Get full context of a specific discussion including messages',
    {
      segmentId: z.string().uuid().describe('Segment ID'),
      includeMessages: z.boolean().default(true).describe('Include message text'),
    },
    async (args) => {
      const segment = await this.knowledgeService.getSegmentWithMessages(args.segmentId);
      return toolSuccess(segment);
    }
  ),

  tool(
    'get_knowledge_summary',
    'Get consolidated knowledge about activity or topic for a period',
    {
      activityId: z.string().uuid().optional().describe('Activity ID'),
      topic: z.string().optional().describe('Topic name'),
      period: z.enum(['week', 'month', 'quarter', 'all']).default('month'),
    },
    async (args) => {
      const pack = await this.knowledgeService.getOrCreatePack(args);
      return toolSuccess({
        title: pack.title,
        summary: pack.summary,
        decisions: pack.decisions,
        openQuestions: pack.openQuestions,
        conflicts: pack.conflicts.filter(c => !c.resolved),
      });
    }
  ),

  tool(
    'trace_fact_source',
    'Find the discussion context where a fact was mentioned',
    {
      factId: z.string().uuid().describe('Fact ID to trace'),
    },
    async (args) => {
      const fact = await this.factService.findOneWithSegment(args.factId);
      if (!fact.sourceSegmentId) {
        return toolEmptyResult('source segment for this fact');
      }
      const segment = await this.knowledgeService.getSegmentWithMessages(fact.sourceSegmentId);
      return toolSuccess({
        fact: { type: fact.factType, value: fact.value },
        discussionTopic: segment.topic,
        discussionSummary: segment.summary,
        messages: segment.messages?.slice(-5), // Последние 5 сообщений контекста
      });
    }
  ),
];
```

---

## Часть 7: Workflows

### 7.1 Периодическая сегментация (Job)

```typescript
// SegmentationJob — запускается каждый час

@Injectable()
export class SegmentationJob {
  @Cron('0 * * * *') // Каждый час
  async runSegmentation() {
    const chatsWithNewMessages = await this.getChatsWithUnsegmentedMessages();

    for (const chatId of chatsWithNewMessages) {
      try {
        const segments = await this.segmentationService.segmentChat(chatId);
        this.logger.log(`Segmented ${segments.length} topics in chat ${chatId}`);
      } catch (error) {
        this.logger.error(`Failed to segment chat ${chatId}: ${error.message}`);
      }
    }
  }
}
```

### 7.2 Еженедельная упаковка (Job)

```typescript
// PackingJob — запускается раз в неделю

@Injectable()
export class PackingJob {
  @Cron('0 3 * * 0') // Воскресенье 03:00
  async runWeeklyPacking() {
    const periodEnd = new Date();
    const periodStart = subDays(periodEnd, 7);

    // Получить все Activity с сегментами за неделю
    const activitiesWithSegments = await this.getActivitiesWithSegments(periodStart, periodEnd);

    for (const activityId of activitiesWithSegments) {
      try {
        const pack = await this.packingService.packByActivity(
          activityId,
          periodStart,
          periodEnd,
        );
        this.logger.log(`Created weekly pack for activity ${activityId}`);

        // Отправить уведомление если есть конфликты
        if (pack.conflicts.length > 0) {
          await this.notifyConflicts(pack);
        }
      } catch (error) {
        this.logger.error(`Failed to pack activity ${activityId}: ${error.message}`);
      }
    }
  }
}
```

### 7.3 Workflow: Recall с контекстом

```
User: "Что мы решили по архитектуре PKG?"

1. [RecallService] Поиск по сегментам:
   - query: "архитектура PKG"
   - Найдено 3 сегмента

2. [RecallService] Проверка KnowledgePack:
   - Есть pack "PKG/Архитектура (Январь 2026)"
   - summary + decisions

3. [RecallService] Формирование ответа:
   "По архитектуре PKG решили:
   - Микросервисная архитектура на NestJS (решение от 18 янв)
   - TypeORM для работы с БД
   - Открытый вопрос: выбор системы очередей

   [Показать обсуждение] → открывает Mini App со списком сегментов"
```

### 7.4 Workflow: Перепроверка факта

```
User: "Откуда взялся факт про бюджет 500к?"

1. [FactService] Получить факт с sourceSegmentId

2. [KnowledgeService] Загрузить сегмент с сообщениями

3. [Response]:
   "Факт 'Бюджет проекта — 500к' извлечён из обсуждения:

   Тема: 'Бюджет проекта Сбер'
   Дата: 15 января 2026
   Участники: Иван, Вы

   Контекст:
   [10:45] Иван: Бюджет утвердили, будет 500к
   [10:46] Вы: Отлично, это больше чем планировали

   [Обновить] [Удалить] [Показать всё обсуждение]"
```

---

## Часть 8: Mini App Integration

### 8.1 Новые страницы

| Страница | URL | Описание |
|----------|-----|----------|
| Обсуждения по Activity | `/activity/:id/discussions` | Список сегментов по проекту |
| Сегмент детально | `/segment/:id` | Сообщения сегмента |
| Пакеты знаний | `/knowledge` | Список KnowledgePack |
| Пакет детально | `/knowledge/:id` | Summary, decisions, конфликты |
| Разрешение конфликтов | `/knowledge/:id/conflicts` | UI для разрешения |

### 8.2 Компонент SegmentCard

```vue
<template>
  <div class="segment-card" @click="openSegment">
    <div class="segment-header">
      <span class="topic">{{ segment.topic }}</span>
      <span class="date">{{ formatDate(segment.startedAt) }}</span>
    </div>

    <p class="summary">{{ segment.summary }}</p>

    <div class="segment-meta">
      <span class="message-count">💬 {{ segment.messageCount }}</span>
      <span v-if="segment.activity" class="activity">
        📁 {{ segment.activity.name }}
      </span>
      <span v-if="segment.extractedFactIds.length" class="facts">
        📝 {{ segment.extractedFactIds.length }} фактов
      </span>
    </div>
  </div>
</template>
```

---

## Часть 9: Implementation Roadmap

### Phase E.1: Core Entities (1 неделя)

| # | Задача | Приоритет |
|---|--------|-----------|
| E.1.1 | TopicalSegment entity + migration | P0 |
| E.1.2 | KnowledgePack entity + migration | P0 |
| E.1.3 | Добавить sourceSegmentId в Fact/Activity/Commitment | P0 |
| E.1.4 | segment_messages join table | P0 |

### Phase E.2: Segmentation (2 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| E.2.1 | SegmentationService | P0 |
| E.2.2 | Topic detection через Claude | P0 |
| E.2.3 | Activity linking | P1 |
| E.2.4 | SegmentationJob (hourly) | P0 |
| E.2.5 | Интеграция с DraftExtractionService (sourceSegmentId) | P0 |

### Phase E.3: Packing (2 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| E.3.1 | PackingService | P0 |
| E.3.2 | Summary generation через Claude | P0 |
| E.3.3 | Conflict detection | P1 |
| E.3.4 | PackingJob (weekly) | P1 |

### Phase E.4: API & Tools (1 неделя)

| # | Задача | Приоритет |
|---|--------|-----------|
| E.4.1 | KnowledgeController REST API | P0 |
| E.4.2 | KnowledgeToolsProvider | P0 |
| E.4.3 | Интеграция с RecallService | P0 |

### Phase E.5: Mini App (1-2 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| E.5.1 | API client расширение | P0 |
| E.5.2 | Страница discussions | P1 |
| E.5.3 | Страница segment details | P1 |
| E.5.4 | Страница knowledge packs | P2 |
| E.5.5 | Conflict resolution UI | P2 |

---

## Часть 10: Зависимости и Prerequisites

### Требуется из Phase D (Jarvis Foundation)

- ✅ Activity entity
- ✅ ActivityService с findByMention()
- ⬜ Commitment entity (для извлечения)

### Требуется из Phase C (Extract & React)

- ✅ DraftExtractionService
- ✅ PendingApproval workflow
- ⬜ Модификация для sourceSegmentId

### Миграции БД

```sql
-- 1. TopicalSegment
CREATE TABLE topical_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic VARCHAR(500) NOT NULL,
  keywords TEXT[],
  summary TEXT,
  chat_id VARCHAR(100) NOT NULL,
  interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
  activity_id UUID REFERENCES activities(id) ON DELETE SET NULL,
  participant_ids UUID[] NOT NULL,
  primary_participant_id UUID REFERENCES entities(id),
  message_count INT DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  extracted_fact_ids UUID[] DEFAULT '{}',
  extracted_task_ids UUID[] DEFAULT '{}',
  extracted_commitment_ids UUID[] DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  knowledge_pack_id UUID,
  merged_into_id UUID,
  confidence DECIMAL(3,2) DEFAULT 0.8,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_segments_chat_id ON topical_segments(chat_id);
CREATE INDEX idx_segments_activity_id ON topical_segments(activity_id);
CREATE INDEX idx_segments_status ON topical_segments(status);
CREATE INDEX idx_segments_started_at ON topical_segments(started_at);

-- 2. segment_messages (many-to-many)
CREATE TABLE segment_messages (
  segment_id UUID REFERENCES topical_segments(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (segment_id, message_id)
);

-- 3. KnowledgePack
CREATE TABLE knowledge_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  pack_type VARCHAR(20) NOT NULL,
  activity_id UUID REFERENCES activities(id) ON DELETE SET NULL,
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  topic VARCHAR(500),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  summary TEXT NOT NULL,
  decisions JSONB DEFAULT '[]',
  open_questions JSONB DEFAULT '[]',
  key_facts JSONB DEFAULT '[]',
  participant_ids UUID[] DEFAULT '{}',
  source_segment_ids UUID[] NOT NULL,
  segment_count INT DEFAULT 0,
  total_message_count INT DEFAULT 0,
  conflicts JSONB DEFAULT '[]',
  is_verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'draft',
  superseded_by_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_packs_activity_id ON knowledge_packs(activity_id);
CREATE INDEX idx_packs_entity_id ON knowledge_packs(entity_id);
CREATE INDEX idx_packs_status ON knowledge_packs(status);
CREATE INDEX idx_packs_period ON knowledge_packs(period_start, period_end);

-- 4. Добавить sourceSegmentId в существующие таблицы
ALTER TABLE entity_facts ADD COLUMN source_segment_id UUID REFERENCES topical_segments(id);
ALTER TABLE activities ADD COLUMN source_segment_id UUID REFERENCES topical_segments(id);
ALTER TABLE commitments ADD COLUMN source_segment_id UUID REFERENCES topical_segments(id);

CREATE INDEX idx_facts_source_segment ON entity_facts(source_segment_id);
CREATE INDEX idx_activities_source_segment ON activities(source_segment_id);
CREATE INDEX idx_commitments_source_segment ON commitments(source_segment_id);
```

---

## Часть 11: Метрики успеха

| Метрика | Текущее | Цель |
|---------|---------|------|
| % фактов с sourceSegmentId | 0% | > 90% |
| Среднее время поиска "откуда факт" | N/A (невозможно) | < 3 сек |
| Выявленных конфликтов/неделю | 0 | Зависит от данных |
| Использование "Показать обсуждение" | 0 | > 20% от recall запросов |

---

## Следующий шаг

После утверждения плана:

1. Создать ветку `feat/knowledge-segmentation`
2. Начать с Phase E.1.1 — TopicalSegment entity
3. Миграция БД
4. Базовый SegmentationService

Готов начать?
