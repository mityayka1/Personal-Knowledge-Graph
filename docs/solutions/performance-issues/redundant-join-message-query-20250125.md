---
module: Interaction/Message
date: 2025-01-25
problem_type: performance_issue
component: typeorm_query
symptoms:
  - "Redundant JOIN on same table in QueryBuilder"
  - "Inefficient SQL query generation"
root_cause: duplicate_join
severity: medium
tags: [typeorm, querybuilder, join, performance, sql]
related_pr: 91
---

# Redundant JOIN в MessageService.findByEntitiesInTimeWindow

## Симптом

При code review обнаружен неоптимальный паттерн в TypeORM QueryBuilder — два JOIN на одну и ту же связь `m.interaction`:

```typescript
// БЫЛО: Избыточный JOIN
const qb = this.messageRepo
  .createQueryBuilder('m')
  .innerJoin('m.interaction', 'i')           // JOIN #1
  .innerJoin('i.participants', 'p')
  .leftJoinAndSelect('m.interaction', 'interaction')  // JOIN #2 на ту же таблицу!
  .where('p.entityId IN (:...entityIds)', { entityIds })
```

## Бизнес-контекст

Метод `findByEntitiesInTimeWindow` используется для:
- **Cross-chat context** — получение сообщений из других чатов с теми же участниками
- **Context-Aware Extraction** — предоставление контекста для извлечения фактов

При большом объёме данных (тысячи сообщений) избыточный JOIN создаёт:
- Лишнюю нагрузку на PostgreSQL
- Увеличенный план выполнения запроса
- Потенциальное замедление при масштабировании

## Корневая причина

TypeORM QueryBuilder позволяет создавать несколько JOIN на одну связь с разными алиасами. Разработчик:
1. Сначала добавил `innerJoin` для фильтрации по participants
2. Затем добавил `leftJoinAndSelect` для загрузки данных interaction

Это работает, но генерирует SQL с двумя JOIN:
```sql
SELECT ... FROM messages m
INNER JOIN interactions i ON i.id = m.interaction_id    -- JOIN #1
INNER JOIN interaction_participants p ON p.interaction_id = i.id
LEFT JOIN interactions interaction ON interaction.id = m.interaction_id  -- JOIN #2
WHERE p.entity_id IN (...)
```

## Решение

Объединить JOIN в один с правильным алиасом:

```typescript
// СТАЛО: Оптимальный запрос
const qb = this.messageRepo
  .createQueryBuilder('m')
  .innerJoinAndSelect('m.interaction', 'interaction')  // JOIN + SELECT в одном
  .innerJoin('interaction.participants', 'p')          // Используем тот же алиас
  .where('p.entityId IN (:...entityIds)', { entityIds })
```

Результирующий SQL:
```sql
SELECT ... FROM messages m
INNER JOIN interactions interaction ON interaction.id = m.interaction_id
INNER JOIN interaction_participants p ON p.interaction_id = interaction.id
WHERE p.entity_id IN (...)
```

## Файл и строки

- **Файл:** `apps/pkg-core/src/modules/interaction/message/message.service.ts`
- **Метод:** `findByEntitiesInTimeWindow`
- **Строки:** 845-850

## Предотвращение

### Code Review Checklist

При review QueryBuilder запросов проверять:
- [ ] Нет ли дублирующихся JOIN на одну связь с разными алиасами
- [ ] Используется ли `JoinAndSelect` когда нужны данные связи
- [ ] Консистентны ли алиасы через весь запрос

### Паттерн: Правильный порядок JOIN

```typescript
// ✅ ПРАВИЛЬНО: Один JOIN на связь
.innerJoinAndSelect('entity.relation', 'alias')  // JOIN + загрузка данных
.innerJoin('alias.nested', 'nested')             // Вложенный JOIN использует алиас

// ❌ НЕПРАВИЛЬНО: Дублирование JOIN
.innerJoin('entity.relation', 'alias1')          // JOIN для фильтрации
.leftJoinAndSelect('entity.relation', 'alias2')  // Ещё один JOIN для данных
```

### Автоматизация

Можно добавить ESLint правило или pre-commit hook для поиска паттерна:
```regex
\.innerJoin\(['"]([^'"]+)['"]\s*,\s*['"][^'"]+['"]\).*\.leftJoinAndSelect\(['"](\1)['"]\s*,
```

## Связанные материалы

- [TypeORM QueryBuilder Relations](https://typeorm.io/select-query-builder#joining-relations)
- PR #91: Context-Aware Extraction
