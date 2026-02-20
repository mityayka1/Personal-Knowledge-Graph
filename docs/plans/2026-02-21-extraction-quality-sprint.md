# Extraction Quality Sprint — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Устранить дубли задач/entities, привязать факты к проектам, очистить существующие дубли через Unified Dedup Gateway с LLM-powered решениями (Claude Haiku).

**Architecture:** Единая точка дедупликации (DeduplicationGatewayService) через которую проходят все extraction paths. Алгоритм: normalize → exact match → embedding cosine (≥0.5, top-5) → LLM decision (Haiku). Без Levenshtein — только семантический matching.

**Tech Stack:** NestJS, TypeORM, pgvector (cosine distance), Claude Agent SDK (mode: 'oneshot', model: 'haiku'), OpenAI text-embedding-3-small (1536 dim)

**Design Doc:** [`docs/plans/2026-02-21-extraction-quality-sprint-design.md`](./2026-02-21-extraction-quality-sprint-design.md)

---

## Task 1: LlmDedupService

LLM-обёртка для принятия решений о дублях. Использует Claude Haiku в oneshot mode с JSON Schema. Паттерн скопирован из `FactDedupReviewService`.

**Files:**
- Create: `apps/pkg-core/src/modules/extraction/llm-dedup.service.ts`
- Test: `apps/pkg-core/src/modules/extraction/__tests__/llm-dedup.service.spec.ts`

### Step 1: Write the failing test

```typescript
// apps/pkg-core/src/modules/extraction/__tests__/llm-dedup.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { LlmDedupService, DedupPair, DedupLlmDecision } from '../llm-dedup.service';
import { ClaudeAgentService } from '../../claude-agent/claude-agent.service';

describe('LlmDedupService', () => {
  let service: LlmDedupService;
  let claudeAgentService: jest.Mocked<ClaudeAgentService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmDedupService,
        {
          provide: ClaudeAgentService,
          useValue: {
            call: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(LlmDedupService);
    claudeAgentService = module.get(ClaudeAgentService);
  });

  describe('decideDuplicate', () => {
    it('should return isDuplicate=true with high confidence for obvious duplicate', async () => {
      claudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [{
            pairIndex: 0,
            isDuplicate: true,
            confidence: 0.95,
            reason: 'Same person, different name format',
          }],
        },
        usage: { input_tokens: 100, output_tokens: 50 },
        turns: 1,
        toolsUsed: [],
      });

      const result = await service.decideDuplicate({
        newItem: { type: 'entity', name: 'Пирекеева М.', description: 'person' },
        existingItem: { id: 'uuid-1', type: 'entity', name: 'Пирекеева Мария', description: 'person, telegram_id=123' },
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(claudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'oneshot',
          model: 'haiku',
        }),
      );
    });

    it('should return isDuplicate=false for different items', async () => {
      claudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [{
            pairIndex: 0,
            isDuplicate: false,
            confidence: 0.1,
            reason: 'Different people',
          }],
        },
        usage: { input_tokens: 100, output_tokens: 50 },
        turns: 1,
        toolsUsed: [],
      });

      const result = await service.decideDuplicate({
        newItem: { type: 'entity', name: 'Иван Петров' },
        existingItem: { id: 'uuid-2', type: 'entity', name: 'Мария Сидорова' },
      });

      expect(result.isDuplicate).toBe(false);
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('decideBatch', () => {
    it('should process multiple pairs in single LLM call', async () => {
      claudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            { pairIndex: 0, isDuplicate: true, confidence: 0.95, reason: 'Same task' },
            { pairIndex: 1, isDuplicate: false, confidence: 0.2, reason: 'Different tasks' },
          ],
        },
        usage: { input_tokens: 200, output_tokens: 100 },
        turns: 1,
        toolsUsed: [],
      });

      const pairs: DedupPair[] = [
        {
          newItem: { type: 'task', name: 'Настроить CI/CD' },
          existingItem: { id: 'a', type: 'task', name: 'Настройка CI/CD пайплайна' },
        },
        {
          newItem: { type: 'task', name: 'Купить молоко' },
          existingItem: { id: 'b', type: 'task', name: 'Написать отчёт' },
        },
      ];

      const results = await service.decideBatch(pairs);

      expect(results).toHaveLength(2);
      expect(results[0].isDuplicate).toBe(true);
      expect(results[1].isDuplicate).toBe(false);
      expect(claudeAgentService.call).toHaveBeenCalledTimes(1); // single batch call
    });
  });

  describe('graceful degradation', () => {
    it('should return isDuplicate=false when LLM fails', async () => {
      claudeAgentService.call.mockRejectedValue(new Error('LLM unavailable'));

      const result = await service.decideDuplicate({
        newItem: { type: 'entity', name: 'Test' },
        existingItem: { id: 'x', type: 'entity', name: 'Test Entity' },
      });

      expect(result.isDuplicate).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain('LLM');
    });
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/modules/extraction/__tests__/llm-dedup.service.spec.ts --no-coverage`
Expected: FAIL — module `../llm-dedup.service` not found

### Step 3: Write minimal implementation

```typescript
// apps/pkg-core/src/modules/extraction/llm-dedup.service.ts
import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

// ─── Interfaces ──────────────────────────────────────────────────────

export interface DedupItemInfo {
  type: string;        // 'entity' | 'task' | 'commitment' | 'fact'
  name: string;        // Name or title
  description?: string; // Additional context
  context?: string;    // Activity context, chat context
}

export interface DedupExistingItem extends DedupItemInfo {
  id: string;          // UUID of existing item
}

export interface DedupPair {
  newItem: DedupItemInfo;
  existingItem: DedupExistingItem;
  activityContext?: string; // "В рамках проекта Панавто..."
}

export interface DedupLlmDecision {
  isDuplicate: boolean;
  confidence: number;   // 0..1
  mergeIntoId?: string; // ID existing item to merge into (when isDuplicate)
  reason: string;
}

// ─── JSON Schema ─────────────────────────────────────────────────────

const DEDUP_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pairIndex: { type: 'number', description: 'Index of the pair from the input list' },
          isDuplicate: { type: 'boolean', description: 'true if items refer to the same thing' },
          confidence: { type: 'number', description: 'Confidence 0.0 to 1.0' },
          reason: { type: 'string', description: 'Short explanation in Russian' },
        },
        required: ['pairIndex', 'isDuplicate', 'confidence', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

interface LlmResponse {
  decisions: Array<{
    pairIndex: number;
    isDuplicate: boolean;
    confidence: number;
    reason: string;
  }>;
}

// ─── Service ─────────────────────────────────────────────────────────

@Injectable()
export class LlmDedupService {
  private readonly logger = new Logger(LlmDedupService.name);

  constructor(
    @Optional()
    @Inject(forwardRef(() => ClaudeAgentService))
    private readonly claudeAgentService: ClaudeAgentService | null,
  ) {}

  /**
   * Decide if a single new item is a duplicate of an existing item.
   */
  async decideDuplicate(pair: DedupPair): Promise<DedupLlmDecision> {
    const results = await this.decideBatch([pair]);
    return results[0];
  }

  /**
   * Decide duplicates for a batch of pairs in a single LLM call.
   * Graceful degradation: returns isDuplicate=false for all on failure.
   */
  async decideBatch(pairs: DedupPair[]): Promise<DedupLlmDecision[]> {
    if (pairs.length === 0) return [];

    if (!this.claudeAgentService) {
      this.logger.warn('ClaudeAgentService unavailable, allowing all as non-duplicates');
      return pairs.map((p) => ({
        isDuplicate: false,
        confidence: 0,
        reason: 'LLM unavailable, allowing creation',
      }));
    }

    try {
      const prompt = this.buildPrompt(pairs);

      const { data } = await this.claudeAgentService.call<LlmResponse>({
        mode: 'oneshot',
        taskType: 'dedup_decision',
        prompt,
        schema: DEDUP_DECISION_SCHEMA,
        model: 'haiku',
      });

      return this.mapDecisions(pairs, data);
    } catch (error: any) {
      this.logger.error(`LLM dedup batch failed: ${error.message}`, error.stack);
      return pairs.map(() => ({
        isDuplicate: false,
        confidence: 0,
        reason: `LLM dedup failed: ${error.message}`,
      }));
    }
  }

  private mapDecisions(pairs: DedupPair[], data: LlmResponse): DedupLlmDecision[] {
    return pairs.map((pair, index) => {
      const llmDecision = data.decisions?.find((d) => d.pairIndex === index);
      if (!llmDecision) {
        this.logger.warn(`LLM did not return decision for pair index=${index}`);
        return { isDuplicate: false, confidence: 0, reason: 'No LLM decision returned' };
      }
      return {
        isDuplicate: llmDecision.isDuplicate,
        confidence: llmDecision.confidence,
        mergeIntoId: llmDecision.isDuplicate ? pair.existingItem.id : undefined,
        reason: llmDecision.reason,
      };
    });
  }

  private buildPrompt(pairs: DedupPair[]): string {
    const pairsBlock = pairs.map((p, i) => {
      let block = `## Пара #${i}\n`;
      block += `**Новый элемент:** [${p.newItem.type}] "${p.newItem.name}"`;
      if (p.newItem.description) block += ` — ${p.newItem.description}`;
      block += `\n**Существующий элемент:** [${p.existingItem.type}] "${p.existingItem.name}" (id: ${p.existingItem.id})`;
      if (p.existingItem.description) block += ` — ${p.existingItem.description}`;
      if (p.activityContext) block += `\n**Контекст:** ${p.activityContext}`;
      return block;
    }).join('\n\n');

    return `Ты эксперт по дедупликации данных. Определи, являются ли элементы в каждой паре дубликатами (описывают одно и то же).

${pairsBlock}

## Правила:
- Дубликат = одна и та же сущность/задача/факт, выраженная разными словами
- "Пирекеева" и "Пирекеева Мария" — ДУБЛИКАТ (одно имя, неполное vs полное)
- "Настроить CI/CD" и "Настройка CI/CD пайплайна" — ДУБЛИКАТ (одна задача)
- "Сделать интеграцию с Авито" и "Подключить Авито к Битриксу" — ДУБЛИКАТ (одна задача в контексте проекта)
- "Позвонить Маше" и "Написать отчёт" — НЕ ДУБЛИКАТ
- "Игорь (person)" и "ИИ-Сервисы (organization)" — НЕ ДУБЛИКАТ (разные типы)

Верни решение для КАЖДОЙ пары. confidence: 0.0-1.0 (1.0 = точно дубликат).`;
  }
}
```

### Step 4: Run test to verify it passes

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/modules/extraction/__tests__/llm-dedup.service.spec.ts --no-coverage`
Expected: PASS (3 tests)

### Step 5: Commit

```bash
git add apps/pkg-core/src/modules/extraction/llm-dedup.service.ts apps/pkg-core/src/modules/extraction/__tests__/llm-dedup.service.spec.ts
git commit -m "feat(extraction): add LlmDedupService for semantic duplicate detection via Claude Haiku"
```

---

## Task 2: DeduplicationGatewayService

Единая точка входа для дедупликации: normalize → exact match → embedding → LLM decision. Заменяет все Levenshtein-based проверки.

**Files:**
- Create: `apps/pkg-core/src/modules/extraction/dedup-gateway.service.ts`
- Test: `apps/pkg-core/src/modules/extraction/__tests__/dedup-gateway.service.spec.ts`

### Step 1: Write the failing test

```typescript
// apps/pkg-core/src/modules/extraction/__tests__/dedup-gateway.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType, ActivityStatus, EntityRecord } from '@pkg/entities';
import { DeduplicationGatewayService, DedupDecision, DedupAction } from '../dedup-gateway.service';
import { LlmDedupService } from '../llm-dedup.service';
import { EmbeddingService } from '../../embedding/embedding.service';
import { ProjectMatchingService } from '../project-matching.service';

describe('DeduplicationGatewayService', () => {
  let service: DeduplicationGatewayService;
  let llmDedupService: jest.Mocked<LlmDedupService>;
  let embeddingService: jest.Mocked<EmbeddingService>;
  let activityRepo: jest.Mocked<Repository<Activity>>;
  let entityRepo: jest.Mocked<Repository<EntityRecord>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeduplicationGatewayService,
        {
          provide: LlmDedupService,
          useValue: { decideDuplicate: jest.fn(), decideBatch: jest.fn() },
        },
        {
          provide: EmbeddingService,
          useValue: { generate: jest.fn() },
        },
        {
          provide: ProjectMatchingService,
          useValue: { normalizeName: ProjectMatchingService.normalizeName },
        },
        {
          provide: getRepositoryToken(Activity),
          useValue: { createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: { createQueryBuilder: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(DeduplicationGatewayService);
    llmDedupService = module.get(LlmDedupService);
    embeddingService = module.get(EmbeddingService);
    activityRepo = module.get(getRepositoryToken(Activity));
    entityRepo = module.get(getRepositoryToken(EntityRecord));
  });

  describe('checkTask', () => {
    it('should return CREATE when no similar tasks exist', async () => {
      embeddingService.generate.mockResolvedValue(new Array(1536).fill(0));
      // Mock: pgvector returns no candidates
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      activityRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await service.checkTask({
        name: 'Купить молоко',
        ownerEntityId: 'owner-1',
      });

      expect(result.action).toBe(DedupAction.CREATE);
    });

    it('should return MERGE for exact name match', async () => {
      // Mock: exact match found
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'task-1', name: 'Купить молоко' }),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      activityRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await service.checkTask({
        name: 'Купить молоко',
        ownerEntityId: 'owner-1',
      });

      expect(result.action).toBe(DedupAction.MERGE);
      expect(result.existingId).toBe('task-1');
    });

    it('should call LLM for semantic candidates and return PENDING_APPROVAL', async () => {
      embeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));
      // Mock: pgvector returns similar candidate
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null), // no exact match
        getRawMany: jest.fn().mockResolvedValue([
          { id: 'task-2', name: 'Настройка CI/CD', similarity: 0.82 },
        ]),
      };
      activityRepo.createQueryBuilder.mockReturnValue(qb as any);

      llmDedupService.decideDuplicate.mockResolvedValue({
        isDuplicate: true,
        confidence: 0.85,
        mergeIntoId: 'task-2',
        reason: 'Same task, different phrasing',
      });

      const result = await service.checkTask({
        name: 'Настроить CI/CD пайплайн',
        ownerEntityId: 'owner-1',
      });

      // 0.85 confidence → PENDING_APPROVAL (between 0.7 and 0.9)
      expect(result.action).toBe(DedupAction.PENDING_APPROVAL);
      expect(result.existingId).toBe('task-2');
    });
  });

  describe('checkEntity', () => {
    it('should return MERGE for exact name match (normalized)', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'entity-1', name: 'Пирекеева Мария', type: 'person' }),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      entityRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await service.checkEntity({
        name: 'пирекеева мария',
        type: 'person',
      });

      expect(result.action).toBe(DedupAction.MERGE);
      expect(result.existingId).toBe('entity-1');
    });
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/modules/extraction/__tests__/dedup-gateway.service.spec.ts --no-coverage`
Expected: FAIL — module `../dedup-gateway.service` not found

### Step 3: Write minimal implementation

```typescript
// apps/pkg-core/src/modules/extraction/dedup-gateway.service.ts
import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType, ActivityStatus, EntityRecord } from '@pkg/entities';
import { LlmDedupService } from './llm-dedup.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { ProjectMatchingService } from './project-matching.service';

// ─── Interfaces ──────────────────────────────────────────────────────

export enum DedupAction {
  CREATE = 'create',
  MERGE = 'merge',
  PENDING_APPROVAL = 'pending_approval',
}

export interface DedupDecision {
  action: DedupAction;
  existingId?: string;    // ID of existing item to merge into
  confidence: number;     // LLM confidence (0..1)
  reason: string;
}

export interface TaskCandidate {
  name: string;
  ownerEntityId: string;
  description?: string;
  projectName?: string;
}

export interface EntityCandidate {
  name: string;
  type: string; // 'person' | 'organization'
  context?: string;
}

export interface CommitmentCandidate {
  what: string;
  entityId?: string;
  activityContext?: string;
}

// ─── Constants ───────────────────────────────────────────────────────

const COSINE_THRESHOLD = 0.5;
const TOP_K = 5;
const AUTO_MERGE_CONFIDENCE = 0.9;
const APPROVAL_CONFIDENCE = 0.7;

// ─── Service ─────────────────────────────────────────────────────────

@Injectable()
export class DeduplicationGatewayService {
  private readonly logger = new Logger(DeduplicationGatewayService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
    private readonly llmDedupService: LlmDedupService,
    @Optional()
    @Inject(forwardRef(() => EmbeddingService))
    private readonly embeddingService: EmbeddingService | null,
    private readonly projectMatchingService: ProjectMatchingService,
  ) {}

  /**
   * Check if a task candidate is a duplicate.
   * Pipeline: normalize → exact match → embedding top-5 → LLM → decision
   */
  async checkTask(candidate: TaskCandidate): Promise<DedupDecision> {
    const normalized = ProjectMatchingService.normalizeName(candidate.name);

    // 1. Exact match (normalized name)
    const exactMatch = await this.findExactTask(normalized, candidate.ownerEntityId);
    if (exactMatch) {
      this.logger.log(`Exact task match: "${candidate.name}" → "${exactMatch.name}" (${exactMatch.id})`);
      return { action: DedupAction.MERGE, existingId: exactMatch.id, confidence: 1.0, reason: 'Exact name match' };
    }

    // 2. Embedding similarity (pgvector cosine)
    if (!this.embeddingService) {
      return { action: DedupAction.CREATE, confidence: 0, reason: 'Embedding service unavailable' };
    }

    const embedding = await this.embeddingService.generate(candidate.name);
    const semanticCandidates = await this.findSimilarTasks(embedding, candidate.ownerEntityId);

    if (semanticCandidates.length === 0) {
      return { action: DedupAction.CREATE, confidence: 0, reason: 'No semantic candidates found' };
    }

    // 3. LLM decision for top candidate
    const topCandidate = semanticCandidates[0];
    const llmDecision = await this.llmDedupService.decideDuplicate({
      newItem: { type: 'task', name: candidate.name, description: candidate.description },
      existingItem: { id: topCandidate.id, type: 'task', name: topCandidate.name },
      activityContext: candidate.projectName ? `Проект: ${candidate.projectName}` : undefined,
    });

    if (!llmDecision.isDuplicate) {
      return { action: DedupAction.CREATE, confidence: llmDecision.confidence, reason: llmDecision.reason };
    }

    // 4. Route by confidence
    return this.routeByConfidence(llmDecision.confidence, topCandidate.id, llmDecision.reason);
  }

  /**
   * Check if an entity candidate is a duplicate.
   */
  async checkEntity(candidate: EntityCandidate): Promise<DedupDecision> {
    const normalized = ProjectMatchingService.normalizeName(candidate.name);

    // 1. Exact match
    const exactMatch = await this.findExactEntity(normalized, candidate.type);
    if (exactMatch) {
      this.logger.log(`Exact entity match: "${candidate.name}" → "${exactMatch.name}" (${exactMatch.id})`);
      return { action: DedupAction.MERGE, existingId: exactMatch.id, confidence: 1.0, reason: 'Exact name match' };
    }

    // 2. Embedding similarity
    if (!this.embeddingService) {
      return { action: DedupAction.CREATE, confidence: 0, reason: 'Embedding service unavailable' };
    }

    const embedding = await this.embeddingService.generate(candidate.name);
    const semanticCandidates = await this.findSimilarEntities(embedding, candidate.type);

    if (semanticCandidates.length === 0) {
      return { action: DedupAction.CREATE, confidence: 0, reason: 'No semantic candidates found' };
    }

    // 3. LLM decision
    const topCandidate = semanticCandidates[0];
    const llmDecision = await this.llmDedupService.decideDuplicate({
      newItem: { type: 'entity', name: candidate.name, description: candidate.type },
      existingItem: { id: topCandidate.id, type: 'entity', name: topCandidate.name, description: topCandidate.type },
      activityContext: candidate.context,
    });

    if (!llmDecision.isDuplicate) {
      return { action: DedupAction.CREATE, confidence: llmDecision.confidence, reason: llmDecision.reason };
    }

    return this.routeByConfidence(llmDecision.confidence, topCandidate.id, llmDecision.reason);
  }

  /**
   * Check if a commitment candidate is a duplicate.
   */
  async checkCommitment(candidate: CommitmentCandidate): Promise<DedupDecision> {
    // Commitments use name-based matching via activity repo (type=TASK or commitment table)
    // For now, delegate to task dedup logic since commitments map to Activity
    return this.checkTask({
      name: candidate.what,
      ownerEntityId: candidate.entityId || '',
      description: candidate.activityContext,
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private routeByConfidence(confidence: number, existingId: string, reason: string): DedupDecision {
    if (confidence >= AUTO_MERGE_CONFIDENCE) {
      return { action: DedupAction.MERGE, existingId, confidence, reason };
    }
    if (confidence >= APPROVAL_CONFIDENCE) {
      return { action: DedupAction.PENDING_APPROVAL, existingId, confidence, reason };
    }
    return { action: DedupAction.CREATE, confidence, reason };
  }

  private async findExactTask(normalizedName: string, ownerEntityId: string): Promise<Activity | null> {
    return this.activityRepo
      .createQueryBuilder('a')
      .where('LOWER(a.name) = LOWER(:name)', { name: normalizedName })
      .andWhere('a.ownerEntityId = :ownerId', { ownerId: ownerEntityId })
      .andWhere('a.activityType = :type', { type: ActivityType.TASK })
      .andWhere('a.status != :cancelled', { cancelled: ActivityStatus.CANCELLED })
      .getOne();
  }

  private async findSimilarTasks(
    embedding: number[],
    ownerEntityId: string,
  ): Promise<Array<{ id: string; name: string; similarity: number }>> {
    return this.activityRepo
      .createQueryBuilder('a')
      .select('a.id', 'id')
      .addSelect('a.name', 'name')
      .addSelect(`1 - (a.embedding <=> :embedding::vector)`, 'similarity')
      .where('a.ownerEntityId = :ownerId', { ownerId: ownerEntityId })
      .andWhere('a.activityType = :type', { type: ActivityType.TASK })
      .andWhere('a.status != :cancelled', { cancelled: ActivityStatus.CANCELLED })
      .andWhere('a.embedding IS NOT NULL')
      .andWhere(`1 - (a.embedding <=> :embedding::vector) >= :threshold`)
      .orderBy('similarity', 'DESC')
      .limit(TOP_K)
      .setParameter('embedding', `[${embedding.join(',')}]`)
      .setParameter('threshold', COSINE_THRESHOLD)
      .getRawMany();
  }

  private async findExactEntity(normalizedName: string, type: string): Promise<EntityRecord | null> {
    return this.entityRepo
      .createQueryBuilder('e')
      .where('LOWER(e.name) = LOWER(:name)', { name: normalizedName })
      .andWhere('e.type = :type', { type })
      .getOne();
  }

  private async findSimilarEntities(
    embedding: number[],
    type: string,
  ): Promise<Array<{ id: string; name: string; type: string; similarity: number }>> {
    return this.entityRepo
      .createQueryBuilder('e')
      .select('e.id', 'id')
      .addSelect('e.name', 'name')
      .addSelect('e.type', 'type')
      .addSelect(`1 - (e.embedding <=> :embedding::vector)`, 'similarity')
      .where('e.type = :type', { type })
      .andWhere('e.embedding IS NOT NULL')
      .andWhere(`1 - (e.embedding <=> :embedding::vector) >= :threshold`)
      .orderBy('similarity', 'DESC')
      .limit(TOP_K)
      .setParameter('embedding', `[${embedding.join(',')}]`)
      .setParameter('threshold', COSINE_THRESHOLD)
      .getRawMany();
  }
}
```

### Step 4: Run test to verify it passes

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/modules/extraction/__tests__/dedup-gateway.service.spec.ts --no-coverage`
Expected: PASS (4 tests)

### Step 5: Register in ExtractionModule

Modify: `apps/pkg-core/src/modules/extraction/extraction.module.ts`

Add imports:
```typescript
import { LlmDedupService } from './llm-dedup.service';
import { DeduplicationGatewayService } from './dedup-gateway.service';
```

Add to `providers` array:
```typescript
LlmDedupService,
DeduplicationGatewayService,
```

Add to `exports` array:
```typescript
LlmDedupService,
DeduplicationGatewayService,
```

### Step 6: Run full module compilation check

Run: `cd /Users/mityayka/work/projects/PKG && npx tsc --noEmit --project apps/pkg-core/tsconfig.app.json 2>&1 | head -30`
Expected: No errors (or only pre-existing ones)

### Step 7: Commit

```bash
git add apps/pkg-core/src/modules/extraction/dedup-gateway.service.ts apps/pkg-core/src/modules/extraction/__tests__/dedup-gateway.service.spec.ts apps/pkg-core/src/modules/extraction/extraction.module.ts
git commit -m "feat(extraction): add DeduplicationGatewayService with embedding+LLM pipeline"
```

---

## Task 3: Integrate Gateway into DraftExtractionService (tasks + commitments)

Заменить `findExistingTaskEnhanced()` (Levenshtein) и `findExistingCommitmentEnhanced()` на вызовы через gateway.

**Files:**
- Modify: `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts:148-183` (constructor — add DeduplicationGatewayService)
- Modify: `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts:466-498` (task dedup section — use gateway)
- Modify: `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts:1528-1587` (findExistingTaskEnhanced — can keep as fallback)

### Step 1: Add gateway to DraftExtractionService constructor

In `draft-extraction.service.ts`, add to constructor after line 182:

```typescript
@Optional()
@Inject(forwardRef(() => DeduplicationGatewayService))
private readonly dedupGateway: DeduplicationGatewayService | null,
```

Add import at top:
```typescript
import { DeduplicationGatewayService, DedupAction } from './dedup-gateway.service';
```

### Step 2: Replace task dedup logic

In the task creation loop (~line 480), replace:
```typescript
const existingTask = await this.findExistingTaskEnhanced(
  task.title,
  input.ownerEntityId,
);
if (existingTask.found) {
```

With:
```typescript
// Use DeduplicationGateway if available, fallback to legacy
let taskDuplicate = false;
let taskExistingId: string | undefined;
let taskParentId: string | null | undefined;

if (this.dedupGateway) {
  const dedupResult = await this.dedupGateway.checkTask({
    name: task.title,
    ownerEntityId: input.ownerEntityId,
    description: task.description,
    projectName: task.projectName,
  });

  if (dedupResult.action === DedupAction.MERGE) {
    taskDuplicate = true;
    taskExistingId = dedupResult.existingId;
    this.logger.debug(
      `Gateway: skip duplicate task "${task.title}" → ${dedupResult.existingId} (confidence: ${dedupResult.confidence.toFixed(2)})`,
    );
  } else if (dedupResult.action === DedupAction.PENDING_APPROVAL) {
    // Grey zone — still create but mark as potential duplicate in context
    this.logger.log(
      `Gateway: potential duplicate task "${task.title}" → ${dedupResult.existingId} (confidence: ${dedupResult.confidence.toFixed(2)}), creating with approval`,
    );
  }
} else {
  // Legacy fallback
  const existingTask = await this.findExistingTaskEnhanced(task.title, input.ownerEntityId);
  if (existingTask.found) {
    taskDuplicate = true;
    taskExistingId = existingTask.activityId;
    taskParentId = existingTask.parentId;
  }
}

if (taskDuplicate) {
```

### Step 3: Apply same pattern to commitment dedup

In the commitment creation loop, replace `findExistingCommitmentEnhanced()` call with gateway:

```typescript
if (this.dedupGateway) {
  const dedupResult = await this.dedupGateway.checkCommitment({
    what: commitment.what,
    entityId: input.ownerEntityId,
    activityContext: commitment.projectName,
  });
  if (dedupResult.action === DedupAction.MERGE) {
    // skip duplicate commitment
    result.skipped.commitments++;
    continue;
  }
} else {
  // Legacy fallback
  const existingCommitment = await this.findExistingCommitmentEnhanced(commitment.what, input.ownerEntityId);
  if (existingCommitment.found) {
    result.skipped.commitments++;
    continue;
  }
}
```

### Step 4: Run existing tests

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/modules/extraction/__tests__/draft-extraction --no-coverage`
Expected: PASS (existing tests should still pass — gateway is @Optional)

### Step 5: Commit

```bash
git add apps/pkg-core/src/modules/extraction/draft-extraction.service.ts
git commit -m "feat(extraction): integrate DeduplicationGateway into DraftExtractionService for tasks and commitments"
```

---

## Task 4: Integrate Gateway into Entity creation paths

Заменить прямое создание Entity в `SecondBrainExtractionService.createExtractedEntity()` и `ExtractionToolsProvider.create_pending_entity` на gateway.

**Files:**
- Modify: `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts:526-548`
- Modify: `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts:819-912`

### Step 1: Modify SecondBrainExtractionService.createExtractedEntity

Replace the method body (lines 526-548) to use gateway:

```typescript
private async createExtractedEntity(
  name: string,
  relatedToEntityId: string,
): Promise<string> {
  if (!this.entityService) {
    throw new Error(`EntityService not available, cannot create extracted entity for "${name}"`);
  }

  // Use gateway for semantic dedup if available
  if (this.dedupGateway) {
    const decision = await this.dedupGateway.checkEntity({
      name,
      type: 'person',
      context: `Упомянут в контексте entity ${relatedToEntityId}`,
    });

    if (decision.action === DedupAction.MERGE && decision.existingId) {
      this.logger.log(
        `Gateway matched entity "${name}" → existing ${decision.existingId} (confidence: ${decision.confidence.toFixed(2)})`,
      );
      return decision.existingId;
    }
  }

  const entity = await this.entityService.create({
    type: EntityType.PERSON,
    name,
    creationSource: CreationSource.EXTRACTED,
    notes: `Автоматически создан из извлечения. Упомянут в контексте entity ${relatedToEntityId}`,
  });

  this.logger.log(`Created extracted entity "${name}" (${entity.id}) related to ${relatedToEntityId}`);
  return entity.id;
}
```

Add to constructor:
```typescript
@Optional()
@Inject(forwardRef(() => DeduplicationGatewayService))
private readonly dedupGateway: DeduplicationGatewayService | null,
```

Add imports:
```typescript
import { DeduplicationGatewayService, DedupAction } from './dedup-gateway.service';
```

### Step 2: Modify ExtractionToolsProvider.create_pending_entity

In `extraction-tools.provider.ts`, modify the `createPendingEntityTool` handler (lines 831-911).

After the telegram username check (line 865), before creating PendingEntityResolution, add gateway check:

```typescript
// Check for semantic duplicate via gateway
if (this.dedupGateway) {
  const decision = await this.dedupGateway.checkEntity({
    name: args.suggestedName,
    type: 'person',
    context: args.mentionedAs,
  });

  if (decision.action === DedupAction.MERGE && decision.existingId) {
    this.logger.log(
      `Gateway: entity "${args.suggestedName}" matches existing ${decision.existingId} (confidence: ${decision.confidence.toFixed(2)})`,
    );
    return toolSuccess({
      entityId: decision.existingId,
      suggestedName: args.suggestedName,
      status: 'matched_existing',
      message: `Entity matched via semantic dedup (confidence: ${decision.confidence.toFixed(2)}). Use this entityId.`,
    });
  }
}
```

Add `dedupGateway` to the provider's constructor with `@Optional()` and `forwardRef`.

### Step 3: Run type check

Run: `cd /Users/mityayka/work/projects/PKG && npx tsc --noEmit --project apps/pkg-core/tsconfig.app.json 2>&1 | head -30`
Expected: No type errors

### Step 4: Commit

```bash
git add apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts
git commit -m "feat(extraction): integrate DeduplicationGateway into entity creation paths"
```

---

## Task 5: Fix create_fact — add activityId param + route through DraftExtractionService (#4 + #6)

Проблемы #4 (факты без контекста проектов) и #6 (create_fact минует approval).

**Files:**
- Modify: `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts:431-458` (create_fact schema)

### Step 1: Add activityId parameter to create_fact tool schema

In `extraction-tools.provider.ts`, add to the create_fact schema (after line 453, before `category`):

```typescript
activityId: z
  .string()
  .uuid()
  .optional()
  .describe('UUID активности/проекта, к которому относится факт. Используй find_activity для поиска.'),
```

### Step 2: Update create_fact system prompt guidance

In the tool description (line 434), append:

```
ВАЖНО: Если факт связан с конкретным проектом или делом — укажи activityId. Используй find_activity для поиска проекта.`
```

### Step 3: Pass activityId through to DraftExtractionService

In the create_fact handler (around line 459), when constructing the `DraftExtractionInput`, add the `sourceInteractionId` from context.interactionId (already done) and the activityId to metadata if provided. The `DraftExtractionInput.facts` should include the activityId:

Modify the `ExtractedFact` object construction to include `activityId` from args:

```typescript
const factInput: ExtractedFact = {
  entityId: args.entityId,
  factType: factType,
  value: factValue,
  confidence: args.confidence,
  sourceQuote: args.sourceQuote,
  category: args.category || 'professional',
  activityId: args.activityId, // NEW: link fact to activity
};
```

Note: The `ExtractedFact` type in `daily-synthesis-extraction.types.ts` may need `activityId?: string` field added.

### Step 4: Run type check

Run: `cd /Users/mityayka/work/projects/PKG && npx tsc --noEmit --project apps/pkg-core/tsconfig.app.json 2>&1 | head -30`
Expected: Pass

### Step 5: Commit

```bash
git add apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.types.ts
git commit -m "feat(extraction): add activityId param to create_fact tool for project context linking"
```

---

## Task 6: Replace substring matching in DailySynthesis (#5)

Заменить `matchProjectsToActivities()` на использование gateway с семантическим matching.

**Files:**
- Modify: `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.service.ts:528-563`

### Step 1: Add gateway to DailySynthesisExtractionService constructor

Add:
```typescript
@Optional()
@Inject(forwardRef(() => DeduplicationGatewayService))
private readonly dedupGateway: DeduplicationGatewayService | null,
```

### Step 2: Enhance matchProjectsToActivities

Replace the method to use gateway when available:

```typescript
private async matchProjectsToActivities(
  projects: DailySynthesisExtractionResponse['projects'],
  existingActivities: Activity[],
): Promise<DailySynthesisExtractionResponse['projects']> {
  const results: DailySynthesisExtractionResponse['projects'] = [];

  for (const project of projects) {
    if (project.existingActivityId) {
      results.push(project);
      continue;
    }

    // Try gateway (embedding + LLM) if available
    if (this.dedupGateway) {
      const decision = await this.dedupGateway.checkTask({
        name: project.name,
        ownerEntityId: '', // daily synthesis doesn't have a single owner
        description: project.description,
      });

      if (decision.action !== DedupAction.CREATE && decision.existingId) {
        this.logger.debug(
          `[daily-extraction] Gateway matched project "${project.name}" → ${decision.existingId} (confidence: ${decision.confidence.toFixed(2)})`,
        );
        results.push({
          ...project,
          isNew: false,
          existingActivityId: decision.existingId,
        });
        continue;
      }
    }

    // Fallback: ProjectMatchingService (Levenshtein)
    const match = this.projectMatchingService.findBestMatchInList(
      project.name,
      existingActivities,
    );

    if (match && match.similarity >= DailySynthesisExtractionService.MATCH_THRESHOLD) {
      this.logger.debug(
        `[daily-extraction] Fallback matched project "${project.name}" → "${match.activity.name}" (similarity: ${match.similarity.toFixed(3)})`,
      );
      results.push({
        ...project,
        isNew: false,
        existingActivityId: match.activity.id,
      });
    } else {
      results.push(project);
    }
  }

  return results;
}
```

### Step 3: Run type check + existing tests

Run: `cd /Users/mityayka/work/projects/PKG && npx tsc --noEmit --project apps/pkg-core/tsconfig.app.json 2>&1 | head -20`
Expected: Pass

### Step 4: Commit

```bash
git add apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.service.ts
git commit -m "feat(extraction): use DeduplicationGateway in DailySynthesis for semantic project matching"
```

---

## Task 7: DedupBatchCleanupJob (daily cron)

Ежедневный cron для поиска и очистки существующих дублей.

**Files:**
- Create: `apps/pkg-core/src/modules/extraction/dedup-batch-cleanup.job.ts`
- Test: `apps/pkg-core/src/modules/extraction/__tests__/dedup-batch-cleanup.job.spec.ts`
- Modify: `apps/pkg-core/src/modules/extraction/extraction.module.ts` (register)

### Step 1: Write the failing test

```typescript
// apps/pkg-core/src/modules/extraction/__tests__/dedup-batch-cleanup.job.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Activity, EntityRecord } from '@pkg/entities';
import { DedupBatchCleanupJob } from '../dedup-batch-cleanup.job';
import { LlmDedupService } from '../llm-dedup.service';
import { EmbeddingService } from '../../embedding/embedding.service';
import { DataQualityService } from '../../data-quality/data-quality.service';
import { SchedulerRegistry } from '@nestjs/schedule';

describe('DedupBatchCleanupJob', () => {
  let job: DedupBatchCleanupJob;
  let llmDedupService: jest.Mocked<LlmDedupService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupBatchCleanupJob,
        {
          provide: LlmDedupService,
          useValue: { decideBatch: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: EmbeddingService,
          useValue: { generate: jest.fn() },
        },
        {
          provide: DataQualityService,
          useValue: { autoMerge: jest.fn() },
        },
        {
          provide: getRepositoryToken(Activity),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getRawMany: jest.fn().mockResolvedValue([]),
          }) },
        },
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getRawMany: jest.fn().mockResolvedValue([]),
          }) },
        },
        {
          provide: SchedulerRegistry,
          useValue: {},
        },
      ],
    }).compile();

    job = module.get(DedupBatchCleanupJob);
    llmDedupService = module.get(LlmDedupService);
  });

  it('should be defined', () => {
    expect(job).toBeDefined();
  });

  it('should run without errors when no duplicates found', async () => {
    await expect(job.run()).resolves.not.toThrow();
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/modules/extraction/__tests__/dedup-batch-cleanup.job.spec.ts --no-coverage`
Expected: FAIL — module not found

### Step 3: Write implementation

```typescript
// apps/pkg-core/src/modules/extraction/dedup-batch-cleanup.job.ts
import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, EntityRecord } from '@pkg/entities';
import { LlmDedupService, DedupPair } from './llm-dedup.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { DataQualityService } from '../data-quality/data-quality.service';

const BATCH_COSINE_THRESHOLD = 0.6;
const AUTO_MERGE_CONFIDENCE = 0.9;

@Injectable()
export class DedupBatchCleanupJob {
  private readonly logger = new Logger(DedupBatchCleanupJob.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
    private readonly llmDedupService: LlmDedupService,
    @Optional()
    @Inject(forwardRef(() => EmbeddingService))
    private readonly embeddingService: EmbeddingService | null,
    @Optional()
    @Inject(forwardRef(() => DataQualityService))
    private readonly dataQualityService: DataQualityService | null,
  ) {}

  /**
   * Daily cron at 3:00 AM — find and clean up existing duplicates.
   */
  @Cron('0 3 * * *')
  async run(): Promise<void> {
    this.logger.log('Starting daily dedup batch cleanup...');

    try {
      const entityResults = await this.cleanupEntityDuplicates();
      const taskResults = await this.cleanupTaskDuplicates();

      this.logger.log(
        `Daily dedup cleanup complete: entities merged=${entityResults.merged}, ` +
        `tasks merged=${taskResults.merged}`,
      );
    } catch (error: any) {
      this.logger.error(`Daily dedup cleanup failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Find entity pairs with high embedding similarity, run through LLM, auto-merge.
   */
  private async cleanupEntityDuplicates(): Promise<{ merged: number }> {
    // Find entity pairs with cosine similarity >= 0.6
    const pairs = await this.entityRepo
      .createQueryBuilder('a')
      .select('a.id', 'id_a')
      .addSelect('a.name', 'name_a')
      .addSelect('a.type', 'type_a')
      .addSelect('b.id', 'id_b')
      .addSelect('b.name', 'name_b')
      .addSelect(`1 - (a.embedding <=> b.embedding)`, 'similarity')
      .where('a.embedding IS NOT NULL')
      .andWhere('b.embedding IS NOT NULL')
      .andWhere('a.id < b.id') // avoid duplicates + self-join
      .andWhere('a.type = b.type')
      .andWhere(`1 - (a.embedding <=> b.embedding) >= :threshold`, { threshold: BATCH_COSINE_THRESHOLD })
      .innerJoin(EntityRecord, 'b', 'a.type = b.type AND a.id < b.id')
      .getRawMany();

    if (pairs.length === 0) return { merged: 0 };

    this.logger.log(`Found ${pairs.length} entity pair(s) with similarity >= ${BATCH_COSINE_THRESHOLD}`);

    // Send to LLM for decision
    const dedupPairs: DedupPair[] = pairs.map((p) => ({
      newItem: { type: 'entity', name: p.name_a, description: p.type_a },
      existingItem: { id: p.id_b, type: 'entity', name: p.name_b, description: p.type_a },
    }));

    const decisions = await this.llmDedupService.decideBatch(dedupPairs);

    let merged = 0;
    for (let i = 0; i < decisions.length; i++) {
      const decision = decisions[i];
      if (decision.isDuplicate && decision.confidence >= AUTO_MERGE_CONFIDENCE && this.dataQualityService) {
        try {
          await this.dataQualityService.autoMerge(pairs[i].id_a, pairs[i].id_b);
          merged++;
          this.logger.log(
            `Auto-merged entities: "${pairs[i].name_a}" + "${pairs[i].name_b}" (confidence: ${decision.confidence.toFixed(2)})`,
          );
        } catch (error: any) {
          this.logger.warn(`Failed to merge entities ${pairs[i].id_a} + ${pairs[i].id_b}: ${error.message}`);
        }
      }
    }

    return { merged };
  }

  /**
   * Find task pairs with high embedding similarity, run through LLM, skip duplicates.
   */
  private async cleanupTaskDuplicates(): Promise<{ merged: number }> {
    // Similar pattern to entity cleanup but for Activity with type=TASK
    // For now, log only — task merging is more complex (hierarchy considerations)
    this.logger.debug('Task dedup cleanup: not yet implemented (requires hierarchy handling)');
    return { merged: 0 };
  }
}
```

### Step 4: Run test to verify it passes

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/modules/extraction/__tests__/dedup-batch-cleanup.job.spec.ts --no-coverage`
Expected: PASS

### Step 5: Register in ExtractionModule

Add to `extraction.module.ts`:
```typescript
import { DedupBatchCleanupJob } from './dedup-batch-cleanup.job';
// Add to providers:
DedupBatchCleanupJob,
```

Also add `ScheduleModule` import if not already present. Check if `@nestjs/schedule` is in the module's imports.

### Step 6: Commit

```bash
git add apps/pkg-core/src/modules/extraction/dedup-batch-cleanup.job.ts apps/pkg-core/src/modules/extraction/__tests__/dedup-batch-cleanup.job.spec.ts apps/pkg-core/src/modules/extraction/extraction.module.ts
git commit -m "feat(extraction): add DedupBatchCleanupJob for daily entity duplicate cleanup"
```

---

## Task 8: Update INDEX.md and documentation

Обновить документацию в соответствии с новой архитектурой.

**Files:**
- Modify: `docs/second-brain/INDEX.md`

### Step 1: Update the known gaps table

Replace the "Extraction Pipeline — разрыв функциональности между путями" section with the updated version showing all paths have full pipeline via DeduplicationGateway.

Update the "Другие пробелы" section to reflect resolved items.

Add a new entry in the roadmap table for "Extraction Quality Sprint".

### Step 2: Commit

```bash
git add docs/second-brain/INDEX.md
git commit -m "docs: update INDEX.md to reflect Extraction Quality Sprint improvements"
```

---

## Task 9: Run all tests + type check

Финальная верификация всех изменений.

### Step 1: Type check

Run: `cd /Users/mityayka/work/projects/PKG && npx tsc --noEmit --project apps/pkg-core/tsconfig.app.json`
Expected: PASS

### Step 2: Run all extraction tests

Run: `cd /Users/mityayka/work/projects/PKG && npx jest apps/pkg-core/src/modules/extraction/ --no-coverage`
Expected: All PASS

### Step 3: Run full test suite

Run: `cd /Users/mityayka/work/projects/PKG && npx jest --no-coverage 2>&1 | tail -20`
Expected: All PASS (or only pre-existing failures)

### Step 4: Commit any fixes

```bash
git add -A && git commit -m "fix: resolve test failures from extraction quality sprint"
```

---

## Execution Dependencies

```
Task 1 (LlmDedupService) ─────────────┐
                                        ├─→ Task 2 (DeduplicationGatewayService) ─→ Task 3 (DraftExtraction integration)
                                        │                                         ─→ Task 4 (Entity creation integration)
                                        │                                         ─→ Task 6 (DailySynthesis integration)
                                        │                                         ─→ Task 7 (Batch cleanup cron)
                                        │
Task 5 (create_fact activityId) ────────┘ (independent)

Task 8 (docs) ─ independent
Task 9 (verification) ─ depends on all above
```

**Parallelizable:** Tasks 3, 4, 5, 6 can be done in parallel after Task 2 is complete.

---

## Verification Checklist

| Check | Command | Expected |
|-------|---------|----------|
| Type check | `npx tsc --noEmit` | No errors |
| New tests pass | `npx jest llm-dedup dedup-gateway dedup-batch --no-coverage` | All PASS |
| Existing tests pass | `npx jest extraction/ --no-coverage` | All PASS |
| Module loads | `npx jest --testPathPattern="app.e2e" --no-coverage` | App boots |
| LlmDedupService registered | Check ExtractionModule providers | Present |
| DeduplicationGatewayService registered | Check ExtractionModule providers | Present |
| DedupBatchCleanupJob registered | Check ExtractionModule providers | Present |

---

## Production Deployment

After all tests pass:

```bash
ssh mityayka@assistant.mityayka.ru
cd /opt/apps/pkg && git pull && cd docker && docker compose build --no-cache pkg-core && docker compose up -d pkg-core
```

Verify:
```bash
docker logs pkg-core 2>&1 | grep -i "dedup\|gateway\|cleanup"
# Expected: services initialized, cron registered
```
