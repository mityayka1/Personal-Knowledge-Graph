---
module: ClaudeAgentService
date: 2025-01-25
problem_type: integration_issue
component: claude_agent_sdk
symptoms:
  - "Поля SDK возвращают undefined или 0"
  - "Новые поля SDK не работают без ad-hoc патчей"
  - "Разные части кода используют разные naming conventions"
root_cause: missing_transformer
severity: medium
tags: [claude-sdk, snake_case, camelCase, systemic, technical-debt]
---

# Claude SDK Snake_Case — Системная проблема

## Суть проблемы

**Claude Agent SDK использует snake_case**, а наш код — camelCase. Вместо единого трансформера мы патчим каждый случай локально.

## Доказательства

### SDK Response Structure (реальные поля)

```typescript
// Result message от SDK
{
  type: 'result',
  subtype: 'success',
  result: '...',
  structured_output: {...},      // НЕ structuredOutput
  usage: {
    input_tokens: 123,           // НЕ inputTokens
    output_tokens: 456,          // НЕ outputTokens
  },
  total_cost_usd: 0.0045,        // НЕ totalCostUsd
  duration_ms: 1234,
  session_id: '...',
}
```

### Наши типы (ожидаемые поля)

```typescript
// claude-agent.types.ts
interface UsageStats {
  inputTokens: number;      // camelCase
  outputTokens: number;
  totalCostUsd: number;
}
```

### Текущие ad-hoc решения (разбросаны по коду)

```typescript
// claude-agent.service.ts:328-330
// Fallback на оба варианта
usage.inputTokens += u.input_tokens || u.inputTokens || 0;
usage.outputTokens += u.output_tokens || u.outputTokens || 0;
usage.totalCostUsd += u.cost_usd || u.costUSD || 0;

// claude-agent.service.ts:242
// Прямой доступ к snake_case
if (msgAny.structured_output !== undefined)

// claude-agent.service.ts:340-349
// Ещё один метод с snake_case
msg.usage.input_tokens
msg.total_cost_usd
```

## Последствия

1. **Каждое новое поле SDK** требует debugging + ad-hoc патч
2. **Нет единого источника правды** — документация SDK не синхронизирована с типами
3. **Code review усложняется** — нужно знать про snake_case
4. **Тесты с моками** проходят (моки используют camelCase), production падает

## Варианты решения

### Вариант A: Централизованный трансформер (рекомендуется)

```typescript
// sdk-transformer.ts
import { snakeToCamel } from 'some-utility';

interface SDKResultMessage {
  // Реальная структура SDK
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
  // ...
}

interface NormalizedResult<T> {
  structuredOutput?: T;
  usage: UsageStats;
  // ...
}

export function normalizeSDKResult<T>(msg: SDKResultMessage): NormalizedResult<T> {
  return {
    structuredOutput: msg.structured_output as T,
    usage: {
      inputTokens: msg.usage?.input_tokens ?? 0,
      outputTokens: msg.usage?.output_tokens ?? 0,
      totalCostUsd: msg.total_cost_usd ?? 0,
    },
  };
}
```

**Плюсы:** Единый источник правды, легко обновлять
**Минусы:** Требует рефакторинг

### Вариант B: Принять snake_case везде

Изменить наши типы на snake_case:

```typescript
interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
}
```

**Плюсы:** Нет трансформации, прямое соответствие SDK
**Минусы:** Ломает consistency с остальным кодом (NestJS, TypeORM — camelCase)

### Вариант C: Статус-кво с документацией

Продолжать ad-hoc патчи, но задокументировать:

1. Добавить в CLAUDE.md правило: "SDK использует snake_case"
2. В каждом месте работы с SDK — комментарий о naming

**Плюсы:** Минимум изменений сейчас
**Минусы:** Технический долг растёт

## Рекомендация

~~**Краткосрочно (сейчас):** Вариант C — документировать паттерн в CLAUDE.md~~

~~**Среднесрочно (при рефакторинге ClaudeAgentService):** Вариант A — создать `normalizeSDKResult()`~~

### ✅ РЕШЕНО — Вариант A реализован

**PR:** [#90 feat(claude-agent): add centralized SDK response transformer](https://github.com/mityayka1/Personal-Knowledge-Graph/pull/90)

Создан `sdk-transformer.ts` с:
- SDK типами (`SDKUsage`, `SDKResultFields`)
- Normalized типами (`NormalizedResultFields<T>`)
- Функциями трансформации (`normalizeSDKResult<T>()`, `accumulateSDKUsage()`, etc.)

## Связанные проблемы

- [Claude SDK Usage Extraction](./claude-sdk-usage-extraction-20250125.md) — конкретный случай с usage
- [Missing outputFormat](./structured-output-undefined-agent-mode-20260124.md) — structured_output undefined
- [OAuth Token Expired](./claude-oauth-token-expired-ClaudeAgent-20260125.md) — другой класс SDK проблем

## Затронутые файлы

- `apps/pkg-core/src/modules/claude-agent/claude-agent.service.ts` — основной файл
- `apps/pkg-core/src/modules/claude-agent/claude-agent.types.ts` — типы (camelCase)
- Любой код, работающий с SDK response напрямую

## Action Items

- [x] Добавить в CLAUDE.md секцию "SDK Naming Convention"
- [x] Создать `normalizeSDKResult()` — PR #90
- [x] Добавить SDK-специфичные интерфейсы (`SDKUsage`, `SDKResultFields`)
- [x] Протестировано в production (2026-01-25)

## Результаты тестирования

**Дата:** 2026-01-25
**Метод:** POST /api/v1/extraction/facts с тестовым сообщением

### Тестовый запрос
```bash
curl -X POST -H "X-API-Key: ..." \
  "http://localhost:3000/api/v1/extraction/facts" \
  -d '{"entityId":"test","entityName":"Тест","messageContent":"Иван работает в Сбербанке с 2020 года."}'
```

### Результат
```json
{
  "entityId": "test-entity-id",
  "facts": [
    {"factType": "company", "value": "Сбербанк", "confidence": 0.95},
    {"factType": "phone", "value": "+79001234567", "confidence": 0.95}
  ],
  "tokensUsed": 143
}
```

### Логи подтверждают корректную работу
```
Claude oneshot success: task=fact_extraction, duration=3310ms, tokens=3/140
```

### Статистика до/после
| Метрика | До теста | После теста |
|---------|----------|-------------|
| totalRuns | 24 | 25 |
| totalTokensIn | 9 | 12 (+3) |
| totalTokensOut | 564 | 704 (+140) |

**Вывод:** Трансформер `sdk-transformer.ts` корректно преобразует snake_case → camelCase
