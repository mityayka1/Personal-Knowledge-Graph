import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
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
    isOwner: false,
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

  // Mock QueryBuilder for transaction operations
  const mockTransactionQueryBuilder = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    withDeleted: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  // Mock manager for transaction operations
  const mockManager = {
    findOne: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(() => mockTransactionQueryBuilder),
  };

  const mockEntityRepository = {
    createQueryBuilder: jest.fn(() => mockQueryBuilder),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
    softRemove: jest.fn(),
    recover: jest.fn(),
    manager: {
      transaction: jest.fn((callback) => callback(mockManager)),
      query: jest.fn(),
    },
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

      // identifiers is already joined via leftJoinAndSelect, so search uses 'identifiers' alias
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(entity.name ILIKE :search OR identifiers.identifierValue ILIKE :search)',
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

    it('should hide organization link if organization is soft-deleted', async () => {
      const deletedOrg = {
        id: 'org-uuid',
        name: 'Deleted Org',
        type: EntityType.ORGANIZATION,
        deletedAt: new Date(),
      };
      const entityWithDeletedOrg = {
        ...mockEntity,
        organization: deletedOrg,
        organizationId: 'org-uuid',
      };
      mockEntityRepository.findOne.mockResolvedValue(entityWithDeletedOrg);

      const result = await service.findOne('test-uuid-1');

      expect(result.organization).toBeNull();
      expect(result.organizationId).toBeNull();
    });

    it('should keep organization link if organization is not deleted', async () => {
      const activeOrg = {
        id: 'org-uuid',
        name: 'Active Org',
        type: EntityType.ORGANIZATION,
        deletedAt: null,
      };
      const entityWithOrg = {
        ...mockEntity,
        organization: activeOrg,
        organizationId: 'org-uuid',
      };
      mockEntityRepository.findOne.mockResolvedValue(entityWithOrg);

      const result = await service.findOne('test-uuid-1');

      expect(result.organization).toEqual(activeOrg);
      expect(result.organizationId).toBe('org-uuid');
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
    it('should soft delete entity', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);
      mockEntityRepository.softRemove.mockResolvedValue({ ...mockEntity, deletedAt: new Date() });

      const result = await service.remove('test-uuid-1');

      expect(result.deleted).toBe(true);
      expect(result.id).toBe('test-uuid-1');
      expect(result.deletedAt).toBeDefined();
      expect(mockEntityRepository.softRemove).toHaveBeenCalledWith(mockEntity);
    });

    it('should prevent deleting owner entity', async () => {
      const ownerEntity = { ...mockEntity, isOwner: true };
      mockEntityRepository.findOne.mockResolvedValue(ownerEntity);

      await expect(service.remove('test-uuid-1')).rejects.toThrow(BadRequestException);
      expect(mockEntityRepository.softRemove).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if entity not found', async () => {
      mockEntityRepository.findOne.mockResolvedValue(null);

      await expect(service.remove('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('merge', () => {
    it('should merge two entities using soft delete', async () => {
      const sourceEntity = { ...mockEntity, id: 'source-uuid' };
      const targetEntity = { ...mockEntity, id: 'target-uuid' };

      mockEntityRepository.findOne
        .mockResolvedValueOnce(sourceEntity)
        .mockResolvedValueOnce(targetEntity);
      mockIdentifierService.moveToEntity.mockResolvedValue(2);
      mockFactService.moveToEntity.mockResolvedValue(3);
      mockEntityRepository.softRemove.mockResolvedValue({ ...sourceEntity, deletedAt: new Date() });

      const result = await service.merge('source-uuid', 'target-uuid');

      expect(result).toEqual({
        mergedEntityId: 'target-uuid',
        sourceEntityDeleted: true,
        identifiersMoved: 2,
        factsMoved: 3,
      });
      expect(mockEntityRepository.softRemove).toHaveBeenCalledWith(sourceEntity);
    });

    it('should throw ConflictException when merging with itself', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);

      await expect(service.merge('test-uuid-1', 'test-uuid-1')).rejects.toThrow(ConflictException);
    });

    it('should prevent merging owner entity', async () => {
      const ownerEntity = { ...mockEntity, id: 'owner-uuid', isOwner: true };
      const targetEntity = { ...mockEntity, id: 'target-uuid' };

      mockEntityRepository.findOne
        .mockResolvedValueOnce(ownerEntity)
        .mockResolvedValueOnce(targetEntity);

      await expect(service.merge('owner-uuid', 'target-uuid')).rejects.toThrow(BadRequestException);
      expect(mockEntityRepository.softRemove).not.toHaveBeenCalled();
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

    it('should throw BadRequestException when depth > 1', async () => {
      mockEntityRepository.findOne.mockResolvedValue(centralEntity);
      mockRelationService.findByEntity.mockResolvedValue([]);

      await expect(service.getGraph('central-uuid', 2)).rejects.toThrow(BadRequestException);
      await expect(service.getGraph('central-uuid', 2)).rejects.toThrow(
        'depth > 1 is not yet supported',
      );
    });

    it('should filter out orphaned edges (member.entity is null)', async () => {
      mockEntityRepository.findOne.mockResolvedValue(centralEntity);
      mockRelationService.findByEntity.mockResolvedValue([
        {
          id: 'relation-1',
          relationType: RelationType.FRIENDSHIP,
          members: [
            { entityId: 'central-uuid', role: 'friend', validUntil: null, entity: centralEntity },
            { entityId: 'orphan-uuid', role: 'friend', validUntil: null, entity: null }, // Entity not loaded/deleted
          ],
        },
      ]);

      const result = await service.getGraph('central-uuid');

      // Only central entity node, no edge (orphan has no entity data)
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
    });

    it('should include role in edge ID for N-ary relations to prevent collision', async () => {
      mockEntityRepository.findOne.mockResolvedValue(centralEntity);
      mockRelationService.findByEntity.mockResolvedValue([
        {
          id: 'team-relation',
          relationType: RelationType.TEAM,
          members: [
            { entityId: 'central-uuid', role: 'lead', validUntil: null, entity: centralEntity },
            { entityId: 'related-uuid', role: 'member', validUntil: null, entity: relatedEntity },
            { entityId: 'org-uuid', role: 'sponsor', validUntil: null, entity: orgEntity },
          ],
        },
      ]);

      const result = await service.getGraph('central-uuid');

      // N-ary edge IDs should include role to prevent collision
      expect(result.edges).toHaveLength(2);
      expect(result.edges.map((e) => e.id)).toContain('team-relation-related-uuid-member');
      expect(result.edges.map((e) => e.id)).toContain('team-relation-org-uuid-sponsor');
    });
  });

  describe('getGraph without relationService', () => {
    let serviceWithoutRelations: EntityService;

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
          // EntityRelationService NOT provided
        ],
      }).compile();

      serviceWithoutRelations = module.get<EntityService>(EntityService);
    });

    it('should throw ServiceUnavailableException when relationService is undefined', async () => {
      await expect(serviceWithoutRelations.getGraph('any-uuid')).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(serviceWithoutRelations.getGraph('any-uuid')).rejects.toThrow(
        'Entity graph is temporarily unavailable',
      );
    });
  });

  describe('findMe', () => {
    it('should return owner entity when exists', async () => {
      const ownerEntity = { ...mockEntity, id: 'owner-uuid', isOwner: true };
      mockEntityRepository.findOne.mockResolvedValue(ownerEntity);

      const result = await service.findMe();

      expect(result).toEqual(ownerEntity);
      expect(entityRepo.findOne).toHaveBeenCalledWith({
        where: { isOwner: true },
        relations: ['organization', 'identifiers', 'facts'],
      });
    });

    it('should return null when no owner is set', async () => {
      mockEntityRepository.findOne.mockResolvedValue(null);

      const result = await service.findMe();

      expect(result).toBeNull();
    });
  });

  describe('setOwner', () => {
    it('should set entity as owner when no current owner', async () => {
      const newOwner = { ...mockEntity, id: 'new-owner-uuid', isOwner: false };
      const updatedOwner = { ...newOwner, isOwner: true };

      // entityRepo.findOne for validation and final return
      mockEntityRepository.findOne
        .mockResolvedValueOnce(newOwner) // findOne(id) validation
        .mockResolvedValueOnce(updatedOwner); // final findOne return

      // manager operations inside transaction
      mockManager.findOne
        .mockResolvedValueOnce(null) // no current owner
        .mockResolvedValueOnce(newOwner); // find entity to set
      mockManager.save.mockResolvedValue(updatedOwner);

      const result = await service.setOwner('new-owner-uuid');

      expect(result.isOwner).toBe(true);
      expect(mockManager.save).toHaveBeenCalledTimes(1);
      expect(mockEntityRepository.manager.transaction).toHaveBeenCalled();
    });

    it('should unset current owner and set new owner', async () => {
      const currentOwner = { ...mockEntity, id: 'current-owner-uuid', isOwner: true };
      const newOwner = { ...mockEntity, id: 'new-owner-uuid', isOwner: false };
      const updatedNewOwner = { ...newOwner, isOwner: true };

      // entityRepo.findOne for validation and final return
      mockEntityRepository.findOne
        .mockResolvedValueOnce(newOwner) // findOne(id) validation
        .mockResolvedValueOnce(updatedNewOwner); // final findOne return

      // manager operations inside transaction
      mockManager.findOne
        .mockResolvedValueOnce(currentOwner) // find current owner
        .mockResolvedValueOnce(newOwner); // find entity to set
      mockManager.save
        .mockResolvedValueOnce({ ...currentOwner, isOwner: false }) // save old owner
        .mockResolvedValueOnce(updatedNewOwner); // save new owner

      const result = await service.setOwner('new-owner-uuid');

      expect(result.isOwner).toBe(true);
      expect(mockManager.save).toHaveBeenCalledTimes(2);
      // First call unsets old owner
      expect(mockManager.save).toHaveBeenNthCalledWith(1, expect.objectContaining({ isOwner: false }));
      // Second call sets new owner
      expect(mockManager.save).toHaveBeenNthCalledWith(2, expect.objectContaining({ isOwner: true }));
    });

    it('should not unset if setting same entity as owner', async () => {
      const currentOwner = { ...mockEntity, id: 'same-uuid', isOwner: true };

      // entityRepo.findOne for validation and final return
      mockEntityRepository.findOne
        .mockResolvedValueOnce(currentOwner) // findOne(id) validation
        .mockResolvedValueOnce(currentOwner); // final findOne return

      // manager operations inside transaction
      mockManager.findOne
        .mockResolvedValueOnce(currentOwner) // find current owner (same entity)
        .mockResolvedValueOnce(currentOwner); // find entity to set
      mockManager.save.mockResolvedValue(currentOwner);

      const result = await service.setOwner('same-uuid');

      expect(result.isOwner).toBe(true);
      // Only one save call (not unsetting since same entity)
      expect(mockManager.save).toHaveBeenCalledTimes(1);
    });

    it('should throw NotFoundException for non-existent entity', async () => {
      mockEntityRepository.findOne.mockResolvedValue(null);

      await expect(service.setOwner('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore soft-deleted entity with pessimistic lock', async () => {
      const deletedEntity = { ...mockEntity, deletedAt: new Date() };
      const restoredEntity = { ...mockEntity, deletedAt: null };

      // Mock transaction query builder chain
      mockTransactionQueryBuilder.getOne.mockResolvedValue(deletedEntity);
      mockManager.save.mockResolvedValue(restoredEntity);
      mockManager.findOne.mockResolvedValue(restoredEntity);

      const result = await service.restore('test-uuid-1');

      expect(result.deletedAt).toBeNull();
      expect(mockTransactionQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(mockTransactionQueryBuilder.withDeleted).toHaveBeenCalled();
      expect(mockManager.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException if entity not found', async () => {
      mockTransactionQueryBuilder.getOne.mockResolvedValue(null);

      await expect(service.restore('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if entity is not deleted', async () => {
      const activeEntity = { ...mockEntity, deletedAt: null };
      mockTransactionQueryBuilder.getOne.mockResolvedValue(activeEntity);

      await expect(service.restore('test-uuid-1')).rejects.toThrow(BadRequestException);
      expect(mockManager.save).not.toHaveBeenCalled();
    });
  });

  describe('findDeleted', () => {
    it('should return soft-deleted entities', async () => {
      const deletedEntities = [
        { ...mockEntity, id: 'deleted-1', deletedAt: new Date() },
        { ...mockEntity, id: 'deleted-2', deletedAt: new Date() },
      ];
      mockEntityRepository.findAndCount.mockResolvedValue([deletedEntities, 2]);

      const result = await service.findDeleted({ limit: 10 });

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.limit).toBe(10);
      expect(mockEntityRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ withDeleted: true }),
      );
    });

    it('should use default pagination', async () => {
      mockEntityRepository.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.findDeleted({});

      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });
  });

  describe('hardDelete', () => {
    it('should permanently delete entity without references', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);
      mockEntityRepository.manager.query
        .mockResolvedValueOnce([{ count: '0' }]) // activities
        .mockResolvedValueOnce([{ count: '0' }]) // commitments
        .mockResolvedValueOnce([{ count: '0' }]); // participations
      mockEntityRepository.remove.mockResolvedValue(mockEntity);

      const result = await service.hardDelete('test-uuid-1', true);

      expect(result.hardDeleted).toBe(true);
      expect(result.id).toBe('test-uuid-1');
      expect(mockEntityRepository.remove).toHaveBeenCalledWith(mockEntity);
    });

    it('should reject without confirm=true', async () => {
      await expect(service.hardDelete('test-uuid-1', false)).rejects.toThrow(BadRequestException);
      await expect(service.hardDelete('test-uuid-1', false)).rejects.toThrow(
        'Hard delete requires explicit confirmation',
      );
    });

    it('should throw NotFoundException if entity not found', async () => {
      mockEntityRepository.findOne.mockResolvedValue(null);

      await expect(service.hardDelete('non-existent', true)).rejects.toThrow(NotFoundException);
    });

    it('should reject if entity has activity references', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);
      mockEntityRepository.manager.query
        .mockResolvedValueOnce([{ count: '5' }]) // activities
        .mockResolvedValueOnce([{ count: '0' }]) // commitments
        .mockResolvedValueOnce([{ count: '0' }]); // participations

      const promise = service.hardDelete('test-uuid-1', true);
      await expect(promise).rejects.toThrow(ConflictException);
      expect(mockEntityRepository.remove).not.toHaveBeenCalled();
    });

    it('should reject if entity has commitment references', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);
      mockEntityRepository.manager.query
        .mockResolvedValueOnce([{ count: '0' }]) // activities
        .mockResolvedValueOnce([{ count: '3' }]) // commitments
        .mockResolvedValueOnce([{ count: '0' }]); // participations

      await expect(service.hardDelete('test-uuid-1', true)).rejects.toThrow(ConflictException);
    });

    it('should reject if entity has participation references', async () => {
      mockEntityRepository.findOne.mockResolvedValue(mockEntity);
      mockEntityRepository.manager.query
        .mockResolvedValueOnce([{ count: '0' }]) // activities
        .mockResolvedValueOnce([{ count: '0' }]) // commitments
        .mockResolvedValueOnce([{ count: '10' }]); // participations

      await expect(service.hardDelete('test-uuid-1', true)).rejects.toThrow(ConflictException);
    });
  });
});
