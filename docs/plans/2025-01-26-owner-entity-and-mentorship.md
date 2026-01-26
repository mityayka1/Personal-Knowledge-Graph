# Owner Entity & Mentorship Relations — Design

> **Статус:** 🔄 In Progress
> **Дата:** 2025-01-26

---

## Проблема

1. **Нет типа связи "учитель-ученик"** — невозможно записать "Татьяна Юрьевна — учитель Ивана"
2. **Нет концепции "Я"** — невозможно создать связи "Иван — мой сын", "связи со мной"

---

## Решение

### 1. Добавить RelationType.MENTORSHIP

```typescript
MENTORSHIP = 'mentorship', // roles: mentor, mentee
```

**Use cases:**
- Учитель → ученик
- Тренер → подопечный
- Наставник → стажёр

### 2. Добавить поле `isOwner` в EntityRecord

```typescript
@Column({ name: 'is_owner', type: 'boolean', default: false, unique: true })
isOwner: boolean;
```

**Ограничения:**
- Только одна entity может быть `isOwner = true`
- При установке `isOwner = true` сбрасывать у других

**API:**
- `GET /entities/me` — получить "мою" entity
- `POST /entities/:id/set-owner` — назначить entity как "Я"

### 3. Миграции

```sql
-- 1. Add MENTORSHIP to relation_type enum
ALTER TYPE relation_type ADD VALUE 'mentorship';

-- 2. Add is_owner column
ALTER TABLE entities ADD COLUMN is_owner BOOLEAN DEFAULT FALSE;
CREATE UNIQUE INDEX idx_entities_owner ON entities (is_owner) WHERE is_owner = TRUE;
```

---

## Файлы для изменения

### Entities
- `packages/entities/src/relation-type.enum.ts` — добавить MENTORSHIP
- `packages/entities/src/entity.entity.ts` — добавить isOwner

### Migrations
- `apps/pkg-core/src/database/migrations/XXXXXX-AddMentorshipAndOwner.ts`

### Services
- `apps/pkg-core/src/modules/entity/entity.service.ts` — findMe(), setOwner()
- `apps/pkg-core/src/modules/entity/entity.controller.ts` — GET /me, POST /:id/set-owner

### Tests
- `apps/pkg-core/src/modules/entity/entity.service.spec.ts`
- `apps/pkg-core/src/modules/entity/entity.controller.spec.ts`

---

## Acceptance Criteria

- [ ] MENTORSHIP тип связи работает в API
- [ ] isOwner поле добавлено с unique constraint
- [ ] GET /entities/me возвращает owner entity
- [ ] POST /entities/:id/set-owner устанавливает owner
- [ ] Только одна entity может быть owner
- [ ] Unit тесты покрывают новую функциональность
- [ ] Миграция применяется без ошибок

---

## Риски

| Риск | Митигация |
|------|-----------|
| Enum migration в PostgreSQL | Использовать безопасный ALTER TYPE ADD VALUE |
| Уникальность isOwner | Partial unique index WHERE is_owner = TRUE |
