---
module: Entity Management
date: 2026-01-30
problem_type: logic_error
component: service_object
symptoms:
  - "Raw SQL queries in FTS/Vector search ignore deleted_at filter"
  - "findByIdentifier returns identifiers for soft-deleted entities"
  - "hardDelete allows deletion of entities with FK references"
  - "restore() has race condition without pessimistic lock"
  - "findOne() returns soft-deleted organization references"
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags: [soft-delete, typeorm, raw-sql, pessimistic-lock, fk-protection]
---

# Soft Delete Code Review Fixes — Entity Module

## Problem

После реализации soft delete для EntityRecord ([см. начальную реализацию](../architecture-decisions/entity-soft-delete-pattern-20260130.md)) code review выявил **6 критических пробелов**, где deleted entities могли "протекать" в результаты или вызывать data integrity issues.

## Symptoms

1. **FTS/Vector Search**: Поиск возвращал сообщения от deleted entities
2. **Entity Resolution**: `findByIdentifier()` возвращал идентификаторы для удалённых сущностей
3. **Hard Delete без проверки FK**: Можно было удалить entity с активными references
4. **Race Condition в restore()**: Concurrent restore requests могли конфликтовать
5. **Organization Ghost Reference**: `findOne()` показывал deleted organization как связанную

## Root Cause Analysis

### TypeORM @DeleteDateColumn Limitation

**Критически важно:** TypeORM `@DeleteDateColumn` автоматически фильтрует ТОЛЬКО ORM запросы (`.find()`, `.findOne()`, QueryBuilder).

**Raw SQL запросы НЕ фильтруются автоматически!**

```typescript
// ✅ TypeORM автоматически добавит WHERE deleted_at IS NULL
await repo.find({ where: { type: 'person' } });

// ❌ Raw SQL — deleted entities возвращаются!
await repo.query('SELECT * FROM entities WHERE type = $1', ['person']);
```

## Solution

### 1. FTS Service — Raw SQL Filtering

**Файл:** `src/modules/search/fts.service.ts`

```typescript
// БЫЛО: JOIN без проверки deleted_at
LEFT JOIN entities e ON m.sender_entity_id = e.id

// СТАЛО: Явная проверка deleted_at
LEFT JOIN entities e ON m.sender_entity_id = e.id AND e.deleted_at IS NULL
```

Добавлено в 3 местах: основной JOIN, subquery для bot filter, participants query.

### 2. Vector Service — Raw SQL Filtering

**Файл:** `src/modules/search/vector.service.ts`

Аналогичные изменения в 3 местах.

### 3. Entity Identifier Resolution

**Файл:** `src/modules/entity/entity-identifier/entity-identifier.service.ts`

```typescript
async findByIdentifier(type: IdentifierType, value: string) {
  const identifier = await this.identifierRepo.findOne({
    where: { identifierType: type, identifierValue: value },
    relations: ['entity'],
  });

  // NEW: Treat soft-deleted entity's identifier as not found
  if (identifier?.entity?.deletedAt) {
    return null;
  }

  return identifier;
}
```

### 4. Hard Delete FK Protection

**Файл:** `src/modules/entity/entity.service.ts`

```typescript
async hardDelete(id: string, confirm: boolean) {
  // ... validation ...

  // NEW: Check FK references before hard delete
  const hasReferences = await this.checkEntityReferences(id);
  if (hasReferences.total > 0) {
    throw new ConflictException(
      `Cannot hard delete: entity has ${hasReferences.total} references ` +
      `(${hasReferences.activities} activities, ${hasReferences.commitments} commitments, ` +
      `${hasReferences.participations} participations). ` +
      `These must be deleted or reassigned first.`,
    );
  }

  await this.entityRepo.remove(entity);
}

private async checkEntityReferences(entityId: string): Promise<{
  activities: number;
  commitments: number;
  participations: number;
  total: number;
}> {
  const [activities, commitments, participations] = await Promise.all([
    this.entityRepo.manager
      .query('SELECT COUNT(*) FROM activities WHERE entity_id = $1', [entityId])
      .then((r) => parseInt(r[0].count, 10)),
    this.entityRepo.manager
      .query('SELECT COUNT(*) FROM commitments WHERE entity_id = $1', [entityId])
      .then((r) => parseInt(r[0].count, 10)),
    this.entityRepo.manager
      .query('SELECT COUNT(*) FROM interaction_participants WHERE entity_id = $1', [entityId])
      .then((r) => parseInt(r[0].count, 10)),
  ]);

  return {
    activities,
    commitments,
    participations,
    total: activities + commitments + participations,
  };
}
```

### 5. Pessimistic Lock in restore()

**Файл:** `src/modules/entity/entity.service.ts`

```typescript
async restore(id: string): Promise<EntityRecord> {
  return this.entityRepo.manager.transaction(async (manager) => {
    // SELECT FOR UPDATE prevents race condition
    const entity = await manager
      .createQueryBuilder(EntityRecord, 'e')
      .setLock('pessimistic_write')
      .where('e.id = :id', { id })
      .withDeleted()
      .getOne();

    if (!entity) {
      throw new NotFoundException(`Entity with id '${id}' not found`);
    }

    if (!entity.deletedAt) {
      throw new BadRequestException(`Entity '${id}' is not deleted`);
    }

    entity.deletedAt = null;
    await manager.save(EntityRecord, entity);

    return manager.findOne(EntityRecord, {
      where: { id },
      relations: ['organization', 'identifiers', 'facts'],
    }) as Promise<EntityRecord>;
  });
}
```

### 6. Deleted Organization Cascade

**Файл:** `src/modules/entity/entity.service.ts`

```typescript
async findOne(id: string) {
  const entity = await this.entityRepo.findOne({
    where: { id },
    relations: ['organization', 'identifiers', 'facts'],
  });

  if (!entity) {
    throw new NotFoundException(`Entity with id '${id}' not found`);
  }

  // NEW: Hide organization link if organization is soft-deleted
  if (entity.organization?.deletedAt) {
    entity.organization = null;
    entity.organizationId = null;
  }

  return entity;
}
```

## Prevention Checklist

При работе с soft delete в TypeORM:

- [ ] **Raw SQL**: Каждый JOIN с soft-deletable таблицей требует `AND deleted_at IS NULL`
- [ ] **Identifier Resolution**: Проверять `entity.deletedAt` перед возвратом
- [ ] **Hard Delete**: Проверять FK references с COUNT queries
- [ ] **Concurrent Operations**: Использовать pessimistic locks в transactions
- [ ] **Cascade Relations**: Проверять deleted status связанных entities при чтении

## Test Coverage

44 unit теста покрывают все сценарии:
- `remove()` использует softRemove
- `restore()` с pessimistic lock
- `hardDelete()` с FK protection
- `findOne()` скрывает deleted organization
- `merge()` использует softRemove для source entity

## Related Issues

- [Entity Soft Delete Pattern](../architecture-decisions/entity-soft-delete-pattern-20260130.md) — начальная реализация
- [PR #103 Code Review Fixes](../code-review-fixes/pr103-entity-activity-extraction-20260130.md) — исправление checkEntityReferences column names (entity_id → owner_entity_id, from_entity_id, to_entity_id)
