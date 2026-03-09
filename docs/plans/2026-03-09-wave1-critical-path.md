# Wave 1: Critical Path — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Разблокировать Knowledge System: починить linking сегментов к Activity (0% → >70%), добавить confidence decay для фактов, и вычистить таксономию fact types.

**Architecture:** Три параллельных задачи. Task 1a фиксит OrphanSegmentLinker (новые стратегии + сниженный порог). Task 1b добавляет decay при retrieval в ContextService (БД не трогаем). Task 1c создаёт конфиг fact types и мержит role→position.

**Tech Stack:** NestJS, TypeORM, PostgreSQL, Claude Agent SDK (Haiku для LLM fallback), Jest

**Dependencies:** Все три задачи параллельны и независимы друг от друга.

---

## Task 1a: Fix Segment→Activity Linking

**Проблема:** `OrphanSegmentLinkerService` использует Levenshtein ≥0.8 — слишком строгий порог. Результат: 0/1804 сегментов привязаны к Activity.

**Files:**
- Modify: `apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.ts`
- Create: `apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.spec.ts`
- Modify: `apps/pkg-core/src/modules/segmentation/segmentation.controller.ts`
- Modify: `packages/entities/src/claude-agent-run.entity.ts` (новый task type)
- Modify: `apps/pkg-core/src/modules/claude-agent/claude-agent.types.ts` (новый task type)

### Step 1: Write tests for lowered threshold

Create test file `apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { OrphanSegmentLinkerService } from './orphan-segment-linker.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TopicalSegment, Activity, Interaction } from '@pkg/entities';
import { DataSource } from 'typeorm';
import { SegmentationService } from './segmentation.service';
import { ActivityService } from '../activity/activity.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { Logger } from '@nestjs/common';

describe('OrphanSegmentLinkerService', () => {
  let service: OrphanSegmentLinkerService;
  let mockDataSource: Partial<DataSource>;
  let mockSegmentRepo: any;
  let mockActivityService: any;

  beforeEach(async () => {
    mockDataSource = { query: jest.fn() };
    mockSegmentRepo = {
      find: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn(),
      }),
    };
    mockActivityService = { findAll: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrphanSegmentLinkerService,
        { provide: getRepositoryToken(TopicalSegment), useValue: mockSegmentRepo },
        { provide: getRepositoryToken(Interaction), useValue: {} },
        { provide: DataSource, useValue: mockDataSource },
        { provide: SegmentationService, useValue: {} },
        { provide: ActivityService, useValue: mockActivityService },
        { provide: ClaudeAgentService, useValue: { call: jest.fn() } },
      ],
    }).compile();

    service = module.get<OrphanSegmentLinkerService>(OrphanSegmentLinkerService);
  });

  describe('findBestActivityMatch', () => {
    it('should match with lowered threshold 0.5', () => {
      // "обсуждение интеграции Авито" vs "Панавто" — ранее не матчилось на 0.8
      // С порогом 0.5 — должно матчиться через token overlap
      const result = (service as any).findBestActivityMatch(
        'обсуждение интеграции Авито для Панавто',
        'Краткое содержание сегмента',
        [
          { id: 'a1', name: 'Панавто', description: 'Клиент Панавто, интеграции' },
          { id: 'a2', name: 'Butler', description: 'Проект Butler' },
        ],
      );
      expect(result).toBeDefined();
      expect(result.activityId).toBe('a1');
      expect(result.score).toBeGreaterThanOrEqual(0.5);
    });

    it('should reject match below 0.5 threshold', () => {
      const result = (service as any).findBestActivityMatch(
        'погода завтра',
        'Обсуждение погоды',
        [
          { id: 'a1', name: 'Панавто', description: 'Клиент Панавто' },
        ],
      );
      expect(result).toBeNull();
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd apps/pkg-core && npx jest --testPathPattern="orphan-segment-linker.service.spec" --no-coverage -- --forceExit
```

Expected: FAIL — `findBestActivityMatch` uses 0.8 threshold, test expects 0.5.

### Step 3: Lower threshold from 0.8 to 0.5

In `apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.ts`, line 61:

```typescript
// BEFORE:
private readonly SIMILARITY_THRESHOLD = 0.8;

// AFTER:
private readonly SIMILARITY_THRESHOLD = 0.5;
```

### Step 4: Run test to verify it passes

```bash
cd apps/pkg-core && npx jest --testPathPattern="orphan-segment-linker.service.spec" --no-coverage -- --forceExit
```

Expected: PASS

### Step 5: Commit

```bash
git add apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.ts apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.spec.ts
git commit -m "feat(segmentation): lower OrphanSegmentLinker threshold from 0.8 to 0.5

The strict 0.8 Levenshtein threshold resulted in 0% segment-to-activity
linking in production (0/1804). Lowering to 0.5 enables weak matches
that are still meaningful for segment organization."
```

### Step 6: Write test for chat→activity mapping strategy

Add to `orphan-segment-linker.service.spec.ts`:

```typescript
describe('linkByChatActivityMapping', () => {
  it('should link segment when chat has single activity', async () => {
    // Setup: chat_id "12345" has interactions linked to exactly one activity
    mockDataSource.query = jest.fn()
      .mockResolvedValueOnce([
        { activity_id: 'act-1', activity_name: 'Панавто', match_count: '5' },
      ]);

    const segment = {
      id: 'seg-1',
      chatId: '12345',
      activityId: null,
    } as any;

    const result = await (service as any).linkByChatActivityMapping(segment);
    expect(result).toBe('act-1');
  });

  it('should return null when chat maps to multiple activities', async () => {
    mockDataSource.query = jest.fn()
      .mockResolvedValueOnce([
        { activity_id: 'act-1', activity_name: 'Панавто', match_count: '3' },
        { activity_id: 'act-2', activity_name: 'Butler', match_count: '2' },
      ]);

    const segment = { id: 'seg-2', chatId: '12345', activityId: null } as any;
    const result = await (service as any).linkByChatActivityMapping(segment);
    expect(result).toBeNull();
  });
});
```

### Step 7: Run test to verify it fails

```bash
cd apps/pkg-core && npx jest --testPathPattern="orphan-segment-linker.service.spec" --no-coverage -- --forceExit
```

Expected: FAIL — `linkByChatActivityMapping` method does not exist yet.

### Step 8: Implement chat→activity mapping strategy

In `orphan-segment-linker.service.ts`, add new private method:

```typescript
/**
 * Strategy: Chat→Activity mapping.
 * If a telegram chat is associated with exactly ONE activity
 * (via interaction source_metadata.telegram_chat_id → interaction_participants → activity_members),
 * all segments from that chat inherit the activity.
 */
private async linkByChatActivityMapping(segment: TopicalSegment): Promise<string | null> {
  if (!segment.chatId) return null;

  const rows: Array<{ activity_id: string; activity_name: string; match_count: string }> =
    await this.dataSource.query(`
      SELECT a.id AS activity_id, a.name AS activity_name, COUNT(DISTINCT i.id) AS match_count
      FROM interactions i
      INNER JOIN interaction_participants ip ON ip.interaction_id = i.id
      INNER JOIN activity_members am ON am.entity_id = ip.entity_id
      INNER JOIN activities a ON a.id = am.activity_id
      WHERE i.source_metadata->>'telegram_chat_id' = $1
        AND a.status = 'active'
      GROUP BY a.id, a.name
      ORDER BY match_count DESC
    `, [segment.chatId]);

  // Only link if chat maps to exactly ONE activity
  if (rows.length === 1) {
    this.logger.log(
      `[chat-mapping] Chat ${segment.chatId} → activity "${rows[0].activity_name}" (${rows[0].activity_id})`,
    );
    return rows[0].activity_id;
  }

  return null;
}
```

Then integrate into `linkOrphan()` method, adding this strategy **after** participant-based matching and **before** activity candidate matching:

```typescript
// In linkOrphan() method, after participant matching fails:
// Strategy 2: Chat→Activity mapping
const chatActivityId = await this.linkByChatActivityMapping(segment);
if (chatActivityId) {
  await this.assignActivity(segment.id, chatActivityId, 'chat_mapping');
  return { linked: true, strategy: 'chat_mapping' };
}
```

### Step 9: Run tests

```bash
cd apps/pkg-core && npx jest --testPathPattern="orphan-segment-linker.service.spec" --no-coverage -- --forceExit
```

Expected: PASS

### Step 10: Commit

```bash
git add apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.ts apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.spec.ts
git commit -m "feat(segmentation): add chat→activity mapping strategy to OrphanSegmentLinker

When a telegram chat is associated with exactly one activity (via
interaction participants → activity members), all segments from that
chat inherit the activity binding. This is strategy 2, inserted
between participant matching and activity candidate matching."
```

### Step 11: Write test for LLM fallback strategy

Add to `orphan-segment-linker.service.spec.ts`:

```typescript
describe('linkByLlmClassification', () => {
  let mockClaudeAgent: any;

  beforeEach(() => {
    mockClaudeAgent = {
      call: jest.fn().mockResolvedValue({
        data: {
          classifications: [
            { segmentId: 'seg-1', activityId: 'act-1', confidence: 0.8, reasoning: 'Topic matches project' },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
        run: { id: 'run-1' },
      }),
    };
    // Re-inject mock
    (service as any).claudeAgentService = mockClaudeAgent;
  });

  it('should classify segment via LLM when confidence >= 0.6', async () => {
    const segments = [
      { id: 'seg-1', topic: 'Настройка Авито интеграции', summary: 'Обсуждение подключения Авито' },
    ];
    const activities = [
      { id: 'act-1', name: 'Панавто', activityType: 'PROJECT' },
      { id: 'act-2', name: 'Butler', activityType: 'PROJECT' },
    ];

    const results = await (service as any).linkByLlmClassification(segments, activities);
    expect(results).toHaveLength(1);
    expect(results[0].activityId).toBe('act-1');
    expect(results[0].confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('should skip classification when confidence < 0.6', async () => {
    mockClaudeAgent.call.mockResolvedValue({
      data: {
        classifications: [
          { segmentId: 'seg-1', activityId: 'act-1', confidence: 0.4, reasoning: 'Weak match' },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
      run: { id: 'run-1' },
    });

    const segments = [{ id: 'seg-1', topic: 'Погода', summary: 'Обсуждение погоды' }];
    const activities = [{ id: 'act-1', name: 'Панавто', activityType: 'PROJECT' }];

    const results = await (service as any).linkByLlmClassification(segments, activities);
    expect(results).toHaveLength(0);
  });
});
```

### Step 12: Run test to verify it fails

```bash
cd apps/pkg-core && npx jest --testPathPattern="orphan-segment-linker.service.spec" --no-coverage -- --forceExit
```

Expected: FAIL — `linkByLlmClassification` does not exist.

### Step 13: Add 'orphan_classification' to ClaudeTaskType

In `packages/entities/src/claude-agent-run.entity.ts` — already exists (line 36: `'orphan_classification'`). Verify in `apps/pkg-core/src/modules/claude-agent/claude-agent.types.ts` — also exists (line 33). No change needed.

### Step 14: Implement LLM fallback strategy

In `orphan-segment-linker.service.ts`, add:

```typescript
constructor(
  // ... existing deps ...
  @Optional()
  private readonly claudeAgentService: ClaudeAgentService | null,  // ❌ WRONG — null union
) {}
```

**IMPORTANT:** Per CLAUDE.md rules, never use `| null` in NestJS constructors. Use `@Optional()` and check at runtime:

```typescript
import { Optional } from '@nestjs/common';

constructor(
  // ... existing deps ...
  @Optional()
  private readonly claudeAgentService?: ClaudeAgentService,
) {}
```

Add the method:

```typescript
private readonly LLM_CONFIDENCE_THRESHOLD = 0.6;
private readonly LLM_BATCH_SIZE = 15;

/**
 * Strategy: LLM classification via Claude Haiku.
 * Batch unresolved segments and ask Claude to match them to activities.
 */
private async linkByLlmClassification(
  segments: Array<{ id: string; topic: string; summary: string }>,
  activities: Array<{ id: string; name: string; activityType: string }>,
): Promise<Array<{ segmentId: string; activityId: string; confidence: number }>> {
  if (!this.claudeAgentService || segments.length === 0) return [];

  const activityList = activities
    .map(a => `- ${a.id}: ${a.name} (${a.activityType})`)
    .join('\n');

  const segmentList = segments
    .map(s => `- ${s.id}: topic="${s.topic}", summary="${s.summary}"`)
    .join('\n');

  const prompt = `Классифицируй каждый сегмент обсуждения по проектам/активностям.

Активности:
${activityList}

Сегменты:
${segmentList}

Для каждого сегмента определи наиболее подходящую активность.
Если сегмент не относится ни к одной активности, поставь confidence < 0.3.

Заполни поля ответа:
- classifications: массив объектов { segmentId, activityId, confidence (0-1), reasoning }`;

  const result = await this.claudeAgentService.call<{
    classifications: Array<{
      segmentId: string;
      activityId: string;
      confidence: number;
      reasoning: string;
    }>;
  }>({
    mode: 'oneshot',
    taskType: 'orphan_classification',
    prompt,
    model: 'haiku',
    schema: {
      type: 'object',
      properties: {
        classifications: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              segmentId: { type: 'string' },
              activityId: { type: 'string' },
              confidence: { type: 'number' },
              reasoning: { type: 'string' },
            },
            required: ['segmentId', 'activityId', 'confidence', 'reasoning'],
          },
        },
      },
      required: ['classifications'],
    },
  });

  return (result.data?.classifications ?? [])
    .filter(c => c.confidence >= this.LLM_CONFIDENCE_THRESHOLD);
}
```

Integrate into `linkAllOrphans()`: after all other strategies, batch remaining orphans through LLM:

```typescript
// After standard strategies, collect still-unlinked segments
const stillOrphans = orphanSegments.filter(s => !linkedIds.has(s.id));
if (stillOrphans.length > 0 && this.claudeAgentService) {
  const allActivities = await this.activityService.findAll({ status: 'active', limit: 200 });

  // Process in batches
  for (let i = 0; i < stillOrphans.length; i += this.LLM_BATCH_SIZE) {
    const batch = stillOrphans.slice(i, i + this.LLM_BATCH_SIZE);
    const batchInput = batch.map(s => ({
      id: s.id,
      topic: s.topic || '',
      summary: s.summary || '',
    }));
    const activityInput = allActivities.data.map(a => ({
      id: a.id,
      name: a.name,
      activityType: a.activityType,
    }));

    const classifications = await this.linkByLlmClassification(batchInput, activityInput);
    for (const cls of classifications) {
      await this.assignActivity(cls.segmentId, cls.activityId, 'llm_classification');
      linkedIds.add(cls.segmentId);
      llmLinked++;
    }

    // Rate limiting between batches
    if (i + this.LLM_BATCH_SIZE < stillOrphans.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
```

### Step 15: Run tests

```bash
cd apps/pkg-core && npx jest --testPathPattern="orphan-segment-linker.service.spec" --no-coverage -- --forceExit
```

Expected: PASS

### Step 16: Commit

```bash
git add apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.ts apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.spec.ts
git commit -m "feat(segmentation): add LLM fallback strategy to OrphanSegmentLinker

For segments unresolved after threshold matching and chat mapping,
batch them through Claude Haiku for semantic classification against
active activities. Confidence threshold: 0.6. Batch size: 15."
```

### Step 17: Add batch re-linking endpoint

In `apps/pkg-core/src/modules/segmentation/segmentation.controller.ts`, add endpoint:

```typescript
/**
 * Re-link all orphan segments using all strategies (lowered threshold + chat mapping + LLM).
 * Use for retroactive linking of existing 1804 orphans.
 */
@Post('relink-all-orphans')
async relinkAllOrphans() {
  this.logger.log('Running full orphan re-linking with all strategies');
  return this.orphanLinker.linkAllOrphans();
}
```

### Step 18: Commit

```bash
git add apps/pkg-core/src/modules/segmentation/segmentation.controller.ts
git commit -m "feat(segmentation): add POST /segments/relink-all-orphans endpoint

Endpoint for retroactive linking of all 1804 orphan segments using
the full strategy chain: participant matching → chat mapping →
lowered threshold (0.5) → LLM classification."
```

---

## Task 1b: Confidence Decay

**Проблема:** Факт двухлетней давности имеет тот же вес, что и вчерашний. Нет temporal decay для confidence.

**Принцип:** Decay ТОЛЬКО при чтении. БД не трогаем. Формула: `effective = base * e^(-ln(2)/halfLife * ageDays)`.

**Files:**
- Modify: `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts`
- Create: `apps/pkg-core/src/modules/entity/entity-fact/confidence-decay.spec.ts`
- Modify: `apps/pkg-core/src/modules/context/context.service.ts`
- Modify: `apps/pkg-core/src/modules/settings/settings.service.ts`

### Step 1: Write test for decay formula

Create `apps/pkg-core/src/modules/entity/entity-fact/confidence-decay.spec.ts`:

```typescript
import { getEffectiveConfidence, DEFAULT_HALF_LIFE_DAYS } from './confidence-decay';

describe('getEffectiveConfidence', () => {
  const halfLifeConfig: Record<string, number | null> = {
    birthday: null,       // Permanent — no decay
    position: 730,        // 2 years
    project: 180,         // 6 months
    status: 90,           // 3 months
    default: 365,         // 1 year
  };

  it('should not decay birthday facts (halfLife = null)', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 0.9,
      factType: 'birthday',
      ageDays: 3650, // 10 years
      halfLifeConfig,
    });
    expect(result).toBe(0.9);
  });

  it('should decay by half at exactly half-life', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 1.0,
      factType: 'position',
      ageDays: 730, // exactly half-life
      halfLifeConfig,
    });
    expect(result).toBeCloseTo(0.5, 2);
  });

  it('should decay to ~0.25 at 2x half-life', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 1.0,
      factType: 'position',
      ageDays: 1460, // 2x half-life
      halfLifeConfig,
    });
    expect(result).toBeCloseTo(0.25, 2);
  });

  it('should use default half-life for unknown factType', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 1.0,
      factType: 'hobby',
      ageDays: 365,
      halfLifeConfig,
    });
    expect(result).toBeCloseTo(0.5, 2);
  });

  it('should handle zero age (brand new fact)', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 0.85,
      factType: 'status',
      ageDays: 0,
      halfLifeConfig,
    });
    expect(result).toBe(0.85);
  });

  it('should filter facts below minimum threshold 0.1', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 0.5,
      factType: 'status', // halfLife=90
      ageDays: 900,       // 10x half-life → 0.5 * (1/1024) ≈ 0.0005
      halfLifeConfig,
    });
    expect(result).toBeLessThan(0.1);
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd apps/pkg-core && npx jest --testPathPattern="confidence-decay.spec" --no-coverage -- --forceExit
```

Expected: FAIL — module `./confidence-decay` does not exist.

### Step 3: Implement decay function

Create `apps/pkg-core/src/modules/entity/entity-fact/confidence-decay.ts`:

```typescript
export const DEFAULT_HALF_LIFE_DAYS: Record<string, number | null> = {
  birthday: null,
  location: 365,
  position: 730,
  company: 730,
  skill: 1095,
  project: 180,
  status: 90,
  preference: 365,
  hobby: 730,
  default: 365,
};

export interface DecayParams {
  baseConfidence: number;
  factType: string;
  ageDays: number;
  halfLifeConfig: Record<string, number | null>;
}

/**
 * Calculate effective confidence with exponential decay.
 * Formula: effective = base * e^(-ln(2) / halfLife * ageDays)
 *
 * Applied ONLY at retrieval time — DB values remain unchanged.
 */
export function getEffectiveConfidence(params: DecayParams): number {
  const { baseConfidence, factType, ageDays, halfLifeConfig } = params;

  const halfLife = halfLifeConfig[factType] ?? halfLifeConfig['default'] ?? 365;

  // null halfLife = permanent (no decay)
  if (halfLife === null) return baseConfidence;

  if (ageDays <= 0) return baseConfidence;

  const decayFactor = Math.exp((-Math.LN2 / halfLife) * ageDays);
  return baseConfidence * decayFactor;
}

/** Minimum effective confidence threshold — facts below this are excluded */
export const MIN_EFFECTIVE_CONFIDENCE = 0.1;
```

### Step 4: Run test to verify it passes

```bash
cd apps/pkg-core && npx jest --testPathPattern="confidence-decay.spec" --no-coverage -- --forceExit
```

Expected: PASS

### Step 5: Commit

```bash
git add apps/pkg-core/src/modules/entity/entity-fact/confidence-decay.ts apps/pkg-core/src/modules/entity/entity-fact/confidence-decay.spec.ts
git commit -m "feat(entity-fact): add confidence decay formula

Exponential decay: effective = base * e^(-ln(2)/halfLife * ageDays).
Applied only at retrieval time, DB values unchanged. Per-type half-life
config: birthday=permanent, status=90d, project=180d, position=730d."
```

### Step 6: Register half-life config in Settings defaults

In `apps/pkg-core/src/modules/settings/settings.service.ts`, add to `DEFAULT_SETTINGS`:

```typescript
// In DEFAULT_SETTINGS object:
'factType.halfLifeDays': JSON.stringify({
  birthday: null,
  location: 365,
  position: 730,
  company: 730,
  skill: 1095,
  project: 180,
  status: 90,
  preference: 365,
  hobby: 730,
  default: 365,
}),
```

### Step 7: Commit

```bash
git add apps/pkg-core/src/modules/settings/settings.service.ts
git commit -m "feat(settings): add factType.halfLifeDays default config

JSON config for per-factType half-life in days. null = no decay
(permanent facts like birthday). Configurable via Settings API."
```

### Step 8: Add getEffectiveConfidence helper to EntityFactService

In `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts`, add:

```typescript
import { getEffectiveConfidence, MIN_EFFECTIVE_CONFIDENCE } from './confidence-decay';

// Add to class:
/**
 * Calculate effective confidence for a fact, applying temporal decay.
 */
async getFactsWithDecay(
  entityId: string,
  halfLifeConfig?: Record<string, number | null>,
): Promise<Array<EntityFact & { effectiveConfidence: number }>> {
  const facts = await this.factRepo.find({
    where: { entityId, validUntil: IsNull() },
    order: { createdAt: 'DESC' },
  });

  const config = halfLifeConfig ?? await this.loadHalfLifeConfig();
  const now = Date.now();

  return facts
    .map(fact => {
      const validFrom = fact.validFrom ?? fact.updatedAt ?? fact.createdAt;
      const ageDays = (now - new Date(validFrom).getTime()) / (1000 * 60 * 60 * 24);
      const effectiveConfidence = getEffectiveConfidence({
        baseConfidence: Number(fact.confidence) || 0.5,
        factType: fact.factType,
        ageDays,
        halfLifeConfig: config,
      });
      return { ...fact, effectiveConfidence };
    })
    .filter(f => f.effectiveConfidence >= MIN_EFFECTIVE_CONFIDENCE)
    .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence);
}

private async loadHalfLifeConfig(): Promise<Record<string, number | null>> {
  if (!this.settingsService) return DEFAULT_HALF_LIFE_DAYS;
  const json = await this.settingsService.getValue<string>('factType.halfLifeDays');
  if (!json) return DEFAULT_HALF_LIFE_DAYS;
  try {
    return JSON.parse(json);
  } catch {
    return DEFAULT_HALF_LIFE_DAYS;
  }
}
```

Add `SettingsService` as `@Optional()` dependency (it may already be available through the module's imports):

```typescript
import { SettingsService } from '../../settings/settings.service';

constructor(
  // ... existing deps ...
  @Optional()
  private readonly settingsService?: SettingsService,
) {}
```

Import `DEFAULT_HALF_LIFE_DAYS`:

```typescript
import { DEFAULT_HALF_LIFE_DAYS } from './confidence-decay';
```

### Step 9: Commit

```bash
git add apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts
git commit -m "feat(entity-fact): add getFactsWithDecay() method

Returns facts with effectiveConfidence applied via exponential decay.
Filters out facts below MIN_EFFECTIVE_CONFIDENCE (0.1). Sorts by
effectiveConfidence DESC. Loads half-life config from Settings."
```

### Step 10: Integrate decay into ContextService

In `apps/pkg-core/src/modules/context/context.service.ts`, modify the PERMANENT tier (lines ~90-93) to use decayed facts:

```typescript
// BEFORE (line ~90):
const facts = await this.factRepo.find({
  where: { entityId, validUntil: IsNull() },
  order: { createdAt: 'DESC' },
});

// AFTER:
// Use EntityFactService.getFactsWithDecay() for temporal ranking
const facts = await this.entityFactService.getFactsWithDecay(entityId);
```

Add `EntityFactService` as a dependency of `ContextService`:

```typescript
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';

constructor(
  // ... existing deps ...
  @Optional()
  private readonly entityFactService?: EntityFactService,
) {}
```

Update `buildSynthesisPrompt()` to include effectiveConfidence:

```typescript
// BEFORE:
const factsText = facts.map(f => `${f.factType}: ${f.value}`).join('\n');

// AFTER:
const factsText = facts
  .map(f => {
    const conf = (f as any).effectiveConfidence ?? f.confidence;
    return `${f.factType}: ${f.value} [confidence: ${(Number(conf) * 100).toFixed(0)}%]`;
  })
  .join('\n');
```

### Step 11: Commit

```bash
git add apps/pkg-core/src/modules/context/context.service.ts
git commit -m "feat(context): integrate confidence decay into retrieval

PERMANENT tier now uses getFactsWithDecay() for temporal ranking.
Facts below 10% effective confidence are excluded. Synthesis prompt
includes confidence percentages for Claude context."
```

---

## Task 1c: Fact Taxonomy Cleanup

**Проблема:** 18 factTypes без метаданных. role и position дублируют друг друга. Нет валидации при extraction.

**Files:**
- Create: `apps/pkg-core/src/modules/entity/entity-fact/fact-type-config.ts`
- Create: `apps/pkg-core/src/modules/entity/entity-fact/fact-type-config.spec.ts`
- Create: migration for role→position merge
- Modify: `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts`

### Step 1: Write test for fact type config

Create `apps/pkg-core/src/modules/entity/entity-fact/fact-type-config.spec.ts`:

```typescript
import { FACT_TYPE_CONFIG, getFactTypeConfig, isValidFactType, FactCategory } from './fact-type-config';

describe('FactTypeConfig', () => {
  it('should have config for all known fact types', () => {
    const knownTypes = [
      'birthday', 'location', 'position', 'company', 'skill',
      'project', 'status', 'preference', 'hobby', 'phone',
      'email', 'telegram', 'website', 'social', 'education',
      'family',
    ];
    for (const type of knownTypes) {
      expect(FACT_TYPE_CONFIG[type]).toBeDefined();
    }
  });

  it('should NOT have role (merged into position)', () => {
    expect(FACT_TYPE_CONFIG['role']).toBeUndefined();
  });

  it('should return config for valid type', () => {
    const config = getFactTypeConfig('birthday');
    expect(config).toBeDefined();
    expect(config?.halfLifeDays).toBeNull(); // permanent
    expect(config?.category).toBe('personal');
    expect(config?.isUnique).toBe(true);
  });

  it('should return null for invalid type', () => {
    expect(getFactTypeConfig('nonexistent')).toBeNull();
  });

  it('should validate known fact types', () => {
    expect(isValidFactType('position')).toBe(true);
    expect(isValidFactType('role')).toBe(false);
    expect(isValidFactType('invalid')).toBe(false);
  });

  it('should categorize fact types correctly', () => {
    const professionalTypes = Object.entries(FACT_TYPE_CONFIG)
      .filter(([_, c]) => c.category === 'professional')
      .map(([k]) => k);
    expect(professionalTypes).toContain('position');
    expect(professionalTypes).toContain('company');
    expect(professionalTypes).toContain('skill');
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd apps/pkg-core && npx jest --testPathPattern="fact-type-config.spec" --no-coverage -- --forceExit
```

Expected: FAIL — module does not exist.

### Step 3: Create fact type config

Create `apps/pkg-core/src/modules/entity/entity-fact/fact-type-config.ts`:

```typescript
export type FactCategory = 'professional' | 'personal' | 'preference' | 'contact' | 'business';
export type ExtractionPriority = 'high' | 'medium' | 'low';

export interface FactTypeConfigEntry {
  halfLifeDays: number | null;
  category: FactCategory;
  isUnique: boolean;
  extractionPriority: ExtractionPriority;
}

export const FACT_TYPE_CONFIG: Record<string, FactTypeConfigEntry> = {
  birthday:   { halfLifeDays: null,  category: 'personal',     isUnique: true,  extractionPriority: 'high' },
  location:   { halfLifeDays: 365,   category: 'personal',     isUnique: false, extractionPriority: 'medium' },
  position:   { halfLifeDays: 730,   category: 'professional', isUnique: true,  extractionPriority: 'high' },
  company:    { halfLifeDays: 730,   category: 'professional', isUnique: true,  extractionPriority: 'high' },
  skill:      { halfLifeDays: 1095,  category: 'professional', isUnique: false, extractionPriority: 'medium' },
  project:    { halfLifeDays: 180,   category: 'business',     isUnique: false, extractionPriority: 'medium' },
  status:     { halfLifeDays: 90,    category: 'business',     isUnique: false, extractionPriority: 'high' },
  preference: { halfLifeDays: 365,   category: 'preference',   isUnique: false, extractionPriority: 'low' },
  hobby:      { halfLifeDays: 730,   category: 'personal',     isUnique: false, extractionPriority: 'low' },
  phone:      { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'high' },
  email:      { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'high' },
  telegram:   { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'high' },
  website:    { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'low' },
  social:     { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'low' },
  education:  { halfLifeDays: null,  category: 'personal',     isUnique: false, extractionPriority: 'medium' },
  family:     { halfLifeDays: null,  category: 'personal',     isUnique: false, extractionPriority: 'medium' },
};

export function getFactTypeConfig(factType: string): FactTypeConfigEntry | null {
  return FACT_TYPE_CONFIG[factType] ?? null;
}

export function isValidFactType(factType: string): boolean {
  return factType in FACT_TYPE_CONFIG;
}

export const VALID_FACT_TYPES = Object.keys(FACT_TYPE_CONFIG);
```

### Step 4: Run test to verify it passes

```bash
cd apps/pkg-core && npx jest --testPathPattern="fact-type-config.spec" --no-coverage -- --forceExit
```

Expected: PASS

### Step 5: Commit

```bash
git add apps/pkg-core/src/modules/entity/entity-fact/fact-type-config.ts apps/pkg-core/src/modules/entity/entity-fact/fact-type-config.spec.ts
git commit -m "feat(entity-fact): add fact type config with metadata

Config per factType: halfLifeDays, category, isUnique, extractionPriority.
16 clean types. 'role' excluded (will be merged into 'position')."
```

### Step 6: Create migration for role→position merge

```bash
cd apps/pkg-core && npx typeorm migration:create src/database/migrations/MergeRoleToPosition
```

Edit the generated migration:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class MergeRoleToPosition1741500000000 implements MigrationInterface {
  name = 'MergeRoleToPosition1741500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Count existing role facts
    const [{ count }] = await queryRunner.query(
      `SELECT COUNT(*) as count FROM entity_facts WHERE fact_type = 'role'`,
    );

    if (Number(count) > 0) {
      // Merge role → position, preserving data
      await queryRunner.query(`
        UPDATE entity_facts
        SET fact_type = 'position'
        WHERE fact_type = 'role'
          AND NOT EXISTS (
            SELECT 1 FROM entity_facts ef2
            WHERE ef2.entity_id = entity_facts.entity_id
              AND ef2.fact_type = 'position'
              AND ef2.value = entity_facts.value
          )
      `);

      // Delete remaining role duplicates (where position already exists with same value)
      await queryRunner.query(`
        DELETE FROM entity_facts WHERE fact_type = 'role'
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Cannot reverse — we don't know which position facts were originally role
  }
}
```

### Step 7: Commit

```bash
git add apps/pkg-core/src/database/migrations/*MergeRoleToPosition*
git commit -m "feat(migration): merge role→position fact type

Migrates all 'role' facts to 'position'. Avoids duplicates by
checking if a position fact with the same value already exists."
```

### Step 8: Add factType validation to ExtractionToolsProvider

In `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts`, in the `create_fact` tool handler:

```typescript
import { isValidFactType, VALID_FACT_TYPES } from '../../entity/entity-fact/fact-type-config';

// At the start of create_fact handler:
if (!isValidFactType(args.factType)) {
  return toolError(
    `Invalid factType "${args.factType}". Valid types: ${VALID_FACT_TYPES.join(', ')}. ` +
    `Note: "role" has been merged into "position".`
  );
}
```

Also update the Zod enum to use `VALID_FACT_TYPES`:

```typescript
// BEFORE:
factType: z.enum(['birthday', 'location', 'position', 'company', ...])

// AFTER:
factType: z.enum(VALID_FACT_TYPES as [string, ...string[]])
  .describe('Fact type. Note: use "position" instead of "role"'),
```

### Step 9: Commit

```bash
git add apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts
git commit -m "feat(extraction): validate factType against config

create_fact tool now validates factType using isValidFactType().
Invalid types return actionable error. 'role' → 'position' hint."
```

---

## Verification

### Task 1a (Segment Linking):
```bash
# After deploy, run retro-linking:
curl -X POST https://assistant.mityayka.ru/api/v1/segments/relink-all-orphans \
  -H "x-api-key: $API_KEY"
# Expected: JSON with linked count > 0 (target: >70% of 1804)
```

### Task 1b (Confidence Decay):
```bash
# Check that old facts get lower confidence in context:
curl https://assistant.mityayka.ru/api/v1/context/entity/{entityId} \
  -H "x-api-key: $API_KEY"
# Expected: facts sorted by effectiveConfidence, old facts with lower %
```

### Task 1c (Taxonomy):
```bash
# Run migration on production:
cd /opt/apps/pkg && npx typeorm migration:run -d apps/pkg-core/src/database/data-source.ts
# Expected: role facts merged into position

# Verify no role facts remain:
# SQL: SELECT COUNT(*) FROM entity_facts WHERE fact_type = 'role'
# Expected: 0
```

### All tests:
```bash
cd apps/pkg-core && npx jest --no-coverage -- --forceExit
```
