      # Knowledge System Evolution — Полный план реализации

> Эволюция PKG от набора фактов к полноценной системе знаний

**Дата:** 2026-02-15
**Статус:** ✅ Completed (2026-02-16)Тра
**Scope:** 9 областей улучшения, ~35 задач, 3 приоритетных волны

---

## Executive Summary

PKG накопила данные, но не знания. Система извлекает факты, задачи, обязательства — но не связывает их в целостную картину. Этот план закрывает разрыв через 3 волны:

1. **Wave 1 — Fix Broken Links** (CRITICAL): Починить то, что уже должно работать
2. **Wave 2 — Deepen Extraction** (HIGH): Улучшить качество и полноту извлечения
3. **Wave 3 — Knowledge Layer** (MEDIUM+): TopicalSegment, KnowledgePack, Smart Fusion

---

## Проблемы и области улучшения

| # | Область | Приоритет | Проблема |
|---|---------|-----------|----------|
| A | InferredRelations persistence | CRITICAL | DailySynthesis извлекает relations, но НЕ сохраняет их в БД |
| B | Commitment↔Activity linking | CRITICAL | Commitment.activityId заполняется ненадёжно |
| C | Activity enrichment | HIGH | 80% Activities без description, tags, deadline, priority |
| D | Semantic dedup для Tasks/Commitments | HIGH | Только Levenshtein ≥0.7, нет semantic dedup |
| E | find_activity_by_name tool | HIGH | Claude не может искать Activity по имени при extraction |
| F | Smart Fusion (CONFIRM/SUPERSEDE/ENRICH/CONFLICT) | MEDIUM | Новые факты не сопоставляются с существующими |
| G | Entity disambiguation | MEDIUM | Одинаковые имена → merge в одну entity без разбора |
| H | TopicalSegment entity | MEDIUM | Нет семантической сегментации сообщений |
| I | KnowledgePack entity | MEDIUM | Нет консолидации знаний |

---

## Wave 1 — Fix Broken Links (CRITICAL)

### Issue #1: Persist InferredRelations from DailySynthesis

**Проблема:** `DailySynthesisExtractionService.extractAndSave()` (строка 165) передаёт в `createDrafts()` только `projects`, `tasks`, `commitments`. Поле `inferredRelations` из extraction result **игнорируется**.

**Файлы:**
- `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.service.ts` — extractAndSave()
- `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts` — createDrafts()
- `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.types.ts` — InferredRelation type

**Решение:**
1. Добавить `inferredRelations: InferredRelation[]` в `DraftExtractionInput`
2. Создать метод `createDraftRelations()` в `DraftExtractionService`:
   - Для каждого `InferredRelation`: resolve entity names → EntityRecord IDs
   - Resolve activityName → Activity ID (через `ProjectMatchingService`)
   - Создать EntityRelation + EntityRelationMember records
   - Дедупликация: проверить существующую relation с тем же типом и участниками
3. Вызвать в `extractAndSave()` после `createDrafts()`
4. Добавить relations count в response

**Зависимости:** Нет
**Агент:** backend-developer
**Оценка:** ~120 строк нового кода

---

### Issue #2: Fix Commitment↔Activity Linking

**Проблема:** `DraftExtractionService.createDraftCommitments()` линкует Commitment→Activity через `projectMap` (name → activityId), но:
- `projectMap` содержит только проекты из текущего extraction batch
- Если commitment ссылается на СУЩЕСТВУЮЩИЙ проект (не в batch) — связь теряется
- `commitment.projectName` может не совпадать exact с Activity.name

**Файлы:**
- `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts` — createDraftCommitments()
- `apps/pkg-core/src/modules/extraction/project-matching.service.ts` — findBestMatch()

**Решение:**
1. В `createDraftCommitments()`, если `projectMap` не содержит `commitment.projectName`:
   - Вызвать `ProjectMatchingService.findBestMatch(projectName, existingActivities)` с порогом 0.7
   - Если найден match — использовать его activityId
2. Если и это не помогло — загрузить `Activity.findByMention(projectName)` из ActivityService
3. Логировать все unlinked commitments для отладки

**Зависимости:** Нет
**Агент:** backend-developer
**Оценка:** ~40 строк изменений

---

### Issue #3: Duplicate Project Prevention (полная проверка)

**Проблема:** Пользователь явно указал: "Предусмотреть проверку уже существующих проектов при создании новых, чтобы избежать их дубликатов."

Текущее состояние:
- `DraftExtractionService.createDraftProjects()` уже использует `ProjectMatchingService.findBestMatch()` с two-tier matching (0.6 weak / 0.8 strong)
- НО: matching работает только по `name` + Levenshtein, без учёта `description`, `client`, `tags`
- `normalizeName()` стрипает стоимости, но не нормализует регистр/пробелы

**Файлы:**
- `apps/pkg-core/src/modules/extraction/project-matching.service.ts` — findBestMatch(), normalizeName()
- `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts` — createDraftProjects()

**Решение:**
1. Улучшить `normalizeName()`: toLowerCase(), trim(), collapse whitespace
2. Добавить client-aware matching: если у нового проекта есть client и у существующего тоже — boost similarity
3. Добавить в `findBestMatch()` вторичный check по `description` similarity для grey zone (0.6-0.8)
4. Добавить check по `tags` overlap для дополнительного boost
5. Log все skip/merge decisions для аудита

**Зависимости:** Нет
**Агент:** backend-developer
**Оценка:** ~50 строк изменений

---

## Wave 2 — Deepen Extraction (HIGH)

### Issue #4: Activity Enrichment при Extraction

**Проблема:** 80% Activity имеют пустые `description`, `tags`, `deadline`, `priority`. Extraction создаёт Activity, но не обогащает существующие.

**Файлы:**
- `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts` — create_event tool
- `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts` — createDraftProjects()
- `apps/pkg-core/src/modules/activity/activity.service.ts` — update()

**Решение:**
1. В `create_event` tool: добавить параметры `priority`, `deadline`, `tags` (уже есть в ExtractedProject, но не в tool schema)
2. В `createDraftProjects()`: если проект matched с существующим (isNew=false) — обновить пустые поля:
   - `description` если было null → set
   - `tags` → merge массивов (unique)
   - `deadline` если было null → set
   - `priority` если было 'none' → set
   - `lastActivityAt` → update to now
3. Создать endpoint `PATCH /activities/:id/enrich` для bulk enrichment
4. В `fact-extraction.processor.ts`: после extraction, если Activity был создан/обновлён — emit event для enrichment

**Зависимости:** Issue #3 (duplicate prevention ensures we match correctly)
**Агент:** backend-developer
**Оценка:** ~100 строк

---

### Issue #5: Semantic Dedup для Tasks и Commitments

**Проблема:** Tasks и Commitments дедуплицируются только по Levenshtein ≥0.7. "Подготовить презентацию для клиента" и "Сделать презентацию клиенту" — не считаются дубликатами.

**Файлы:**
- `apps/pkg-core/src/modules/extraction/fact-deduplication.service.ts` — checkDuplicateHybrid()
- `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts` — createDraftTasks(), createDraftCommitments()

**Решение:**
1. Обобщить `FactDeduplicationService` → `DeduplicationService`:
   - Вынести `checkDuplicateHybrid()` в generic method с configurable thresholds
   - Добавить методы `checkTaskDuplicate()`, `checkCommitmentDuplicate()`
2. Для Tasks: сравнивать `title` + `projectName` combined
   - Text threshold: Levenshtein ≥0.6 (вместо 0.7)
   - Semantic threshold: cosine ≥0.75
3. Для Commitments: сравнивать `what` + `from` + `to` combined
   - Text threshold: Levenshtein ≥0.6
   - Semantic threshold: cosine ≥0.75
4. Добавить embedding column в Activity и Commitment entities (для semantic search)
5. Генерировать embeddings при создании Tasks/Commitments через EmbeddingService

**Зависимости:** Нет
**Агент:** backend-developer + pgvector-expert
**Оценка:** ~200 строк нового кода + миграция

---

### Issue #6: find_activity_by_name MCP Tool

**Проблема:** Claude при extraction не может найти существующую Activity по имени. Сейчас `create_event` создаёт новую Activity даже если такая уже есть (dedup ловит это post-factum).

**Файлы:**
- `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts` — добавить новый tool

**Решение:**
1. Создать tool `find_activity`:
   ```
   find_activity(query: string, type?: ActivityType, status?: ActivityStatus): Activity[]
   ```
   - Fuzzy search по `Activity.name` через `ILIKE %query%`
   - Fallback на `ProjectMatchingService.findBestMatch()` для Levenshtein
   - Вернуть top-5 matches с similarity score
2. Обновить prompt в `unified-extraction.service.ts` и `group-extraction.service.ts`:
   - Добавить инструкцию: "Перед созданием нового проекта — ОБЯЗАТЕЛЬНО вызови find_activity для проверки существования"
3. В `create_event`: добавить параметр `existingActivityId` как альтернативу созданию нового

**Зависимости:** Нет
**Агент:** claude-agent-sdk-expert + backend-developer
**Оценка:** ~80 строк нового tool + ~20 строк prompt changes

---

## Wave 3 — Knowledge Layer (MEDIUM+)

### Issue #7: TopicalSegment Entity и Миграция

**Проблема:** Нет семантической сегментации — факты привязаны к одному сообщению, не к обсуждению.

**Файлы (создать):**
- `packages/entities/src/topical-segment.entity.ts` — entity (спецификация в 06-PHASE-E)
- `apps/pkg-core/src/database/entities.ts` — регистрация
- Миграция для создания таблиц `topical_segments` и `segment_messages`

**Решение:**
1. Создать entity `TopicalSegment` по спецификации из `06-PHASE-E-KNOWLEDGE-PACKING.md` (строки 101-328)
2. Добавить в `entities.ts`
3. Создать миграцию:
   - Таблица `topical_segments` (все поля из спецификации)
   - Join-таблица `segment_messages` (segment_id, message_id)
   - Индексы: topic, chat_id, interaction_id, activity_id, status, started_at, ended_at
4. Создать `SegmentationModule` с:
   - `SegmentationService` — CRUD для segments
   - Методы: `createSegment()`, `addMessages()`, `linkToActivity()`, `closeSegment()`

**Зависимости:** Нет
**Агент:** backend-developer
**Оценка:** ~250 строк entity + service + миграция

---

### Issue #8: SegmentationService — Автоматическая сегментация

**Проблема:** Нет автоматического определения границ тем в потоке сообщений.

**Файлы (создать):**
- `apps/pkg-core/src/modules/segmentation/segmentation.module.ts`
- `apps/pkg-core/src/modules/segmentation/segmentation.service.ts`
- `apps/pkg-core/src/modules/segmentation/topic-boundary-detector.service.ts`

**Решение:**
1. `TopicBoundaryDetectorService`:
   - Метод `detectBoundaries(messages: Message[]): TopicBoundary[]`
   - Используй time-gap heuristic (>20 min) + semantic shift detection
   - Semantic shift: compare embedding cosine distance between consecutive message windows
   - Fallback: Claude LLM call для сложных случаев (explicit topic markers)
2. `SegmentationService.segmentInteraction(interactionId)`:
   - Load messages → detectBoundaries → create TopicalSegments
   - Link messages to segments via `segment_messages`
   - Attempt `linkToActivity()` для каждого сегмента
3. Интеграция: вызывать `segmentInteraction()` из `fact-extraction.processor.ts` ПЕРЕД extraction
4. Передать `segmentId` в extraction context для трассировки

**Зависимости:** Issue #7 (TopicalSegment entity)
**Агент:** backend-developer + claude-agent-sdk-expert
**Оценка:** ~350 строк

---

### Issue #9: KnowledgePack Entity и Миграция

**Проблема:** Нет механизма консолидации знаний — сегменты накапливаются, но не упаковываются.

**Файлы (создать):**
- `packages/entities/src/knowledge-pack.entity.ts` — entity (спецификация в 06-PHASE-E)
- Миграция для создания таблицы `knowledge_packs`

**Решение:**
1. Создать entity `KnowledgePack` по спецификации (строки 331-449)
2. Добавить в `entities.ts`
3. Создать миграцию с индексами
4. Создать `PackingService`:
   - `packByActivity(activityId, periodStart, periodEnd)` — собрать segments → сгенерировать pack
   - `generatePackContent(segments)` — Claude LLM: consolidate segments into decisions, openQuestions, keyFacts
   - `detectConflicts(facts)` — найти противоречия в фактах по одной теме

**Зависимости:** Issue #7, #8 (сегменты должны существовать)
**Агент:** backend-developer + claude-agent-sdk-expert
**Оценка:** ~300 строк entity + service + миграция

---

### Issue #10: Smart Fusion (CONFIRM/SUPERSEDE/ENRICH/CONFLICT)

**Проблема:** Новые факты создаются параллельно существующим, вместо обогащения/обновления.

**Файлы:**
- `apps/pkg-core/src/modules/extraction/fact-deduplication.service.ts` — расширить actions
- `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts` — create_fact tool
- `apps/pkg-core/src/modules/extraction/unified-extraction.service.ts` — prompt

**Решение:**
1. Расширить `DedupAction` enum:
   - `CONFIRM` — повысить confidence существующего факта
   - `SUPERSEDE` — заменить старый факт (set validUntil, create new)
   - `ENRICH` — добавить детали к существующему факту
   - `CONFLICT` — создать PendingApproval для разрешения конфликта
2. В `checkDuplicateHybrid()`: определять action на основе:
   - Similarity ≥0.90 + same value → CONFIRM (boost confidence)
   - Similarity ≥0.80 + different value + same factType → SUPERSEDE или CONFLICT
   - Similarity ≥0.70 + complementary info → ENRICH
3. В prompt: инструктировать Claude использовать `update_fact` tool для обновлений
4. Создать tool `update_fact` для явного обновления существующего факта

**Зависимости:** Issue #5 (semantic dedup infrastructure)
**Агент:** backend-developer + claude-agent-sdk-expert
**Оценка:** ~150 строк

---

### Issue #11: Cross-Chat Topic Linking

**Проблема:** Обсуждение одной темы в разных чатах не связывается.

**Файлы:**
- `apps/pkg-core/src/modules/segmentation/segmentation.service.ts` — добавить cross-chat logic
- `apps/pkg-core/src/modules/job/processors/fact-extraction.processor.ts` — cross-chat context

**Решение:**
1. В `SegmentationService`: метод `findRelatedSegments(segment)`:
   - По `activityId` — все segments для того же Activity
   - По `topic` similarity — ILIKE или embedding search
   - По `participantIds` overlap + time proximity (±1 hour)
2. В `fact-extraction.processor.ts`: при extraction, загрузить `relatedSegments` и добавить в prompt как "СВЯЗАННЫЙ КОНТЕКСТ"
3. В `TopicalSegment`: добавить `relatedSegmentIds: string[]` для explicit linking

**Зависимости:** Issue #7, #8 (сегментация должна работать)
**Агент:** backend-developer
**Оценка:** ~120 строк

---

### Issue #12: Entity Disambiguation

**Проблема:** Одинаковые имена (напр. два "Александра") merge в одну entity.

**Файлы:**
- `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts` — find_entity_by_name
- `apps/pkg-core/src/modules/entity/entity.service.ts` — disambiguation logic

**Решение:**
1. В `find_entity_by_name` tool: если найдено >1 entity с таким именем:
   - Вернуть все matches с контекстом (company, identifiers, last interaction)
   - Добавить в response `disambiguation_needed: true`
2. В `create_pending_entity` tool: добавить `context` параметр (chat_id, mentioned_with):
   - При создании PendingEntityResolution — сохранить контекст для будущего resolve
3. В extraction prompt: инструкция "Если есть несколько людей с одним именем — используй дополнительный контекст (компания, должность, чат)"
4. Создать `EntityDisambiguationService`:
   - `disambiguate(name, context)` — score каждого кандидата по контексту
   - Факторы: recent interaction, same chat, mentioned companies, co-occurrence

**Зависимости:** Нет
**Агент:** backend-developer
**Оценка:** ~150 строк

---

## Полный Task List с Git Workflow

### Обозначения

- **Branch:** `feature/<issue-slug>` от `master`
- **PR:** merge --merge (не squash!) в `master`
- **Review:** tech-lead agent code review перед merge
- **Test:** qa-engineer agent проверяет compilation + логику
- **Deploy:** devops agent деплоит на production

---

### Wave 1: Fix Broken Links

#### Task 1.1: Persist InferredRelations

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/persist-inferred-relations` |
| **Агент** | backend-developer |
| **Зависимости** | Нет |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/persist-inferred-relations master`
2. Добавить `inferredRelations` в `DraftExtractionInput` (`draft-extraction.service.ts`)
3. Создать метод `createDraftRelations()` в `DraftExtractionService`:
   - Resolve entity names → IDs через `EntityService.findByName()`
   - Resolve activityName → Activity ID через `ProjectMatchingService.findBestMatch()`
   - Создать `EntityRelation` + `EntityRelationMember` records
   - Dedup: check existing relation with same type + participants
4. В `extractAndSave()`: передать `extraction.inferredRelations` в createDrafts
5. Обновить response в `extraction.controller.ts` — добавить `relationsCreated`
6. **Commit:** `feat(extraction): persist inferred relations from daily synthesis`
7. **Review:** tech-lead проверяет:
   - Нет дублирования relations
   - Entity resolution fallback при не-найденных именах
   - TypeORM QueryBuilder (не save!) для Activity-related записей
8. **PR → master**, merge --merge --delete-branch

#### Task 1.2: Fix Commitment↔Activity Linking

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/fix-commitment-activity-link` |
| **Агент** | backend-developer |
| **Зависимости** | Нет |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/fix-commitment-activity-link master`
2. В `createDraftCommitments()`: после check в `projectMap`, добавить fallback:
   ```typescript
   // Fallback 1: ProjectMatchingService fuzzy match
   const match = await this.projectMatchingService.findBestMatch(
     commitment.projectName, existingActivities, { threshold: 0.7 }
   );
   if (match) activityId = match.activityId;

   // Fallback 2: Activity.findByMention() для ILIKE search
   if (!activityId) {
     const found = await this.activityService.findByMention(commitment.projectName);
     if (found.length === 1) activityId = found[0].id;
   }
   ```
3. Добавить логирование unlinked commitments
4. **Commit:** `fix(extraction): improve commitment-to-activity linking with fuzzy fallback`
5. **Review:** tech-lead — проверить что circular deps resolved
6. **PR → master**

#### Task 1.3: Strengthen Project Duplicate Prevention

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/strengthen-project-dedup` |
| **Агент** | backend-developer |
| **Зависимости** | Нет |
| **Блокирует** | Task 2.1 |

**Шаги:**
1. `git checkout -b feature/strengthen-project-dedup master`
2. В `ProjectMatchingService.normalizeName()`:
   - Добавить `.toLowerCase().trim().replace(/\s+/g, ' ')`
   - Стрипать кавычки, скобки с аннотациями
3. В `findBestMatch()`:
   - Добавить client-aware boost: если client совпадает → понизить strong threshold до 0.7
   - Добавить secondary description similarity check для grey zone (0.6-0.8)
4. Добавить unit тесты для edge cases:
   - "ПРОЕКТ X" vs "проект x" → match
   - "Invapp-panavto (424₽)" vs "invapp-panavto" → match
   - "PKG Core" vs "pkg-core" → match
5. **Commit:** `feat(extraction): strengthen project duplicate detection with normalization and client boost`
6. **Review:** tech-lead + qa-engineer (unit tests)
7. **PR → master**

#### Task 1.4: Wave 1 Integration Test & Deploy

| Параметр | Значение |
|----------|----------|
| **Branch** | — (на master после merge всех Wave 1 PRs) |
| **Агент** | qa-engineer + devops |
| **Зависимости** | Tasks 1.1, 1.2, 1.3 |

**Шаги:**
1. qa-engineer: `npx tsc --noEmit` — compilation check
2. qa-engineer: Ручной тест `POST /extraction/daily/extract-and-save` — проверить что:
   - `relationsCreated > 0` в response
   - Commitments привязаны к Activities
   - Дубликаты проектов не создаются
3. devops: Deploy на production
4. devops: Проверить логи `docker compose logs -f pkg-core | grep "draft-extraction"`

---

### Wave 2: Deepen Extraction

#### Task 2.1: Activity Enrichment при Extraction

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/activity-enrichment` |
| **Агент** | backend-developer |
| **Зависимости** | Task 1.3 (проект dedup ensures correct matching) |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/activity-enrichment master`
2. В `extraction-tools.provider.ts` → `create_event` tool:
   - Добавить параметры `priority`, `deadline`, `tags` в Zod schema
   - Описания: `.describe('Priority: critical/high/medium/low')` и т.д.
3. В `draft-extraction.service.ts` → `createDraftProjects()`:
   - При match существующего проекта (isNew=false): enrich пустые поля
   ```typescript
   if (!existingActivity.description && project.description) {
     await this.activityService.update(existingActivity.id, { description: project.description });
   }
   // Аналогично для tags (merge), deadline, priority
   ```
4. **Commit:** `feat(extraction): enrich existing activities with new extraction data`
5. **Review:** tech-lead — проверить что enrichment не перезатирает manual данные
6. **PR → master**

#### Task 2.2: Semantic Dedup для Tasks — Инфраструктура

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/semantic-dedup-tasks` |
| **Агент** | backend-developer + pgvector-expert |
| **Зависимости** | Нет |
| **Блокирует** | Task 2.3 |

**Шаги:**
1. `git checkout -b feature/semantic-dedup-tasks master`
2. Создать миграцию: добавить `embedding vector(1536)` в таблицу `activities`
3. Создать миграцию: добавить `embedding vector(1536)` в таблицу `commitments`
4. Обобщить `FactDeduplicationService` — вынести generic `checkSimilarity()`:
   ```typescript
   async checkTextAndSemanticSimilarity(params: {
     text: string;
     candidates: Array<{ id: string; text: string; embedding?: number[] }>;
     textThreshold: number;
     semanticThreshold: number;
   }): Promise<DedupResult>
   ```
5. Добавить `checkTaskDuplicate(title, projectName, existingTasks)`:
   - Levenshtein ≥0.6 на `title`
   - Cosine ≥0.75 на embedding
   - Boost если `projectName` совпадает
6. **Commit:** `feat(extraction): add semantic dedup infrastructure for tasks and commitments`
7. **Review:** pgvector-expert — проверить индексы и query performance
8. **PR → master**

#### Task 2.3: Semantic Dedup — Интеграция в Draft Service

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/semantic-dedup-integration` |
| **Агент** | backend-developer |
| **Зависимости** | Task 2.2 |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/semantic-dedup-integration master`
2. В `createDraftTasks()`: заменить Levenshtein-only check на `checkTaskDuplicate()`
3. В `createDraftCommitments()`: аналогично — `checkCommitmentDuplicate()`
4. Генерировать embeddings при создании Activity/Commitment через `EmbeddingService.generateEmbedding()`
5. **Commit:** `feat(extraction): integrate semantic dedup for tasks and commitments`
6. **Review:** tech-lead — проверить что embedding generation async (не блокирует)
7. **PR → master**

#### Task 2.4: find_activity MCP Tool

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/find-activity-tool` |
| **Агент** | claude-agent-sdk-expert + backend-developer |
| **Зависимости** | Нет |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/find-activity-tool master`
2. В `extraction-tools.provider.ts`: создать tool `find_activity`:
   ```typescript
   tool('find_activity', 'Search for existing activities/projects by name', {
     query: z.string().min(2).describe('Activity name to search for'),
     type: z.string().optional().describe('Filter by type: project, task, area, business'),
     status: z.string().optional().describe('Filter by status: active, draft, completed'),
   }, async (args) => {
     const activities = await this.activityService.findByMention(args.query);
     if (activities.length === 0) return toolEmptyResult('activities matching query');
     return toolSuccess(activities.map(a => ({
       id: a.id, name: a.name, type: a.type, status: a.status,
       parentName: a.parent?.name, description: a.description?.substring(0, 100),
     })));
   })
   ```
3. Добавить tool в `getTools()` return array
4. В `unified-extraction.service.ts` prompt: добавить инструкцию:
   ```
   ВАЖНО: Перед созданием нового проекта — ОБЯЗАТЕЛЬНО вызови find_activity для проверки.
   Если проект уже существует — используй existingActivityId вместо создания нового.
   ```
5. Аналогичная инструкция в `group-extraction.service.ts`
6. В `create_event` tool: добавить опциональный параметр `existingActivityId`
7. **Commit:** `feat(extraction): add find_activity tool for duplicate prevention during extraction`
8. **Review:** claude-agent-sdk-expert — проверить tool description quality, tech-lead — prompt correctness
9. **PR → master**

#### Task 2.5: Wave 2 Integration Test & Deploy

| Параметр | Значение |
|----------|----------|
| **Branch** | — |
| **Агент** | qa-engineer + devops |
| **Зависимости** | Tasks 2.1-2.4 |

**Шаги:**
1. qa-engineer: `npx tsc --noEmit` — compilation
2. qa-engineer: Ручной тест extraction — проверить:
   - Activity enrichment работает (description заполняется)
   - Дубликаты Tasks пойманы semantic dedup
   - find_activity вызывается Claude перед create_event
3. devops: Deploy, мониторинг логов
4. devops: Проверить embedding generation в queue

---

### Wave 3: Knowledge Layer

#### Task 3.1: TopicalSegment Entity + Migration

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/topical-segment-entity` |
| **Агент** | backend-developer |
| **Зависимости** | Нет |
| **Блокирует** | Tasks 3.2, 3.4, 3.5, 3.6 |

**Шаги:**
1. `git checkout -b feature/topical-segment-entity master`
2. Создать `packages/entities/src/topical-segment.entity.ts` по спецификации из Phase E (строки 101-328)
3. Создать `packages/entities/src/index.ts` — экспорт
4. Добавить `TopicalSegment` в `apps/pkg-core/src/database/entities.ts`
5. Создать миграцию: `npx typeorm migration:generate -n CreateTopicalSegment`
   - Таблица `topical_segments`
   - Join-таблица `segment_messages`
   - Индексы по спецификации
6. **Commit:** `feat(entities): add TopicalSegment entity with migration`
7. **Review:** tech-lead — проверить entity design, pgvector-expert — индексы
8. **PR → master**

#### Task 3.2: SegmentationModule — CRUD

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/segmentation-module` |
| **Агент** | backend-developer |
| **Зависимости** | Task 3.1 |
| **Блокирует** | Task 3.3 |

**Шаги:**
1. `git checkout -b feature/segmentation-module master`
2. Создать:
   - `apps/pkg-core/src/modules/segmentation/segmentation.module.ts`
   - `apps/pkg-core/src/modules/segmentation/segmentation.service.ts`
   - `apps/pkg-core/src/modules/segmentation/segmentation.controller.ts`
3. `SegmentationService` методы:
   - `createSegment(params)` — создать сегмент
   - `addMessages(segmentId, messageIds)` — добавить сообщения
   - `linkToActivity(segmentId, activityId)` — привязать к Activity
   - `closeSegment(segmentId)` — закрыть сегмент
   - `findByInteraction(interactionId)` — все сегменты interaction
   - `findByActivity(activityId)` — все сегменты Activity
4. REST API:
   - `GET /segmentation/interaction/:id` — segments по interaction
   - `GET /segmentation/activity/:id` — segments по activity
   - `POST /segmentation/segment` — manual creation
5. **Commit:** `feat(segmentation): add SegmentationModule with CRUD operations`
6. **Review:** tech-lead
7. **PR → master**

#### Task 3.3: TopicBoundaryDetector — Автоматическая сегментация

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/topic-boundary-detection` |
| **Агент** | backend-developer + claude-agent-sdk-expert |
| **Зависимости** | Task 3.2 |
| **Блокирует** | Task 3.6 |

**Шаги:**
1. `git checkout -b feature/topic-boundary-detection master`
2. Создать `topic-boundary-detector.service.ts`:
   ```typescript
   detectBoundaries(messages: Message[]): TopicBoundary[]
   ```
   - Heuristic 1: time gap >20 min → boundary
   - Heuristic 2: embedding cosine distance between sliding windows (5 messages) > threshold → boundary
   - Heuristic 3: explicit markers ("кстати", "другая тема", "вернёмся к")
3. Создать `SegmentationService.segmentInteraction(interactionId)`:
   - Load messages → detectBoundaries → create TopicalSegments
   - For each segment: attempt `linkToActivity()` via ProjectMatchingService
   - Set `participantIds` from message senderEntityIds
4. Интеграция: hook в `fact-extraction.processor.ts`:
   ```typescript
   // Before extraction
   await this.segmentationService.segmentInteraction(interactionId);
   ```
5. **Commit:** `feat(segmentation): add automatic topic boundary detection`
6. **Review:** claude-agent-sdk-expert — embedding threshold tuning, tech-lead — integration point
7. **PR → master**

#### Task 3.4: KnowledgePack Entity + Migration

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/knowledge-pack-entity` |
| **Агент** | backend-developer |
| **Зависимости** | Task 3.1 |
| **Блокирует** | Task 3.5 |

**Шаги:**
1. `git checkout -b feature/knowledge-pack-entity master`
2. Создать `packages/entities/src/knowledge-pack.entity.ts` по спецификации (строки 331-449)
3. Добавить в `entities.ts`
4. Создать миграцию
5. **Commit:** `feat(entities): add KnowledgePack entity with migration`
6. **Review:** tech-lead
7. **PR → master**

#### Task 3.5: PackingService — Консолидация знаний

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/packing-service` |
| **Агент** | backend-developer + claude-agent-sdk-expert |
| **Зависимости** | Tasks 3.4, 3.2 |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/packing-service master`
2. Создать `PackingService`:
   - `packByActivity(activityId, periodStart, periodEnd)` — собрать segments → LLM → pack
   - `generatePackContent(segments: TopicalSegment[])` — Claude prompt:
     ```
     Анализируй обсуждения и извлеки:
     - decisions: принятые решения
     - openQuestions: нерешённые вопросы
     - keyFacts: ключевые факты
     - conflicts: противоречия между обсуждениями
     ```
   - `detectConflicts(facts: EntityFact[])` — найти факты с противоречащими значениями
3. Создать scheduled job (BullMQ): weekly packing
4. REST API:
   - `POST /knowledge/pack/:activityId` — manual pack
   - `GET /knowledge/packs` — list packs
   - `GET /knowledge/pack/:id` — pack details
5. **Commit:** `feat(knowledge): add PackingService for knowledge consolidation`
6. **Review:** claude-agent-sdk-expert — prompt quality, tech-lead — architecture
7. **PR → master**

#### Task 3.6: Smart Fusion

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/smart-fusion` |
| **Агент** | backend-developer |
| **Зависимости** | Task 2.2 (semantic dedup infrastructure) |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/smart-fusion master`
2. Расширить `DedupAction` → `FusionAction`:
   ```typescript
   enum FusionAction {
     CREATE = 'create',     // Новый факт
     SKIP = 'skip',         // Полный дубликат
     CONFIRM = 'confirm',   // Повысить confidence
     SUPERSEDE = 'supersede', // Заменить (set validUntil)
     ENRICH = 'enrich',     // Добавить детали
     CONFLICT = 'conflict', // Флаг конфликта → PendingApproval
   }
   ```
3. В `checkDuplicateHybrid()`: логика определения action:
   - Similarity ≥0.90 + same value → CONFIRM
   - Similarity ≥0.80 + different value + same factType → SUPERSEDE/CONFLICT
   - Similarity ≥0.70 + complementary → ENRICH
4. Реализовать каждый action:
   - CONFIRM: `UPDATE entity_facts SET confidence = LEAST(confidence + 0.1, 1.0)`
   - SUPERSEDE: `UPDATE entity_facts SET valid_until = NOW()` + create new
   - ENRICH: `UPDATE entity_facts SET value = value || ' | ' || newInfo`
   - CONFLICT: create PendingApproval с `metadata: { conflicting_fact_id, old_value, new_value }`
5. Создать MCP tool `update_fact` для explicit fact updates
6. **Commit:** `feat(extraction): implement smart fusion (CONFIRM/SUPERSEDE/ENRICH/CONFLICT)`
7. **Review:** tech-lead — data integrity, qa-engineer — edge cases
8. **PR → master**

#### Task 3.7: Cross-Chat Topic Linking

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/cross-chat-linking` |
| **Агент** | backend-developer |
| **Зависимости** | Task 3.3 (сегментация работает) |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/cross-chat-linking master`
2. В `SegmentationService`: метод `findRelatedSegments(segment: TopicalSegment)`:
   - По activityId: все segments с тем же activityId
   - По topic similarity: ILIKE '%topic%' или embedding search
   - По participantIds overlap + time window (±1 hour)
3. Добавить `relatedSegmentIds` в `TopicalSegment` entity (uuid array)
4. В `fact-extraction.processor.ts`: при extraction добавить related context:
   ```typescript
   const segments = await this.segmentationService.findByInteraction(interactionId);
   for (const segment of segments) {
     const related = await this.segmentationService.findRelatedSegments(segment);
     // Add to extraction context
   }
   ```
5. **Commit:** `feat(segmentation): add cross-chat topic linking`
6. **Review:** tech-lead
7. **PR → master**

#### Task 3.8: Entity Disambiguation

| Параметр | Значение |
|----------|----------|
| **Branch** | `feature/entity-disambiguation` |
| **Агент** | backend-developer |
| **Зависимости** | Нет |
| **Блокирует** | — |

**Шаги:**
1. `git checkout -b feature/entity-disambiguation master`
2. Создать `EntityDisambiguationService`:
   ```typescript
   disambiguate(name: string, context: DisambiguationContext): ScoredEntity[]
   ```
   - Context: chatId, mentionedWith (co-occurring names), recentInteractionIds
   - Scoring: recent interaction (+0.3), same chat (+0.2), co-mentioned company (+0.4)
3. В `find_entity_by_name` tool: если >1 match → вернуть `disambiguation_needed: true` с candidates
4. В `create_pending_entity` tool: добавить `context` parameter для future resolve
5. В extraction prompt: инструкция про disambiguation
6. **Commit:** `feat(entity): add entity disambiguation service`
7. **Review:** tech-lead — scoring logic
8. **PR → master**

#### Task 3.9: Wave 3 Integration Test & Deploy

| Параметр | Значение |
|----------|----------|
| **Branch** | — |
| **Агент** | qa-engineer + devops |
| **Зависимости** | Tasks 3.1-3.8 |

**Шаги:**
1. qa-engineer: `npx tsc --noEmit`
2. qa-engineer: Ручной тест:
   - Отправить сообщения → проверить что TopicalSegments создаются
   - Проверить cross-chat linking
   - Проверить Smart Fusion (обновление факта → SUPERSEDE)
   - Запустить manual packing → KnowledgePack создаётся
3. devops: Deploy + миграции
4. devops: Мониторинг логов, проверка таблиц `topical_segments`, `knowledge_packs`

---

## Граф зависимостей

```
Wave 1 (CRITICAL):
  1.1 Persist InferredRelations ──────────┐
  1.2 Fix Commitment↔Activity ────────────┤
  1.3 Strengthen Project Dedup ───────────┤──→ 1.4 Integration Test
                                    │
Wave 2 (HIGH):                      │
  1.3 ──→ 2.1 Activity Enrichment ──┤
  2.2 Semantic Dedup Infra ──→ 2.3 Integration ──┤
  2.4 find_activity Tool ───────────────────────┤──→ 2.5 Integration Test
                                                │
Wave 3 (MEDIUM+):                               │
  3.1 TopicalSegment Entity ──┬──→ 3.2 CRUD ──→ 3.3 AutoSegmentation ──→ 3.7 Cross-Chat
                              └──→ 3.4 KnowledgePack ──→ 3.5 PackingService
  2.2 ──→ 3.6 Smart Fusion
  3.8 Entity Disambiguation (independent)
  ──→ 3.9 Integration Test
```

---

## Проверочный чеклист (после каждой Wave)

### Wave 1 Checklist
- [ ] `POST /extraction/daily/extract-and-save` возвращает `relationsCreated > 0`
- [ ] EntityRelation records создаются в БД для inferred relations
- [ ] Commitment.activityId заполняется для ≥80% commitments с projectName
- [ ] Дубликаты проектов ("PKG Core" vs "pkg-core") пойманы
- [ ] Compilation: `npx tsc --noEmit` без ошибок

### Wave 2 Checklist
- [ ] Существующие Activity обогащаются description, tags, priority при extraction
- [ ] "Подготовить презентацию" и "Сделать презентацию" → пойманы как дубликаты
- [ ] Claude вызывает `find_activity` перед `create_event` (проверить в логах)
- [ ] Embedding columns существуют в activities и commitments
- [ ] Performance: extraction job < 60 секунд

### Wave 3 Checklist
- [ ] Таблицы `topical_segments` и `knowledge_packs` созданы
- [ ] Auto-segmentation создаёт segments для новых interactions
- [ ] Segments привязаны к Activities
- [ ] Smart Fusion: CONFIRM повышает confidence, SUPERSEDE устанавливает validUntil
- [ ] KnowledgePack генерируется для Activity с ≥3 segments
- [ ] Cross-chat segments linked by activityId
- [ ] Entity disambiguation: 2 "Александра" не merge автоматически

---

## Оценка объёма

| Wave | Новый код | Изменения | Миграции | Entities |
|------|-----------|-----------|----------|----------|
| **Wave 1** | ~210 строк | ~90 строк | 0 | 0 |
| **Wave 2** | ~380 строк | ~120 строк | 2 (embedding columns) | 0 |
| **Wave 3** | ~1100 строк | ~200 строк | 2 (topical_segments, knowledge_packs) | 2 |
| **Итого** | ~1690 строк | ~410 строк | 4 миграции | 2 новые entity |

---

## Ссылки

- [Phase E: Knowledge Packing](../second-brain/06-PHASE-E-KNOWLEDGE-PACKING.md)
- [Context-Aware Extraction Design](./2025-01-24-context-aware-extraction-design.md)
- [Conversation-Based Extraction Design](./2025-01-25-conversation-based-extraction-design.md)
- [Extraction Quality Plan (completed)](./fuzzy-tinkering-allen.md)
- [Data Quality Remediation (completed)](./proud-prancing-squid.md)
