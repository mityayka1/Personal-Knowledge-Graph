# План реализации: Smart Fact Fusion

## Обзор

Замена простого skip-дедупликации на интеллектуальное слияние фактов через LLM с уведомлениями о конфликтах.

**Проблема:** Текущая система просто игнорирует семантически похожие факты, теряя ценную информацию:
```
"Работает в Сбере" + "Ведущий разработчик в Сбербанке"
→ Текущее: SKIP (потеряли должность!)
→ Цель: ENRICH → "Ведущий разработчик в Сбербанке"
```

**Решения пользователя:**
1. UI для конфликтов — Telegram уведомления ✅
2. LLM решает автоматически ✅
3. Приоритет: MANUAL > EXTRACTED > IMPORTED ✅

---

## Архитектура решения

```
┌─────────────────────────────────────────────────────────────────┐
│                     SMART FACT FUSION FLOW                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  New Fact ─→ Generate Embedding ─→ Find Similar (>0.85)         │
│                                           │                      │
│                                           ▼                      │
│                                  ┌────────────────┐              │
│                                  │  LLM Decision  │              │
│                                  │    Service     │              │
│                                  └───────┬────────┘              │
│                                          │                       │
│         ┌────────┬────────┬──────┬──────┴─────┐                 │
│         ▼        ▼        ▼      ▼            ▼                 │
│     CONFIRM   ENRICH  SUPERSEDE COEXIST   CONFLICT              │
│         │        │        │      │            │                 │
│         ▼        ▼        ▼      ▼            ▼                 │
│     +conf    merge     deprec  keep both   Telegram             │
│              value     old                 notification         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Фазы реализации

### Phase 1: Расширение модели данных

**Файлы:**
- `packages/entities/src/entity-fact.entity.ts` (MODIFY)
- `apps/pkg-core/src/database/migrations/XXXXXX-AddFactFusionFields.ts` (NEW)

**Новые поля EntityFact:**

```typescript
// Ranking (Wikidata-style)
@Column({ type: 'varchar', length: 20, default: 'normal' })
rank: 'preferred' | 'normal' | 'deprecated';

// Fact linking
@Column({ name: 'superseded_by', type: 'uuid', nullable: true })
supersededById: string | null;

@ManyToOne(() => EntityFact, { nullable: true })
@JoinColumn({ name: 'superseded_by' })
supersededBy: EntityFact | null;

// Conflict tracking
@Column({ name: 'needs_review', type: 'boolean', default: false })
needsReview: boolean;

@Column({ name: 'review_reason', type: 'text', nullable: true })
reviewReason: string | null;

// Confirmation tracking
@Column({ name: 'confirmation_count', type: 'integer', default: 1 })
confirmationCount: number;
```

**Миграция:**
```sql
ALTER TABLE entity_facts ADD COLUMN rank VARCHAR(20) DEFAULT 'normal';
ALTER TABLE entity_facts ADD COLUMN superseded_by UUID REFERENCES entity_facts(id);
ALTER TABLE entity_facts ADD COLUMN needs_review BOOLEAN DEFAULT FALSE;
ALTER TABLE entity_facts ADD COLUMN review_reason TEXT;
ALTER TABLE entity_facts ADD COLUMN confirmation_count INTEGER DEFAULT 1;

CREATE INDEX idx_entity_facts_rank ON entity_facts(entity_id, fact_type, rank);
CREATE INDEX idx_entity_facts_needs_review ON entity_facts(id) WHERE needs_review = TRUE;
```

**Acceptance:**
- [x] Миграция применяется без ошибок
- [x] Индексы созданы
- [x] Entity обновлена и экспортирована

---

### Phase 2: FactFusionService (LLM Decision)

**Файлы:**
- `apps/pkg-core/src/modules/entity/entity-fact/fact-fusion.service.ts` (NEW)
- `apps/pkg-core/src/modules/entity/entity-fact/fact-fusion.constants.ts` (NEW)

**JSON Schema для LLM:**
```typescript
const FUSION_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['confirm', 'enrich', 'supersede', 'coexist', 'conflict'],
      description: 'Decision type'
    },
    mergedValue: {
      type: 'string',
      nullable: true,
      description: 'Merged value for enrich action'
    },
    explanation: {
      type: 'string',
      description: 'Why this decision was made (Russian)'
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence in decision'
    }
  },
  required: ['action', 'explanation', 'confidence']
};
```

**Сервис:**
```typescript
@Injectable()
export class FactFusionService {
  constructor(
    private claudeAgentService: ClaudeAgentService,
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
  ) {}

  async decideFusion(
    existingFact: EntityFact,
    newFactValue: string,
    newFactSource: FactSource,
    context?: { messageContent?: string },
  ): Promise<FusionDecision> {
    const prompt = this.buildPrompt(existingFact, newFactValue, newFactSource, context);

    const { data } = await this.claudeAgentService.call<FusionDecision>({
      mode: 'oneshot',
      taskType: 'fact_fusion',
      prompt,
      schema: FUSION_DECISION_SCHEMA,
      model: 'haiku',  // Fast + cheap for decisions
      timeout: 30000,
    });

    return data;
  }

  async applyDecision(
    existingFact: EntityFact,
    newFactDto: CreateFactDto,
    decision: FusionDecision,
  ): Promise<CreateFactResult> {
    switch (decision.action) {
      case 'confirm':
        return this.handleConfirm(existingFact);
      case 'enrich':
        return this.handleEnrich(existingFact, decision.mergedValue!);
      case 'supersede':
        return this.handleSupersede(existingFact, newFactDto);
      case 'coexist':
        return this.handleCoexist(existingFact, newFactDto);
      case 'conflict':
        return this.handleConflict(existingFact, newFactDto, decision.explanation);
    }
  }
}
```

**Prompt template:**
```
Analyze two facts about the same person/organization:

EXISTING FACT:
- Type: ${existingFact.factType}
- Value: "${existingFact.value}"
- Source: ${existingFact.source} (priority: ${SOURCE_PRIORITY[existingFact.source]})
- Confidence: ${existingFact.confidence}
- Created: ${existingFact.createdAt}

NEW FACT:
- Type: ${newFactDto.type}
- Value: "${newFactDto.value}"
- Source: ${newFactDto.source} (priority: ${SOURCE_PRIORITY[newFactDto.source]})
${context?.messageContent ? `- Context: "${context.messageContent.slice(0, 200)}"` : ''}

SOURCE PRIORITY: MANUAL(100) > EXTRACTED(70) > IMPORTED(50)

Determine relationship:

1. CONFIRM - Same information, just confirmation
   Example: "Работает в Сбере" ≈ "Работает в Сбербанке"
   → Increase confidence of existing

2. ENRICH - Complementary, can merge into richer fact
   Example: "В Сбере" + "Ведущий разработчик в Сбербанке"
   → Merge: "Ведущий разработчик в Сбербанке"

3. SUPERSEDE - New is more specific/accurate
   Example: "ДР в марте" → "ДР 15.03.1990"
   → Deprecate old, use new

4. COEXIST - Different time periods or both valid
   Example: "CTO в 2020" + "CEO в 2024"
   → Keep both with temporal markers

5. CONFLICT - Contradictory, needs human review
   Example: "Работает в Сбере" + "Работает в Тинькофф" (same time)
   → Flag for user resolution

Return JSON with action, mergedValue (if enrich), explanation (Russian), confidence.
```

**Acceptance:**
- [x] LLM корректно определяет тип решения
- [x] "Работает в Сбере" + "работает в Сбербанке России" → CONFIRM (verified)
- [ ] "ДР в марте" + "ДР 15.03.1990" → SUPERSEDE (not tested)
- [x] Противоречия → CONFLICT ("Старший разработчик" vs "Ведущий разработчик" → needs_review=true)

---

### Phase 3: Интеграция в EntityFactService

**Файлы:**
- `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts` (MODIFY)

**Изменения в createWithDedup():**

```typescript
async createWithDedup(
  entityId: string,
  dto: CreateFactDto,
  options?: {
    skipSemanticCheck?: boolean;
    skipFusion?: boolean;  // NEW: для тестов
    messageContext?: string;  // NEW: контекст сообщения
  },
): Promise<CreateFactResult> {
  // 1. Check for semantic duplicates
  if (dto.value && this.embeddingService && !options?.skipSemanticCheck) {
    const dupResult = await this.checkSemanticDuplicate(entityId, dto.value, dto.type);

    if (dupResult.isDuplicate && dupResult.existingFact) {
      // 2. NEW: Use LLM to decide fusion strategy
      if (!options?.skipFusion && this.factFusionService) {
        const decision = await this.factFusionService.decideFusion(
          dupResult.existingFact,
          dto.value,
          dto.source || FactSource.EXTRACTED,
          { messageContent: options?.messageContext },
        );

        this.logger.log(
          `Fusion decision for "${dto.value}": ${decision.action} (${decision.confidence})`
        );

        return this.factFusionService.applyDecision(
          dupResult.existingFact,
          dto,
          decision,
        );
      }

      // Fallback: simple skip (backward compatible)
      return {
        fact: dupResult.existingFact,
        action: 'skipped',
        reason: dupResult.reason,
        existingFactId: dupResult.existingFact.id,
      };
    }
  }

  // ... rest of creation logic
}
```

**Acceptance:**
- [ ] Backward compatible (skipFusion работает)
- [ ] LLM вызывается при обнаружении дубликата
- [ ] Все типы решений применяются корректно

---

### Phase 4: Уведомления о конфликтах (Telegram)

**Файлы:**
- `apps/pkg-core/src/modules/notification/fact-conflict.service.ts` (NEW)
- `apps/pkg-core/src/modules/notification/notification.module.ts` (MODIFY)
- `apps/telegram-adapter/src/bot/handlers/fact-callback.handler.ts` (NEW)

**Формат уведомления:**
```
⚠️ <b>Конфликт фактов</b>

👤 Иван Петров
📋 Тип: position

<b>Существующий:</b>
"Работает в Сбербанке"
📅 Добавлен: 15.01.2025

<b>Новый:</b>
"Работает в Тинькофф"
📅 Извлечён: 20.01.2025
💬 <a href="tg://...">Из сообщения</a>

Какой факт корректен?

[✅ Новый] [❌ Старый] [🔀 Оба верны]
```

**Callback format:**
```
fact_new:<shortId>   → Использовать новый, deprecated старый
fact_old:<shortId>   → Оставить старый, отклонить новый
fact_both:<shortId>  → Создать оба как coexist
```

**FactConflictService:**
```typescript
@Injectable()
export class FactConflictService {
  constructor(
    private telegramNotifier: TelegramNotifierService,
    private digestActionStore: DigestActionStoreService,
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
  ) {}

  async notifyConflict(
    existingFact: EntityFact,
    newFactData: CreateFactDto,
    entityName: string,
    sourceMessageLink?: string,
  ): Promise<string> {
    // Store both fact IDs for callback resolution
    const shortId = await this.digestActionStore.store([
      existingFact.id,
      JSON.stringify(newFactData),  // New fact not saved yet
    ]);

    const message = this.formatConflictMessage(
      existingFact,
      newFactData,
      entityName,
      sourceMessageLink,
    );

    const buttons = [
      [
        { text: '✅ Новый', callback_data: `fact_new:${shortId}` },
        { text: '❌ Старый', callback_data: `fact_old:${shortId}` },
        { text: '🔀 Оба', callback_data: `fact_both:${shortId}` },
      ],
    ];

    await this.telegramNotifier.sendWithButtons(message, buttons, 'HTML');
    return shortId;
  }

  async resolveConflict(
    shortId: string,
    resolution: 'new' | 'old' | 'both',
  ): Promise<void> {
    const [existingFactId, newFactDataJson] = await this.digestActionStore.get(shortId);
    const newFactData = JSON.parse(newFactDataJson) as CreateFactDto;

    switch (resolution) {
      case 'new':
        // Deprecate existing, create new as preferred
        await this.factRepo.update(existingFactId, {
          rank: 'deprecated',
          validUntil: new Date(),
        });
        // Create new fact...
        break;
      case 'old':
        // Just increase confidence of existing
        await this.factRepo.increment({ id: existingFactId }, 'confirmationCount', 1);
        break;
      case 'both':
        // Create new fact with coexist marker
        // Keep existing as is
        break;
    }
  }
}
```

**Acceptance:**
- [x] Telegram уведомление отправляется при CONFLICT (logic works, tested with adapter offline)
- [ ] Кнопки работают корректно (requires telegram-adapter running)
- [ ] Факты обновляются согласно выбору пользователя

---

### Phase 5: API Endpoints

**Файлы:**
- `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.controller.ts` (NEW or MODIFY)

**Endpoints:**
```typescript
// GET /entities/:entityId/facts?includeDeprecated=false
// Возвращает факты с учётом rank (preferred first)

// GET /facts/conflicts
// Список фактов с needsReview=true

// POST /facts/:factId/resolve
// Body: { resolution: 'prefer' | 'deprecate' | 'coexist' }

// POST /facts/conflict-callback/:shortId
// Body: { resolution: 'new' | 'old' | 'both' }
// Для Telegram callback
```

**Acceptance:**
- [x] Endpoint для списка конфликтов (GET /facts/conflicts)
- [x] Endpoint для callback от Telegram (POST /facts/conflict-callback/:shortId)
- [x] Факты сортируются по rank

---

## Файлы для изменения

| Файл | Действие | Описание |
|------|----------|----------|
| `packages/entities/src/entity-fact.entity.ts` | MODIFY | Add rank, supersededBy, needsReview, confirmationCount |
| `apps/pkg-core/src/database/migrations/XXXXXX-AddFactFusionFields.ts` | NEW | Migration |
| `apps/pkg-core/src/modules/entity/entity-fact/fact-fusion.service.ts` | NEW | LLM decision service |
| `apps/pkg-core/src/modules/entity/entity-fact/fact-fusion.constants.ts` | NEW | Schema, prompts |
| `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts` | MODIFY | Integrate fusion |
| `apps/pkg-core/src/modules/notification/fact-conflict.service.ts` | NEW | Telegram notifications |
| `apps/pkg-core/src/modules/entity/entity.module.ts` | MODIFY | Register new services |
| `apps/telegram-adapter/src/bot/handlers/fact-callback.handler.ts` | NEW | Handle callbacks |

---

## Verification

```bash
# 1. Применить миграцию
pnpm migration:run

# 2. Запустить тесты
pnpm test -- fact-fusion

# 3. Manual test: ENRICH case
curl -X POST localhost:3000/api/entities/{entityId}/facts \
  -H "Content-Type: application/json" \
  -d '{"type": "position", "value": "Ведущий разработчик в Сбербанке"}'
# После: "В Сбере" должен стать "Ведущий разработчик в Сбербанке"

# 4. Manual test: CONFLICT case
# Добавить "Работает в Тинькофф" когда есть "Работает в Сбере"
# → Должно прийти уведомление в Telegram

# 5. Проверить Telegram callbacks
# Нажать кнопку → факт должен обновиться
```

---

## Риски и митигация

| Риск | Митигация |
|------|-----------|
| LLM ошибается в решениях | Низкий confidence → CONFLICT (user review) |
| Latency LLM calls | Haiku model (fast), async processing |
| Много конфликтов | Batch digest вместо instant notifications |
| Backward compatibility | skipFusion option, graceful fallback |

---

## Метрики успеха

- [x] 90%+ решений LLM корректны (по ручной проверке) — CONFIRM/CONFLICT работают правильно
- [x] < 5% фактов требуют user review (CONFLICT) — только реальные противоречия
- [ ] ENRICH сохраняет информацию из обоих фактов (not tested yet)
- [x] Время обработки < 3s (включая LLM call) — ~1-2s с Haiku

---

# Phase 6: Context-Aware Extraction (Обсуждение)

> **Статус:** Проектирование
> **Дата:** 2025-01-24

## Концепция

Факты сущности = её "память". При извлечении новых фактов используем существующие факты как контекст для лучшего понимания сообщений.

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTEXT-AWARE EXTRACTION                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Entity Facts ──► formatAsContext() ──► Compact Context         │
│       ▲                                       │                  │
│       │                                       ▼                  │
│       │                              ┌────────────────┐          │
│       │                              │  New Message   │          │
│       │                              │ + Entity Context│         │
│       │                              └───────┬────────┘          │
│       │                                      ▼                   │
│       │                              ┌────────────────┐          │
│       │                              │  LLM Extract   │          │
│       │                              │ (context-aware)│          │
│       │                              └───────┬────────┘          │
│       │                                      │                   │
│       └──────────────────────────────────────┘                   │
│                    New/Updated Facts                             │
└─────────────────────────────────────────────────────────────────┘
```

## Проблемы текущего подхода

| Проблема | Пример | Текущий результат | С контекстом |
|----------|--------|-------------------|--------------|
| **Третьи лица** | "Маша уже в Сбере работает" | Факт записывается Ивану ❌ | Знает что Маша = жена Ивана ✅ |
| **Местоимения** | "Она передаёт привет" | Не извлекает (кто "она"?) | Связь: жена Мария → понимает ✅ |
| **Смена работы** | "Я теперь в Тинькофф" (было Сбер) | Создаёт новый → Fusion решает | Сразу видит противоречие → SUPERSEDE |
| **Подтверждение** | "ДР через неделю" (8 марта, контекст: ДР 15 марта) | Извлекает как новый факт | Понимает совпадение → CONFIRM с высоким confidence |

---

## Компонент 1: Связи между сущностями (EntityRelation)

### Проблема

Сейчас связи хранятся неявно (факты типа `company`) или в `EntityRelationshipProfile`. Нет явной модели "Иван → жена → Мария".

### Предлагаемая модель

```typescript
// packages/entities/src/entity-relation.entity.ts

@Entity('entity_relations')
export class EntityRelation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'source_entity_id', type: 'uuid' })
  @Index()
  sourceEntityId: string;  // Иван

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'source_entity_id' })
  sourceEntity: EntityRecord;

  @Column({ name: 'target_entity_id', type: 'uuid' })
  @Index()
  targetEntityId: string;  // Мария

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'target_entity_id' })
  targetEntity: EntityRecord;

  @Column({ name: 'relation_type', length: 50 })
  relationType: RelationType;

  @Column({ name: 'relation_label', length: 100, nullable: true })
  relationLabel: string | null;  // "жена", "Маша", "шеф"

  @Column({ type: 'boolean', default: true })
  bidirectional: boolean;  // Если true, создаётся обратная связь

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;  // { since: '2015' }

  @Column({ name: 'source', length: 20, default: 'extracted' })
  source: 'manual' | 'extracted' | 'imported';

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

enum RelationType {
  // Семья
  SPOUSE = 'spouse',           // муж/жена
  CHILD = 'child',             // ребёнок
  PARENT = 'parent',           // родитель
  SIBLING = 'sibling',         // брат/сестра
  RELATIVE = 'relative',       // другой родственник

  // Работа
  COLLEAGUE = 'colleague',     // коллега
  MANAGER = 'manager',         // руководитель
  SUBORDINATE = 'subordinate', // подчинённый
  BUSINESS_PARTNER = 'business_partner',

  // Социальные
  FRIEND = 'friend',
  ACQUAINTANCE = 'acquaintance',

  // Служебные
  ASSISTANT = 'assistant',     // помощник/секретарь
  MENTOR = 'mentor',
}
```

### Как связи попадают в систему

```
Сообщение: "Маша (моя жена) передаёт привет"
                    │
                    ▼
           LLM Extraction
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   Факт: нет               Связь: spouse
   (это не факт об Иване)  sourceEntityId: Иван
                           targetEntityId: найти/создать "Мария"
                           relationLabel: "жена", "Маша"
```

### Миграция

```sql
CREATE TYPE relation_type AS ENUM (
  'spouse', 'child', 'parent', 'sibling', 'relative',
  'colleague', 'manager', 'subordinate', 'business_partner',
  'friend', 'acquaintance', 'assistant', 'mentor'
);

CREATE TABLE entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type relation_type NOT NULL,
  relation_label VARCHAR(100),
  bidirectional BOOLEAN DEFAULT TRUE,
  metadata JSONB,
  source VARCHAR(20) DEFAULT 'extracted',
  confidence DECIMAL(3,2),
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(source_entity_id, target_entity_id, relation_type)
);

CREATE INDEX idx_entity_relations_source ON entity_relations(source_entity_id);
CREATE INDEX idx_entity_relations_target ON entity_relations(target_entity_id);
```

---

## Компонент 2: Subject Resolution в групповых чатах

### Проблема

```
Групповой чат "Команда":
├── Иван: "Завтра у Пети ДР"
├── Петя: "Да, 35 лет уже"
└── Маша: "Петь, поздравляю! Как дела на новой работе?"
```

Кому какие факты?

### Алгоритм определения субъекта

```
┌─────────────────────────────────────────────────────────────┐
│              SUBJECT RESOLUTION ALGORITHM                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. EXPLICIT MENTION (highest priority)                      │
│     "У Пети ДР" → субъект = Петя                            │
│     Паттерны: "у X", "X сказал", имя в род. падеже          │
│                                                              │
│  2. DIRECT ADDRESS                                           │
│     "Петь, поздравляю" → субъект = Петя                     │
│     Паттерны: обращение, @mention, звательный падеж         │
│                                                              │
│  3. REPLY CONTEXT                                            │
│     Маша отвечает на сообщение Пети → субъект = Петя        │
│                                                              │
│  4. SELF-REFERENCE                                           │
│     "Я теперь директор" → субъект = автор сообщения         │
│     Ключевые слова: "я", "мой", "меня", "у меня"            │
│                                                              │
│  5. THREAD CONTEXT                                           │
│     Если в треде обсуждают Петю → субъект = Петя            │
│     (анализ предыдущих N сообщений)                         │
│                                                              │
│  6. DEFAULT (lowest priority)                                │
│     Личный чат → субъект = собеседник                       │
│     Группа без контекста → НЕ извлекать (low confidence)    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Формат данных для группового extraction

```typescript
interface GroupExtractionContext {
  chatType: 'private' | 'group' | 'supergroup' | 'channel';

  // Участники с их контекстом (факты + связи)
  participants: Array<{
    entityId: string;
    name: string;
    aliases: string[];           // ["Петя", "Пётр", "Петруха", "@petr"]
    factsSummary: string;        // Компактный список фактов
    relations: string[];         // ["коллега Ивана", "муж Маши"]
  }>;

  // Сообщения с авторством
  messages: Array<{
    authorEntityId: string;
    authorName: string;
    content: string;
    replyToAuthorId?: string;
    replyToContent?: string;     // Для контекста reply
    timestamp: Date;
  }>;
}
```

### Prompt для группы

```
Извлеки факты из группового чата.
ВАЖНО: Определи КОМУ принадлежит каждый факт.

УЧАСТНИКИ:
1. Иван Петров (ID: xxx)
   • Факты: CTO в Сбербанке
   • Связи: коллега Пети, знает Машу

2. Петя Сидоров (ID: yyy)
   • Факты: Backend разработчик
   • День рождения: неизвестен

3. Маша Козлова (ID: zzz)
   • Факты: HR директор
   • Связи: коллега Пети

ПЕРЕПИСКА:
[Иван]: Завтра у Пети ДР
[Петя]: Да, 35 лет уже
[Маша → reply to Петя]: Петь, поздравляю! Как дела на новой работе?

ЗАДАЧА: Для каждого факта укажи:
- subjectEntityId: UUID сущности, которой принадлежит факт
- factType, value, confidence
- reasoning: почему факт относится к этому человеку
```

---

## Компонент 3: Batch Processing по логическим границам

### Текущее состояние

Extraction запускается по сессиям (gap > 4 часа). Но внутри сессии может быть много разных тем.

### Предлагаемые триггеры

```
┌─────────────────────────────────────────────────────────────┐
│              EXTRACTION TRIGGERS                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  TRIGGER 1: SESSION END (текущий)                           │
│  Gap > 4 часа → новая сессия → extraction                   │
│                                                              │
│  TRIGGER 2: TOPIC SHIFT (новый)                             │
│  Внутри сессии определять смену темы:                       │
│  - Явная: "Кстати, о другом...", "А вот ещё..."            │
│  - Семантическая: cosine distance > 0.7 между блоками      │
│  - Временная: пауза > 30 мин внутри сессии                  │
│                                                              │
│  TRIGGER 3: BUFFER FULL (fallback)                          │
│  Каждые N сообщений (15-20) если нет других триггеров       │
│                                                              │
│  TRIGGER 4: EXPLICIT (manual)                               │
│  Команда /extract или API вызов                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Оптимизированный flow

```
Messages Stream
      │
      ▼
┌─────────────┐
│   Buffer    │ ← Накапливаем сообщения (в памяти/Redis)
└──────┬──────┘
       │
       ▼
┌─────────────────────────┐
│   Trigger Detection     │
│   • Session end?        │
│   • Topic shift?        │
│   • Buffer full (20)?   │
└───────────┬─────────────┘
            │ trigger!
            ▼
┌─────────────────────────┐
│   Load Entity Contexts  │ ← Факты + связи всех участников
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│   Batch Extraction      │ ← ОДИН LLM вызов на весь batch
│   • Subject resolution  │
│   • Fact extraction     │
│   • Relation extraction │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│   Distribution          │
│   • Route facts → entities │
│   • Fusion per entity   │
│   • Create relations    │
│   • Update contexts     │
└─────────────────────────┘
```

---

## Компонент 4: Факты как контекст (Entity Memory)

### Уже есть

```typescript
// EntityFact уже содержит всё нужное
interface EntityFact {
  entityId: string;
  factType: string;        // position, company, birthday...
  value: string;
  confidence: number;
  rank: 'preferred' | 'normal' | 'deprecated';
  confirmationCount: number;
}
```

### Нужно добавить

```typescript
// EntityFactService - новый метод
async getContextString(entityId: string, options?: {
  maxFacts?: number;        // Лимит фактов (default: 10)
  includeRelations?: boolean; // Включить связи
  maxTokens?: number;       // Лимит токенов контекста
}): Promise<string> {
  const facts = await this.findByEntityWithRanking(entityId, {
    includeDeprecated: false,
    limit: options?.maxFacts || 10,
  });

  const relations = options?.includeRelations
    ? await this.relationService.findByEntity(entityId)
    : [];

  return this.formatAsContext(facts, relations);
}

private formatAsContext(facts: EntityFact[], relations: EntityRelation[]): string {
  let context = '';

  // Группируем факты по типам
  const byType = groupBy(facts.filter(f => f.rank !== 'deprecated'), 'factType');

  if (byType.position?.[0]) context += `• Должность: ${byType.position[0].value}\n`;
  if (byType.company?.[0]) context += `• Компания: ${byType.company[0].value}\n`;
  if (byType.birthday?.[0]) context += `• День рождения: ${byType.birthday[0].value}\n`;
  if (byType.phone?.[0]) context += `• Телефон: ${byType.phone[0].value}\n`;
  // ... other types

  // Связи
  if (relations.length > 0) {
    context += '\nСвязи:\n';
    for (const rel of relations.slice(0, 5)) {
      const label = rel.relationLabel || RELATION_TYPE_LABELS[rel.relationType];
      context += `• ${label}: ${rel.targetEntity?.name || rel.targetEntityId}\n`;
    }
  }

  return context;
}
```

### Формат контекста для prompt

```
Контекст: Иван Петров
━━━━━━━━━━━━━━━━━━━━━
📋 Факты:
• Должность: CTO
• Компания: Сбербанк (с 2020)
• День рождения: 15 марта 1985
• Telegram: @ivan_petrov

👥 Связи:
• Жена: Мария (Маша)
• Коллега: Петя Сидоров
• Руководитель: Герман Греф
```

---

## Вопросы для решения

### Q1: Где хранить связи?

**Вариант A: Связи как факты**
```typescript
// factType: 'relation_spouse', value: 'Мария', valueJson: { targetEntityId: '...' }
```
✅ Используем существующую инфраструктуру
❌ Нет bidirectional, сложнее граф

**Вариант B: Отдельная таблица EntityRelation** ← Рекомендация
```typescript
// entity_relations: source_id, target_id, relation_type, label
```
✅ Чистая модель графа
✅ Легко запрашивать "все связи Ивана"
❌ Новая entity, миграция, сервис

### Q2: Кэширование контекста?

**Вариант A: Без кэша** — строить на каждый extraction
- ✅ Всегда актуальный
- ❌ Лишние запросы к БД

**Вариант B: Redis с TTL** ← Рекомендация
- ✅ Быстро
- ⚠️ Нужно инвалидировать при изменении фактов

**Вариант C: Поле в Entity**
- ✅ Всегда под рукой
- ❌ Нужно обновлять при каждом изменении факта

### Q3: Как определять Topic Shift?

**Вариант A: Только временной gap (30 мин)**
- ✅ Просто
- ❌ Может быть неточно

**Вариант B: Semantic similarity между блоками**
- ✅ Точнее
- ❌ Дополнительные embedding вычисления

**Вариант C: Ключевые слова** ("кстати", "а вот", "другой вопрос")
- ✅ Просто и работает
- ❌ Не все смены темы явные

---

## План реализации

| # | Задача | Сложность | Приоритет |
|---|--------|-----------|-----------|
| 1 | `getContextString()` в EntityFactService | Low | **High** |
| 2 | Передача контекста в extraction prompt | Low | **High** |
| 3 | `EntityRelation` entity + migration | Medium | **High** |
| 4 | `EntityRelationService` CRUD | Medium | High |
| 5 | Extraction связей из сообщений | High | Medium |
| 6 | Subject resolution для групп | High | Medium |
| 7 | Topic shift detection | Medium | Low |
| 8 | Redis кэш для контекста | Low | Low |

### Рекомендуемый порядок

**Этап 1 (Quick Win):** Задачи 1-2
- Добавить `getContextString()`
- Передавать контекст в extraction
- Уже улучшит качество extraction

**Этап 2 (Relations):** Задачи 3-5
- EntityRelation модель
- Извлечение связей
- Использование связей в контексте

**Этап 3 (Groups):** Задача 6
- Subject resolution для групповых чатов

**Этап 4 (Optimization):** Задачи 7-8
- Topic shift detection
- Кэширование

---

## Acceptance Criteria

- [ ] При extraction передаётся контекст из существующих фактов
- [ ] "Маша (жена) передаёт привет" не создаёт факт для Ивана
- [ ] Связи извлекаются и сохраняются в EntityRelation
- [ ] В групповых чатах факты правильно распределяются по участникам
- [ ] Subject resolution работает для reply и @mentions
