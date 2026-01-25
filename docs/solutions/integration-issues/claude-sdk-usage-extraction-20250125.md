---
module: ClaudeAgentService
date: 2025-01-25
problem_type: integration_issue
component: claude_agent_sdk
symptoms:
  - "Usage всегда 0 токенов"
  - "tokensUsed: 0 при успешном извлечении фактов"
root_cause: wrong_message_type
severity: medium
tags: [claude-sdk, usage, tokens, snake_case]
---

# Claude SDK Usage Extraction Issue

## Симптомы

- `tokensUsed: 0` в ответе extraction endpoint
- Claude успешно обрабатывает запросы (получаем JSON ответ)
- Логи показывают `Usage: in=0, out=0`

## Исследование

1. SDK возвращает сообщения разных типов: `system`, `assistant`, `result`
2. Код искал `usage` в `assistant` message
3. SDK фактически кладёт usage в `result` message

Лог с ключами result message:
```
keys=type,subtype,is_error,duration_ms,duration_api_ms,num_turns,result,session_id,total_cost_usd,usage,modelUsage,permission_denials,uuid
```

## Корневая причина

**Две проблемы:**

1. **Usage в неправильном message** — SDK кладёт usage в `result` message, а код ожидал в `assistant`

2. **Snake_case vs camelCase** — SDK использует `input_tokens`, `output_tokens`, а код ожидал `inputTokens`, `outputTokens`

## Решение

### До (неправильно)

```typescript
private accumulateUsage(message: SDKMessage, usage: UsageStats): void {
  if (message.type === 'assistant' && 'usage' in message && message.usage) {
    const u = message.usage as { inputTokens?: number; outputTokens?: number };
    usage.inputTokens += u.inputTokens || 0;  // ❌ camelCase
    usage.outputTokens += u.outputTokens || 0;
  }
}
```

### После (правильно)

```typescript
// Для assistant messages (на всякий случай)
private accumulateUsage(message: SDKMessage, usage: UsageStats): void {
  if (message.type === 'assistant' && 'usage' in message && message.usage) {
    const u = message.usage as {
      input_tokens?: number;   // ✅ snake_case
      output_tokens?: number;
    };
    usage.inputTokens += u.input_tokens || 0;
    usage.outputTokens += u.output_tokens || 0;
  }
}

// Для result message (основной источник)
private accumulateUsageFromResult(resultMessage: SDKResultMessage, usage: UsageStats): void {
  const msg = resultMessage as {
    usage?: { input_tokens?: number; output_tokens?: number };
    total_cost_usd?: number;
  };

  if (msg.usage) {
    usage.inputTokens += msg.usage.input_tokens || 0;
    usage.outputTokens += msg.usage.output_tokens || 0;
  }
  if (msg.total_cost_usd) {
    usage.totalCostUsd += msg.total_cost_usd;
  }
}
```

И вызов в oneshot mode:

```typescript
if (message.type === 'result') {
  const resultMessage = message as SDKResultMessage;
  this.accumulateUsageFromResult(resultMessage, usage);  // ✅
  // ...
}
```

## Профилактика

1. При работе с SDK всегда логировать структуру сообщений: `Object.keys(message)`
2. SDK использует snake_case, не camelCase
3. Usage находится в result message, не assistant

## Связанные файлы

- `apps/pkg-core/src/modules/claude-agent/claude-agent.service.ts`

## Связанные проблемы

- [Missing outputFormat in Agent Mode](./structured-output-undefined-agent-mode-20260124.md) — `structured_output` undefined если не передать `outputFormat`
- [Claude OAuth Token Expired](./claude-oauth-token-expired-ClaudeAgent-20260125.md) — истёкший OAuth токен также приводит к нулевым результатам

## Результат

После исправления:
```json
{
  "tokensUsed": 283,
  "facts": []
}
```

Usage корректно: in=3 + out=280 = 283 токена.
