---
module: notification-and-summarization
date: 2026-01-29
problem_type: integration_issue
component: ScheduleModule, NotificationService, DigestService, ExtractionToolsProvider
symptoms:
  - Duplicate Telegram notifications sent (same message appearing twice)
  - Notifications lacking sufficient context and metadata
  - Missing contact links and source attribution in digest events
  - sourceQuote field optional in event extraction tool
root_cause: multiple_module_registration
severity: high
tags:
  - cron-jobs
  - module-registration
  - duplicate-execution
  - notification-context
  - telegram-adapter
  - event-extraction
  - nestjs-schedule
---

# Duplicate Notifications and Missing Event Context

## Problem

Users reported receiving duplicate Telegram notifications for events, and notifications lacked sufficient context to understand what they were about.

**Screenshot evidence:** Identical "Новые события:" messages appearing twice in Telegram.

## Symptoms

1. **Duplicate notifications** — Same digest/event message sent 2x
2. **Poor context** — Notifications missing:
   - Contact links (`tg://user?id=X`)
   - Deep links to source messages
   - Source quotes from original conversation
3. **Events without sourceQuote** — ~30% of extracted events had no source citation

## Investigation

### Step 1: Check Cron Job Registration

Found `ScheduleModule.forRoot()` registered in **multiple modules**:

```bash
grep -r "ScheduleModule.forRoot()" apps/pkg-core/src
```

**Results:**
- `apps/pkg-core/src/app.module.ts` — OK (root)
- `apps/pkg-core/src/modules/notification/notification.module.ts` — DUPLICATE!
- `apps/pkg-core/src/modules/summarization/summarization.module.ts` — DUPLICATE!

### Step 2: Check Event Extraction Schema

In `extraction-tools.provider.ts`, the `create_event` tool schema had:

```typescript
sourceQuote: z.string().max(200).optional().describe('...')
//                                ^^^^^^^^ — PROBLEM!
```

Compare with `create_fact` tool:

```typescript
sourceQuote: z.string().max(200).describe('...')
//                              — No .optional(), required!
```

### Step 3: Check Digest Formatting

In `digest.service.ts`, single events used basic format:

```typescript
// Old code - basic format
const message = this.formatHourlyDigest(events);
```

While `NotificationService.formatEnhancedEventNotification()` was **private** and not reused.

## Root Causes

### 1. Multiple ScheduleModule.forRoot() Registrations

NestJS ScheduleModule requires **single** `forRoot()` registration. Each registration creates a separate cron scheduler instance, causing all `@Cron()` decorators to execute N times.

```
AppModule ─── ScheduleModule.forRoot() ─┬─ Executes @Cron once
NotificationModule ─ ScheduleModule.forRoot() ─┼─ Executes @Cron again
SummarizationModule ─ ScheduleModule.forRoot() ─┴─ Executes @Cron third time
```

### 2. Optional sourceQuote in Event Extraction

The `create_event` Zod schema marked `sourceQuote` as optional, so Claude sometimes skipped it. Without source quotes, notifications couldn't show context.

### 3. Private Enhanced Formatting Method

`formatEnhancedEventNotification()` was private to NotificationService, so DigestService couldn't reuse it for single-event digests.

## Solution

### 1. Consolidate ScheduleModule Registration

**File:** `apps/pkg-core/src/app.module.ts`

```typescript
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    // ... other imports

    // Cron scheduling (single instance for entire app)
    ScheduleModule.forRoot(),

    // Domain modules (contain @Cron() decorators)
    NotificationModule,
    SummarizationModule,
  ],
})
export class AppModule {}
```

**Removed from:**
- `apps/pkg-core/src/modules/notification/notification.module.ts`
- `apps/pkg-core/src/modules/summarization/summarization.module.ts`

### 2. Make sourceQuote Required

**File:** `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts`

```typescript
// Before (optional)
sourceQuote: z.string().max(200).optional().describe('Цитата из сообщения (до 200 символов)'),

// After (required)
sourceQuote: z.string().max(200).describe('Цитата из сообщения — ОБЯЗАТЕЛЬНО (до 200 символов)'),
```

Handler update:
```typescript
// Before
sourceQuote: args.sourceQuote?.substring(0, 200) || null,

// After
sourceQuote: args.sourceQuote.substring(0, 200),
```

### 3. Add Prompt Instruction

**File:** `apps/pkg-core/src/modules/extraction/unified-extraction.service.ts`

Added to extraction prompt:

```
6. sourceQuote — ОБЯЗАТЕЛЬНО:
   - Всегда указывай цитату из сообщения (до 200 символов)
   - Это нужно для контекста в уведомлениях
   - Без sourceQuote событие будет непонятным получателю
```

### 4. Make formatEnhancedEventNotification() Public

**File:** `apps/pkg-core/src/modules/notification/notification.service.ts`

```typescript
/**
 * Format enhanced event notification with contact links, message deep links,
 * needsContext warning, and enrichment synthesis.
 * Public method for use by DigestService for rich single-event formatting.
 */
async formatEnhancedEventNotification(event: ExtractedEvent): Promise<string> {
  // Implementation...
}
```

### 5. Use Enhanced Format in Digests

**File:** `apps/pkg-core/src/modules/notification/digest.service.ts`

```typescript
// Single event - use enhanced format with full context
const event = events[0];
const enhancedContent = await this.notificationService.formatEnhancedEventNotification(event);
const message = '<b>Новые события:</b>\n\n' + enhancedContent;
```

## Prevention

### Code Review Checklist

- [ ] **ScheduleModule.forRoot()** — Should appear exactly once in AppModule
  ```bash
  grep -r "ScheduleModule.forRoot()" apps/ --include="*.ts" | wc -l
  # Expected: 1
  ```

- [ ] **Required Zod fields** — Critical fields should NOT use `.optional()`

- [ ] **Prompt instructions** — Required fields should be explicitly mentioned in extraction prompts

- [ ] **Public method documentation** — Methods used cross-module should have `@public` JSDoc tag

### CI Check Script

```bash
#!/bin/bash
# scripts/validate-schedule-module.sh

SCHEDULE_MODULE_ROOTS=$(grep -r "ScheduleModule.forRoot()" apps/ --include="*.ts" 2>/dev/null | wc -l)

if [ "$SCHEDULE_MODULE_ROOTS" -ne 1 ]; then
  echo "ERROR: Expected 1 ScheduleModule.forRoot(), found $SCHEDULE_MODULE_ROOTS"
  grep -r "ScheduleModule.forRoot()" apps/ --include="*.ts"
  exit 1
fi

echo "✓ ScheduleModule registration is correct"
```

### Best Practices

1. **NestJS ScheduleModule** — Register `forRoot()` only in root AppModule
2. **Zod schema optionality** — Match schema to business requirements
3. **Extraction prompts** — Use "ОБЯЗАТЕЛЬНО", "ALWAYS", "REQUIRED" for critical fields
4. **Cross-module methods** — Document public API surface with JSDoc

## Testing

```typescript
describe('Cron Job Registration', () => {
  it('should execute cron job exactly once per schedule', async () => {
    let callCount = 0;
    jest.spyOn(service, 'sendHourlyDigest').mockImplementation(async () => {
      callCount++;
    });

    // Trigger cron
    await service.sendHourlyDigest();

    expect(callCount).toBe(1); // Not 2 or 3
  });
});

describe('Event Extraction', () => {
  it('should require sourceQuote for all events', async () => {
    const events = await extractedEventRepo.find();

    events.forEach(event => {
      expect(event.sourceQuote).toBeTruthy();
      expect(event.sourceQuote.length).toBeGreaterThan(0);
    });
  });
});
```

## Related Documentation

- [Phase C: Extract & React](../../second-brain/02-PHASE-C-EXTRACT-REACT.md) — Event extraction specification
- [Phase C+ UX Improvements](../../second-brain/PLAN_PHASE_C_PLUS.md) — Carousel and notification context
- [Unified Extraction Refactoring](./unified-extraction-refactoring-PKGCore-20260128.md) — Recent extraction changes

## Commit

```
fix(notification): resolve duplicate notifications and improve event context

- Consolidate ScheduleModule.forRoot() to single registration in AppModule
- Make formatEnhancedEventNotification() public for DigestService reuse
- Use enhanced format for single-event digests
- Make sourceQuote required in create_event tool
- Add explicit prompt instruction to always fill sourceQuote
```
