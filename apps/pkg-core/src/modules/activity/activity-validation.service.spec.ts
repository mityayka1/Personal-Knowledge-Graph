import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ActivityValidationService } from './activity-validation.service';
import { Activity, ActivityType } from '@pkg/entities';

describe('ActivityValidationService', () => {
  let service: ActivityValidationService;

  const mockRepo = {
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityValidationService,
        {
          provide: getRepositoryToken(Activity),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<ActivityValidationService>(ActivityValidationService);
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // validateTypeHierarchy
  // ---------------------------------------------------------------------------
  describe('validateTypeHierarchy', () => {
    // -- AREA --
    describe('AREA parent', () => {
      const parent = ActivityType.AREA;

      it('should allow BUSINESS under AREA', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.BUSINESS),
        ).not.toThrow();
      });

      it('should allow DIRECTION under AREA', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.DIRECTION),
        ).not.toThrow();
      });

      it('should allow PROJECT under AREA', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.PROJECT),
        ).not.toThrow();
      });

      it.each([
        ActivityType.AREA,
        ActivityType.TASK,
        ActivityType.MILESTONE,
        ActivityType.INITIATIVE,
        ActivityType.HABIT,
        ActivityType.LEARNING,
        ActivityType.EVENT_SERIES,
      ])('should reject %s under AREA', (childType) => {
        expect(() =>
          service.validateTypeHierarchy(parent, childType),
        ).toThrow(BadRequestException);
      });
    });

    // -- BUSINESS --
    describe('BUSINESS parent', () => {
      const parent = ActivityType.BUSINESS;

      it('should allow DIRECTION under BUSINESS', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.DIRECTION),
        ).not.toThrow();
      });

      it('should allow PROJECT under BUSINESS', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.PROJECT),
        ).not.toThrow();
      });

      it.each([
        ActivityType.AREA,
        ActivityType.BUSINESS,
        ActivityType.TASK,
        ActivityType.MILESTONE,
        ActivityType.INITIATIVE,
        ActivityType.HABIT,
        ActivityType.LEARNING,
        ActivityType.EVENT_SERIES,
      ])('should reject %s under BUSINESS', (childType) => {
        expect(() =>
          service.validateTypeHierarchy(parent, childType),
        ).toThrow(BadRequestException);
      });
    });

    // -- DIRECTION --
    describe('DIRECTION parent', () => {
      const parent = ActivityType.DIRECTION;

      it('should allow PROJECT under DIRECTION', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.PROJECT),
        ).not.toThrow();
      });

      it('should allow INITIATIVE under DIRECTION', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.INITIATIVE),
        ).not.toThrow();
      });

      it.each([
        ActivityType.AREA,
        ActivityType.BUSINESS,
        ActivityType.DIRECTION,
        ActivityType.TASK,
        ActivityType.MILESTONE,
        ActivityType.HABIT,
        ActivityType.LEARNING,
        ActivityType.EVENT_SERIES,
      ])('should reject %s under DIRECTION', (childType) => {
        expect(() =>
          service.validateTypeHierarchy(parent, childType),
        ).toThrow(BadRequestException);
      });
    });

    // -- PROJECT --
    describe('PROJECT parent', () => {
      const parent = ActivityType.PROJECT;

      it('should allow TASK under PROJECT', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.TASK),
        ).not.toThrow();
      });

      it('should allow PROJECT under PROJECT (sub-project)', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.PROJECT),
        ).not.toThrow();
      });

      it('should allow MILESTONE under PROJECT', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.MILESTONE),
        ).not.toThrow();
      });

      it.each([
        ActivityType.AREA,
        ActivityType.BUSINESS,
        ActivityType.DIRECTION,
        ActivityType.INITIATIVE,
        ActivityType.HABIT,
        ActivityType.LEARNING,
        ActivityType.EVENT_SERIES,
      ])('should reject %s under PROJECT', (childType) => {
        expect(() =>
          service.validateTypeHierarchy(parent, childType),
        ).toThrow(BadRequestException);
      });
    });

    // -- INITIATIVE --
    describe('INITIATIVE parent', () => {
      const parent = ActivityType.INITIATIVE;

      it('should allow PROJECT under INITIATIVE', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.PROJECT),
        ).not.toThrow();
      });

      it('should allow TASK under INITIATIVE', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.TASK),
        ).not.toThrow();
      });

      it.each([
        ActivityType.AREA,
        ActivityType.BUSINESS,
        ActivityType.DIRECTION,
        ActivityType.INITIATIVE,
        ActivityType.MILESTONE,
        ActivityType.HABIT,
        ActivityType.LEARNING,
        ActivityType.EVENT_SERIES,
      ])('should reject %s under INITIATIVE', (childType) => {
        expect(() =>
          service.validateTypeHierarchy(parent, childType),
        ).toThrow(BadRequestException);
      });
    });

    // -- TASK (leaf) --
    describe('TASK parent (leaf node)', () => {
      const parent = ActivityType.TASK;

      it.each(Object.values(ActivityType))(
        'should reject %s under TASK (leaf node has no children)',
        (childType) => {
          expect(() =>
            service.validateTypeHierarchy(parent, childType),
          ).toThrow(BadRequestException);
        },
      );
    });

    // -- MILESTONE (leaf) --
    describe('MILESTONE parent (leaf node)', () => {
      const parent = ActivityType.MILESTONE;

      it.each(Object.values(ActivityType))(
        'should reject %s under MILESTONE (leaf node has no children)',
        (childType) => {
          expect(() =>
            service.validateTypeHierarchy(parent, childType),
          ).toThrow(BadRequestException);
        },
      );
    });

    // -- HABIT --
    describe('HABIT parent', () => {
      const parent = ActivityType.HABIT;

      it('should allow TASK under HABIT', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.TASK),
        ).not.toThrow();
      });

      it.each([
        ActivityType.AREA,
        ActivityType.BUSINESS,
        ActivityType.DIRECTION,
        ActivityType.PROJECT,
        ActivityType.INITIATIVE,
        ActivityType.MILESTONE,
        ActivityType.HABIT,
        ActivityType.LEARNING,
        ActivityType.EVENT_SERIES,
      ])('should reject %s under HABIT', (childType) => {
        expect(() =>
          service.validateTypeHierarchy(parent, childType),
        ).toThrow(BadRequestException);
      });
    });

    // -- LEARNING --
    describe('LEARNING parent', () => {
      const parent = ActivityType.LEARNING;

      it('should allow TASK under LEARNING', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.TASK),
        ).not.toThrow();
      });

      it.each([
        ActivityType.AREA,
        ActivityType.BUSINESS,
        ActivityType.DIRECTION,
        ActivityType.PROJECT,
        ActivityType.INITIATIVE,
        ActivityType.MILESTONE,
        ActivityType.HABIT,
        ActivityType.LEARNING,
        ActivityType.EVENT_SERIES,
      ])('should reject %s under LEARNING', (childType) => {
        expect(() =>
          service.validateTypeHierarchy(parent, childType),
        ).toThrow(BadRequestException);
      });
    });

    // -- EVENT_SERIES --
    describe('EVENT_SERIES parent', () => {
      const parent = ActivityType.EVENT_SERIES;

      it('should allow TASK under EVENT_SERIES', () => {
        expect(() =>
          service.validateTypeHierarchy(parent, ActivityType.TASK),
        ).not.toThrow();
      });

      it.each([
        ActivityType.AREA,
        ActivityType.BUSINESS,
        ActivityType.DIRECTION,
        ActivityType.PROJECT,
        ActivityType.INITIATIVE,
        ActivityType.MILESTONE,
        ActivityType.HABIT,
        ActivityType.LEARNING,
        ActivityType.EVENT_SERIES,
      ])('should reject %s under EVENT_SERIES', (childType) => {
        expect(() =>
          service.validateTypeHierarchy(parent, childType),
        ).toThrow(BadRequestException);
      });
    });

    // -- Error message format --
    describe('error message format', () => {
      it('should include parent type, child type, and allowed list in error', () => {
        expect(() =>
          service.validateTypeHierarchy(ActivityType.AREA, ActivityType.TASK),
        ).toThrow(
          /Cannot create task under area.*Allowed children: business, direction, project/,
        );
      });

      it('should say "none (leaf node)" for leaf types', () => {
        expect(() =>
          service.validateTypeHierarchy(ActivityType.TASK, ActivityType.TASK),
        ).toThrow(/Allowed children: none \(leaf node\)/);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // validateCreate
  // ---------------------------------------------------------------------------
  describe('validateCreate', () => {
    it('should pass when parentId is null (root activity)', async () => {
      await expect(
        service.validateCreate({
          activityType: ActivityType.AREA,
          parentId: null,
        }),
      ).resolves.toBeUndefined();

      expect(mockRepo.findOne).not.toHaveBeenCalled();
    });

    it('should pass when parentId is undefined (root activity)', async () => {
      await expect(
        service.validateCreate({
          activityType: ActivityType.PROJECT,
          parentId: undefined,
        }),
      ).resolves.toBeUndefined();

      expect(mockRepo.findOne).not.toHaveBeenCalled();
    });

    it('should pass when parentId is empty string (treated as root)', async () => {
      await expect(
        service.validateCreate({
          activityType: ActivityType.AREA,
          parentId: '',
        }),
      ).resolves.toBeUndefined();

      expect(mockRepo.findOne).not.toHaveBeenCalled();
    });

    it('should pass when parent exists and hierarchy is valid', async () => {
      const parentId = 'parent-uuid-1';
      mockRepo.findOne.mockResolvedValue({
        id: parentId,
        activityType: ActivityType.PROJECT,
        name: 'My Project',
      });

      await expect(
        service.validateCreate({
          activityType: ActivityType.TASK,
          parentId,
        }),
      ).resolves.toBeUndefined();

      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: parentId },
        select: ['id', 'activityType', 'name'],
      });
    });

    it('should throw NotFoundException when parent does not exist', async () => {
      const parentId = 'nonexistent-uuid';
      mockRepo.findOne.mockResolvedValue(null);

      await expect(
        service.validateCreate({
          activityType: ActivityType.TASK,
          parentId,
        }),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.validateCreate({
          activityType: ActivityType.TASK,
          parentId,
        }),
      ).rejects.toThrow(/Parent activity with id 'nonexistent-uuid' not found/);
    });

    it('should throw BadRequestException when hierarchy is invalid', async () => {
      const parentId = 'parent-uuid-task';
      mockRepo.findOne.mockResolvedValue({
        id: parentId,
        activityType: ActivityType.TASK,
        name: 'Some Task',
      });

      await expect(
        service.validateCreate({
          activityType: ActivityType.PROJECT,
          parentId,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should validate hierarchy for AREA -> BUSINESS (valid)', async () => {
      const parentId = 'area-uuid';
      mockRepo.findOne.mockResolvedValue({
        id: parentId,
        activityType: ActivityType.AREA,
        name: 'Work',
      });

      await expect(
        service.validateCreate({
          activityType: ActivityType.BUSINESS,
          parentId,
        }),
      ).resolves.toBeUndefined();
    });

    it('should reject AREA under BUSINESS (invalid hierarchy)', async () => {
      const parentId = 'business-uuid';
      mockRepo.findOne.mockResolvedValue({
        id: parentId,
        activityType: ActivityType.BUSINESS,
        name: 'My Company',
      });

      await expect(
        service.validateCreate({
          activityType: ActivityType.AREA,
          parentId,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // validateUpdate
  // ---------------------------------------------------------------------------
  describe('validateUpdate', () => {
    const activityId = 'activity-uuid-1';

    it('should pass when newParentId is undefined (not changing parent)', async () => {
      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.TASK,
          newParentId: undefined,
        }),
      ).resolves.toBeUndefined();

      expect(mockRepo.findOne).not.toHaveBeenCalled();
    });

    it('should pass when newParentId is null (moving to root)', async () => {
      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.AREA,
          newParentId: null,
        }),
      ).resolves.toBeUndefined();

      expect(mockRepo.findOne).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when newParentId equals activityId (self-parent)', async () => {
      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.PROJECT,
          newParentId: activityId,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.PROJECT,
          newParentId: activityId,
        }),
      ).rejects.toThrow('Activity cannot be its own parent');
    });

    it('should throw NotFoundException when new parent does not exist', async () => {
      const newParentId = 'nonexistent-parent';
      mockRepo.findOne.mockResolvedValue(null);

      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.TASK,
          newParentId,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should pass when parent exists and hierarchy is valid', async () => {
      const newParentId = 'project-parent-uuid';
      // First call: validateUpdate -> findOne for parent
      // Second call: checkNoCycle -> findOne for newParent
      mockRepo.findOne
        .mockResolvedValueOnce({
          id: newParentId,
          activityType: ActivityType.PROJECT,
          name: 'Parent Project',
          materializedPath: 'root-uuid/area-uuid',
        })
        .mockResolvedValueOnce({
          id: newParentId,
          materializedPath: 'root-uuid/area-uuid',
        });

      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.TASK,
          newParentId,
        }),
      ).resolves.toBeUndefined();
    });

    it('should throw BadRequestException when hierarchy is invalid', async () => {
      const newParentId = 'milestone-uuid';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        activityType: ActivityType.MILESTONE,
        name: 'V1 Release',
        materializedPath: null,
      });

      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.PROJECT,
          newParentId,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when moving under a descendant (cycle)', async () => {
      const newParentId = 'descendant-uuid';
      // validateUpdate -> findOne for parent
      mockRepo.findOne.mockResolvedValueOnce({
        id: newParentId,
        activityType: ActivityType.PROJECT,
        name: 'Sub Project',
        materializedPath: `root-uuid/${activityId}/some-child`,
      });
      // checkNoCycle -> findOne for newParent
      mockRepo.findOne.mockResolvedValueOnce({
        id: newParentId,
        materializedPath: `root-uuid/${activityId}/some-child`,
      });

      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.PROJECT,
          newParentId,
        }),
      ).rejects.toThrow(BadRequestException);

      // Verify both findOne calls were made
      expect(mockRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it('should not call checkNoCycle if self-parent is detected first', async () => {
      await expect(
        service.validateUpdate({
          activityId,
          activityType: ActivityType.TASK,
          newParentId: activityId,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockRepo.findOne).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // checkNoCycle
  // ---------------------------------------------------------------------------
  describe('checkNoCycle', () => {
    const activityId = 'activity-uuid-check';

    it('should pass when newParent has no materializedPath (null)', async () => {
      const newParentId = 'parent-no-path';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        materializedPath: null,
      });

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).resolves.toBeUndefined();
    });

    it('should pass when newParent has empty materializedPath', async () => {
      const newParentId = 'parent-empty-path';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        materializedPath: '',
      });

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).resolves.toBeUndefined();
    });

    it('should pass when activityId is NOT in materializedPath', async () => {
      const newParentId = 'parent-safe';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        materializedPath: 'uuid-a/uuid-b/uuid-c',
      });

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).resolves.toBeUndefined();
    });

    it('should throw BadRequestException when activityId IS in materializedPath', async () => {
      const newParentId = 'descendant-node';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        materializedPath: `root-uuid/${activityId}/child-uuid`,
      });

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).rejects.toThrow(/would create a cycle/);
    });

    it('should throw BadRequestException when activityId is the only segment in path', async () => {
      const newParentId = 'direct-child';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        materializedPath: activityId,
      });

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when activityId is the first segment in path', async () => {
      const newParentId = 'deep-descendant';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        materializedPath: `${activityId}/child-a/child-b`,
      });

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when activityId is the last segment in path', async () => {
      const newParentId = 'deep-descendant-end';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        materializedPath: `root-uuid/mid-uuid/${activityId}`,
      });

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for self-reference (newParentId === activityId)', async () => {
      mockRepo.findOne.mockResolvedValue({
        id: activityId,
        materializedPath: 'root-uuid/some-parent',
      });

      await expect(
        service.checkNoCycle(activityId, activityId),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.checkNoCycle(activityId, activityId),
      ).rejects.toThrow('Activity cannot be its own parent');
    });

    it('should pass (return) when newParent is not found', async () => {
      const newParentId = 'ghost-uuid';
      mockRepo.findOne.mockResolvedValue(null);

      await expect(
        service.checkNoCycle(activityId, newParentId),
      ).resolves.toBeUndefined();
    });

    it('should not match partial UUID segments in materializedPath', async () => {
      // activityId = "abc" should NOT match "xabc" or "abcx" as path segments
      const shortActivityId = 'abc';
      const newParentId = 'parent-partial';
      mockRepo.findOne.mockResolvedValue({
        id: newParentId,
        materializedPath: 'xabc/abcx/zabc-def',
      });

      // The path is split by "/" so segments are: ["xabc", "abcx", "zabc-def"]
      // None of them equals "abc", so no cycle should be detected.
      await expect(
        service.checkNoCycle(shortActivityId, newParentId),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getAllowedChildTypes
  // ---------------------------------------------------------------------------
  describe('getAllowedChildTypes', () => {
    it('should return [BUSINESS, DIRECTION, PROJECT] for AREA', () => {
      const result = service.getAllowedChildTypes(ActivityType.AREA);
      expect(result).toEqual([
        ActivityType.BUSINESS,
        ActivityType.DIRECTION,
        ActivityType.PROJECT,
      ]);
    });

    it('should return [DIRECTION, PROJECT] for BUSINESS', () => {
      const result = service.getAllowedChildTypes(ActivityType.BUSINESS);
      expect(result).toEqual([
        ActivityType.DIRECTION,
        ActivityType.PROJECT,
      ]);
    });

    it('should return [PROJECT, INITIATIVE] for DIRECTION', () => {
      const result = service.getAllowedChildTypes(ActivityType.DIRECTION);
      expect(result).toEqual([
        ActivityType.PROJECT,
        ActivityType.INITIATIVE,
      ]);
    });

    it('should return [TASK, PROJECT, MILESTONE] for PROJECT', () => {
      const result = service.getAllowedChildTypes(ActivityType.PROJECT);
      expect(result).toEqual([
        ActivityType.TASK,
        ActivityType.PROJECT,
        ActivityType.MILESTONE,
      ]);
    });

    it('should return [PROJECT, TASK] for INITIATIVE', () => {
      const result = service.getAllowedChildTypes(ActivityType.INITIATIVE);
      expect(result).toEqual([
        ActivityType.PROJECT,
        ActivityType.TASK,
      ]);
    });

    it('should return empty array for TASK (leaf)', () => {
      const result = service.getAllowedChildTypes(ActivityType.TASK);
      expect(result).toEqual([]);
    });

    it('should return empty array for MILESTONE (leaf)', () => {
      const result = service.getAllowedChildTypes(ActivityType.MILESTONE);
      expect(result).toEqual([]);
    });

    it('should return [TASK] for HABIT', () => {
      const result = service.getAllowedChildTypes(ActivityType.HABIT);
      expect(result).toEqual([ActivityType.TASK]);
    });

    it('should return [TASK] for LEARNING', () => {
      const result = service.getAllowedChildTypes(ActivityType.LEARNING);
      expect(result).toEqual([ActivityType.TASK]);
    });

    it('should return [TASK] for EVENT_SERIES', () => {
      const result = service.getAllowedChildTypes(ActivityType.EVENT_SERIES);
      expect(result).toEqual([ActivityType.TASK]);
    });

    it('should return empty array for an unknown type (fallback via ??)', () => {
      const result = service.getAllowedChildTypes(
        'unknown_type' as ActivityType,
      );
      expect(result).toEqual([]);
    });
  });
});
