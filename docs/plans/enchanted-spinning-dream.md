# Entity Soft Delete — Исправление замечаний Code Review

> **Статус:** 🔄 В планировании
> **Дата:** 2026-01-30
> **Контекст:** Code review бизнес-логики soft delete для EntityRecord

---

## Проблема

При ревью реализации soft delete для EntityRecord выявлены критичные пробелы:

1. **Raw SQL запросы игнорируют deleted_at** — поиск (FTS, vector) возвращает удалённые сущности
2. **Entity Resolution по идентификаторам** — findByIdentifier() не проверяет deleted_at связанной entity
3. **Hard delete не проверяет FK** — можно удалить entity с существующими Activity/Commitment
4. **Тесты устарели** — используют `repo.remove()` вместо `softRemove()`

---

## Исправленные проблемы (P0)

✅ **Route conflict** — `@Get('deleted/list')` перемещён перед `@Get(':id')`
✅ **Owner protection** — запрет удаления owner entity в `remove()`
✅ **Merge hard delete** — `merge()` использует `softRemove()` вместо `remove()`

---

## План исправлений

### Шаг 1: Raw SQL фильтрация (P1)

**Проблема:** TypeORM `@DeleteDateColumn` автоматически фильтрует только ORM-запросы. Raw SQL требует явного условия.

#### 1.1 fts.service.ts

**Файл:** `apps/pkg-core/src/modules/search/fts.service.ts`

**Изменения:**

```typescript
// Строка ~32: Основной JOIN
// БЫЛО:
LEFT JOIN entities e ON m.sender_entity_id = e.id

// СТАЛО:
LEFT JOIN entities e ON m.sender_entity_id = e.id AND e.deleted_at IS NULL

// Строки ~38-39: Bot filter subquery
// БЫЛО:
JOIN entities bot_e ON ip.entity_id = bot_e.id
WHERE bot_e.is_bot = true

// СТАЛО:
JOIN entities bot_e ON ip.entity_id = bot_e.id
WHERE bot_e.is_bot = true AND bot_e.deleted_at IS NULL

// Строка ~82: Participants query
// БЫЛО:
LEFT JOIN entities pe ON ip.entity_id = pe.id

// СТАЛО:
LEFT JOIN entities pe ON ip.entity_id = pe.id AND pe.deleted_at IS NULL
```

#### 1.2 vector.service.ts

**Файл:** `apps/pkg-core/src/modules/search/vector.service.ts`

**Изменения:** Аналогичные fts.service.ts (строки ~31, ~37-38, ~81)

#### 1.3 notification.service.ts

**Файл:** `apps/pkg-core/src/modules/notification/notification.service.ts`

**Проверить:** Есть ли raw SQL с JOIN на entities. Если да — добавить фильтр.

---

### Шаг 2: Entity Identifier Resolution (P1)

**Проблема:** `findByIdentifier()` возвращает identifier с удалённой entity.

**Файл:** `apps/pkg-core/src/modules/entity/entity-identifier/entity-identifier.service.ts`

**Изменение:**

```typescript
async findByIdentifier(type: IdentifierType, value: string) {
  const identifier = await this.identifierRepo.findOne({
    where: { identifierType: type, identifierValue: value },
    relations: ['entity'],
  });

  // Проверка: если entity удалена — считаем идентификатор не найденным
  if (identifier?.entity?.deletedAt) {
    return null;
  }

  return identifier;
}
```

**Влияние на вызывающий код:**

| Файл | Использование | Влияние |
|------|---------------|---------|
| `entity-resolution.service.ts` | Entity lookup | ✅ Нулевой identifier → создание pending |
| `interaction-participant.service.ts` | Participant resolve | ✅ Нулевой → pending participant |
| `telegram-adapter` | User sync | ✅ Нулевой → создание нового entity |
| `extraction` | Fact subject | ✅ Нулевой → pending confirmation |

---

### Шаг 3: Hard Delete FK Protection (P1)

**Проблема:** `hardDelete()` не проверяет наличие связанных записей.

**Файл:** `apps/pkg-core/src/modules/entity/entity.service.ts`

**Изменение:**

```typescript
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

  // NEW: Проверка FK references
  const hasReferences = await this.checkEntityReferences(id);
  if (hasReferences.total > 0) {
    throw new ConflictException(
      `Cannot hard delete: entity has ${hasReferences.total} references ` +
      `(${hasReferences.activities} activities, ${hasReferences.commitments} commitments, ` +
      `${hasReferences.participations} participations). ` +
      `These must be deleted or reassigned first.`
    );
  }

  await this.entityRepo.remove(entity);

  this.logger.warn(`HARD deleted entity: ${entity.name} (${id})`);

  return {
    hardDeleted: true,
    id,
    message: 'Entity permanently deleted. This cannot be undone.',
  };
}

// NEW helper method
private async checkEntityReferences(entityId: string): Promise<{
  activities: number;
  commitments: number;
  participations: number;
  total: number;
}> {
  // Используем raw count для производительности
  const [activities, commitments, participations] = await Promise.all([
    this.entityRepo.manager.query(
      'SELECT COUNT(*) FROM activities WHERE entity_id = $1',
      [entityId]
    ).then(r => parseInt(r[0].count, 10)),
    this.entityRepo.manager.query(
      'SELECT COUNT(*) FROM commitments WHERE entity_id = $1',
      [entityId]
    ).then(r => parseInt(r[0].count, 10)),
    this.entityRepo.manager.query(
      'SELECT COUNT(*) FROM interaction_participants WHERE entity_id = $1',
      [entityId]
    ).then(r => parseInt(r[0].count, 10)),
  ]);

  return {
    activities,
    commitments,
    participations,
    total: activities + commitments + participations,
  };
}
```

---

### Шаг 4: Исправление тестов (P1)

**Файл:** `apps/pkg-core/src/modules/entity/entity.service.spec.ts`

#### 4.1 Добавить моки для soft delete методов

```typescript
const mockEntityRepo = {
  // Existing mocks...
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),

  // NEW: Soft delete mocks
  softRemove: jest.fn(),
  recover: jest.fn(),
  findAndCount: jest.fn(),
  remove: jest.fn(),  // Для hardDelete

  manager: {
    transaction: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    query: jest.fn(),  // Для checkEntityReferences
  },
};
```

#### 4.2 Исправить тест remove()

```typescript
describe('remove', () => {
  it('should soft delete entity', async () => {
    const entity = createMockEntity();
    mockEntityRepo.findOne.mockResolvedValue(entity);
    mockEntityRepo.softRemove.mockResolvedValue({ ...entity, deletedAt: new Date() });

    const result = await service.remove(entity.id);

    expect(mockEntityRepo.softRemove).toHaveBeenCalledWith(entity);
    expect(result.deleted).toBe(true);
    expect(result.id).toBe(entity.id);
  });

  it('should prevent deleting owner entity', async () => {
    const ownerEntity = createMockEntity({ isOwner: true });
    mockEntityRepo.findOne.mockResolvedValue(ownerEntity);

    await expect(service.remove(ownerEntity.id))
      .rejects.toThrow(BadRequestException);

    expect(mockEntityRepo.softRemove).not.toHaveBeenCalled();
  });
});
```

#### 4.3 Добавить тесты для новых методов

```typescript
describe('restore', () => {
  it('should restore soft-deleted entity', async () => {
    const deletedEntity = createMockEntity({ deletedAt: new Date() });
    mockEntityRepo.findOne
      .mockResolvedValueOnce(deletedEntity)  // withDeleted: true
      .mockResolvedValueOnce({ ...deletedEntity, deletedAt: null });  // after recover
    mockEntityRepo.recover.mockResolvedValue({ ...deletedEntity, deletedAt: null });

    const result = await service.restore(deletedEntity.id);

    expect(mockEntityRepo.recover).toHaveBeenCalledWith(deletedEntity);
    expect(result.deletedAt).toBeNull();
  });

  it('should throw if entity not deleted', async () => {
    const activeEntity = createMockEntity({ deletedAt: null });
    mockEntityRepo.findOne.mockResolvedValue(activeEntity);

    await expect(service.restore(activeEntity.id))
      .rejects.toThrow(BadRequestException);
  });
});

describe('findDeleted', () => {
  it('should return soft-deleted entities', async () => {
    const deletedEntities = [
      createMockEntity({ deletedAt: new Date() }),
      createMockEntity({ deletedAt: new Date() }),
    ];
    mockEntityRepo.findAndCount.mockResolvedValue([deletedEntities, 2]);

    const result = await service.findDeleted({ limit: 10 });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(mockEntityRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ withDeleted: true })
    );
  });
});

describe('hardDelete', () => {
  it('should permanently delete entity without references', async () => {
    const entity = createMockEntity();
    mockEntityRepo.findOne.mockResolvedValue(entity);
    mockEntityRepo.manager.query
      .mockResolvedValueOnce([{ count: '0' }])  // activities
      .mockResolvedValueOnce([{ count: '0' }])  // commitments
      .mockResolvedValueOnce([{ count: '0' }]); // participations

    const result = await service.hardDelete(entity.id, true);

    expect(mockEntityRepo.remove).toHaveBeenCalledWith(entity);
    expect(result.hardDeleted).toBe(true);
  });

  it('should reject without confirm=true', async () => {
    await expect(service.hardDelete('any-id', false))
      .rejects.toThrow(BadRequestException);
  });

  it('should reject if entity has references', async () => {
    const entity = createMockEntity();
    mockEntityRepo.findOne.mockResolvedValue(entity);
    mockEntityRepo.manager.query
      .mockResolvedValueOnce([{ count: '5' }])  // activities
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([{ count: '0' }]);

    await expect(service.hardDelete(entity.id, true))
      .rejects.toThrow(ConflictException);
  });
});
```

---

### Шаг 5: Тест subject-resolver (P1)

**Файл:** `apps/pkg-core/src/modules/extraction/subject-resolver.service.spec.ts`

Тест уже содержит правильный mock с `deletedAt: null` (строки 61-64). Проверить что все helper-функции корректны.

---

### Шаг 6: Race Condition в restore() (P2)

**Проблема:** Параллельные вызовы `restore()` могут привести к двойному восстановлению.

**Решение:** Использовать optimistic locking или SELECT FOR UPDATE.

```typescript
async restore(id: string): Promise<EntityRecord> {
  return this.entityRepo.manager.transaction(async (manager) => {
    // SELECT FOR UPDATE предотвращает race condition
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

    await manager.recover(EntityRecord, entity);

    return manager.findOne(EntityRecord, {
      where: { id },
      relations: ['organization', 'identifiers', 'facts'],
    });
  });
}
```

---

### Шаг 7: Organization Cascade (P2)

**Проблема:** При soft delete организации сотрудники остаются с `organizationId` указывающим на удалённую организацию.

**Варианты:**

| Вариант | Плюсы | Минусы |
|---------|-------|--------|
| A. Cascade soft delete | Консистентность | Неожиданное поведение |
| B. Clear organizationId | Простота | Потеря связи |
| C. Оставить как есть | Минимум изменений | Нужна проверка при чтении |

**Рекомендация:** Вариант C + добавить проверку в `findOne()`:

```typescript
async findOne(id: string) {
  const entity = await this.entityRepo.findOne({
    where: { id },
    relations: ['organization', 'identifiers', 'facts'],
  });

  if (!entity) {
    throw new NotFoundException(`Entity with id '${id}' not found`);
  }

  // Проверка: если organization удалена — скрыть связь
  if (entity.organization?.deletedAt) {
    entity.organization = null;
    entity.organizationId = null;
  }

  return entity;
}
```

---

## Файлы для модификации

| Файл | Изменение | Приоритет |
|------|-----------|-----------|
| `search/fts.service.ts` | 3 SQL фильтра | P1 |
| `search/vector.service.ts` | 3 SQL фильтра | P1 |
| `entity-identifier/entity-identifier.service.ts` | deletedAt check | P1 |
| `entity/entity.service.ts` | hardDelete FK check, restore lock | P1/P2 |
| `entity/entity.service.spec.ts` | Моки + новые тесты | P1 |

---

## Порядок реализации

```
Шаг 1 ──► Шаг 2 ──► Шаг 3 ──► Шаг 4 ──► Шаг 5 ──► Шаг 6 ──► Шаг 7
  │          │         │          │         │         │         │
  ▼          ▼         ▼          ▼         ▼         ▼         ▼
 FTS/Vec   Ident    HardDel    Tests     Subj     Restore    Org
 filters   check    FK check   fix       test     lock       cascade
```

**Критический путь:** Шаги 1-4 блокируют production readiness.

---

## Verification

### 1. Сборка
```bash
cd apps/pkg-core && pnpm build
```

### 2. Тесты
```bash
cd apps/pkg-core && pnpm test entity.service
cd apps/pkg-core && pnpm test subject-resolver
```

### 3. SQL фильтрация (ручная проверка)
```sql
-- Создать deleted entity
UPDATE entities SET deleted_at = NOW() WHERE id = 'test-uuid';

-- FTS поиск НЕ должен возвращать сообщения от этой entity
SELECT * FROM search_fts('test query');

-- Vector поиск аналогично
SELECT * FROM search_vector('test embedding');
```

### 4. Entity Resolution
```bash
# Через API: поиск по идентификатору удалённой entity
curl localhost:3000/entities/resolve?type=telegram_id&value=12345
# Ожидание: 404 или pending resolution
```

### 5. Hard Delete Protection
```bash
# Попытка hard delete entity с activities
curl -X DELETE "localhost:3000/entities/{id}/hard?confirm=true"
# Ожидание: 409 Conflict с описанием references
```

---

## Риски и митигация

| Риск | Митигация |
|------|-----------|
| SQL фильтры ломают существующие запросы | Тесты перед деплоем |
| findByIdentifier null ломает caller | Все callers уже обрабатывают null |
| checkEntityReferences медленный | Параллельные count запросы |
| restore lock deadlocks | Короткая транзакция, один ресурс |
