import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataQualityService } from './data-quality.service';
import { OrphanResolutionService } from './orphan-resolution.service';
import { ClientResolutionService } from '../extraction/client-resolution.service';
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
    update: jest.fn(),
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
  // Mock QueryRunner + DataSource (for transactional mergeActivities)
  // ---------------------------------------------------------------------------

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
    manager: {
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    },
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  };

  const mockOrphanResolutionService = {
    resolveOrphans: jest.fn(),
  };

  const mockClientResolutionService = {
    resolveClient: jest.fn(),
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
        { provide: DataSource, useValue: mockDataSource },
        { provide: OrphanResolutionService, useValue: mockOrphanResolutionService },
        { provide: ClientResolutionService, useValue: mockClientResolutionService },
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

    it('should throw BadRequestException for invalid issueIndex', async () => {
      const report = makeReport(); // has 2 issues (index 0 and 1)
      mockReportRepo.findOne.mockResolvedValue(report);

      await expect(service.resolveIssue(REPORT_ID, 5, 'Bad index')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for negative issueIndex', async () => {
      const report = makeReport();
      mockReportRepo.findOne.mockResolvedValue(report);

      await expect(service.resolveIssue(REPORT_ID, -1, 'Negative')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // =========================================================================
  // mergeActivities
  // =========================================================================

  describe('mergeActivities', () => {
    it('should throw BadRequestException when keepId appears in mergeIds', async () => {
      await expect(
        service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2, KEEP_ID]),
      ).rejects.toThrow(BadRequestException);
    });

    it('should move children to keep activity', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID, name: 'Keep Project' });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2, name: 'Merge Project' });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);
      mockQueryRunner.manager.find.mockResolvedValue([]);

      const childrenQb = createMockQueryBuilder();
      const commitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockQueryRunner.manager.createQueryBuilder
        .mockReturnValueOnce(childrenQb)
        .mockReturnValueOnce(commitmentsQb)
        .mockReturnValueOnce(softDeleteQb);

      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(childrenQb.update).toHaveBeenCalledWith(Activity);
      expect(childrenQb.set).toHaveBeenCalledWith({ parentId: KEEP_ID });
      expect(childrenQb.execute).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
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
      mockQueryRunner.manager.find.mockResolvedValue([member]);
      mockQueryRunner.manager.findOne.mockResolvedValue(null); // no duplicate

      const childrenQb = createMockQueryBuilder();
      const memberUpdateQb = createMockQueryBuilder();
      const commitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockQueryRunner.manager.createQueryBuilder
        .mockReturnValueOnce(childrenQb)
        .mockReturnValueOnce(memberUpdateQb)
        .mockReturnValueOnce(commitmentsQb)
        .mockReturnValueOnce(softDeleteQb);

      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(mockQueryRunner.manager.findOne).toHaveBeenCalledWith(ActivityMember, {
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
      mockQueryRunner.manager.find.mockResolvedValue([member]);
      // Existing duplicate found
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: 'existing-member',
        activityId: KEEP_ID,
        entityId: ENTITY_ID_A,
        role: ActivityMemberRole.MEMBER,
      });

      const childrenQb = createMockQueryBuilder();
      const commitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      // Only 3 QBs — no member update since duplicate is skipped
      mockQueryRunner.manager.createQueryBuilder
        .mockReturnValueOnce(childrenQb)
        .mockReturnValueOnce(commitmentsQb)
        .mockReturnValueOnce(softDeleteQb);

      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(mockQueryRunner.manager.createQueryBuilder).toHaveBeenCalledTimes(3);
    });

    it('should reassign commitments', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2 });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);
      mockQueryRunner.manager.find.mockResolvedValue([]);

      const childrenQb = createMockQueryBuilder();
      const commitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockQueryRunner.manager.createQueryBuilder
        .mockReturnValueOnce(childrenQb)
        .mockReturnValueOnce(commitmentsQb)
        .mockReturnValueOnce(softDeleteQb);

      mockActivityRepo.findOneOrFail.mockResolvedValue(keepActivity);

      await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(commitmentsQb.update).toHaveBeenCalledWith(Commitment);
      expect(commitmentsQb.set).toHaveBeenCalledWith({ activityId: KEEP_ID });
      expect(commitmentsQb.execute).toHaveBeenCalled();
    });

    it('should soft-delete merged activities (ARCHIVED + deletedAt)', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2 });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);
      mockQueryRunner.manager.find.mockResolvedValue([]);

      const childrenQb = createMockQueryBuilder();
      const commitmentsQb = createMockQueryBuilder();
      const softDeleteQb = createMockQueryBuilder();

      mockQueryRunner.manager.createQueryBuilder
        .mockReturnValueOnce(childrenQb)
        .mockReturnValueOnce(commitmentsQb)
        .mockReturnValueOnce(softDeleteQb);

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
      mockQueryRunner.manager.find.mockResolvedValue([]);

      mockQueryRunner.manager.createQueryBuilder
        .mockReturnValue(createMockQueryBuilder());

      const updatedKeep = makeActivity({ id: KEEP_ID, name: 'Keep Project' });
      mockActivityRepo.findOneOrFail.mockResolvedValue(updatedKeep);

      const result = await service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]);

      expect(result).toEqual(updatedKeep);
      expect(mockActivityRepo.findOneOrFail).toHaveBeenCalledWith({
        where: { id: KEEP_ID },
      });
    });

    it('should rollback transaction on error', async () => {
      const keepActivity = makeActivity({ id: KEEP_ID });
      const mergeActivity = makeActivity({ id: ACTIVITY_ID_2 });

      mockActivityRepo.findOne.mockResolvedValue(keepActivity);
      mockActivityRepo.find.mockResolvedValue([mergeActivity]);

      mockQueryRunner.manager.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({
          execute: jest.fn().mockRejectedValue(new Error('DB error')),
        }),
      );

      await expect(
        service.mergeActivities(KEEP_ID, [ACTIVITY_ID_2]),
      ).rejects.toThrow('DB error');

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // autoMergeAllDuplicates
  // =========================================================================

  describe('autoMergeAllDuplicates', () => {
    it('should return empty result when no duplicates', async () => {
      jest.spyOn(service, 'findDuplicateProjects').mockResolvedValue([]);

      const result = await service.autoMergeAllDuplicates();

      expect(result).toEqual({
        mergedGroups: 0,
        totalMerged: 0,
        errors: [],
        details: [],
      });
      expect(service.findDuplicateProjects).toHaveBeenCalledTimes(1);
    });

    it('should merge duplicate groups and return details', async () => {
      const keeperActivity = makeActivity({ id: KEEP_ID, name: 'Project Alpha' });
      const duplicateGroup = {
        name: 'project alpha',
        type: ActivityType.PROJECT,
        count: 2,
        activities: [
          { id: KEEP_ID, name: 'Project Alpha', status: ActivityStatus.ACTIVE, createdAt: new Date('2025-01-01') },
          { id: ACTIVITY_ID_2, name: 'project alpha', status: ActivityStatus.DRAFT, createdAt: new Date('2025-01-15') },
        ],
      };

      jest.spyOn(service, 'findDuplicateProjects').mockResolvedValue([duplicateGroup]);
      jest.spyOn(service as any, 'selectKeeper').mockResolvedValue(keeperActivity);
      jest.spyOn(service, 'mergeActivities').mockResolvedValue(keeperActivity);

      const result = await service.autoMergeAllDuplicates();

      expect(result.mergedGroups).toBe(1);
      expect(result.totalMerged).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toEqual({
        keptId: KEEP_ID,
        keptName: 'Project Alpha',
        mergedIds: [ACTIVITY_ID_2],
      });
      expect(service.mergeActivities).toHaveBeenCalledWith(KEEP_ID, [ACTIVITY_ID_2]);
    });

    it('should select keeper with most children', async () => {
      // Activity 1 has 0 children, Activity 2 has 3 children
      // selectKeeper should pick Activity 2 as keeper
      const duplicateGroup = {
        name: 'project beta',
        type: ActivityType.PROJECT,
        count: 2,
        activities: [
          { id: ACTIVITY_ID_1, name: 'Project Beta', status: ActivityStatus.ACTIVE, createdAt: new Date('2025-01-01') },
          { id: ACTIVITY_ID_2, name: 'project beta', status: ActivityStatus.ACTIVE, createdAt: new Date('2025-01-10') },
        ],
      };

      jest.spyOn(service, 'findDuplicateProjects').mockResolvedValue([duplicateGroup]);

      // Mock child counts: ACTIVITY_ID_2 has 3 children, ACTIVITY_ID_1 has 0
      const childCountQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { parentId: ACTIVITY_ID_2, cnt: '3' },
        ]),
      });

      // Mock member counts: both 0
      const memberCountQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      mockActivityRepo.createQueryBuilder
        .mockReturnValueOnce(childCountQb)   // selectKeeper: child counts
      mockMemberRepo.createQueryBuilder
        .mockReturnValueOnce(memberCountQb); // selectKeeper: member counts

      // Mock activityRepo.find for selectKeeper (fetch activities with createdAt)
      const activity1 = makeActivity({ id: ACTIVITY_ID_1, name: 'Project Beta', createdAt: new Date('2025-01-01') });
      const activity2 = makeActivity({ id: ACTIVITY_ID_2, name: 'project beta', createdAt: new Date('2025-01-10') });
      mockActivityRepo.find.mockResolvedValue([activity1, activity2]);

      // Mock mergeActivities to avoid deep repo calls
      jest.spyOn(service, 'mergeActivities').mockResolvedValue(activity2);

      const result = await service.autoMergeAllDuplicates();

      expect(result.mergedGroups).toBe(1);
      // ACTIVITY_ID_2 is keeper (most children), ACTIVITY_ID_1 gets merged
      expect(result.details[0].keptId).toBe(ACTIVITY_ID_2);
      expect(result.details[0].mergedIds).toEqual([ACTIVITY_ID_1]);
      expect(service.mergeActivities).toHaveBeenCalledWith(ACTIVITY_ID_2, [ACTIVITY_ID_1]);
    });

    it('should continue on error in one group and collect errors', async () => {
      const keeperActivity1 = makeActivity({ id: KEEP_ID, name: 'Group A' });
      const keeperActivity2 = makeActivity({ id: ACTIVITY_ID_3, name: 'Group B' });

      const group1 = {
        name: 'group a',
        type: ActivityType.PROJECT,
        count: 2,
        activities: [
          { id: KEEP_ID, name: 'Group A', status: ActivityStatus.ACTIVE, createdAt: new Date('2025-01-01') },
          { id: ACTIVITY_ID_1, name: 'group a', status: ActivityStatus.DRAFT, createdAt: new Date('2025-01-10') },
        ],
      };

      const group2 = {
        name: 'group b',
        type: ActivityType.PROJECT,
        count: 2,
        activities: [
          { id: ACTIVITY_ID_3, name: 'Group B', status: ActivityStatus.ACTIVE, createdAt: new Date('2025-01-01') },
          { id: ACTIVITY_ID_2, name: 'group b', status: ActivityStatus.DRAFT, createdAt: new Date('2025-01-15') },
        ],
      };

      jest.spyOn(service, 'findDuplicateProjects').mockResolvedValue([group1, group2]);

      const selectKeeperSpy = jest.spyOn(service as any, 'selectKeeper');
      selectKeeperSpy
        .mockResolvedValueOnce(keeperActivity1)   // group 1 keeper
        .mockResolvedValueOnce(keeperActivity2);   // group 2 keeper

      const mergeActivitiesSpy = jest.spyOn(service, 'mergeActivities');
      mergeActivitiesSpy
        .mockRejectedValueOnce(new Error('DB connection lost'))  // group 1 fails
        .mockResolvedValueOnce(keeperActivity2);                  // group 2 succeeds

      const result = await service.autoMergeAllDuplicates();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].group).toBe('group a');
      expect(result.errors[0].error).toBe('DB connection lost');
      expect(result.mergedGroups).toBe(1);
      expect(result.totalMerged).toBe(1);
      expect(result.details).toHaveLength(1);
      expect(result.details[0].keptId).toBe(ACTIVITY_ID_3);
      expect(result.details[0].mergedIds).toEqual([ACTIVITY_ID_2]);
    });
  });

  // =========================================================================
  // autoAssignOrphanedTasks
  // =========================================================================

  describe('autoAssignOrphanedTasks', () => {
    it('should return empty result when no orphans', async () => {
      jest.spyOn(service, 'findOrphanedTasks').mockResolvedValue([]);

      const result = await service.autoAssignOrphanedTasks();

      expect(result).toEqual({
        resolved: 0,
        unresolved: 0,
        createdUnsortedProject: false,
        details: [],
      });
      expect(mockOrphanResolutionService.resolveOrphans).not.toHaveBeenCalled();
    });

    it('should fetch full task data and delegate to OrphanResolutionService', async () => {
      const orphanSummary = [
        makeActivity({ id: ACTIVITY_ID_1, activityType: ActivityType.TASK, name: 'Orphan 1' }),
        makeActivity({ id: ACTIVITY_ID_2, activityType: ActivityType.TASK, name: 'Orphan 2' }),
      ];

      jest.spyOn(service, 'findOrphanedTasks').mockResolvedValue(orphanSummary);

      const fullTasks = [
        makeActivity({ id: ACTIVITY_ID_1, activityType: ActivityType.TASK, name: 'Orphan 1', ownerEntityId: ENTITY_ID_A }),
        makeActivity({ id: ACTIVITY_ID_2, activityType: ActivityType.TASK, name: 'Orphan 2', ownerEntityId: ENTITY_ID_A }),
      ];
      mockActivityRepo.find.mockResolvedValue(fullTasks);

      const resolveResult = {
        resolved: 2,
        unresolved: 0,
        createdUnsortedProject: false,
        details: [
          { taskId: ACTIVITY_ID_1, taskName: 'Orphan 1', assignedParentId: KEEP_ID, assignedParentName: 'Project A', method: 'name_containment' as const },
          { taskId: ACTIVITY_ID_2, taskName: 'Orphan 2', assignedParentId: KEEP_ID, assignedParentName: 'Project A', method: 'single_project' as const },
        ],
      };
      mockOrphanResolutionService.resolveOrphans.mockResolvedValue(resolveResult);

      const result = await service.autoAssignOrphanedTasks();

      expect(result.resolved).toBe(2);
      expect(result.details).toHaveLength(2);
      expect(mockActivityRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: expect.anything(),
          }),
        }),
      );
      expect(mockOrphanResolutionService.resolveOrphans).toHaveBeenCalledWith(fullTasks);
    });
  });

  // =========================================================================
  // autoResolveClients
  // =========================================================================

  describe('autoResolveClients', () => {
    it('should return empty result when no activities with missing clients', async () => {
      jest.spyOn(service, 'findMissingClientEntity').mockResolvedValue([]);

      const result = await service.autoResolveClients();

      expect(result).toEqual({ resolved: 0, unresolved: 0, details: [] });
      expect(mockClientResolutionService.resolveClient).not.toHaveBeenCalled();
    });

    it('should resolve clients for activities with members', async () => {
      const missingSummary = [
        makeActivity({ id: ACTIVITY_ID_1, activityType: ActivityType.PROJECT, name: 'Project X', clientEntityId: null }),
      ];
      jest.spyOn(service, 'findMissingClientEntity').mockResolvedValue(missingSummary);

      // Full activity fetch
      const fullActivity = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Project X',
        ownerEntityId: ENTITY_ID_A,
        clientEntityId: null,
      });
      mockActivityRepo.find.mockResolvedValue([fullActivity]);

      // Members with entity names
      mockMemberRepo.find.mockResolvedValue([
        { id: 'mem-1', activityId: ACTIVITY_ID_1, entityId: 'ent-1', entity: { name: 'Acme Corp' } },
        { id: 'mem-2', activityId: ACTIVITY_ID_1, entityId: 'ent-2', entity: { name: 'John Doe' } },
      ]);

      // Client resolution success
      mockClientResolutionService.resolveClient.mockResolvedValue({
        entityId: 'client-entity-id',
        entityName: 'Acme Corp',
        method: 'participant_org' as const,
      });

      mockActivityRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.autoResolveClients();

      expect(result.resolved).toBe(1);
      expect(result.unresolved).toBe(0);
      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toEqual({
        activityId: ACTIVITY_ID_1,
        activityName: 'Project X',
        clientEntityId: 'client-entity-id',
        clientName: 'Acme Corp',
        method: 'participant_org',
      });
      expect(mockClientResolutionService.resolveClient).toHaveBeenCalledWith({
        participants: ['Acme Corp', 'John Doe'],
        ownerEntityId: ENTITY_ID_A,
      });
      expect(mockActivityRepo.update).toHaveBeenCalledWith(ACTIVITY_ID_1, {
        clientEntityId: 'client-entity-id',
      });
    });

    it('should count unresolved when clientResolutionService returns null', async () => {
      const missingSummary = [
        makeActivity({ id: ACTIVITY_ID_1, activityType: ActivityType.PROJECT, name: 'Unknown Project' }),
      ];
      jest.spyOn(service, 'findMissingClientEntity').mockResolvedValue(missingSummary);

      const fullActivity = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'Unknown Project',
        ownerEntityId: ENTITY_ID_A,
      });
      mockActivityRepo.find.mockResolvedValue([fullActivity]);
      mockMemberRepo.find.mockResolvedValue([]);
      mockClientResolutionService.resolveClient.mockResolvedValue(null);

      const result = await service.autoResolveClients();

      expect(result.resolved).toBe(0);
      expect(result.unresolved).toBe(1);
      expect(result.details).toHaveLength(0);
    });

    it('should skip activities without ownerEntityId', async () => {
      const missingSummary = [
        makeActivity({ id: ACTIVITY_ID_1, activityType: ActivityType.PROJECT, name: 'No Owner' }),
      ];
      jest.spyOn(service, 'findMissingClientEntity').mockResolvedValue(missingSummary);

      const fullActivity = makeActivity({
        id: ACTIVITY_ID_1,
        name: 'No Owner',
        ownerEntityId: null as any,
      });
      mockActivityRepo.find.mockResolvedValue([fullActivity]);

      const result = await service.autoResolveClients();

      expect(result.unresolved).toBe(1);
      expect(result.resolved).toBe(0);
      expect(mockClientResolutionService.resolveClient).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // runFullAudit
  // =========================================================================

  describe('runFullAudit', () => {
    it('should create report with metrics and issues, status PENDING', async () => {
      // Setup mocks for runFullAudit — data fetched once via Promise.all

      // activityRepo.count (for totalActivities + member coverage)
      mockActivityRepo.count.mockResolvedValue(0);

      // findDuplicateProjects
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
