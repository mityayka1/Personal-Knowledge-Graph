---
module: Extraction Pipeline
date: 2026-02-17
problem_type: logic_error
component: service_object
symptoms:
  - "[ProjectDedup] similarity=0.000, source=no_match for project with client annotation"
  - "LLM fallback (project_name_match) triggered but also returned no match"
  - "Duplicate projects created instead of linking to existing activity"
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [normalization, project-matching, extraction, client-annotation, fuzzy-match]
---

# Troubleshooting: Client Annotation in Project Name Breaks Fuzzy Matching

## Problem
When Claude extracts project names from conversations, it copies metadata annotations like `(клиент: Ассистент Панавто)` from the activity context prompt, causing `normalizeName()` to produce a string that fails both heuristic and LLM-based matching against the real project name.

## Environment
- Module: Extraction Pipeline (ProjectMatchingService, DraftExtractionService, SecondBrainExtractionService)
- Stack: NestJS / TypeORM / PostgreSQL
- Affected Component: `ProjectMatchingService.normalizeName()`, conversation extraction prompt
- Date: 2026-02-17

## Symptoms
- `[ProjectDedup] "Панавто-Хаб (клиент: Ассистент Панавто)" → decision=create, similarity=0.000, source=no_match`
- LLM fallback fired (`project_name_match`, 9723ms) but returned `matchedIndex: null`
- New duplicate project/task created instead of linking to existing `Панавто-Хаб` (b41c8bd4)
- Task warning: `references project "Панавто-Хаб (клиент: Ассистент Панавто)" but no matching activity found`

## What Didn't Work

**Attempted Solution 1:** Token-based Jaccard similarity (implemented earlier in same session)
- **Why it failed:** Jaccard("панавто-хаб (клиент: ассистент панавто)", "панавто-хаб") = 1/4 = 0.25 — well below the 0.6 weak match threshold. The annotation adds 3 extra tokens, diluting the overlap.

**Attempted Solution 2:** LLM fallback with Haiku (cross-script matching feature)
- **Why it failed:** The LLM received the full annotated name `"Панавто-Хаб (клиент: Ассистент Панавто)"` and the clean list entry `"0. Панавто-Хаб"`. Haiku returned `matchedIndex: null` — it treated the annotation as part of the identity and considered them different entities.

## Solution

Three-pronged fix applied:

### 1. Expand `normalizeName()` to strip client annotations

**File:** `apps/pkg-core/src/modules/extraction/project-matching.service.ts:73`

```typescript
// Before (broken):
static normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(
      /\s*\([^)]*(?:₽|руб|rub|тыс|млн|usd|eur|\$|k\b|m\b)[^)]*\)/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!]+$/, '')
    .trim();
}

// After (fixed):
static normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(
      /\s*\([^)]*(?:₽|руб|rub|тыс|млн|usd|eur|\$|k\b|m\b)[^)]*\)/gi,
      '',
    )
    .replace(
      /\s*\((?:клиент|client|заказчик)\s*:[^)]*\)/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!]+$/, '')
    .trim();
}
```

### 2. Update extraction prompt with explicit instruction

**File:** `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts:697`

```
// Before:
6. Используй СУЩЕСТВУЮЩИЕ АКТИВНОСТИ для привязки:
   - Используй ТОЧНЫЕ имена проектов из списка

// After:
6. Используй СУЩЕСТВУЮЩИЕ АКТИВНОСТИ для привязки:
   - Используй ТОЛЬКО ИМЯ проекта из списка, БЕЗ аннотаций (клиент, статус, id, теги)
   - Пример: если в списке "Панавто-Хаб (клиент: Ассистент Панавто)" → пиши projectName: "Панавто-Хаб"
```

### 3. Normalize LLM fallback input

**File:** `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts:1842`

```typescript
// Before:
const prompt = `Имя проекта из извлечения: "${projectName}"\n\n...`;

// After:
const normalizedInput = ProjectMatchingService.normalizeName(projectName);
const prompt = `Имя проекта из извлечения: "${normalizedInput}"\n\n...`;
```

## Why This Works

1. **Root cause:** `formatActivityContext()` formats activities as `"Панавто-Хаб (клиент: Ассистент Панавто) [active] (id: ...)"`. Claude copies the name with `(клиент: ...)` annotation into `projectName`. The existing `normalizeName()` only stripped cost annotations like `(424.39₽)` but not metadata annotations.

2. **The regex fix** catches the most common metadata annotation pattern `(клиент: ...)` / `(client: ...)` / `(заказчик: ...)` — these are the labels produced by `formatActivityContext()`.

3. **The prompt fix** prevents the problem at the source — Claude now knows to extract only the project name, not the full formatted line. This is the primary defense.

4. **The LLM normalization** ensures that even if both the regex and prompt fail, the LLM fallback gets a clean input with better matching chances.

## Prevention

- **When modifying `formatActivityContext()`**: If new annotation patterns are added (e.g., `(ответственный: ...)`, `(дедлайн: ...)`), ensure `normalizeName()` handles them or the prompt explicitly instructs to strip them.
- **General principle**: Any time LLM receives a formatted list with metadata annotations, the extraction prompt MUST instruct to use only the core name, not the full formatted line.
- **Test pattern**: Add `normalizeName()` unit tests for any new annotation format before deployment.
- **Monitoring**: Watch for `[ProjectDedup] ... source=no_match` in logs with names containing parenthetical annotations — this signals a normalization gap.

## Related Issues
- See also: [extraction-quality-prevention-pipeline-20260215.md](../integration-issues/extraction-quality-prevention-pipeline-20260215.md) — covers broader extraction quality improvements including two-tier matching thresholds
- See also: [vague-extraction-context-understanding-ExtractionPipeline-20260215.md](./vague-extraction-context-understanding-ExtractionPipeline-20260215.md) — related prompt clarity issue
