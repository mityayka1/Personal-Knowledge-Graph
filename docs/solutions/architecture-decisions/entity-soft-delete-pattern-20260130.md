---
module: Entity/DataIntegrity
date: 2026-01-30
problem_type: architecture_decision
component: entity_management
symptoms:
  - "При удалении Entity нарушаются FK связи в Activity/Commitment"
  - "Потеря данных при случайном удалении контакта"
  - "Невозможность восстановить удалённую сущность"
root_cause: missing_soft_delete
severity: high
tags: [typeorm, soft-delete, fk-constraints, entity, data-integrity, activity, commitment]
related_tasks: ["#18"]
---

# Soft Delete для EntityRecord

## Симптом

При попытке удалить Entity, на которую ссылаются Activity или Commitment записи, возникает ошибка FK constraint violation. Даже без ошибки — жёсткое удаление приводит к потере всех связанных данных без возможности восстановления.

## Бизнес-контекст

**Entity** — центральная сущность системы PKG (Person или Organization). На неё ссылаются:

| Таблица | FK поле | Описание |
|---------|---------|----------|
| `activities` | `entity_id` | Действия связанные с контактом |
| `commitments` | `entity_id` | Обязательства и обещания |
| `interaction_participants` | `entity_id` | Участники чатов/звонков |
| `entity_facts` | `entity_id` | Факты о контакте |
| `entity_identifiers` | `entity_id` | Телефоны, email, telegram |

При удалении Entity возможны 3 стратегии:

| Стратегия | Плюсы | Минусы |
|-----------|-------|--------|
| **CASCADE** | Автоматическая очистка | Потеря данных Activity/Commitment |
| **SET NULL** | Сохранение Activity | "Осиротевшие" записи без контекста |
| **Soft Delete** | Полное сохранение, восстановление | Усложнение запросов (решается TypeORM) |

## Решение

Выбран **Soft Delete** через TypeORM `@DeleteDateColumn`:

### 1. Entity с DeleteDateColumn

```typescript
// packages/entities/src/entity.entity.ts
import {
  DeleteDateColumn,
  Index,
} from 'typeorm';

@Entity('entities')
export class EntityRecord {
  // ... existing fields ...

  /**
   * Soft delete timestamp.
   * When set, entity is considered deleted but data is preserved.
   * TypeORM automatically excludes soft-deleted entities from queries.
   * Use { withDeleted: true } to include them.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  @Index('idx_entities_deleted_at')
  deletedAt: Date | null;

  /**
   * Check if entity is soft-deleted.
   */
  get isDeleted(): boolean {
    return this.deletedAt !== null;
  }
}
```

### 2. Service методы

```typescript
// apps/pkg-core/src/modules/entity/entity.service.ts

/**
 * Soft delete an entity.
 * Marks entity as deleted but preserves all data.
 * Related Activity/Commitment records remain intact.
 */
async remove(id: string) {
  const entity = await this.findOne(id);
  await this.entityRepo.softRemove(entity);

  this.logger.log(`Soft deleted entity: ${entity.name} (${id})`);

  return {
    deleted: true,
    id,
    deletedAt: new Date(),
    message: 'Entity soft deleted. Use POST /entities/:id/restore to recover.',
  };
}

/**
 * Restore a soft-deleted entity.
 */
async restore(id: string): Promise<EntityRecord> {
  const entity = await this.entityRepo.findOne({
    where: { id },
    withDeleted: true,  // Include soft-deleted
    relations: ['organization', 'identifiers', 'facts'],
  });

  if (!entity) {
    throw new NotFoundException(`Entity with id '${id}' not found`);
  }

  if (!entity.deletedAt) {
    throw new BadRequestException(`Entity '${id}' is not deleted`);
  }

  await this.entityRepo.recover(entity);
  return this.findOne(id);
}

/**
 * Find all soft-deleted entities.
 */
async findDeleted(options: { limit?: number; offset?: number } = {}) {
  const { limit = 50, offset = 0 } = options;

  const [items, total] = await this.entityRepo.findAndCount({
    where: { deletedAt: Not(IsNull()) },
    withDeleted: true,
    order: { deletedAt: 'DESC' },
    take: limit,
    skip: offset,
  });

  return { items, total, limit, offset };
}

/**
 * Permanently delete an entity (hard delete).
 * USE WITH CAUTION: This cannot be undone.
 */
async hardDelete(id: string, confirm: boolean) {
  if (!confirm) {
    throw new BadRequestException(
      'Hard delete requires explicit confirmation. Set confirm=true to proceed.',
    );
  }

  const entity = await this.entityRepo.findOne({
    where: { id },
    withDeleted: true,
  });

  if (!entity) {
    throw new NotFoundException(`Entity with id '${id}' not found`);
  }

  await this.entityRepo.remove(entity);

  this.logger.warn(`HARD deleted entity: ${entity.name} (${id})`);

  return {
    hardDeleted: true,
    id,
    message: 'Entity permanently deleted. This cannot be undone.',
  };
}
```

### 3. API Endpoints

```typescript
// apps/pkg-core/src/modules/entity/entity.controller.ts

/**
 * Soft delete an entity.
 */
@Delete(':id')
async remove(@Param('id', ParseUUIDPipe) id: string) {
  return this.entityService.remove(id);
}

/**
 * Restore a soft-deleted entity.
 */
@Post(':id/restore')
async restore(@Param('id', ParseUUIDPipe) id: string) {
  return this.entityService.restore(id);
}

/**
 * Get all soft-deleted entities.
 */
@Get('deleted/list')
async findDeleted(
  @Query('limit') limit?: number,
  @Query('offset') offset?: number,
) {
  return this.entityService.findDeleted({ limit, offset });
}

/**
 * Permanently delete an entity (CANNOT BE UNDONE).
 */
@Delete(':id/hard')
async hardDelete(
  @Param('id', ParseUUIDPipe) id: string,
  @Query('confirm') confirm?: string,
) {
  return this.entityService.hardDelete(id, confirm === 'true');
}
```

### 4. Миграция

```typescript
// apps/pkg-core/src/database/migrations/1769900000000-AddSoftDeleteToEntities.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSoftDeleteToEntities1769900000000 implements MigrationInterface {
  name = 'AddSoftDeleteToEntities1769900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "entities"
      ADD COLUMN "deleted_at" TIMESTAMPTZ DEFAULT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_entities_deleted_at"
      ON "entities" ("deleted_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_entities_deleted_at"
    `);

    await queryRunner.query(`
      ALTER TABLE "entities"
      DROP COLUMN "deleted_at"
    `);
  }
}
```

## Файлы

| Файл | Изменение |
|------|-----------|
| `packages/entities/src/entity.entity.ts` | `@DeleteDateColumn`, `isDeleted` getter |
| `apps/pkg-core/src/modules/entity/entity.service.ts` | `remove()`, `restore()`, `findDeleted()`, `hardDelete()` |
| `apps/pkg-core/src/modules/entity/entity.controller.ts` | REST endpoints |
| `apps/pkg-core/src/database/migrations/1769900000000-AddSoftDeleteToEntities.ts` | Миграция |

## Проверка

```sql
-- Проверить наличие колонки
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'entities' AND column_name = 'deleted_at';

-- Проверить индекс
SELECT indexname FROM pg_indexes
WHERE tablename = 'entities' AND indexname = 'idx_entities_deleted_at';

-- Тест soft delete
UPDATE entities SET deleted_at = NOW() WHERE id = 'test-uuid';
-- Обычный SELECT не вернёт эту запись
-- SELECT с withDeleted: true вернёт
```

## TypeORM Поведение

| Операция | Метод | Эффект |
|----------|-------|--------|
| Soft delete | `repo.softRemove(entity)` | Устанавливает `deleted_at = NOW()` |
| Restore | `repo.recover(entity)` | Очищает `deleted_at = NULL` |
| Hard delete | `repo.remove(entity)` | Физическое удаление из БД |
| Query | `repo.find()` | Автоматически исключает `deleted_at IS NOT NULL` |
| Query all | `repo.find({ withDeleted: true })` | Включает удалённые записи |

## Предотвращение

### Паттерн: Soft Delete для связанных сущностей

```
┌─────────────────────────────────────────────────────────────┐
│ Шаг 1: Оценка связей                                        │
│   - Сколько таблиц ссылается на сущность?                  │
│   - Критичны ли связанные данные для бизнеса?              │
├─────────────────────────────────────────────────────────────┤
│ Шаг 2: Выбор стратегии                                      │
│   - Нет критичных связей → Hard delete допустим            │
│   - Есть связи, данные важны → Soft delete                 │
│   - Данные для аудита → Soft delete обязателен             │
├─────────────────────────────────────────────────────────────┤
│ Шаг 3: Реализация                                           │
│   - @DeleteDateColumn для soft delete                       │
│   - Индекс на deleted_at для производительности            │
│   - Явный hardDelete() с confirm=true для необратимых ops  │
└─────────────────────────────────────────────────────────────┘
```

### Checklist для новых сущностей с FK связями

При создании Entity с внешними связями:
- [ ] Оценить: нужен ли soft delete?
- [ ] Если да: добавить `@DeleteDateColumn`
- [ ] Создать индекс на `deleted_at`
- [ ] Реализовать `restore()` и `findDeleted()` методы
- [ ] Добавить `hardDelete()` с подтверждением
- [ ] Документировать API endpoints

### Когда НЕ использовать Soft Delete

- Временные/кэш данные (sessions, tokens)
- Данные без бизнес-ценности после удаления
- Таблицы с высокой частотой insert/delete (логи)

## Связанные материалы

- [TypeORM Soft Delete](https://typeorm.io/delete-query-builder#soft-delete)
- [PostgreSQL Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
- Задача #18: FK constraints для Activity/Commitment
- `packages/entities/src/entity.entity.ts` — Entity definition
- [Code Review Fixes](../logic-errors/soft-delete-code-review-fixes-entity-20260130.md) — исправления найденных при code review пробелов
- [PR #103 Fixes](../code-review-fixes/pr103-entity-activity-extraction-20260130.md) — checkEntityReferences column fixes, cascade materializedPath
