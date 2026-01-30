# Morning Brief Integration Fixes — План исправления

> **Статус:** 📋 Обсуждение с командой
> **Дата:** 2026-01-30
> **Ветка:** feat/activity-foundation
> **Ревью:** Architecture + Business Logic + Data Integrity

---

## Executive Summary

Интеграция Activity/Commitment в Morning Brief выявила **4 критических** и **6 важных** проблем. Этот план структурирует исправления в 3 фазы с чёткими зависимостями.

---

## Фаза 1: Critical Fixes (блокируют релиз)

| # | Задача | Severity | Effort |
|---|--------|----------|--------|
| #19 | Дедупликация EntityEvent vs Commitment | 🔴 CRITICAL | 2h |
| #15 | Status handlers для Activity/Commitment | 🔴 CRITICAL | 2h |
| #13 | Фильтр dueDate: IsNull() в commitments | 🔴 CRITICAL | 30m |
| #17 | Обработка NULL deadline | 🔴 CRITICAL | 1h |

**Общее время:** ~6 часов
**Результат:** Brief работает корректно, данные не дублируются, статусы обновляются

### Детали решений

#### #19: Дедупликация
```typescript
// В buildBriefItems() перед итерацией по Commitments
const seenSourceMessageIds = new Set<string>();
for (const event of data.overdueCommitments) {
  if (event.sourceMessageId) seenSourceMessageIds.add(event.sourceMessageId);
}
// При добавлении Commitment
if (commitment.sourceMessageId && seenSourceMessageIds.has(commitment.sourceMessageId)) {
  continue; // Skip duplicate
}
```

#### #15: Status Handlers
```typescript
// brief.service.ts - добавить в constructor
@InjectRepository(Activity) private activityRepo: Repository<Activity>,
@InjectRepository(Commitment) private commitmentRepo: Repository<Commitment>,

// В updateSourceStatus()
case 'activity':
  await this.activityRepo.update(item.sourceId, {
    status: status === EventStatus.COMPLETED ? ActivityStatus.COMPLETED : ActivityStatus.CANCELLED,
  });
  break;
case 'commitment':
  await this.commitmentRepo.update(item.sourceId, {
    status: status === EventStatus.COMPLETED ? CommitmentStatus.COMPLETED : CommitmentStatus.CANCELLED,
  });
  break;
```

#### #13: dueDate Filter
```typescript
// Было
{ status: PENDING, type: In([REQUEST, PROMISE]) }

// Стало
{ status: PENDING, type: In([REQUEST, PROMISE]), dueDate: IsNull() }
```

---

## Фаза 2: Architecture Improvements

| # | Задача | Severity | Effort | Blocked By |
|---|--------|----------|--------|------------|
| #16 | Extract BriefDataProvider | 🟠 HIGH | 4h | #19, #13 |
| #20 | Priority sorting | 🟡 MEDIUM | 1h | — |
| #11 | UTC timezone | 🟡 MEDIUM | 1h | — |

**Общее время:** ~6 часов
**Результат:** Чистая архитектура, корректные timezone, приоритеты в UI

### BriefDataProvider Interface
```typescript
@Injectable()
export class BriefDataProvider {
  async getMorningBriefData(): Promise<MorningBriefData> {
    // Все 7 запросов здесь
    // Дедупликация здесь
    // Сортировка по приоритету здесь
  }
}
```

---

## Фаза 3: Long-term & Data Integrity

| # | Задача | Severity | Effort | Notes |
|---|--------|----------|--------|-------|
| #18 | FK constraints migration | 🟠 HIGH | 2h | Требует product decision |
| #12 | Consolidate queries | 🟡 MEDIUM | 2h | Blocked by #16 |
| #14 | Document PAUSED decision | 🟡 MEDIUM | 30m | Product decision |

**Общее время:** ~5 часов
**Результат:** Data integrity, оптимизация запросов

---

## Вопросы для обсуждения с командой

### 1. FK Constraints Strategy
**Вопрос:** Что происходит с Activity когда owner Entity удаляется?

| Опция | Плюсы | Минусы |
|-------|-------|--------|
| ON DELETE CASCADE | Чисто, нет orphans | Теряем историю задач |
| ON DELETE SET NULL | Сохраняем историю | Нужны nullable columns |
| Soft delete only | Контроль | Сложнее, нужен refactoring |

**Рекомендация:** ON DELETE SET NULL — сохраняем историю, помечаем "владелец удалён"

### 2. PAUSED Status
**Вопрос:** Показывать ли PAUSED задачи с просроченным дедлайном?

| Опция | Поведение |
|-------|-----------|
| Не показывать (текущее) | Пользователь сам решил отложить |
| Показывать | Напоминание что дедлайн прошёл |

**Рекомендация:** Не показывать, но добавить отдельную секцию "Приостановленные" по запросу

### 3. Tasks Without Deadline
**Вопрос:** Как обрабатывать задачи без дедлайна?

| Опция | Поведение |
|-------|-----------|
| Игнорировать (текущее) | Показываем только overdue |
| Отдельная секция | "Задачи без срока" в конце |
| Всегда показывать | Раздувает brief |

**Рекомендация:** Отдельная секция "Без срока" с лимитом 3 элемента

---

## Порядок выполнения

```
Фаза 1 (Critical):
  #19 ─┬─► #16 ─► #12
  #13 ─┘
  #15 ─────────────►
  #17 ─────────────►

Фаза 2 (Architecture):
  #16 ─► #12
  #20 ──────►
  #11 ──────►

Фаза 3 (Long-term):
  #18 (после product decision)
  #14 (после product decision)
```

---

## Checklist для Code Review

После каждого fix:
- [ ] Unit tests для нового поведения
- [ ] E2E test: extract → brief → action → DB state
- [ ] Проверка на дублирование данных
- [ ] Проверка timezone в edge cases
- [ ] Документация обновлена

---

## Риски

| Риск | Mitigation |
|------|------------|
| Migration #18 ломает prod data | Dry-run на staging, backup перед деплоем |
| BriefDataProvider рефакторинг большой | Инкрементально, сначала extract, потом optimize |
| Timezone issues | Добавить E2E тесты с разными TZ |

---

## Метрики успеха

1. **Дублирование:** 0 дублей в brief (мониторинг логов)
2. **Status updates:** 100% кнопок "Готово" обновляют DB
3. **Query performance:** Время генерации brief < 500ms
4. **User feedback:** Нет жалоб на "призрачные" элементы
