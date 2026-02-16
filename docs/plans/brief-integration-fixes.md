# Morning Brief Integration Fixes — План исправления

> **Статус:** ✅ Completed (verified 2026-02-16)
> **Дата:** 2026-01-30
> **Ветка:** feat/activity-foundation
> **Ревью:** Architecture + Business Logic + Data Integrity
>
> **Результат аудита 2026-02-16:** Все критические и архитектурные фиксы реализованы.
> Оставшиеся задачи (FK constraints #18, PAUSED documentation #14) — product decisions.

---

## Executive Summary

Интеграция Activity/Commitment в Morning Brief выявила **4 критических** и **6 важных** проблем. Этот план структурирует исправления в 3 фазы с чёткими зависимостями.

---

## Фаза 1: Critical Fixes (блокируют релиз) — ✅ ALL DONE

| # | Задача | Severity | Статус | Где реализовано |
|---|--------|----------|--------|-----------------|
| #19 | Дедупликация EntityEvent vs Commitment | 🔴 CRITICAL | ✅ Done | `digest.service.ts:211-224` — `seenSourceMessageIds` Set |
| #15 | Status handlers для Activity/Commitment | 🔴 CRITICAL | ✅ Done | `brief.service.ts:209-231` — cases 'activity' и 'commitment' |
| #13 | Фильтр dueDate: IsNull() в commitments | 🔴 CRITICAL | ✅ Done | `brief-data-provider.service.ts:157` — `And(Not(IsNull()), LessThan(now))` |
| #17 | Обработка NULL deadline | 🔴 CRITICAL | ✅ Done | `brief-data-provider.service.ts:183-189` — отдельная секция для commitments без dueDate |

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

## Фаза 2: Architecture Improvements — ✅ ALL DONE

| # | Задача | Severity | Статус | Где реализовано |
|---|--------|----------|--------|-----------------|
| #16 | Extract BriefDataProvider | 🟠 HIGH | ✅ Done | `brief-data-provider.service.ts` — отдельный сервис, 5 консолидированных запросов |
| #20 | Priority sorting | 🟡 MEDIUM | ✅ Done | `digest.service.ts:249-263` — overdue first → meetings → alphabetical |
| #11 | UTC timezone | 🟡 MEDIUM | ✅ Done | `digest.service.ts:53-64` — `startOf('day')` в UTC |

---

## Фаза 3: Long-term & Data Integrity — PARTIAL (product decisions pending)

| # | Задача | Severity | Статус | Notes |
|---|--------|----------|--------|-------|
| #18 | FK constraints migration | 🟠 HIGH | ⏳ Pending | Требует product decision (ON DELETE strategy) |
| #12 | Consolidate queries | 🟡 MEDIUM | ✅ Done | Консолидировано в `brief-data-provider.service.ts` |
| #14 | Document PAUSED decision | 🟡 MEDIUM | ⏳ Pending | Product decision — показывать ли PAUSED с просроченным дедлайном |

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
