# Jarvis Foundation — Архитектура "Второй Памяти"

> Спецификация фундамента для проактивного интеллектуального ассистента

**Статус:** Draft v2
**Дата:** 2026-01-30
**Ключевое решение:** Гибкая модель Activity вместо жёстких Project/Task

---

## Executive Summary

PKG эволюционирует от "умного поиска по переписке" к **проактивному персональному ассистенту** ("Jarvis"). Ключевые компоненты:

1. **Knowledge Graph** — гибкая модель Activity + связи
2. **Reasoning Engine** — выводы, инференс, планирование
3. **Trigger System** — контекстно-зависимые уведомления
4. **Action Engine** — автономное выполнение действий
5. **External Knowledge** — интеграция с интернетом

---

## Часть 1: Онтология "Жизнь человека"

### 1.1 Философия модели

Жизнь человека состоит из **активностей** разного масштаба и природы:

| Уровень | Примеры | Характеристика |
|---------|---------|----------------|
| **Область жизни** | Работа, Семья, Здоровье | Вечные, без дедлайна |
| **Бизнес** | ИИ-Сервисы, ГуглШитс.ру | Долгоживущие, источник дохода |
| **Направление** | Канал, Сайт, Клиенты | Ongoing в рамках бизнеса |
| **Проект** | Хаб для Панавто | Временный, есть цель и дедлайн |
| **Инициатива** | Написать статью | Личный проект без клиента |
| **Задача** | Подготовить демо | Атомарное действие |

**Принцип:** Всё это — **Activity** с разным типом. Единая модель, максимальная гибкость.

### 1.2 Core Entities

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CORE ENTITIES                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │
│  │   PERSON    │    │ORGANIZATION │    │       ACTIVITY          │ │
│  │             │    │             │    │                         │ │
│  │ (человек)   │    │ (компания,  │    │ business | direction |  │ │
│  │             │    │  группа)    │    │ project | initiative |  │ │
│  │             │    │             │    │ task | area | habit     │ │
│  └──────┬──────┘    └──────┬──────┘    └───────────┬─────────────┘ │
│         │                  │                       │               │
│         └──────────────────┴───────────────────────┘               │
│                            │                                        │
│                    ┌───────▼───────┐                               │
│                    │  COMMITMENT   │                               │
│                    │               │                               │
│                    │ (обязательство│                               │
│                    │  между людьми)│                               │
│                    └───────────────┘                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Часть 2: Activity — Центральная сущность

### 2.1 Activity Entity

```typescript
// packages/entities/src/activity.entity.ts

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  Tree,
  TreeChildren,
  TreeParent,
} from 'typeorm';
import { EntityRecord } from './entity.entity';

/**
 * Типы активностей — расширяемый enum.
 * Новые типы добавляются без миграций структуры.
 */
export enum ActivityType {
  // Верхний уровень
  AREA = 'area',                 // Область жизни: Работа, Семья, Здоровье, Финансы
  BUSINESS = 'business',         // Бизнес/компания: ИИ-Сервисы, ГуглШитс.ру

  // Средний уровень
  DIRECTION = 'direction',       // Направление: Канал, Сайт, Клиентская работа
  PROJECT = 'project',           // Проект с целью и дедлайном
  INITIATIVE = 'initiative',     // Личная инициатива без клиента

  // Нижний уровень
  TASK = 'task',                 // Конкретная задача
  MILESTONE = 'milestone',       // Веха в проекте

  // Специальные
  HABIT = 'habit',               // Привычка (регулярная активность)
  LEARNING = 'learning',         // Обучение (курс, книга)
  EVENT_SERIES = 'event_series', // Серия событий (еженедельные встречи)
}

/**
 * Статусы активностей.
 * Семантика зависит от типа активности.
 */
export enum ActivityStatus {
  // Для ongoing (area, business, direction, habit)
  ONGOING = 'ongoing',           // Активно идёт, без конца

  // Для временных (project, initiative, task)
  IDEA = 'idea',                 // Идея, не начато
  PLANNED = 'planned',           // Запланировано
  ACTIVE = 'active',             // В работе
  BLOCKED = 'blocked',           // Заблокировано
  ON_HOLD = 'on_hold',           // Приостановлено
  COMPLETED = 'completed',       // Завершено успешно
  CANCELLED = 'cancelled',       // Отменено

  // Для архивации
  ARCHIVED = 'archived',         // Архивировано (скрыто из активных)
}

/**
 * Приоритеты.
 */
export enum ActivityPriority {
  NONE = 'none',                 // Без приоритета (для ongoing)
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * Контекст активности.
 */
export enum ActivityContext {
  WORK = 'work',
  PERSONAL = 'personal',
  FAMILY = 'family',
  FRIENDS = 'friends',
  HEALTH = 'health',
  FINANCE = 'finance',
  LEARNING = 'learning',
}

/**
 * Activity — универсальная сущность для всего, чем занимается человек.
 *
 * Иерархия через parent_id позволяет строить деревья любой глубины:
 * - Area → Business → Direction → Project → Task
 * - Area → Initiative → Task
 * - Habit (без parent)
 */
@Entity('activities')
@Tree('closure-table') // Эффективные запросы по иерархии
export class Activity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ==================== Основные поля ====================

  @Column({ length: 500 })
  @Index()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'activity_type', type: 'varchar', length: 30 })
  @Index()
  activityType: ActivityType;

  @Column({ type: 'varchar', length: 20, default: ActivityStatus.ACTIVE })
  @Index()
  status: ActivityStatus;

  @Column({ type: 'varchar', length: 20, default: ActivityPriority.NORMAL })
  priority: ActivityPriority;

  @Column({ type: 'varchar', length: 20, nullable: true })
  @Index()
  context: ActivityContext | null;

  // ==================== Иерархия ====================

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  @Index()
  parentId: string | null;

  @TreeParent()
  @ManyToOne(() => Activity, (a) => a.children, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_id' })
  parent: Activity | null;

  @TreeChildren()
  @OneToMany(() => Activity, (a) => a.parent)
  children: Activity[];

  // ==================== Связи с Entity ====================

  /**
   * Владелец активности (обычно owner системы).
   * Для task может быть другой человек (делегирование).
   */
  @Column({ name: 'owner_entity_id', type: 'uuid' })
  @Index()
  ownerEntityId: string;

  @ManyToOne(() => EntityRecord)
  @JoinColumn({ name: 'owner_entity_id' })
  owner: EntityRecord;

  /**
   * Клиент/заказчик (для project, direction).
   * NULL для личных инициатив.
   */
  @Column({ name: 'client_entity_id', type: 'uuid', nullable: true })
  @Index()
  clientEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'client_entity_id' })
  client: EntityRecord | null;

  /**
   * Исполнитель (организация, от имени которой работаем).
   * Например: ГуглШитс.ру для клиентских проектов.
   */
  @Column({ name: 'executor_entity_id', type: 'uuid', nullable: true })
  executorEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'executor_entity_id' })
  executor: EntityRecord | null;

  // ==================== Временные рамки ====================

  /**
   * Дедлайн (для project, task, milestone).
   * NULL для ongoing активностей.
   */
  @Column({ type: 'timestamp with time zone', nullable: true })
  @Index()
  deadline: Date | null;

  /**
   * Плановая дата начала.
   */
  @Column({ name: 'start_date', type: 'timestamp with time zone', nullable: true })
  startDate: Date | null;

  /**
   * Фактическая дата начала работы.
   */
  @Column({ name: 'started_at', type: 'timestamp with time zone', nullable: true })
  startedAt: Date | null;

  /**
   * Дата завершения.
   */
  @Column({ name: 'completed_at', type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null;

  // ==================== Источник ====================

  @Column({ type: 'varchar', length: 20, default: 'manual' })
  source: 'manual' | 'extracted' | 'inferred';

  /**
   * Уверенность (для extracted/inferred).
   */
  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  /**
   * Сообщение-источник (откуда извлечено).
   */
  @Column({ name: 'source_message_id', type: 'uuid', nullable: true })
  sourceMessageId: string | null;

  /**
   * Цитата из источника.
   */
  @Column({ name: 'source_quote', type: 'text', nullable: true })
  sourceQuote: string | null;

  // ==================== Расширяемые метаданные ====================

  /**
   * Гибкие метаданные для специфичных типов.
   *
   * Примеры:
   * - learning: { platform: 'Coursera', progress: 45 }
   * - habit: { frequency: 'daily', streak: 12 }
   * - project: { budget: 100000, tags: ['integration', 'bitrix'] }
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // ==================== Связи (будут добавлены) ====================

  // @OneToMany(() => ActivityMember, (m) => m.activity)
  // members: ActivityMember[];

  // @OneToMany(() => Commitment, (c) => c.activity)
  // commitments: Commitment[];
}
```

### 2.2 Activity Members

```typescript
// packages/entities/src/activity-member.entity.ts

/**
 * Роли участников в активности.
 */
export enum ActivityMemberRole {
  OWNER = 'owner',           // Владелец, отвечает за результат
  LEAD = 'lead',             // Лидер направления/проекта
  MEMBER = 'member',         // Участник
  CONTRIBUTOR = 'contributor', // Вносит вклад, но не основной
  STAKEHOLDER = 'stakeholder', // Заинтересованное лицо
  OBSERVER = 'observer',     // Наблюдатель
}

@Entity('activity_members')
@Index(['activityId', 'entityId'], { unique: true })
export class ActivityMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'activity_id', type: 'uuid' })
  @Index()
  activityId: string;

  @ManyToOne(() => Activity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity;

  @Column({ name: 'entity_id', type: 'uuid' })
  @Index()
  entityId: string;

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;

  @Column({ type: 'varchar', length: 30 })
  role: ActivityMemberRole;

  /**
   * Зона ответственности в рамках активности.
   * Пример: "API интеграция", "Дизайн", "Тестирование"
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  responsibility: string | null;

  @Column({ name: 'joined_at', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  joinedAt: Date;

  @Column({ name: 'left_at', type: 'timestamp with time zone', nullable: true })
  leftAt: Date | null;
}
```

### 2.3 Commitment (Обязательства)

```typescript
// packages/entities/src/commitment.entity.ts

export enum CommitmentType {
  PROMISE = 'promise',       // "Я сделаю X"
  REQUEST = 'request',       // "Сделай X"
  AGREEMENT = 'agreement',   // "Договорились о X"
  DEADLINE = 'deadline',     // "X должно быть готово к Y"
  FOLLOW_UP = 'follow_up',   // "Вернуться к X через Y"
}

export enum CommitmentStatus {
  ACTIVE = 'active',
  FULFILLED = 'fulfilled',
  BROKEN = 'broken',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

@Entity('commitments')
export class Commitment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Что обещано/согласовано.
   */
  @Column({ type: 'text' })
  what: string;

  @Column({ type: 'varchar', length: 30 })
  type: CommitmentType;

  @Column({ type: 'varchar', length: 20, default: CommitmentStatus.ACTIVE })
  @Index()
  status: CommitmentStatus;

  // ==================== Участники ====================

  /**
   * Кто дал обязательство.
   */
  @Column({ name: 'from_entity_id', type: 'uuid' })
  @Index()
  fromEntityId: string;

  @ManyToOne(() => EntityRecord)
  @JoinColumn({ name: 'from_entity_id' })
  fromEntity: EntityRecord;

  /**
   * Кому дано обязательство.
   */
  @Column({ name: 'to_entity_id', type: 'uuid' })
  @Index()
  toEntityId: string;

  @ManyToOne(() => EntityRecord)
  @JoinColumn({ name: 'to_entity_id' })
  toEntity: EntityRecord;

  // ==================== Связи ====================

  /**
   * В рамках какой активности (опционально).
   */
  @Column({ name: 'activity_id', type: 'uuid', nullable: true })
  @Index()
  activityId: string | null;

  @ManyToOne(() => Activity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'activity_id' })
  activity: Activity | null;

  // ==================== Сроки ====================

  @Column({ type: 'timestamp with time zone', nullable: true })
  @Index()
  deadline: Date | null;

  @Column({ name: 'fulfilled_at', type: 'timestamp with time zone', nullable: true })
  fulfilledAt: Date | null;

  // ==================== Источник ====================

  @Column({ name: 'source_message_id', type: 'uuid', nullable: true })
  sourceMessageId: string | null;

  @Column({ name: 'source_quote', type: 'text', nullable: true })
  sourceQuote: string | null;

  @Column({ type: 'varchar', length: 20, default: 'extracted' })
  source: 'manual' | 'extracted' | 'inferred';

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

---

## Часть 3: Примеры данных

### 3.1 Твой реальный кейс

```sql
-- activities table
INSERT INTO activities (id, name, activity_type, status, parent_id, context, owner_entity_id) VALUES
-- Области жизни
('A0', 'Работа', 'area', 'ongoing', NULL, 'work', 'owner-uuid'),
('A0b', 'Семья', 'area', 'ongoing', NULL, 'family', 'owner-uuid'),

-- Бизнесы
('A1', 'ИИ-Сервисы', 'business', 'ongoing', 'A0', 'work', 'owner-uuid'),
('A2', 'ГуглШитс.ру', 'business', 'ongoing', 'A0', 'work', 'owner-uuid'),

-- Направления ГуглШитс.ру
('A3', 'Канал', 'direction', 'ongoing', 'A2', 'work', 'owner-uuid'),
('A4', 'Сайт', 'direction', 'ongoing', 'A2', 'work', 'owner-uuid'),
('A5', 'Клиентская работа', 'direction', 'ongoing', 'A2', 'work', 'owner-uuid'),

-- Проекты для клиентов
('A6', 'Автоматизация отчётов', 'project', 'active', 'A5', 'work', 'owner-uuid'),
('A7', 'Интеграция с CRM', 'project', 'planned', 'A5', 'work', 'owner-uuid'),
('A8', 'Dashboard', 'project', 'active', 'A5', 'work', 'owner-uuid'),

-- Проекты ИИ-Сервисы
('A9', 'Хаб для Битрикс24', 'project', 'active', 'A1', 'work', 'owner-uuid'),
('A10', 'Скоринг звонков', 'project', 'active', 'A1', 'work', 'owner-uuid'),

-- Задачи
('T1', 'Подготовить демо интеграции', 'task', 'active', 'A9', 'work', 'owner-uuid'),
('T2', 'Написать пост про QUERY', 'task', 'planned', 'A3', 'work', 'owner-uuid');

-- Клиенты проектов
UPDATE activities SET client_entity_id = 'client-a-uuid' WHERE id IN ('A6', 'A7');
UPDATE activities SET client_entity_id = 'client-b-uuid' WHERE id = 'A8';
UPDATE activities SET client_entity_id = 'panavto-uuid' WHERE id = 'A9';

-- Исполнитель
UPDATE activities SET executor_entity_id = 'googlesheets-ru-uuid' WHERE parent_id = 'A5';
UPDATE activities SET executor_entity_id = 'ii-services-uuid' WHERE id IN ('A9', 'A10');
```

### 3.2 Визуализация иерархии

```
Работа (area)
├── ИИ-Сервисы (business)
│   ├── Хаб для Битрикс24 (project) → клиент: Панавто
│   │   ├── Подготовить демо (task)
│   │   └── Согласовать ТЗ (task)
│   └── Скоринг звонков (project) → клиент: Ласфлор
│
└── ГуглШитс.ру (business)
    ├── Канал (direction)
    │   └── Написать пост про QUERY (task)
    ├── Сайт (direction)
    └── Клиентская работа (direction)
        ├── [Клиент А] Автоматизация (project)
        ├── [Клиент А] Интеграция CRM (project)
        └── [Клиент Б] Dashboard (project)

Семья (area)
├── Ремонт квартиры (project)
└── Отпуск в августе (initiative)
```

---

## Часть 4: Запросы и API

### 4.1 Типичные запросы

```typescript
// ActivityService

/**
 * Получить всё дерево активностей
 */
async getActivityTree(rootId?: string): Promise<Activity[]> {
  const repo = this.activityRepo.manager.getTreeRepository(Activity);
  if (rootId) {
    const root = await repo.findOne({ where: { id: rootId } });
    return repo.findDescendantsTree(root);
  }
  return repo.findTrees();
}

/**
 * Получить активные проекты с дедлайнами
 */
async getActiveProjectsWithDeadlines(): Promise<Activity[]> {
  return this.activityRepo.find({
    where: {
      activityType: In([ActivityType.PROJECT, ActivityType.TASK]),
      status: In([ActivityStatus.ACTIVE, ActivityStatus.PLANNED]),
      deadline: Not(IsNull()),
    },
    order: { deadline: 'ASC' },
    relations: ['client', 'parent'],
  });
}

/**
 * Получить всё по контексту (work/personal)
 */
async getByContext(context: ActivityContext): Promise<Activity[]> {
  return this.activityRepo.find({
    where: { context, status: Not(ActivityStatus.ARCHIVED) },
    relations: ['children'],
  });
}

/**
 * Получить проекты с клиентом
 */
async getProjectsByClient(clientEntityId: string): Promise<Activity[]> {
  return this.activityRepo.find({
    where: {
      clientEntityId,
      activityType: ActivityType.PROJECT,
      status: Not(In([ActivityStatus.COMPLETED, ActivityStatus.CANCELLED, ActivityStatus.ARCHIVED])),
    },
  });
}

/**
 * Найти активность по упоминанию (для inference)
 */
async findByMention(mention: string): Promise<Activity | null> {
  // Fuzzy search по имени
  return this.activityRepo
    .createQueryBuilder('a')
    .where('a.name ILIKE :pattern', { pattern: `%${mention}%` })
    .andWhere('a.status NOT IN (:...statuses)', {
      statuses: [ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED],
    })
    .getOne();
}
```

### 4.2 Tools для Claude Agent

```typescript
// ActivityToolsProvider

const activityTools = [
  tool(
    'list_activities',
    'List activities with filters. Use to find projects, tasks, directions.',
    {
      type: z.enum(['all', 'area', 'business', 'direction', 'project', 'task'])
        .optional()
        .describe('Filter by activity type'),
      context: z.enum(['work', 'personal', 'family'])
        .optional()
        .describe('Filter by life context'),
      status: z.enum(['active', 'planned', 'completed', 'all'])
        .optional()
        .default('active')
        .describe('Filter by status'),
      parentId: z.string().uuid().optional()
        .describe('Get children of specific activity'),
      clientId: z.string().uuid().optional()
        .describe('Filter by client entity'),
    },
    async (args) => {
      const activities = await this.activityService.list(args);
      return toolSuccess(activities);
    }
  ),

  tool(
    'get_activity_tree',
    'Get full hierarchy tree of an activity with all descendants',
    {
      activityId: z.string().uuid().describe('Root activity ID'),
    },
    async (args) => {
      const tree = await this.activityService.getActivityTree(args.activityId);
      return toolSuccess(tree);
    }
  ),

  tool(
    'create_activity',
    'Create new activity (project, task, etc). Requires user confirmation.',
    {
      name: z.string().describe('Activity name'),
      type: z.enum(['project', 'task', 'initiative', 'direction'])
        .describe('Activity type'),
      parentId: z.string().uuid().optional()
        .describe('Parent activity ID'),
      clientId: z.string().uuid().optional()
        .describe('Client entity ID for client projects'),
      deadline: z.string().optional()
        .describe('Deadline in ISO format'),
      context: z.enum(['work', 'personal', 'family']).optional()
        .describe('Life context'),
    },
    async (args) => {
      // Создаёт pending_confirmation, не сразу activity
      const pending = await this.confirmationService.createActivityConfirmation(args);
      return toolSuccess({
        message: 'Activity creation requires confirmation',
        confirmationId: pending.id,
        preview: args,
      });
    }
  ),

  tool(
    'update_activity_status',
    'Update activity status (complete, cancel, pause)',
    {
      activityId: z.string().uuid().describe('Activity ID'),
      status: z.enum(['active', 'completed', 'cancelled', 'on_hold'])
        .describe('New status'),
    },
    async (args) => {
      await this.activityService.updateStatus(args.activityId, args.status);
      return toolSuccess({ message: 'Status updated' });
    }
  ),

  tool(
    'get_deadlines',
    'Get upcoming deadlines for projects and tasks',
    {
      days: z.number().int().min(1).max(90).default(7)
        .describe('Number of days to look ahead'),
      context: z.enum(['work', 'personal', 'all']).optional()
        .describe('Filter by context'),
    },
    async (args) => {
      const deadlines = await this.activityService.getUpcomingDeadlines(args.days, args.context);
      return toolSuccess(deadlines);
    }
  ),
];
```

---

## Часть 5: Reasoning Engine

### 5.1 Inference Rules

```typescript
// InferenceService

interface InferenceRule {
  id: string;
  name: string;
  trigger: InferenceTrigger;
  conditions: InferenceCondition[];
  actions: InferenceAction[];
  confidence: number;
}

// Правило 1: Обнаружение проекта из переписки
const projectInferenceRule: InferenceRule = {
  id: 'infer-project-from-conversation',
  name: 'Detect project from conversation patterns',
  trigger: {
    type: 'message_pattern',
    patterns: [
      'работаем над',
      'проект по',
      'нужно сделать для',
      'заказ от',
      'клиент просит',
    ],
  },
  conditions: [
    { type: 'mentions_multiple_people', minCount: 2 },
    { type: 'mentions_deliverable_or_deadline' },
    { type: 'no_existing_activity_matches' },
  ],
  actions: [
    {
      type: 'suggest_activity_creation',
      activityType: 'project',
      extractFields: ['name', 'client', 'participants', 'deadline'],
    },
  ],
  confidence: 0.7,
};

// Правило 2: Определение контекста
const contextInferenceRule: InferenceRule = {
  id: 'infer-context',
  name: 'Determine work/personal context',
  trigger: { type: 'new_interaction' },
  conditions: [],
  actions: [
    {
      type: 'set_context',
      logic: `
        IF entity.organizationId === owner.organizationId THEN 'work'
        ELSE IF entity has CLIENT_VENDOR with owner.org THEN 'work'
        ELSE IF entity has FAMILY relation THEN 'family'
        ELSE IF entity has FRIENDSHIP relation THEN 'personal'
        ELSE NULL
      `,
    },
  ],
  confidence: 0.9,
};

// Правило 3: Извлечение задачи
const taskExtractionRule: InferenceRule = {
  id: 'extract-task-from-message',
  name: 'Extract task from message',
  trigger: {
    type: 'message_pattern',
    patterns: [
      'нужно ',
      'надо ',
      'сделай ',
      'подготовь ',
      'напиши ',
      'отправь ',
    ],
  },
  conditions: [
    { type: 'is_actionable' },
    { type: 'has_clear_deliverable' },
  ],
  actions: [
    {
      type: 'suggest_activity_creation',
      activityType: 'task',
      extractFields: ['name', 'deadline', 'assignee'],
      linkToParent: 'infer_from_context', // Попытаться найти родительский project
    },
  ],
  confidence: 0.6,
};
```

### 5.2 Daily Synthesis → Structured Extraction

```typescript
// DailySynthesisExtractionService

interface DailySynthesisOutput {
  // Обнаруженные проекты (новые или упомянутые)
  projects: {
    name: string;
    isNew: boolean;
    existingActivityId?: string;
    participants: string[];
    client?: string;
    status?: string;
  }[];

  // Извлечённые задачи
  tasks: {
    title: string;
    projectName?: string;
    deadline?: string;
    assignee?: 'self' | string;
    status: 'pending' | 'done';
  }[];

  // Обязательства
  commitments: {
    what: string;
    from: string;
    to: string;
    deadline?: string;
    type: CommitmentType;
  }[];

  // Инференс связей
  inferredRelations: {
    type: 'project_member' | 'works_on' | 'client_of';
    entities: string[];
    confidence: number;
  }[];
}

async extractFromDailySynthesis(dailyText: string): Promise<DailySynthesisOutput> {
  const result = await this.claudeAgent.call({
    mode: 'oneshot',
    prompt: `
Проанализируй daily-отчёт и извлеки структурированные данные.

DAILY ОТЧЁТ:
${dailyText}

Извлеки:
1. ПРОЕКТЫ — упомянутые инициативы, над которыми ведётся работа
2. ЗАДАЧИ — конкретные действия (выполненные и планируемые)
3. ОБЯЗАТЕЛЬСТВА — кто кому что обещал
4. СВЯЗИ — кто с кем работает над чем

Для каждого элемента укажи confidence (0-1).
`,
    outputFormat: {
      type: 'json_schema',
      schema: DAILY_EXTRACTION_SCHEMA,
      strict: true,
    },
  });

  return result.data as DailySynthesisOutput;
}
```

---

## Часть 6: Trigger System

### 6.1 Trigger Types

```typescript
export enum TriggerType {
  // Time-based
  SCHEDULED = 'scheduled',
  DEADLINE_APPROACHING = 'deadline_approaching',
  DEADLINE_PASSED = 'deadline_passed',
  PERIODIC = 'periodic', // Для habits

  // Event-based
  INCOMING_CALL = 'incoming_call',
  INCOMING_MESSAGE = 'incoming_message',
  ACTIVITY_STATUS_CHANGED = 'activity_status_changed',

  // Context-based
  MEETING_STARTING = 'meeting_starting',
  WORKING_HOURS_START = 'working_hours_start',
  WORKING_HOURS_END = 'working_hours_end',

  // Anomaly-based
  COMMITMENT_OVERDUE = 'commitment_overdue',
  UNUSUAL_SILENCE = 'unusual_silence',
  BLOCKED_TOO_LONG = 'blocked_too_long',
}
```

### 6.2 Example Triggers

```typescript
// Триггер: приближается дедлайн
{
  type: TriggerType.DEADLINE_APPROACHING,
  conditions: {
    daysUntil: [3, 1, 0], // За 3 дня, за 1 день, в день
    activityTypes: ['project', 'task'],
    statuses: ['active', 'planned'],
  },
  actions: [{
    type: 'notify',
    template: 'deadline_reminder',
    channel: 'telegram',
    data: {
      includeBlockers: true,
      suggestActions: ['complete', 'extend', 'delegate'],
    },
  }],
}

// Триггер: входящий звонок — показать контекст
{
  type: TriggerType.INCOMING_CALL,
  conditions: {
    entityHasActivities: true, // Есть общие проекты/задачи
  },
  actions: [{
    type: 'notify',
    template: 'call_context',
    channel: 'telegram',
    priority: 'high',
    data: {
      includeOpenCommitments: true,
      includeRecentTopics: true,
      includeSharedActivities: true,
    },
  }],
}

// Триггер: обязательство просрочено
{
  type: TriggerType.COMMITMENT_OVERDUE,
  conditions: {
    daysOverdue: 1,
    commitmentTypes: ['promise', 'deadline'],
  },
  actions: [{
    type: 'notify',
    template: 'commitment_overdue',
    data: {
      suggestActions: ['remind_them', 'mark_cancelled', 'extend'],
    },
  }],
}
```

---

## Часть 7: Action Engine

### 7.1 Action Types

```typescript
export enum ActionType {
  // Communication
  DRAFT_MESSAGE = 'draft_message',
  SEND_MESSAGE = 'send_message',
  SCHEDULE_MESSAGE = 'schedule_message',

  // Activity Management
  CREATE_ACTIVITY = 'create_activity',
  UPDATE_ACTIVITY = 'update_activity',
  COMPLETE_ACTIVITY = 'complete_activity',
  DELEGATE_ACTIVITY = 'delegate_activity',

  // Commitment Management
  CREATE_COMMITMENT = 'create_commitment',
  FULFILL_COMMITMENT = 'fulfill_commitment',
  REMIND_COMMITMENT = 'remind_commitment',

  // Knowledge Management
  CREATE_FACT = 'create_fact',
  LINK_ENTITIES = 'link_entities',
  ADD_ACTIVITY_MEMBER = 'add_activity_member',

  // External
  SEARCH_WEB = 'search_web',
  FETCH_DOCS = 'fetch_docs',
}

// Уровни автономности
export enum ActionAutonomy {
  AUTO = 'auto',           // Выполняется без подтверждения
  CONFIRM = 'confirm',     // Требует подтверждения
  SUGGEST = 'suggest',     // Только предлагается
  FORBIDDEN = 'forbidden', // Запрещено системой
}

// Конфигурация автономности по типам
const ACTION_AUTONOMY: Record<ActionType, ActionAutonomy> = {
  // Auto — безопасные действия
  [ActionType.CREATE_FACT]: ActionAutonomy.AUTO, // Если confidence > 0.9
  [ActionType.SEARCH_WEB]: ActionAutonomy.AUTO,

  // Confirm — требуют подтверждения
  [ActionType.SEND_MESSAGE]: ActionAutonomy.CONFIRM,
  [ActionType.CREATE_ACTIVITY]: ActionAutonomy.CONFIRM,
  [ActionType.COMPLETE_ACTIVITY]: ActionAutonomy.CONFIRM,
  [ActionType.DELEGATE_ACTIVITY]: ActionAutonomy.CONFIRM,

  // Suggest — только предложения
  [ActionType.DRAFT_MESSAGE]: ActionAutonomy.SUGGEST,
  [ActionType.REMIND_COMMITMENT]: ActionAutonomy.SUGGEST,
};
```

### 7.2 Approval Flow in Telegram

```typescript
// Пример: система предлагает создать проект

async suggestProjectCreation(inference: ProjectInference): Promise<void> {
  const message = `
🔍 **Обнаружен возможный проект**

**${inference.name}**
${inference.client ? `Клиент: ${inference.client}` : ''}
${inference.participants.length ? `Участники: ${inference.participants.join(', ')}` : ''}
${inference.deadline ? `Дедлайн: ${formatDate(inference.deadline)}` : ''}

_Уверенность: ${Math.round(inference.confidence * 100)}%_
_Источник: переписка с ${inference.sourceEntity}_
`;

  await this.telegram.sendMessage(ownerId, message, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Создать', callback_data: `act_create_${inference.id}` },
          { text: '✏️ Изменить', callback_data: `act_edit_${inference.id}` },
        ],
        [
          { text: '❌ Не проект', callback_data: `act_reject_${inference.id}` },
          { text: '🔇 Игнор', callback_data: `act_ignore_${inference.id}` },
        ],
      ],
    },
  });
}
```

---

## Часть 8: External Knowledge

### 8.1 Integration Architecture

```typescript
// ExternalKnowledgeService

async augmentAnswer(
  question: string,
  internalContext: InternalContext,
): Promise<AugmentedAnswer> {
  // 1. Определить, нужны ли внешние знания
  const needsExternal = await this.assessExternalNeed(question, internalContext);

  if (!needsExternal) {
    return { answer: internalContext.synthesis, sources: internalContext.sources };
  }

  // 2. Сформировать поисковые запросы
  const queries = await this.generateSearchQueries(question, internalContext);

  // 3. Получить внешние данные
  const externalData = await Promise.all([
    this.webSearch(queries.general),
    this.fetchDocs(queries.documentation),
    this.findExamples(queries.examples),
  ]);

  // 4. Синтезировать ответ
  return this.synthesizeAnswer(question, internalContext, externalData);
}
```

### 8.2 Example: Question about Bitrix24 Integration

```
User: "Как лучше сделать интеграцию с Битрикс24?"

Internal Context:
- Project "Хаб для Битрикс24" exists
- Participants: Маша, Александра, Сергей (Панавто)
- Recent discussions about REST API

External Augmentation:
- Bitrix24 REST API documentation
- Best practices from community
- Rate limits, authentication methods

Synthesized Answer:
"Для проекта 'Хаб для Битрикс24' (клиент: Панавто) рекомендую:

**Из вашего контекста:**
- Маша уже работала с методом crm.lead.add
- Сергей просил синхронизацию в реальном времени

**Из документации Bitrix24:**
- REST API rate limit: 2 req/sec
- Используй batch методы для массовых операций
- OAuth 2.0 для авторизации (не webhook secret)

**Best practices:**
- Храни access_token в secure storage
- Используй webhooks для событий, не polling
- Для больших объёмов — batch + queue

Хочешь, подготовлю план интеграции?"
```

---

## Часть 9: Implementation Roadmap

### Phase 1: Activity Foundation (2 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| 1.1 | Activity entity + migration | P0 |
| 1.2 | ActivityMember entity | P0 |
| 1.3 | ActivityService CRUD | P0 |
| 1.4 | ActivityToolsProvider | P0 |
| 1.5 | Commitment entity | P1 |
| 1.6 | Seed initial areas/businesses | P1 |

### Phase 2: Daily → Structure (2 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| 2.1 | DailySynthesisExtractionService | P0 |
| 2.2 | Project inference from daily | P0 |
| 2.3 | Task extraction from daily | P0 |
| 2.4 | Commitment extraction | P1 |
| 2.5 | Confirmation UX в Telegram | P0 |

### Phase 3: Context & Reasoning (2-3 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| 3.1 | Context inference (work/personal) | P0 |
| 3.2 | Activity linking to messages | P0 |
| 3.3 | InferenceService framework | P1 |
| 3.4 | /daily с фильтром по activity | P0 |

### Phase 4: Triggers (2 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| 4.1 | Trigger entity + scheduler | P0 |
| 4.2 | Deadline triggers | P0 |
| 4.3 | Commitment overdue triggers | P1 |
| 4.4 | Incoming call context | P2 |

### Phase 5: Actions (2 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| 5.1 | Action framework | P0 |
| 5.2 | Approval flow UI | P0 |
| 5.3 | Draft message action | P1 |
| 5.4 | Activity management actions | P1 |

### Phase 6: External Knowledge (1-2 недели)

| # | Задача | Приоритет |
|---|--------|-----------|
| 6.1 | WebSearch tool integration | P1 |
| 6.2 | Answer augmentation | P1 |
| 6.3 | Documentation fetching | P2 |

---

## Часть 10: Миграция существующих данных

### 10.1 Mapping ExtractedEvent → Activity/Commitment

```typescript
// ExtractedEvent.TASK → Activity (type=task)
// ExtractedEvent.PROMISE_BY_ME → Commitment (type=promise, from=owner)
// ExtractedEvent.PROMISE_BY_THEM → Commitment (type=promise, from=entity)
// ExtractedEvent.MEETING → EntityEvent (без изменений)
// ExtractedEvent.FACT → EntityFact (без изменений)
```

### 10.2 Сохранение обратной совместимости

- EntityEvent остаётся для calendar events
- EntityFact остаётся для атрибутов
- Activity — новый слой для "дел"
- Commitment — новый слой для обязательств

---

## Следующий шаг

**Рекомендация:** Начать с Phase 1.1 — создание Activity entity и миграции.

```bash
git checkout -b feat/activity-foundation
```

Создать:
1. `packages/entities/src/activity.entity.ts`
2. `packages/entities/src/activity-member.entity.ts`
3. Migration script
4. Basic ActivityService

Готов начать?
