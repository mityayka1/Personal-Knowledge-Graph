import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RelationInferenceService } from './relation-inference.service';
import { EntityService } from '../entity/entity.service';
import { EntityRelationService } from '../entity/entity-relation/entity-relation.service';
import {
  EntityFact,
  EntityRecord,
  EntityType,
  RelationType,
  RelationSource,
  EntityRelation,
} from '@pkg/entities';

describe('RelationInferenceService', () => {
  let service: RelationInferenceService;
  let factRepo: Repository<EntityFact>;
  let entityService: EntityService;
  let entityRelationService: EntityRelationService;

  const mockPersonEntity: Partial<EntityRecord> = {
    id: 'person-uuid-1',
    name: 'Иван Петров',
    type: EntityType.PERSON,
  };

  const mockOrgEntity: Partial<EntityRecord> = {
    id: 'org-uuid-1',
    name: 'Сбербанк',
    type: EntityType.ORGANIZATION,
  };

  const mockCompanyFact: Partial<EntityFact> = {
    id: 'fact-uuid-1',
    entityId: 'person-uuid-1',
    factType: 'company',
    value: 'Сбербанк',  // Должно совпадать с mockOrgEntity.name для similarity > 0.7
    confidence: 0.85,
    validUntil: null,
    createdAt: new Date(),
  };

  const mockRelation: Partial<EntityRelation> = {
    id: 'relation-uuid-1',
    relationType: RelationType.EMPLOYMENT,
    source: RelationSource.INFERRED,
    confidence: 0.85,
  };

  const mockFactRepository = {
    count: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    }),
  };

  const mockEntityService = {
    findAll: jest.fn(),
  };

  const mockEntityRelationService = {
    findByPair: jest.fn(),
    create: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RelationInferenceService,
        {
          provide: getRepositoryToken(EntityFact),
          useValue: mockFactRepository,
        },
        {
          provide: EntityService,
          useValue: mockEntityService,
        },
        {
          provide: EntityRelationService,
          useValue: mockEntityRelationService,
        },
      ],
    }).compile();

    service = module.get<RelationInferenceService>(RelationInferenceService);
    factRepo = module.get<Repository<EntityFact>>(getRepositoryToken(EntityFact));
    entityService = module.get<EntityService>(EntityService);
    entityRelationService = module.get<EntityRelationService>(EntityRelationService);
  });

  describe('inferRelations', () => {
    it('should create employment relations from company facts', async () => {
      // Setup: company fact exists, org found, no existing relation
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([mockCompanyFact]);
      mockEntityService.findAll.mockResolvedValue({
        items: [mockOrgEntity],
        total: 1,
      });
      mockEntityRelationService.findByPair.mockResolvedValue(null);
      mockEntityRelationService.create.mockResolvedValue(mockRelation);

      const result = await service.inferRelations();

      expect(result.processed).toBe(1);
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(mockEntityRelationService.create).toHaveBeenCalledWith({
        relationType: RelationType.EMPLOYMENT,
        members: [
          { entityId: 'person-uuid-1', role: 'employee' },
          { entityId: 'org-uuid-1', role: 'employer' },
        ],
        source: RelationSource.INFERRED,
        confidence: 0.85,
        metadata: {
          inferredFrom: 'company_fact',
          sourceFactId: 'fact-uuid-1',
          sourceFactValue: 'Сбербанк',
        },
      });
    });

    it('should not create relation in dry-run mode', async () => {
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([mockCompanyFact]);
      mockEntityService.findAll.mockResolvedValue({
        items: [mockOrgEntity],
        total: 1,
      });
      mockEntityRelationService.findByPair.mockResolvedValue(null);

      const result = await service.inferRelations({ dryRun: true });

      expect(result.processed).toBe(1);
      expect(result.created).toBe(1);
      expect(result.details).toBeDefined();
      expect(result.details).toHaveLength(1);
      expect(result.details![0]).toMatchObject({
        factId: 'fact-uuid-1',
        entityId: 'person-uuid-1',
        organizationId: 'org-uuid-1',
        organizationName: 'Сбербанк',
        relationType: RelationType.EMPLOYMENT,
      });
      expect(mockEntityRelationService.create).not.toHaveBeenCalled();
    });

    it('should skip when organization not found', async () => {
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([mockCompanyFact]);
      mockEntityService.findAll.mockResolvedValue({
        items: [],
        total: 0,
      });

      const result = await service.inferRelations();

      expect(result.processed).toBe(1);
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockEntityRelationService.create).not.toHaveBeenCalled();
    });

    it('should skip when relation already exists', async () => {
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([mockCompanyFact]);
      mockEntityService.findAll.mockResolvedValue({
        items: [mockOrgEntity],
        total: 1,
      });
      mockEntityRelationService.findByPair.mockResolvedValue(mockRelation);

      const result = await service.inferRelations();

      expect(result.processed).toBe(1);
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockEntityRelationService.create).not.toHaveBeenCalled();
    });

    it('should skip facts with null value', async () => {
      const factWithNullValue = { ...mockCompanyFact, value: null };
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([factWithNullValue]);

      const result = await service.inferRelations();

      expect(result.processed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(mockEntityService.findAll).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([mockCompanyFact]);
      mockEntityService.findAll.mockRejectedValue(new Error('Database error'));

      const result = await service.inferRelations();

      expect(result.processed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].factId).toBe('fact-uuid-1');
      expect(result.errors[0].error).toBe('Database error');
    });

    it('should respect limit option', async () => {
      const facts = [
        { ...mockCompanyFact, id: 'fact-1' },
        { ...mockCompanyFact, id: 'fact-2' },
        { ...mockCompanyFact, id: 'fact-3' },
      ];
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue(facts);
      mockEntityService.findAll.mockResolvedValue({
        items: [mockOrgEntity],
        total: 1,
      });
      mockEntityRelationService.findByPair.mockResolvedValue(null);
      mockEntityRelationService.create.mockResolvedValue(mockRelation);

      await service.inferRelations({ limit: 2 });

      expect(mockFactRepository.createQueryBuilder().limit).toHaveBeenCalledWith(2);
    });

    it('should respect sinceDate option', async () => {
      const sinceDate = new Date('2025-01-01');
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([]);

      await service.inferRelations({ sinceDate });

      expect(mockFactRepository.createQueryBuilder().andWhere).toHaveBeenCalledWith(
        'f.createdAt >= :since',
        { since: sinceDate },
      );
    });
  });

  describe('getInferenceStats', () => {
    it('should return statistics about inference candidates', async () => {
      mockFactRepository.count.mockResolvedValue(10);
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([
        mockCompanyFact,
        mockCompanyFact,
        mockCompanyFact,
      ]);
      mockEntityService.findAll.mockResolvedValue({
        items: [mockOrgEntity],
        total: 5,
      });

      const stats = await service.getInferenceStats();

      expect(stats.totalCompanyFacts).toBe(10);
      expect(stats.unlinkedCompanyFacts).toBe(3);
      expect(stats.organizationsInDb).toBe(5);
    });
  });

  describe('organization matching', () => {
    it('should match organization with similar name (high similarity)', async () => {
      // Fact value: 'Сбербанк' нормализуется в 'сбербанк'
      // Org name: 'ПАО Сбербанк' нормализуется в 'сбербанк' (ПАО удаляется)
      // Similarity = 1.0 (точное совпадение после нормализации)
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([
        { ...mockCompanyFact, value: 'Сбербанк' },
      ]);
      mockEntityService.findAll.mockResolvedValue({
        items: [{ ...mockOrgEntity, name: 'ПАО Сбербанк' }],
        total: 1,
      });
      mockEntityRelationService.findByPair.mockResolvedValue(null);
      mockEntityRelationService.create.mockResolvedValue(mockRelation);

      const result = await service.inferRelations();

      expect(result.created).toBe(1);
    });

    it('should not match organization with low similarity', async () => {
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([
        { ...mockCompanyFact, value: 'Сбер' },
      ]);
      mockEntityService.findAll.mockResolvedValue({
        items: [{ ...mockOrgEntity, name: 'Газпром' }],
        total: 1,
      });

      const result = await service.inferRelations();

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('should try first word search when exact match not found', async () => {
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([
        { ...mockCompanyFact, value: 'ООО Сбербанк Технологии' },
      ]);
      // First search returns nothing
      mockEntityService.findAll
        .mockResolvedValueOnce({ items: [], total: 0 })
        // Second search (by first word) returns org
        .mockResolvedValueOnce({
          items: [mockOrgEntity],
          total: 1,
        });
      mockEntityRelationService.findByPair.mockResolvedValue(null);
      mockEntityRelationService.create.mockResolvedValue(mockRelation);

      const result = await service.inferRelations();

      // Should call findAll twice - first full name, then first word
      expect(mockEntityService.findAll).toHaveBeenCalledTimes(2);
    });

    it('should normalize company names by removing legal forms', async () => {
      mockFactRepository.createQueryBuilder().getMany.mockResolvedValue([
        { ...mockCompanyFact, value: 'ООО "Сбербанк"' },
      ]);
      mockEntityService.findAll.mockResolvedValue({
        items: [{ ...mockOrgEntity, name: 'Сбербанк' }],
        total: 1,
      });
      mockEntityRelationService.findByPair.mockResolvedValue(null);
      mockEntityRelationService.create.mockResolvedValue(mockRelation);

      const result = await service.inferRelations();

      expect(result.created).toBe(1);
    });
  });
});
