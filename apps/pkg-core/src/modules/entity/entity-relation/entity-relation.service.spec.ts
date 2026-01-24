import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityRelationService } from './entity-relation.service';
import {
  EntityRelation,
  EntityRelationMember,
  RelationType,
  RelationSource,
} from '@pkg/entities';

describe('EntityRelationService', () => {
  let service: EntityRelationService;
  let relationRepo: Repository<EntityRelation>;
  let memberRepo: Repository<EntityRelationMember>;

  const mockRelation: Partial<EntityRelation> = {
    id: 'relation-uuid-1',
    relationType: RelationType.EMPLOYMENT,
    source: RelationSource.EXTRACTED,
    confidence: 0.9,
    members: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockMember: Partial<EntityRelationMember> = {
    relationId: 'relation-uuid-1',
    entityId: 'entity-uuid-1',
    role: 'employee',
    label: 'John',
    validUntil: null,
  };

  const mockRelationRepository = {
    create: jest.fn().mockImplementation((data) => ({ ...mockRelation, ...data })),
    save: jest.fn().mockImplementation((data) => Promise.resolve({ ...mockRelation, ...data })),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  };

  const mockMemberRepository = {
    create: jest.fn().mockImplementation((data) => ({ ...mockMember, ...data })),
    save: jest.fn().mockImplementation((data) => Promise.resolve({ ...mockMember, ...data })),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityRelationService,
        {
          provide: getRepositoryToken(EntityRelation),
          useValue: mockRelationRepository,
        },
        {
          provide: getRepositoryToken(EntityRelationMember),
          useValue: mockMemberRepository,
        },
      ],
    }).compile();

    service = module.get<EntityRelationService>(EntityRelationService);
    relationRepo = module.get<Repository<EntityRelation>>(getRepositoryToken(EntityRelation));
    memberRepo = module.get<Repository<EntityRelationMember>>(getRepositoryToken(EntityRelationMember));
  });

  describe('create', () => {
    it('should create a new relation with valid members', async () => {
      const dto = {
        relationType: RelationType.EMPLOYMENT,
        members: [
          { entityId: 'entity-1', role: 'employee' },
          { entityId: 'entity-2', role: 'employer' },
        ],
        source: RelationSource.EXTRACTED,
        confidence: 0.9,
      };

      // Mock no duplicate found
      mockRelationRepository.createQueryBuilder().getMany.mockResolvedValue([]);

      const result = await service.create(dto);

      expect(mockRelationRepository.create).toHaveBeenCalled();
      expect(mockRelationRepository.save).toHaveBeenCalled();
      expect(result.relationType).toBe(RelationType.EMPLOYMENT);
    });

    it('should throw BadRequestException for invalid role', async () => {
      const dto = {
        relationType: RelationType.EMPLOYMENT,
        members: [
          { entityId: 'entity-1', role: 'invalid_role' },
          { entityId: 'entity-2', role: 'employer' },
        ],
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid cardinality', async () => {
      const dto = {
        relationType: RelationType.MARRIAGE, // Marriage requires exactly 2
        members: [
          { entityId: 'entity-1', role: 'spouse' },
          { entityId: 'entity-2', role: 'spouse' },
          { entityId: 'entity-3', role: 'spouse' }, // Too many
        ],
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('should return existing relation if duplicate found', async () => {
      const existingRelation = {
        ...mockRelation,
        members: [
          { entityId: 'entity-1', role: 'employee', validUntil: null },
          { entityId: 'entity-2', role: 'employer', validUntil: null },
        ],
      };

      mockRelationRepository.createQueryBuilder().getMany.mockResolvedValue([existingRelation]);

      const dto = {
        relationType: RelationType.EMPLOYMENT,
        members: [
          { entityId: 'entity-1', role: 'employee' },
          { entityId: 'entity-2', role: 'employer' },
        ],
      };

      const result = await service.create(dto);

      expect(result.id).toBe(existingRelation.id);
      expect(mockRelationRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('should return relation when found', async () => {
      mockRelationRepository.findOne.mockResolvedValue(mockRelation);

      const result = await service.findById('relation-uuid-1');

      expect(result).toEqual(mockRelation);
      expect(mockRelationRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'relation-uuid-1' },
        relations: ['members', 'members.entity'],
      });
    });

    it('should return null when not found', async () => {
      mockRelationRepository.findOne.mockResolvedValue(null);

      const result = await service.findById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('findByEntity', () => {
    it('should return empty array when entity has no relations', async () => {
      mockMemberRepository.find.mockResolvedValue([]);

      const result = await service.findByEntity('entity-uuid-1');

      expect(result).toEqual([]);
    });

    it('should return relations for entity', async () => {
      mockMemberRepository.find.mockResolvedValue([{ relationId: 'relation-1' }]);
      mockRelationRepository.createQueryBuilder().getMany.mockResolvedValue([mockRelation]);

      const result = await service.findByEntity('entity-uuid-1');

      expect(result).toHaveLength(1);
    });
  });

  describe('removeMember', () => {
    it('should soft delete member by setting validUntil', async () => {
      mockMemberRepository.update.mockResolvedValue({ affected: 1 });

      const result = await service.removeMember('relation-1', 'entity-1', 'employee');

      expect(result).toBe(true);
      expect(mockMemberRepository.update).toHaveBeenCalled();
    });

    it('should return false when member not found', async () => {
      mockMemberRepository.update.mockResolvedValue({ affected: 0 });

      const result = await service.removeMember('relation-1', 'non-existent', 'employee');

      expect(result).toBe(false);
    });
  });

  describe('formatForContext', () => {
    it('should return empty string for no relations', () => {
      const result = service.formatForContext([]);

      expect(result).toBe('');
    });

    it('should format relations correctly', () => {
      const relations = [
        {
          relation: mockRelation as EntityRelation,
          otherMembers: [
            {
              entityId: 'entity-2',
              role: 'employer',
              label: 'Acme Corp',
              entity: { name: 'Acme Corporation' },
            } as EntityRelationMember,
          ],
          currentRole: 'employee',
        },
      ];

      const result = service.formatForContext(relations);

      expect(result).toContain('СВЯЗИ:');
      expect(result).toContain('employer');
      expect(result).toContain('Acme Corporation');
    });
  });
});
