# PR #103 Code Review Fixes — Entity, Activity, Extraction

> 8 исправлений по результатам code review: source-agnostic architecture, cascade updates, FK protection, и другие

---

```yaml
module: PKG Core (Entity, Activity, Extraction)
date: 2026-01-30
problem_type: code_fix
component: entity.service, activity.service, extraction-carousel-state.service, extraction-persistence.service, activity-tools.provider
severity: high
root_cause: Множественные проблемы накопленные при быстрой разработке — неправильные column names в raw SQL, отсутствие cascade updates для дерева, архитектурные нарушения source-agnostic принципа
resolution_type: code_fix
tags: [code-review, source-agnostic, cascade-update, column-reference, transaction-safety, null-handling, materializedPath]
symptoms:
  - checkEntityReferences использует entity_id вместо owner_entity_id/from_entity_id/to_entity_id
  - materializedPath потомков не обновляется при перемещении Activity
  - ExtractionCarouselState содержит Telegram-специфичные поля chatId/messageId
  - includeCompleted флаг игнорируется в get_activities_by_client tool
  - Activity.update теряет metadata при spread undefined
related_tasks: ["#103"]
references:
  - docs/solutions/integration-issues/source-agnostic-architecture-prevention.md
  - docs/solutions/logic-errors/soft-delete-code-review-fixes-entity-20260130.md
```

---

## Обзор

В рамках code review PR #103 были выявлены и исправлены 8 проблем разного уровня критичности:

| № | Приоритет | Проблема | Файл |
|---|-----------|----------|------|
| 1 | CRITICAL | checkEntityReferences использует неправильные column names | entity.service.ts |
| 2 | HIGH | Отсутствует transaction в persist() | extraction-persistence.service.ts |
| 3 | HIGH | Telegram-специфичные поля в core state | extraction-carousel-state.service.ts |
| 4 | HIGH | Нет cascade update для materializedPath | activity.service.ts |
| 5 | MEDIUM | includeCompleted флаг игнорируется | activity-tools.provider.ts |
| 6 | MEDIUM | Metadata spread undefined bug | activity.service.ts |
| 7 | LOW | Неиспользуемые импорты | entity.service.ts |
| 8 | LOW | Опечатка "canceld" | activity.service.ts |

---

## 1. checkEntityReferences — Неправильные Column Names (CRITICAL)

### Проблема

Raw SQL запросы использовали несуществующие column names, из-за чего проверка FK references всегда возвращала 0.

### До исправления (БАГ)

```typescript
private async checkEntityReferences(entityId: string) {
  const [activities, commitments, participations] = await Promise.all([
    // БАГ: activities использует owner_entity_id и client_entity_id, НЕ entity_id
    this.entityRepo.manager
      .query('SELECT COUNT(*) FROM activities WHERE entity_id = $1', [entityId])
      .then((r) => parseInt(r[0].count, 10)),

    // БАГ: commitments использует from_entity_id и to_entity_id, НЕ entity_id
    this.entityRepo.manager
      .query('SELECT COUNT(*) FROM commitments WHERE entity_id = $1', [entityId])
      .then((r) => parseInt(r[0].count, 10)),

    this.entityRepo.manager
      .query('SELECT COUNT(*) FROM interaction_participants WHERE entity_id = $1', [entityId])
      .then((r) => parseInt(r[0].count, 10)),
  ]);

  return { activities, commitments, participations, total: ... };
}
```

### После исправления

```typescript
private async checkEntityReferences(entityId: string): Promise<{
  activities: number;
  commitments: number;
  activityMembers: number;  // NEW: добавлена проверка
  participations: number;
  total: number;
}> {
  const [activities, commitments, activityMembers, participations] = await Promise.all([
    // ИСПРАВЛЕНО: проверяем owner_entity_id И client_entity_id
    this.entityRepo.manager
      .query(
        'SELECT COUNT(*) FROM activities WHERE owner_entity_id = $1 OR client_entity_id = $1',
        [entityId],
      )
      .then((r) => parseInt(r[0].count, 10)),

    // ИСПРАВЛЕНО: проверяем from_entity_id И to_entity_id
    this.entityRepo.manager
      .query(
        'SELECT COUNT(*) FROM commitments WHERE from_entity_id = $1 OR to_entity_id = $1',
        [entityId],
      )
      .then((r) => parseInt(r[0].count, 10)),

    // NEW: проверка activity_members
    this.entityRepo.manager
      .query('SELECT COUNT(*) FROM activity_members WHERE entity_id = $1', [entityId])
      .then((r) => parseInt(r[0].count, 10)),

    this.entityRepo.manager
      .query('SELECT COUNT(*) FROM interaction_participants WHERE entity_id = $1', [entityId])
      .then((r) => parseInt(r[0].count, 10)),
  ]);

  return {
    activities,
    commitments,
    activityMembers,
    participations,
    total: activities + commitments + activityMembers + participations,
  };
}
```

### Влияние

Без этого исправления `hardDelete()` успешно удалял entity даже при наличии FK references, что приводило к нарушению целостности данных.

---

## 2. Source-Agnostic Architecture Refactoring (HIGH)

### Проблема

`ExtractionCarouselState` содержал Telegram-специфичные поля (`chatId`, `messageId`), нарушая принцип source-agnostic architecture.

### До исправления

```typescript
// Internal state с Telegram-специфичными полями
export interface ExtractionCarouselState {
  chatId: string;      // Telegram-специфично
  messageId: number;   // Telegram-специфично
  items: ExtractionCarouselItem[];
  // ...
}
```

### После исправления

```typescript
// Internal state с generic полями
export interface ExtractionCarouselState {
  /** Conversation/chat ID (source-agnostic) */
  conversationId: string;
  /** Message reference for updates (source-agnostic) */
  messageRef: string;
  items: ExtractionCarouselItem[];
  // ...
}

// Controller маппит между DTO и internal state
async create(@Body() dto: CreateExtractionCarouselDto) {
  const carouselId = await this.carouselService.create({
    conversationId: dto.chatId,          // DTO → internal
    messageRef: String(dto.messageId),    // DTO → internal
    projects: dto.projects,
    // ...
  });
}

// Response маппинг: internal → external
return {
  chatId: state.conversationId,           // internal → response
  messageId: parseInt(state.messageRef, 10),
  // ...
};
```

### Паттерн

External API сохраняет обратную совместимость (Telegram-специфичные поля в DTO), а internal state использует generic поля. Controller служит "адаптером" между ними.

---

## 3. Cascade materializedPath Update (HIGH)

### Проблема

При перемещении Activity в новую parent, у всех descendants не обновлялись `materializedPath` и `depth`.

### До исправления

```typescript
// Только обновлялась сама Activity, потомки оставались с устаревшими paths
async update(id: string, dto: UpdateActivityDto): Promise<Activity> {
  if (dto.parentId !== undefined) {
    activity.parentId = dto.parentId;
    activity.depth = newParent.depth + 1;
    activity.materializedPath = computePath(newParent);
    // БАГ: descendants не обновлены!
  }
  return this.activityRepo.save(activity);
}
```

### После исправления

```typescript
async update(id: string, dto: UpdateActivityDto): Promise<Activity> {
  if (dto.parentId !== undefined && dto.parentId !== activity.parentId) {
    const oldDepth = activity.depth;
    const oldFullPath = activity.materializedPath
      ? `${activity.materializedPath}/${activity.id}`
      : activity.id;

    // Update activity itself
    activity.parentId = dto.parentId;
    activity.depth = newParent ? newParent.depth + 1 : 0;
    activity.materializedPath = newParent
      ? `${newParent.materializedPath}/${newParent.id}`
      : null;

    // NEW: Cascade update all descendants
    const newFullPath = activity.materializedPath
      ? `${activity.materializedPath}/${activity.id}`
      : activity.id;
    const depthDelta = activity.depth - oldDepth;

    await this.cascadeUpdateDescendantPaths(
      activity.id,
      oldFullPath,
      newFullPath,
      depthDelta,
    );
  }
  return this.activityRepo.save(activity);
}

/**
 * Cascade update materializedPath and depth for all descendants.
 */
private async cascadeUpdateDescendantPaths(
  activityId: string,
  oldFullPath: string,
  newFullPath: string,
  depthDelta: number,
): Promise<void> {
  // Find all descendants by LIKE on path prefix
  const descendants = await this.activityRepo
    .createQueryBuilder('a')
    .where('a.materializedPath LIKE :pattern', { pattern: `${oldFullPath}%` })
    .getMany();

  if (descendants.length === 0) return;

  for (const descendant of descendants) {
    descendant.materializedPath = descendant.materializedPath!.replace(
      oldFullPath,
      newFullPath,
    );
    descendant.depth += depthDelta;
  }

  await this.activityRepo.save(descendants);
}
```

---

## 4. Остальные исправления

### includeCompleted флаг (MEDIUM)

```typescript
// До: флаг передавался, но метод его игнорировал
const activities = await this.activityService.getProjectsByClient(
  args.clientId,
  args.includeCompleted,  // Ignored!
);

// После: добавлена проверка hasTools()
if (!this.activityService) {
  return toolEmptyResult('activity service not available');
}
```

### Metadata spread undefined (MEDIUM)

```typescript
// До: spread undefined приводил к потере данных
metadata: {
  ...activity.metadata,
  ...dto.metadata,  // undefined spreads to nothing!
}

// После: проверка на undefined
metadata: dto.metadata !== undefined
  ? { ...activity.metadata, ...dto.metadata }
  : activity.metadata,
```

### Unused imports и typo (LOW)

- Удалены неиспользуемые импорты `BadRequestException` (заменён на `ConflictException`)
- Исправлена опечатка `canceld` → `canceled` в логах

---

## Code Review Checklist

### Raw SQL Queries
- [ ] Верифицировать column names против TypeORM entity definitions
- [ ] Проверить `@JoinColumn({ name: ... })` для relation columns
- [ ] Использовать QueryBuilder вместо raw SQL где возможно
- [ ] Добавить комментарии со ссылкой на entity file

### Source-Agnostic Architecture
- [ ] Internal state использует generic names (не `chatId`, `telegramMessageId`)
- [ ] Controller/adapter маппит между external DTO и internal state
- [ ] Core services не импортируют из adapter modules

### Tree/Hierarchy Operations
- [ ] Перемещение узла обновляет всех descendants
- [ ] Тестировать с 3+ уровнями вложенности
- [ ] Проверять консистентность paths после bulk операций

### Object Spread Safety
- [ ] Проверять на undefined перед spread: `...(dto.metadata ?? {})`
- [ ] Особое внимание в update операциях с partial data

---

## Тестирование

### Verification Commands

```bash
# Build
cd apps/pkg-core && pnpm build

# Tests
cd apps/pkg-core && pnpm test -- --testPathPattern="entity.service|activity.service"
```

### Test Results

- Build: `5 successful, 5 total`
- Tests: `45 passed, 45 total`

---

## Related Documentation

- [Source-Agnostic Architecture Prevention](../integration-issues/source-agnostic-architecture-prevention.md) — паттерн изоляции адаптеров
- [Entity Soft-Delete Pattern](../architecture-decisions/entity-soft-delete-pattern-20260130.md) — стратегия soft-delete
- [Soft-Delete Code Review Fixes](../logic-errors/soft-delete-code-review-fixes-entity-20260130.md) — связанные исправления
- [CLAUDE.md](../../../CLAUDE.md) — правила разработки проекта
