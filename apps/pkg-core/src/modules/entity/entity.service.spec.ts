import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { EntityService } from './entity.service';
import { EntityIdentifierService } from './entity-identifier/entity-identifier.service';
import { EntityFactService } from './entity-fact/entity-fact.service';
import { EntityRelationService } from './entity-relation/entity-relation.service';
import { EntityRecord, EntityType, RelationType } from '@pkg/entities';

describe('EntityService', () => {
  let service: EntityService;
  let entityRepo: Repository<EntityRecord>;
  let identifierService: EntityIdentifierService;
  let factService: EntityFactService;
  let relationService: EntityRelationService;

  const mockEntity = {
    id: 'test-uuid-1',
    type: EntityType.PERSON,
    name: 'John Doe',
    organizationId: null,
    notes: null,
    isBot: false,
    identifiers: [],
    facts: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[mockEntity], 1]),
  };

  const mockEntityRepository = {
    createQueryBuilder: jest.fn(() => mockQueryBuilder),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
  };

  const mockIdentifierService = {
    create: jest.fn(),
    moveToEntity: jest.fn(),
  };

  const mockFactService = {
    create: jest.fn(),
    moveToEntity: jest.fn(),
  };

  const mockRelationService = {
    findByEntity: jest.fn(),
    findByType: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityService,
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: mockEntityRepository,
        },
        {
          provide: EntityIdentifierService,
          useValue: mockIdentifierService,
        },
        {
          provide: EntityFactService,
          useValue: mockFactService,
        },
        {
          provide: EntityRelationService,
          useValue: mockRelationService,
        },
      ],
    }).compile();

    service = module.get<EntityService>(EntityService);
    entityRepo = module.get<Repository<EntityRecord>>(getRepositoryToken(EntityRecord));
    identifierService = module.get<EntityIdentifierService>(EntityIdentifierService);
    factService = module.get<EntityFactService>(EntityFactService);
    relationService = module.get<EntityRelationService>(EntityRelationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('should return paginated entities', async () => {
      const result = await service.findAll({ limit: 50, offset: 0 });

      expect(result).toEqual({
        items: [mockEntity],
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    it('should filter by type', async () => {
      await service.findAll({ type: EntityType.PERSON });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('entity.type = :type', { type: EntityType.PERSON });
    });

    it('should filter by search', async () => {
      await service.findAll({ search: 'John' });

      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith('entity.identifiers', 'identifier');
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(entity.name ILIKE :search OR identifier.identifierValue ILIKE :search)',
        { search: '%John%' },
      );
    });
  });

  describe('findOne', () => {
    it('should return entity with relations', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);

      const result = await service.findOne('test-uuid-1');

      expect(result).toEqual(mockEntity);
      expect(entityRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'test-uuid-1' },
        relations: ['organization', 'identifiers', 'facts'],
      });
    });

    it('should throw NotFoundException if not found', async () => {
      mockEntityRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('should create entity without identifiers or facts', async () => {
      const newEntity = { ...mockEntity, id: 'new-uuid' };
      mockEntityRepository.create.mockReturnValue(newEntity);
      mockEntityRepository.save.mockResolvedValue(newEntity);
      mockEntityRepository.findOne.mockResolvedValue(newEntity);

      const result = await service.create({
        type: EntityType.PERSON,
        name: 'Jane Doe',
      });

      expect(result).toEqual(newEntity);
      expect(entityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EntityType.PERSON,
          name: 'Jane Doe',
        }),
      );
    });

    it('should create entity with identifiers', async () => {
      const newEntity = { ...mockEntity, id: 'new-uuid' };
      mockEntityRepository.create.mockReturnValue(newEntity);
      mockEntityRepository.save.mockResolvedValue(newEntity);
      mockEntityRepository.findOne.mockResolvedValue(newEntity);
      mockIdentifierService.create.mockResolvedValue({});

      await service.create({
        type: EntityType.PERSON,
        name: 'Jane Doe',
        identifiers: [{ type: 'phone' as any, value: '+1234567890' }],
      });

      expect(identifierService.create).toHaveBeenCalledWith('new-uuid', { type: 'phone', value: '+1234567890' });
    });

    it('should create entity with isBot: true', async () => {
      const botEntity = { ...mockEntity, id: 'bot-uuid', isBot: true };
      mockEntityRepository.create.mockReturnValue(botEntity);
      mockEntityRepository.save.mockResolvedValue(botEntity);
      mockEntityRepository.findOne.mockResolvedValue(botEntity);

      const result = await service.create({
        type: EntityType.PERSON,
        name: 'Test Bot',
        isBot: true,
      });

      expect(result.isBot).toBe(true);
      expect(entityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isBot: true }),
      );
    });

    it('should default isBot to false when not provided', async () => {
      const humanEntity = { ...mockEntity, id: 'human-uuid', isBot: false };
      mockEntityRepository.create.mockReturnValue(humanEntity);
      mockEntityRepository.save.mockResolvedValue(humanEntity);
      mockEntityRepository.findOne.mockResolvedValue(humanEntity);

      const result = await service.create({
        type: EntityType.PERSON,
        name: 'Human User',
      });

      expect(result.isBot).toBe(false);
      expect(entityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isBot: false }),
      );
    });
  });

  describe('update', () => {
    it('should update entity fields', async () => {
      mockEntityRepository.findOne.mockResolvedValue({ ...mockEntity });
      mockEntityRepository.save.mockResolvedValue({ ...mockEntity, name: 'Updated Name' });

      const result = await service.update('test-uuid-1', { name: 'Updated Name' });

      expect(entityRepo.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated Name');
    });

    it('should throw NotFoundException if entity not found', async () => {
      mockEntityRepository.findOne.mockResolvedValue(null);

      await expect(service.update('non-existent', { name: 'Test' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should remove entity', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);
      mockEntityRepository.remove.mockResolvedValue(mockEntity);

      const result = await service.remove('test-uuid-1');

      expect(result).toEqual({ deleted: true, id: 'test-uuid-1' });
      expect(entityRepo.remove).toHaveBeenCalledWith(mockEntity);
    });
  });

  describe('merge', () => {
    it('should merge two entities', async () => {
      const sourceEntity = { ...mockEntity, id: 'source-uuid' };
      const targetEntity = { ...mockEntity, id: 'target-uuid' };

      mockEntityRepository.findOne
        .mockResolvedValueOnce(sourceEntity)
        .mockResolvedValueOnce(targetEntity);
      mockIdentifierService.moveToEntity.mockResolvedValue(2);
      mockFactService.moveToEntity.mockResolvedValue(3);
      mockEntityRepository.remove.mockResolvedValue(sourceEntity);

      const result = await service.merge('source-uuid', 'target-uuid');

      expect(result).toEqual({
        mergedEntityId: 'target-uuid',
        sourceEntityDeleted: true,
        identifiersMoved: 2,
        factsMoved: 3,
      });
    });

    it('should throw ConflictException when merging with itself', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);

      await expect(service.merge('test-uuid-1', 'test-uuid-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('getGraph', () => {
    const centralEntity = {
      ...mockEntity,
      id: 'central-uuid',
      name: 'Central Person',
      profilePhoto: 'photo.jpg',
    };

    const relatedEntity = {
      id: 'related-uuid',
      name: 'Related Person',
      type: EntityType.PERSON,
      profilePhoto: null,
    };

    const orgEntity = {
      id: 'org-uuid',
      name: 'Company Inc',
      type: EntityType.ORGANIZATION,
      profilePhoto: null,
    };

    it('should return graph with central entity', async () => {
      mockEntityRepository.findOne.mockResolvedValue(centralEntity);
      mockRelationService.findByEntity.mockResolvedValue([]);

      const result = await service.getGraph('central-uuid');

      expect(result).toEqual({
        centralEntityId: 'central-uuid',
        nodes: [
          {
            id: 'central-uuid',
            name: 'Central Person',
            type: EntityType.PERSON,
            profilePhoto: 'photo.jpg',
          },
        ],
        edges: [],
      });
    });

    it('should include related entities from binary relations', async () => {
      mockEntityRepository.findOne.mockResolvedValue(centralEntity);
      mockRelationService.findByEntity.mockResolvedValue([
        {
          id: 'relation-1',
          relationType: RelationType.FRIENDSHIP,
          members: [
            { entityId: 'central-uuid', role: 'friend', validUntil: null, entity: centralEntity },
            { entityId: 'related-uuid', role: 'friend', validUntil: null, entity: relatedEntity },
          ],
        },
      ]);

      const result = await service.getGraph('central-uuid');

      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]).toEqual({
        id: 'relation-1',
        source: 'central-uuid',
        target: 'related-uuid',
        relationType: RelationType.FRIENDSHIP,
        sourceRole: 'friend',
        targetRole: 'friend',
      });
    });

    it('should handle N-ary relations (more than 2 members)', async () => {
      mockEntityRepository.findOne.mockResolvedValue(centralEntity);
      mockRelationService.findByEntity.mockResolvedValue([
        {
          id: 'team-relation',
          relationType: RelationType.TEAM,
          members: [
            { entityId: 'central-uuid', role: 'member', validUntil: null, entity: centralEntity },
            { entityId: 'related-uuid', role: 'member', validUntil: null, entity: relatedEntity },
            { entityId: 'org-uuid', role: 'lead', validUntil: null, entity: orgEntity },
          ],
        },
      ]);

      const result = await service.getGraph('central-uuid');

      expect(result.nodes).toHaveLength(3);
      expect(result.edges).toHaveLength(2);
      // Central entity should have edges to all other members
      expect(result.edges.map((e) => e.target)).toContain('related-uuid');
      expect(result.edges.map((e) => e.target)).toContain('org-uuid');
    });

    it('should exclude members with validUntil (soft-deleted)', async () => {
      mockEntityRepository.findOne.mockResolvedValue(centralEntity);
      mockRelationService.findByEntity.mockResolvedValue([
        {
          id: 'relation-1',
          relationType: RelationType.EMPLOYMENT,
          members: [
            { entityId: 'central-uuid', role: 'employee', validUntil: null, entity: centralEntity },
            { entityId: 'org-uuid', role: 'employer', validUntil: new Date(), entity: orgEntity }, // Soft-deleted
          ],
        },
      ]);

      const result = await service.getGraph('central-uuid');

      // Only central entity, no edges (employer is soft-deleted)
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
    });
  });
});
