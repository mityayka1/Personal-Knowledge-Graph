import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact, FactType, FactCategory, FactSource } from '@pkg/entities';
import { EntityFactService, CreateFactResult } from './entity-fact.service';
import { EmbeddingService } from '../../embedding/embedding.service';
import { FactFusionService } from './fact-fusion.service';
import { FusionAction } from './fact-fusion.constants';

/** Create a mock embedding (normalized random vector for testing) */
const createMockEmbedding = (seed = 0): number[] => {
  const vector = Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.1);
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map(v => v / magnitude);
};

describe('EntityFactService', () => {
  let service: EntityFactService;
  let factRepo: jest.Mocked<Repository<EntityFact>>;
  let embeddingService: jest.Mocked<EmbeddingService>;
  let factFusionService: jest.Mocked<FactFusionService>;

  const mockFactRepo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
  };

  const mockEmbeddingService = {
    generate: jest.fn(),
    generateBatch: jest.fn(),
  };

  const mockFactFusionService = {
    decideFusion: jest.fn(),
    applyDecision: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityFactService,
        {
          provide: getRepositoryToken(EntityFact),
          useValue: mockFactRepo,
        },
        {
          provide: EmbeddingService,
          useValue: mockEmbeddingService,
        },
        {
          provide: FactFusionService,
          useValue: mockFactFusionService,
        },
      ],
    }).compile();

    service = module.get<EntityFactService>(EntityFactService);
    factRepo = module.get(getRepositoryToken(EntityFact));
    embeddingService = module.get(EmbeddingService);
    factFusionService = module.get(FactFusionService);

    // Ensure services are available
    (service as any).embeddingService = mockEmbeddingService;
    (service as any).factFusionService = mockFactFusionService;

    jest.clearAllMocks();
  });

  describe('create', () => {
    const entityId = 'entity-123';

    it('should create a new fact without embedding when no value', async () => {
      const dto = {
        type: FactType.BIRTHDAY,
        category: FactCategory.PERSONAL,
        valueDate: new Date('1990-01-15'),
      };

      const createdFact = {
        id: 'fact-1',
        entityId,
        factType: dto.type,
        category: dto.category,
        valueDate: dto.valueDate,
        source: FactSource.MANUAL,
      };

      mockFactRepo.create.mockReturnValue(createdFact);
      mockFactRepo.save.mockResolvedValue(createdFact);

      const result = await service.create(entityId, dto);

      expect(result.id).toBe('fact-1');
      expect(mockEmbeddingService.generate).not.toHaveBeenCalled();
    });

    it('should create a fact with embedding when value is provided', async () => {
      const dto = {
        type: FactType.POSITION,
        category: FactCategory.PROFESSIONAL,
        value: 'Senior Developer',
      };

      const mockEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(mockEmbedding);
      mockFactRepo.query.mockResolvedValue([]); // No duplicates

      const createdFact = {
        id: 'fact-1',
        entityId,
        factType: dto.type,
        category: dto.category,
        value: dto.value,
        embedding: null,
      };

      mockFactRepo.create.mockReturnValue(createdFact);
      mockFactRepo.save.mockResolvedValue({ ...createdFact, embedding: mockEmbedding });

      const result = await service.create(entityId, dto);

      expect(result.id).toBe('fact-1');
      expect(mockEmbeddingService.generate).toHaveBeenCalledWith('Senior Developer');
    });
  });

  describe('createWithDedup', () => {
    const entityId = 'entity-123';

    it('should use fusion service when semantic duplicate found', async () => {
      const dto = {
        type: FactType.POSITION,
        category: FactCategory.PROFESSIONAL,
        value: 'Работает в Сбере',
      };

      const existingFact = {
        id: 'existing-fact-1',
        entityId,
        factType: FactType.POSITION,
        value: 'Сотрудник Сбербанка',
        embedding: createMockEmbedding(2),
        source: FactSource.EXTRACTED,
        confidence: 0.8,
        createdAt: new Date(),
        confirmationCount: 1,
      };

      const mockEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(mockEmbedding);

      // Mock the similarity query to return a duplicate
      mockFactRepo.query.mockResolvedValue([
        { id: 'existing-fact-1', similarity: 0.92 },
      ]);
      mockFactRepo.findOne.mockResolvedValue(existingFact);

      // Mock fusion decision - CONFIRM
      const fusionDecision = {
        action: FusionAction.CONFIRM,
        explanation: 'Та же информация о работе в Сбербанке',
        confidence: 0.95,
      };
      mockFactFusionService.decideFusion.mockResolvedValue(fusionDecision);
      mockFactFusionService.applyDecision.mockResolvedValue({
        fact: { ...existingFact, confirmationCount: 2 },
        action: 'updated',
        reason: 'CONFIRM: Та же информация. Подтверждений: 2',
        existingFactId: existingFact.id,
      });

      const result = await service.createWithDedup(entityId, dto);

      expect(mockFactFusionService.decideFusion).toHaveBeenCalledWith(
        existingFact,
        dto.value,
        FactSource.EXTRACTED,
        { messageContent: undefined },
      );
      expect(mockFactFusionService.applyDecision).toHaveBeenCalled();
      expect(result.action).toBe('updated');
    });

    it('should skip creation when skipFusion option is true', async () => {
      const dto = {
        type: FactType.POSITION,
        category: FactCategory.PROFESSIONAL,
        value: 'Работает в Сбере',
      };

      const existingFact = {
        id: 'existing-fact-1',
        entityId,
        factType: FactType.POSITION,
        value: 'Сотрудник Сбербанка',
        embedding: createMockEmbedding(2),
      };

      const mockEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(mockEmbedding);

      mockFactRepo.query.mockResolvedValue([
        { id: 'existing-fact-1', similarity: 0.92 },
      ]);
      mockFactRepo.findOne.mockResolvedValue(existingFact);

      const result = await service.createWithDedup(entityId, dto, { skipFusion: true });

      expect(result.action).toBe('skipped');
      expect(result.existingFactId).toBe('existing-fact-1');
      expect(result.reason).toContain('Semantic duplicate');
      expect(mockFactFusionService.decideFusion).not.toHaveBeenCalled();
      expect(mockFactRepo.save).not.toHaveBeenCalled();
    });

    it('should create new fact when no duplicate found', async () => {
      const dto = {
        type: FactType.POSITION,
        category: FactCategory.PROFESSIONAL,
        value: 'Unique Position',
      };

      const mockEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(mockEmbedding);

      // No duplicates found
      mockFactRepo.query.mockResolvedValue([]);

      const createdFact = {
        id: 'new-fact-1',
        entityId,
        factType: dto.type,
        value: dto.value,
        embedding: mockEmbedding,
      };

      mockFactRepo.create.mockReturnValue({ ...createdFact, embedding: null });
      mockFactRepo.save.mockResolvedValue(createdFact);

      const result = await service.createWithDedup(entityId, dto);

      expect(result.action).toBe('created');
      expect(result.fact.id).toBe('new-fact-1');
      expect(result.reason).toContain('with embedding');
    });

    it('should skip semantic check when skipSemanticCheck option is true', async () => {
      const dto = {
        type: FactType.POSITION,
        category: FactCategory.PROFESSIONAL,
        value: 'Some Position',
      };

      const mockEmbedding = createMockEmbedding(1);
      mockEmbeddingService.generate.mockResolvedValue(mockEmbedding);

      const createdFact = {
        id: 'new-fact-1',
        entityId,
        factType: dto.type,
        value: dto.value,
      };

      mockFactRepo.create.mockReturnValue(createdFact);
      mockFactRepo.save.mockResolvedValue({ ...createdFact, embedding: mockEmbedding });

      const result = await service.createWithDedup(entityId, dto, { skipSemanticCheck: true });

      expect(result.action).toBe('created');
      // Should not have called query for duplicate check
      expect(mockFactRepo.query).not.toHaveBeenCalled();
    });

    it('should handle embedding service errors gracefully', async () => {
      const dto = {
        type: FactType.POSITION,
        category: FactCategory.PROFESSIONAL,
        value: 'Developer',
      };

      // First call for dedup check fails
      mockEmbeddingService.generate
        .mockRejectedValueOnce(new Error('OpenAI API error'))
        .mockRejectedValueOnce(new Error('OpenAI API error'));

      const createdFact = {
        id: 'new-fact-1',
        entityId,
        factType: dto.type,
        value: dto.value,
      };

      mockFactRepo.create.mockReturnValue(createdFact);
      mockFactRepo.save.mockResolvedValue(createdFact);

      const result = await service.createWithDedup(entityId, dto);

      // Should still create the fact without embedding
      expect(result.action).toBe('created');
      expect(result.reason).toContain('without embedding');
    });
  });

  describe('findByEntity', () => {
    it('should return active facts by default', async () => {
      const entityId = 'entity-123';
      const facts = [
        { id: 'fact-1', entityId, validUntil: null },
        { id: 'fact-2', entityId, validUntil: null },
      ];

      mockFactRepo.find.mockResolvedValue(facts);

      const result = await service.findByEntity(entityId);

      expect(result).toHaveLength(2);
      expect(mockFactRepo.find).toHaveBeenCalledWith({
        where: { entityId, validUntil: expect.anything() },
        order: { createdAt: 'DESC' },
      });
    });

    it('should include history when requested', async () => {
      const entityId = 'entity-123';
      mockFactRepo.find.mockResolvedValue([]);

      await service.findByEntity(entityId, true);

      expect(mockFactRepo.find).toHaveBeenCalledWith({
        where: { entityId },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('invalidate', () => {
    it('should set validUntil date', async () => {
      mockFactRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.invalidate('fact-123');

      expect(result).toBe(true);
      expect(mockFactRepo.update).toHaveBeenCalledWith('fact-123', {
        validUntil: expect.any(Date),
      });
    });
  });
});
