---
title: "TypeORM Nullable Column 'Object' Type Error"
category: integration-issues
tags: [typeorm, typescript, postgresql, nullable, column-types, reflect-metadata]
module: entities
symptom: "DataTypeNotSupportedError: Data type 'Object' in column is not supported by 'postgres'"
root_cause: "TypeScript emits 'Object' in reflect-metadata for union types like string | null"
date: 2026-01-31
---

# TypeORM Nullable Column 'Object' Type Error

## Симптом

При запуске миграций TypeORM выдаёт ошибку:

```
DataTypeNotSupportedError: Data type "Object" in "PendingApproval.messageRef" is not supported by "postgres" database.
```

## Контекст

Создана entity с nullable string колонкой:

```typescript
// packages/entities/src/pending-approval.entity.ts

@Column({ name: 'message_ref', length: 100, nullable: true })
messageRef: string | null;
```

Локально всё работает, но на production при запуске миграций падает с ошибкой "Object" type.

## Почему это происходит

### TypeScript Reflect Metadata

TypeORM использует `reflect-metadata` для определения типов колонок. TypeScript при компиляции генерирует metadata через декораторы.

**Проблема:** Для union типов (`string | null`, `number | undefined`) TypeScript не может определить один конкретный тип и fallback'ится на `Object`.

Скомпилированный JavaScript:

```javascript
// packages/entities/dist/pending-approval.entity.js

__decorate([
    (0, typeorm_1.Column)({ name: 'message_ref', length: 100, nullable: true }),
    __metadata("design:type", Object)  // <-- Object вместо String!
], PendingApproval.prototype, "messageRef", void 0);
```

TypeORM видит `design:type: Object` и пытается создать колонку типа "Object", которого нет в PostgreSQL.

### Почему работает локально?

Если база данных уже существует с правильной схемой (миграции были применены раньше), TypeORM не пытается создать/изменить колонку. Ошибка возникает только при:
- Первом запуске миграции
- `synchronize: true`
- Создании таблицы с нуля

## Решение

**Явно указать тип колонки в декораторе `@Column`:**

```typescript
// ❌ НЕПРАВИЛЬНО - TypeScript генерирует Object
@Column({ name: 'message_ref', length: 100, nullable: true })
messageRef: string | null;

// ✅ ПРАВИЛЬНО - явный тип для PostgreSQL
@Column({ name: 'message_ref', type: 'varchar', length: 100, nullable: true })
messageRef: string | null;
```

### Варианты явных типов

| TypeScript тип | PostgreSQL type в @Column |
|----------------|---------------------------|
| `string \| null` | `type: 'varchar'` или `type: 'text'` |
| `number \| null` | `type: 'integer'` или `type: 'decimal'` |
| `Date \| null` | `type: 'timestamp with time zone'` |
| `boolean \| null` | `type: 'boolean'` |

## Правило

**Для любой nullable колонки ВСЕГДА указывай explicit `type` в декораторе `@Column`.**

TypeScript emit metadata не справляется с union types - это известное ограничение reflect-metadata.

## Проверка

После исправления убедись, что скомпилированный JS больше не содержит `design:type: Object`:

```bash
grep -n "design:type.*Object" packages/entities/dist/*.js
```

## Связанные файлы

- `packages/entities/src/pending-approval.entity.ts` - исправленная entity
- `apps/pkg-core/src/database/migrations/*-add-pending-approval.ts` - миграция

## Ссылки

- [TypeORM Column Types](https://typeorm.io/entities#column-types)
- [reflect-metadata limitations](https://github.com/rbuckton/reflect-metadata#known-issues)
- [TypeORM issue #2200](https://github.com/typeorm/typeorm/issues/2200)
