import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { ActivityValidationService } from './activity-validation.service';
import { ActivityMemberService } from './activity-member.service';
import {
  ActivityType,
  ActivityStatus,
  ActivityPriority,
  ActivityContext,
  ActivityMemberRole,
} from '@pkg/entities';

describe('ActivityController', () => {
  let controller: ActivityController;

  // -------------------------------------------------------------------------
  // Mock setup
  // -------------------------------------------------------------------------

  const mockActivityService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findOneWithDetails: jest.fn(),
    update: jest.fn(),
    archive: jest.fn(),
    getActivityTree: jest.fn(),
  };

  const mockValidationService = {
    validateCreate: jest.fn(),
    validateUpdate: jest.fn(),
  };

  const mockMemberService = {
    addMember: jest.fn(),
    getMembers: jest.fn(),
  };

  // -------------------------------------------------------------------------
  // Test data factories
  // -------------------------------------------------------------------------

  const OWNER_ID = '11111111-1111-1111-1111-111111111111';
  const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
  const ACTIVITY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const ENTITY_A_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const ENTITY_B_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  function makeActivity(overrides: Record<string, unknown> = {}) {
    return {
      id: ACTIVITY_ID,
      name: 'Test Activity',
      activityType: ActivityType.PROJECT,
      status: ActivityStatus.ACTIVE,
      priority: ActivityPriority.MEDIUM,
      context: ActivityContext.WORK,
      parentId: null,
      depth: 0,
      materializedPath: null,
      ownerEntityId: OWNER_ID,
      clientEntityId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Module setup
  // -------------------------------------------------------------------------

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ActivityController],
      providers: [
        { provide: ActivityService, useValue: mockActivityService },
        { provide: ActivityValidationService, useValue: mockValidationService },
        { provide: ActivityMemberService, useValue: mockMemberService },
      ],
    }).compile();

    controller = module.get<ActivityController>(ActivityController);
    jest.clearAllMocks();
  });

  // =========================================================================
  // POST /activities (create)
  // =========================================================================
  describe('create', () => {
    it('should create activity without parentId', async () => {
      const dto = {
        name: 'New Project',
        activityType: ActivityType.PROJECT,
        ownerEntityId: OWNER_ID,
        context: ActivityContext.WORK,
      };
      const created = makeActivity({ name: dto.name });
      mockActivityService.create.mockResolvedValue(created);

      const result = await controller.create(dto as any);

      expect(result).toEqual(created);
      expect(mockActivityService.create).toHaveBeenCalledWith(dto);
      expect(mockValidationService.validateCreate).not.toHaveBeenCalled();
    });

    it('should validate hierarchy when parentId provided', async () => {
      const dto = {
        name: 'Child Task',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
        parentId: PARENT_ID,
      };
      const created = makeActivity({
        name: dto.name,
        activityType: ActivityType.TASK,
        parentId: PARENT_ID,
      });

      mockValidationService.validateCreate.mockResolvedValue(undefined);
      mockActivityService.create.mockResolvedValue(created);

      const result = await controller.create(dto as any);

      expect(mockValidationService.validateCreate).toHaveBeenCalledWith({
        activityType: ActivityType.TASK,
        parentId: PARENT_ID,
      });
      expect(mockActivityService.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(created);
    });

    it('should throw when hierarchy validation fails', async () => {
      const dto = {
        name: 'Bad Child',
        activityType: ActivityType.AREA,
        ownerEntityId: OWNER_ID,
        parentId: PARENT_ID,
      };

      mockValidationService.validateCreate.mockRejectedValue(
        new BadRequestException('Cannot create area under task'),
      );

      await expect(controller.create(dto as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockActivityService.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /activities (findAll)
  // =========================================================================
  describe('findAll', () => {
    it('should return list with default pagination', async () => {
      const items = [makeActivity()];
      const response = { items, total: 1 };
      mockActivityService.findAll.mockResolvedValue(response);

      const result = await controller.findAll({} as any);

      expect(result).toEqual(response);
      expect(mockActivityService.findAll).toHaveBeenCalledWith({
        type: undefined,
        status: undefined,
        context: undefined,
        parentId: undefined,
        ownerEntityId: undefined,
        clientEntityId: undefined,
        search: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('should pass all query filters to service', async () => {
      const query = {
        activityType: ActivityType.TASK,
        status: ActivityStatus.ACTIVE,
        context: ActivityContext.WORK,
        parentId: PARENT_ID,
        ownerEntityId: OWNER_ID,
        clientEntityId: CLIENT_ID,
        search: 'design',
        limit: 10,
        offset: 20,
      };
      const response = { items: [], total: 0 };
      mockActivityService.findAll.mockResolvedValue(response);

      const result = await controller.findAll(query as any);

      expect(result).toEqual(response);
      expect(mockActivityService.findAll).toHaveBeenCalledWith({
        type: ActivityType.TASK,
        status: ActivityStatus.ACTIVE,
        context: ActivityContext.WORK,
        parentId: PARENT_ID,
        ownerEntityId: OWNER_ID,
        clientEntityId: CLIENT_ID,
        search: 'design',
        limit: 10,
        offset: 20,
      });
    });
  });

  // =========================================================================
  // GET /activities/:id (findOne)
  // =========================================================================
  describe('findOne', () => {
    it('should return activity with details', async () => {
      const detailed = {
        ...makeActivity(),
        childrenCount: 3,
        members: [{ id: 'member-1', role: ActivityMemberRole.OWNER }],
      };
      mockActivityService.findOneWithDetails.mockResolvedValue(detailed);

      const result = await controller.findOne(ACTIVITY_ID);

      expect(result).toEqual(detailed);
      expect(mockActivityService.findOneWithDetails).toHaveBeenCalledWith(
        ACTIVITY_ID,
      );
    });

    it('should throw for non-existent id', async () => {
      mockActivityService.findOneWithDetails.mockRejectedValue(
        new NotFoundException(`Activity with id 'nonexistent' not found`),
      );

      await expect(controller.findOne('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // PATCH /activities/:id (update)
  // =========================================================================
  describe('update', () => {
    it('should update activity fields', async () => {
      const dto = { name: 'Renamed Project' };
      const updated = makeActivity({ name: 'Renamed Project' });
      mockActivityService.update.mockResolvedValue(updated);

      const result = await controller.update(ACTIVITY_ID, dto as any);

      expect(result).toEqual(updated);
      expect(mockValidationService.validateUpdate).not.toHaveBeenCalled();
      expect(mockActivityService.update).toHaveBeenCalledWith(
        ACTIVITY_ID,
        dto,
      );
    });

    it('should validate hierarchy when parentId changes', async () => {
      const existingActivity = makeActivity({
        activityType: ActivityType.PROJECT,
      });
      const dto = { parentId: PARENT_ID };
      const updated = makeActivity({ parentId: PARENT_ID });

      mockActivityService.findOne.mockResolvedValue(existingActivity);
      mockValidationService.validateUpdate.mockResolvedValue(undefined);
      mockActivityService.update.mockResolvedValue(updated);

      const result = await controller.update(ACTIVITY_ID, dto as any);

      expect(mockActivityService.findOne).toHaveBeenCalledWith(ACTIVITY_ID);
      expect(mockValidationService.validateUpdate).toHaveBeenCalledWith({
        activityId: ACTIVITY_ID,
        activityType: ActivityType.PROJECT,
        newParentId: PARENT_ID,
      });
      expect(mockActivityService.update).toHaveBeenCalledWith(
        ACTIVITY_ID,
        dto,
      );
      expect(result).toEqual(updated);
    });

    it('should use dto.activityType for validation when provided', async () => {
      const existingActivity = makeActivity({
        activityType: ActivityType.PROJECT,
      });
      const dto = {
        parentId: PARENT_ID,
        activityType: ActivityType.TASK,
      };
      const updated = makeActivity({
        parentId: PARENT_ID,
        activityType: ActivityType.TASK,
      });

      mockActivityService.findOne.mockResolvedValue(existingActivity);
      mockValidationService.validateUpdate.mockResolvedValue(undefined);
      mockActivityService.update.mockResolvedValue(updated);

      await controller.update(ACTIVITY_ID, dto as any);

      expect(mockValidationService.validateUpdate).toHaveBeenCalledWith({
        activityId: ACTIVITY_ID,
        activityType: ActivityType.TASK,
        newParentId: PARENT_ID,
      });
    });

    it('should skip validation when parentId not in dto', async () => {
      const dto = { name: 'Just a rename', status: ActivityStatus.PAUSED };
      const updated = makeActivity(dto);
      mockActivityService.update.mockResolvedValue(updated);

      await controller.update(ACTIVITY_ID, dto as any);

      expect(mockActivityService.findOne).not.toHaveBeenCalled();
      expect(mockValidationService.validateUpdate).not.toHaveBeenCalled();
    });

    it('should validate when parentId is explicitly set to null (move to root)', async () => {
      const existingActivity = makeActivity({
        activityType: ActivityType.PROJECT,
        parentId: PARENT_ID,
      });
      const dto = { parentId: null };
      const updated = makeActivity({ parentId: null });

      mockActivityService.findOne.mockResolvedValue(existingActivity);
      mockValidationService.validateUpdate.mockResolvedValue(undefined);
      mockActivityService.update.mockResolvedValue(updated);

      await controller.update(ACTIVITY_ID, dto as any);

      expect(mockValidationService.validateUpdate).toHaveBeenCalledWith({
        activityId: ACTIVITY_ID,
        activityType: ActivityType.PROJECT,
        newParentId: null,
      });
    });
  });

  // =========================================================================
  // DELETE /activities/:id (remove / archive)
  // =========================================================================
  describe('remove', () => {
    it('should archive activity and return status', async () => {
      const archived = makeActivity({ status: ActivityStatus.ARCHIVED });
      mockActivityService.archive.mockResolvedValue(archived);

      const result = await controller.remove(ACTIVITY_ID);

      expect(mockActivityService.archive).toHaveBeenCalledWith(ACTIVITY_ID);
      expect(result).toEqual({
        id: ACTIVITY_ID,
        status: ActivityStatus.ARCHIVED,
        message: 'Activity archived successfully',
      });
    });

    it('should propagate NotFoundException when activity does not exist', async () => {
      mockActivityService.archive.mockRejectedValue(
        new NotFoundException(`Activity with id '${ACTIVITY_ID}' not found`),
      );

      await expect(controller.remove(ACTIVITY_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // GET /activities/:id/tree
  // =========================================================================
  describe('getTree', () => {
    it('should return activity tree', async () => {
      const tree = [
        makeActivity({
          children: [
            makeActivity({ id: 'child-1', name: 'Child 1', children: [] }),
            makeActivity({ id: 'child-2', name: 'Child 2', children: [] }),
          ],
        }),
      ];
      mockActivityService.getActivityTree.mockResolvedValue(tree);

      const result = await controller.getTree(ACTIVITY_ID);

      expect(result).toEqual(tree);
      expect(mockActivityService.getActivityTree).toHaveBeenCalledWith(
        ACTIVITY_ID,
      );
    });

    it('should propagate NotFoundException for non-existent activity', async () => {
      mockActivityService.getActivityTree.mockRejectedValue(
        new NotFoundException(`Activity with id '${ACTIVITY_ID}' not found`),
      );

      await expect(controller.getTree(ACTIVITY_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // POST /activities/:id/members (addMembers)
  // =========================================================================
  describe('addMembers', () => {
    it('should add members and report results', async () => {
      const dto = {
        members: [
          { entityId: ENTITY_A_ID, role: ActivityMemberRole.OWNER },
          { entityId: ENTITY_B_ID }, // role defaults to MEMBER in controller
        ],
      };

      const memberA = {
        id: 'member-a',
        activityId: ACTIVITY_ID,
        entityId: ENTITY_A_ID,
        role: ActivityMemberRole.OWNER,
      };
      const memberB = {
        id: 'member-b',
        activityId: ACTIVITY_ID,
        entityId: ENTITY_B_ID,
        role: ActivityMemberRole.MEMBER,
      };

      mockActivityService.findOne.mockResolvedValue(makeActivity());
      mockMemberService.addMember
        .mockResolvedValueOnce(memberA)
        .mockResolvedValueOnce(memberB);

      const result = await controller.addMembers(ACTIVITY_ID, dto as any);

      expect(mockActivityService.findOne).toHaveBeenCalledWith(ACTIVITY_ID);
      expect(mockMemberService.addMember).toHaveBeenCalledTimes(2);
      expect(mockMemberService.addMember).toHaveBeenCalledWith({
        activityId: ACTIVITY_ID,
        entityId: ENTITY_A_ID,
        role: ActivityMemberRole.OWNER,
        notes: undefined,
      });
      expect(mockMemberService.addMember).toHaveBeenCalledWith({
        activityId: ACTIVITY_ID,
        entityId: ENTITY_B_ID,
        role: ActivityMemberRole.MEMBER,
        notes: undefined,
      });

      expect(result).toEqual({
        added: 2,
        skipped: 0,
        members: [memberA, memberB],
      });
    });

    it('should handle duplicate members (null results from addMember)', async () => {
      const dto = {
        members: [
          { entityId: ENTITY_A_ID, role: ActivityMemberRole.MEMBER },
          { entityId: ENTITY_B_ID, role: ActivityMemberRole.MEMBER },
          { entityId: ENTITY_A_ID, role: ActivityMemberRole.MEMBER }, // duplicate
        ],
      };

      const memberA = {
        id: 'member-a',
        activityId: ACTIVITY_ID,
        entityId: ENTITY_A_ID,
        role: ActivityMemberRole.MEMBER,
      };
      const memberB = {
        id: 'member-b',
        activityId: ACTIVITY_ID,
        entityId: ENTITY_B_ID,
        role: ActivityMemberRole.MEMBER,
      };

      mockActivityService.findOne.mockResolvedValue(makeActivity());
      mockMemberService.addMember
        .mockResolvedValueOnce(memberA)
        .mockResolvedValueOnce(memberB)
        .mockResolvedValueOnce(null); // duplicate — returns null

      const result = await controller.addMembers(ACTIVITY_ID, dto as any);

      expect(mockMemberService.addMember).toHaveBeenCalledTimes(3);
      expect(result).toEqual({
        added: 2,
        skipped: 1,
        members: [memberA, memberB],
      });
    });

    it('should throw for non-existent activity', async () => {
      const dto = {
        members: [{ entityId: ENTITY_A_ID }],
      };

      mockActivityService.findOne.mockRejectedValue(
        new NotFoundException(`Activity with id '${ACTIVITY_ID}' not found`),
      );

      await expect(
        controller.addMembers(ACTIVITY_ID, dto as any),
      ).rejects.toThrow(NotFoundException);

      expect(mockMemberService.addMember).not.toHaveBeenCalled();
    });

    it('should pass notes to addMember when provided', async () => {
      const dto = {
        members: [
          {
            entityId: ENTITY_A_ID,
            role: ActivityMemberRole.MEMBER,
            notes: 'Tech lead',
          },
        ],
      };

      const memberA = {
        id: 'member-a',
        activityId: ACTIVITY_ID,
        entityId: ENTITY_A_ID,
        role: ActivityMemberRole.MEMBER,
        notes: 'Tech lead',
      };

      mockActivityService.findOne.mockResolvedValue(makeActivity());
      mockMemberService.addMember.mockResolvedValue(memberA);

      const result = await controller.addMembers(ACTIVITY_ID, dto as any);

      expect(mockMemberService.addMember).toHaveBeenCalledWith({
        activityId: ACTIVITY_ID,
        entityId: ENTITY_A_ID,
        role: ActivityMemberRole.MEMBER,
        notes: 'Tech lead',
      });
      expect(result.added).toBe(1);
    });
  });

  // =========================================================================
  // GET /activities/:id/members (getMembers)
  // =========================================================================
  describe('getMembers', () => {
    it('should return members list', async () => {
      const members = [
        {
          id: 'member-1',
          activityId: ACTIVITY_ID,
          entityId: ENTITY_A_ID,
          role: ActivityMemberRole.OWNER,
          entity: { id: ENTITY_A_ID, name: 'Alice' },
        },
        {
          id: 'member-2',
          activityId: ACTIVITY_ID,
          entityId: ENTITY_B_ID,
          role: ActivityMemberRole.MEMBER,
          entity: { id: ENTITY_B_ID, name: 'Bob' },
        },
      ];

      mockActivityService.findOne.mockResolvedValue(makeActivity());
      mockMemberService.getMembers.mockResolvedValue(members);

      const result = await controller.getMembers(ACTIVITY_ID);

      expect(mockActivityService.findOne).toHaveBeenCalledWith(ACTIVITY_ID);
      expect(mockMemberService.getMembers).toHaveBeenCalledWith(ACTIVITY_ID);
      expect(result).toEqual(members);
    });

    it('should throw for non-existent activity', async () => {
      mockActivityService.findOne.mockRejectedValue(
        new NotFoundException(`Activity with id '${ACTIVITY_ID}' not found`),
      );

      await expect(controller.getMembers(ACTIVITY_ID)).rejects.toThrow(
        NotFoundException,
      );

      expect(mockMemberService.getMembers).not.toHaveBeenCalled();
    });
  });
});
