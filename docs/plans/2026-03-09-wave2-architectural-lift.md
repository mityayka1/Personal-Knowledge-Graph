# Wave 2: Architectural Lift — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Поднять Knowledge System на архитектурный уровень: заработавший KnowledgePack pipeline с hierarchical aggregation и graph-aware retrieval с обходом связей между entities.

**Architecture:** Две задачи, обе зависят от Wave 1 (нужны привязанные сегменты и рабочий linking). Task 2a активирует и улучшает PackingJobService. Task 2b создаёт GraphTraversalService и интегрирует в ContextService.

**Tech Stack:** NestJS, TypeORM, PostgreSQL, Claude Agent SDK (Sonnet для synthesis), Jest

**Dependencies:** Wave 1 должен быть завершён (сегменты привязаны к Activity, decay работает).

---

## Task 2a: Activity-level KnowledgePacks

**Проблема:** PackingJobService (weekly Sunday 3AM) мёртв: 0 сегментов с activityId → 0 packs. После Wave 1a сегменты будут привязаны — pipeline заработает. Нужно добавить hierarchical aggregation и incremental update.

**Files:**
- Modify: `apps/pkg-core/src/modules/segmentation/packing-job.service.ts`
- Modify: `apps/pkg-core/src/modules/segmentation/packing.service.ts`
- Create: `apps/pkg-core/src/modules/segmentation/packing-job.service.spec.ts`
- Create: `apps/pkg-core/src/modules/segmentation/packing.service.spec.ts`

### Step 1: Write test for hierarchical segment collection

Create `apps/pkg-core/src/modules/segmentation/packing-job.service.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PackingJobService } from './packing-job.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TopicalSegment, KnowledgePack, Activity } from '@pkg/entities';
import { DataSource } from 'typeorm';
import { PackingService } from './packing.service';
import { OrphanSegmentLinkerService } from './orphan-segment-linker.service';
import { SettingsService } from '../settings/settings.service';

describe('PackingJobService', () => {
  let service: PackingJobService;
  let mockDataSource: Partial<DataSource>;
  let mockPackingService: any;

  beforeEach(async () => {
    mockDataSource = { query: jest.fn() };
    mockPackingService = { packByActivity: jest.fn().mockResolvedValue({ id: 'kp-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PackingJobService,
        { provide: getRepositoryToken(TopicalSegment), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(KnowledgePack), useValue: {} },
        { provide: getRepositoryToken(Activity), useValue: { find: jest.fn() } },
        { provide: DataSource, useValue: mockDataSource },
        { provide: PackingService, useValue: mockPackingService },
        { provide: OrphanSegmentLinkerService, useValue: { linkAllOrphans: jest.fn() } },
        { provide: SettingsService, useValue: { getValue: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();

    service = module.get<PackingJobService>(PackingJobService);
  });

  describe('collectHierarchicalSegments', () => {
    it('should collect segments from activity and its children', async () => {
      // PROJECT activity with 2 child TASKs
      mockDataSource.query = jest.fn()
        .mockResolvedValueOnce([
          // Segments for the PROJECT itself
          { id: 'seg-1', activity_id: 'proj-1', topic: 'Project planning' },
        ])
        .mockResolvedValueOnce([
          // Child activities
          { id: 'task-1', name: 'Setup CI', parent_id: 'proj-1' },
          { id: 'task-2', name: 'Deploy', parent_id: 'proj-1' },
        ])
        .mockResolvedValueOnce([
          // Segments for child tasks
          { id: 'seg-2', activity_id: 'task-1', topic: 'CI configuration' },
          { id: 'seg-3', activity_id: 'task-2', topic: 'Deploy setup' },
        ]);

      const segments = await (service as any).collectHierarchicalSegments('proj-1');
      expect(segments).toHaveLength(3);
      expect(segments.map((s: any) => s.id)).toEqual(['seg-1', 'seg-2', 'seg-3']);
    });

    it('should return only own segments when no children', async () => {
      mockDataSource.query = jest.fn()
        .mockResolvedValueOnce([
          { id: 'seg-1', activity_id: 'task-1', topic: 'Task topic' },
        ])
        .mockResolvedValueOnce([]); // no children

      const segments = await (service as any).collectHierarchicalSegments('task-1');
      expect(segments).toHaveLength(1);
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd apps/pkg-core && npx jest --testPathPattern="packing-job.service.spec" --no-coverage -- --forceExit
```

Expected: FAIL — `collectHierarchicalSegments` does not exist.

### Step 3: Implement hierarchical segment collection

In `apps/pkg-core/src/modules/segmentation/packing-job.service.ts`, add:

```typescript
/**
 * Collect segments from an activity AND all its descendant activities.
 * For PROJECT, includes segments from child TASKs.
 * For BUSINESS, includes segments from child PROJECTs and their TASKs.
 */
private async collectHierarchicalSegments(activityId: string): Promise<TopicalSegment[]> {
  // Get segments directly linked to this activity
  const ownSegments = await this.segmentRepo.find({
    where: { activityId, status: 'ACTIVE' },
    order: { startedAt: 'ASC' },
  });

  // Get all descendant activity IDs using closure table
  const descendants: Array<{ id: string }> = await this.dataSource.query(`
    SELECT a.id
    FROM activities a
    INNER JOIN activity_closure ac ON ac.id_descendant = a.id
    WHERE ac.id_ancestor = $1
      AND ac.id_descendant != $1
      AND a.status = 'active'
  `, [activityId]);

  if (descendants.length === 0) return ownSegments;

  const descendantIds = descendants.map(d => d.id);

  // Get segments from all descendants
  const childSegments = await this.segmentRepo
    .createQueryBuilder('s')
    .where('s.activityId IN (:...ids)', { ids: descendantIds })
    .andWhere('s.status = :status', { status: 'ACTIVE' })
    .orderBy('s.startedAt', 'ASC')
    .getMany();

  return [...ownSegments, ...childSegments];
}
```

### Step 4: Run test to verify it passes

```bash
cd apps/pkg-core && npx jest --testPathPattern="packing-job.service.spec" --no-coverage -- --forceExit
```

Expected: PASS

### Step 5: Commit

```bash
git add apps/pkg-core/src/modules/segmentation/packing-job.service.ts apps/pkg-core/src/modules/segmentation/packing-job.service.spec.ts
git commit -m "feat(packing): add hierarchical segment collection

collectHierarchicalSegments() gathers segments from an activity and
all its descendants via closure table. PROJECT packing includes
segments from child TASKs."
```

### Step 6: Write test for incremental KnowledgePack update

Create `apps/pkg-core/src/modules/segmentation/packing.service.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PackingService } from './packing.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TopicalSegment, KnowledgePack, Activity, EntityFact, Commitment } from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

describe('PackingService', () => {
  let service: PackingService;
  let mockKpRepo: any;
  let mockClaudeAgent: any;

  beforeEach(async () => {
    mockKpRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(kp => ({ ...kp, id: kp.id || 'kp-new' })),
      create: jest.fn().mockImplementation(data => data),
    };
    mockClaudeAgent = {
      call: jest.fn().mockResolvedValue({
        data: {
          keyFacts: ['Fact 1', 'Fact 2'],
          decisions: ['Decision 1'],
          openQuestions: ['Question 1'],
          conflicts: [],
          timeline: [{ date: '2026-03-01', event: 'Start' }],
        },
        usage: { inputTokens: 500, outputTokens: 200, totalCostUsd: 0.01 },
        run: { id: 'run-1' },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PackingService,
        { provide: getRepositoryToken(TopicalSegment), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(KnowledgePack), useValue: mockKpRepo },
        { provide: getRepositoryToken(Activity), useValue: {} },
        { provide: getRepositoryToken(EntityFact), useValue: {} },
        { provide: getRepositoryToken(Commitment), useValue: {} },
        { provide: ClaudeAgentService, useValue: mockClaudeAgent },
      ],
    }).compile();

    service = module.get<PackingService>(PackingService);
  });

  describe('packByActivityIncremental', () => {
    it('should create new KP when none exists', async () => {
      mockKpRepo.findOne.mockResolvedValue(null); // no existing KP

      const segments = [
        { id: 'seg-1', topic: 'Integration', summary: 'Discussed integration' },
        { id: 'seg-2', topic: 'Deploy', summary: 'Planned deployment' },
      ] as any[];

      const result = await service.packByActivityIncremental('act-1', segments);
      expect(mockKpRepo.save).toHaveBeenCalled();
      expect(result.isNew).toBe(true);
    });

    it('should update existing KP with new segments', async () => {
      const existingKp = {
        id: 'kp-existing',
        activityId: 'act-1',
        status: 'ACTIVE',
        content: JSON.stringify({ keyFacts: ['Old fact'] }),
        segmentIds: ['seg-old'],
      };
      mockKpRepo.findOne.mockResolvedValue(existingKp);

      const newSegments = [
        { id: 'seg-new', topic: 'New topic', summary: 'New discussion' },
      ] as any[];

      const result = await service.packByActivityIncremental('act-1', newSegments);
      expect(mockClaudeAgent.call).toHaveBeenCalled();
      expect(result.isNew).toBe(false);
      expect(result.newSegmentsAdded).toBe(1);
    });
  });
});
```

### Step 7: Run test to verify it fails

```bash
cd apps/pkg-core && npx jest --testPathPattern="packing.service.spec" --no-coverage -- --forceExit
```

Expected: FAIL — `packByActivityIncremental` does not exist.

### Step 8: Implement incremental packing

In `apps/pkg-core/src/modules/segmentation/packing.service.ts`, add:

```typescript
export interface StructuredKpContent {
  keyFacts: string[];
  decisions: string[];
  openQuestions: string[];
  conflicts: string[];
  timeline: Array<{ date: string; event: string }>;
}

/**
 * Incremental packing: update existing KP with new segments,
 * or create a new one if none exists for the activity.
 */
async packByActivityIncremental(
  activityId: string,
  newSegments: TopicalSegment[],
): Promise<{ id: string; isNew: boolean; newSegmentsAdded: number }> {
  // Find existing ACTIVE KP for this activity
  const existingKp = await this.kpRepo.findOne({
    where: { activityId, status: 'ACTIVE' },
    order: { createdAt: 'DESC' },
  });

  if (!existingKp) {
    // Create new KP
    const content = await this.synthesizeStructured(newSegments, null);
    const kp = this.kpRepo.create({
      activityId,
      type: 'BY_ACTIVITY',
      status: 'ACTIVE',
      content: JSON.stringify(content),
      segmentIds: newSegments.map(s => s.id),
      segmentCount: newSegments.length,
    });
    const saved = await this.kpRepo.save(kp);

    // Mark segments as PACKED
    await this.markSegmentsPacked(newSegments.map(s => s.id), saved.id);

    return { id: saved.id, isNew: true, newSegmentsAdded: newSegments.length };
  }

  // Filter out segments already in the KP
  const existingSegmentIds = new Set(existingKp.segmentIds || []);
  const trulyNewSegments = newSegments.filter(s => !existingSegmentIds.has(s.id));

  if (trulyNewSegments.length === 0) {
    return { id: existingKp.id, isNew: false, newSegmentsAdded: 0 };
  }

  // Incremental update: synthesize with existing content as context
  const existingContent = this.parseContent(existingKp.content);
  const updatedContent = await this.synthesizeStructured(trulyNewSegments, existingContent);

  existingKp.content = JSON.stringify(updatedContent);
  existingKp.segmentIds = [...(existingKp.segmentIds || []), ...trulyNewSegments.map(s => s.id)];
  existingKp.segmentCount = existingKp.segmentIds.length;
  await this.kpRepo.save(existingKp);

  await this.markSegmentsPacked(trulyNewSegments.map(s => s.id), existingKp.id);

  return { id: existingKp.id, isNew: false, newSegmentsAdded: trulyNewSegments.length };
}

private parseContent(content: string): StructuredKpContent | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Synthesize structured KP content from segments, optionally merging with existing content.
 */
private async synthesizeStructured(
  segments: TopicalSegment[],
  existingContent: StructuredKpContent | null,
): Promise<StructuredKpContent> {
  const segmentText = segments
    .map(s => `[${s.topic}] ${s.summary || ''}`)
    .join('\n\n');

  const existingContext = existingContent
    ? `\n\nСуществующие знания (обнови/дополни):\n${JSON.stringify(existingContent, null, 2)}`
    : '';

  const prompt = `Проанализируй обсуждения и создай структурированную сводку.${existingContext}

Новые обсуждения:
${segmentText}

Заполни поля ответа:
- keyFacts: ключевые факты (массив строк)
- decisions: принятые решения (массив строк)
- openQuestions: нерешённые вопросы (массив строк)
- conflicts: противоречия между фактами (массив строк, может быть пустым)
- timeline: хронология ключевых событий (массив { date, event })`;

  const result = await this.claudeAgentService.call<StructuredKpContent>({
    mode: 'oneshot',
    taskType: 'knowledge_packing',
    prompt,
    model: 'sonnet',
    schema: {
      type: 'object',
      properties: {
        keyFacts: { type: 'array', items: { type: 'string' }, description: 'Key facts' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions made' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: 'Open questions' },
        conflicts: { type: 'array', items: { type: 'string' }, description: 'Fact conflicts' },
        timeline: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Date (ISO or approximate)' },
              event: { type: 'string', description: 'Event description' },
            },
            required: ['date', 'event'],
          },
          description: 'Key event timeline',
        },
      },
      required: ['keyFacts', 'decisions', 'openQuestions', 'conflicts', 'timeline'],
    },
  });

  return result.data ?? {
    keyFacts: [],
    decisions: [],
    openQuestions: [],
    conflicts: [],
    timeline: [],
  };
}

private async markSegmentsPacked(segmentIds: string[], knowledgePackId: string): Promise<void> {
  if (segmentIds.length === 0) return;
  await this.segmentRepo
    .createQueryBuilder()
    .update(TopicalSegment)
    .set({ status: 'PACKED' as any, knowledgePackId })
    .whereInIds(segmentIds)
    .execute();
}
```

### Step 9: Run test to verify it passes

```bash
cd apps/pkg-core && npx jest --testPathPattern="packing.service.spec" --no-coverage -- --forceExit
```

Expected: PASS

### Step 10: Commit

```bash
git add apps/pkg-core/src/modules/segmentation/packing.service.ts apps/pkg-core/src/modules/segmentation/packing.service.spec.ts
git commit -m "feat(packing): add incremental KnowledgePack updates

packByActivityIncremental() creates or updates KP for an activity.
Uses structured synthesis with keyFacts, decisions, openQuestions,
conflicts, and timeline fields. Claude Sonnet for synthesis."
```

### Step 11: Update PackingJobService to use hierarchical + incremental

In `apps/pkg-core/src/modules/segmentation/packing-job.service.ts`, update the main packing loop:

```typescript
// In the main packing method, replace direct packing with hierarchical + incremental:
for (const activity of activitiesWithSegments) {
  try {
    // Collect segments from activity + children
    const allSegments = await this.collectHierarchicalSegments(activity.id);

    if (allSegments.length < MIN_SEGMENTS) {
      this.logger.debug(`[packing] Activity ${activity.name}: ${allSegments.length} segments (< ${MIN_SEGMENTS}), skipping`);
      continue;
    }

    // Incremental packing
    const result = await this.packingService.packByActivityIncremental(activity.id, allSegments);

    this.logger.log(
      `[packing] Activity "${activity.name}": ` +
      `${result.isNew ? 'created new' : 'updated'} KP ${result.id}, ` +
      `${result.newSegmentsAdded} new segments added`,
    );

    packedCount++;

    // Rate limiting between Claude calls
    await new Promise(r => setTimeout(r, 2000));
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    this.logger.error(`[packing] Error packing activity ${activity.name}: ${err.message}`, err.stack);
    errorCount++;
  }
}
```

### Step 12: Commit

```bash
git add apps/pkg-core/src/modules/segmentation/packing-job.service.ts
git commit -m "feat(packing): integrate hierarchical + incremental packing into job

PackingJobService now collects segments from activity subtree and
uses incremental packing. Rate-limited with 2s delay between calls."
```

---

## Task 2b: Graph-aware Retrieval

**Проблема:** ContextService выполняет 6 независимых SQL запросов. Нет обхода relations между entities. Нет Activity hierarchy traversal.

**Files:**
- Create: `apps/pkg-core/src/modules/context/graph-traversal.service.ts`
- Create: `apps/pkg-core/src/modules/context/graph-traversal.service.spec.ts`
- Modify: `apps/pkg-core/src/modules/context/context.service.ts`
- Modify: `apps/pkg-core/src/modules/context/context.module.ts`

### Step 1: Write test for entity relation traversal

Create `apps/pkg-core/src/modules/context/graph-traversal.service.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { GraphTraversalService, TraversalResult } from './graph-traversal.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Entity, EntityRelation, EntityFact, Activity } from '@pkg/entities';
import { DataSource } from 'typeorm';

describe('GraphTraversalService', () => {
  let service: GraphTraversalService;
  let mockDataSource: Partial<DataSource>;

  beforeEach(async () => {
    mockDataSource = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphTraversalService,
        { provide: getRepositoryToken(Entity), useValue: {} },
        { provide: getRepositoryToken(EntityRelation), useValue: {} },
        { provide: getRepositoryToken(EntityFact), useValue: {} },
        { provide: getRepositoryToken(Activity), useValue: {} },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<GraphTraversalService>(GraphTraversalService);
  });

  describe('traverseEntityRelations', () => {
    it('should return related entities with facts (1 hop)', async () => {
      // Entity "Иванов" → works_at → "Панавто" → other employees
      mockDataSource.query = jest.fn()
        // Hop 1: direct relations
        .mockResolvedValueOnce([
          {
            related_id: 'panawto-id',
            related_name: 'Панавто',
            relation_type: 'works_at',
            interaction_count: '10',
          },
        ])
        // Hop 1 facts
        .mockResolvedValueOnce([
          {
            entity_id: 'panawto-id',
            fact_type: 'company',
            value: 'Автодилер',
            confidence: '0.9',
            created_at: new Date(),
          },
        ]);

      const result = await service.traverseEntityRelations('ivanov-id', { maxHops: 1, maxRelated: 5 });

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].entityId).toBe('panawto-id');
      expect(result.entities[0].hop).toBe(1);
      expect(result.entities[0].facts).toHaveLength(1);
    });

    it('should apply hop penalty to scores', async () => {
      mockDataSource.query = jest.fn()
        .mockResolvedValueOnce([
          { related_id: 'e1', related_name: 'E1', relation_type: 'works_at', interaction_count: '5' },
        ])
        .mockResolvedValueOnce([
          { entity_id: 'e1', fact_type: 'position', value: 'CEO', confidence: '1.0', created_at: new Date() },
        ]);

      const result = await service.traverseEntityRelations('root-id', { maxHops: 1, maxRelated: 5 });

      // hop_penalty = 0.8^1 = 0.8
      expect(result.entities[0].hopPenalty).toBeCloseTo(0.8, 2);
    });

    it('should respect maxRelated limit', async () => {
      const manyRelations = Array.from({ length: 20 }, (_, i) => ({
        related_id: `e-${i}`,
        related_name: `Entity ${i}`,
        relation_type: 'knows',
        interaction_count: `${20 - i}`,
      }));
      mockDataSource.query = jest.fn()
        .mockResolvedValueOnce(manyRelations)
        .mockResolvedValueOnce([]); // no facts

      const result = await service.traverseEntityRelations('root-id', { maxHops: 1, maxRelated: 5 });
      expect(result.entities).toHaveLength(5);
    });
  });

  describe('traverseActivityHierarchy', () => {
    it('should traverse parent chain and children', async () => {
      // TASK → PROJECT → BUSINESS
      mockDataSource.query = jest.fn()
        // Parent chain
        .mockResolvedValueOnce([
          { id: 'proj-1', name: 'Битрикс-хаб', activity_type: 'PROJECT', parent_id: 'biz-1' },
          { id: 'biz-1', name: 'ИИ-Сервисы', activity_type: 'BUSINESS', parent_id: null },
        ])
        // Children
        .mockResolvedValueOnce([])
        // KnowledgePacks for each level
        .mockResolvedValueOnce([
          { id: 'kp-1', activity_id: 'proj-1', content: '{"keyFacts":["Fact1"]}' },
        ]);

      const result = await service.traverseActivityHierarchy('task-1');

      expect(result.parents).toHaveLength(2);
      expect(result.parents[0].name).toBe('Битрикс-хаб');
      expect(result.knowledgePacks).toHaveLength(1);
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd apps/pkg-core && npx jest --testPathPattern="graph-traversal.service.spec" --no-coverage -- --forceExit
```

Expected: FAIL — module does not exist.

### Step 3: Implement GraphTraversalService

Create `apps/pkg-core/src/modules/context/graph-traversal.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Entity, EntityRelation, EntityFact, Activity, KnowledgePack } from '@pkg/entities';

export interface TraversalOptions {
  maxHops: number;
  maxRelated: number;
}

export interface RelatedEntityResult {
  entityId: string;
  entityName: string;
  relationType: string;
  hop: number;
  hopPenalty: number;
  facts: Array<{
    factType: string;
    value: string;
    confidence: number;
  }>;
}

export interface EntityTraversalResult {
  entities: RelatedEntityResult[];
}

export interface ActivityHierarchyResult {
  parents: Array<{ id: string; name: string; activityType: string }>;
  children: Array<{ id: string; name: string; activityType: string }>;
  knowledgePacks: Array<{ id: string; activityId: string; content: string }>;
}

const HOP_PENALTY_BASE = 0.8;

@Injectable()
export class GraphTraversalService {
  private readonly logger = new Logger(GraphTraversalService.name);

  constructor(
    @InjectRepository(Entity)
    private readonly entityRepo: Repository<Entity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Traverse entity relations up to maxHops, collecting related entities and their facts.
   * Results sorted by interaction_count DESC, limited to maxRelated per hop.
   */
  async traverseEntityRelations(
    entityId: string,
    options: TraversalOptions = { maxHops: 2, maxRelated: 5 },
  ): Promise<EntityTraversalResult> {
    const visited = new Set<string>([entityId]);
    const results: RelatedEntityResult[] = [];
    let currentIds = [entityId];

    for (let hop = 1; hop <= options.maxHops; hop++) {
      if (currentIds.length === 0) break;

      // Find related entities
      const relations: Array<{
        related_id: string;
        related_name: string;
        relation_type: string;
        interaction_count: string;
      }> = await this.dataSource.query(`
        SELECT
          CASE WHEN er.source_entity_id = ANY($1::uuid[]) THEN er.target_entity_id ELSE er.source_entity_id END AS related_id,
          e.name AS related_name,
          er.relation_type,
          COALESCE(er.interaction_count, 0)::text AS interaction_count
        FROM entity_relations er
        INNER JOIN entities e ON e.id = CASE
          WHEN er.source_entity_id = ANY($1::uuid[]) THEN er.target_entity_id
          ELSE er.source_entity_id
        END
        WHERE (er.source_entity_id = ANY($1::uuid[]) OR er.target_entity_id = ANY($1::uuid[]))
          AND e.id != ALL($2::uuid[])
        ORDER BY COALESCE(er.interaction_count, 0) DESC
        LIMIT $3
      `, [currentIds, Array.from(visited), options.maxRelated]);

      const hopPenalty = Math.pow(HOP_PENALTY_BASE, hop);
      const newIds: string[] = [];

      for (const rel of relations) {
        if (visited.has(rel.related_id)) continue;
        visited.add(rel.related_id);
        newIds.push(rel.related_id);

        // Get facts for related entity
        const facts: Array<{
          entity_id: string;
          fact_type: string;
          value: string;
          confidence: string;
          created_at: Date;
        }> = await this.dataSource.query(`
          SELECT entity_id, fact_type, value, confidence, created_at
          FROM entity_facts
          WHERE entity_id = $1
            AND valid_until IS NULL
          ORDER BY confidence DESC
          LIMIT 10
        `, [rel.related_id]);

        results.push({
          entityId: rel.related_id,
          entityName: rel.related_name,
          relationType: rel.relation_type,
          hop,
          hopPenalty,
          facts: facts.map(f => ({
            factType: f.fact_type,
            value: f.value,
            confidence: Number(f.confidence) * hopPenalty,
          })),
        });
      }

      currentIds = newIds;
    }

    return { entities: results };
  }

  /**
   * Traverse Activity hierarchy: parent chain + children + KnowledgePacks at each level.
   */
  async traverseActivityHierarchy(activityId: string): Promise<ActivityHierarchyResult> {
    // Parent chain via closure table
    const parents: Array<{ id: string; name: string; activity_type: string; parent_id: string | null }> =
      await this.dataSource.query(`
        SELECT a.id, a.name, a.activity_type, a.parent_id
        FROM activities a
        INNER JOIN activity_closure ac ON ac.id_ancestor = a.id
        WHERE ac.id_descendant = $1
          AND a.id != $1
        ORDER BY ac.id_ancestor
      `, [activityId]);

    // Direct children
    const children: Array<{ id: string; name: string; activity_type: string }> =
      await this.dataSource.query(`
        SELECT id, name, activity_type
        FROM activities
        WHERE parent_id = $1
          AND status = 'active'
        ORDER BY name
      `, [activityId]);

    // KnowledgePacks for this activity + parents
    const allActivityIds = [activityId, ...parents.map(p => p.id)];
    const knowledgePacks = allActivityIds.length > 0
      ? await this.dataSource.query(`
          SELECT id, activity_id, content
          FROM knowledge_packs
          WHERE activity_id = ANY($1::uuid[])
            AND status = 'ACTIVE'
          ORDER BY created_at DESC
        `, [allActivityIds])
      : [];

    return {
      parents: parents.map(p => ({
        id: p.id,
        name: p.name,
        activityType: p.activity_type,
      })),
      children: children.map(c => ({
        id: c.id,
        name: c.name,
        activityType: c.activity_type,
      })),
      knowledgePacks,
    };
  }
}
```

### Step 4: Run test to verify it passes

```bash
cd apps/pkg-core && npx jest --testPathPattern="graph-traversal.service.spec" --no-coverage -- --forceExit
```

Expected: PASS

### Step 5: Commit

```bash
git add apps/pkg-core/src/modules/context/graph-traversal.service.ts apps/pkg-core/src/modules/context/graph-traversal.service.spec.ts
git commit -m "feat(context): add GraphTraversalService

Traverses entity relations (max 2 hops, top 5 per hop) with
hop_penalty=0.8^hop scoring. Traverses Activity hierarchy via
closure table with KnowledgePack collection at each level."
```

### Step 6: Register GraphTraversalService in ContextModule

In `apps/pkg-core/src/modules/context/context.module.ts`:

```typescript
import { GraphTraversalService } from './graph-traversal.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Message, InteractionSummary, EntityRelationshipProfile,
      EntityFact, TranscriptSegment, KnowledgePack,
      Entity, EntityRelation, Activity, // Add these for GraphTraversalService
    ]),
    // ... existing imports
  ],
  providers: [
    ContextService,
    GraphTraversalService, // Add
  ],
  exports: [
    ContextService,
    GraphTraversalService, // Export for other modules
  ],
})
export class ContextModule {}
```

### Step 7: Commit

```bash
git add apps/pkg-core/src/modules/context/context.module.ts
git commit -m "feat(context): register GraphTraversalService in ContextModule"
```

### Step 8: Integrate graph traversal into ContextService

In `apps/pkg-core/src/modules/context/context.service.ts`, inject and use GraphTraversalService:

```typescript
import { GraphTraversalService } from './graph-traversal.service';

constructor(
  // ... existing deps ...
  @Optional()
  private readonly graphTraversal?: GraphTraversalService,
) {}
```

Add a new GRAPH tier to the context building:

```typescript
/**
 * Build graph-aware context for an entity.
 * Adds related entities' facts with hop penalty scoring.
 */
private async buildGraphContext(entityId: string): Promise<string> {
  if (!this.graphTraversal) return '';

  const result = await this.graphTraversal.traverseEntityRelations(entityId, {
    maxHops: 2,
    maxRelated: 5,
  });

  if (result.entities.length === 0) return '';

  const sections = result.entities.map(e => {
    const factsText = e.facts
      .map(f => `  ${f.factType}: ${f.value} [${(f.confidence * 100).toFixed(0)}%]`)
      .join('\n');
    return `${e.entityName} (${e.relationType}, hop ${e.hop}):\n${factsText}`;
  });

  return `\n\n### Связанные сущности (graph traversal)\n${sections.join('\n\n')}`;
}
```

Call this from the main `buildEntityContext()` method:

```typescript
// After KNOWLEDGE tier, before synthesis:
const graphContext = await this.buildGraphContext(entityId);
// Append to synthesis prompt
```

### Step 9: Commit

```bash
git add apps/pkg-core/src/modules/context/context.service.ts
git commit -m "feat(context): integrate graph traversal into entity context

ContextService now includes related entities' facts via 2-hop graph
traversal. Hop penalty (0.8^hop) reduces weight of distant relations.
Max 5 related entities per hop."
```

### Step 10: Add activity hierarchy context

Also in `context.service.ts`, add activity hierarchy traversal:

```typescript
/**
 * Build hierarchical activity context.
 * Shows parent chain and KnowledgePacks at each level.
 */
private async buildActivityHierarchyContext(activityId: string): Promise<string> {
  if (!this.graphTraversal) return '';

  const result = await this.graphTraversal.traverseActivityHierarchy(activityId);

  const parts: string[] = [];

  // Parent chain
  if (result.parents.length > 0) {
    const chain = result.parents
      .map(p => `${p.name} (${p.activityType})`)
      .join(' → ');
    parts.push(`Иерархия: ${chain}`);
  }

  // Children
  if (result.children.length > 0) {
    const childList = result.children
      .map(c => `- ${c.name} (${c.activityType})`)
      .join('\n');
    parts.push(`Подзадачи:\n${childList}`);
  }

  // KnowledgePacks
  for (const kp of result.knowledgePacks) {
    try {
      const content = JSON.parse(kp.content);
      if (content.keyFacts?.length) {
        parts.push(`Знания (${kp.activity_id === activityId ? 'текущий' : 'родитель'}):\n` +
          content.keyFacts.map((f: string) => `- ${f}`).join('\n'));
      }
    } catch { /* skip malformed */ }
  }

  return parts.length > 0
    ? `\n\n### Activity Hierarchy\n${parts.join('\n\n')}`
    : '';
}
```

### Step 11: Commit

```bash
git add apps/pkg-core/src/modules/context/context.service.ts
git commit -m "feat(context): add activity hierarchy context with KnowledgePacks

Shows parent chain, children, and KnowledgePack key facts for the
activity and its ancestors. Provides hierarchical context for
synthesis prompts."
```

---

## Verification

### Task 2a (KnowledgePacks):
```bash
# After Wave 1a deploys and segments are linked, trigger packing:
curl -X POST https://assistant.mityayka.ru/api/v1/segments/run-packing \
  -H "x-api-key: $API_KEY"
# Expected: JSON with packed activities count > 0

# Check created KnowledgePacks:
curl https://assistant.mityayka.ru/api/v1/knowledge-packs?limit=20 \
  -H "x-api-key: $API_KEY"
# Expected: KPs with structured content (keyFacts, decisions, etc.)
```

### Task 2b (Graph Retrieval):
```bash
# Check entity context now includes related entities:
curl https://assistant.mityayka.ru/api/v1/context/entity/{entityId} \
  -H "x-api-key: $API_KEY"
# Expected: Response includes "Связанные сущности" section with hop info

# Check activity context includes hierarchy:
curl https://assistant.mityayka.ru/api/v1/context/activity/{activityId} \
  -H "x-api-key: $API_KEY"
# Expected: Response includes parent chain, children, KnowledgePack facts
```

### All tests:
```bash
cd apps/pkg-core && npx jest --no-coverage -- --forceExit
```

### Integration check:
```bash
# Recall query should now use graph traversal:
curl -X POST https://assistant.mityayka.ru/api/v1/agent/recall \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "что обсуждали с коллегами из Панавто?"}'
# Expected: Answer includes related entities and activity hierarchy context
```
