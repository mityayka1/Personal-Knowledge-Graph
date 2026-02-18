# Sprint: Качество знаний — от фактов к реальным знаниям

> **Статус:** ✅ Completed (PR #154 merged 2026-02-18)
> **Старт:** 2026-02-17
> **Фокус:** Активация мёртвого Knowledge Pipeline + верификация качества на реальных данных
> **Принцип:** Каждый шаг проверяется на production данных, не на синтетике

---

## Стратегическая проблема

Система СОБИРАЕТ факты, но НЕ СОЗДАЁТ знаний:
- Segmentation job каждый час находит 96-137 interactions, создаёт **0 сегментов**
- PackingService никогда не запускался на реальных данных
- OrphanSegmentLinker не имеет данных для работы
- Knowledge tools агента не имеют контента

**Корневая причина:** `MIN_UNSEGMENTED_MESSAGES = 4`, но post-extraction trigger подаёт по 1 сообщению. А cron-job находит interactions, но все их сообщения либо уже сегментированы (через пустую segment_messages таблицу — нет, LEFT JOIN показывает unsegmented), либо < 4 штук per interaction.

---

## Git Flow

```
master ← feature/knowledge-quality-sprint
              ├── wave-0/fix-segmentation-pipeline
              ├── wave-1/extraction-quality-verification
              ├── wave-2/knowledge-pipeline-activation
              └── wave-3/remaining-features
```

**Правила:**
1. Каждая wave — отдельная ветка от `feature/knowledge-quality-sprint`
2. Merge в feature-ветку через PR с code review
3. Merge в master через PR с business logic review
4. Deploy на прод после каждой wave
5. Verification на реальных данных ОБЯЗАТЕЛЬНА перед следующей wave

---

## Wave 0: Диагностика и починка Segmentation Pipeline (P0-CRITICAL)

### Задача 0.1: Диагностика — почему 0 сегментов создаётся
**Агент:** tech-lead (исследование)
**Ветка:** `wave-0/fix-segmentation-pipeline`

**Расследовать:**
1. SQL запрос в processInteraction() — сколько unsegmented messages per interaction?
2. Существует ли таблица `segment_messages`? Есть ли в ней данные?
3. Проверить threshold `MIN_UNSEGMENTED_MESSAGES = 4` — сколько interactions имеют ≥ 4 unsegmented?
4. Есть ли postgres контейнер в compose? Если нет — как pkg-core подключается?

**Проверка на prod:**
```sql
-- Сколько unsegmented messages per interaction
SELECT i.id, COUNT(m.id) as msg_count
FROM interactions i
INNER JOIN messages m ON m.interaction_id = i.id
LEFT JOIN segment_messages sm ON sm.message_id = m.id
WHERE i.updated_at > NOW() - INTERVAL '24 hours'
  AND sm.message_id IS NULL
GROUP BY i.id
ORDER BY msg_count DESC
LIMIT 20;
```

**Критерий готовности:** Ясно, почему 0 сегментов. Документированный отчёт.

---

### Задача 0.2: Fix — настроить segmentation для реального использования
**Агент:** backend-developer
**Зависит от:** 0.1

**Потенциальные исправления (по результатам диагностики):**
- Снизить `MIN_UNSEGMENTED_MESSAGES` если interactions содержат 2-3 сообщения
- Агрегировать messages по chat_id вместо interaction_id для cron-job
- Fix connection timeout (увеличить pool timeout или добавить retry)
- Убедиться что cron-job выбирает правильный time window

**Файлы:**
- `apps/pkg-core/src/modules/segmentation/segmentation-job.service.ts`
- Возможно: `apps/pkg-core/src/modules/segmentation/topic-boundary-detector.service.ts`

**Проверка на prod:**
```bash
# После deploy — проверить что сегменты создаются
docker compose logs pkg-core 2>&1 | grep 'segments created' | tail -5
# Ожидаем: > 0 segments created
```

---

### Задача 0.3: Fix DB connection timeouts
**Агент:** devops
**Параллельно с:** 0.2

**Расследовать:**
- Postgres не виден в `docker compose ps` — где он?
- Connection pool settings в TypeORM config
- Timeout settings для long-running cron jobs

**Файлы:**
- `docker/docker-compose.yml` — проверить postgres service
- `apps/pkg-core/src/database/database.config.ts` — pool settings

---

### CHECKPOINT 0: Segmentation работает
**Ревью:** tech-lead
**Верификация на prod:**
- [ ] `segmentation-job` создаёт > 0 segments в hourly run
- [ ] Нет connection timeout ошибок за последние 2 часа
- [ ] SQL: `SELECT count(*) FROM topical_segments` > 0
- [ ] POST `/api/v1/topical-segments/auto-segment` возвращает 200

---

## Wave 1: Верификация качества Extraction на реальных данных (P0)

### Задача 1.1: Аудит последних 50 extraction results
**Агент:** qa-engineer + tech-lead (парный ревью)
**Ветка:** `wave-1/extraction-quality-verification`

**Проверить на prod:**
```sql
-- Последние 50 pending approvals
SELECT pa.id, pa.item_type, pa.metadata->>'source' as source,
       pa.created_at, pa.status
FROM pending_approvals pa
ORDER BY pa.created_at DESC
LIMIT 50;

-- Дубликаты фактов (одинаковые entity + fact_type + value)
SELECT ef.entity_id, ef.fact_type, ef.value, COUNT(*) as cnt
FROM entity_facts ef
GROUP BY ef.entity_id, ef.fact_type, ef.value
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 20;

-- Дубликаты activities (similar names)
SELECT a1.id, a1.name, a2.id as dup_id, a2.name as dup_name
FROM activities a1
JOIN activities a2 ON a1.id < a2.id
  AND LOWER(a1.name) = LOWER(a2.name)
  AND a1.activity_type = a2.activity_type;
```

**Критерий готовности:** Отчёт с метриками — % дубликатов, % noise, % orphans.

---

### Задача 1.2: Проверить client annotation fix на живых данных
**Агент:** qa-engineer
**Параллельно с:** 1.1

**Тест-сценарий:**
1. Найти проект с клиентом (e.g., "Панавто-Хаб" с клиентом "Ассистент Панавто")
2. Отправить тестовое сообщение в Telegram: "Обсудил с Максом по Панавто-Хаб новые условия"
3. Дождаться extraction
4. Проверить PendingApproval: task/commitment должен иметь `parentId → Панавто-Хаб`, а НЕ создать дубликат "Панавто-Хаб (клиент: Ассистент Панавто)"

**Проверка:**
```sql
SELECT pa.id, pa.item_type, pa.metadata->>'projectName' as project_name,
       a.name as linked_activity, a.id as activity_id
FROM pending_approvals pa
LEFT JOIN activities a ON a.id = (pa.metadata->>'activityId')::uuid
WHERE pa.created_at > NOW() - INTERVAL '30 minutes'
ORDER BY pa.created_at DESC;
```

---

### Задача 1.3: Проверить noise/vague filtering
**Агент:** qa-engineer
**Параллельно с:** 1.1

**Тест-сценарий:**
1. Отправить сообщение с шумом: "Подтверждение использования инструмента. Ок. Что-то сделать."
2. Дождаться extraction
3. Проверить: events НЕ должны создаться (отфильтрованы)

**Проверка:**
```sql
-- Шумовые events за последний час
SELECT ee.id, ee.title, ee.description, ee.created_at
FROM extracted_events ee
WHERE ee.created_at > NOW() - INTERVAL '1 hour'
  AND (ee.title ILIKE '%подтвержд%инструмент%'
    OR ee.title ILIKE '%что-то%'
    OR LENGTH(ee.title) < 15);
-- Ожидаем: 0 rows
```

---

### Задача 1.4: Проверить dedup effectiveness
**Агент:** qa-engineer
**Параллельно с:** 1.1

**Тест-сценарий:**
1. Отправить "Нужно сделать договор для Панавто" → создаст commitment
2. Через 5 минут отправить "Подготовить договор по Панавто" → должен найти дубликат (Levenshtein ≥ 0.7)
3. Проверить: второй НЕ создан, или fusion applied

**Проверка логов:**
```bash
docker compose logs pkg-core 2>&1 | grep -i 'dedup\|fusion\|duplicate\|similarity' | tail -20
```

---

### CHECKPOINT 1: Extraction качество подтверждено
**Ревью:** tech-lead + product-owner (business logic review!)
**Верификация:**
- [ ] Дубликаты фактов: < 5% от общего числа
- [ ] Noise events: 0 за последние сутки
- [ ] Client annotation: проект привязывается, не дублируется
- [ ] Commitment dedup: переформулировка не создаёт дубликат
- [ ] Документ: `docs/verification/wave-1-extraction-quality.md`

**Business Logic Review (product-owner):**
- [ ] Правильно ли определяются типы событий (task vs commitment vs meeting)?
- [ ] Адекватны ли пороги fuzzy matching (0.7 для task/commitment, 0.8 для project)?
- [ ] Не теряются ли важные события из-за noise filtering?

---

## Wave 2: Активация Knowledge Pipeline (P1)

### Задача 2.1: Запустить сегментацию на ретроспективных данных
**Агент:** backend-developer
**Ветка:** `wave-2/knowledge-pipeline-activation`
**Зависит от:** CHECKPOINT 0

**Действия:**
1. Создать одноразовый endpoint/script для ретроспективной сегментации
2. Выбрать 10 наиболее активных чатов (> 50 messages)
3. Запустить `TopicBoundaryDetectorService.detectAndCreate()` для каждого
4. Верифицировать результаты

**Файлы:**
- Новый метод в `segmentation.controller.ts` или script
- Использовать `topic-boundary-detector.service.ts`

**Проверка на prod:**
```sql
SELECT ts.id, ts.title, ts.summary, ts.chat_id,
       (SELECT COUNT(*) FROM segment_messages sm WHERE sm.segment_id = ts.id) as msg_count
FROM topical_segments ts
ORDER BY ts.created_at DESC
LIMIT 20;
```

**Критерий готовности:** ≥ 20 TopicalSegments с осмысленными title/summary.

---

### Задача 2.2: Проверить OrphanSegmentLinker
**Агент:** backend-developer
**Зависит от:** 2.1

**Действия:**
1. Проверить сколько сегментов orphaned (без activityId)
2. Запустить OrphanSegmentLinker
3. Верифицировать привязки

**Проверка:**
```sql
-- Orphan segments
SELECT COUNT(*) as total,
       COUNT(ts.activity_id) as linked,
       COUNT(*) - COUNT(ts.activity_id) as orphaned
FROM topical_segments ts;
```

---

### Задача 2.3: Тестовый запуск PackingService
**Агент:** backend-developer
**Зависит от:** 2.1, 2.2

**Действия:**
1. Выбрать Activity с ≥ 3 linked segments
2. Запустить `PackingService.packActivity(activityId)`
3. Проверить создание KnowledgePack

**Проверка:**
```sql
SELECT kp.id, kp.title, kp.pack_type, kp.period_start, kp.period_end,
       kp.source_segment_ids, kp.content->>'summary' as summary
FROM knowledge_packs kp
ORDER BY kp.created_at DESC
LIMIT 5;
```

**Критерий готовности:** ≥ 1 KnowledgePack с осмысленным content.

---

### CHECKPOINT 2: Knowledge Pipeline работает
**Ревью:** tech-lead + product-owner
**Верификация:**
- [ ] ≥ 20 TopicalSegments в базе
- [ ] Сегменты имеют осмысленные title и summary
- [ ] OrphanSegmentLinker привязал ≥ 50% segments к activities
- [ ] ≥ 1 KnowledgePack создан
- [ ] KnowledgePack содержит корректные facts/decisions/open_questions

**Business Logic Review (product-owner):**
- [ ] Сегменты правильно разбивают обсуждения на темы?
- [ ] KnowledgePack адекватно суммаризирует знания?
- [ ] Не теряется ли важная информация при упаковке?
- [ ] Достаточен ли контекст в упакованных знаниях для принятия решений?

---

## Wave 3: Оставшиеся фичи (P2)

### Задача 3.1: Birthday lookup в Morning Brief
**Агент:** backend-developer
**Ветка:** `wave-3/remaining-features`

**Файл:** `apps/pkg-core/src/modules/notification/brief-data-provider.service.ts:102-105`

**Текущее состояние:**
```typescript
private async getEntitiesWithBirthdayToday(): Promise<EntityRecord[]> {
  // TODO: Implement birthday lookup via EntityFact
  return [];
}
```

**Реализация:**
```sql
SELECT e.id, e.name, ef.value as birthday
FROM entity_facts ef
JOIN entities e ON e.id = ef.entity_id
WHERE ef.fact_type = 'birthday'
  AND ef.is_current = true
  AND EXTRACT(MONTH FROM ef.value::date) = EXTRACT(MONTH FROM CURRENT_DATE)
  AND EXTRACT(DAY FROM ef.value::date) = EXTRACT(DAY FROM CURRENT_DATE);
```

**Проверка:**
```sql
-- Сначала: есть ли birthday facts?
SELECT COUNT(*) FROM entity_facts WHERE fact_type = 'birthday';
```

---

### Задача 3.2: Валидация знаний через agent recall
**Агент:** qa-engineer
**Зависит от:** CHECKPOINT 2

**Тест-сценарий:**
1. Вызвать `/agent/recall` с запросом о проекте, для которого есть KnowledgePack
2. Проверить что recall использует упакованные знания
3. Сравнить quality ответа с/без KnowledgePack

---

### CHECKPOINT 3: Sprint завершён
**Ревью:** tech-lead + product-owner (финальный)
**Верификация:**
- [ ] Все SQL-проверки из Wave 0-2 проходят
- [ ] Morning Brief показывает birthdays (если есть данные)
- [ ] Agent recall использует knowledge packs
- [ ] `npx tsc --noEmit` — без ошибок
- [ ] Документация обновлена

---

## Назначения агентов

| Агент | Задачи | Инструменты |
|-------|--------|-------------|
| **tech-lead** | 0.1, ревью всех checkpoints | Glob, Grep, Read, Bash |
| **backend-developer** | 0.2, 2.1, 2.2, 2.3, 3.1 | Read, Edit, Write, Bash, Glob, Grep |
| **devops** | 0.3 | Bash, Read, Edit |
| **qa-engineer** | 1.1, 1.2, 1.3, 1.4, 3.2 | Bash, Read, Grep |
| **product-owner** | Business logic review на CHECKPOINT 1, 2, 3 | Read |

---

## Граф зависимостей

```
Wave 0 (PARALLEL):
  [0.1] Диагностика ─────────────────► [0.2] Fix segmentation
  [0.3] DB timeouts fix ──────────────► (параллельно)
                                         │
                                    CHECKPOINT 0
                                         │
Wave 1 (PARALLEL после CHECKPOINT 0):   │
  [1.1] Аудит 50 extractions ──────────►│
  [1.2] Client annotation test ─────────►├── CHECKPOINT 1
  [1.3] Noise filter test ─────────────►│
  [1.4] Dedup effectiveness ───────────►│
                                         │
Wave 2 (SEQUENTIAL после CHECKPOINT 1): │
  [2.1] Ретроспективная сегментация ────►[2.2] OrphanLinker ──►[2.3] Packing
                                                                      │
                                                                 CHECKPOINT 2
                                                                      │
Wave 3 (после CHECKPOINT 2):                                         │
  [3.1] Birthday lookup (параллельно) ──►                             │
  [3.2] Agent recall validation ────────►──── CHECKPOINT 3 (FINAL)
```

---

## Метрики успеха

| Метрика | До спринта | Целевое |
|---------|-----------|---------|
| TopicalSegments в БД | 0 | ≥ 50 |
| KnowledgePacks в БД | 0 | ≥ 5 |
| Segmentation job: segments/hour | 0 | > 0 |
| Дубликаты фактов | Неизвестно | < 5% |
| Noise events за сутки | Неизвестно | 0 |
| Orphan segments | 100% | < 50% |
| Birthday lookup | TODO stub | Работает |
| DB connection timeouts/hour | ~2 | 0 |

---

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| TopicBoundaryDetector — высокая стоимость Claude API | Высокая | Rate limiting (INTER_CALL_DELAY_MS), batch processing |
| Ретроспективная сегментация перегрузит API | Средняя | Обрабатывать по 5 чатов за раз, с паузами |
| PackingService на реальных данных даёт бессмыслицу | Средняя | Manual review на CHECKPOINT 2, adjusting prompts |
| Postgres connection pool исчерпан | Средняя | Увеличить pool size, добавить retry логику |
| Birthday facts не существуют в БД | Высокая | Проверить перед реализацией, graceful fallback |
