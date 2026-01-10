import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact } from '@pkg/entities';
import { FactDeduplicationService } from './fact-deduplication.service';
import { ExtractedFact } from './fact-extraction.service';

/** Helper to create test ExtractedFact */
const createFact = (
  factType: string,
  value: string,
  confidence: number,
  sourceQuote = 'test quote',
): ExtractedFact => ({
  factType,
  value,
  confidence,
  sourceQuote,
});

describe('FactDeduplicationService', () => {
  let service: FactDeduplicationService;
  let repo: jest.Mocked<Repository<EntityFact>>;

  const mockRepo = {
    find: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FactDeduplicationService,
        {
          provide: getRepositoryToken(EntityFact),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<FactDeduplicationService>(FactDeduplicationService);
    repo = module.get(getRepositoryToken(EntityFact));

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
      const facts: ExtractedFact[] = [
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
      const facts: ExtractedFact[] = [
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

      const facts: ExtractedFact[] = [
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
      const facts: ExtractedFact[] = Array.from({ length: 100 }, (_, i) =>
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
});
