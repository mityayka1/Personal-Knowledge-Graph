# Спецификация: Summarization и организация хранения знаний

## 1. Обзор проблемы

### 1.1 Рост данных

При активном использовании PKG данные растут экспоненциально:

```
Месяц 1:   3,000 сообщений  │  150 interactions  │  ~50 контактов
Месяц 6:  18,000 сообщений  │  900 interactions  │ ~120 контактов
Месяц 12: 36,000 сообщений  │ 1800 interactions  │ ~200 контактов
```

### 1.2 Проблемы без summarization

| Проблема | Последствие |
|----------|-------------|
| Context retrieval тянет все сообщения | Timeout, высокий latency |
| LLM получает слишком много токенов | Дорого, теряется фокус |
| Старые договорённости "тонут" | Потеря важной информации |
| Нет компактного представления истории | Невозможно быстро понять контекст |

### 1.3 Цель

Обеспечить **стабильное время ответа** и **полноту контекста** независимо от объёма накопленных данных через:

1. **Proactive summarization** — создание summaries ДО того, как они понадобятся
2. **Tiered retrieval** — разные уровни детализации для разных временных периодов
3. **Importance preservation** — сохранение ключевых решений и договорённостей навсегда

---

## 2. Архитектура хранения

### 2.1 Уровни данных (Data Tiers)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DATA TIERS                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  HOT TIER: Raw Messages (< 7 дней)                          │   │
│  │  ─────────────────────────────────────────────────────────  │   │
│  │  • Полный текст всех сообщений                              │   │
│  │  • Embeddings для semantic search                           │   │
│  │  • Максимальная детализация                                 │   │
│  │  • ~2000-3000 tokens на entity                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↓                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  WARM TIER: Interaction Summaries (7-90 дней)               │   │
│  │  ─────────────────────────────────────────────────────────  │   │
│  │  • Summary каждой interaction (100-200 слов)                │   │
│  │  • Key points, decisions, action items                      │   │
│  │  • Ссылки на важные сообщения                               │   │
│  │  • ~1000-1500 tokens на entity                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↓                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  COLD TIER: Entity Relationship Profile (> 90 дней)         │   │
│  │  ─────────────────────────────────────────────────────────  │   │
│  │  • Агрегированный профиль отношений                         │   │
│  │  • Только HIGH importance decisions                         │   │
│  │  • Timeline ключевых событий                                │   │
│  │  • ~300-500 tokens на entity                                │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  PERMANENT: Key Decisions & Facts                           │   │
│  │  ─────────────────────────────────────────────────────────  │   │
│  │  • EntityFacts (birthday, position, contacts)               │   │
│  │  • High-importance decisions (никогда не удаляются)         │   │
│  │  • Contractual agreements                                   │   │
│  │  • ~200-300 tokens на entity                                │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Целевой token budget при retrieval

```
┌────────────────────────────────────────────────────────────────┐
│  CONTEXT RETRIEVAL TOKEN BUDGET                                │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Entity Info + Facts         ~300 tokens   ████                │
│  Hot: Recent Messages       ~2000 tokens   ████████████████    │
│  Warm: Summaries            ~1000 tokens   ████████            │
│  Cold: Key Decisions         ~300 tokens   ████                │
│  Relevant Chunks (search)    ~500 tokens   ██████              │
│  ──────────────────────────────────────────────────────────── │
│  TOTAL                      ~4100 tokens                       │
│                                                                │
│  vs. без summarization:    ~50000+ tokens (все сообщения)     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Модель данных

### 3.1 InteractionSummary Entity

```typescript
// packages/entities/src/interaction-summary.entity.ts

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Interaction } from './interaction.entity';

/**
 * Решение, принятое в рамках interaction.
 * Сохраняется с importance для tiered retrieval.
 */
export interface Decision {
  /** Описание решения */
  description: string;
  /** Дата решения (ISO string) */
  date: string;
  /** Важность: high сохраняется в cold tier навсегда */
  importance: 'high' | 'medium' | 'low';
  /** Цитата из сообщения (опционально) */
  quote?: string;
}

/**
 * Задача/action item из interaction.
 */
export interface ActionItem {
  /** Описание задачи */
  description: string;
  /** Кто ответственный */
  owner: 'self' | 'them' | 'both';
  /** Статус выполнения */
  status: 'open' | 'closed';
  /** Дедлайн если указан */
  dueDate?: string;
  /** Когда закрыта */
  closedAt?: string;
}

/**
 * Факт, извлечённый в процессе summarization.
 * Может быть промоутнут в EntityFact после review.
 */
export interface ExtractedFactRef {
  factType: string;
  value: string;
  confidence: number;
  quote?: string;
  /** Если создан EntityFact — его ID */
  promotedToFactId?: string;
}

/**
 * Ссылка на важное сообщение, сохраняемое даже после archival.
 */
export interface ImportantMessageRef {
  messageId: string;
  content: string;
  timestamp: string;
  reason: 'decision' | 'agreement' | 'deadline' | 'important_info';
}

@Entity('interaction_summaries')
export class InteractionSummary {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'interaction_id', type: 'uuid', unique: true })
  @Index()
  interactionId: string;

  @OneToOne(() => Interaction, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'interaction_id' })
  interaction: Interaction;

  // ─────────────────────────────────────────────────────────────
  // Core Summary Content
  // ─────────────────────────────────────────────────────────────

  /**
   * Краткое резюме interaction (2-4 предложения).
   * Отвечает на: "О чём общались? Какой результат?"
   */
  @Column('text')
  summary: string;

  /**
   * Ключевые темы/points обсуждения.
   * Используется для быстрого скана и поиска.
   */
  @Column('jsonb', { default: [] })
  keyPoints: string[];

  /**
   * Эмоциональный тон взаимодействия.
   */
  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  tone: 'positive' | 'neutral' | 'negative' | 'formal' | 'informal' | null;

  // ─────────────────────────────────────────────────────────────
  // Structured Extractions
  // ─────────────────────────────────────────────────────────────

  /**
   * Решения, принятые в рамках interaction.
   * HIGH importance решения сохраняются в cold tier навсегда.
   */
  @Column('jsonb', { default: [] })
  decisions: Decision[];

  /**
   * Action items / задачи.
   * Open items показываются в context retrieval.
   */
  @Column('jsonb', { default: [] })
  actionItems: ActionItem[];

  /**
   * Факты, извлечённые из conversation.
   * Могут быть promoted в EntityFact после review.
   */
  @Column('jsonb', { name: 'extracted_facts', default: [] })
  extractedFacts: ExtractedFactRef[];

  /**
   * Ссылки на важные сообщения.
   * Сохраняются даже после archival основных messages.
   */
  @Column('jsonb', { name: 'important_messages', default: [] })
  importantMessages: ImportantMessageRef[];

  // ─────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────

  /** Количество сообщений в interaction */
  @Column({ name: 'message_count', type: 'int' })
  messageCount: number;

  /** Примерное количество токенов в исходных сообщениях */
  @Column({ name: 'source_token_count', type: 'int', nullable: true })
  sourceTokenCount: number;

  /** Количество токенов в summary */
  @Column({ name: 'summary_token_count', type: 'int', nullable: true })
  summaryTokenCount: number;

  /** Compression ratio: source_tokens / summary_tokens */
  @Column({ name: 'compression_ratio', type: 'decimal', precision: 5, scale: 2, nullable: true })
  compressionRatio: number;

  /** Версия модели, создавшей summary */
  @Column({ name: 'model_version', type: 'varchar', length: 50, nullable: true })
  modelVersion: string;

  /** Стоимость генерации в USD */
  @Column({ name: 'generation_cost_usd', type: 'decimal', precision: 10, scale: 6, nullable: true })
  generationCostUsd: number;

  @CreateDateColumn({ name: 'generated_at' })
  generatedAt: Date;

  /** Была ли summary обновлена после создания */
  @Column({ name: 'updated_at', type: 'timestamp', nullable: true })
  updatedAt: Date | null;

  /** Количество обновлений summary */
  @Column({ name: 'revision_count', type: 'int', default: 1 })
  revisionCount: number;
}
```

### 3.2 EntityRelationshipProfile Entity

```typescript
// packages/entities/src/entity-relationship-profile.entity.ts

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Entity as PKGEntity } from './entity.entity';

/**
 * Ключевое событие в истории отношений.
 */
export interface RelationshipMilestone {
  date: string;
  event: string;
  importance: 'high' | 'medium';
}

/**
 * Агрегированный профиль отношений с entity.
 * Создаётся для entities с историей > 90 дней.
 * Обновляется еженедельно.
 */
@Entity('entity_relationship_profiles')
export class EntityRelationshipProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'entity_id', type: 'uuid', unique: true })
  @Index()
  entityId: string;

  @OneToOne(() => PKGEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entity_id' })
  entity: PKGEntity;

  // ─────────────────────────────────────────────────────────────
  // Relationship Overview
  // ─────────────────────────────────────────────────────────────

  /**
   * Тип отношений.
   */
  @Column({ name: 'relationship_type', type: 'varchar', length: 30 })
  relationshipType: 'client' | 'partner' | 'colleague' | 'friend' | 'acquaintance' | 'vendor' | 'other';

  /**
   * Частота коммуникации.
   */
  @Column({ name: 'communication_frequency', type: 'varchar', length: 20 })
  communicationFrequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'rare';

  /**
   * Краткое описание отношений (1-2 предложения).
   */
  @Column('text')
  relationshipSummary: string;

  /**
   * Timeline отношений.
   * Пример: "Знакомы с марта 2023. Активно работали Q2-Q3 2024."
   */
  @Column({ name: 'relationship_timeline', type: 'text', nullable: true })
  relationshipTimeline: string;

  // ─────────────────────────────────────────────────────────────
  // Aggregated Stats
  // ─────────────────────────────────────────────────────────────

  /** Дата первого взаимодействия */
  @Column({ name: 'first_interaction_date', type: 'date' })
  firstInteractionDate: Date;

  /** Дата последнего значимого контакта */
  @Column({ name: 'last_meaningful_contact', type: 'date' })
  lastMeaningfulContact: Date;

  /** Общее количество interactions */
  @Column({ name: 'total_interactions', type: 'int' })
  totalInteractions: number;

  /** Общее количество сообщений */
  @Column({ name: 'total_messages', type: 'int' })
  totalMessages: number;

  // ─────────────────────────────────────────────────────────────
  // Key Information (Cold Tier)
  // ─────────────────────────────────────────────────────────────

  /**
   * Топ темы обсуждений (агрегировано из всех interactions).
   */
  @Column('jsonb', { name: 'top_topics', default: [] })
  topTopics: string[];

  /**
   * Ключевые вехи в отношениях.
   * Только HIGH importance события.
   */
  @Column('jsonb', { default: [] })
  milestones: RelationshipMilestone[];

  /**
   * HIGH importance decisions из всех interactions.
   * Никогда не удаляются, всегда включаются в context.
   */
  @Column('jsonb', { name: 'key_decisions', default: [] })
  keyDecisions: Array<{
    date: string;
    description: string;
    interactionId: string;
  }>;

  /**
   * Незакрытые action items (агрегировано).
   */
  @Column('jsonb', { name: 'open_action_items', default: [] })
  openActionItems: Array<{
    description: string;
    owner: 'self' | 'them' | 'both';
    since: string;
    interactionId: string;
  }>;

  // ─────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────

  /** Количество summarized interactions, вошедших в профиль */
  @Column({ name: 'summarized_interactions_count', type: 'int' })
  summarizedInteractionsCount: number;

  /** Период покрытия: начало */
  @Column({ name: 'coverage_start', type: 'date' })
  coverageStart: Date;

  /** Период покрытия: конец */
  @Column({ name: 'coverage_end', type: 'date' })
  coverageEnd: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /** Версия модели */
  @Column({ name: 'model_version', type: 'varchar', length: 50, nullable: true })
  modelVersion: string;
}
```

### 3.3 Дополнительные поля в Message

```typescript
// Добавить в Message entity

/**
 * Importance score сообщения (0.0 - 1.0).
 * Рассчитывается при ingestion на основе эвристик.
 * Высокий score = сохраняется в important_messages при summarization.
 */
@Column({ name: 'importance_score', type: 'decimal', precision: 3, scale: 2, nullable: true })
importanceScore: number | null;

/**
 * Причина высокой важности (если importance_score > 0.7).
 */
@Column({ name: 'importance_reason', type: 'varchar', length: 50, nullable: true })
importanceReason: 'has_date' | 'has_amount' | 'has_agreement' | 'has_deadline' | 'long_message' | null;

/**
 * Флаг: сообщение archived (исходный текст удалён, сохранено в summary).
 */
@Column({ name: 'is_archived', type: 'boolean', default: false })
isArchived: boolean;

/**
 * Дата archival.
 */
@Column({ name: 'archived_at', type: 'timestamp', nullable: true })
archivedAt: Date | null;
```

### 3.4 Миграция БД

```typescript
// apps/pkg-core/src/database/migrations/XXXXXX-AddSummarizationTables.ts

import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSummarizationTables implements MigrationInterface {
  name = 'AddSummarizationTables';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. InteractionSummary table
    await queryRunner.query(`
      CREATE TABLE "interaction_summaries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "interaction_id" uuid NOT NULL,
        "summary" text NOT NULL,
        "key_points" jsonb NOT NULL DEFAULT '[]',
        "tone" varchar(20),
        "decisions" jsonb NOT NULL DEFAULT '[]',
        "action_items" jsonb NOT NULL DEFAULT '[]',
        "extracted_facts" jsonb NOT NULL DEFAULT '[]',
        "important_messages" jsonb NOT NULL DEFAULT '[]',
        "message_count" integer NOT NULL,
        "source_token_count" integer,
        "summary_token_count" integer,
        "compression_ratio" decimal(5,2),
        "model_version" varchar(50),
        "generation_cost_usd" decimal(10,6),
        "generated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP,
        "revision_count" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_interaction_summaries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_interaction_summaries_interaction" UNIQUE ("interaction_id"),
        CONSTRAINT "FK_interaction_summaries_interaction" 
          FOREIGN KEY ("interaction_id") 
          REFERENCES "interactions"("id") 
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_interaction_summaries_interaction_id" 
      ON "interaction_summaries" ("interaction_id")
    `);

    // 2. EntityRelationshipProfile table
    await queryRunner.query(`
      CREATE TABLE "entity_relationship_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "entity_id" uuid NOT NULL,
        "relationship_type" varchar(30) NOT NULL,
        "communication_frequency" varchar(20) NOT NULL,
        "relationship_summary" text NOT NULL,
        "relationship_timeline" text,
        "first_interaction_date" date NOT NULL,
        "last_meaningful_contact" date NOT NULL,
        "total_interactions" integer NOT NULL,
        "total_messages" integer NOT NULL,
        "top_topics" jsonb NOT NULL DEFAULT '[]',
        "milestones" jsonb NOT NULL DEFAULT '[]',
        "key_decisions" jsonb NOT NULL DEFAULT '[]',
        "open_action_items" jsonb NOT NULL DEFAULT '[]',
        "summarized_interactions_count" integer NOT NULL,
        "coverage_start" date NOT NULL,
        "coverage_end" date NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "model_version" varchar(50),
        CONSTRAINT "PK_entity_relationship_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_entity_relationship_profiles_entity" UNIQUE ("entity_id"),
        CONSTRAINT "FK_entity_relationship_profiles_entity" 
          FOREIGN KEY ("entity_id") 
          REFERENCES "entities"("id") 
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_entity_relationship_profiles_entity_id" 
      ON "entity_relationship_profiles" ("entity_id")
    `);

    // 3. Add columns to messages
    await queryRunner.query(`
      ALTER TABLE "messages" 
      ADD COLUMN "importance_score" decimal(3,2),
      ADD COLUMN "importance_reason" varchar(50),
      ADD COLUMN "is_archived" boolean NOT NULL DEFAULT false,
      ADD COLUMN "archived_at" timestamp
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_messages_importance" 
      ON "messages" ("importance_score") 
      WHERE "importance_score" > 0.7
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_messages_archived" 
      ON "messages" ("is_archived") 
      WHERE "is_archived" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_messages_archived"`);
    await queryRunner.query(`DROP INDEX "IDX_messages_importance"`);
    await queryRunner.query(`
      ALTER TABLE "messages" 
      DROP COLUMN "archived_at",
      DROP COLUMN "is_archived",
      DROP COLUMN "importance_reason",
      DROP COLUMN "importance_score"
    `);
    await queryRunner.query(`DROP TABLE "entity_relationship_profiles"`);
    await queryRunner.query(`DROP TABLE "interaction_summaries"`);
  }
}
```

---

## 4. Процессы Summarization

### 4.1 Обзор процессов

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SUMMARIZATION PROCESSES                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  PROCESS 1: Interaction Summarization                         │ │
│  │  ─────────────────────────────────────────────────────────── │ │
│  │  Trigger: Cron (daily 03:00) + On interaction complete        │ │
│  │  Input:   Completed interactions > 7 days without summary     │ │
│  │  Output:  InteractionSummary record                           │ │
│  │  Rate:    20 interactions/day (rate limited)                  │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  PROCESS 2: Entity Profile Aggregation                        │ │
│  │  ─────────────────────────────────────────────────────────── │ │
│  │  Trigger: Cron (weekly, Sunday 04:00)                         │ │
│  │  Input:   Entities with interactions > 90 days                │ │
│  │  Output:  EntityRelationshipProfile record                    │ │
│  │  Rate:    50 entities/week                                    │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  PROCESS 3: Message Archival                                  │ │
│  │  ─────────────────────────────────────────────────────────── │ │
│  │  Trigger: Cron (monthly, 1st day 05:00)                       │ │
│  │  Input:   Summarized interactions > 180 days                  │ │
│  │  Output:  Messages marked as archived                         │ │
│  │  Note:    Embeddings и important_messages сохраняются         │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  PROCESS 4: Incremental Summary Update                        │ │
│  │  ─────────────────────────────────────────────────────────── │ │
│  │  Trigger: New messages in summarized interaction              │ │
│  │  Input:   Existing summary + new messages                     │ │
│  │  Output:  Updated InteractionSummary                          │ │
│  │  Note:    Только если < 10 новых сообщений                    │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Process 1: Interaction Summarization

#### 4.2.1 Trigger условия

```typescript
interface SummarizationTrigger {
  // Основные условия
  interactionStatus: 'completed';           // Только завершённые
  interactionAge: '>= 7 days';              // Старше 7 дней
  hasSummary: false;                        // Ещё нет summary
  messageCount: '>= 3';                     // Минимум 3 сообщения
  
  // Исключения
  excludeChatCategories: ['mass'];          // Не суммаризировать mass chats
}
```

#### 4.2.2 Flow диаграмма

```
┌─────────────────────────────────────────────────────────────────┐
│  INTERACTION SUMMARIZATION FLOW                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────┐                                                    │
│  │  CRON   │ Daily 03:00                                        │
│  │ Trigger │                                                    │
│  └────┬────┘                                                    │
│       ↓                                                         │
│  ┌─────────────────────────────────────────┐                   │
│  │ Query: unsummarized interactions        │                   │
│  │ WHERE status = 'completed'              │                   │
│  │   AND ended_at < NOW() - 7 days         │                   │
│  │   AND id NOT IN (SELECT interaction_id  │                   │
│  │                  FROM interaction_summaries)                │
│  │ ORDER BY ended_at ASC                   │                   │
│  │ LIMIT 20                                │                   │
│  └────────────────┬────────────────────────┘                   │
│                   ↓                                             │
│  ┌─────────────────────────────────────────┐                   │
│  │ For each interaction:                   │                   │
│  │   Add to BullMQ 'summarization' queue   │                   │
│  │   with rate limiting                    │                   │
│  └────────────────┬────────────────────────┘                   │
│                   ↓                                             │
│  ┌─────────────────────────────────────────┐                   │
│  │ Queue Worker processes job:             │                   │
│  │                                         │                   │
│  │ 1. Fetch all messages for interaction   │                   │
│  │ 2. Calculate importance scores          │                   │
│  │ 3. Build prompt                         │                   │
│  │ 4. Call Claude CLI (haiku)              │                   │
│  │ 5. Parse structured output              │                   │
│  │ 6. Save InteractionSummary              │                   │
│  │ 7. Update message importance flags      │                   │
│  │ 8. Log cost metrics                     │                   │
│  └─────────────────────────────────────────┘                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.2.3 Промпт для summarization

```typescript
const SUMMARIZATION_PROMPT = `
Проанализируй переписку и создай структурированное резюме.

## Участники
- Я: {selfName}
- Собеседник: {entityName} ({entityType})
{organizationContext}

## Переписка
{formattedMessages}

## Задача
Создай резюме, выделив:

1. **Summary**: 2-4 предложения. О чём общались? Какой результат? Какой тон?

2. **Key Points**: 3-7 ключевых тем/пунктов обсуждения.

3. **Decisions**: Решения, которые были приняты.
   - Укажи importance: "high" для решений влияющих на деньги, сроки, обязательства
   - "medium" для обычных договорённостей
   - "low" для мелких решений

4. **Action Items**: Задачи, которые нужно выполнить.
   - owner: "self" (я должен), "them" (они должны), "both" (совместно)
   - status: "open" или "closed" (если уже выполнено в переписке)

5. **Important Messages**: ID сообщений, которые критично сохранить:
   - Конкретные даты, дедлайны
   - Суммы денег, цены
   - Явные договорённости ("договорились", "ок, сделаю")
   - Контактные данные

6. **Tone**: Общий тон переписки (positive/neutral/negative/formal/informal)

## Формат вывода
JSON согласно схеме.
`;
```

#### 4.2.4 JSON Schema для structured output

```typescript
const SUMMARIZATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Краткое резюме 2-4 предложения',
    },
    keyPoints: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 7,
    },
    tone: {
      type: 'string',
      enum: ['positive', 'neutral', 'negative', 'formal', 'informal'],
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          date: { type: 'string', description: 'ISO date or null' },
          importance: { type: 'string', enum: ['high', 'medium', 'low'] },
          quote: { type: 'string' },
        },
        required: ['description', 'importance'],
      },
    },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          owner: { type: 'string', enum: ['self', 'them', 'both'] },
          status: { type: 'string', enum: ['open', 'closed'] },
          dueDate: { type: 'string' },
        },
        required: ['description', 'owner', 'status'],
      },
    },
    importantMessageIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs сообщений для сохранения',
    },
  },
  required: ['summary', 'keyPoints', 'tone', 'decisions', 'actionItems'],
};
```

#### 4.2.5 Реализация сервиса

```typescript
// apps/pkg-core/src/modules/summarization/summarization.service.ts

@Injectable()
export class SummarizationService {
  private readonly logger = new Logger(SummarizationService.name);

  constructor(
    @InjectRepository(InteractionSummary)
    private summaryRepo: Repository<InteractionSummary>,
    @InjectRepository(Interaction)
    private interactionRepo: Repository<Interaction>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    private claudeService: ClaudeService,
    private metricsService: MetricsService,
    @InjectQueue('summarization')
    private summarizationQueue: Queue,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Scheduling
  // ─────────────────────────────────────────────────────────────

  /**
   * Daily cron: schedule summarization for old interactions
   */
  @Cron('0 3 * * *')
  async scheduleDailySummarization() {
    const cutoffDate = subDays(new Date(), 7);

    const interactions = await this.interactionRepo
      .createQueryBuilder('i')
      .leftJoin('interaction_summaries', 's', 's.interaction_id = i.id')
      .leftJoin('chat_categories', 'cc', 'cc.telegram_chat_id = i.source_metadata->>\'telegram_chat_id\'')
      .where('i.status = :status', { status: 'completed' })
      .andWhere('i.ended_at < :cutoff', { cutoff: cutoffDate })
      .andWhere('s.id IS NULL')
      .andWhere('(cc.category IS NULL OR cc.category != :mass)', { mass: 'mass' })
      .orderBy('i.ended_at', 'ASC')
      .limit(20)
      .getMany();

    for (const interaction of interactions) {
      await this.summarizationQueue.add(
        'summarize',
        { interactionId: interaction.id },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 60000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );
    }

    this.logger.log(`Scheduled ${interactions.length} interactions for summarization`);
  }

  /**
   * Manual trigger: schedule backfill for all unsummarized
   */
  async scheduleBackfill(params: {
    olderThan: Date;
    limit: number;
  }): Promise<number> {
    const interactions = await this.interactionRepo
      .createQueryBuilder('i')
      .leftJoin('interaction_summaries', 's', 's.interaction_id = i.id')
      .where('i.status = :status', { status: 'completed' })
      .andWhere('i.ended_at < :cutoff', { cutoff: params.olderThan })
      .andWhere('s.id IS NULL')
      .orderBy('i.ended_at', 'ASC')
      .limit(params.limit)
      .getMany();

    for (const interaction of interactions) {
      await this.summarizationQueue.add(
        'summarize',
        { interactionId: interaction.id },
        { priority: 10 }, // Lower priority than daily
      );
    }

    return interactions.length;
  }

  // ─────────────────────────────────────────────────────────────
  // Processing
  // ─────────────────────────────────────────────────────────────

  /**
   * Process summarization job
   */
  @Process('summarize')
  async processSummarization(job: Job<{ interactionId: string }>) {
    const { interactionId } = job.data;
    const startTime = Date.now();

    this.logger.debug(`Processing summarization for interaction ${interactionId}`);

    // 1. Check if already summarized (race condition)
    const existing = await this.summaryRepo.findOne({
      where: { interactionId },
    });
    if (existing) {
      this.logger.debug(`Interaction ${interactionId} already summarized, skipping`);
      return { skipped: true };
    }

    // 2. Fetch interaction with participants
    const interaction = await this.interactionRepo.findOne({
      where: { id: interactionId },
      relations: ['participants', 'participants.entity'],
    });

    if (!interaction) {
      throw new Error(`Interaction ${interactionId} not found`);
    }

    // 3. Fetch messages
    const messages = await this.messageRepo.find({
      where: { interactionId },
      order: { timestamp: 'ASC' },
      take: 500, // Limit for very long interactions
    });

    if (messages.length < 3) {
      this.logger.debug(`Interaction ${interactionId} has < 3 messages, skipping`);
      return { skipped: true, reason: 'too_few_messages' };
    }

    // 4. Calculate importance scores for messages
    const scoredMessages = this.scoreMessages(messages);

    // 5. Build prompt
    const prompt = this.buildPrompt(interaction, scoredMessages);
    const sourceTokens = this.estimateTokens(prompt);

    // 6. Call Claude CLI
    const result = await this.claudeService.call({
      prompt,
      schema: SUMMARIZATION_SCHEMA,
      model: 'haiku',
      task: 'summarization',
    });

    // 7. Extract important messages content
    const importantMessages = this.extractImportantMessages(
      scoredMessages,
      result.importantMessageIds || [],
    );

    // 8. Save summary
    const summary = this.summaryRepo.create({
      interactionId,
      summary: result.summary,
      keyPoints: result.keyPoints,
      tone: result.tone,
      decisions: result.decisions || [],
      actionItems: result.actionItems || [],
      importantMessages,
      messageCount: messages.length,
      sourceTokenCount: sourceTokens,
      summaryTokenCount: this.estimateTokens(JSON.stringify(result)),
      compressionRatio: sourceTokens / this.estimateTokens(JSON.stringify(result)),
      modelVersion: 'claude-3-haiku',
      generationCostUsd: result.cost,
    });

    await this.summaryRepo.save(summary);

    // 9. Update importance scores on messages
    await this.updateMessageImportance(scoredMessages);

    // 10. Log metrics
    const duration = Date.now() - startTime;
    this.metricsService.recordSummarization({
      interactionId,
      messageCount: messages.length,
      duration,
      cost: result.cost,
      compressionRatio: summary.compressionRatio,
    });

    this.logger.log(
      `Summarized interaction ${interactionId}: ` +
      `${messages.length} msgs → ${result.keyPoints.length} points, ` +
      `${result.decisions?.length || 0} decisions, ` +
      `compression ${summary.compressionRatio?.toFixed(1)}x`,
    );

    return { success: true, summaryId: summary.id };
  }

  // ─────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Score messages by importance using heuristics
   */
  private scoreMessages(messages: Message[]): Array<Message & { score: number; reason?: string }> {
    return messages.map(msg => {
      let score = 0;
      let reason: string | undefined;

      const text = msg.content || '';

      // Date patterns: 15.01, 15 января, завтра, в понедельник
      if (/\d{1,2}[.\/]\d{1,2}|\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|завтра|послезавтра|в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)/i.test(text)) {
        score += 0.3;
        reason = 'has_date';
      }

      // Amount patterns: 50k, $100, 1000 рублей
      if (/\d+[kкКK]|\$\d+|€\d+|\d+\s*(руб|рублей|долларов|евро|usd|eur)/i.test(text)) {
        score += 0.3;
        reason = reason || 'has_amount';
      }

      // Agreement patterns
      if (/договорились|согласен|окей|ок,|хорошо,\s*сделаю|принято|deal|договор/i.test(text)) {
        score += 0.4;
        reason = reason || 'has_agreement';
      }

      // Deadline patterns
      if (/дедлайн|срок|до\s+\d|крайний срок|deadline/i.test(text)) {
        score += 0.3;
        reason = reason || 'has_deadline';
      }

      // Long messages often contain important info
      if (text.length > 300) {
        score += 0.2;
        reason = reason || 'long_message';
      }

      // Questions might need follow-up
      if (text.includes('?') && text.length > 50) {
        score += 0.1;
      }

      return { ...msg, score: Math.min(score, 1), reason };
    });
  }

  /**
   * Build prompt for summarization
   */
  private buildPrompt(
    interaction: Interaction,
    messages: Array<Message & { score: number }>,
  ): string {
    // Find self and other participants
    const selfParticipant = interaction.participants?.find(p => p.role === 'self');
    const otherParticipant = interaction.participants?.find(p => p.role !== 'self');

    const selfName = 'Я';
    const entityName = otherParticipant?.entity?.name || otherParticipant?.displayName || 'Собеседник';
    const entityType = otherParticipant?.entity?.type || 'person';
    const orgContext = otherParticipant?.entity?.organization
      ? `Организация: ${otherParticipant.entity.organization.name}`
      : '';

    // Format messages
    const formattedMessages = messages
      .map((m, i) => {
        const sender = m.isOutgoing ? 'Я' : entityName;
        const importance = m.score > 0.5 ? ' [!]' : '';
        return `[${i + 1}] ${sender}${importance}: ${m.content}`;
      })
      .join('\n\n');

    return SUMMARIZATION_PROMPT
      .replace('{selfName}', selfName)
      .replace('{entityName}', entityName)
      .replace('{entityType}', entityType)
      .replace('{organizationContext}', orgContext)
      .replace('{formattedMessages}', formattedMessages);
  }

  /**
   * Extract important messages for permanent storage
   */
  private extractImportantMessages(
    messages: Array<Message & { score: number; reason?: string }>,
    llmSelectedIds: string[],
  ): ImportantMessageRef[] {
    const important: ImportantMessageRef[] = [];

    for (const msg of messages) {
      // Include if: high score OR selected by LLM
      const isHighScore = msg.score >= 0.5;
      const isLLMSelected = llmSelectedIds.includes(msg.id);

      if (isHighScore || isLLMSelected) {
        important.push({
          messageId: msg.id,
          content: msg.content || '',
          timestamp: msg.timestamp.toISOString(),
          reason: this.mapReason(msg.reason),
        });
      }
    }

    return important;
  }

  private mapReason(reason?: string): ImportantMessageRef['reason'] {
    switch (reason) {
      case 'has_agreement': return 'agreement';
      case 'has_deadline': return 'deadline';
      case 'has_date':
      case 'has_amount': return 'important_info';
      default: return 'decision';
    }
  }

  private estimateTokens(text: string): number {
    // Rough estimation: ~4 chars per token for mixed ru/en
    return Math.ceil(text.length / 4);
  }

  private async updateMessageImportance(
    messages: Array<Message & { score: number; reason?: string }>,
  ): Promise<void> {
    const updates = messages
      .filter(m => m.score > 0)
      .map(m => ({
        id: m.id,
        importanceScore: m.score,
        importanceReason: m.reason || null,
      }));

    if (updates.length > 0) {
      await this.messageRepo
        .createQueryBuilder()
        .update()
        .set({ importanceScore: () => 'EXCLUDED.importance_score' })
        .whereInIds(updates.map(u => u.id))
        .execute();
    }
  }
}
```

### 4.3 Process 2: Entity Profile Aggregation

#### 4.3.1 Flow диаграмма

```
┌─────────────────────────────────────────────────────────────────┐
│  ENTITY PROFILE AGGREGATION FLOW                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────┐                                                    │
│  │  CRON   │ Weekly, Sunday 04:00                               │
│  │ Trigger │                                                    │
│  └────┬────┘                                                    │
│       ↓                                                         │
│  ┌─────────────────────────────────────────┐                   │
│  │ Query: entities needing profile update  │                   │
│  │ WHERE first_interaction > 90 days ago   │                   │
│  │   AND (profile IS NULL                  │                   │
│  │        OR profile.updated_at < 7 days)  │                   │
│  │ LIMIT 50                                │                   │
│  └────────────────┬────────────────────────┘                   │
│                   ↓                                             │
│  ┌─────────────────────────────────────────┐                   │
│  │ For each entity:                        │                   │
│  │                                         │                   │
│  │ 1. Fetch all InteractionSummaries       │                   │
│  │ 2. Aggregate:                           │                   │
│  │    - All HIGH importance decisions      │                   │
│  │    - All open action items              │                   │
│  │    - Top topics (frequency analysis)    │                   │
│  │    - Communication stats                │                   │
│  │ 3. Call Claude CLI for synthesis:       │                   │
│  │    - relationship_type                  │                   │
│  │    - relationship_summary               │                   │
│  │    - milestones                         │                   │
│  │ 4. Save/Update EntityRelationshipProfile│                   │
│  └─────────────────────────────────────────┘                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.3.2 Реализация

```typescript
// apps/pkg-core/src/modules/summarization/entity-profile.service.ts

@Injectable()
export class EntityProfileService {
  private readonly logger = new Logger(EntityProfileService.name);

  /**
   * Weekly cron: update entity profiles
   */
  @Cron('0 4 * * 0') // Sunday 04:00
  async scheduleWeeklyProfileUpdate() {
    const cutoffDate = subDays(new Date(), 90);
    const staleDate = subDays(new Date(), 7);

    // Find entities needing profile update
    const entities = await this.entityRepo
      .createQueryBuilder('e')
      .leftJoin('entity_relationship_profiles', 'p', 'p.entity_id = e.id')
      .leftJoin('interactions', 'i', 'i.participants @> :participant', {
        participant: JSON.stringify([{ entityId: 'e.id' }]),
      })
      .where('e.type = :type', { type: 'person' })
      .andWhere('(p.id IS NULL OR p.updated_at < :stale)', { stale: staleDate })
      .groupBy('e.id')
      .having('MIN(i.started_at) < :cutoff', { cutoff: cutoffDate })
      .limit(50)
      .getMany();

    for (const entity of entities) {
      await this.profileQueue.add('aggregate', { entityId: entity.id });
    }

    this.logger.log(`Scheduled ${entities.length} entity profiles for aggregation`);
  }

  /**
   * Process profile aggregation
   */
  @Process('aggregate')
  async processProfileAggregation(job: Job<{ entityId: string }>) {
    const { entityId } = job.data;

    // 1. Fetch entity with facts
    const entity = await this.entityRepo.findOne({
      where: { id: entityId },
      relations: ['facts', 'organization'],
    });

    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    // 2. Fetch all interaction summaries for this entity
    const summaries = await this.summaryRepo
      .createQueryBuilder('s')
      .innerJoin('interactions', 'i', 'i.id = s.interaction_id')
      .innerJoin('interaction_participants', 'ip', 'ip.interaction_id = i.id')
      .where('ip.entity_id = :entityId', { entityId })
      .orderBy('i.started_at', 'ASC')
      .getMany();

    if (summaries.length === 0) {
      this.logger.debug(`No summaries for entity ${entityId}, skipping profile`);
      return { skipped: true };
    }

    // 3. Aggregate data
    const aggregated = this.aggregateSummaries(summaries);

    // 4. Call Claude for synthesis
    const synthesis = await this.claudeService.call({
      prompt: this.buildProfilePrompt(entity, aggregated),
      schema: PROFILE_SCHEMA,
      model: 'haiku',
    });

    // 5. Save profile
    const profile = await this.profileRepo.findOne({ where: { entityId } });

    const profileData = {
      entityId,
      relationshipType: synthesis.relationshipType,
      communicationFrequency: aggregated.communicationFrequency,
      relationshipSummary: synthesis.relationshipSummary,
      relationshipTimeline: synthesis.relationshipTimeline,
      firstInteractionDate: aggregated.firstInteraction,
      lastMeaningfulContact: aggregated.lastInteraction,
      totalInteractions: aggregated.totalInteractions,
      totalMessages: aggregated.totalMessages,
      topTopics: aggregated.topTopics,
      milestones: synthesis.milestones,
      keyDecisions: aggregated.highImportanceDecisions,
      openActionItems: aggregated.openActionItems,
      summarizedInteractionsCount: summaries.length,
      coverageStart: aggregated.firstInteraction,
      coverageEnd: aggregated.lastInteraction,
      modelVersion: 'claude-3-haiku',
    };

    if (profile) {
      await this.profileRepo.update(profile.id, profileData);
    } else {
      await this.profileRepo.save(this.profileRepo.create(profileData));
    }

    this.logger.log(`Updated profile for entity ${entity.name}: ${summaries.length} summaries`);
    return { success: true };
  }

  /**
   * Aggregate data from multiple summaries
   */
  private aggregateSummaries(summaries: InteractionSummary[]) {
    const allDecisions: Decision[] = [];
    const allActionItems: ActionItem[] = [];
    const allKeyPoints: string[] = [];
    let totalMessages = 0;

    for (const summary of summaries) {
      allDecisions.push(...(summary.decisions || []));
      allActionItems.push(...(summary.actionItems || []));
      allKeyPoints.push(...(summary.keyPoints || []));
      totalMessages += summary.messageCount;
    }

    // Filter HIGH importance decisions
    const highImportanceDecisions = allDecisions
      .filter(d => d.importance === 'high')
      .map(d => ({
        date: d.date,
        description: d.description,
        interactionId: '', // Would need to track this
      }));

    // Filter open action items
    const openActionItems = allActionItems
      .filter(a => a.status === 'open')
      .map(a => ({
        description: a.description,
        owner: a.owner,
        since: a.dueDate || '',
        interactionId: '',
      }));

    // Calculate top topics by frequency
    const topicCounts = new Map<string, number>();
    for (const point of allKeyPoints) {
      const normalized = point.toLowerCase();
      topicCounts.set(normalized, (topicCounts.get(normalized) || 0) + 1);
    }
    const topTopics = [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic]) => topic);

    // Calculate communication frequency
    const firstInteraction = new Date(Math.min(...summaries.map(s => s.generatedAt.getTime())));
    const lastInteraction = new Date(Math.max(...summaries.map(s => s.generatedAt.getTime())));
    const daysDiff = differenceInDays(lastInteraction, firstInteraction);
    const avgDaysBetween = daysDiff / summaries.length;

    let communicationFrequency: string;
    if (avgDaysBetween <= 1) communicationFrequency = 'daily';
    else if (avgDaysBetween <= 7) communicationFrequency = 'weekly';
    else if (avgDaysBetween <= 30) communicationFrequency = 'monthly';
    else if (avgDaysBetween <= 90) communicationFrequency = 'quarterly';
    else communicationFrequency = 'rare';

    return {
      totalInteractions: summaries.length,
      totalMessages,
      firstInteraction,
      lastInteraction,
      communicationFrequency,
      topTopics,
      highImportanceDecisions,
      openActionItems,
      allDecisions,
    };
  }
}
```

### 4.4 Process 3: Message Archival

```typescript
// apps/pkg-core/src/modules/summarization/archival.service.ts

@Injectable()
export class ArchivalService {
  /**
   * Monthly cron: archive old messages
   * Keeps: embeddings, important_messages in summary
   * Removes: raw content (replaced with "[archived]")
   */
  @Cron('0 5 1 * *') // 1st day of month, 05:00
  async archiveOldMessages() {
    const cutoffDate = subDays(new Date(), 180); // 6 months

    // Find summarized interactions older than 180 days
    const interactions = await this.interactionRepo
      .createQueryBuilder('i')
      .innerJoin('interaction_summaries', 's', 's.interaction_id = i.id')
      .where('i.ended_at < :cutoff', { cutoff: cutoffDate })
      .andWhere('i.id NOT IN (SELECT DISTINCT interaction_id FROM messages WHERE is_archived = false)')
      .getMany();

    let archivedCount = 0;

    for (const interaction of interactions) {
      // Get messages that are NOT in important_messages
      const summary = await this.summaryRepo.findOne({
        where: { interactionId: interaction.id },
      });

      const importantIds = new Set(
        summary?.importantMessages?.map(m => m.messageId) || [],
      );

      // Archive non-important messages
      const result = await this.messageRepo
        .createQueryBuilder()
        .update()
        .set({
          content: '[archived]',
          isArchived: true,
          archivedAt: new Date(),
        })
        .where('interaction_id = :interactionId', { interactionId: interaction.id })
        .andWhere('id NOT IN (:...importantIds)', {
          importantIds: [...importantIds, 'dummy'], // Avoid empty array
        })
        .andWhere('is_archived = false')
        .execute();

      archivedCount += result.affected || 0;
    }

    this.logger.log(`Archived ${archivedCount} messages from ${interactions.length} interactions`);
  }
}
```

### 4.5 Process 4: Incremental Summary Update

```typescript
/**
 * Update existing summary when new messages arrive in old interaction.
 * Called when: message arrives in interaction that already has summary.
 */
async updateSummaryIncremental(interactionId: string, newMessages: Message[]) {
  const existing = await this.summaryRepo.findOne({
    where: { interactionId },
  });

  if (!existing) {
    // No summary exists, queue full summarization
    await this.summarizationQueue.add('summarize', { interactionId });
    return;
  }

  // If too many new messages, regenerate completely
  if (newMessages.length > 10) {
    await this.summarizationQueue.add('summarize', {
      interactionId,
      force: true, // Override existing
    });
    return;
  }

  // Incremental update
  const prompt = `
Существующее резюме:
${existing.summary}

Key points: ${existing.keyPoints.join(', ')}

Новые сообщения:
${newMessages.map(m => `[${m.isOutgoing ? 'Я' : 'Они'}]: ${m.content}`).join('\n')}

Обнови резюме, добавив информацию из новых сообщений.
Сохрани существующие decisions и action items, добавь новые если есть.
  `;

  const result = await this.claudeService.call({
    prompt,
    schema: SUMMARIZATION_SCHEMA,
    model: 'haiku',
  });

  // Merge results
  existing.summary = result.summary;
  existing.keyPoints = [...new Set([...existing.keyPoints, ...result.keyPoints])];
  existing.decisions = [...existing.decisions, ...(result.decisions || [])];
  existing.actionItems = this.mergeActionItems(existing.actionItems, result.actionItems || []);
  existing.messageCount += newMessages.length;
  existing.updatedAt = new Date();
  existing.revisionCount += 1;

  await this.summaryRepo.save(existing);

  this.logger.log(`Incrementally updated summary for interaction ${interactionId}`);
}

/**
 * Merge action items: update status of existing, add new
 */
private mergeActionItems(existing: ActionItem[], incoming: ActionItem[]): ActionItem[] {
  const result = [...existing];

  for (const item of incoming) {
    const existingItem = result.find(e =>
      e.description.toLowerCase() === item.description.toLowerCase(),
    );

    if (existingItem) {
      // Update status if changed
      if (item.status === 'closed' && existingItem.status === 'open') {
        existingItem.status = 'closed';
        existingItem.closedAt = new Date().toISOString();
      }
    } else {
      result.push(item);
    }
  }

  return result;
}
```

---

## 5. Context Retrieval с Tiered Data

### 5.1 Алгоритм retrieval

```typescript
// apps/pkg-core/src/modules/context/context.service.ts

@Injectable()
export class ContextService {
  /**
   * Get context for entity using tiered retrieval
   */
  async getContext(params: {
    entityId: string;
    taskHint?: string;
    maxTokens?: number;
  }): Promise<ContextResult> {
    const { entityId, taskHint, maxTokens = 4000 } = params;
    const now = new Date();

    // Token budget allocation
    const budget = {
      entityInfo: 300,
      hotMessages: 2000,
      warmSummaries: 1000,
      coldDecisions: 300,
      relevantChunks: taskHint ? 500 : 0,
    };

    // 1. Entity info + Facts (PERMANENT tier)
    const entity = await this.entityRepo.findOne({
      where: { id: entityId },
      relations: ['facts', 'organization'],
    });

    if (!entity) {
      throw new NotFoundException(`Entity ${entityId} not found`);
    }

    const entityInfo = this.formatEntityInfo(entity);

    // 2. HOT tier: Recent messages (< 7 days)
    const hotCutoff = subDays(now, 7);
    const hotMessages = await this.messageRepo.find({
      where: {
        senderEntityId: entityId,
        timestamp: MoreThan(hotCutoff),
        isArchived: false,
      },
      order: { timestamp: 'DESC' },
      take: 50,
    });

    // 3. WARM tier: Summaries (7-90 days)
    const warmCutoff = subDays(now, 90);
    const warmSummaries = await this.summaryRepo
      .createQueryBuilder('s')
      .innerJoin('interactions', 'i', 'i.id = s.interaction_id')
      .innerJoin('interaction_participants', 'ip', 'ip.interaction_id = i.id')
      .where('ip.entity_id = :entityId', { entityId })
      .andWhere('i.ended_at BETWEEN :warm AND :hot', {
        warm: warmCutoff,
        hot: hotCutoff,
      })
      .orderBy('i.ended_at', 'DESC')
      .limit(10)
      .getMany();

    // 4. COLD tier: Key decisions (> 90 days)
    const profile = await this.profileRepo.findOne({
      where: { entityId },
    });

    const coldDecisions = profile?.keyDecisions || [];
    const openActionItems = profile?.openActionItems || [];

    // 5. Relevant chunks via vector search (if task_hint)
    let relevantChunks: SearchResult[] = [];
    if (taskHint) {
      relevantChunks = await this.searchService.vectorSearch({
        query: taskHint,
        entityId,
        limit: 5,
      });
    }

    // 6. Synthesize context
    return this.synthesize({
      entity,
      entityInfo,
      hotMessages,
      warmSummaries,
      coldDecisions,
      openActionItems,
      relevantChunks,
      profile,
      taskHint,
    });
  }

  /**
   * Synthesize final context using Claude
   */
  private async synthesize(data: ContextData): Promise<ContextResult> {
    const prompt = this.buildSynthesisPrompt(data);

    const result = await this.claudeService.call({
      prompt,
      model: 'haiku',
      task: 'context-synthesis',
    });

    return {
      entityId: data.entity.id,
      entityName: data.entity.name,
      context: result,
      sources: {
        hotMessagesCount: data.hotMessages.length,
        warmSummariesCount: data.warmSummaries.length,
        coldDecisionsCount: data.coldDecisions.length,
        relevantChunksCount: data.relevantChunks.length,
      },
      generatedAt: new Date(),
    };
  }

  private buildSynthesisPrompt(data: ContextData): string {
    const sections: string[] = [];

    // Entity info
    sections.push(`## ${data.entity.name}`);
    sections.push(data.entityInfo);

    // Hot: recent messages
    if (data.hotMessages.length > 0) {
      sections.push('\n## Последние сообщения (< 7 дней)');
      sections.push(
        data.hotMessages
          .slice(0, 20)
          .map(m => `[${format(m.timestamp, 'dd.MM')}] ${m.isOutgoing ? 'Я' : 'Они'}: ${m.content}`)
          .join('\n'),
      );
    }

    // Warm: summaries
    if (data.warmSummaries.length > 0) {
      sections.push('\n## История взаимодействий (7-90 дней)');
      for (const summary of data.warmSummaries) {
        sections.push(`\n### ${format(summary.generatedAt, 'dd.MM.yyyy')}`);
        sections.push(summary.summary);
        if (summary.decisions?.length) {
          sections.push('Решения: ' + summary.decisions.map(d => d.description).join('; '));
        }
      }
    }

    // Cold: key decisions
    if (data.coldDecisions.length > 0) {
      sections.push('\n## Ключевые договорённости (история)');
      sections.push(
        data.coldDecisions
          .map(d => `- [${d.date}] ${d.description}`)
          .join('\n'),
      );
    }

    // Open action items
    if (data.openActionItems.length > 0) {
      sections.push('\n## Открытые задачи');
      sections.push(
        data.openActionItems
          .map(a => `- [${a.owner}] ${a.description}`)
          .join('\n'),
      );
    }

    // Relevant chunks
    if (data.relevantChunks.length > 0 && data.taskHint) {
      sections.push(`\n## Релевантно для: "${data.taskHint}"`);
      sections.push(data.relevantChunks.map(c => c.content).join('\n---\n'));
    }

    // Task for Claude
    sections.push(`
## Задача
Синтезируй компактный контекст для подготовки к общению с ${data.entity.name}.
${data.taskHint ? `Фокус: ${data.taskHint}` : ''}

Формат:
1. Текущий статус отношений (1-2 предложения)
2. Что актуально сейчас
3. Открытые вопросы
4. Ключевые факты для помнить
    `);

    return sections.join('\n');
  }
}
```

---

## 6. Мониторинг и метрики

### 6.1 Dashboard метрики

```typescript
interface SummarizationMetrics {
  // Coverage
  totalInteractions: number;
  summarizedInteractions: number;
  summarizationCoverage: number; // %
  
  // Backlog
  pendingInQueue: number;
  oldestUnsummarized: Date | null;
  
  // Performance
  avgSummarizationTimeMs: number;
  avgCompressionRatio: number;
  
  // Cost
  totalCostToday: number;
  totalCostMonth: number;
  avgCostPerSummary: number;
  
  // Quality indicators
  avgKeyPointsPerSummary: number;
  avgDecisionsPerSummary: number;
  totalOpenActionItems: number;
}
```

### 6.2 Endpoints для мониторинга

```typescript
@Controller('summarization')
export class SummarizationController {
  @Get('stats')
  async getStats(): Promise<SummarizationMetrics> {
    // Implementation
  }

  @Get('queue')
  async getQueueStatus() {
    const waiting = await this.summarizationQueue.getWaitingCount();
    const active = await this.summarizationQueue.getActiveCount();
    const failed = await this.summarizationQueue.getFailedCount();
    
    return { waiting, active, failed };
  }

  @Post('backfill')
  async triggerBackfill(
    @Query('limit') limit = 100,
    @Query('older_than_days') olderThanDays = 7,
  ) {
    // Trigger backfill
  }
}
```

---

## 7. Checklist для реализации

> **Статус: ✅ ЗАВЕРШЕНО** (12.01.2026)

### Фаза 1: Data Model (День 1) ✅
- [x] Создать `InteractionSummary` entity
- [x] Создать `EntityRelationshipProfile` entity
- [x] Добавить поля в `Message` entity
- [x] Написать и выполнить миграцию
- [x] Добавить entities в TypeORM config

### Фаза 2: Summarization Service (Дни 2-3) ✅
- [x] Создать `SummarizationService`
- [x] Реализовать `scoreMessages()` эвристики
- [x] Реализовать prompt building
- [x] Настроить BullMQ queue
- [x] Добавить cron job
- [x] Реализовать backfill endpoint

### Фаза 3: Profile Aggregation (День 4) ✅
- [x] Создать `EntityProfileService`
- [x] Реализовать агрегацию summaries
- [x] Добавить weekly cron job

### Фаза 4: Context Retrieval (Дни 5-6) ✅
- [x] Обновить `ContextService` с tiered logic
- [x] Реализовать synthesis prompt
- [x] Добавить `/context` endpoint

### Фаза 5: Monitoring (День 7) ✅
- [x] Добавить метрики в `MetricsService` (GET /summarization/stats)
- [x] Создать endpoints для мониторинга (GET /summarization/queue)
- [x] Добавить виджеты в Dashboard (Bull Board с summarization/entity-profile queues)

---

## 8. Оценка затрат

### LLM costs (Claude Haiku)

| Операция | Tokens in | Tokens out | Cost/op | Frequency | Monthly cost |
|----------|-----------|------------|---------|-----------|--------------|
| Summarization | ~3000 | ~500 | $0.003 | 600/mo | $1.80 |
| Profile aggregation | ~2000 | ~300 | $0.002 | 200/mo | $0.40 |
| Context synthesis | ~4000 | ~500 | $0.004 | 300/mo | $1.20 |
| **Total** | | | | | **~$3.40/mo** |

При активном использовании (1000+ interactions/месяц) затраты вырастут до ~$10-15/месяц.
