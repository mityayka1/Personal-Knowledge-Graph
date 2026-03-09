# Two-Wave Knowledge System Improvement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Привести систему EntityFact к контролируемой таксономии (18 типов вместо 77), улучшить FTS-scoring и добавить LLM-reranking для повышения качества retrieval.

**Architecture:** Wave 1 перестраивает entity memory layer — строгий enum, runtime-валидация, миграция 1330→~350 фактов, weekly consolidation. Wave 2 модернизирует retrieval pipeline — BM25 scoring, weighted RRF, LLM-reranking через Claude Haiku.

**Tech Stack:** NestJS, TypeORM, PostgreSQL 16 + pgvector, Claude Agent SDK (Haiku для reranking), Zod

**Design docs:**
- [Wave 1: Fact Taxonomy Redesign](./2026-03-09-fact-taxonomy-redesign.md)
- [Wave 2: Retrieval Quality Sprint](./2026-03-09-retrieval-quality-sprint.md)

---

## Wave 1: Fact Taxonomy Redesign

### Task 1: Redesign FactType Enum

**Files:**
- Modify: `packages/entities/src/entity-fact.entity.ts:15-50`

**Step 1: Replace FactType enum with 18 controlled types**

```typescript
// packages/entities/src/entity-fact.entity.ts

export enum FactType {
  // PROFESSIONAL
  POSITION = 'position',
  COMPANY = 'company',
  DEPARTMENT = 'department',
  SPECIALIZATION = 'specialization',
  SKILL = 'skill',
  EDUCATION = 'education',
  ROLE = 'role',

  // PERSONAL
  BIRTHDAY = 'birthday',
  LOCATION = 'location',
  FAMILY = 'family',
  HOBBY = 'hobby',
  LANGUAGE = 'language',
  HEALTH = 'health',
  STATUS = 'status',

  // PREFERENCES
  COMMUNICATION = 'communication',
  PREFERENCE = 'preference',

  // BUSINESS
  INN = 'inn',
  LEGAL_ADDRESS = 'legal_address',
}
```

**Step 2: Update FactCategory enum**

```typescript
export enum FactCategory {
  PROFESSIONAL = 'professional',
  PERSONAL = 'personal',
  PREFERENCES = 'preferences',
  BUSINESS = 'business',
}
```

**Step 3: Remove `| string` union — enforce strict typing**

Change line 96:
```typescript
// БЫЛО:
factType: FactType | string;

// СТАНЕТ:
factType: FactType;
```

> **ВАЖНО:** Колонку `fact_type` оставляем как `varchar(50)`, НЕ меняем на PostgreSQL enum. Миграция данных (Task 5) произойдёт до этого изменения и нормализует все значения.

**Step 4: Run build to check compilation**

Run: `cd /Users/mityayka/work/projects/PKG && npx tsc --noEmit --project apps/pkg-core/tsconfig.build.json 2>&1 | head -50`

Expected: Ошибки компиляции в файлах, использующих старые FactType значения или `| string`. Список ошибок станет чек-листом для Tasks 2-4.

**Step 5: Commit**

```bash
git add packages/entities/src/entity-fact.entity.ts
git commit -m "feat(entities): redesign FactType enum to 18 controlled types

Remove arbitrary string union, enforce strict enum.
Old types: NAME_FULL, NICKNAME, PHONE_*, EMAIL_*, ADDRESS,
ACTUAL_ADDRESS, KPP, OGRN, BANK_ACCOUNT, TIMEZONE,
DAILY_SUMMARY, COMMUNICATION_PREFERENCE removed.
New types: skill, education, role, location, family, hobby,
health, status, communication, preference added."
```

---

### Task 2: Create fact-validation utility

**Files:**
- Create: `apps/pkg-core/src/common/utils/fact-validation.ts`
- Create: `apps/pkg-core/src/common/utils/fact-validation.spec.ts`

**Step 1: Write the failing test**

```typescript
// apps/pkg-core/src/common/utils/fact-validation.spec.ts
import { normalizeFactType, getFactCategory } from './fact-validation';
import { FactType, FactCategory } from '@pkg/entities';

describe('normalizeFactType', () => {
  it('should return exact match', () => {
    expect(normalizeFactType('position')).toBe(FactType.POSITION);
    expect(normalizeFactType('birthday')).toBe(FactType.BIRTHDAY);
    expect(normalizeFactType('skill')).toBe(FactType.SKILL);
  });

  it('should normalize case and separators', () => {
    expect(normalizeFactType('Position')).toBe(FactType.POSITION);
    expect(normalizeFactType('LEGAL_ADDRESS')).toBe(FactType.LEGAL_ADDRESS);
    expect(normalizeFactType('legal-address')).toBe(FactType.LEGAL_ADDRESS);
  });

  it('should resolve aliases', () => {
    expect(normalizeFactType('occupation')).toBe(FactType.POSITION);
    expect(normalizeFactType('job')).toBe(FactType.POSITION);
    expect(normalizeFactType('work_activity')).toBe(FactType.SPECIALIZATION);
    expect(normalizeFactType('tool')).toBe(FactType.SKILL);
    expect(normalizeFactType('experience')).toBe(FactType.EDUCATION);
    expect(normalizeFactType('communication_style')).toBe(FactType.COMMUNICATION);
    expect(normalizeFactType('health_condition')).toBe(FactType.HEALTH);
    expect(normalizeFactType('career_aspiration')).toBe(FactType.PREFERENCE);
    expect(normalizeFactType('professional_approach')).toBe(FactType.PREFERENCE);
    expect(normalizeFactType('work_setup')).toBe(FactType.PREFERENCE);
    expect(normalizeFactType('research_area')).toBe(FactType.SPECIALIZATION);
    expect(normalizeFactType('accessibility_issue')).toBe(FactType.HEALTH);
  });

  it('should return null for unknown types', () => {
    expect(normalizeFactType('activity')).toBeNull();
    expect(normalizeFactType('transaction')).toBeNull();
    expect(normalizeFactType('some_random_type')).toBeNull();
  });
});

describe('getFactCategory', () => {
  it('should return correct category for each type', () => {
    expect(getFactCategory(FactType.POSITION)).toBe(FactCategory.PROFESSIONAL);
    expect(getFactCategory(FactType.BIRTHDAY)).toBe(FactCategory.PERSONAL);
    expect(getFactCategory(FactType.COMMUNICATION)).toBe(FactCategory.PREFERENCES);
    expect(getFactCategory(FactType.INN)).toBe(FactCategory.BUSINESS);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/common/utils/fact-validation.spec.ts --no-coverage 2>&1 | tail -10`
Expected: FAIL — module not found

**Step 3: Implement fact-validation.ts**

```typescript
// apps/pkg-core/src/common/utils/fact-validation.ts
import { FactType, FactCategory } from '@pkg/entities';

/**
 * Maps common LLM-generated aliases to canonical FactType values.
 * Built from production analysis of 77 unique fact_type values.
 */
const FACT_TYPE_ALIASES: Record<string, FactType> = {
  // Position aliases
  occupation: FactType.POSITION,
  job: FactType.POSITION,
  job_title: FactType.POSITION,

  // Specialization aliases
  work_activity: FactType.SPECIALIZATION,
  research_area: FactType.SPECIALIZATION,
  professional: FactType.SPECIALIZATION,
  expertise: FactType.SPECIALIZATION,

  // Skill aliases
  tool: FactType.SKILL,
  technology: FactType.SKILL,

  // Education aliases
  experience: FactType.EDUCATION,
  certification: FactType.EDUCATION,

  // Location aliases
  address: FactType.LOCATION,
  actual_address: FactType.LOCATION,
  city: FactType.LOCATION,

  // Health aliases
  health_condition: FactType.HEALTH,
  health_visit: FactType.HEALTH,
  accessibility_issue: FactType.HEALTH,

  // Status aliases
  tax_status: FactType.STATUS,
  work_status: FactType.STATUS,

  // Preference aliases
  career_aspiration: FactType.PREFERENCE,
  professional_approach: FactType.PREFERENCE,
  work_setup: FactType.PREFERENCE,
  opinion: FactType.PREFERENCE,
  personal: FactType.PREFERENCE,
  timezone: FactType.PREFERENCE,
  nickname: FactType.PREFERENCE,

  // Communication aliases
  communication_style: FactType.COMMUNICATION,
  communication_preference: FactType.COMMUNICATION,
};

const FACT_TYPE_VALUES = new Set(Object.values(FactType) as string[]);

/**
 * Normalize a raw fact type string to a canonical FactType enum value.
 * Returns null if the type is unknown and cannot be mapped.
 *
 * Pipeline: lowercase → replace separators → exact match → alias match → null
 */
export function normalizeFactType(raw: string): FactType | null {
  const normalized = raw.toLowerCase().replace(/[-\s]/g, '_');

  // Exact match against enum values
  if (FACT_TYPE_VALUES.has(normalized)) {
    return normalized as FactType;
  }

  // Alias match
  return FACT_TYPE_ALIASES[normalized] ?? null;
}

/**
 * Maps FactType → FactCategory automatically.
 */
const FACT_CATEGORY_MAP: Record<FactType, FactCategory> = {
  [FactType.POSITION]: FactCategory.PROFESSIONAL,
  [FactType.COMPANY]: FactCategory.PROFESSIONAL,
  [FactType.DEPARTMENT]: FactCategory.PROFESSIONAL,
  [FactType.SPECIALIZATION]: FactCategory.PROFESSIONAL,
  [FactType.SKILL]: FactCategory.PROFESSIONAL,
  [FactType.EDUCATION]: FactCategory.PROFESSIONAL,
  [FactType.ROLE]: FactCategory.PROFESSIONAL,

  [FactType.BIRTHDAY]: FactCategory.PERSONAL,
  [FactType.LOCATION]: FactCategory.PERSONAL,
  [FactType.FAMILY]: FactCategory.PERSONAL,
  [FactType.HOBBY]: FactCategory.PERSONAL,
  [FactType.LANGUAGE]: FactCategory.PERSONAL,
  [FactType.HEALTH]: FactCategory.PERSONAL,
  [FactType.STATUS]: FactCategory.PERSONAL,

  [FactType.COMMUNICATION]: FactCategory.PREFERENCES,
  [FactType.PREFERENCE]: FactCategory.PREFERENCES,

  [FactType.INN]: FactCategory.BUSINESS,
  [FactType.LEGAL_ADDRESS]: FactCategory.BUSINESS,
};

export function getFactCategory(type: FactType): FactCategory {
  return FACT_CATEGORY_MAP[type];
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/common/utils/fact-validation.spec.ts --no-coverage 2>&1 | tail -10`
Expected: PASS

**Step 5: Export from utils/index.ts**

Add to `apps/pkg-core/src/common/utils/index.ts`:
```typescript
export { normalizeFactType, getFactCategory } from './fact-validation';
```

**Step 6: Commit**

```bash
git add apps/pkg-core/src/common/utils/fact-validation.ts \
        apps/pkg-core/src/common/utils/fact-validation.spec.ts \
        apps/pkg-core/src/common/utils/index.ts
git commit -m "feat(extraction): add normalizeFactType utility with alias mapping

Maps 30+ LLM-generated aliases to 18 canonical FactType values.
Returns null for unknown types (activity, transaction, etc)."
```

---

### Task 3: Enforce enum in Extraction Pipelines

**Files:**
- Modify: `apps/pkg-core/src/modules/extraction/fact-extraction.service.ts:39-57,47`
- Modify: `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts:54-96,367-376`
- Modify: `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts:457`

**Step 1: Update FACTS_SCHEMA in fact-extraction.service.ts**

At line 47, change:
```typescript
// БЫЛО:
factType: { type: 'string' },

// СТАНЕТ:
factType: {
  type: 'string',
  enum: ['position', 'company', 'department', 'specialization', 'skill',
         'education', 'role', 'birthday', 'location', 'family', 'hobby',
         'language', 'health', 'status', 'communication', 'preference',
         'inn', 'legal_address'],
  description: 'Fact type. Only use values from this enum.',
},
```

**Step 2: Add normalizeFactType validation in fact-extraction.service.ts**

Find the fact validation/filtering section (around line 182-189 where `validFacts` filter exists) and add:

```typescript
import { normalizeFactType, getFactCategory } from '../../common/utils/fact-validation';

// In the fact processing pipeline, after LLM output parsing:
const normalizedFacts = rawFacts
  .map(f => {
    const factType = normalizeFactType(f.factType);
    if (!factType) {
      this.logger.debug(`Skipping unknown fact type: ${f.factType}`);
      return null;
    }
    return { ...f, factType };
  })
  .filter(Boolean);
```

**Step 3: Update CONVERSATION_EXTRACTION_SCHEMA in second-brain-extraction.service.ts**

In `CONVERSATION_EXTRACTION_SCHEMA` (line 54-96), the `data` field at line 78-81 has `additionalProperties: true`. Add fact type guidance to the schema description. Also update `mapToExtractedFact` at line 367-376:

```typescript
// line 371, БЫЛО:
factType: String(data.factType || 'other'),

// СТАНЕТ:
factType: (() => {
  const normalized = normalizeFactType(String(data.factType || ''));
  if (!normalized) {
    this.logger.debug(`SecondBrain: skipping unknown factType "${data.factType}"`);
    return null;
  }
  return normalized;
})(),
```

Also add null check in the calling code — if factType is null, skip this fact.

**Step 4: Update create_fact tool in extraction-tools.provider.ts**

At line 457, change:
```typescript
// БЫЛО:
factType: z.string().describe('Тип факта (position, company, phone, email, etc.)'),

// СТАНЕТ:
factType: z.enum([
  'position', 'company', 'department', 'specialization', 'skill',
  'education', 'role', 'birthday', 'location', 'family', 'hobby',
  'language', 'health', 'status', 'communication', 'preference',
  'inn', 'legal_address',
]).describe('Тип факта. PROFESSIONAL: position, company, department, specialization, skill, education, role. PERSONAL: birthday, location, family, hobby, language, health, status. PREFERENCES: communication, preference. BUSINESS: inn, legal_address.'),
```

**Step 5: Fix all compilation errors from Task 1**

Run: `npx tsc --noEmit --project apps/pkg-core/tsconfig.build.json 2>&1 | head -80`

Fix each error — most will be references to removed FactType members (NAME_FULL, PHONE_WORK, EMAIL_WORK, etc.). Replace them with appropriate new types or remove the code paths.

**Step 6: Run existing tests**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest --no-coverage --passWithNoTests 2>&1 | tail -20`
Expected: All existing tests pass (or list specific failures to fix)

**Step 7: Commit**

```bash
git add -A
git commit -m "feat(extraction): enforce FactType enum in all 3 extraction paths

- fact-extraction.service.ts: enum in JSON Schema + normalizeFactType()
- second-brain-extraction.service.ts: validation in mapToExtractedFact()
- extraction-tools.provider.ts: z.enum() in create_fact tool
- Fix all compilation errors from FactType enum changes"
```

---

### Task 4: Add validation in EntityFactService

**Files:**
- Modify: `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts:110-120`

**Step 1: Add normalizeFactType validation before persistence**

At line 110-112 (in `createWithDedup`), before `this.factRepo.create(...)`:

```typescript
import { normalizeFactType, getFactCategory } from '../../../common/utils/fact-validation';

// Add validation at the top of createWithDedup:
const validatedType = normalizeFactType(dto.type as string);
if (!validatedType) {
  this.logger.warn(`Rejected invalid factType: "${dto.type}"`);
  return {
    fact: null as any,
    action: 'skipped' as const,
    reason: `Invalid factType: "${dto.type}". Allowed: ${Object.values(FactType).join(', ')}`,
  };
}

// Use validatedType instead of dto.type in the create call:
const fact = this.factRepo.create({
  entityId,
  factType: validatedType,
  category: getFactCategory(validatedType),
  // ... rest unchanged
});
```

**Step 2: Run tests**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest entity-fact --no-coverage 2>&1 | tail -20`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts
git commit -m "feat(entity-fact): validate factType before persistence

Rejects unknown types with 'skipped' action.
Auto-derives FactCategory from FactType."
```

---

### Task 5: Database Migration

**Files:**
- Create: `apps/pkg-core/src/database/migrations/XXXX-fact-taxonomy-cleanup.ts`

> **ВНИМАНИЕ:** Эту задачу выполнять после деплоя Tasks 1-4. Миграция работает с production данными.

**Step 1: Create migration file**

```typescript
// apps/pkg-core/src/database/migrations/1741500000000-FactTaxonomyCleanup.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class FactTaxonomyCleanup1741500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════
    // ЭТАП 1: Delete non-fact data
    // ═══════════════════════════════════════════

    // Financial data — не факты
    await queryRunner.query(`
      DELETE FROM entity_facts
      WHERE fact_type IN (
        'transaction', 'financial_transaction', 'account_balance',
        'card_last_digits', 'payment', 'payment_methods', 'mortgage',
        'financial_arrangement', 'mood_financial_status', 'tax_status_update'
      )
    `);

    // Process/observation data — не факты
    await queryRunner.query(`
      DELETE FROM entity_facts
      WHERE fact_type IN (
        'process_observation', 'project', 'project_status',
        'project_update', 'project_context', 'current_project',
        'access', 'access_level', 'access_issue',
        'note', 'plan', 'issue', 'problem', 'daily_summary',
        'service_agreement', 'infrastructure',
        'software_version', 'technical_issue', 'availability',
        'acquaintance', 'friendship_history'
      )
    `);

    // ═══════════════════════════════════════════
    // ЭТАП 2: Remap types to canonical
    // ═══════════════════════════════════════════

    const remaps: [string, string][] = [
      ['occupation', 'position'],
      ['work_activity', 'specialization'],
      ['professional', 'specialization'],
      ['research_area', 'specialization'],
      ['career_aspiration', 'preference'],
      ['professional_approach', 'preference'],
      ['communication_style', 'communication'],
      ['communication_preference', 'communication'],
      ['experience', 'education'],
      ['tool', 'skill'],
      ['accessibility_issue', 'health'],
      ['health_condition', 'health'],
      ['health_visit', 'health'],
      ['tax_status', 'status'],
      ['work_status', 'status'],
      ['work_setup', 'preference'],
      ['opinion', 'preference'],
      ['personal', 'preference'],
      ['timezone', 'preference'],
      ['address', 'location'],
      ['actual_address', 'location'],
      ['nickname', 'preference'],
      ['name', 'preference'],
      ['name_full', 'preference'],
    ];

    for (const [from, to] of remaps) {
      await queryRunner.query(
        `UPDATE entity_facts SET fact_type = $1 WHERE fact_type = $2`,
        [to, from],
      );
    }

    // Delete contact facts — they duplicate EntityIdentifier
    await queryRunner.query(`
      DELETE FROM entity_facts
      WHERE fact_type IN (
        'phone_work', 'phone_personal', 'email_work', 'email_personal',
        'telegram', 'phone', 'email',
        'contact', 'contact_telegram', 'contact_link',
        'github_account', 'website'
      )
    `);

    // Delete deprecated types
    await queryRunner.query(`
      DELETE FROM entity_facts
      WHERE fact_type IN ('daily_summary', 'kpp', 'ogrn', 'bank_account')
    `);

    // ═══════════════════════════════════════════
    // ЭТАП 3: Update categories
    // ═══════════════════════════════════════════

    const categoryUpdates: [string[], string][] = [
      [['position', 'company', 'department', 'specialization', 'skill', 'education', 'role'], 'professional'],
      [['birthday', 'location', 'family', 'hobby', 'language', 'health', 'status'], 'personal'],
      [['communication', 'preference'], 'preferences'],
      [['inn', 'legal_address'], 'business'],
    ];

    for (const [types, category] of categoryUpdates) {
      const placeholders = types.map((_, i) => `$${i + 2}`).join(', ');
      await queryRunner.query(
        `UPDATE entity_facts SET category = $1 WHERE fact_type IN (${placeholders})`,
        [category, ...types],
      );
    }

    // ═══════════════════════════════════════════
    // ЭТАП 4: Log remaining unknown types
    // ═══════════════════════════════════════════

    // Any remaining facts with types NOT in the new enum should be logged
    // (primarily 'activity' — handled by LLM batch in Task 6)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Необратимая миграция — данные удалены
    // down() оставляем пустым
  }
}
```

**Step 2: Run migration on staging/dev first**

Run: `cd /Users/mityayka/work/projects/PKG && npx typeorm migration:run -d apps/pkg-core/src/database/data-source.ts`

**Step 3: Verify**

```sql
SELECT fact_type, COUNT(*) FROM entity_facts GROUP BY fact_type ORDER BY COUNT(*) DESC;
-- Ожидание: все значения из нового enum + 'activity' (для Task 6)
```

**Step 4: Commit**

```bash
git add apps/pkg-core/src/database/migrations/
git commit -m "feat(migration): cleanup and normalize fact_type values

Delete non-fact data (transactions, processes, contacts).
Remap 24 alias types to canonical 18-type taxonomy.
Update categories to match new structure."
```

---

### Task 6: LLM Batch Reclassification of Activity Facts

**Files:**
- Create: `apps/pkg-core/src/modules/data-quality/activity-fact-reclassification.service.ts`

> **Контекст:** 712 фактов с типом 'activity' нужно переклассифицировать через LLM. ~50-80 станут skill/hobby/specialization/status, остальные ~630-660 будут удалены как временные события.

**Step 1: Create the reclassification service**

```typescript
// apps/pkg-core/src/modules/data-quality/activity-fact-reclassification.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact, FactType } from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { normalizeFactType, getFactCategory } from '../../common/utils/fact-validation';

interface ReclassificationDecision {
  factId: string;
  newType: string | null; // null = delete (temporary event, not a fact)
  reason: string;
}

const RECLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factId: { type: 'string', description: 'UUID of the fact' },
          newType: {
            type: ['string', 'null'],
            enum: [
              'position', 'company', 'department', 'specialization', 'skill',
              'education', 'role', 'birthday', 'location', 'family', 'hobby',
              'language', 'health', 'status', 'communication', 'preference',
              'inn', 'legal_address', null,
            ],
            description: 'New fact type or null if this is a temporary event, not a stable attribute',
          },
          reason: { type: 'string', description: 'Brief reason for the decision' },
        },
        required: ['factId', 'newType', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

@Injectable()
export class ActivityFactReclassificationService {
  private readonly logger = new Logger(ActivityFactReclassificationService.name);

  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    private claudeAgentService: ClaudeAgentService,
  ) {}

  async reclassify(): Promise<{
    total: number;
    reclassified: number;
    deleted: number;
    errors: number;
  }> {
    const activityFacts = await this.factRepo.find({
      where: { factType: 'activity' as any },
    });

    this.logger.log(`Found ${activityFacts.length} activity facts to reclassify`);

    let reclassified = 0;
    let deleted = 0;
    let errors = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < activityFacts.length; i += BATCH_SIZE) {
      const batch = activityFacts.slice(i, i + BATCH_SIZE);
      try {
        const decisions = await this.classifyBatch(batch);

        for (const decision of decisions) {
          try {
            if (decision.newType === null) {
              await this.factRepo.softDelete(decision.factId);
              deleted++;
            } else {
              const validType = normalizeFactType(decision.newType);
              if (validType) {
                await this.factRepo.update(decision.factId, {
                  factType: validType,
                  category: getFactCategory(validType),
                });
                reclassified++;
              } else {
                this.logger.warn(`Invalid reclassification type: ${decision.newType} for fact ${decision.factId}`);
                errors++;
              }
            }
          } catch (err) {
            this.logger.error(`Error processing fact ${decision.factId}: ${err}`);
            errors++;
          }
        }

        this.logger.log(`Batch ${i / BATCH_SIZE + 1}: reclassified=${reclassified}, deleted=${deleted}`);
      } catch (err) {
        this.logger.error(`Batch error at offset ${i}: ${err}`);
        errors += batch.length;
      }
    }

    return { total: activityFacts.length, reclassified, deleted, errors };
  }

  private async classifyBatch(facts: EntityFact[]): Promise<ReclassificationDecision[]> {
    const factsText = facts.map(f =>
      `- id: ${f.id} | entity: ${f.entityId} | value: "${f.value}" | created: ${f.createdAt?.toISOString().split('T')[0]}`
    ).join('\n');

    const prompt = `Classify each fact below. A FACT is a STABLE ATTRIBUTE of a person/org (skill, hobby, position, status).
A TEMPORARY EVENT ("analyzed errors", "sent invoice", "had a meeting") is NOT a fact — set newType to null.

Allowed types: position, company, department, specialization, skill, education, role, birthday, location, family, hobby, language, health, status, communication, preference, inn, legal_address.

Facts to classify:
${factsText}`;

    const { data } = await this.claudeAgentService.call<{ decisions: ReclassificationDecision[] }>({
      mode: 'oneshot',
      taskType: 'fact_reclassification',
      prompt,
      schema: RECLASSIFICATION_SCHEMA,
      model: 'haiku',
    });

    return data?.decisions ?? [];
  }
}
```

**Step 2: Add endpoint to DataQualityController**

Add a POST endpoint `POST /data-quality/reclassify-activity-facts` that calls `ActivityFactReclassificationService.reclassify()`.

**Step 3: Register in module**

Add `ActivityFactReclassificationService` to DataQuality module providers.

**Step 4: Run and verify**

Run: `curl -X POST https://assistant.mityayka.ru/api/v1/data-quality/reclassify-activity-facts -H "x-api-key: ..."`
Expected: JSON with `{ total: ~712, reclassified: ~50-80, deleted: ~630-660, errors: 0 }`

**Step 5: Commit**

```bash
git add apps/pkg-core/src/modules/data-quality/
git commit -m "feat(data-quality): LLM batch reclassification of activity facts

Uses Claude Haiku to reclassify 712 activity-type facts.
Stable attributes → proper FactType, temporary events → soft delete."
```

---

### Task 7: FactConsolidationJob (weekly cron)

**Files:**
- Create: `apps/pkg-core/src/modules/data-quality/fact-consolidation.job.ts`

**Step 1: Create the consolidation job**

```typescript
// apps/pkg-core/src/modules/data-quality/fact-consolidation.job.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { EntityFact, FactType } from '@pkg/entities';
import { FactFusionService } from '../entity/entity-fact/fact-fusion.service';
import { formatEmbeddingForQuery } from '../../common/utils/similarity.utils';

@Injectable()
export class FactConsolidationJob {
  private readonly logger = new Logger(FactConsolidationJob.name);

  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    private factFusionService: FactFusionService,
  ) {}

  /**
   * Weekly consolidation: Sunday 4:00 AM
   * 1. Find duplicates by entity + factType (embedding similarity > 0.75)
   * 2. Smart Fusion for each pair
   * 3. Archive outdated facts
   * 4. Remove low-confidence facts
   */
  @Cron('0 4 * * 0') // Sunday 4:00 AM
  async consolidate(): Promise<{
    duplicatesFound: number;
    merged: number;
    archived: number;
    lowConfidenceRemoved: number;
  }> {
    this.logger.log('Starting weekly fact consolidation');
    let duplicatesFound = 0;
    let merged = 0;
    let archived = 0;
    let lowConfidenceRemoved = 0;

    // Get all entities with facts
    const entityIds: { entity_id: string }[] = await this.factRepo.query(
      `SELECT DISTINCT entity_id FROM entity_facts WHERE deleted_at IS NULL`,
    );

    for (const { entity_id: entityId } of entityIds) {
      // Group facts by type
      const facts = await this.factRepo.find({
        where: { entityId, validUntil: IsNull() },
        order: { createdAt: 'DESC' },
      });

      const byType = new Map<string, EntityFact[]>();
      for (const fact of facts) {
        const group = byType.get(fact.factType) || [];
        group.push(fact);
        byType.set(fact.factType, group);
      }

      // For each type with >1 fact, check for duplicates
      for (const [factType, typeFacts] of byType) {
        if (typeFacts.length < 2) continue;

        for (let i = 0; i < typeFacts.length; i++) {
          for (let j = i + 1; j < typeFacts.length; j++) {
            const a = typeFacts[i];
            const b = typeFacts[j];

            // Check embedding similarity if both have embeddings
            if (a.embedding && b.embedding) {
              const similarity = this.cosineSimilarity(a.embedding, b.embedding);
              if (similarity > 0.75) {
                duplicatesFound++;
                try {
                  const decision = await this.factFusionService.decideFusion(
                    a,
                    b.value || '',
                    b.source,
                  );
                  await this.factFusionService.applyDecision(a, {
                    type: b.factType as FactType,
                    value: b.value || '',
                    source: b.source,
                  }, decision, entityId);
                  merged++;
                } catch (err) {
                  this.logger.warn(`Fusion failed for facts ${a.id} / ${b.id}: ${err}`);
                }
              }
            }
          }
        }
      }

      // Remove low-confidence facts
      const lowConf = facts.filter(f => (f.confidence ?? 1) < 0.3);
      for (const fact of lowConf) {
        await this.factRepo.softDelete(fact.id);
        lowConfidenceRemoved++;
      }
    }

    this.logger.log(
      `Consolidation complete: duplicates=${duplicatesFound}, merged=${merged}, ` +
      `archived=${archived}, lowConfRemoved=${lowConfidenceRemoved}`,
    );

    return { duplicatesFound, merged, archived, lowConfidenceRemoved };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
```

**Step 2: Register in DataQuality module**

Add `FactConsolidationJob` to providers + import ScheduleModule if not already imported.

**Step 3: Commit**

```bash
git add apps/pkg-core/src/modules/data-quality/fact-consolidation.job.ts
git commit -m "feat(data-quality): weekly fact consolidation cron job

Sunday 4AM: find duplicates by embedding similarity >0.75,
run Smart Fusion, remove low-confidence (<0.3) facts."
```

---

### Task 8: Update Extraction Prompts

**Files:**
- Modify: `apps/pkg-core/src/modules/extraction/fact-extraction.service.ts` (prompt sections)
- Modify: `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts` (prompt sections)

**Step 1: Update prompts to define what IS and ISN'T a fact**

In all prompt-building methods, replace free-text fact type lists with:

```
## Правила извлечения фактов

ФАКТ = стабильный атрибут сущности, который сохраняется долгое время.

ЯВЛЯЕТСЯ фактом:
- "Дмитрий — CTO в компании X" → position
- "У Маши ДР 15 марта" → birthday
- "Он знает Python" → skill
- "Живёт в Казани" → location
- "Занимается теннисом" → hobby

НЕ является фактом (не извлекай):
- "Анализировал ошибки в Авито" — это временное действие
- "Заплатил 50000₽" — финансовая транзакция
- "Планирует читать документацию" — намерение, не факт
- "Сейчас на встрече" — текущее состояние (используй status только для длительных состояний)

Типы: position, company, department, specialization, skill, education, role,
birthday, location, family, hobby, language, health, status,
communication, preference, inn, legal_address
```

**Step 2: Verify compilation and tests**

Run: `npx tsc --noEmit && npx jest --no-coverage --passWithNoTests 2>&1 | tail -10`

**Step 3: Commit**

```bash
git add apps/pkg-core/src/modules/extraction/
git commit -m "feat(extraction): update prompts with fact definition rules

Clear examples of what IS and ISN'T a fact.
Explicit list of 18 allowed fact types in all prompts."
```

---

## Wave 2: Retrieval Quality Sprint

### Task 9: Upgrade FTS to BM25 (ts_rank_cd)

**Files:**
- Modify: `apps/pkg-core/src/modules/search/fts.service.ts:29`

**Step 1: Replace ts_rank with ts_rank_cd**

At line 29, change:

```typescript
// БЫЛО:
ts_rank(to_tsvector('russian', m.content), plainto_tsquery('russian', $1)) as score,

// СТАНЕТ:
ts_rank_cd(to_tsvector('russian', m.content), plainto_tsquery('russian', $1), 2|32) as score,
```

> **Insight:** `ts_rank_cd` использует cover density ranking (считает позицию и плотность совпадений). Флаг `2` = деление на длину документа, `32` = нормализация rank/(rank + 1) для диапазона [0, 1). Это даёт BM25-like scoring с нормализацией по длине.

**Step 2: Run search tests**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest fts --no-coverage 2>&1 | tail -10`

**Step 3: Commit**

```bash
git add apps/pkg-core/src/modules/search/fts.service.ts
git commit -m "feat(search): upgrade FTS to ts_rank_cd with length normalization

Replace ts_rank with ts_rank_cd(flags=2|32) for BM25-like scoring.
Normalizes by document length, produces [0,1) range."
```

---

### Task 10: Create RerankerService

**Files:**
- Create: `apps/pkg-core/src/modules/search/reranker.service.ts`
- Create: `apps/pkg-core/src/modules/search/reranker.service.spec.ts`

**Step 1: Write the test**

```typescript
// apps/pkg-core/src/modules/search/reranker.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { RerankerService } from './reranker.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

describe('RerankerService', () => {
  let service: RerankerService;
  let claudeAgentService: jest.Mocked<ClaudeAgentService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RerankerService,
        {
          provide: ClaudeAgentService,
          useValue: {
            call: jest.fn().mockResolvedValue({
              data: {
                rankings: [
                  { id: 'msg-1', relevance: 0.9 },
                  { id: 'msg-3', relevance: 0.7 },
                  { id: 'msg-2', relevance: 0.3 },
                ],
              },
            }),
          },
        },
      ],
    }).compile();

    service = module.get<RerankerService>(RerankerService);
    claudeAgentService = module.get(ClaudeAgentService);
  });

  it('should rerank items by relevance', async () => {
    const items = [
      { id: 'msg-1', content: 'First message', score: 0.5 },
      { id: 'msg-2', content: 'Second message', score: 0.8 },
      { id: 'msg-3', content: 'Third message', score: 0.6 },
    ];

    const result = await service.rerank(items, 'test query');

    expect(result[0].id).toBe('msg-1');
    expect(result[1].id).toBe('msg-3');
    expect(result[2].id).toBe('msg-2');
  });

  it('should return original order when LLM fails', async () => {
    claudeAgentService.call.mockRejectedValue(new Error('API error'));

    const items = [
      { id: 'msg-1', content: 'First', score: 0.8 },
      { id: 'msg-2', content: 'Second', score: 0.5 },
    ];

    const result = await service.rerank(items, 'test query');

    // Graceful fallback — original order preserved
    expect(result[0].id).toBe('msg-1');
    expect(result[1].id).toBe('msg-2');
  });

  it('should skip reranking if less than 2 items', async () => {
    const items = [{ id: 'msg-1', content: 'Only one', score: 1.0 }];

    const result = await service.rerank(items, 'query');

    expect(claudeAgentService.call).not.toHaveBeenCalled();
    expect(result).toEqual(items);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest reranker --no-coverage 2>&1 | tail -10`
Expected: FAIL — module not found

**Step 3: Implement RerankerService**

```typescript
// apps/pkg-core/src/modules/search/reranker.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

export interface RerankItem {
  id: string;
  content: string;
  score: number;
  [key: string]: any;
}

const RERANKING_SCHEMA = {
  type: 'object',
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item ID from input' },
          relevance: { type: 'number', description: 'Relevance score 0.0-1.0' },
        },
        required: ['id', 'relevance'],
      },
    },
  },
  required: ['rankings'],
};

@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);

  constructor(private claudeAgentService: ClaudeAgentService) {}

  /**
   * Rerank items by relevance to query using LLM.
   * Gracefully falls back to original order on failure.
   */
  async rerank<T extends RerankItem>(
    items: T[],
    query: string,
    options?: { topK?: number },
  ): Promise<T[]> {
    if (items.length < 2) return items;

    const topK = options?.topK ?? items.length;

    try {
      const itemsText = items
        .map((item, i) => `[${item.id}] ${item.content.slice(0, 300)}`)
        .join('\n');

      const prompt = `Rate each item's relevance to the query. Return rankings sorted by relevance (highest first).

Query: "${query}"

Items:
${itemsText}

Rate relevance 0.0-1.0 for each item. Only include items with relevance > 0.1.`;

      const { data } = await this.claudeAgentService.call<{
        rankings: { id: string; relevance: number }[];
      }>({
        mode: 'oneshot',
        taskType: 'reranking',
        prompt,
        schema: RERANKING_SCHEMA,
        model: 'haiku',
      });

      if (!data?.rankings?.length) {
        return items.slice(0, topK);
      }

      // Build reranked list
      const itemMap = new Map(items.map(item => [item.id, item]));
      const reranked: T[] = [];

      for (const ranking of data.rankings) {
        const item = itemMap.get(ranking.id);
        if (item) {
          reranked.push({ ...item, score: ranking.relevance });
        }
      }

      // Add any items not in rankings at the end
      for (const item of items) {
        if (!reranked.find(r => r.id === item.id)) {
          reranked.push(item);
        }
      }

      return reranked.slice(0, topK);
    } catch (error) {
      this.logger.warn(`Reranking failed, falling back to original order: ${error}`);
      return items.slice(0, topK);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest reranker --no-coverage 2>&1 | tail -10`
Expected: PASS

**Step 5: Register in SearchModule**

Update `apps/pkg-core/src/modules/search/search.module.ts`:

```typescript
import { RerankerService } from './reranker.service';
// Add to providers and exports:
providers: [SearchService, FtsService, VectorService, RerankerService],
exports: [SearchService, VectorService, RerankerService],
```

Also need to import ClaudeAgentCoreModule:

```typescript
import { ClaudeAgentCoreModule } from '../claude-agent/claude-agent-core.module';
// Add to imports:
imports: [
  TypeOrmModule.forFeature([Message, TranscriptSegment, InteractionSummary]),
  EmbeddingModule,
  ClaudeAgentCoreModule,
],
```

**Step 6: Commit**

```bash
git add apps/pkg-core/src/modules/search/reranker.service.ts \
        apps/pkg-core/src/modules/search/reranker.service.spec.ts \
        apps/pkg-core/src/modules/search/search.module.ts
git commit -m "feat(search): add RerankerService with LLM-based reranking

Uses Claude Haiku for relevance scoring.
Graceful fallback to original order on failure.
~$0.23/month estimated cost for typical usage."
```

---

### Task 11: Upgrade SearchService with Weighted RRF + Reranking

**Files:**
- Modify: `apps/pkg-core/src/modules/search/search.service.ts:38-82`

**Step 1: Add weighted RRF and optional reranking**

```typescript
// Обновить SearchService

import { RerankerService, RerankItem } from './reranker.service';

@Injectable()
export class SearchService {
  constructor(
    private ftsService: FtsService,
    private vectorService: VectorService,
    private embeddingService: EmbeddingService,
    private rerankerService: RerankerService, // NEW
  ) {}

  // ... search() method unchanged ...

  private async hybridSearch(query: SearchQuery, limit: number): Promise<SearchResult[]> {
    const ftsResults = await this.ftsService.search(
      query.query, query.entityId, query.period, limit * 2,
    );

    const embedding = await this.embeddingService.generate(query.query);
    const vectorResults = await this.vectorService.search(
      embedding, query.entityId, query.period, limit * 2,
    );

    // Weighted RRF: FTS 0.4, Vector 0.6
    const k = 60;
    const FTS_WEIGHT = 0.4;
    const VECTOR_WEIGHT = 0.6;
    const DUAL_SIGNAL_BOOST = 1.2;

    const scores = new Map<string, number>();
    const inBothSignals = new Set<string>();

    // Track which results appear in both
    const ftsIds = new Set(ftsResults.map(r => r.id));
    const vectorIds = new Set(vectorResults.map(r => r.id));
    ftsIds.forEach(id => { if (vectorIds.has(id)) inBothSignals.add(id); });

    ftsResults.forEach((result, rank) => {
      const rrfScore = FTS_WEIGHT * (1 / (k + rank + 1));
      scores.set(result.id, (scores.get(result.id) || 0) + rrfScore);
    });

    vectorResults.forEach((result, rank) => {
      const rrfScore = VECTOR_WEIGHT * (1 / (k + rank + 1));
      scores.set(result.id, (scores.get(result.id) || 0) + rrfScore);
    });

    // Dual-signal boost
    for (const id of inBothSignals) {
      scores.set(id, (scores.get(id) || 0) * DUAL_SIGNAL_BOOST);
    }

    // Merge and sort
    const resultMap = new Map<string, SearchResult>();
    [...ftsResults, ...vectorResults].forEach(r => {
      if (!resultMap.has(r.id)) resultMap.set(r.id, r);
    });

    let merged = Array.from(resultMap.values())
      .map(r => ({ ...r, score: scores.get(r.id) || 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 2); // Get more for reranking

    // LLM reranking (top candidates only)
    if (merged.length > 3) {
      const rerankCandidates: RerankItem[] = merged.slice(0, 20).map(r => ({
        id: r.id,
        content: r.content,
        score: r.score,
      }));

      const reranked = await this.rerankerService.rerank(rerankCandidates, query.query, { topK: limit });
      const rerankedMap = new Map(reranked.map(r => [r.id, r.score]));

      // Merge reranked scores with original
      merged = merged.map(r => ({
        ...r,
        score: rerankedMap.has(r.id) ? rerankedMap.get(r.id)! : r.score * 0.5,
      }));
      merged.sort((a, b) => b.score - a.score);
    }

    return merged.slice(0, limit);
  }
}
```

**Step 2: Run tests**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest search --no-coverage 2>&1 | tail -20`

**Step 3: Commit**

```bash
git add apps/pkg-core/src/modules/search/search.service.ts
git commit -m "feat(search): weighted RRF (0.4/0.6) + dual-signal boost + LLM reranking

FTS weight 0.4, vector weight 0.6 (semantic context preferred).
1.2x boost for results appearing in both FTS and vector.
Top-20 candidates reranked by Claude Haiku for final ordering."
```

---

### Task 12: Add Reranking to Context Assembly

**Files:**
- Modify: `apps/pkg-core/src/modules/context/context.service.ts:59-176`
- Modify: `apps/pkg-core/src/modules/context/context.module.ts`

**Step 1: Inject RerankerService in ContextService**

Add to constructor:
```typescript
import { RerankerService, RerankItem } from '../search/reranker.service';

constructor(
  // ... existing dependencies ...
  private rerankerService: RerankerService, // NEW
) {}
```

**Step 2: Add reranking to WARM and RELEVANT tiers**

In `generateContext()`, after fetching warm summaries (line 100) and relevant chunks (line 117):

```typescript
// After line 100 - Rerank warm summaries if taskHint provided
if (taskHint && warmSummaries.length > 3) {
  const summaryItems: RerankItem[] = warmSummaries.map(s => ({
    id: s.id,
    content: s.summaryText + ' ' + (s.keyPoints || []).join(' '),
    score: 1,
  }));
  const reranked = await this.rerankerService.rerank(summaryItems, taskHint, { topK: 5 });
  const rerankedIds = new Set(reranked.map(r => r.id));
  warmSummaries = warmSummaries
    .filter(s => rerankedIds.has(s.id))
    .sort((a, b) => {
      const aIdx = reranked.findIndex(r => r.id === a.id);
      const bIdx = reranked.findIndex(r => r.id === b.id);
      return aIdx - bIdx;
    });
}
```

**Step 3: Import SearchModule in ContextModule**

Ensure `ContextModule` imports `SearchModule` (or at minimum the `RerankerService` is available).

**Step 4: Run tests**

Run: `cd /Users/mityayka/work/projects/PKG && npx jest context --no-coverage 2>&1 | tail -10`

**Step 5: Commit**

```bash
git add apps/pkg-core/src/modules/context/
git commit -m "feat(context): add LLM reranking to WARM tier assembly

When taskHint is provided, rerank warm summaries by relevance.
Reduces noise in context by focusing on task-relevant history."
```

---

## Final Verification

### After Wave 1:

```sql
-- Verify taxonomy
SELECT fact_type, COUNT(*) FROM entity_facts WHERE deleted_at IS NULL
GROUP BY fact_type ORDER BY COUNT(*) DESC;
-- Expected: ≤18 types, 350-400 facts

-- Verify no orphan types
SELECT DISTINCT fact_type FROM entity_facts WHERE deleted_at IS NULL
AND fact_type NOT IN (
  'position', 'company', 'department', 'specialization', 'skill',
  'education', 'role', 'birthday', 'location', 'family', 'hobby',
  'language', 'health', 'status', 'communication', 'preference',
  'inn', 'legal_address'
);
-- Expected: 0 rows
```

### After Wave 2:

```bash
# Test search quality
curl -X POST https://assistant.mityayka.ru/api/v1/search \
  -H "x-api-key: ..." -H "Content-Type: application/json" \
  -d '{"query": "когда созвон с Панавто", "searchType": "hybrid"}'
# Expected: results reranked by relevance, dual-signal boost visible
```

### Deploy:

```bash
ssh mityayka@assistant.mityayka.ru
cd /opt/apps/pkg && git pull && cd docker && docker compose build --no-cache pkg-core && docker compose up -d pkg-core
```

---

## Summary

| Wave | Tasks | Key Files |
|------|-------|-----------|
| **Wave 1** | 1-8 | entity-fact.entity.ts, fact-validation.ts, 3 extraction services, migration, consolidation job |
| **Wave 2** | 9-12 | fts.service.ts, reranker.service.ts, search.service.ts, context.service.ts |

**After both waves:** Full re-extraction of all knowledge from historical messages with the new pipeline.
