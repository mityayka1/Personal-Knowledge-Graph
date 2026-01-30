---
module: PKG
date: 2026-01-30
problem_type: integration_issue
component: service_object
symptoms:
  - "Telegram Adapter stored full recall session data locally"
  - "Build errors: missing sessionId in RecallResponseData interface"
  - "DailyContextCacheService exported types that no longer existed"
root_cause: config_error
resolution_type: code_fix
severity: medium
tags: [source-agnostic, session-storage, redis, nestjs, microservices, recall-api]
---

# Troubleshooting: Recall Session Storage Centralization

## Problem

Telegram Adapter was storing full recall session data (`{ dateStr, answer, sources, model }`) locally in Redis, violating the Source-Agnostic Architecture principle where PKG Core should be the single data owner.

## Environment
- Module: PKG (Telegram Adapter + PKG Core)
- Framework: NestJS with TypeORM
- Affected Components: `DailyContextCacheService`, `DailySummaryHandler`, `RecallSessionService`
- Date: 2026-01-30

## Symptoms

1. **Architecture violation:** Telegram Adapter owned session data instead of delegating to PKG Core
2. **Build errors (12 total):**
   - `recall.handler.spec.ts:188` — missing `sessionId` property in mock data (7 instances)
   - `src/common/cache/index.ts:1` — exports non-existent `DailyContext` and `RecallSource` types
3. **Data inconsistency risk:** Session data split between two services

## What Didn't Work

**Direct solution:** The architectural problem was identified and fixed with proper refactoring from the start.

## Solution

### 1. New `RecallSessionService` in PKG Core

Created centralized session storage with Redis backend:

```typescript
// apps/pkg-core/src/modules/claude-agent/recall-session.service.ts
@Injectable()
export class RecallSessionService {
  private readonly REDIS_PREFIX = 'recall-session:';
  private readonly TTL_SECONDS = 86400; // 24 hours

  async create(data: CreateRecallSessionDto): Promise<RecallSession> {
    const sessionId = `rs_${randomId(12)}`;
    const session: RecallSession = {
      id: sessionId,
      query: data.query,
      dateStr: data.dateStr,
      answer: data.answer,
      sources: data.sources,
      model: data.model,
      createdAt: Date.now(),
    };
    await this.redis.setex(
      `${this.REDIS_PREFIX}${sessionId}`,
      this.TTL_SECONDS,
      JSON.stringify(session),
    );
    return session;
  }

  async get(sessionId: string): Promise<RecallSession | null> {
    const data = await this.redis.get(`${this.REDIS_PREFIX}${sessionId}`);
    return data ? JSON.parse(data) : null;
  }
}
```

### 2. New API Endpoints in PKG Core

Added session-related endpoints to `AgentController`:

```typescript
// apps/pkg-core/src/modules/claude-agent/agent.controller.ts

@Get('recall/session/:sessionId')
async getRecallSession(@Param('sessionId') sessionId: string) {
  const session = await this.recallSessionService.get(sessionId);
  if (!session) throw new NotFoundException('Session not found');
  return { success: true, data: session };
}

@Post('recall/session/:sessionId/followup')
async followupRecall(
  @Param('sessionId') sessionId: string,
  @Body() body: RecallFollowupRequestDto,
) {
  // Continue conversation in session context
}

@Post('recall/session/:sessionId/extract')
async extractFromSession(
  @Param('sessionId') sessionId: string,
  @Body() body: RecallExtractRequestDto,
) {
  // Extract structured data from session
}
```

### 3. Refactored `DailyContextCacheService` (Telegram Adapter)

Changed from storing full context to storing only `messageId → sessionId` mapping:

```typescript
// BEFORE (broken architecture):
interface DailyContext {
  dateStr: string;
  lastAnswer: string;
  sources: RecallSource[];
  model?: string;
}
await this.cache.set(messageId, fullContext);

// AFTER (correct):
// Only store mapping, delegate data storage to PKG Core
await this.cache.setSessionId(messageId, sessionId);
const sessionId = await this.cache.getSessionId(messageId);
```

### 4. Fixed Test Mocks

Added `sessionId` to all `RecallResponseData` mock objects:

```typescript
// BEFORE:
const mockResponse = {
  success: true,
  data: { answer: 'Test', sources: [], toolsUsed: [] },
};

// AFTER:
const mockResponse = {
  success: true,
  data: { sessionId: 'rs_test123', answer: 'Test', sources: [], toolsUsed: [] },
};
```

### 5. Fixed Index Exports

```typescript
// BEFORE:
export { DailyContextCacheService, DailyContext, RecallSource } from './daily-context-cache.service';

// AFTER:
export { DailyContextCacheService } from './daily-context-cache.service';
```

## Why This Works

### Root Cause Analysis

1. **Architectural violation:** Telegram Adapter was acting as a data owner instead of a stateless proxy
2. **Interface mismatch:** `RecallResponseData` gained a `sessionId` field, but test mocks weren't updated
3. **Stale exports:** Types were removed from service but still exported from index

### Why the Solution Addresses This

1. **Single data owner:** PKG Core now owns all session data via `RecallSessionService`
2. **Stateless adapter:** Telegram Adapter stores only lightweight `messageId → sessionId` mapping
3. **API-based access:** All session operations go through PKG Core REST API
4. **Future extensibility:** Other clients can use the same session API without code changes

## Architecture After Fix

```
┌─────────────────────┐     ┌─────────────────────┐
│  Telegram Adapter   │     │      PKG Core       │
│  (stateless proxy)  │────►│   (data owner)      │
│                     │     │                     │
│ messageId→sessionId │     │ sessionId→{         │
│    (lightweight)    │     │   dateStr,          │
│                     │     │   answer,           │
│                     │     │   sources[],        │
│                     │     │   model             │
│                     │     │ }                   │
└─────────────────────┘     └────────┬────────────┘
                                     │
                            ┌────────▼────────┐
                            │     Redis       │
                            │  (24h TTL)      │
                            └─────────────────┘
```

## Prevention

1. **Follow Source-Agnostic principle:** Adapters should be stateless proxies, not data owners
2. **When adding new data storage:** Always ask "who owns this data?" — the answer should be PKG Core
3. **Interface changes:** When modifying DTOs, search for all usages including test mocks
4. **Export cleanup:** When removing types from a file, update index.ts exports immediately
5. **CI validation:** Run `pnpm build` on both services before committing

## Verification Commands

```bash
# Build both services
cd apps/pkg-core && pnpm build
cd apps/telegram-adapter && pnpm build

# Run tests
cd apps/telegram-adapter && pnpm test -- --testPathPattern=recall.handler.spec

# Verify no stale exports
grep -r "DailyContext\|RecallSource" apps/telegram-adapter/src/common/cache/
```

## Related Issues

- See also: [source-agnostic-architecture-prevention.md](./source-agnostic-architecture-prevention.md) — Original Source-Agnostic principle documentation
- GitHub PR: [#111](https://github.com/mityayka1/Personal-Knowledge-Graph/pull/111) — Implementation of this fix
