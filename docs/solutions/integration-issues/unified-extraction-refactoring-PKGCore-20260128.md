---
module: PKG Core
date: 2026-01-28
problem_type: integration_issue
component: service_object
symptoms:
  - "3 параллельных extraction flow с дублирующимися типами"
  - "budgetUsd и onToolResult не реализованы"
  - "enrichmentData не заполняется в create_event tool"
  - "ExtractionMessage и MessageData — дублирующиеся интерфейсы"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [extraction, refactoring, unified-flow, tech-debt, agent-sdk]
---

# Troubleshooting: Унификация 3 extraction flows в единый agent call

## Problem
Три параллельных extraction сервиса (FactExtraction, EventExtraction, SecondBrainExtraction) с дублирующимися типами, отсутствующими фичами и несогласованным поведением. Tech debt накопился при быстром развитии функциональности.

## Environment
- Module: PKG Core (Extraction)
- Affected Components: ClaudeAgentService, ExtractionToolsProvider, UnifiedExtractionService
- Date: 2026-01-28

## Symptoms
- `ExtractionMessage` и `MessageData` — практически идентичные интерфейсы в разных файлах
- `budgetUsd` параметр в ClaudeAgentService не реализован (YAGNI violation)
- `onToolResult` hook объявлен но не работает
- `enrichmentData` не заполняется в `create_event` tool — enrichment pipeline не находит события
- 3 отдельных extraction flow вместо единого агента

## What Didn't Work

**Direct solution:** Проблемы были системными и требовали комплексного рефакторинга. Поэтапный подход:

1. Сначала создан UnifiedExtractionService с 6 MCP tools
2. Затем исправлены отдельные проблемы (budgetUsd, onToolResult, enrichmentData, types)

## Solution

### 1. budgetUsd — лимит бюджета для agent mode

```typescript
// apps/pkg-core/src/modules/claude-agent/claude-agent.service.ts

// В agent loop добавлен budget check с AbortController
const budgetUsd = params.budgetUsd;
let budgetExceeded = false;

for await (const message of query({...})) {
  this.accumulateUsage(message, usage);

  // Budget check: abort if cost exceeds limit
  if (budgetUsd !== undefined && usage.totalCostUsd > budgetUsd) {
    this.logger.warn(`Budget exceeded: $${usage.totalCostUsd.toFixed(4)} > $${budgetUsd}, aborting`);
    budgetExceeded = true;
    abortController.abort();
    break;
  }
  // ...
}

// После loop — throw если budget exceeded
if (result === undefined && budgetExceeded) {
  throw new Error(`Budget exceeded: $${usage.totalCostUsd.toFixed(4)} > $${budgetUsd}`);
}
```

### 2. onToolResult — hook для обработки результатов tools

```typescript
// apps/pkg-core/src/modules/claude-agent/claude-agent.service.ts

// Handle tool results for onToolResult hook
if (message.type === 'user' && params.hooks?.onToolResult) {
  await this.processToolResults(message, params.hooks.onToolResult);
}

// Новый метод для парсинга tool_result блоков из SDK user messages
private async processToolResults(
  message: SDKMessage,
  onToolResult: (toolName: string, result: string) => Promise<void>,
): Promise<void> {
  const messageAny = message as Record<string, unknown>;
  const content = messageAny.message?.content;

  if (!content || !Array.isArray(content)) return;

  for (const block of content) {
    if (block?.type === 'tool_result') {
      const resultText = typeof block.content === 'string'
        ? block.content
        : block.content?.map(c => c.text).join('\n');
      await onToolResult(block.tool_use_id || 'unknown', resultText || '');
    }
  }
}
```

### 3. enrichmentData — для enrichment pipeline

```typescript
// apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts

// В create_event tool
const event = this.extractedEventRepo.create({
  // ... existing fields ...
  needsContext: args.needsEnrichment,
  // Set enrichmentData for enrichment pipeline to find events needing context
  enrichmentData: args.needsEnrichment ? { enrichmentSuccess: false } : null,
});
```

### 4. Type consolidation

```typescript
// БЫЛО: 2 дублирующихся интерфейса
// unified-extraction.types.ts
export interface ExtractionMessage { ... }  // 15 строк

// job.service.ts
messages: Array<{ ... }>;  // 15 строк inline

// СТАЛО: единый тип MessageData
// extraction.types.ts — источник правды
export interface MessageData {
  id: string;
  content: string;
  timestamp: string;
  isOutgoing: boolean;
  senderEntityId?: string;
  senderEntityName?: string;
  isBotSender?: boolean;
  replyToSourceMessageId?: string;
  topicName?: string;
}

// unified-extraction.types.ts
import { MessageData } from './extraction.types';
export interface EnrichedMessage extends MessageData { ... }

// job.service.ts
import { MessageData } from '../extraction/extraction.types';
export interface ExtractionJobData {
  messages: MessageData[];
}
```

## Why This Works

1. **budgetUsd** — AbortController позволяет прервать agent loop mid-execution, а не только после завершения turn. Проверка после каждого message обеспечивает точный контроль.

2. **onToolResult** — SDK возвращает tool results в `user` messages с `type: 'tool_result'` блоками. Парсинг этих блоков позволяет hook получать результаты каждого tool call.

3. **enrichmentData** — Enrichment pipeline ищет события с `enrichmentData.enrichmentSuccess = false`. Без этого поля события с `needsEnrichment: true` не обрабатывались.

4. **Type consolidation** — `MessageData` уже имел required `timestamp` и `isOutgoing`, что соответствует реальному использованию. `ExtractionMessage` был избыточен.

## Prevention

- **Single Source of Truth**: Один тип для одной концепции. Если нужен тип для messages — используй `MessageData`.
- **YAGNI compliance**: Если объявляешь параметр/hook — реализуй его. Иначе не объявляй.
- **Enrichment pipeline**: События с `needsEnrichment: true` ДОЛЖНЫ иметь `enrichmentData: { enrichmentSuccess: false }`.
- **Unit tests**: Всегда писать тесты для новых сервисов (22 теста для UnifiedExtractionService).

## Related Issues

- See also: [structured-output-undefined-agent-mode](./structured-output-undefined-agent-mode-20260124.md) — outputFormat обязателен для structured data
- See also: [claude-sdk-snake-case-systemic](./claude-sdk-snake-case-systemic-20250125.md) — SDK возвращает snake_case поля
- See also: [claude-sdk-usage-extraction](./claude-sdk-usage-extraction-20250125.md) — usage в `result` message

## Files Changed

- `apps/pkg-core/src/modules/claude-agent/claude-agent.service.ts` — budgetUsd, onToolResult
- `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts` — enrichmentData
- `apps/pkg-core/src/modules/extraction/unified-extraction.types.ts` — type consolidation
- `apps/pkg-core/src/modules/extraction/unified-extraction.service.ts` — import update
- `apps/pkg-core/src/modules/job/job.service.ts` — type consolidation
- `apps/pkg-core/src/modules/extraction/unified-extraction.service.spec.ts` — 22 new tests
