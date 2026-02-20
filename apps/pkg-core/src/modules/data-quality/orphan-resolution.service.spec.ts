import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityPriority,
  ActivityContext,
  ActivityMember,
} from '@pkg/entities';
import { OrphanResolutionService, OrphanResolutionResult } from './orphan-resolution.service';
import { ActivityService } from '../activity/activity.service';
import { ProjectMatchingService } from '../extraction/project-matching.service';

describe('OrphanResolutionService', () => {
  let service: OrphanResolutionService;

  // ---------------------------------------------------------------------------
  // Test data constants
  // ---------------------------------------------------------------------------

  const ACTIVITY_ID_1 = '11111111-1111-1111-1111-111111111111';
  const ACTIVITY_ID_2 = '22222222-2222-2222-2222-222222222222';
  const ACTIVITY_ID_3 = '33333333-3333-3333-3333-333333333333';
  const PROJECT_ID = '44444444-4444-4444-4444-444444444444';
  const UNSORTED_ID = '55555555-5555-5555-5555-555555555555';
  const OWNER_ID = '66666666-6666-6666-6666-666666666666';

  // ---------------------------------------------------------------------------
  // Mock QueryBuilder factory
  // ---------------------------------------------------------------------------

  function createMockQueryBuilder(overrides: Record<string, unknown> = {}) {
    const qb: Record<string, jest.Mock> = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    Object.assign(qb, overrides);
    return qb;
  }

  // ---------------------------------------------------------------------------
  // Mock repositories and services
  // ---------------------------------------------------------------------------

  const mockActivityRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockMemberRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockActivityService = {
    create: jest.fn(),
    update: jest.fn(),
  };

  const mockProjectMatchingService = {
    findBestMatchInList: jest.fn().mockReturnValue(null),
  };

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  function makeActivity(overrides: Partial<Activity> = {}): Activity {
    return {
      id: ACTIVITY_ID_1,
      name: 'Test Activity',
      activityType: ActivityType.TASK,
      description: null,
      status: ActivityStatus.ACTIVE,
      priority: ActivityPriority.MEDIUM,
      context: ActivityContext.WORK,
      parentId: null,
      parent: null,
      children: [],
      depth: 0,
      materializedPath: null,
      ownerEntityId: OWNER_ID,
      ownerEntity: null as any,
      clientEntityId: null,
      clientEntity: null,
      deadline: null,
      startDate: null,
      endDate: null,
      recurrenceRule: null,
      metadata: null,
      tags: null,
      progress: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: null,
      deletedAt: null,
      ...overrides,
    } as Activity;
  }

  // ---------------------------------------------------------------------------
  // Module setup
  // ---------------------------------------------------------------------------

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrphanResolutionService,
        { provide: getRepositoryToken(Activity), useValue: mockActivityRepo },
        { provide: getRepositoryToken(ActivityMember), useValue: mockMemberRepo },
        { provide: ActivityService, useValue: mockActivityService },
        { provide: ProjectMatchingService, useValue: mockProjectMatchingService },
      ],
    }).compile();

    service = module.get<OrphanResolutionService>(OrphanResolutionService);
    jest.clearAllMocks();
  });

  // =========================================================================
  // resolveOrphans — empty input
  // =========================================================================

  describe('resolveOrphans — empty input', () => {
    it('should return empty result for empty array', async () => {
      const result = await service.resolveOrphans([]);

      expect(result).toEqual({
        resolved: 0,
        unresolved: 0,
        createdUnsortedProject: false,
        details: [],
      });
      expect(mockActivityRepo.find).not.toHaveBeenCalled();
      expect(mockActivityService.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Strategy 1: Name Containment
  // =========================================================================

  describe('Strategy 1: Name Containment', () => {
    it('should match task "Fix Alpha bug" to project "Alpha"', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Fix Alpha bug',
        activityType: ActivityType.TASK,
      });

      const project = makeActivity({
        id: PROJECT_ID,
        name: 'Alpha',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
      });

      // activityRepo.find returns active projects for name containment lookup
      mockActivityRepo.find.mockResolvedValue([project]);
      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.unresolved).toBe(0);
      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toEqual({
        taskId: ACTIVITY_ID_1,
        taskName: 'Fix Alpha bug',
        assignedParentId: PROJECT_ID,
        assignedParentName: 'Alpha',
        method: 'name_containment',
      });
      expect(mockActivityService.update).toHaveBeenCalledWith(ACTIVITY_ID_1, {
        parentId: PROJECT_ID,
      });
    });

    it('should skip project with short name (< 3 chars) for name containment', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Fix AI integration',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
      });

      const shortProject = makeActivity({
        id: PROJECT_ID,
        name: 'AI',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      // Only one project available and its normalized name is < 3 chars
      mockActivityRepo.find.mockResolvedValue([shortProject]);

      // For batch strategy — no batchId so returns null
      // For single_project — owner has one project so it should match via strategy 3
      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      // Name containment skipped (< 3 chars), but single_project should match
      expect(result.resolved).toBe(1);
      expect(result.details[0].method).toBe('single_project');
    });

    it('should match case-insensitively (task "deploy BETA service" matches project "Beta")', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'deploy BETA service',
        activityType: ActivityType.TASK,
      });

      const project = makeActivity({
        id: PROJECT_ID,
        name: 'Beta',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
      });

      mockActivityRepo.find.mockResolvedValue([project]);
      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.details[0].method).toBe('name_containment');
      expect(result.details[0].assignedParentId).toBe(PROJECT_ID);
    });
  });

  // =========================================================================
  // Strategy 2: Fuzzy Name Matching
  // =========================================================================

  describe('Strategy 2: Fuzzy Name Matching', () => {
    it('should match task to project when fuzzy similarity >= 0.6', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Настроить Панавто интеграцию',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
      });

      const project = makeActivity({
        id: PROJECT_ID,
        name: 'Панавто',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      // Name containment won't match: "панавто" is in "настроить панавто интеграцию",
      // but let's test a case where name containment misses but fuzzy catches it
      const projectWithDifferentName = makeActivity({
        id: PROJECT_ID,
        name: 'Клиент Панавто (424.39₽)',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      // normalizeName strips cost annotations, so "клиент панавто" — not contained in task name
      mockActivityRepo.find.mockResolvedValue([projectWithDifferentName]);

      // Fuzzy matching returns a match with similarity 0.65
      mockProjectMatchingService.findBestMatchInList.mockReturnValue({
        activity: projectWithDifferentName,
        similarity: 0.65,
      });

      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.details[0]).toEqual({
        taskId: ACTIVITY_ID_1,
        taskName: 'Настроить Панавто интеграцию',
        assignedParentId: PROJECT_ID,
        assignedParentName: 'Клиент Панавто (424.39₽)',
        method: 'fuzzy_name',
      });
      expect(mockProjectMatchingService.findBestMatchInList).toHaveBeenCalledWith(
        'Настроить Панавто интеграцию',
        [projectWithDifferentName],
      );
    });

    it('should skip fuzzy matching when similarity < 0.6', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Completely different task',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
        metadata: null,
      });

      const project = makeActivity({
        id: PROJECT_ID,
        name: 'Some Project',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      mockActivityRepo.find.mockResolvedValue([project]);

      // Fuzzy returns low similarity
      mockProjectMatchingService.findBestMatchInList.mockReturnValue({
        activity: project,
        similarity: 0.45,
      });

      // Falls through to single_project (only one project for owner)
      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.details[0].method).toBe('single_project');
    });

    it('should skip fuzzy matching when findBestMatchInList returns null', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'No match at all',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
        metadata: null,
      });

      // No projects
      mockActivityRepo.find.mockResolvedValue([]);

      // findBestMatchInList returns null (no candidates)
      mockProjectMatchingService.findBestMatchInList.mockReturnValue(null);

      // Falls through all strategies to unsorted
      mockActivityRepo.findOne.mockResolvedValue(null);
      mockActivityService.create.mockResolvedValue(
        makeActivity({
          id: UNSORTED_ID,
          name: 'Unsorted Tasks',
          activityType: ActivityType.PROJECT,
          ownerEntityId: OWNER_ID,
        }),
      );
      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.details[0].method).toBe('unsorted');
    });
  });

  // =========================================================================
  // Strategy 3: Batch Matching
  // =========================================================================

  describe('Strategy 3: Batch Matching', () => {
    it('should find sibling with parent in same batch', async () => {
      const batchId = 'batch-abc-123';
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Unrelated task name',
        activityType: ActivityType.TASK,
        metadata: { draftBatchId: batchId } as any,
      });

      const siblingWithParent = makeActivity({
        id: ACTIVITY_ID_2,
        name: 'Sibling task',
        parentId: PROJECT_ID,
        metadata: { draftBatchId: batchId } as any,
      });

      const parentProject = makeActivity({
        id: PROJECT_ID,
        name: 'Target Project',
        activityType: ActivityType.PROJECT,
      });

      // No projects match by name containment
      mockActivityRepo.find.mockResolvedValue([]);

      // Batch query: find sibling with parent
      const batchQb = createMockQueryBuilder({
        getOne: jest.fn().mockResolvedValue(siblingWithParent),
      });
      mockActivityRepo.createQueryBuilder.mockReturnValue(batchQb);

      // Find the parent of the sibling
      mockActivityRepo.findOne.mockResolvedValue(parentProject);

      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.details[0]).toEqual({
        taskId: ACTIVITY_ID_1,
        taskName: 'Unrelated task name',
        assignedParentId: PROJECT_ID,
        assignedParentName: 'Target Project',
        method: 'batch',
      });
      expect(mockActivityService.update).toHaveBeenCalledWith(ACTIVITY_ID_1, {
        parentId: PROJECT_ID,
      });
    });

    it('should skip batch strategy when task has no draftBatchId', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Standalone task',
        activityType: ActivityType.TASK,
        metadata: null,
        ownerEntityId: null as any,
      });

      // No name containment match (no projects)
      mockActivityRepo.find.mockResolvedValue([]);

      // No batch match because metadata is null — matchByBatch returns null
      // No single_project match because ownerEntityId is null
      // No unsorted fallback because ownerEntityId is null

      const result = await service.resolveOrphans([task]);

      // Task remains unresolved
      expect(result.unresolved).toBe(1);
      expect(result.resolved).toBe(0);
      expect(mockActivityRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Strategy 4: Single Project
  // =========================================================================

  describe('Strategy 4: Single Project', () => {
    it('should assign to single active project owned by task owner', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Random task name',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
      });

      const project = makeActivity({
        id: PROJECT_ID,
        name: 'Only Project',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      // One project, but name does not appear in task name => name containment skipped
      mockActivityRepo.find.mockResolvedValue([project]);

      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.details[0]).toEqual({
        taskId: ACTIVITY_ID_1,
        taskName: 'Random task name',
        assignedParentId: PROJECT_ID,
        assignedParentName: 'Only Project',
        method: 'single_project',
      });
    });

    it('should skip when owner has multiple active projects', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Ambiguous task',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
      });

      const projectA = makeActivity({
        id: PROJECT_ID,
        name: 'Project X',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      const projectB = makeActivity({
        id: ACTIVITY_ID_3,
        name: 'Project Y',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      // Neither project name is contained in "Ambiguous task"
      mockActivityRepo.find.mockResolvedValue([projectA, projectB]);

      // Batch strategy: no batch metadata
      // Single project: two projects => skip
      // Fallback to unsorted

      const unsortedProject = makeActivity({
        id: UNSORTED_ID,
        name: 'Unsorted Tasks',
        activityType: ActivityType.PROJECT,
        ownerEntityId: OWNER_ID,
      });

      mockActivityRepo.findOne.mockResolvedValue(unsortedProject);
      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.details[0].method).toBe('unsorted');
    });
  });

  // =========================================================================
  // Strategy 5: Unsorted Fallback
  // =========================================================================

  describe('Strategy 5: Unsorted Fallback', () => {
    it('should create "Unsorted Tasks" project when it does not exist', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Orphaned task',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
      });

      // No projects => no name containment, no single project
      mockActivityRepo.find.mockResolvedValue([]);

      // getOrCreateUnsortedProject: not found
      mockActivityRepo.findOne.mockResolvedValue(null);

      const createdUnsorted = makeActivity({
        id: UNSORTED_ID,
        name: 'Unsorted Tasks',
        activityType: ActivityType.PROJECT,
        ownerEntityId: OWNER_ID,
      });
      mockActivityService.create.mockResolvedValue(createdUnsorted);
      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.createdUnsortedProject).toBe(true);
      expect(result.details[0]).toEqual({
        taskId: ACTIVITY_ID_1,
        taskName: 'Orphaned task',
        assignedParentId: UNSORTED_ID,
        assignedParentName: 'Unsorted Tasks',
        method: 'unsorted',
      });
      expect(mockActivityService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Unsorted Tasks',
          activityType: ActivityType.PROJECT,
          ownerEntityId: OWNER_ID,
          status: ActivityStatus.ACTIVE,
        }),
      );
      expect(mockActivityService.update).toHaveBeenCalledWith(ACTIVITY_ID_1, {
        parentId: UNSORTED_ID,
      });
    });

    it('should reuse existing "Unsorted Tasks" project', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Orphaned task',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
      });

      // No projects => all strategies before unsorted skip
      mockActivityRepo.find.mockResolvedValue([]);

      const existingUnsorted = makeActivity({
        id: UNSORTED_ID,
        name: 'Unsorted Tasks',
        activityType: ActivityType.PROJECT,
        ownerEntityId: OWNER_ID,
      });

      // getOrCreateUnsortedProject: found existing
      mockActivityRepo.findOne.mockResolvedValue(existingUnsorted);
      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(1);
      expect(result.createdUnsortedProject).toBe(true);
      expect(result.details[0].method).toBe('unsorted');
      expect(result.details[0].assignedParentId).toBe(UNSORTED_ID);
      // create should NOT have been called since the project already exists
      expect(mockActivityService.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Task without ownerEntityId
  // =========================================================================

  describe('Task without ownerEntityId', () => {
    it('should remain unresolved when no strategies match and ownerEntityId is missing', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'No owner task',
        activityType: ActivityType.TASK,
        ownerEntityId: undefined as any,
        metadata: null,
      });

      // No projects for name containment
      mockActivityRepo.find.mockResolvedValue([]);

      // Batch: no metadata.draftBatchId => skip
      // Single project: no ownerEntityId => returns null
      // Unsorted: no ownerEntityId => getOrCreateUnsortedProject returns null

      const result = await service.resolveOrphans([task]);

      expect(result.resolved).toBe(0);
      expect(result.unresolved).toBe(1);
      expect(result.details).toHaveLength(0);
      expect(mockActivityService.update).not.toHaveBeenCalled();
      expect(mockActivityService.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Mixed strategies in one batch
  // =========================================================================

  describe('Mixed strategies in one batch', () => {
    it('should resolve tasks with different strategies in a single call', async () => {
      const batchId = 'batch-mixed-001';

      // Task 1: name contains project name => name_containment
      const task1 = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Fix Alpha integration',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
      });

      // Task 2: has batchId, sibling in batch has parent => batch
      const task2 = makeActivity({
        id: ACTIVITY_ID_2,
        name: 'Some batch task',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
        metadata: { draftBatchId: batchId } as any,
      });

      // Task 3: no name match, no batch, owner has multiple projects => unsorted
      const task3 = makeActivity({
        id: ACTIVITY_ID_3,
        name: 'Completely unrelated',
        activityType: ActivityType.TASK,
        ownerEntityId: OWNER_ID,
      });

      const projectAlpha = makeActivity({
        id: PROJECT_ID,
        name: 'Alpha',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      const projectBeta = makeActivity({
        id: '77777777-7777-7777-7777-777777777777',
        name: 'Beta',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        ownerEntityId: OWNER_ID,
      });

      // Active projects for name containment + single project checks
      mockActivityRepo.find.mockResolvedValue([projectAlpha, projectBeta]);

      // Batch matching for task2: sibling found with parent
      const siblingWithParent = makeActivity({
        id: '88888888-8888-8888-8888-888888888888',
        parentId: projectBeta.id,
      });

      const batchQb = createMockQueryBuilder({
        getOne: jest.fn().mockResolvedValue(siblingWithParent),
      });
      mockActivityRepo.createQueryBuilder.mockReturnValue(batchQb);
      mockActivityRepo.findOne
        // For task2 batch: find parent
        .mockResolvedValueOnce(projectBeta)
        // For task3 unsorted: find existing "Unsorted Tasks"
        .mockResolvedValueOnce(
          makeActivity({
            id: UNSORTED_ID,
            name: 'Unsorted Tasks',
            activityType: ActivityType.PROJECT,
            ownerEntityId: OWNER_ID,
          }),
        );

      mockActivityService.update.mockResolvedValue(undefined);

      const result = await service.resolveOrphans([task1, task2, task3]);

      expect(result.resolved).toBe(3);
      expect(result.unresolved).toBe(0);
      expect(result.details).toHaveLength(3);

      // Task 1: name_containment (Alpha)
      expect(result.details[0]).toEqual(
        expect.objectContaining({
          taskId: ACTIVITY_ID_1,
          method: 'name_containment',
          assignedParentId: PROJECT_ID,
        }),
      );

      // Task 2: batch
      expect(result.details[1]).toEqual(
        expect.objectContaining({
          taskId: ACTIVITY_ID_2,
          method: 'batch',
          assignedParentId: projectBeta.id,
        }),
      );

      // Task 3: unsorted
      expect(result.details[2]).toEqual(
        expect.objectContaining({
          taskId: ACTIVITY_ID_3,
          method: 'unsorted',
          assignedParentId: UNSORTED_ID,
        }),
      );

      expect(mockActivityService.update).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // assignParent delegation
  // =========================================================================

  describe('assignParent', () => {
    it('should call activityService.update with correct parentId', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Test task in project context',
        activityType: ActivityType.TASK,
      });

      const project = makeActivity({
        id: PROJECT_ID,
        name: 'Context',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
      });

      // Name containment: "context" (>= 3 chars) is in "test task in project context"
      mockActivityRepo.find.mockResolvedValue([project]);
      mockActivityService.update.mockResolvedValue(undefined);

      await service.resolveOrphans([task]);

      expect(mockActivityService.update).toHaveBeenCalledWith(ACTIVITY_ID_1, {
        parentId: PROJECT_ID,
      });
    });
  });

  // =========================================================================
  // Pre-loading active projects
  // =========================================================================

  describe('Pre-loading active projects', () => {
    it('should query ACTIVE and DRAFT projects with deletedAt IS NULL', async () => {
      const task = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Some orphan',
        ownerEntityId: OWNER_ID,
      });

      mockActivityRepo.find.mockResolvedValue([]);
      mockActivityRepo.findOne.mockResolvedValue(null);

      await service.resolveOrphans([task]);

      expect(mockActivityRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.arrayContaining([
            expect.objectContaining({
              activityType: ActivityType.PROJECT,
              status: ActivityStatus.ACTIVE,
            }),
            expect.objectContaining({
              activityType: ActivityType.PROJECT,
              status: ActivityStatus.DRAFT,
            }),
          ]),
          select: ['id', 'name', 'ownerEntityId'],
        }),
      );
    });
  });
});
