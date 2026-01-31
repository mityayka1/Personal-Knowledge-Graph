# TypeORM Closure-Table ClosureSubjectExecutor Bug

## Metadata

```yaml
category: database-issues
severity: high
component: Activity Entity, DraftExtractionService, ActivityService
symptoms:
  - "Cannot read properties of undefined (reading 'getEntityValue')"
  - Activity creation fails silently
  - Projects and Tasks not created while Commitments succeed
tags:
  - typeorm
  - closure-table
  - tree-entities
  - orm-bug
created: 2026-01-31
related_issues:
  - https://github.com/typeorm/typeorm/issues/9658
  - https://github.com/typeorm/typeorm/issues/11302
commits:
  - 4279493 (TreeRepository attempt)
  - f3ab50c (remove transactions)
  - 2c00ac6 (QueryBuilder fix)
  - fd44ba5 (ActivityService fix)
```

## Problem

При создании Activity сущностей (проекты, задачи) с декоратором `@Tree('closure-table')` возникает ошибка:

```
Cannot read properties of undefined (reading 'getEntityValue')
```

Ошибка происходит в `ClosureSubjectExecutor.insert()` при вызове `repository.save()` или `EntityManager.save()`.

**Важно:** Commitment сущности создавались успешно, а Activity — нет.

## Root Cause

TypeORM 0.3.x имеет баг в `ClosureSubjectExecutor`, который обрабатывает closure-table операции:

1. При вызове `save()` на entity с `@Tree('closure-table')` TypeORM запускает `ClosureSubjectExecutor`
2. Executor пытается получить значения полей через внутренний метод `getEntityValue`
3. В определённых условиях (transaction context, entity state) этот метод возвращает `undefined`
4. Результат: `Cannot read properties of undefined (reading 'getEntityValue')`

**Почему Commitment работает, а Activity нет:**
- `Commitment` entity НЕ имеет декоратор `@Tree` → стандартный ORM save → работает
- `Activity` entity ИМЕЕТ `@Tree('closure-table')` → ClosureSubjectExecutor → падает

## Investigation Steps

### Попытка 1: TreeRepository
```typescript
// Гипотеза: closure-table требует TreeRepository
const treeRepo = manager.getTreeRepository(Activity);
const savedActivity = await treeRepo.save(activity);
// Результат: Ошибка осталась — TreeRepository использует тот же Executor
```

### Попытка 2: Убрать транзакции
```typescript
// Гипотеза: Transaction context вызывает баг
// Было:
await this.dataSource.transaction(async (manager) => {
  await manager.save(activity);
});

// Стало:
await this.activityRepo.save(activity);
// Результат: Частично помогло, но не полностью
```

### Попытка 3: QueryBuilder.insert() ✅
```typescript
// Гипотеза: INSERT обходит closure-table логику
await this.activityRepo
  .createQueryBuilder()
  .insert()
  .into(Activity)
  .values({ id, name, ... })
  .execute();
// Результат: УСПЕХ — closure-table Executor не вызывается
```

## Solution

Использовать `QueryBuilder.insert()` вместо `repository.save()` для создания Activity сущностей.

### Паттерн решения

```typescript
import { randomUUID } from 'crypto';

async createActivity(dto: CreateActivityDto): Promise<Activity> {
  // 1. Вычислить depth и materializedPath
  let depth = 0;
  let materializedPath: string | null = null;

  if (dto.parentId) {
    const parent = await this.activityRepo.findOne({ where: { id: dto.parentId } });
    if (parent) {
      depth = parent.depth + 1;
      materializedPath = parent.materializedPath
        ? `${parent.materializedPath}/${parent.id}`
        : parent.id;
    }
  }

  // 2. Сгенерировать ID вручную (QueryBuilder не возвращает entity)
  const activityId = randomUUID();

  // 3. Использовать QueryBuilder вместо save()
  await this.activityRepo
    .createQueryBuilder()
    .insert()
    .into(Activity)
    .values({
      id: activityId,
      name: dto.name,
      activityType: dto.activityType,
      status: dto.status ?? ActivityStatus.ACTIVE,
      parentId: dto.parentId ?? null,
      depth,
      materializedPath,
      ownerEntityId: dto.ownerEntityId,
      // ... остальные поля
    })
    .execute();

  // 4. Загрузить созданную entity
  return this.activityRepo.findOneOrFail({ where: { id: activityId } });
}
```

### Ключевые моменты

1. **Pre-generate UUID** — QueryBuilder не возвращает созданную entity
2. **Compute depth/materializedPath** — TypeORM не делает это автоматически при INSERT
3. **Fetch after insert** — для получения entity с relations
4. **No transactions** — orphaned entities чистятся cleanup cron job

### Применённые файлы

| Файл | Изменение |
|------|-----------|
| `draft-extraction.service.ts` | `createDraftProject()`, `createDraftTask()` |
| `activity.service.ts` | `create()` |
| `activity.entity.ts` | Документация в JSDoc |

## Prevention

### 1. Документация в Entity

```typescript
/**
 * Activity — универсальная сущность для всех "дел" человека.
 *
 * ВАЖНО: Из-за бага TypeORM 0.3.x с ClosureSubjectExecutor, для создания
 * новых Activity используй QueryBuilder.insert() вместо repository.save().
 * @see https://github.com/typeorm/typeorm/issues/9658
 */
@Entity('activities')
@Tree('closure-table')
export class Activity {
  // ...
}
```

### 2. Правило для Code Review

При review кода с `@Tree('closure-table')` entities:
- ❌ Не использовать `repository.save()` для создания
- ❌ Не использовать `EntityManager.save()` для создания
- ✅ Использовать `QueryBuilder.insert()` для создания
- ✅ `save()` можно использовать для UPDATE (осторожно)

### 3. Cleanup Service

Для обработки orphaned entities (Activity без PendingApproval):

```typescript
@Cron('0 3 * * *') // Ежедневно в 3:00
async cleanupOrphanedDrafts(): Promise<void> {
  // Удаляем draft Activity без связанных PendingApproval
}
```

## Trade-offs

| Аспект | Было (save) | Стало (QueryBuilder) |
|--------|-------------|---------------------|
| Атомарность | Транзакция | Нет (cleanup service) |
| Closure-table | Автоматически | Не заполняется |
| Return value | Entity | null (нужен fetch) |
| depth/path | Автоматически | Вручную |
| Валидация | Entity hooks | Только DB constraints |

## Related Documentation

- [TypeORM Nullable Column 'Object' Type Error](../integration-issues/typeorm-nullable-column-object-type-20260131.md)
- [Entity Soft Delete Pattern](../architecture-decisions/entity-soft-delete-pattern-20260130.md)
- [Confidence CHECK Constraint](./confidence-check-constraint-20250125.md)

## External References

- [TypeORM Issue #9658](https://github.com/typeorm/typeorm/issues/9658) — ClosureSubjectExecutor bug
- [TypeORM Issue #11302](https://github.com/typeorm/typeorm/issues/11302) — Related tree entity issues
- [TypeORM Tree Entities Docs](https://typeorm.io/tree-entities) — Official documentation
