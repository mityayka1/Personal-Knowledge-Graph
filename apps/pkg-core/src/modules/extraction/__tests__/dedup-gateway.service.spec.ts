import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Activity, ActivityType, ActivityStatus, EntityRecord, EntityType } from '@pkg/entities';
import {
  DeduplicationGatewayService,
  DedupAction,
  TaskCandidate,
  EntityCandidate,
  CommitmentCandidate,
} from '../dedup-gateway.service';
import { ProjectMatchingService } from '../project-matching.service';
import { LlmDedupService } from '../llm-dedup.service';
import { EmbeddingService } from '../../embedding/embedding.service';

// --- Mock QueryBuilder ---

const createMockQueryBuilder = (returnValue: any = null, rawResults: any[] = []) => {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(returnValue),
    getMany: jest.fn().mockResolvedValue(rawResults),
    getRawMany: jest.fn().mockResolvedValue(rawResults),
  };
  return qb;
};

// --- Mock Factories ---

const makeActivity = (overrides: Partial<Activity> = {}): Activity =>
  ({
    id: 'activity-aaa-111',
    name: 'Настроить CI/CD',
    activityType: ActivityType.TASK,
    status: ActivityStatus.ACTIVE,
    ownerEntityId: 'owner-111',
    description: null,
    embedding: null,
    ...overrides,
  }) as Activity;

const makeEntity = (overrides: Partial<EntityRecord> = {}): EntityRecord =>
  ({
    id: 'entity-aaa-111',
    name: 'Иванов Иван',
    type: 'person',
    notes: null,
    ...overrides,
  }) as EntityRecord;

// --- Tests ---

describe('DeduplicationGatewayService', () => {
  let service: DeduplicationGatewayService;

  // Mocks
  let mockActivityQb: any;
  let mockEntityQb: any;
  const mockActivityRepo = {
    createQueryBuilder: jest.fn(),
  };
  const mockEntityRepo = {
    createQueryBuilder: jest.fn(),
  };
  const mockProjectMatchingService = {};
  const mockLlmDedupService = {
    decideDuplicate: jest.fn(),
    decideBatch: jest.fn(),
  };
  const mockEmbeddingService = {
    generate: jest.fn(),
  };

  const buildModule = async (
    withEmbedding = true,
  ): Promise<TestingModule> => {
    const providers: any[] = [
      DeduplicationGatewayService,
      {
        provide: getRepositoryToken(Activity),
        useValue: mockActivityRepo,
      },
      {
        provide: getRepositoryToken(EntityRecord),
        useValue: mockEntityRepo,
      },
      {
        provide: ProjectMatchingService,
        useValue: mockProjectMatchingService,
      },
      {
        provide: LlmDedupService,
        useValue: mockLlmDedupService,
      },
    ];

    if (withEmbedding) {
      providers.push({
        provide: EmbeddingService,
        useValue: mockEmbeddingService,
      });
    }

    return Test.createTestingModule({ providers }).compile();
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await buildModule();
    service = module.get(DeduplicationGatewayService);
  });

  // ─────────────────────────────────────────────────────────────
  // checkTask
  // ─────────────────────────────────────────────────────────────

  describe('checkTask', () => {
    it('should return CREATE when no similar tasks exist (pgvector returns empty)', async () => {
      // Exact match returns null
      const exactQb = createMockQueryBuilder(null);
      // Semantic search returns empty
      const semanticQb = createMockQueryBuilder(null, []);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb) // findExactTaskMatch
        .mockReturnValueOnce(semanticQb); // findSemanticTaskCandidates

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      const candidate: TaskCandidate = {
        name: 'Совершенно новая задача',
        ownerEntityId: 'owner-111',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.existingId).toBeUndefined();
      expect(decision.reason).toContain('No similar tasks');
    });

    it('should return MERGE for exact name match', async () => {
      const existingActivity = makeActivity({ id: 'exact-match-id', name: 'настроить ci/cd' });
      const exactQb = createMockQueryBuilder(existingActivity);

      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(exactQb);

      const candidate: TaskCandidate = {
        name: 'Настроить CI/CD',
        ownerEntityId: 'owner-111',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('exact-match-id');
      expect(decision.confidence).toBe(1.0);
      expect(decision.reason).toContain('Exact name match');
    });

    it('should call LLM for semantic candidates and return PENDING_APPROVAL for 0.7-0.9 confidence', async () => {
      // No exact match
      const exactQb = createMockQueryBuilder(null);
      // Semantic search returns one candidate
      const semanticQb = createMockQueryBuilder(null, [
        {
          id: 'semantic-match-id',
          name: 'Настройка CI/CD пайплайна',
          description: 'Настроить CI/CD для проекта',
          similarity: 0.85,
        },
      ]);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      mockLlmDedupService.decideDuplicate.mockResolvedValue({
        isDuplicate: true,
        confidence: 0.82,
        mergeIntoId: 'semantic-match-id',
        reason: 'Похожие задачи: настройка CI/CD',
      });

      const candidate: TaskCandidate = {
        name: 'Настроить CI/CD',
        ownerEntityId: 'owner-111',
        projectName: 'Проект ИИ-Сервисы',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.PENDING_APPROVAL);
      expect(decision.existingId).toBe('semantic-match-id');
      expect(decision.confidence).toBe(0.82);

      // Verify LLM was called with correct pair
      expect(mockLlmDedupService.decideDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({
          newItem: expect.objectContaining({ type: 'task', name: 'Настроить CI/CD' }),
          existingItem: expect.objectContaining({
            id: 'semantic-match-id',
            name: 'Настройка CI/CD пайплайна',
          }),
          activityContext: 'Проект ИИ-Сервисы',
        }),
      );
    });

    it('should return MERGE for high confidence LLM decision (>=0.9)', async () => {
      // No exact match
      const exactQb = createMockQueryBuilder(null);
      // Semantic candidate
      const semanticQb = createMockQueryBuilder(null, [
        {
          id: 'high-conf-id',
          name: 'Настройка CI/CD',
          description: null,
          similarity: 0.92,
        },
      ]);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      mockLlmDedupService.decideDuplicate.mockResolvedValue({
        isDuplicate: true,
        confidence: 0.95,
        mergeIntoId: 'high-conf-id',
        reason: 'Одна и та же задача: CI/CD setup',
      });

      const candidate: TaskCandidate = {
        name: 'Настроить CI CD',
        ownerEntityId: 'owner-111',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('high-conf-id');
      expect(decision.confidence).toBe(0.95);
    });

    it('should return CREATE when LLM says not duplicate', async () => {
      // No exact match
      const exactQb = createMockQueryBuilder(null);
      // Semantic candidate found
      const semanticQb = createMockQueryBuilder(null, [
        {
          id: 'different-task-id',
          name: 'Написать тесты',
          description: null,
          similarity: 0.55,
        },
      ]);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      mockLlmDedupService.decideDuplicate.mockResolvedValue({
        isDuplicate: false,
        confidence: 0.9,
        reason: 'Разные задачи: CI/CD vs тестирование',
      });

      const candidate: TaskCandidate = {
        name: 'Настроить CI/CD',
        ownerEntityId: 'owner-111',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.existingId).toBeUndefined();
      expect(decision.reason).toContain('not duplicate');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // checkEntity
  // ─────────────────────────────────────────────────────────────

  describe('checkEntity', () => {
    it('should return MERGE for exact name match (normalized)', async () => {
      const existingEntity = makeEntity({
        id: 'entity-exact-id',
        name: 'Иванов Иван Иванович',
      });
      const exactQb = createMockQueryBuilder(existingEntity);

      mockEntityRepo.createQueryBuilder.mockReturnValueOnce(exactQb);

      const candidate: EntityCandidate = {
        name: '  Иванов Иван Иванович  ',
        type: EntityType.PERSON,
      };

      const decision = await service.checkEntity(candidate);

      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('entity-exact-id');
      expect(decision.confidence).toBe(1.0);
    });

    it('should return CREATE when no matches', async () => {
      const exactQb = createMockQueryBuilder(null);
      const partialQb = createMockQueryBuilder(null, []);
      // getMany for partial
      partialQb.getMany = jest.fn().mockResolvedValue([]);

      mockEntityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(partialQb);

      const candidate: EntityCandidate = {
        name: 'Абсолютно новый человек',
        type: EntityType.PERSON,
      };

      const decision = await service.checkEntity(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.existingId).toBeUndefined();
      expect(decision.reason).toContain('No similar entities');
    });

    it('should use ILIKE for partial entity name match and call LLM', async () => {
      // No exact match
      const exactQb = createMockQueryBuilder(null);

      // ILIKE partial match returns a candidate
      const partialCandidate = makeEntity({
        id: 'partial-entity-id',
        name: 'Иванов И.И.',
      });
      const partialQb = createMockQueryBuilder(null, []);
      partialQb.getMany = jest.fn().mockResolvedValue([partialCandidate]);

      mockEntityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(partialQb);

      mockLlmDedupService.decideDuplicate.mockResolvedValue({
        isDuplicate: true,
        confidence: 0.85,
        mergeIntoId: 'partial-entity-id',
        reason: 'Тот же человек: Иванов И.И. = Иванов',
      });

      const candidate: EntityCandidate = {
        name: 'Иванов',
        type: EntityType.PERSON,
        context: 'Из переписки в Telegram',
      };

      const decision = await service.checkEntity(candidate);

      expect(decision.action).toBe(DedupAction.PENDING_APPROVAL);
      expect(decision.existingId).toBe('partial-entity-id');
      expect(decision.confidence).toBe(0.85);

      // Verify ILIKE query was built
      expect(partialQb.andWhere).toHaveBeenCalledWith(
        'e.name ILIKE :pattern',
        expect.objectContaining({ pattern: expect.stringContaining('%') }),
      );

      // Verify LLM was called with entity type
      expect(mockLlmDedupService.decideDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({
          newItem: expect.objectContaining({ type: 'entity', name: 'Иванов' }),
          existingItem: expect.objectContaining({
            id: 'partial-entity-id',
            type: 'entity',
            name: 'Иванов И.И.',
          }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // checkCommitment
  // ─────────────────────────────────────────────────────────────

  describe('checkCommitment', () => {
    it('should delegate to checkTask', async () => {
      // Set up exact match for the task dedup
      const existingActivity = makeActivity({
        id: 'commitment-task-id',
        name: 'отправить договор',
      });
      const exactQb = createMockQueryBuilder(existingActivity);

      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(exactQb);

      const candidate: CommitmentCandidate = {
        what: 'Отправить договор',
        entityId: 'owner-111',
        activityContext: 'Проект Панавто',
      };

      const decision = await service.checkCommitment(candidate);

      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('commitment-task-id');

      // Verify activity repo was queried (not entity repo)
      expect(mockActivityRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('should return CREATE when commitment has no entityId', async () => {
      const candidate: CommitmentCandidate = {
        what: 'Отправить отчёт',
      };

      const decision = await service.checkCommitment(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.reason).toContain('No entityId');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Graceful degradation
  // ─────────────────────────────────────────────────────────────

  describe('graceful degradation', () => {
    it('should return CREATE when embedding service is unavailable', async () => {
      // Build module WITHOUT EmbeddingService
      const module = await buildModule(false);
      const serviceNoEmb = module.get(DeduplicationGatewayService);

      // No exact match
      const exactQb = createMockQueryBuilder(null);
      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(exactQb);

      const candidate: TaskCandidate = {
        name: 'Some task',
        ownerEntityId: 'owner-111',
      };

      const decision = await serviceNoEmb.checkTask(candidate);

      // Should still work -- just no semantic candidates, so CREATE
      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.reason).toContain('No similar tasks');

      // Embedding should NOT have been called
      expect(mockEmbeddingService.generate).not.toHaveBeenCalled();
    });

    it('should include deletedAt IS NULL filter in task queries', async () => {
      // No exact match
      const exactQb = createMockQueryBuilder(null);
      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(exactQb);

      // Verify the exact match query includes deletedAt filter
      const candidate: TaskCandidate = {
        name: 'Some task',
        ownerEntityId: 'owner-111',
      };

      // Need semantic step too — no embedding service
      const module = await buildModule(false);
      const svc = module.get(DeduplicationGatewayService);
      await svc.checkTask(candidate);

      expect(exactQb.andWhere).toHaveBeenCalledWith('a.deletedAt IS NULL');
    });

    it('should include deletedAt IS NULL filter in entity queries', async () => {
      const exactQb = createMockQueryBuilder(null);
      const partialQb = createMockQueryBuilder(null, []);
      partialQb.getMany = jest.fn().mockResolvedValue([]);

      mockEntityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(partialQb);

      const candidate: EntityCandidate = {
        name: 'Тестовый человек',
        type: EntityType.PERSON,
      };

      await service.checkEntity(candidate);

      // Both exact and partial queries should filter deleted
      expect(exactQb.andWhere).toHaveBeenCalledWith('e.deletedAt IS NULL');
      expect(partialQb.andWhere).toHaveBeenCalledWith('e.deletedAt IS NULL');
    });

    it('should return CREATE when embedding generation throws', async () => {
      // No exact match
      const exactQb = createMockQueryBuilder(null);
      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(exactQb);

      mockEmbeddingService.generate.mockRejectedValue(
        new Error('OpenAI API rate limit'),
      );

      const candidate: TaskCandidate = {
        name: 'Задача без эмбеддинга',
        ownerEntityId: 'owner-111',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.reason).toContain('No similar tasks');
    });
  });
});
