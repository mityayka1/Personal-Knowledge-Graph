---
module: Extraction Pipeline
date: 2026-02-15
problem_type: logic_error
component: service_object
symptoms:
  - "Claude извлекает абстрактные события ('Переделать что-то в будущем') вместо конкретных"
  - "Per-message анализ без понимания контекста разговора целиком"
  - "Отсутствие chat title приводит к деконтекстуализированным извлечениям"
  - "Vague titles с датой обходят фильтр через escape !args.date"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [extraction, prompt-engineering, chat-context, vague-filter, two-phase-prompt]
---

# Troubleshooting: Vague Extraction Due to Missing Context Understanding

## Problem

Extraction pipeline генерировал мусорные данные: Claude анализировал сообщения по одному, извлекая абстрактные формулировки без контекста беседы. Реальный пример: вместо "Использовать внутренний сервис транскрибации вместо OpenAI для invapp-panavto" извлекалось "Переделать что-то в будущем" (conf: 0.7).

## Environment
- Module: Extraction Pipeline (UnifiedExtractionService, GroupExtractionService, FactExtractionProcessor)
- Framework: NestJS + Claude Agent SDK
- Affected Component: Prompt design, chat title pipeline, vague content filter
- Date: 2026-02-15

## Symptoms
- Claude извлекал абстрактные события ("Переделать что-то в будущем", "Обсудить вопрос", "Сделать задачу")
- Каждый element из extraction можно было приложить к ЛЮБОМУ разговору — полная деконтекстуализация
- Chat title (напр. "invapp-panavto") не передавался в extraction prompt, хотя был доступен через ChatCategory
- Events с vague title, но с датой, обходили фильтр через `isVagueContent(args.title) && !args.date`

## What Didn't Work

**Attempted Solution 1:** Noise filtering (первая волна — shift-left подход)
- **Почему недостаточно:** `VAGUE_PATTERNS` и `NOISE_PATTERNS` отфильтровали техническую лексику Claude, но Claude продолжал генерировать "человекоподобный" мусор — фразы, формально не содержащие vague words, но всё равно абстрактные. Проблема была в **промпте**, а не в фильтре.

**Attempted Solution 2:** Activity context в промпте (первая волна)
- **Почему недостаточно:** Claude получил список активностей, но без инструкции "сначала пойми контекст" продолжал извлекать per-message, игнорируя общую тему разговора.

## Solution

4 области изменений, решающих **фундаментальную проблему** — Claude анализировал сообщения по одному.

### Область 1: Prompt Restructuring — "Пойми, потом извлекай"

**Файл:** `unified-extraction.service.ts` — `buildUnifiedPrompt()`

Заменена секция ЗАДАНИЕ на двухфазную инструкцию:

```typescript
// Before (broken):
// Просто "Проанализируй все сообщения" — Claude не имел инструкции понять контекст

// After (fixed):
`══════════════════════════════════════════
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

КРИТИЧНО: Каждый извлечённый элемент должен:
1. Быть понятен БЕЗ возврата к переписке
2. Содержать конкретику, а не расплывчатые формулировки
3. Быть привязан к контексту разговора (проект, тема, цель)`
```

Добавлены анти-примеры в секцию § СОБЫТИЯ (правило 8):

```
8. АНТИ-ПРИМЕРЫ — НЕ извлекай подобное:
   ❌ "Переделать что-то в будущем" — нет конкретики.
      Правильно: "Перенести транскрибацию на внутренний сервис для invapp-panavto"
   ❌ "Обсудить вопрос" — нет объекта.
      Правильно: "Согласовать стоимость лицензии $200/мес с клиентом X"
   ❌ "Сделать задачу" — пересказ, не извлечение. Указывай ЧТО конкретно.
   Правило: если title можно приложить к ЛЮБОМУ разговору — оно слишком абстрактное.
```

### Область 2: Chat Title Pipeline

Цепочка для проброса `chatCategory.title` в extraction prompt:

**Шаг 1 — Types** (`unified-extraction.types.ts`):
```typescript
export interface UnifiedExtractionParams {
  // ... existing fields
  /** Chat title from ChatCategory — provides conversation topic context */
  chatTitle?: string;
}
```

**Шаг 2 — Processor** (`fact-extraction.processor.ts`):
```typescript
// Inject ChatCategoryService
@Optional()
@Inject(forwardRef(() => ChatCategoryService))
private chatCategoryService: ChatCategoryService | null,

// Resolve chat title from interaction's telegram_chat_id
private async resolveChatTitle(interaction: Interaction | null): Promise<string | undefined> {
  if (!interaction || !this.chatCategoryService) return undefined;
  const telegramChatId = interaction.sourceMetadata?.telegram_chat_id;
  if (!telegramChatId) return undefined;
  const category = await this.chatCategoryService.getCategory(String(telegramChatId));
  return category?.title;
}
```

**Шаг 3 — Prompt** (`unified-extraction.service.ts`):
```typescript
const chatTitleSection = chatTitle
  ? `\nЧАТ: "${chatTitle}"\nУчитывай название чата как контекст беседы — оно указывает на тему или проект обсуждения.\n`
  : '';
```

**Performance:** Один indexed query `getCategory(telegramChatId)` на extraction job (~1 раз в 10 минут).

### Область 3: Fix Vague Content Filter

**Файл:** `extraction-tools.provider.ts`

```typescript
// Before (broken) — date was an escape hatch:
if (isVagueContent(args.title) && !args.date) {
  return toolError('Event title is too vague', '...');
}

// After (fixed) — vague is vague regardless of date:
if (isVagueContent(args.title)) {
  return toolError(
    'Event title is too vague',
    'Title contains placeholder words (что-то, как-нибудь). ' +
    'Use specific details from conversation: project name, action object, person. ' +
    'Example: instead of "переделать что-то" use "перенести транскрибацию на внутренний сервис для invapp-panavto".',
  );
}
```

**Обоснование:** "Переделать что-то в будущем" с любой датой — всё ещё мусор. Дата не компенсирует отсутствие конкретики. Claude получит toolError с actionable подсказкой и переформулирует.

### Область 4: Group Extraction — аналогичные изменения

**Файл:** `group-extraction.service.ts` — `buildGroupPrompt()`

Применена та же двухфазная инструкция и анти-примеры. Chat title уже передавался через параметр `chatName`, но был `undefined` — теперь заполняется через `resolveChatTitle()`.

## Why This Works

### Root Cause
Промпт не содержал инструкции "сначала пойми контекст". Claude Agent SDK обрабатывает промпт последовательно — если инструкция не упомянута явно, LLM начнёт извлечение сразу, без фазы осмысления.

### Почему двухфазный промпт работает
1. **ФАЗА 1** заставляет LLM прочитать ВСЕ сообщения и сформировать mental model разговора
2. **ФАЗА 2** использует эту model для извлечения, привязывая каждый element к общему контексту
3. **Анти-примеры** дают in-context learning — Claude видит пары "плохо → хорошо" и калибрует
4. **Chat title** даёт тематическую привязку — "invapp-panavto" сразу сужает scope интерпретации

### Почему `!args.date` escape был проблемой
Дата — метаданные события, не показатель его конкретности. "Переделать что-то 15 января" — такой же мусор, как "Переделать что-то в будущем". Фильтр должен проверять title на vagueness безусловно.

## Prevention

### 1. Prompt Design для LLM Extraction
- **Всегда** структурируй как двухфазный процесс: ПОЙМИ → ИЗВЛЕКИ
- Включай анти-примеры (пары "плохо → хорошо") — это эффективнее абстрактных правил
- Передавай контекст среды (chat title, project name) — LLM не может его угадать

### 2. Filter Design
- Фильтры качества (isVagueContent, isNoiseContent) должны быть **безусловными** — не добавлять escape-хетчи через другие поля
- `toolError()` с actionable message > молчаливый пропуск — in-context learning для агента

### 3. Context Pipeline
- При добавлении нового источника контекста — пробрасывать через всю цепочку: types → processor → service → prompt
- Проверять оба пути extraction (unified + group) — они имеют разные промпты

### 4. Chat Title как обязательный контекст
- `ChatCategoryService.getCategory(telegramChatId)` — один indexed query
- Если chat title не пустой — включать в промпт; это критически влияет на качество

## Changed Files

| File | Change | Area |
|------|--------|------|
| `unified-extraction.types.ts` | +`chatTitle?: string` | #2 |
| `fact-extraction.processor.ts` | +ChatCategoryService DI, +resolveChatTitle(), chatTitle passing | #2 |
| `job.module.ts` | +ChatCategoryModule import | #2 |
| `unified-extraction.service.ts` | Two-phase prompt, anti-patterns, chatTitle section | #1, #2 |
| `extraction-tools.provider.ts` | Remove `!args.date` escape, actionable error message | #3 |
| `group-extraction.service.ts` | Two-phase prompt, anti-patterns | #4 |

## Related Issues

- See also: [extraction-quality-prevention-pipeline-20260215.md](../integration-issues/extraction-quality-prevention-pipeline-20260215.md) — первая волна: noise filtering, commitment dedup, activity context, client boost
- See also: [docs/plans/fuzzy-tinkering-allen.md](../../plans/fuzzy-tinkering-allen.md) — исходный план реализации
- See also: [unified-extraction-refactoring-PKGCore-20260128.md](../integration-issues/unified-extraction-refactoring-PKGCore-20260128.md) — унификация 3 extraction flows в единый agent call
- See also: [pr103-entity-activity-extraction-20260130.md](../code-review-fixes/pr103-entity-activity-extraction-20260130.md) — code review fixes для extraction pipeline
- See also: [structured-output-undefined-agent-mode-20260124.md](../integration-issues/structured-output-undefined-agent-mode-20260124.md) — outputFormat обязателен для structured data
