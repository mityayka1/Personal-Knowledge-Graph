# Plan: Качество извлечения данных — "Пойми контекст, потом извлекай"

## Context

Extraction pipeline генерирует мусорные данные. Реальный пример:
- **Извлечено**: Commitment "Переделать что-то в будущем" (conf: 0.7)
- **Реальный разговор**: обсуждение выбора сервиса транскрипции голосовых для invapp-panavto
- **Должно было быть**: "Использовать внутренний сервис транскрибации вместо OpenAI для invapp-panavto"

Предыдущие улучшения (noise filtering, fuzzy dedup, activity linking, client boost) уже реализованы и работают на production. Теперь нужно решить **фундаментальную проблему**: Claude анализирует сообщения по одному, вместо того чтобы сначала понять разговор целиком.

## Root Causes

| # | Причина | Влияние |
|---|---------|---------|
| 1 | **Per-message extraction** — промпт говорит "Проанализируй все сообщения" без инструкции понять контекст | Claude извлекает из одного сообщения без контекста беседы |
| 2 | **Потеря контекста чата** — `chatCategory.title` (напр. "invapp-panavto") доступен, но НЕ передаётся в extraction | Claude не знает тему чата |
| 3 | **Escape в vague filter** — `isVagueContent(title) && !args.date` пропускает мусор с датой | "что-то в будущем" с датой проходит фильтр |
| 4 | **Нет anti-pattern примеров** — промпт описывает правила абстрактно, без примеров плохих извлечений | Claude не учится на ошибках |

## Решение: 4 области изменений

### Область 1: Prompt Restructuring — "Пойми, потом извлекай" (PRIMARY)

**Файл:** `apps/pkg-core/src/modules/extraction/unified-extraction.service.ts`

Заменить секцию ЗАДАНИЕ (строки 390-397) двухфазной инструкцией:

```
══════════════════════════════════════════
ЗАДАНИЕ (2 фазы):
══════════════════════════════════════════

ФАЗА 1 — ПОЙМИ КОНТЕКСТ РАЗГОВОРА:
Прочитай ВСЕ сообщения целиком. Определи:
- О чём разговор в целом? Какая основная тема?
- Какие решения были приняты?
- Какие конкретные действия обсуждались?
НЕ начинай извлечение до понимания общего контекста.

ФАЗА 2 — ИЗВЛЕКИ ЗНАЧИМЫЕ ЭЛЕМЕНТЫ:
Основываясь на понимании разговора, извлеки:
- Конкретные факты (должность, компания, контакты)
- Конкретные обещания и задачи с ясным описанием ЧТО ИМЕННО
- Связи между людьми/организациями

КРИТИЧНО: Каждый элемент должен:
1. Быть понятен БЕЗ возврата к переписке
2. Содержать конкретику, а не расплывчатые формулировки
3. Быть привязан к контексту разговора (проект, тема, цель)
```

Добавить anti-pattern примеры в секцию § СОБЫТИЯ (после правила 7, строка ~367):

```
8. АНТИ-ПРИМЕРЫ — НЕ извлекай подобное:
   ❌ "Переделать что-то в будущем" — нет конкретики. Правильно: "Перенести транскрибацию на внутренний сервис для invapp-panavto"
   ❌ "Обсудить вопрос" — нет объекта. Правильно: "Согласовать стоимость лицензии $200/мес с клиентом X"
   ❌ "Сделать задачу" — пересказ, не извлечение. Указывай ЧТО конкретно.
   Правило: если title можно приложить к ЛЮБОМУ разговору — оно слишком абстрактное.
```

Также добавить chat title в контекст промпта — новая секция после `${relationsSection}`:

```typescript
const chatTitleSection = chatTitle
  ? `\nЧАТ: "${chatTitle}"\nУчитывай название чата как контекст беседы.`
  : '';
```

Изменить сигнатуру `buildUnifiedPrompt()` — добавить параметр `chatTitle?: string`.

### Область 2: Chat Title Pipeline — передать название чата в extraction

Цепочка изменений для проброса `chatCategory.title`:

**Файл 1:** `apps/pkg-core/src/modules/extraction/unified-extraction.types.ts`
- Добавить `chatTitle?: string` в `UnifiedExtractionParams`

**Файл 2:** `apps/pkg-core/src/modules/job/processors/fact-extraction.processor.ts`
- Inject `ChatCategoryService` (из `ChatCategoryModule`)
- В `processPrivateChat()`: получить `interaction` (уже загружается в `process()`), извлечь `telegram_chat_id` из `sourceMetadata`, вызвать `chatCategoryService.getCategory()`, получить `title`
- Передать `chatTitle` в `extract()`
- В `processGroupChat()`: аналогично, заменить `chatName: undefined` на реальный title

**Файл 3:** `apps/pkg-core/src/modules/job/job.module.ts`
- Добавить `ChatCategoryModule` в imports

**Файл 4:** `apps/pkg-core/src/modules/extraction/unified-extraction.service.ts`
- В `extract()`: деструктурировать `chatTitle` из params
- Передать `chatTitle` в `buildUnifiedPrompt()`

**Стратегия**: Lookup в processor через interaction.sourceMetadata.telegram_chat_id → ChatCategoryService.getCategory(). Это 1 простой indexed query на каждый extraction job (максимум раз в 10 минут), не влияет на performance.

**Оптимизация**: Рефакторить `process()` чтобы всегда передавать loaded `interaction` в обе ветки (private/group), избегая двойной загрузки.

### Область 3: Fix Vague Content Filter

**Файл:** `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts`

Строка 627 — убрать `!args.date` escape:

```typescript
// БЫЛО:
if (isVagueContent(args.title) && !args.date) {

// СТАЛО:
if (isVagueContent(args.title)) {
```

**Обоснование**: "Переделать что-то в будущем" с любой датой — всё ещё мусор. Дата не компенсирует неконкретный title. Claude получит toolError и переформулирует с конкретикой.

Обновить сообщение об ошибке для лучшего in-context learning:

```typescript
return toolError(
  'Event title is too vague',
  'Title contains placeholder words (что-то, как-нибудь). ' +
  'Use specific details from conversation: project name, action object, person.',
);
```

### Область 4: Аналогичные изменения для Group Extraction

**Файл:** `apps/pkg-core/src/modules/extraction/group-extraction.service.ts`

Применить ту же двухфазную инструкцию в `buildGroupPrompt()` (строки 417-423):
- Заменить ЗАДАНИЕ на двухфазную версию
- Добавить anti-pattern примеры в секцию СОБЫТИЯ

Chat title уже передаётся в group extraction через параметр `chatName`, но сейчас всегда `undefined` — это исправлено в Области 2.

## Порядок реализации

| # | Изменение | Файлы | Зависимости |
|---|-----------|-------|-------------|
| 1 | `chatTitle` в types | `unified-extraction.types.ts` | Нет |
| 2 | Chat title lookup в processor | `fact-extraction.processor.ts`, `job.module.ts` | #1 |
| 3 | Prompt restructuring + chat title | `unified-extraction.service.ts` | #1 |
| 4 | Fix vague filter | `extraction-tools.provider.ts` | Нет |
| 5 | Group extraction prompt | `group-extraction.service.ts` | Нет |

Шаги 1→2→3 последовательны. Шаги 4 и 5 независимы.

## Итого: файлы

| Файл | Изменение |
|------|-----------|
| `unified-extraction.types.ts` | +1 строка: `chatTitle?: string` |
| `fact-extraction.processor.ts` | +25 строк: DI ChatCategoryService, title lookup, передача в extract |
| `job.module.ts` | +2 строки: import + ChatCategoryModule в imports |
| `unified-extraction.service.ts` | ~40 строк: chatTitle param, промпт restructuring, anti-patterns |
| `extraction-tools.provider.ts` | ~5 строк: убрать `!args.date`, обновить error message |
| `group-extraction.service.ts` | ~20 строк: двухфазная инструкция + anti-patterns |

## Существующие функции для reuse

| Функция | Файл | Назначение |
|---------|------|------------|
| `ChatCategoryService.getCategory(telegramChatId)` | `chat-category.service.ts:206` | Получить ChatCategoryRecord с title |
| `isVagueContent(text)` | `extraction-quality.constants.ts:37` | Проверка на vague patterns |
| `isNoiseContent(text)` | `extraction-quality.constants.ts:42` | Проверка на noise patterns |
| `InteractionService.findOne(id)` | interaction module | Загрузка interaction с sourceMetadata |

## Verification

1. **Компиляция**: `cd apps/pkg-core && npx tsc --noEmit` — без ошибок
2. **Vague filter тест**: Вручную проверить `isVagueContent("Переделать что-то")` — должен отклоняться даже с датой
3. **Chat title**: Запустить extraction на interaction с known telegram_chat_id — title должен появиться в промпте (через debug лог)
4. **Production тест**: Отправить сообщения в чат invapp-panavto → extraction должен использовать контекст чата для извлечений
5. **Anti-patterns**: Попытка создать "Сделать что-то" через create_event → должен получить toolError

## Ожидаемый результат

**До**: Claude видит "надо переделать" в одном сообщении → извлекает "Переделать что-то в будущем"

**После**: Claude видит все сообщения + название чата "invapp-panavto" → понимает что разговор о выборе сервиса транскрипции → извлекает "Использовать внутренний сервис транскрибации вместо OpenAI для invapp-panavto"
