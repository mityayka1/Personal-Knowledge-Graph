import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { DataQualityService } from './data-quality.service';
import {
  DataQualityReport,
  DataQualityReportStatus,
  DataQualityIssueType,
  DataQualityIssueSeverity,
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityPriority,
  ActivityContext,
  ActivityMember,
  ActivityMemberRole,
  Commitment,
  EntityRelation,
  RelationSource,
} from '@pkg/entities';

describe('DataQualityService', () => {
  let service: DataQualityService;

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
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    Object.assign(qb, overrides);
    return qb;
  }

  // ---------------------------------------------------------------------------
  // Mock repositories
  // ---------------------------------------------------------------------------

  const mockReportRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockActivityRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockMemberRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockCommitmentRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockRelationRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  // ---------------------------------------------------------------------------
  // Test data constants
  // ---------------------------------------------------------------------------

  const REPORT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const ACTIVITY_ID_1 = '11111111-1111-1111-1111-111111111111';
  const ACTIVITY_ID_2 = '22222222-2222-2222-2222-222222222222';
  const ACTIVITY_ID_3 = '33333333-3333-3333-3333-333333333333';
  const KEEP_ID = '44444444-4444-4444-4444-444444444444';
  const ENTITY_ID_A = '55555555-5555-5555-5555-555555555555';

  // ---------------------------------------------------------------------------
  // Factories
  // ---------------------------------------------------------------------------

  function makeReport(overrides: Partial<DataQualityReport> = {}): DataQualityReport {
    return {
      id: REPORT_ID,
      reportDate: new Date('2025-02-01'),
      metrics: {
        totalActivities: 10,
        duplicateGroups: 1,
        orphanedTasks: 2,
        missingClientEntity: 3,
        activityMemberCoverage: 0.5,
        commitmentLinkageRate: 0.8,
        inferredRelationsCount: 4,
        fieldFillRate: 0.6,
      },
      issues: [
        {
          type: DataQualityIssueType.DUPLICATE,
          severity: DataQualityIssueSeverity.HIGH,
          activityId: ACTIVITY_ID_1,
          activityName: 'Dup Project',
          description: 'Duplicate',
          suggestedAction: 'Merge',
        },
        {
          type: DataQualityIssueType.ORPHAN,
          severity: DataQualityIssueSeverity.MEDIUM,
          activityId: ACTIVITY_ID_2,
          activityName: 'Orphan Task',
          description: 'No parent',
          suggestedAction: 'Assign parent',
        },
      ],
      resolutions: null,
      status: DataQualityReportStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as DataQualityReport;
  }

  function makeActivity(overrides: Partial<Activity> = {}): Activity {
    return {
      id: ACTIVITY_ID_1,
      name: 'Test Activity',
      activityType: ActivityType.PROJECT,
      description: null,
      status: ActivityStatus.ACTIVE,
      priority: ActivityPriority.MEDIUM,
      context: ActivityContext.WORK,
      parentId: null,
      parent: null,
      children: [],
      depth: 0,
      materializedPath: null,
      ownerEntityId: ENTITY_ID_A,
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
        DataQualityService,
        { provide: getRepositoryToken(DataQualityReport), useValue: mockReportRepo },
        { provide: getRepositoryToken(Activity), useValue: mockActivityRepo },
        { provide: getRepositoryToken(ActivityMember), useValue: mockMemberRepo },
        { provide: getRepositoryToken(Commitment), useValue: mockCommitmentRepo },
        { provide: getRepositoryToken(EntityRelation), useValue: mockRelationRepo },
      ],
    }).compile();

    service = module.get<DataQualityService>(DataQualityService);
    jest.clearAllMocks();
  });

  // =========================================================================
  // findDuplicateProjects
  // =========================================================================

  describe('findDuplicateProjects', () => {
    it('should find groups with same LOWER(name) and type', async () => {
      const groupsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { lowerName: 'project alpha', activityType: 'project', cnt: '2' },
        ]),
      });

      const detailQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          makeActivity({ id: ACTIVITY_ID_1, name: 'Project Alpha', status: ActivityStatus.ACTIVE, createdAt: new Date('2025-01-01') }),
          makeActivity({ id: ACTIVITY_ID_2, name: 'project alpha', status: ActivityStatus.DRAFT, createdAt: new Date('2025-01-15') }),
        ]),
      });

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(groupsQb)
        .mockReturnValueOnce(detailQb);

      const result = await service.findDuplicateProjects();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('project alpha');
      expect(result[0].type).toBe(ActivityType.PROJECT);
      expect(result[0].count).toBe(2);
      expect(result[0].activities).toHaveLength(2);
      expect(groupsQb.groupBy).toHaveBeenCalledWith('LOWER(a.name)');
      expect(groupsQb.addGroupBy).toHaveBeenCalledWith('a.activity_type');
      expect(groupsQb.having).toHaveBeenCalledWith('COUNT(*) > 1');
    });

    it('should return empty array when no duplicates', async () => {
      const groupsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(groupsQb);

      const result = await service.findDuplicateProjects();

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // findOrphanedTasks
  // =========================================================================

  describe('findOrphanedTasks', () => {
    it('should find tasks without parentId (IsNull)', async () => {
      const orphanNoParent = makeActivity({
        id: ACTIVITY_ID_1,
        activityType: ActivityType.TASK,
        name: 'Orphan No Parent',
        parentId: null,
      });

      mockActivityRepo.find.mockResolvedValue([orphanNoParent]);

      const invalidParentQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(invalidParentQb);

      const result = await service.findOrphanedTasks();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(ACTIVITY_ID_1);
      expect(mockActivityRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            activityType: ActivityType.TASK,
          }),
        }),
      );
    });

    it('should find tasks with invalid parent (LEFT JOIN)', async () => {
      mockActivityRepo.find.mockResolvedValue([]);

      const orphanInvalidParent = makeActivity({
        id: ACTIVITY_ID_2,
        activityType: ActivityType.TASK,
        name: 'Orphan Invalid Parent',
      });

      const invalidParentQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([orphanInvalidParent]),
      });
      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(invalidParentQb);

      const result = await service.findOrphanedTasks();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(ACTIVITY_ID_2);
      expect(invalidParentQb.leftJoin).toHaveBeenCalled();
    });

    it('should return empty when all tasks have valid parents', async () => {
      mockActivityRepo.find.mockResolvedValue([]);

      const invalidParentQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      mockActivityRepo.createQueryBuilder.mockReturnValueOnce(invalidParentQb);

      const result = await service.findOrphanedTasks();

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // findMissingClientEntity
  // =========================================================================

  describe('findMissingClientEntity', () => {
    it('should find PROJECT and BUSINESS without clientEntityId', async () => {
      const missingClient = [
        makeActivity({ id: ACTIVITY_ID_1, activityType: ActivityType.PROJECT, clientEntityId: null }),
        makeActivity({ id: ACTIVITY_ID_2, activityType: ActivityType.BUSINESS, clientEntityId: null }),
      ];

      mockActivityRepo.find.mockResolvedValue(missingClient);

      const result = await service.findMissingClientEntity();

      expect(result).toHaveLength(2);
      expect(mockActivityRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.arrayContaining([
            expect.objectContaining({ activityType: ActivityType.PROJECT }),
            expect.objectContaining({ activityType: ActivityType.BUSINESS }),
          ]),
        }),
      );
    });

    it('should return empty when all have clients', async () => {
      mockActivityRepo.find.mockResolvedValue([]);

      const result = await service.findMissingClientEntity();

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // calculateActivityMemberCoverage
  // =========================================================================

  describe('calculateActivityMemberCoverage', () => {
    it('should calculate correct rate', async () => {
      mockActivityRepo.count.mockResolvedValue(10);

      const memberQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ count: '6' }),
      });
      mockMemberRepo.createQueryBuilder.mockReturnValueOnce(memberQb);

      const result = await service.calculateActivityMemberCoverage();

      expect(result).toEqual({ total: 10, withMembers: 6, rate: 0.6 });
    });

    it('should return 0 when no activities', async () => {
      mockActivityRepo.count.mockResolvedValue(0);

      const result = await service.calculateActivityMemberCoverage();

      expect(result).toEqual({ total: 0, withMembers: 0, rate: 0 });
      expect(mockMemberRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // calculateCommitmentLinkageRate
  // =========================================================================

  describe('calculateCommitmentLinkageRate', () => {
    it('should calculate correct rate', async () => {
      mockCommitmentRepo.count
        .mockResolvedValueOnce(20) // total
        .mockResolvedValueOnce(15); // linked

      const result = await service.calculateCommitmentLinkageRate();

      expect(result).toEqual({ total: 20, linked: 15, rate: 0.75 });
    });

    it('should return 0 when no commitments', async () => {
      mockCommitmentRepo.count.mockResolvedValue(0);

      const result = await service.calculateCommitmentLinkageRate();

      expect(result).toEqual({ total: 0, linked: 0, rate: 0 });
      // count called only once (total) because early return
      expect(mockCommitmentRepo.count).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // countInferredRelations
  // =========================================================================

  describe('countInferredRelations', () => {
    it('should count EXTRACTED and INFERRED relations', async () => {
      mockRelationRepo.count.mockResolvedValue(7);

      const result = await service.countInferredRelations();

      expect(result).toBe(7);
      expect(mockRelationRepo.count).toHaveBeenCalledWith({
        where: [
          { source: RelationSource.EXTRACTED },
          { source: RelationSource.INFERRED },
        ],
      });
    });
  });

  // =========================================================================
  // calculateFieldFillRate
  // =========================================================================

  describe('calculateFieldFillRate', () => {
    it('should calculate rate for description, priority, deadline, tags', async () => {
      mockActivityRepo.find.mockResolvedValue([
        makeActivity({
          description: 'Some desc',
          priority: ActivityPriority.HIGH,
          deadline: new Date(),
          tags: ['tag1'],
        }),
        makeActivity({
          description: null,
          priority: ActivityPriority.MEDIUM,
          deadline: null,
          tags: null,
        }),
      ]);

      const result = await service.calculateFieldFillRate();

      // Activity 1: 4/4 filled, Activity 2: 1/4 filled (priority is truthy)
      // total fields = 8, filled = 5
      expect(result.total).toBe(2);
      expect(result.avgFillRate).toBe(0.63); // 5/8 = 0.625 rounded to 0.63
    });

    it('should return 0 when no activities', async () => {
      mockActivityRepo.find.mockResolvedValue([]);

      const result = await service.calculateFieldFillRate();

      expect(result).toEqual({ total: 0, avgFillRate: 0 });
    });

    it('should handle activities with all fields empty (rate=0)', async () => {
      mockActivityRepo.find.mockResolvedValue([
        makeActivity({
          description: null,
          priority: null as any,
          deadline: null,
          tags: null,
        }),
      ]);

      const result = await service.calculateFieldFillRate();

      expect(result.total).toBe(1);
      expect(result.avgFillRate).toBe(0);
    });

    it('should handle activities with all fields filled (rate=1)', async () => {
      mockActivityRepo.find.mockResolvedValue([
        makeActivity({
          description: 'Full desc',
          priority: ActivityPriority.HIGH,
          deadline: new Date(),
          tags: ['a', 'b'],
        }),
      ]);

      const result = await service.calculateFieldFillRate();

      expect(result.total).toBe(1);
      expect(result.avgFillRate).toBe(1);
    });
  });

  // =========================================================================
  // getCurrentMetrics
  // =========================================================================

  describe('getCurrentMetrics', () => {
    it('should aggregate all metrics via Promise.all', async () => {
      // Mock activityRepo.count for totalActivities (called first in Promise.all)
      mockActivityRepo.count.mockResolvedValue(10);

      // Mock findDuplicateProjects (needs createQueryBuilder)
      const groupsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      mockActivityRepo.createQueryBuilder.mockReturnValue(groupsQb);

      // Mock findOrphanedTasks
      mockActivityRepo.find
        .mockResolvedValueOnce([]) // orphaned tasks (find with TASK + IsNull parent)
        .mockResolvedValueOnce([]) // missing client
        .mockResolvedValueOnce([]); // field fill rate activities

      // Mock member coverage
      mockMemberRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawOne: jest.fn().mockResolvedValue({ count: '0' }),
        }),
      );

      // Mock commitment linkage
      mockCommitmentRepo.count.mockResolvedValue(0);

      // Mock inferred relations
      mockRelationRepo.count.mockResolvedValue(0);

      const result = await service.getCurrentMetrics();

      expect(result).toEqual({
        totalActivities: 10,
        duplicateGroups: 0,
        orphanedTasks: 0,
        missingClientEntity: 0,
        activityMemberCoverage: 0,
        commitmentLinkageRate: 0,
        inferredRelationsCount: 0,
        fieldFillRate: 0,
      });
    });
  });

  // =========================================================================
  // getReports
  // =========================================================================

  describe('getReports', () => {
    it('should return paginated reports', async () => {
      const reports = [makeReport()];
      mockReportRepo.findAndCount.mockResolvedValue([reports, 1]);

      const result = await service.getReports(20, 0);

      expect(result).toEqual({ data: reports, total: 1 });
      expect(mockReportRepo.findAndCount).toHaveBeenCalledWith({
        order: { reportDate: 'DESC' },
        take: 20,
        skip: 0,
      });
    });

    it('should pass custom limit and offset', async () => {
      mockReportRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.getReports(5, 10);

      expect(mockReportRepo.findAndCount).toHaveBeenCalledWith({
        order: { reportDate: 'DESC' },
        take: 5,
        skip: 10,
      });
    });
  });

  // =========================================================================
  // getLatestReport
  // =========================================================================

  describe('getLatestReport', () => {
    it('should return most recent report', async () => {
      const report = makeReport();
      mockReportRepo.findOne.mockResolvedValue(report);

      const result = await service.getLatestReport();

      expect(result).toEqual(report);
      expect(mockReportRepo.findOne).toHaveBeenCalledWith({
        where: {},
        order: { reportDate: 'DESC' },
      });
    });

    it('should return null when no reports', async () => {
      mockReportRepo.findOne.mockResolvedValue(null);

      const result = await service.getLatestReport();

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // getReportById
  // =========================================================================

  describe('getReportById', () => {
    it('should return report by ID', async () => {
      const report = makeReport();
      mockReportRepo.findOne.mockResolvedValue(report);

      const result = await service.getReportById(REPORT_ID);

      expect(result).toEqual(report);
      expect(mockReportRepo.findOne).toHaveBeenCalledWith({ where: { id: REPORT_ID } });
    });

    it('should throw NotFoundException when not found', async () => {
      mockReportRepo.findOne.mockResolvedValue(null);

      await expect(service.getReportById('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // resolveIssue
  // =========================================================================

  describe('resolveIssue', () => {
    it('should add resolution entry', async () => {
      const report = makeReport({ resolutions: null });
      mockReportRepo.findOne.mockResolvedValue(report);
      mockReportRepo.save.mockImplementation((r) => Promise.resolve(r));

      const result = await service.resolveIssue(REPORT_ID, 0, 'Merged duplicates');

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions![0].issueIndex).toBe(0);
      expect(result.resolutions![0].action).toBe('Merged duplicates');
      expect(result.resolutions![0].resolvedBy).toBe('manual');
      expect(mockReportRepo.save).toHaveBeenCalled();
    });

    it('should set status REVIEWED when partially resolved', async () => {
      const report = makeReport({ resolutions: null });
      mockReportRepo.findOne.mockResolvedValue(report);
      mockReportRepo.save.mockImplementation((r) => Promise.resolve(r));

      const result = await service.resolveIssue(REPORT_ID, 0, 'Fixed first issue');

      // 2 issues total, only 1 resolved => REVIEWED
      expect(result.status).toBe(DataQualityReportStatus.REVIEWED);
    });

    it('should set status RESOLVED when all issues resolved', async () => {
      const report = makeReport({
        resolutions: [
          { issueIndex: 0, resolvedAt: new Date(), resolvedBy: 'manual' as const, action: 'First fix' },
        ],
      });
      mockReportRepo.findOne.mockResolvedValue(report);
      mockReportRepo.save.mockImplementation((r) => Promise.resolve(r));

      // Resolve issue index 1 (the second and last issue)
      const result = await service.resolveIssue(REPORT_ID, 1, 'Second fix');

      // Both issues resolved => RESOLVED
      expect(result.status).toBe(DataQualityReportStatus.RESOLVED);
      expect(result.resolutions).toHaveLength(2);
    });

    it('should throw NotFoundException for invalid issueIndex', async () => {
      const report = makeReport(); // has 2 issues (index 0 and 1)
      mockReportRepo.findOne.mockResolvedValue(report);

      await expect(service.resolveIssue(REPORT_ID, 5, 'Bad index')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException for negative issueIndex', async () => {
      const report = makeReport();
      mockReportRepo.findOne.mockResolvedValue(report);

      await expect(service.resolveIssue(REPORT_ID, -1, 'Negative')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // mergeActivities
  // =========================================================================

  describe('mergeActivities', () => {
    it('should move children to keep activity', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID, name: 'Keep Project' });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2, name: 'Merge Project' });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);
      mockMemberRepo.find.mockResolvedValue([]);

      const updateChildrenQb = createMockQueryBuilder();
      const reassignCommitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(updateChildrenQb)
        .mockReturnValueOnce(softDeleteQb);

      mockCommitmentRepo.createQueryBuilder.mockReturnValueOnce(reassignCommitmentsQb);
      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(updateChildrenQb.update).toHaveBeenCalledWith(Activity);
      expect(updateChildrenQb.set).toHaveBeenCalledWith({ parentId: KEEP_ID });
      expect(updateChildrenQb.execute).toHaveBeenCalled();
    });

    it('should move members (skip duplicates)', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2 });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);

      const member = {
        id: 'member-1',
        activityId: ACTIVITY_ID_2,
        entityId: ENTITY_ID_A,
        role: ActivityMemberRole.MEMBER,
      };
      mockMemberRepo.find.mockResolvedValue([member]);
      mockMemberRepo.findOne.mockResolvedValue(null); // no duplicate

      const memberUpdateQb = createMockQueryBuilder();
      mockMemberRepo.createQueryBuilder.mockReturnValueOnce(memberUpdateQb);

      const updateChildrenQb = createMockQueryBuilder();
      const reassignCommitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(updateChildrenQb)
        .mockReturnValueOnce(softDeleteQb);

      mockCommitmentRepo.createQueryBuilder.mockReturnValueOnce(reassignCommitmentsQb);
      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(mockMemberRepo.findOne).toHaveBeenCalledWith({
        where: {
          activityId: KEEP_ID,
          entityId: ENTITY_ID_A,
          role: ActivityMemberRole.MEMBER,
        },
      });
      expect(memberUpdateQb.update).toHaveBeenCalledWith(ActivityMember);
      expect(memberUpdateQb.set).toHaveBeenCalledWith({ activityId: KEEP_ID });
    });

    it('should skip duplicate members when merging', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2 });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);

      const member = {
        id: 'member-1',
        activityId: ACTIVITY_ID_2,
        entityId: ENTITY_ID_A,
        role: ActivityMemberRole.MEMBER,
      };
      mockMemberRepo.find.mockResolvedValue([member]);
      // Existing duplicate found
      mockMemberRepo.findOne.mockResolvedValue({
        id: 'existing-member',
        activityId: KEEP_ID,
        entityId: ENTITY_ID_A,
        role: ActivityMemberRole.MEMBER,
      });

      const updateChildrenQb = createMockQueryBuilder();
      const reassignCommitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(updateChildrenQb)
        .mockReturnValueOnce(softDeleteQb);

      mockCommitmentRepo.createQueryBuilder.mockReturnValueOnce(reassignCommitmentsQb);
      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      // Should NOT create a QueryBuilder to move this member
      expect(mockMemberRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should reassign commitments', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2 });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);
      mockMemberRepo.find.mockResolvedValue([]);

      const updateChildrenQb = createMockQueryBuilder();
      const reassignCommitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(updateChildrenQb)
        .mockReturnValueOnce(softDeleteQb);

      mockCommitmentRepo.createQueryBuilder.mockReturnValueOnce(reassignCommitmentsQb);
      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(reassignCommitmentsQb.update).toHaveBeenCalledWith(Commitment);
      expect(reassignCommitmentsQb.set).toHaveBeenCalledWith({ activityId: KEEP_ID });
      expect(reassignCommitmentsQb.execute).toHaveBeenCalled();
    });

    it('should soft-delete merged activities (ARCHIVED + deletedAt)', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2 });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);
      mockMemberRepo.find.mockResolvedValue([]);

      const updateChildrenQb = createMockQueryBuilder();
      const reassignCommitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(updateChildrenQb)
        .mockReturnValueOnce(softDeleteQb);

      mockCommitmentRepo.createQueryBuilder.mockReturnValueOnce(reassignCommitmentsQb);
      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(softDeleteQb.update).toHaveBeenCalledWith(Activity);
      expect(softDeleteQb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ActivityStatus.ARCHIVED,
        }),
      );
      expect(softDeleteQb.execute).toHaveBeenCalled();
    });

    it('should throw NotFoundException when keepId not found', async () => {
      mockActivityRepo.findOne.mockResolvedValue(null);

      await expect(
        service.mergeActivities('nonexistent', [ACTIVITY_ID_2]),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when mergeIds not found', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID });
      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([]); // none found

      await expect(
        service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2, ACTIVITY_ID_3]),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return updated keep activity after merge', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID, name: 'Keep Project' });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2 });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);
      mockMemberRepo.find.mockResolvedValue([]);

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(createMockQueryBuilder())
        .mockReturnValueOnce(createMockQueryBuilder());

      mockCommitmentRepo.createQueryBuilder.mockReturnValueOnce(createMockQueryBuilder());

      const updatedKeep = makeActivity({ id: KEEP_ID, name: 'Keep Project' });
      mockActivityRepo.findOneOrFail.mockResolvedValue(updatedKeep);

      const result = await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(result).toEqual(updatedKeep);
      expect(mockActivityRepo.findOneOrFail).toHaveBeenCalledWith({
        where: { id: KEEP_ID },
      });
    });
  });

  // =========================================================================
  // runFullAudit
  // =========================================================================

  describe('runFullAudit', () => {
    it('should create report with metrics and issues, status PENDING', async () => {
      // Setup mocks for getCurrentMetrics + detectIssues
      // Both call findDuplicateProjects, findOrphanedTasks, findMissingClientEntity

      // activityRepo.count (for totalActivities + member coverage)
      mockActivityRepo.count.mockResolvedValue(0);

      // findDuplicateProjects (called twice: getCurrentMetrics + detectIssues)
      const emptyGroupsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      mockActivityRepo.createQueryBuilder.mockReturnValue(emptyGroupsQb);

      // findOrphanedTasks, findMissingClientEntity, calculateFieldFillRate
      mockActivityRepo.find.mockResolvedValue([]);

      // member coverage
      mockMemberRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawOne: jest.fn().mockResolvedValue({ count: '0' }),
        }),
      );

      // commitment
      mockCommitmentRepo.count.mockResolvedValue(0);

      // relations
      mockRelationRepo.count.mockResolvedValue(0);

      // report creation
      const createdReport = makeReport({ status: DataQualityReportStatus.PENDING });
      mockReportRepo.create.mockReturnValue(createdReport);
      mockReportRepo.save.mockResolvedValue({ ...createdReport, id: REPORT_ID });

      const result = await service.runFullAudit();

      expect(mockReportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: DataQualityReportStatus.PENDING,
        }),
      );
      expect(mockReportRepo.save).toHaveBeenCalled();
      expect(result.id).toBe(REPORT_ID);
    });
  });
});
