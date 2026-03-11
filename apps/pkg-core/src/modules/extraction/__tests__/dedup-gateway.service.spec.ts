import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Activity, ActivityType, ActivityStatus, EntityRecord, EntityType, Commitment, CommitmentStatus } from '@pkg/entities';
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

const makeCommitment = (overrides: Partial<Commitment> = {}): Commitment =>
  ({
    id: 'commitment-aaa-111',
    title: 'Отправить договор',
    status: CommitmentStatus.PENDING,
    fromEntityId: 'owner-111',
    toEntityId: 'entity-222',
    ...overrides,
  }) as Commitment;

// --- Tests ---

describe('DeduplicationGatewayService', () => {
  let service: DeduplicationGatewayService;

  // Mocks
  const mockActivityRepo = {
    createQueryBuilder: jest.fn(),
  };
  const mockEntityRepo = {
    createQueryBuilder: jest.fn(),
  };
  const mockCommitmentRepo = {
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
        provide: getRepositoryToken(Commitment),
        useValue: mockCommitmentRepo,
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
    it('should return CREATE when no similar tasks exist (both channels empty)', async () => {
      const exactQb = createMockQueryBuilder(null);
      const semanticQb = createMockQueryBuilder(null, []);
      const trigramQb = createMockQueryBuilder(null, []);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

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

    it('should call LLM batch for all semantic candidates and pick best match', async () => {
      const exactQb = createMockQueryBuilder(null);
      const semanticQb = createMockQueryBuilder(null, [
        {
          id: 'candidate-1',
          name: 'Настройка CI/CD пайплайна',
          description: 'Настроить CI/CD для проекта',
          similarity: 0.85,
        },
        {
          id: 'candidate-2',
          name: 'Настроить автодеплой',
          description: null,
          similarity: 0.72,
        },
      ]);
      const trigramQb = createMockQueryBuilder(null, []);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      // LLM batch: candidate-1 is duplicate, candidate-2 is not
      mockLlmDedupService.decideBatch.mockResolvedValue([
        {
          isDuplicate: true,
          confidence: 0.82,
          mergeIntoId: 'candidate-1',
          reason: 'Похожие задачи: настройка CI/CD',
        },
        {
          isDuplicate: false,
          confidence: 0.3,
          reason: 'Разные задачи',
        },
      ]);

      const candidate: TaskCandidate = {
        name: 'Настроить CI/CD',
        ownerEntityId: 'owner-111',
        projectName: 'Проект ИИ-Сервисы',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.PENDING_APPROVAL);
      expect(decision.existingId).toBe('candidate-1');
      expect(decision.confidence).toBe(0.82);

      // Verify LLM was called with ALL candidates in batch
      expect(mockLlmDedupService.decideBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            existingItem: expect.objectContaining({ id: 'candidate-1' }),
          }),
          expect.objectContaining({
            existingItem: expect.objectContaining({ id: 'candidate-2' }),
          }),
        ]),
      );
    });

    it('should return MERGE for high confidence LLM decision (>=0.9)', async () => {
      const exactQb = createMockQueryBuilder(null);
      const semanticQb = createMockQueryBuilder(null, [
        {
          id: 'high-conf-id',
          name: 'Настройка CI/CD',
          description: null,
          similarity: 0.92,
        },
      ]);
      const trigramQb = createMockQueryBuilder(null, []);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      mockLlmDedupService.decideBatch.mockResolvedValue([
        {
          isDuplicate: true,
          confidence: 0.95,
          mergeIntoId: 'high-conf-id',
          reason: 'Одна и та же задача: CI/CD setup',
        },
      ]);

      const candidate: TaskCandidate = {
        name: 'Настроить CI CD',
        ownerEntityId: 'owner-111',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('high-conf-id');
      expect(decision.confidence).toBe(0.95);
    });

    it('should return CREATE when LLM says not duplicate for any candidate', async () => {
      const exactQb = createMockQueryBuilder(null);
      const semanticQb = createMockQueryBuilder(null, [
        {
          id: 'different-task-id',
          name: 'Написать тесты',
          description: null,
          similarity: 0.55,
        },
      ]);
      const trigramQb = createMockQueryBuilder(null, []);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      mockLlmDedupService.decideBatch.mockResolvedValue([
        {
          isDuplicate: false,
          confidence: 0.9,
          reason: 'Разные задачи: CI/CD vs тестирование',
        },
      ]);

      const candidate: TaskCandidate = {
        name: 'Настроить CI/CD',
        ownerEntityId: 'owner-111',
      };

      const decision = await service.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.existingId).toBeUndefined();
      expect(decision.reason).toContain('not duplicate');
    });

    it('should pick the highest-confidence match when multiple candidates are duplicates', async () => {
      const exactQb = createMockQueryBuilder(null);
      const semanticQb = createMockQueryBuilder(null, [
        { id: 'c1', name: 'CI/CD настройка', description: null, similarity: 0.88 },
        { id: 'c2', name: 'Настроить деплой CI/CD', description: null, similarity: 0.82 },
        { id: 'c3', name: 'Написать тесты', description: null, similarity: 0.55 },
      ]);
      const trigramQb = createMockQueryBuilder(null, []);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      // LLM: c1 is weak duplicate, c2 is strong duplicate, c3 is not
      mockLlmDedupService.decideBatch.mockResolvedValue([
        { isDuplicate: true, confidence: 0.75, mergeIntoId: 'c1', reason: 'Похожие' },
        { isDuplicate: true, confidence: 0.95, mergeIntoId: 'c2', reason: 'Точный дубликат' },
        { isDuplicate: false, confidence: 0.1, reason: 'Не дубликат' },
      ]);

      const decision = await service.checkTask({
        name: 'Настроить CI/CD',
        ownerEntityId: 'owner-111',
      });

      // Should pick c2 (confidence 0.95) over c1 (confidence 0.75)
      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('c2');
      expect(decision.confidence).toBe(0.95);
    });

    it('should discover duplicate via trigram when cosine returns nothing', async () => {
      const exactQb = createMockQueryBuilder(null);
      const semanticQb = createMockQueryBuilder(null, []); // cosine: no hits
      const trigramQb = createMockQueryBuilder(null, [
        {
          id: 'trigram-hit-1',
          name: 'Настроить CICD пайплайн',
          description: null,
          similarity: 0.55,
        },
      ]);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      mockLlmDedupService.decideBatch.mockResolvedValue([
        {
          isDuplicate: true,
          confidence: 0.88,
          mergeIntoId: 'trigram-hit-1',
          reason: 'Одна задача: CICD pipeline',
        },
      ]);

      const decision = await service.checkTask({
        name: 'Настроить CI/CD',
        ownerEntityId: 'owner-111',
      });

      expect(decision.action).toBe(DedupAction.PENDING_APPROVAL);
      expect(decision.existingId).toBe('trigram-hit-1');
      expect(decision.confidence).toBe(0.88);
    });

    it('should deduplicate candidates when both channels find the same task', async () => {
      const exactQb = createMockQueryBuilder(null);
      // Both channels return same ID with different scores
      const semanticQb = createMockQueryBuilder(null, [
        { id: 'same-task', name: 'CI/CD настройка', description: null, similarity: 0.78 },
      ]);
      const trigramQb = createMockQueryBuilder(null, [
        { id: 'same-task', name: 'CI/CD настройка', description: null, similarity: 0.62 },
      ]);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      mockLlmDedupService.decideBatch.mockResolvedValue([
        {
          isDuplicate: true,
          confidence: 0.91,
          mergeIntoId: 'same-task',
          reason: 'Та же задача',
        },
      ]);

      const decision = await service.checkTask({
        name: 'Настроить CI/CD',
        ownerEntityId: 'owner-111',
      });

      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('same-task');
      // LLM should be called with exactly 1 candidate (deduplicated)
      expect(mockLlmDedupService.decideBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            existingItem: expect.objectContaining({ id: 'same-task' }),
          }),
        ]),
      );
      // Only 1 pair, not 2
      expect(mockLlmDedupService.decideBatch.mock.calls[0][0]).toHaveLength(1);
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

    it('should call LLM batch for all partial entity matches', async () => {
      const exactQb = createMockQueryBuilder(null);

      const partialCandidates = [
        makeEntity({ id: 'partial-1', name: 'Иванов И.И.' }),
        makeEntity({ id: 'partial-2', name: 'Иванов Игорь' }),
      ];
      const partialQb = createMockQueryBuilder(null, []);
      partialQb.getMany = jest.fn().mockResolvedValue(partialCandidates);

      mockEntityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(partialQb);

      // LLM batch: partial-1 is duplicate (same person), partial-2 is not
      mockLlmDedupService.decideBatch.mockResolvedValue([
        {
          isDuplicate: true,
          confidence: 0.85,
          mergeIntoId: 'partial-1',
          reason: 'Тот же человек: Иванов И.И. = Иванов',
        },
        {
          isDuplicate: false,
          confidence: 0.3,
          reason: 'Другой человек: Иванов Игорь',
        },
      ]);

      const candidate: EntityCandidate = {
        name: 'Иванов',
        type: EntityType.PERSON,
        context: 'Из переписки в Telegram',
      };

      const decision = await service.checkEntity(candidate);

      expect(decision.action).toBe(DedupAction.PENDING_APPROVAL);
      expect(decision.existingId).toBe('partial-1');
      expect(decision.confidence).toBe(0.85);

      // Verify LLM batch was called with ALL candidates
      expect(mockLlmDedupService.decideBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            existingItem: expect.objectContaining({ id: 'partial-1' }),
          }),
          expect.objectContaining({
            existingItem: expect.objectContaining({ id: 'partial-2' }),
          }),
        ]),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // checkCommitment
  // ─────────────────────────────────────────────────────────────

  describe('checkCommitment', () => {
    it('should return MERGE for exact commitment title match', async () => {
      const existingCommitment = makeCommitment({
        id: 'commit-exact-id',
        title: 'отправить договор',
      });
      const exactQb = createMockQueryBuilder(existingCommitment);

      mockCommitmentRepo.createQueryBuilder.mockReturnValueOnce(exactQb);

      const candidate: CommitmentCandidate = {
        what: 'Отправить договор',
        entityId: 'owner-111',
        activityContext: 'Проект Панавто',
      };

      const decision = await service.checkCommitment(candidate);

      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('commit-exact-id');
      expect(decision.confidence).toBe(1.0);
    });

    it('should call LLM batch for all semantic commitment candidates', async () => {
      // No exact match
      const exactQb = createMockQueryBuilder(null);
      // Semantic candidates
      const semanticQb = createMockQueryBuilder(null, [
        { id: 'sc-1', title: 'Отправить контракт клиенту', similarity: 0.82 },
        { id: 'sc-2', title: 'Подготовить договор', similarity: 0.65 },
      ]);
      const trigramQb = createMockQueryBuilder(null, []);

      mockCommitmentRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      // LLM: sc-1 is duplicate, sc-2 is not
      mockLlmDedupService.decideBatch.mockResolvedValue([
        {
          isDuplicate: true,
          confidence: 0.92,
          mergeIntoId: 'sc-1',
          reason: 'Одно обязательство: отправить договор = отправить контракт',
        },
        {
          isDuplicate: false,
          confidence: 0.2,
          reason: 'Разные действия: подготовить vs отправить',
        },
      ]);

      const candidate: CommitmentCandidate = {
        what: 'Отправить договор',
        entityId: 'owner-111',
        activityContext: 'Проект Панавто',
      };

      const decision = await service.checkCommitment(candidate);

      expect(decision.action).toBe(DedupAction.MERGE);
      expect(decision.existingId).toBe('sc-1');
      expect(decision.confidence).toBe(0.92);

      // Verify LLM was called with ALL candidates
      expect(mockLlmDedupService.decideBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            existingItem: expect.objectContaining({ id: 'sc-1' }),
          }),
          expect.objectContaining({
            existingItem: expect.objectContaining({ id: 'sc-2' }),
          }),
        ]),
      );
    });

    it('should return CREATE when no semantic candidates found (both channels empty)', async () => {
      const exactQb = createMockQueryBuilder(null);
      const semanticQb = createMockQueryBuilder(null, []);
      const trigramQb = createMockQueryBuilder(null, []);

      mockCommitmentRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      const candidate: CommitmentCandidate = {
        what: 'Совершенно уникальное обязательство',
        entityId: 'owner-111',
      };

      const decision = await service.checkCommitment(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.reason).toContain('No similar commitments');
    });

    it('should return CREATE when LLM says not duplicate for any candidate', async () => {
      const exactQb = createMockQueryBuilder(null);
      const semanticQb = createMockQueryBuilder(null, [
        { id: 'sc-1', title: 'Другое дело', similarity: 0.55 },
      ]);
      const trigramQb = createMockQueryBuilder(null, []);

      mockCommitmentRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(semanticQb)
        .mockReturnValueOnce(trigramQb);

      mockEmbeddingService.generate.mockResolvedValue(new Array(1536).fill(0.1));

      mockLlmDedupService.decideBatch.mockResolvedValue([
        {
          isDuplicate: false,
          confidence: 0.1,
          reason: 'Разные обязательства',
        },
      ]);

      const candidate: CommitmentCandidate = {
        what: 'Отправить договор',
        entityId: 'owner-111',
      };

      const decision = await service.checkCommitment(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.reason).toContain('not duplicate');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Graceful degradation
  // ─────────────────────────────────────────────────────────────

  describe('graceful degradation', () => {
    it('should return CREATE when embedding service is unavailable', async () => {
      const module = await buildModule(false);
      const serviceNoEmb = module.get(DeduplicationGatewayService);

      const exactQb = createMockQueryBuilder(null);
      const trigramQb = createMockQueryBuilder(null, []);
      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(trigramQb);

      const candidate: TaskCandidate = {
        name: 'Some task',
        ownerEntityId: 'owner-111',
      };

      const decision = await serviceNoEmb.checkTask(candidate);

      expect(decision.action).toBe(DedupAction.CREATE);
      expect(decision.reason).toContain('No similar tasks');
      expect(mockEmbeddingService.generate).not.toHaveBeenCalled();
    });

    it('should include deletedAt IS NULL filter in task queries', async () => {
      const exactQb = createMockQueryBuilder(null);
      const trigramQb = createMockQueryBuilder(null, []);
      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(trigramQb);

      const module = await buildModule(false);
      const svc = module.get(DeduplicationGatewayService);
      await svc.checkTask({ name: 'Some task', ownerEntityId: 'owner-111' });

      expect(exactQb.andWhere).toHaveBeenCalledWith('a.deletedAt IS NULL');
    });

    it('should include deletedAt IS NULL filter in entity queries', async () => {
      const exactQb = createMockQueryBuilder(null);
      const partialQb = createMockQueryBuilder(null, []);
      partialQb.getMany = jest.fn().mockResolvedValue([]);

      mockEntityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(partialQb);

      await service.checkEntity({
        name: 'Тестовый человек',
        type: EntityType.PERSON,
      });

      expect(exactQb.andWhere).toHaveBeenCalledWith('e.deletedAt IS NULL');
      expect(partialQb.andWhere).toHaveBeenCalledWith('e.deletedAt IS NULL');
    });

    it('should return CREATE when embedding generation throws', async () => {
      const exactQb = createMockQueryBuilder(null);
      const trigramQb = createMockQueryBuilder(null, []);
      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(exactQb)
        .mockReturnValueOnce(trigramQb);

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
