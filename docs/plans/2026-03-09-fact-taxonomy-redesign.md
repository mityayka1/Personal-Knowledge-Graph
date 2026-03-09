# Fact Taxonomy Redesign — Wave 1

> **Статус:** 📋 Design Approved
> **Дата:** 2026-03-09
> **Связан с:** [Wave 2: Retrieval Quality Sprint](./2026-03-09-retrieval-quality-sprint.md)
> **Следующий шаг:** После обеих волн — полная переработка всех знаний (re-extraction)

## Проблема

EntityFact система накопила 1330 фактов с 77 уникальными fact_type'ами, из которых 52 — одиночки. Корневая причина: `factType: FactType | string` позволяет LLM генерировать произвольные типы без ограничений. 712 фактов (53.5%) имеют тип `activity` — это временные события, а не стабильные атрибуты.

### Цифры из production

| Метрика | Значение |
|---------|----------|
| Всего фактов | 1330 |
| Уникальных fact_type | 77 |
| Singleton-типы (1 факт) | 52 |
| Тип `activity` | 712 (53.5%) |
| Финансовые транзакции | 57 (transaction + financial_transaction + account_balance) |
| Контакты как факты | 30 (phone + email + telegram) |
| PendingApproval: approved | 299 |
| PendingApproval: rejected | 372 |
| PendingApproval: pending | 110 |

### Распределение activity-фактов по содержанию

| Паттерн | Кол-во | Пример |
|---------|--------|--------|
| Не классифицировано | 336 | Описания рабочих действий |
| Проект/продукт | 129 | "Разработал экосистему ccbox" |
| Проблема/наблюдение | 79 | "Выявил 859 позиций без Title" |
| Текущая работа | 52 | "Анализирует структуру навигации" |
| Намерение/план | 31 | "Планирует читать документацию" |
| Быт | 22 | "Делал ремонт дома" |
| Финансовое событие | 19 | "Выставил счет" |
| Хобби/спорт | 19 | "Занят на тренировке" |
| Навык/обучение | 18 | "Научил Claude генерировать скрипты" |

## Теоретическая основа

### Memory Systems Architecture (5 слоёв)

Источник: [memory-systems skill](https://skills.sh/shipshitdev/library/memory-systems)

| Слой | Описание | Реализация в PKG |
|------|----------|------------------|
| Working Memory | Context window | System prompt при recall/prepare |
| Short-Term Memory | Session scope | Interaction + Messages |
| Long-Term Memory | Cross-session | TopicalSegments, KnowledgePacks |
| **Entity Memory** | Свойства + связи | **EntityFact + EntityRelation** |
| **Temporal KG** | Факты с validity windows | **valid_from/valid_until** |

PKG уже реализует все 5 слоёв. Проблема в **extraction quality**, не в архитектуре хранения.

### Ключевые принципы

- "The extraction step is more important than the storage format" — [memory-systems](https://skills.sh/shipshitdev/library/memory-systems)
- Temporal KG (Zep) даёт 94.8% accuracy — лучший benchmark результат
- memU taxonomy: `preferences`, `relationships`, `knowledge`, `context` — 4 корневых категории
- Memory Consolidation — периодическое объединение связанных фактов, архивация устаревших

### Определение факта

Факт — это **стабильный атрибут сущности** с временной валидностью. Выражается как:

```
<Entity> <has/is> <Value> [since Date] [until Date]
```

**Является фактом:**
- "Dmitriy is CTO at Company X since 2024" → `position`
- "Айдар has birthday 15 марта" → `birthday`
- "Masha knows Python" → `skill`

**НЕ является фактом:**
- "Dmitriy analyzed errors in Avito" → Activity/TopicalSegment
- "Alexander paid 50000₽" → финансовое событие
- "Masha plans to read docs" → Commitment/Task

## Дизайн

### 1. Контролируемая таксономия (18 типов)

```
CATEGORY: PROFESSIONAL (knowledge + work context)
├── position        — должность (CTO, разработчик, менеджер)
├── company         — место работы (ООО "ИИ-Сервисы")
├── department      — отдел/подразделение
├── specialization  — область экспертизы (AI, backend, маркетинг)
├── skill           — конкретный навык (Python, Claude Code, Google Sheets)
├── education       — образование (ВУЗ, курсы, сертификаты)
└── role            — роль в проекте (исполнитель, заказчик)

CATEGORY: PERSONAL (identity + lifestyle)
├── birthday        — дата рождения
├── location        — город/страна проживания
├── family          — семейное положение, дети, родственники
├── hobby           — увлечения (спорт, музыка, путешествия)
├── language        — языки общения
├── health          — здоровье (аллергии, ограничения)
└── status          — текущий статус (ищет работу, в декрете, в отпуске)

CATEGORY: PREFERENCES (communication + work style)
├── communication   — предпочтения по общению (формат, время, канал)
└── preference      — прочие предпочтения (инструменты, подходы)

CATEGORY: BUSINESS (для организаций)
├── inn             — ИНН/КПП/ОГРН
└── legal_address   — юридический/фактический адрес
```

### 2. Изменения в FactType enum

```typescript
// packages/entities/src/entity-fact.entity.ts

export enum FactType {
  // PROFESSIONAL
  POSITION = 'position',
  COMPANY = 'company',
  DEPARTMENT = 'department',
  SPECIALIZATION = 'specialization',
  SKILL = 'skill',
  EDUCATION = 'education',
  ROLE = 'role',

  // PERSONAL
  BIRTHDAY = 'birthday',
  LOCATION = 'location',
  FAMILY = 'family',
  HOBBY = 'hobby',
  LANGUAGE = 'language',
  HEALTH = 'health',
  STATUS = 'status',

  // PREFERENCES
  COMMUNICATION = 'communication',
  PREFERENCE = 'preference',

  // BUSINESS
  INN = 'inn',
  LEGAL_ADDRESS = 'legal_address',
}

// УДАЛЯЕМ из enum:
// NAME_FULL, NICKNAME — не используются реально (0 фактов)
// PHONE_WORK, PHONE_PERSONAL, EMAIL_WORK, EMAIL_PERSONAL, TELEGRAM — → EntityIdentifier
// ADDRESS → LOCATION (объединяем)
// ACTUAL_ADDRESS → LOCATION
// KPP, OGRN, BANK_ACCOUNT — объединяем в INN (metadata в value)
// TIMEZONE — объединяем в PREFERENCE
// DAILY_SUMMARY — удаляем (не факт)
// COMMUNICATION_PREFERENCE → COMMUNICATION (сокращаем)
```

### 3. Строгая типизация (убираем `| string`)

```typescript
// БЫЛО:
@Column({ type: 'varchar', length: 100 })
factType: FactType | string;  // ← КОРЕНЬ ПРОБЛЕМЫ

// СТАНЕТ:
@Column({ type: 'enum', enum: FactType })
factType: FactType;  // ← строгий enum
```

### 4. Runtime-валидация

```typescript
// common/utils/fact-validation.ts

const FACT_TYPE_ALIASES: Record<string, FactType> = {
  'occupation': FactType.POSITION,
  'job': FactType.POSITION,
  'work_activity': FactType.SPECIALIZATION,
  'experience': FactType.EDUCATION,
  'career_aspiration': FactType.PREFERENCE,
  'professional_approach': FactType.PREFERENCE,
  'communication_style': FactType.COMMUNICATION,
  'research_area': FactType.SPECIALIZATION,
  'tool': FactType.SKILL,
  'work_setup': FactType.PREFERENCE,
  'accessibility_issue': FactType.HEALTH,
  'health_condition': FactType.HEALTH,
  'health_visit': FactType.HEALTH,
  'nickname': FactType.PREFERENCE,
  'name': FactType.PREFERENCE,
};

export function normalizeFactType(raw: string): FactType | null {
  const normalized = raw.toLowerCase().replace(/[-\s]/g, '_');

  // Exact match
  if (Object.values(FactType).includes(normalized as FactType)) {
    return normalized as FactType;
  }

  // Alias match
  if (FACT_TYPE_ALIASES[normalized]) {
    return FACT_TYPE_ALIASES[normalized];
  }

  // Unknown — reject
  return null;
}
```

### 5. Обновление Extraction Pipeline (3 пути)

#### Path 1: FactExtractionService (oneshot)

Файл: `extraction/fact-extraction.service.ts`

- Обновить FACTS_SCHEMA: `factType` → `z.enum([...FactType values])`
- Обновить промпт: явный список типов + правило "факт = стабильный атрибут"
- Добавить `normalizeFactType()` validation после парсинга

#### Path 2: SecondBrainExtractionService (conversation)

Файл: `extraction/second-brain-extraction.service.ts`

- Обновить CONVERSATION_EXTRACTION_SCHEMA для type='fact': `factType` → enum
- Обновить промпт: что является фактом, а что нет (примеры)
- Добавить validation в mapper

#### Path 3: ExtractionToolsProvider (agent create_fact tool)

Файл: `extraction/tools/extraction-tools.provider.ts`

- `factType: z.enum([...FactType values])` вместо `z.string()`
- Обновить описание tool: правила что является фактом
- Убрать примеры несуществующих типов из describe()

### 6. План миграции существующих данных

```
ЭТАП 1: SQL cleanup — удаление non-fact данных
├── DELETE: transaction (37), financial_transaction (13), account_balance (7)
├── DELETE: process_observation (37)
├── DELETE: project/project_status/project_update/project_context (5)
├── DELETE: access/access_level/access_issue (5)
├── DELETE: note, plan, issue, problem, daily_summary (5)
├── DELETE: card_last_digits, payment, payment_methods, mortgage (4)
├── DELETE: service_agreement, financial_arrangement, infrastructure (3)
├── DELETE: software_version, technical_issue, availability (3)
├── DELETE: acquaintance, friendship_history (2) — → EntityRelation
├── DELETE: mood_financial_status, tax_status_update (2)
└── ~123 удалений

ЭТАП 2: SQL remap — нормализация типов
├── occupation (2) → position
├── work_activity (7) → specialization
├── career_aspiration (1) → preference
├── professional_approach (1) → preference
├── communication_style (1) → communication
├── experience (2) → education
├── tool (3) → skill
├── accessibility_issue (2) → health
├── health_condition (11) → health
├── health_visit (1) → health
├── contact (5) → DELETE (дубль EntityIdentifier)
├── contact_telegram (1), contact_link (1) → DELETE
├── tax_status (2) → status
├── work_status (1) → status
├── work_setup (1) → preference
├── research_area (1) → specialization
├── opinion (2) → preference
├── current_project (1) → DELETE (Activity system)
├── github_account (1) → DELETE (→ EntityIdentifier)
├── website (1) → DELETE (→ EntityIdentifier)
├── name (1) → DELETE
├── personal (2) → preference
├── professional (41) → specialization
└── ~82 ремаппинга

ЭТАП 3: LLM batch — переклассификация 712 activity фактов
├── Для каждого: Claude Haiku решает { newType: FactType | null }
├── newType = skill → UPDATE fact_type = 'skill'
├── newType = hobby → UPDATE fact_type = 'hobby'
├── newType = specialization → UPDATE fact_type = 'specialization'
├── newType = status → UPDATE fact_type = 'status'
├── newType = null → DELETE (временное событие, не факт)
├── Ожидание: ~50-80 сохранённых, ~630-660 удалённых
└── Batch processing: chunks по 50, Claude Haiku

ЭТАП 4: Контакты → EntityIdentifier
├── phone (15) → EntityIdentifier type=phone
├── email (12) → EntityIdentifier type=email
├── telegram (3) → EntityIdentifier type=telegram_username
├── Проверка на дубликаты в EntityIdentifier перед миграцией
└── DELETE из entity_facts после миграции

ЭТАП 5: Дедупликация оставшихся
├── Smart Fusion по entity + factType
├── birthday: 51 → ~25
├── position: 46 → ~30
├── company: 31 → ~20
└── Запуск существующего FactFusionService

ИТОГО: 1330 → ~350-400 чистых фактов
```

### 7. Memory Consolidation (новый cron)

**FactConsolidationJob** — еженедельный cron (воскресенье, 4:00 AM):

1. Найти дубликаты по entity + factType (embedding similarity > 0.75)
2. Для каждой пары — Smart Fusion (CONFIRM/SUPERSEDE/ENRICH)
3. Закрыть устаревшие факты (valid_until = now) если есть свежая версия
4. Удалить факты с confidence < 0.3 без одобрения
5. Отчёт в DataQualityReport

### 8. Ревью одобренных фактов

299 approved фактов в PendingApproval включают activity-type факты. Approval подтвердил что информация верна, но не что тип правильный. Все entity_facts (включая ранее одобренные) подлежат миграции по тем же правилам.

### 9. Привязка к Activity (activityId)

Факты, связанные с проектным контекстом, получают `activityId`:
- `skill: "Python"` + activityId: PKG
- `specialization: "Avito integration"` + activityId: Панавто
- `position: "CTO"` без activityId — общий факт

Поле `activityId` уже существует в entity_facts (добавлено в Extraction Quality Sprint).

## Файлы для изменения

| Файл | Изменение |
|------|-----------|
| `packages/entities/src/entity-fact.entity.ts` | Новый FactType enum (18 типов), убрать `\| string` |
| `apps/pkg-core/src/common/utils/fact-validation.ts` | **Новый** — normalizeFactType() + aliases |
| `apps/pkg-core/src/modules/extraction/fact-extraction.service.ts` | Enum в schema + prompt + validation |
| `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts` | Enum в schema + prompt + validation |
| `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts` | z.enum() + описание |
| `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts` | normalizeFactType() в createDraft |
| `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts` | Validation при create/update |
| `apps/pkg-core/src/modules/data-quality/fact-consolidation.job.ts` | **Новый** — weekly consolidation |
| `apps/pkg-core/src/database/migrations/XXXX-fact-taxonomy-migration.ts` | **Новый** — SQL миграция |

## Verification

### Pre-migration
```sql
SELECT fact_type, COUNT(*) FROM entity_facts GROUP BY fact_type ORDER BY COUNT(*) DESC;
-- Ожидание: 77 уникальных типов, 1330 фактов
```

### Post-migration
```sql
SELECT fact_type, COUNT(*) FROM entity_facts GROUP BY fact_type ORDER BY COUNT(*) DESC;
-- Ожидание: ≤18 типов, 350-400 фактов
-- Все fact_type значения входят в FactType enum
```

### Extraction test
```bash
# Создать факт с невалидным типом — должен быть отклонён
curl -X POST .../entity-facts -d '{"factType": "activity", "value": "test"}'
# Ожидание: 400 Bad Request — "Invalid factType"
```

## Связь с Wave 2

После Wave 1 (чистая таксономия) → [Wave 2: Retrieval Quality Sprint](./2026-03-09-retrieval-quality-sprint.md) улучшит ИЗВЛЕЧЕНИЕ фактов для recall/prepare:
- BM25 (ts_rank_cd) вместо ts_rank
- LLM-based reranking при context assembly
- Hybrid scoring для tiered retrieval

После обеих волн → **полная переработка всех знаний**: re-extraction из исторических сообщений с новым pipeline, чтобы заполнить чистую базу фактов.
