# Plan: Data Quality Remediation + Agent Tools

> Устранение проблем первого DQ-аудита и расширение agent tools

## Статус

| Phase | Описание | Статус |
|-------|----------|--------|
| 5.1 | normalizeName + autoMergeAllDuplicates | ✅ Done |
| 5.2 | OrphanResolutionService + auto-assign | ✅ Done |
| 5.3 | Auto-resolve missing clients | ✅ Done |
| 5.4 | Agent Tools — CRUD + auto-fix | ✅ Done |
| 5.5 | Extraction pipeline prevention | ✅ Done |
| 5.6 | Documentation | ✅ Done |

## Контекст

Первый аудит на продакшене (2026-02-06) выявил:
- **9 duplicate groups** (13 issues) — exact name match
- **88 orphaned tasks** — без parentId
- **7 projects без client** entity
- **activityMemberCoverage: 9%**, commitmentLinkageRate: 0%, fieldFillRate: 29%

---

## Phase 5.1: Auto-Merge Duplicates + Name Normalization (1 день)

### 5.1.1 `normalizeName()` в ProjectMatchingService

**Файл:** `src/modules/extraction/project-matching.service.ts`

Добавить static метод:
```typescript
static normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*(?:₽|руб|rub|тыс|млн|usd|eur|\$|k\b|m\b)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!]+$/, '')
    .trim();
}
```

Использовать в `calculateSimilarity()` перед вычислением Levenshtein.

**Тесты:** `project-matching.service.spec.ts`
- `normalizeName("Оплата Рег.ру - хостинг (424.39₽)") === "оплата рег.ру - хостинг"`
- `normalizeName("  My Project  (1.5M RUB)  ") === "my project"`
- Verify similarity вычисляется на нормализованных именах

### 5.1.2 `autoMergeAllDuplicates()` в DataQualityService

**Файл:** `src/modules/data-quality/data-quality.service.ts`

```typescript
interface AutoMergeResult {
  mergedGroups: number;
  totalMerged: number;
  errors: Array<{ group: string; error: string }>;
  details: Array<{ keptId: string; keptName: string; mergedIds: string[] }>;
}

async autoMergeAllDuplicates(): Promise<AutoMergeResult>
```

Логика выбора keeper: наибольшее кол-во children → members → самый старый createdAt.
Итерирует группы, вызывает существующий `mergeActivities(keepId, mergeIds)`.
Ловит ошибки per-group, продолжает при сбое.

### 5.1.3 REST endpoint

**Файл:** `src/modules/data-quality/data-quality.controller.ts`

```typescript
@Post('auto-merge-duplicates')
async autoMergeDuplicates(): Promise<AutoMergeResult>
```

---

## Phase 5.2: Auto-Assign Orphaned Tasks (1-2 дня)

### 5.2.1 OrphanResolutionService

**Новый файл:** `src/modules/data-quality/orphan-resolution.service.ts`

```typescript
@Injectable()
export class OrphanResolutionService {
  constructor(
    @InjectRepository(Activity) private activityRepo: Repository<Activity>,
    @InjectRepository(ActivityMember) private memberRepo: Repository<ActivityMember>,
    private projectMatchingService: ProjectMatchingService,
    private activityService: ActivityService,
  ) {}

  async resolveOrphans(orphanedTasks: Activity[]): Promise<OrphanResolutionResult>
}
```

**Стратегии (по приоритету):**

1. **By Name Containment** — если имя задачи содержит имя активного проекта (ILIKE), назначить как child. Пример: "Fix bug in Alpha" → проект "Alpha".

2. **By Batch** — если у задачи `metadata.draftBatchId`, найти проекты в той же batch-группе. Query: `Activity WHERE metadata->>'draftBatchId' = :batchId AND parentId IS NOT NULL`.

3. **By Owner's Single Project** — если у owner только один активный PROJECT, назначить туда.

4. **Fallback → "Unsorted Tasks"** — создать или найти проект `name: "Unsorted Tasks"`, `type: PROJECT`, `status: ACTIVE`. Orphans без match идут туда.

Для каждого назначения вызывать `activityService.update(taskId, { parentId })` для cascade обновления depth/materializedPath.

```typescript
interface OrphanResolutionResult {
  resolved: number;
  unresolved: number;
  createdUnsortedProject: boolean;
  details: Array<{
    taskId: string; taskName: string;
    assignedParentId: string; assignedParentName: string;
    method: 'name_containment' | 'batch' | 'single_project' | 'unsorted';
  }>;
}
```

### 5.2.2 Интеграция в DataQualityService

**Файл:** `src/modules/data-quality/data-quality.service.ts`

```typescript
async autoAssignOrphanedTasks(): Promise<OrphanResolutionResult>
```
Делегирует в `OrphanResolutionService.resolveOrphans()`.

### 5.2.3 Module updates

**Файл:** `src/modules/data-quality/data-quality.module.ts`

- Import `ActivityModule` (для ActivityService, ActivityValidationService)
- Import `ExtractionModule` (для ProjectMatchingService)
- Register `OrphanResolutionService` в providers

### 5.2.4 REST endpoint

```typescript
@Post('auto-assign-orphans')
async autoAssignOrphans(): Promise<OrphanResolutionResult>
```

**Тесты:** `orphan-resolution.service.spec.ts`
- Task "Fix Alpha bug" → проект "Alpha" (name containment)
- Task с batchId → проект из той же batch
- Task без match → "Unsorted Tasks"
- Cascade depth/path при assign

**Зависит от:** Phase 5.1 (normalizeName)

---

## Phase 5.3: Missing Client Resolution (0.5 дня)

### 5.3.1 `autoResolveClients()` в DataQualityService

**Файл:** `src/modules/data-quality/data-quality.service.ts`

```typescript
interface ClientResolutionBatchResult {
  resolved: number;
  unresolved: number;
  details: Array<{
    activityId: string; activityName: string;
    clientEntityId: string; clientName: string;
    method: ClientResolutionMethod;
  }>;
}

async autoResolveClients(): Promise<ClientResolutionBatchResult>
```

Логика:
1. `findMissingClientEntity()` → список activities без клиента
2. Для каждой: получить ActivityMembers → собрать participant names
3. Вызвать `ClientResolutionService.resolveClient({ participants, ownerEntityId })`
4. Если resolved → `activityRepo.update(id, { clientEntityId })`

### 5.3.2 Module updates

**Файл:** `src/modules/data-quality/data-quality.module.ts`

- Import `ExtractionModule` (уже нужен из 5.2 — ClientResolutionService экспортирован)
- Inject `ClientResolutionService` в DataQualityService constructor

### 5.3.3 REST endpoint

```typescript
@Post('auto-resolve-clients')
async autoResolveClients(): Promise<ClientResolutionBatchResult>
```

**Тесты:** в `data-quality.service.spec.ts`
- Activity с members из известной организации → client assigned
- Activity без members → unresolved

**Зависит от:** Phase 5.2 (module wiring)

---

## Phase 5.4: Agent Tools — Activity CRUD + Management (1-2 дня)

### 5.4.1 Write tools в ActivityToolsProvider

**Файл:** `src/modules/claude-agent/tools/activity-tools.provider.ts`

Добавить в constructor: `ActivityValidationService`, `ActivityMemberService`, `CommitmentService` (все уже экспортируются из ActivityModule).

**Новые tools (4 шт.):**

#### `create_activity`
- Params: name, activityType, description?, parentId?, ownerEntityId, clientEntityId?, context?, priority?, deadline?, tags?
- Валидация иерархии через `activityValidationService.validateCreate()`
- Вызов `activityService.create(dto)`
- Возврат: id, name, type, parentId, status

#### `update_activity`
- Params: activityId, name?, description?, parentId? (nullable), clientEntityId? (nullable), context?, priority?, deadline? (nullable), tags? (nullable), progress?
- Если parentId меняется → `activityValidationService.validateUpdate()`
- Вызов `activityService.update(activityId, dto)`
- Возврат: обновлённая activity

#### `manage_activity_members`
- Params: activityId, action (add|remove), entityId, role? (default: member)
- add → `activityMemberService.addMember()`
- remove → `activityMemberService.deactivateMember()`

#### `assign_commitment_to_activity`
- Params: commitmentId, activityId (nullable — для unlink)
- Вызов `commitmentService.update(commitmentId, { activityId })`

### 5.4.2 Auto-fix tool в DataQualityToolsProvider

**Файл:** `src/modules/data-quality/data-quality-tools.provider.ts`

#### `auto_fix_data_quality`
- Params: fixDuplicates? (default true), fixOrphans? (default true), fixClients? (default true)
- Последовательный вызов: autoMergeAllDuplicates → autoAssignOrphanedTasks → autoResolveClients
- Возврат: combined summary

### 5.4.3 Module wiring

**Файл:** `src/modules/claude-agent/claude-agent.module.ts` (или activity-tools registration)

Убедиться что ActivityToolsProvider имеет доступ к: ActivityValidationService, ActivityMemberService, CommitmentService.

**Тесты:** `activity-tools.provider.spec.ts` (новый файл)
- create_activity с валидной иерархией
- create_activity с невалидной иерархией → toolError
- update_activity с изменением parentId
- manage_activity_members add/remove
- assign_commitment_to_activity link/unlink

**Зависит от:** Phases 5.1-5.3 (для auto_fix_data_quality)

---

## Phase 5.5: Extraction Pipeline Prevention (1 день)

### 5.5.1 Two-tier matching threshold

**Файл:** `src/modules/extraction/draft-extraction.service.ts`

Изменить `findExistingProjectEnhanced()`:
- **>= 0.8** — strong match, skip creation (текущее поведение)
- **0.6-0.8** — weak match, создать но добавить в metadata: `{ possibleDuplicate: { matchedActivityId, matchedName, similarity } }`
- **< 0.6** — no match, создать как обычно

### 5.5.2 Normalization в projectMap

**Файл:** `src/modules/extraction/draft-extraction.service.ts`

Заменить `project.name.toLowerCase()` на `ProjectMatchingService.normalizeName(project.name)` в projectMap key.

### 5.5.3 Task deduplication

**Файл:** `src/modules/extraction/draft-extraction.service.ts`

Добавить `findExistingTaskEnhanced()`:
1. Проверить pending approvals (текущее поведение)
2. Проверить активные tasks с ILIKE match для этого owner
3. Threshold 0.7 для skip

**Тесты:** обновить `draft-extraction.service.spec.ts`
- Проект с cost annotation → match после нормализации
- Two-tier: similarity 0.75 → create with possibleDuplicate flag
- Task с similarity > 0.7 к existing → skip

**Зависит от:** Phase 5.1 (normalizeName)

---

## Phase 5.6: Documentation (0.5 дня)

### 5.6.1 Обновить docs/API_CONTRACTS.md

Добавить новые endpoints:
- `POST /data-quality/auto-merge-duplicates`
- `POST /data-quality/auto-assign-orphans`
- `POST /data-quality/auto-resolve-clients`

### 5.6.2 Обновить docs/second-brain/INDEX.md

Добавить Phase 5 (Data Quality Remediation) как completed.

### 5.6.3 Workflow документация

Добавить в docs/ пример workflow:
```
Extraction → Activity(draft) → Approval → Activity(active)
                                       → Commitment(linked via activityId)
                                       → ActivityMember(auto-created)
```

---

## Граф зависимостей

```
Phase 5.1 (normalizeName + autoMerge)
   ├──→ Phase 5.2 (orphan resolution) ─┐
   ├──→ Phase 5.3 (client resolution)──┤
   └──→ Phase 5.5 (extraction prevent) │
                                        ├──→ Phase 5.4 (agent tools)
                                        │       └──→ Phase 5.6 (docs)
```

5.2 и 5.3 можно параллелить. 5.5 можно параллелить с 5.2/5.3.

## Ключевые файлы

| Файл | Операция |
|------|----------|
| `src/modules/extraction/project-matching.service.ts` | MODIFY — normalizeName() |
| `src/modules/data-quality/data-quality.service.ts` | MODIFY — autoMerge, autoAssign, autoResolve |
| `src/modules/data-quality/data-quality.controller.ts` | MODIFY — 3 новых endpoint |
| `src/modules/data-quality/data-quality.module.ts` | MODIFY — imports ActivityModule, ExtractionModule |
| `src/modules/data-quality/orphan-resolution.service.ts` | CREATE — новый сервис |
| `src/modules/claude-agent/tools/activity-tools.provider.ts` | MODIFY — 4 новых tool |
| `src/modules/data-quality/data-quality-tools.provider.ts` | MODIFY — auto_fix tool |
| `src/modules/extraction/draft-extraction.service.ts` | MODIFY — two-tier, normalization, task dedup |

## Verification

1. `pnpm test` — все существующие + новые тесты проходят
2. `POST /data-quality/auto-merge-duplicates` на prod → duplicateGroups = 0
3. `POST /data-quality/auto-assign-orphans` на prod → orphanedTasks уменьшился
4. `POST /data-quality/auto-resolve-clients` на prod → missingClientEntity уменьшился
5. `POST /data-quality/audit` — повторный аудит показывает улучшение метрик
6. Agent tools: `create_activity`, `update_activity`, `manage_activity_members`, `assign_commitment_to_activity` работают через Claude Agent
