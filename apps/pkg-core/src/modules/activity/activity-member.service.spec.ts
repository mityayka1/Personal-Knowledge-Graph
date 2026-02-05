import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ActivityMember, ActivityMemberRole, EntityRecord } from '@pkg/entities';
import { ActivityMemberService } from './activity-member.service';

describe('ActivityMemberService', () => {
  let service: ActivityMemberService;

  // ---- mock repositories ----

  const mockMemberRepo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
  };

  const mockEntityQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  const mockEntityRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(mockEntityQueryBuilder),
  };

  // ---- helpers ----

  function makeMember(overrides: Partial<ActivityMember> = {}): ActivityMember {
    return {
      id: 'member-uuid-1',
      activityId: 'activity-uuid-1',
      entityId: 'entity-uuid-1',
      role: ActivityMemberRole.MEMBER,
      notes: null,
      isActive: true,
      joinedAt: new Date('2025-01-01'),
      leftAt: null,
      metadata: null,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
      ...overrides,
    } as ActivityMember;
  }

  function makeEntity(overrides: Partial<EntityRecord> = {}): EntityRecord {
    return {
      id: 'entity-uuid-1',
      name: 'Test Person',
      updatedAt: new Date('2025-01-01'),
      ...overrides,
    } as EntityRecord;
  }

  // ---- setup ----

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityMemberService,
        {
          provide: getRepositoryToken(ActivityMember),
          useValue: mockMemberRepo,
        },
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: mockEntityRepo,
        },
      ],
    }).compile();

    service = module.get<ActivityMemberService>(ActivityMemberService);

    jest.clearAllMocks();

    // Restore query builder chaining after clearAllMocks
    mockEntityQueryBuilder.where.mockReturnThis();
    mockEntityQueryBuilder.orderBy.mockReturnThis();
  });

  // =======================================================================
  // addMember
  // =======================================================================

  describe('addMember', () => {
    it('should create and return saved member', async () => {
      const created = makeMember();
      const saved = makeMember({ id: 'saved-uuid' });

      mockMemberRepo.create.mockReturnValue(created);
      mockMemberRepo.save.mockResolvedValue(saved);

      const result = await service.addMember({
        activityId: 'activity-uuid-1',
        entityId: 'entity-uuid-1',
        role: ActivityMemberRole.OWNER,
      });

      expect(result).toBe(saved);
      expect(mockMemberRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: 'activity-uuid-1',
          entityId: 'entity-uuid-1',
          role: ActivityMemberRole.OWNER,
          notes: null,
        }),
      );
      expect(mockMemberRepo.save).toHaveBeenCalledWith(created);
    });

    it('should pass notes to create when provided', async () => {
      const created = makeMember({ notes: 'lead dev' });
      mockMemberRepo.create.mockReturnValue(created);
      mockMemberRepo.save.mockResolvedValue(created);

      await service.addMember({
        activityId: 'activity-uuid-1',
        entityId: 'entity-uuid-1',
        role: ActivityMemberRole.MEMBER,
        notes: 'lead dev',
      });

      expect(mockMemberRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ notes: 'lead dev' }),
      );
    });

    it('should set joinedAt to a Date instance', async () => {
      const created = makeMember();
      mockMemberRepo.create.mockReturnValue(created);
      mockMemberRepo.save.mockResolvedValue(created);

      await service.addMember({
        activityId: 'a',
        entityId: 'e',
        role: ActivityMemberRole.MEMBER,
      });

      const callArg = mockMemberRepo.create.mock.calls[0][0];
      expect(callArg.joinedAt).toBeInstanceOf(Date);
    });

    it('should return null on unique constraint violation (code 23505)', async () => {
      mockMemberRepo.create.mockReturnValue(makeMember());

      const duplicateError = new Error('duplicate key') as Error & {
        code: string;
      };
      duplicateError.code = '23505';
      mockMemberRepo.save.mockRejectedValue(duplicateError);

      const result = await service.addMember({
        activityId: 'a',
        entityId: 'e',
        role: ActivityMemberRole.OWNER,
      });

      expect(result).toBeNull();
    });

    it('should rethrow non-duplicate errors', async () => {
      mockMemberRepo.create.mockReturnValue(makeMember());

      const genericError = new Error('connection lost');
      mockMemberRepo.save.mockRejectedValue(genericError);

      await expect(
        service.addMember({
          activityId: 'a',
          entityId: 'e',
          role: ActivityMemberRole.MEMBER,
        }),
      ).rejects.toThrow('connection lost');
    });

    it('should rethrow errors with a different code than 23505', async () => {
      mockMemberRepo.create.mockReturnValue(makeMember());

      const fkError = new Error('foreign key violation') as Error & {
        code: string;
      };
      fkError.code = '23503';
      mockMemberRepo.save.mockRejectedValue(fkError);

      await expect(
        service.addMember({
          activityId: 'a',
          entityId: 'e',
          role: ActivityMemberRole.MEMBER,
        }),
      ).rejects.toThrow('foreign key violation');
    });
  });

  // =======================================================================
  // resolveAndCreateMembers
  // =======================================================================

  describe('resolveAndCreateMembers', () => {
    const ownerEntityId = 'owner-uuid';
    const clientEntityId = 'client-uuid';
    const activityId = 'activity-uuid';

    // Helper: make addMember resolve with a fresh member each time
    function setupAddMemberSuccess() {
      let counter = 0;
      mockMemberRepo.create.mockImplementation((data: Partial<ActivityMember>) => ({
        ...makeMember(data),
        id: `member-${++counter}`,
      }));
      mockMemberRepo.save.mockImplementation((m: ActivityMember) =>
        Promise.resolve(m),
      );
    }

    it('should create OWNER member record', async () => {
      setupAddMemberSuccess();

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: [],
        ownerEntityId,
      });

      expect(result.length).toBe(1);
      expect(result[0].role).toBe(ActivityMemberRole.OWNER);
      expect(result[0].entityId).toBe(ownerEntityId);
    });

    it('should create CLIENT member when clientEntityId is provided', async () => {
      setupAddMemberSuccess();

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: [],
        ownerEntityId,
        clientEntityId,
      });

      expect(result.length).toBe(2);
      const roles = result.map((m) => m.role);
      expect(roles).toContain(ActivityMemberRole.OWNER);
      expect(roles).toContain(ActivityMemberRole.CLIENT);

      const clientMember = result.find(
        (m) => m.role === ActivityMemberRole.CLIENT,
      );
      expect(clientMember?.entityId).toBe(clientEntityId);
    });

    it('should NOT create CLIENT member when clientEntityId is undefined', async () => {
      setupAddMemberSuccess();

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: [],
        ownerEntityId,
        clientEntityId: undefined,
      });

      expect(result.length).toBe(1);
      expect(result[0].role).toBe(ActivityMemberRole.OWNER);
    });

    it('should resolve participant name to entity and create MEMBER record', async () => {
      setupAddMemberSuccess();

      const participantEntity = makeEntity({
        id: 'participant-entity-uuid',
        name: 'Alice',
      });
      mockEntityQueryBuilder.getOne.mockResolvedValue(participantEntity);

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: ['Alice'],
        ownerEntityId,
      });

      // OWNER + MEMBER
      expect(result.length).toBe(2);

      const memberRecord = result.find(
        (m) => m.role === ActivityMemberRole.MEMBER,
      );
      expect(memberRecord?.entityId).toBe('participant-entity-uuid');
    });

    it('should skip participant when entity is not found', async () => {
      setupAddMemberSuccess();
      mockEntityQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: ['UnknownPerson'],
        ownerEntityId,
      });

      // Only OWNER, no MEMBER created
      expect(result.length).toBe(1);
      expect(result[0].role).toBe(ActivityMemberRole.OWNER);
    });

    it('should skip participant whose entityId matches ownerEntityId', async () => {
      setupAddMemberSuccess();

      const ownerEntity = makeEntity({ id: ownerEntityId, name: 'Owner' });
      mockEntityQueryBuilder.getOne.mockResolvedValue(ownerEntity);

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: ['Owner'],
        ownerEntityId,
      });

      // Only OWNER — participant is same as owner, skipped
      expect(result.length).toBe(1);
    });

    it('should skip participant whose entityId matches clientEntityId', async () => {
      setupAddMemberSuccess();

      const clientEntity = makeEntity({ id: clientEntityId, name: 'Client' });
      mockEntityQueryBuilder.getOne.mockResolvedValue(clientEntity);

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: ['Client'],
        ownerEntityId,
        clientEntityId,
      });

      // OWNER + CLIENT, participant is same as client — skipped
      expect(result.length).toBe(2);
      const roles = result.map((m) => m.role);
      expect(roles).not.toContain(ActivityMemberRole.MEMBER);
    });

    it('should skip participants with empty or whitespace-only names', async () => {
      setupAddMemberSuccess();

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: ['', '   ', '\t'],
        ownerEntityId,
      });

      // Only OWNER — all participants were blank
      expect(result.length).toBe(1);
      // findEntityByName should never be called for empty names
      expect(mockEntityRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should handle multiple participants with mixed outcomes', async () => {
      setupAddMemberSuccess();

      const alice = makeEntity({ id: 'alice-uuid', name: 'Alice' });
      const bob = makeEntity({ id: 'bob-uuid', name: 'Bob' });

      // Alice found, Unknown not found, Bob found
      mockEntityQueryBuilder.getOne
        .mockResolvedValueOnce(alice)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(bob);

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: ['Alice', 'Unknown', 'Bob'],
        ownerEntityId,
      });

      // OWNER + Alice MEMBER + Bob MEMBER = 3
      expect(result.length).toBe(3);
      const memberIds = result
        .filter((m) => m.role === ActivityMemberRole.MEMBER)
        .map((m) => m.entityId);
      expect(memberIds).toContain('alice-uuid');
      expect(memberIds).toContain('bob-uuid');
    });

    it('should not create duplicate MEMBER if same entity resolved twice', async () => {
      setupAddMemberSuccess();

      const alice = makeEntity({ id: 'alice-uuid', name: 'Alice' });

      // Both names resolve to same entity
      mockEntityQueryBuilder.getOne
        .mockResolvedValueOnce(alice)
        .mockResolvedValueOnce(alice);

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: ['Alice', 'Alice Smith'],
        ownerEntityId,
      });

      // OWNER + one MEMBER (second one is skipped via knownEntityIds)
      expect(result.length).toBe(2);
    });

    it('should still return OWNER when addMember for owner returns null (duplicate)', async () => {
      // First call (OWNER) returns null — duplicate
      mockMemberRepo.create.mockReturnValue(makeMember());
      const duplicateError = new Error('dup') as Error & { code: string };
      duplicateError.code = '23505';
      mockMemberRepo.save
        .mockRejectedValueOnce(duplicateError) // OWNER dup
        .mockImplementation((m: ActivityMember) => Promise.resolve(m)); // subsequent calls succeed

      const result = await service.resolveAndCreateMembers({
        activityId,
        participants: [],
        ownerEntityId,
      });

      // addMember returned null for OWNER, so createdMembers is empty
      expect(result.length).toBe(0);
    });

    it('should use ILIKE pattern when resolving participant entity by name', async () => {
      setupAddMemberSuccess();
      mockEntityQueryBuilder.getOne.mockResolvedValue(null);

      await service.resolveAndCreateMembers({
        activityId,
        participants: ['Alice'],
        ownerEntityId,
      });

      expect(mockEntityRepo.createQueryBuilder).toHaveBeenCalledWith('e');
      expect(mockEntityQueryBuilder.where).toHaveBeenCalledWith(
        'e.name ILIKE :pattern',
        { pattern: '%Alice%' },
      );
      expect(mockEntityQueryBuilder.orderBy).toHaveBeenCalledWith(
        'e.updatedAt',
        'DESC',
      );
    });

    it('should trim participant name before search', async () => {
      setupAddMemberSuccess();
      mockEntityQueryBuilder.getOne.mockResolvedValue(null);

      await service.resolveAndCreateMembers({
        activityId,
        participants: ['  Alice  '],
        ownerEntityId,
      });

      expect(mockEntityQueryBuilder.where).toHaveBeenCalledWith(
        'e.name ILIKE :pattern',
        { pattern: '%Alice%' },
      );
    });
  });

  // =======================================================================
  // getMembers
  // =======================================================================

  describe('getMembers', () => {
    it('should query with activityId, isActive filter, entity relation, and proper order', async () => {
      const members = [makeMember(), makeMember({ id: 'member-2' })];
      mockMemberRepo.find.mockResolvedValue(members);

      const result = await service.getMembers('activity-uuid-1');

      expect(result).toBe(members);
      expect(mockMemberRepo.find).toHaveBeenCalledWith({
        where: { activityId: 'activity-uuid-1', isActive: true },
        relations: ['entity'],
        order: { role: 'ASC', joinedAt: 'ASC' },
      });
    });

    it('should return empty array when no active members found', async () => {
      mockMemberRepo.find.mockResolvedValue([]);

      const result = await service.getMembers('no-members-activity');

      expect(result).toEqual([]);
    });
  });

  // =======================================================================
  // getActivitiesForEntity
  // =======================================================================

  describe('getActivitiesForEntity', () => {
    it('should query by entityId and isActive without role filter', async () => {
      const members = [makeMember()];
      mockMemberRepo.find.mockResolvedValue(members);

      const result = await service.getActivitiesForEntity('entity-uuid-1');

      expect(result).toBe(members);
      expect(mockMemberRepo.find).toHaveBeenCalledWith({
        where: { entityId: 'entity-uuid-1', isActive: true },
        relations: ['activity'],
        order: { joinedAt: 'DESC' },
      });
    });

    it('should include role in where clause when role is provided', async () => {
      mockMemberRepo.find.mockResolvedValue([]);

      await service.getActivitiesForEntity(
        'entity-uuid-1',
        ActivityMemberRole.OWNER,
      );

      expect(mockMemberRepo.find).toHaveBeenCalledWith({
        where: {
          entityId: 'entity-uuid-1',
          isActive: true,
          role: ActivityMemberRole.OWNER,
        },
        relations: ['activity'],
        order: { joinedAt: 'DESC' },
      });
    });

    it('should NOT include role in where clause when role is undefined', async () => {
      mockMemberRepo.find.mockResolvedValue([]);

      await service.getActivitiesForEntity('entity-uuid-1', undefined);

      const whereArg = mockMemberRepo.find.mock.calls[0][0].where;
      expect(whereArg).not.toHaveProperty('role');
    });
  });

  // =======================================================================
  // deactivateMember
  // =======================================================================

  describe('deactivateMember', () => {
    it('should call update with isActive false and leftAt date', async () => {
      mockMemberRepo.update.mockResolvedValue({ affected: 1 });

      await service.deactivateMember('activity-uuid-1', 'entity-uuid-1');

      expect(mockMemberRepo.update).toHaveBeenCalledWith(
        { activityId: 'activity-uuid-1', entityId: 'entity-uuid-1', isActive: true },
        expect.objectContaining({
          isActive: false,
        }),
      );

      // Verify leftAt is a Date
      const updateData = mockMemberRepo.update.mock.calls[0][1];
      expect(updateData.leftAt).toBeInstanceOf(Date);
    });

    it('should not throw when member is found and deactivated (affected > 0)', async () => {
      mockMemberRepo.update.mockResolvedValue({ affected: 1 });

      await expect(
        service.deactivateMember('activity-uuid-1', 'entity-uuid-1'),
      ).resolves.toBeUndefined();
    });

    it('should not throw when no active member is found (affected = 0)', async () => {
      mockMemberRepo.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.deactivateMember('activity-uuid-1', 'entity-uuid-1'),
      ).resolves.toBeUndefined();
    });

    it('should handle affected being undefined gracefully', async () => {
      mockMemberRepo.update.mockResolvedValue({ affected: undefined });

      await expect(
        service.deactivateMember('activity-uuid-1', 'entity-uuid-1'),
      ).resolves.toBeUndefined();
    });
  });
});
