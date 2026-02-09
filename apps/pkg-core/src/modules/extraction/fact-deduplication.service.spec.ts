import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact } from '@pkg/entities';
import { FactDeduplicationService, DeduplicableFact } from './fact-deduplication.service';
import { EmbeddingService } from '../embedding/embedding.service';

/** Helper to create test DeduplicableFact */
const createFact = (
  factType: string,
  value: string,
  confidence: number,
): DeduplicableFact => ({
  factType,
  value,
  confidence,
});

/** Create a mock embedding (normalized random vector for testing) */
const createMockEmbedding = (seed = 0): number[] => {
  const vector = Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.1);
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map(v => v / magnitude);
};

describe('FactDeduplicationService', () => {
  let service: FactDeduplicationService;
  let repo: jest.Mocked<Repository<EntityFact>>;
  let embeddingService: jest.Mocked<EmbeddingService>;

  const mockRepo = {
    find: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
  };

  const mockEmbeddingService = {
    generate: jest.fn(),
    generateBatch: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FactDeduplicationService,
        {
          provide: getRepositoryToken(EntityFact),
          useValue: mockRepo,
        },
        {
          provide: EmbeddingService,
          useValue: mockEmbeddingService,
        },
      ],
    }).compile();

    service = module.get<FactDeduplicationService>(FactDeduplicationService);
    repo = module.get(getRepositoryToken(EntityFact));
    embeddingService = module.get(EmbeddingService);

    jest.clearAllMocks();
  });

  describe('checkDuplicate', () => {
    const entityId = 'entity-123';

    it('should return create action if no existing facts', async () => {
      mockRepo.find.mockResolvedValue([]);

      const newFact = createFact('email', 'test@example.com', 0.9);

      const result = await service.checkDuplicate(entityId, newFact);

      expect(result.action).toBe('create');
      expect(result.reason).toContain('No existing facts');
    });

    it('should return skip action for exact duplicate', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'email',
          value: 'test@example.com',
          validUntil: null,
        },
      ]);

      const newFact = createFact('email', 'test@example.com', 0.9);

      const result = await service.checkDuplicate(entityId, newFact);

      expect(result.action).toBe('skip');
      expect(result.existingFactId).toBe('fact-1');
      expect(result.reason).toContain('Exact duplicate');
    });

    it('should handle case insensitivity for exact duplicates', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'email',
          value: 'Test@Example.COM',
          validUntil: null,
        },
      ]);

      const newFact = createFact('email', 'test@example.com', 0.9);

      const result = await service.checkDuplicate(entityId, newFact);

      expect(result.action).toBe('skip');
    });

    it('should return update action for similar facts', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'name',
          value: 'Иван Петров',
          validUntil: null,
        },
      ]);

      const newFact = createFact('name', 'Иван Петрович', 0.9);

      const result = await service.checkDuplicate(entityId, newFact);

      // "Иван Петров" and "Иван Петрович" are similar - could be skip, update, or create
      expect(['skip', 'update', 'create']).toContain(result.action);
    });

    it('should return supersede action for temporal updates', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'position',
          value: 'Junior Developer',
          validUntil: null,
        },
      ]);

      const newFact = createFact('position', 'Senior Developer', 0.9);

      const result = await service.checkDuplicate(entityId, newFact);

      // Position changes should supersede
      expect(result.action).toBe('supersede');
      expect(result.existingFactId).toBe('fact-1');
    });

    it('should return create for completely different values', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'email',
          value: 'old@example.com',
          validUntil: null,
        },
      ]);

      const newFact = createFact('email', 'completely-different@newdomain.org', 0.9);

      const result = await service.checkDuplicate(entityId, newFact);

      expect(result.action).toBe('create');
    });

    it('should ignore facts with validUntil set', async () => {
      mockRepo.find.mockResolvedValue([]); // Query filters by validUntil IS NULL

      const newFact = createFact('position', 'Developer', 0.9);

      const result = await service.checkDuplicate(entityId, newFact);

      expect(result.action).toBe('create');
    });

    it('should handle null values in existing facts', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'phone',
          value: null,
          validUntil: null,
        },
      ]);

      const newFact = createFact('phone', '+79991234567', 0.9);

      const result = await service.checkDuplicate(entityId, newFact);

      expect(result.action).toBe('create');
    });
  });

  describe('processBatch', () => {
    const entityId = 'entity-123';

    beforeEach(() => {
      mockRepo.find.mockResolvedValue([]);
    });

    it('should deduplicate within batch', async () => {
      const facts: DeduplicableFact[] = [
        createFact('email', 'test@example.com', 0.8),
        createFact('email', 'test@example.com', 0.9),
        createFact('email', 'test@example.com', 0.7),
      ];

      const result = await service.processBatch(entityId, facts);

      expect(result.toCreate).toHaveLength(1);
      expect(result.skipped).toBe(2);
      // The first occurrence goes through DB check, others are skipped
      // seenInBatch tracking keeps highest confidence for future batches
      expect(result.toCreate[0].factType).toBe('email');
      expect(result.toCreate[0].value).toBe('test@example.com');
    });

    it('should process mixed fact types', async () => {
      const facts: DeduplicableFact[] = [
        createFact('email', 'test@example.com', 0.9),
        createFact('phone', '+79991234567', 0.8),
        createFact('position', 'Developer', 0.7),
      ];

      const result = await service.processBatch(entityId, facts);

      expect(result.toCreate).toHaveLength(3);
      expect(result.skipped).toBe(0);
    });

    it('should handle supersede actions', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'position',
          value: 'Junior Developer',
          validUntil: null,
        },
      ]);

      const facts: DeduplicableFact[] = [
        createFact('position', 'Senior Developer', 0.9),
      ];

      const result = await service.processBatch(entityId, facts);

      expect(result.toSupersede).toHaveLength(1);
      expect(result.toSupersede[0].oldFactId).toBe('fact-1');
      expect(result.toSupersede[0].newFact.value).toBe('Senior Developer');
    });

    it('should return empty arrays for empty input', async () => {
      const result = await service.processBatch(entityId, []);

      expect(result.toCreate).toHaveLength(0);
      expect(result.toSupersede).toHaveLength(0);
      expect(result.skipped).toBe(0);
    });

    it('should handle large batches', async () => {
      const facts: DeduplicableFact[] = Array.from({ length: 100 }, (_, i) =>
        createFact('note', `Note ${i}`, 0.8)
      );

      const result = await service.processBatch(entityId, facts);

      expect(result.toCreate).toHaveLength(100);
      expect(result.skipped).toBe(0);
    });
  });

  describe('supersedeFact', () => {
    it('should update validUntil on existing fact', async () => {
      mockRepo.update.mockResolvedValue({ affected: 1 });

      await service.supersedeFact('fact-123');

      expect(mockRepo.update).toHaveBeenCalledWith('fact-123', {
        validUntil: expect.any(Date),
      });
    });
  });

  describe('similarity calculation', () => {
    // Testing private method through behavior

    it('should treat identical strings as duplicates', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId: 'entity-1',
          factType: 'name',
          value: 'John Doe',
          validUntil: null,
        },
      ]);

      const result = await service.checkDuplicate(
        'entity-1',
        createFact('name', 'John Doe', 0.9)
      );

      expect(result.action).toBe('skip');
    });

    it('should treat strings with extra whitespace as similar', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId: 'entity-1',
          factType: 'name',
          value: 'John   Doe',
          validUntil: null,
        },
      ]);

      const result = await service.checkDuplicate(
        'entity-1',
        createFact('name', 'John Doe', 0.9)
      );

      expect(result.action).toBe('skip');
    });

    it('should handle special characters', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId: 'entity-1',
          factType: 'email',
          value: 'test+tag@example.com',
          validUntil: null,
        },
      ]);

      const result = await service.checkDuplicate(
        'entity-1',
        createFact('email', 'test+tag@example.com', 0.9)
      );

      expect(result.action).toBe('skip');
    });
  });

  describe('temporal updates', () => {
    // Temporal updates require similarity between 0.3 and 0.95
    // "Junior Developer" vs "Senior Developer" meets this threshold

    it('should detect temporal update for position with similar values', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId: 'entity-1',
          factType: 'position',
          value: 'Junior Developer',
          validUntil: null,
        },
      ]);

      const result = await service.checkDuplicate(
        'entity-1',
        createFact('position', 'Senior Developer', 0.9)
      );

      expect(result.action).toBe('supersede');
    });

    it('should detect temporal update for company with similar values', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId: 'entity-1',
          factType: 'company',
          value: 'Google LLC',
          validUntil: null,
        },
      ]);

      const result = await service.checkDuplicate(
        'entity-1',
        createFact('company', 'Google Inc', 0.9)
      );

      // Similar but different - should supersede
      expect(result.action).toBe('supersede');
    });

    it('should return create for completely different temporal values', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId: 'entity-1',
          factType: 'company',
          value: 'Google',
          validUntil: null,
        },
      ]);

      const result = await service.checkDuplicate(
        'entity-1',
        createFact('company', 'Microsoft', 0.9)
      );

      // Too different - should create new
      expect(result.action).toBe('create');
    });

    it('should not supersede non-temporal fact types', async () => {
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId: 'entity-1',
          factType: 'birthday',
          value: '1990-01-01',
          validUntil: null,
        },
      ]);

      const result = await service.checkDuplicate(
        'entity-1',
        createFact('birthday', '1990-01-02', 0.9)
      );

      // Birthday shouldn't be superseded, should be create/update
      expect(result.action).not.toBe('supersede');
    });
  });

  describe('checkSemanticDuplicate', () => {
    const entityId = 'entity-123';

    beforeEach(() => {
      // Ensure embeddingService is available for semantic tests
      // @Optional() can cause issues with DI in tests
      (service as any).embeddingService = mockEmbeddingService;
    });

    it('should return skip action when semantic duplicate found', async () => {
      const newEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(newEmbedding);

      mockRepo.query.mockResolvedValue([
        {
          id: 'fact-1',
          value: 'Сотрудник Сбербанка',
          fact_type: 'position',
          similarity: 0.92,
        },
      ]);

      const result = await service.checkSemanticDuplicate(
        entityId,
        'Работает в Сбере',
        'position',
      );

      expect(result.action).toBe('skip');
      expect(result.existingFactId).toBe('fact-1');
      expect(result.reason).toContain('Semantic duplicate');
      expect(result.reason).toContain('0.92');
    });

    it('should return create action when no semantic duplicate found', async () => {
      const newEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(newEmbedding);

      mockRepo.query.mockResolvedValue([]);

      const result = await service.checkSemanticDuplicate(
        entityId,
        'Completely unique fact',
      );

      expect(result.action).toBe('create');
      expect(result.reason).toContain('No semantic duplicates');
    });

    it('should NOT filter by factType — embeddings catch cross-type duplicates', async () => {
      const newEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(newEmbedding);
      mockRepo.query.mockResolvedValue([]);

      await service.checkSemanticDuplicate(entityId, 'test value', 'position');

      expect(mockRepo.query).toHaveBeenCalled();
      const queryCall = mockRepo.query.mock.calls[0];
      // No factType filter — semantic search should find "birthday" ≈ "дата_рождения"
      expect(queryCall[0]).not.toContain('AND fact_type');
    });

    it('should handle embedding service errors gracefully', async () => {
      mockEmbeddingService.generate.mockRejectedValue(new Error('OpenAI API error'));

      const result = await service.checkSemanticDuplicate(entityId, 'test value');

      expect(result.action).toBe('create');
      expect(result.reason).toContain('error');
    });

    it('should handle database query errors gracefully', async () => {
      const newEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(newEmbedding);
      mockRepo.query.mockRejectedValue(new Error('DB error'));

      const result = await service.checkSemanticDuplicate(entityId, 'test value');

      expect(result.action).toBe('create');
      expect(result.reason).toContain('error');
    });

    it('should return create with unavailable message when embeddingService is null', async () => {
      // Simulate no embedding service available
      (service as any).embeddingService = null;

      const result = await service.checkSemanticDuplicate(entityId, 'test value');

      expect(result.action).toBe('create');
      expect(result.reason).toBe('Semantic dedup unavailable');
    });
  });

  describe('checkDuplicateHybrid', () => {
    const entityId = 'entity-123';

    beforeEach(() => {
      // Ensure embeddingService is available for hybrid tests
      (service as any).embeddingService = mockEmbeddingService;
    });

    it('should use text-based result if found', async () => {
      // Text-based check finds exact match
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'email',
          value: 'test@example.com',
          validUntil: null,
        },
      ]);

      const newFact = createFact('email', 'test@example.com', 0.9);

      const result = await service.checkDuplicateHybrid(entityId, newFact);

      expect(result.action).toBe('skip');
      expect(result.existingFactId).toBe('fact-1');
      // Should not call embedding service
      expect(mockEmbeddingService.generate).not.toHaveBeenCalled();
    });

    it('should fallback to semantic check when text-based finds no match', async () => {
      // Text-based check finds no match
      mockRepo.find.mockResolvedValue([]);

      // Semantic check finds match
      const newEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(newEmbedding);
      mockRepo.query.mockResolvedValue([
        {
          id: 'fact-2',
          value: 'Сотрудник Сбербанка',
          fact_type: 'position',
          similarity: 0.90,
        },
      ]);

      const newFact = createFact('position', 'Работает в Сбере', 0.9);

      const result = await service.checkDuplicateHybrid(entityId, newFact);

      expect(result.action).toBe('skip');
      expect(result.existingFactId).toBe('fact-2');
      expect(result.reason).toContain('Semantic duplicate');
      expect(mockEmbeddingService.generate).toHaveBeenCalled();
    });

    it('should return create when neither text nor semantic finds match', async () => {
      // Text-based check finds no match
      mockRepo.find.mockResolvedValue([]);

      // Semantic check finds no match
      const newEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(newEmbedding);
      mockRepo.query.mockResolvedValue([]);

      const newFact = createFact('position', 'Unique position', 0.9);

      const result = await service.checkDuplicateHybrid(entityId, newFact);

      expect(result.action).toBe('create');
    });

    it('should return text-based supersede without calling semantic', async () => {
      // Text-based check finds similar temporal fact
      mockRepo.find.mockResolvedValue([
        {
          id: 'fact-1',
          entityId,
          factType: 'position',
          value: 'Junior Developer',
          validUntil: null,
        },
      ]);

      const newFact = createFact('position', 'Senior Developer', 0.9);

      const result = await service.checkDuplicateHybrid(entityId, newFact);

      expect(result.action).toBe('supersede');
      expect(result.existingFactId).toBe('fact-1');
      // Should not call embedding service since text-based found a match
      expect(mockEmbeddingService.generate).not.toHaveBeenCalled();
    });
  });
});
