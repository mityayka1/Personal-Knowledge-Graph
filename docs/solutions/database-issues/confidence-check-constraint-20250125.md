---
module: Database/Migrations
date: 2025-01-25
problem_type: database_issue
component: postgresql_constraint
symptoms:
  - "Отсутствие валидации confidence на уровне БД"
  - "Возможность записи некорректных значений при прямых SQL операциях"
root_cause: missing_constraint
severity: medium
tags: [postgresql, check-constraint, data-integrity, confidence, validation]
related_pr: 91
---

# Отсутствие CHECK Constraint для Confidence

## Симптом

Поля `confidence` в таблицах `pending_confirmations` и `extracted_events` не имели ограничений на уровне базы данных, хотя бизнес-логика требует значения в диапазоне [0, 1].

## Бизнес-контекст

**Confidence** — ключевой показатель для системы извлечения фактов:

| Значение | Интерпретация | Действие |
|----------|---------------|----------|
| `>= 0.8` | Высокая уверенность | Авто-подтверждение |
| `0.6 - 0.8` | Средняя уверенность | Требует подтверждения пользователя |
| `< 0.6` | Низкая уверенность | Создаётся PendingConfirmation |

Если в БД попадёт значение `1.5` или `-0.3`, это нарушит:
- **SubjectResolverService** — некорректная сортировка по confidence
- **ConfirmationService** — неверная приоритизация в очереди подтверждений
- **UI** — процентный индикатор покажет >100% или отрицательное значение

## Корневая причина

Миграция `1769400000000-CreatePendingConfirmations.ts` создала колонку:
```sql
confidence DECIMAL(3,2)  -- Нет CHECK constraint
```

Zod валидация в DTO защищает API входы, но не защищает от:
- Прямых SQL операций (миграции, скрипты)
- Багов в коде, минующих DTO валидацию
- Импорта данных из внешних источников

## Решение

Создана миграция `1769600000000-AddConfidenceCheckConstraint.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConfidenceCheckConstraint1769600000000
  implements MigrationInterface
{
  name = 'AddConfidenceCheckConstraint1769600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // pending_confirmations: confidence может быть NULL
    await queryRunner.query(`
      ALTER TABLE pending_confirmations
      ADD CONSTRAINT chk_pending_confirmations_confidence
      CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
    `);

    // extracted_events: confidence обязателен
    await queryRunner.query(`
      ALTER TABLE extracted_events
      ADD CONSTRAINT chk_extracted_events_confidence
      CHECK (confidence >= 0 AND confidence <= 1)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE extracted_events
      DROP CONSTRAINT IF EXISTS chk_extracted_events_confidence
    `);

    await queryRunner.query(`
      ALTER TABLE pending_confirmations
      DROP CONSTRAINT IF EXISTS chk_pending_confirmations_confidence
    `);
  }
}
```

## Файлы

- **Миграция:** `apps/pkg-core/src/database/migrations/1769600000000-AddConfidenceCheckConstraint.ts`
- **Затронутые таблицы:** `pending_confirmations`, `extracted_events`

## Проверка

После применения миграции:

```sql
-- Проверить наличие constraints
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname LIKE 'chk_%confidence';

-- Попытка вставить некорректное значение должна упасть
INSERT INTO extracted_events (confidence, ...) VALUES (1.5, ...);
-- ERROR: new row violates check constraint "chk_extracted_events_confidence"
```

## Предотвращение

### Паттерн: Defense in Depth для числовых полей

```
┌─────────────────────────────────────────────────────────────┐
│ Уровень 1: Zod DTO Validation (API boundary)                │
│   z.number().min(0).max(1).describe('Confidence 0-1')       │
├─────────────────────────────────────────────────────────────┤
│ Уровень 2: TypeORM Column Decorator                         │
│   @Column({ type: 'decimal', precision: 3, scale: 2 })      │
├─────────────────────────────────────────────────────────────┤
│ Уровень 3: PostgreSQL CHECK Constraint (DB level)           │
│   CHECK (confidence >= 0 AND confidence <= 1)               │
└─────────────────────────────────────────────────────────────┘
```

### Checklist для новых числовых полей

При добавлении поля с бизнес-ограничениями:
- [ ] Добавить Zod валидацию в DTO
- [ ] Рассмотреть CHECK constraint в миграции
- [ ] Документировать допустимый диапазон в Entity

### Централизованные константы

Использовать единый источник истины:

```typescript
// packages/entities/src/constants/confidence.constants.ts
export const CONFIDENCE_THRESHOLDS = {
  AUTO_RESOLVE: 0.8,    // Авто-подтверждение
  NEEDS_REVIEW: 0.6,    // Требует review
  MIN: 0,
  MAX: 1,
} as const;
```

## Связанные материалы

- [PostgreSQL CHECK Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)
- `packages/entities/src/constants/confidence.constants.ts` — централизованные thresholds
- PR #91: Context-Aware Extraction
