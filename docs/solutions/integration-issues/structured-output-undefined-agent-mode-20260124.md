---
module: PKG Core - Extraction
date: 2026-01-24
problem_type: integration_issue
component: service_object
symptoms:
  - "Agent mode endpoint returns factsCreated: 0 despite facts being created"
  - "E2E tests pass but real API calls return wrong values"
  - "structured_output is undefined in agent response"
root_cause: config_error
resolution_type: code_fix
severity: high
tags: [claude-agent-sdk, outputFormat, structured-output, agent-mode]
---

# Missing outputFormat in Agent Mode Causes structured_output Undefined

## Summary

При вызове Claude Agent SDK в режиме `mode: 'agent'` без параметра `outputFormat`, поле `structured_output` в ответе будет `undefined`. Это приводит к тому, что код с fallback-значениями (`data?.field ?? 0`) всегда возвращает значения по умолчанию, даже когда операции выполняются успешно.

## Symptom

```typescript
// API возвращает
{ factsCreated: 0, relationsCreated: 0, pendingEntitiesCreated: 0 }

// Хотя в логах видно что факты создаются через MCP tools
// И в базе данных появляются новые записи
```

E2E тесты проходят успешно (моки возвращают `structured_output`), но реальные API вызовы возвращают нули.

## Root Cause

В коде отсутствовал параметр `outputFormat` при вызове `claudeAgentService.call()`:

```typescript
// ❌ НЕПРАВИЛЬНО - structured_output будет undefined
const { data } = await this.claudeAgentService.call<AgentExtractionResponse>({
  mode: 'agent',
  taskType: 'fact_extraction',
  prompt,
  // НЕТ outputFormat → Claude не знает какую схему использовать
});

// data = undefined, поэтому:
const result = {
  factsCreated: data?.factsCreated ?? 0,  // Всегда 0!
};
```

Без JSON Schema Claude SDK не заполняет поле `structured_output` в ответе.

## Investigation Steps

1. Проверил E2E тесты — все проходят ✅
2. Запустил реальный API вызов — `factsCreated: 0` ❌
3. Проверил логи — факты создаются через `create_fact` tool ✅
4. Проверил базу данных — записи появляются ✅
5. Проанализировал код — обнаружил отсутствие `outputFormat`
6. Сравнил с документацией Claude Agent SDK — подтвердил что `outputFormat` обязателен

## Solution

Добавить `outputFormat` с JSON Schema к вызову агента:

```typescript
// ✅ ПРАВИЛЬНО - structured_output будет заполнен
const AGENT_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    factsCreated: {
      type: 'number',
      description: 'Number of facts created via create_fact tool',
    },
    relationsCreated: {
      type: 'number',
      description: 'Number of relations created via create_relation tool',
    },
    pendingEntitiesCreated: {
      type: 'number',
      description: 'Number of pending entities created',
    },
    summary: {
      type: 'string',
      description: 'Brief summary of what was extracted',
    },
  },
  required: ['factsCreated', 'relationsCreated', 'pendingEntitiesCreated'],
};

const { data } = await this.claudeAgentService.call<AgentExtractionResponse>({
  mode: 'agent',
  taskType: 'fact_extraction',
  prompt,
  outputFormat: {
    type: 'json_schema',
    schema: AGENT_EXTRACTION_SCHEMA,
    strict: true,
  },
});

// Теперь data.factsCreated содержит реальное значение
```

**Также обновить prompt** чтобы Claude знал что нужно посчитать вызовы инструментов:

```typescript
const prompt = `
...
После завершения извлечения, посчитай количество успешных вызовов каждого инструмента и верни в ответе.
`;
```

## Files Changed

- `apps/pkg-core/src/modules/extraction/fact-extraction.service.ts`
  - Добавлен `AGENT_EXTRACTION_SCHEMA` constant
  - Добавлен `outputFormat` параметр в `extractFactsAgent()`
  - Обновлён prompt для подсчёта вызовов

## Prevention

1. **Правило:** Любой `mode: 'agent'` вызов, который должен вернуть структурированные данные, ОБЯЗАН передавать `outputFormat` с JSON Schema

2. **Используй raw JSON Schema**, НЕ `z.toJSONSchema()` — SDK не поддерживает формат Zod 4

3. **Тестируй на реальных данных**, не только E2E с моками — см. [docs/TESTING_REAL_DATA.md](../../TESTING_REAL_DATA.md)

4. **Добавлено в CLAUDE.md** — секция "КРИТИЧНО: outputFormat обязателен для structured data"

## Related Issues

- Задокументировано в CLAUDE.md: секция "Claude Agent SDK — Правила работы"
- Создан гайд: docs/TESTING_REAL_DATA.md
- [Claude OAuth Token Expired](./claude-oauth-token-expired-ClaudeAgent-20260125.md) — другая причина сбоя agent mode (401 auth errors)
- [Claude SDK Usage Extraction](./claude-sdk-usage-extraction-20250125.md) — usage в `result` message, не `assistant` + snake_case поля
- [**Claude SDK Snake_Case — Системная проблема**](./claude-sdk-snake-case-systemic-20250125.md) — централизованный трансформер для snake_case → camelCase

## Verification

```bash
# 1. Получить реальное сообщение
curl -s http://localhost:3000/api/v1/messages?limit=1 | jq '.[0].id'

# 2. Запустить extraction
curl -X POST http://localhost:3000/api/v1/extraction/facts/agent \
  -H "Content-Type: application/json" \
  -d '{"messageId": "<id>"}' | jq '.factsCreated'

# Должно вернуть число > 0 если факты есть в сообщении
```
