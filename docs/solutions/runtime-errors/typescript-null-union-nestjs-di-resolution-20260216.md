---
module: Claude Agent
date: 2026-02-16
problem_type: runtime_error
component: service_object
symptoms:
  - "UnknownDependenciesException: Nest can't resolve dependencies of ActionToolsProvider"
  - "Constructor params show '?' and 'Object' instead of class names"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [nestjs, typescript, reflect-metadata, dependency-injection, union-types]
---

# Troubleshooting: TypeScript `| null` Union Type Breaks NestJS DI Resolution

## Problem

NestJS application crashes at startup with `UnknownDependenciesException` when a provider's constructor uses TypeScript union types like `Service | null`. TypeScript's `reflect-metadata` emits `Object` instead of the actual class, and NestJS cannot resolve `Object` as a dependency.

## Environment
- Module: ClaudeAgentModule / ActionToolsProvider
- Framework: NestJS 10.x, TypeScript 5.x
- Affected Component: NestJS Dependency Injection system
- Date: 2026-02-16

## Symptoms
- Application crashes immediately at startup
- Error: `UnknownDependenciesException: Nest can't resolve dependencies of the ActionToolsProvider (EntityService, EntityEventService, ?, Object, Object, ToolsRegistryService). Please make sure that the argument dependency at index [2] is available in the current context.`
- Parameters typed as `Service | null` show as `?` or `Object` in the error message
- `tsc --noEmit` passes with 0 errors — the issue is runtime-only

## What Didn't Work

**Attempted Solution 1:** Checked barrel file exports and module imports
- **Why it failed:** All imports were correct. Static analysis showed no issues. The problem was in TypeScript's compiled metadata, not in the module graph.

**Attempted Solution 2:** Verified ToolCategory type includes all categories
- **Why it failed:** The type was correct. The provider wasn't instantiated at all due to DI failure, so category registration never happened.

**Attempted Solution 3:** Compared with other providers that DO register
- **Why it failed:** Other providers didn't use `| null` union types in constructors, so they worked fine. The difference wasn't in module configuration but in TypeScript type annotations.

## Solution

**Remove `| null` from constructor parameter types.** Since the provider was moved to a module that imports all required dependencies, they are guaranteed to be available.

**Code changes:**

```typescript
// Before (broken):
@Injectable()
export class ActionToolsProvider {
  constructor(
    private readonly entityService: EntityService,
    private readonly entityEventService: EntityEventService,
    private readonly contextService: ContextService | null,        // ← Object
    private readonly claudeAgentService: ClaudeAgentService | null, // ← Object
    private readonly approvalService: ApprovalService | null,       // ← Object
    private readonly toolsRegistry: ToolsRegistryService,
  ) {}
}

// After (fixed):
@Injectable()
export class ActionToolsProvider {
  constructor(
    private readonly entityService: EntityService,
    private readonly entityEventService: EntityEventService,
    private readonly contextService: ContextService,
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly approvalService: ApprovalService,
    private readonly toolsRegistry: ToolsRegistryService,
  ) {}
}
```

**File:** `apps/pkg-core/src/modules/claude-agent/tools/action-tools.provider.ts:41-48`

## Why This Works

1. **Root cause:** TypeScript's `reflect-metadata` library cannot represent union types in `design:paramtypes` metadata. When TypeScript sees `ContextService | null`, it emits `Object` as the metadata type. NestJS reads `design:paramtypes` to resolve constructor dependencies, sees `Object`, and throws `UnknownDependenciesException`.

2. **The compiled JavaScript reveals the issue:**
   ```javascript
   // With "| null" — broken:
   __metadata("design:paramtypes", [
     EntityService, EntityEventService,
     Object,  // ← was ContextService | null
     Object,  // ← was ClaudeAgentService | null
     Object,  // ← was ApprovalService | null
     ToolsRegistryService
   ])

   // Without "| null" — correct:
   __metadata("design:paramtypes", [
     EntityService, EntityEventService,
     ContextService,
     ClaudeAgentService,
     ApprovalService,
     ToolsRegistryService
   ])
   ```

3. **Why `| null` was there originally:** The provider previously lived in ClaudeAgentModule which didn't directly import the modules providing these services. `@Optional() + forwardRef()` was used to handle the circular dependency. After refactoring to the registration pattern, the provider moved to NotificationModule which imports all required modules, making `| null` unnecessary.

## Prevention

- **Never use `| null` or `| undefined` union types in NestJS constructor injection.** The reflect-metadata library emits `Object` for all union types.
- **If a dependency is truly optional**, use `@Optional()` decorator instead of `| null`:
  ```typescript
  // ✅ Correct way for optional dependency:
  @Optional()
  @Inject(forwardRef(() => SomeService))
  private readonly someService: SomeService,

  // ❌ Wrong — causes Object metadata:
  private readonly someService: SomeService | null,
  ```
- **Diagnostic clue:** If NestJS error shows `?` or `Object` instead of a class name at a specific index, check if that constructor parameter uses a union type.
- **Quick check:** `grep -n "| null" src/**/*.ts` in provider files to find potential issues.

## Related Issues

- See also: [TypeORM Nullable Column 'Object' Type Error](../integration-issues/typeorm-nullable-column-object-type-20260131.md) — same `reflect-metadata` root cause but for TypeORM `@Column` decorators instead of NestJS constructors
