import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PendingApprovalCleanupService } from './pending-approval-cleanup.service';
import {
  PendingApproval,
  PendingApprovalItemType,
  PendingApprovalStatus,
  EntityFact,
  EntityFactStatus,
  Activity,
  Commitment,
} from '@pkg/entities';

describe('PendingApprovalCleanupService', () => {
  let service: PendingApprovalCleanupService;

  // Sample rejected approval older than retention period
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 40); // 40 days ago (older than 30 days default)

  const recentDate = new Date();
  recentDate.setDate(recentDate.getDate() - 10); // 10 days ago (within retention)

  const createMockRejectedApprovalOld = (
    overrides: Partial<PendingApproval> = {},
  ): Partial<PendingApproval> => ({
    id: 'approval-old-1',
    itemType: PendingApprovalItemType.FACT,
    targetId: 'fact-old-1',
    batchId: 'batch-1',
    status: PendingApprovalStatus.REJECTED,
    confidence: 0.7,
    reviewedAt: oldDate,
    createdAt: oldDate,
    ...overrides,
  });

  // Create fresh mocks for each test
  let mockApprovalRepository: {
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  let mockFactRepository: {
    find: jest.Mock;
    delete: jest.Mock;
  };

  let mockActivityRepository: {
    find: jest.Mock;
    delete: jest.Mock;
  };

  let mockCommitmentRepository: {
    find: jest.Mock;
    delete: jest.Mock;
  };

  let mockManager: {
    query: jest.Mock;
    delete: jest.Mock;
  };

  let mockDataSource: {
    transaction: jest.Mock;
    query: jest.Mock;
    manager: {
      query: jest.Mock;
    };
  };

  let mockConfigService: {
    get: jest.Mock;
  };

  beforeEach(async () => {
    // Create fresh mocks for each test
    mockApprovalRepository = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    mockFactRepository = {
      find: jest.fn(),
      delete: jest.fn(),
    };

    mockActivityRepository = {
      find: jest.fn(),
      delete: jest.fn(),
    };

    mockCommitmentRepository = {
      find: jest.fn(),
      delete: jest.fn(),
    };

    mockManager = {
      query: jest.fn(),
      delete: jest.fn(),
    };

    mockDataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(mockManager)),
      query: jest.fn(),
      manager: {
        query: jest.fn(),
      },
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue(30), // Default retention days
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PendingApprovalCleanupService,
        {
          provide: getRepositoryToken(PendingApproval),
          useValue: mockApprovalRepository,
        },
        {
          provide: getRepositoryToken(EntityFact),
          useValue: mockFactRepository,
        },
        {
          provide: getRepositoryToken(Activity),
          useValue: mockActivityRepository,
        },
        {
          provide: getRepositoryToken(Commitment),
          useValue: mockCommitmentRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<PendingApprovalCleanupService>(
      PendingApprovalCleanupService,
    );
  });

  describe('Configuration', () => {
    it('should respect PENDING_APPROVAL_RETENTION_DAYS from ConfigService', async () => {
      expect(mockConfigService.get).toHaveBeenCalledWith(
        'PENDING_APPROVAL_RETENTION_DAYS',
        30,
      );
    });

    it('should default to 30 days if not configured', async () => {
      const localConfigService = {
        get: jest.fn().mockImplementation((_key, defaultValue) => defaultValue),
      };

      const localApprovalRepo = { find: jest.fn() };
      const localDataSource = {
        transaction: jest.fn(),
        query: jest.fn(),
        manager: { query: jest.fn() },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PendingApprovalCleanupService,
          { provide: getRepositoryToken(PendingApproval), useValue: localApprovalRepo },
          { provide: getRepositoryToken(EntityFact), useValue: mockFactRepository },
          { provide: getRepositoryToken(Activity), useValue: mockActivityRepository },
          { provide: getRepositoryToken(Commitment), useValue: mockCommitmentRepository },
          { provide: DataSource, useValue: localDataSource },
          { provide: ConfigService, useValue: localConfigService },
        ],
      }).compile();

      const serviceWithDefault = module.get<PendingApprovalCleanupService>(
        PendingApprovalCleanupService,
      );

      // The service should use 30 as default
      localApprovalRepo.find.mockResolvedValue([]);
      await serviceWithDefault.cleanupRejectedApprovals();

      expect(localApprovalRepo.find).toHaveBeenCalled();
      expect(localConfigService.get).toHaveBeenCalledWith(
        'PENDING_APPROVAL_RETENTION_DAYS',
        30,
      );
    });
  });

  describe('cleanupRejectedApprovals', () => {
    it('should hard-delete rejected approvals older than retention period', async () => {
      const oldApproval = createMockRejectedApprovalOld();

      // First batch: one old rejected approval (filtered by LessThan in SQL)
      mockApprovalRepository.find
        .mockResolvedValueOnce([oldApproval])
        .mockResolvedValueOnce([]);

      // TypeORM raw query for DELETE returns result with rowCount property
      const deleteResult = { rowCount: 1 };
      mockManager.query.mockResolvedValue(deleteResult);
      mockManager.delete.mockResolvedValue({ affected: 1 });

      const result = await service.cleanupRejectedApprovals();

      expect(result.approvals).toBe(1);
      expect(result.targets).toBe(1);
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockManager.delete).toHaveBeenCalledWith(
        PendingApproval,
        { id: In(['approval-old-1']) },
      );
    });

    it('should NOT delete rejected approvals younger than retention period', async () => {
      // With LessThan filtering in SQL, recent approvals are NOT returned from DB
      // So the mock should return empty array (simulating SQL filtering)
      mockApprovalRepository.find.mockResolvedValueOnce([]);

      const result = await service.cleanupRejectedApprovals();

      // No approvals returned from DB because LessThan(cutoffDate) filters them
      expect(result.approvals).toBe(0);
      expect(result.targets).toBe(0);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('should NOT delete pending or approved approvals', async () => {
      // The find query filters by status: REJECTED, so pending/approved won't be returned
      mockApprovalRepository.find.mockResolvedValue([]);

      const result = await service.cleanupRejectedApprovals();

      expect(result.approvals).toBe(0);
      expect(result.targets).toBe(0);

      // Verify the find was called with correct status filter
      expect(mockApprovalRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: PendingApprovalStatus.REJECTED,
          }),
        }),
      );
    });

    it('should delete associated target entities (EntityFact)', async () => {
      const factApproval = createMockRejectedApprovalOld({
        itemType: PendingApprovalItemType.FACT,
        targetId: 'fact-to-delete',
      });

      mockApprovalRepository.find
        .mockResolvedValueOnce([factApproval])
        .mockResolvedValueOnce([]);
      mockManager.query.mockResolvedValue([{}, 1]);
      mockManager.delete.mockResolvedValue({ affected: 1 });

      await service.cleanupRejectedApprovals();

      // Verify the raw query was called to delete from entity_facts table
      expect(mockManager.query).toHaveBeenCalledWith(
        'DELETE FROM entity_facts WHERE id = ANY($1::uuid[])',
        [['fact-to-delete']],
      );
    });

    it('should delete associated target entities (Activity)', async () => {
      const activityApproval = createMockRejectedApprovalOld({
        id: 'approval-activity',
        itemType: PendingApprovalItemType.PROJECT,
        targetId: 'activity-to-delete',
      });

      mockApprovalRepository.find
        .mockResolvedValueOnce([activityApproval])
        .mockResolvedValueOnce([]);
      mockManager.query.mockResolvedValue([{}, 1]);
      mockManager.delete.mockResolvedValue({ affected: 1 });

      await service.cleanupRejectedApprovals();

      expect(mockManager.query).toHaveBeenCalledWith(
        'DELETE FROM activities WHERE id = ANY($1::uuid[])',
        [['activity-to-delete']],
      );
    });

    it('should delete associated target entities (Commitment)', async () => {
      const commitmentApproval = createMockRejectedApprovalOld({
        id: 'approval-commitment',
        itemType: PendingApprovalItemType.COMMITMENT,
        targetId: 'commitment-to-delete',
      });

      mockApprovalRepository.find
        .mockResolvedValueOnce([commitmentApproval])
        .mockResolvedValueOnce([]);
      mockManager.query.mockResolvedValue([{}, 1]);
      mockManager.delete.mockResolvedValue({ affected: 1 });

      await service.cleanupRejectedApprovals();

      expect(mockManager.query).toHaveBeenCalledWith(
        'DELETE FROM commitments WHERE id = ANY($1::uuid[])',
        [['commitment-to-delete']],
      );
    });

    it('should process in batches (not load all at once)', async () => {
      // Create 150 approvals (more than batchSize of 100)
      const batch1 = Array.from({ length: 100 }, (_, i) =>
        createMockRejectedApprovalOld({
          id: `approval-batch1-${i}`,
          targetId: `fact-batch1-${i}`,
        }),
      );

      const batch2 = Array.from({ length: 50 }, (_, i) =>
        createMockRejectedApprovalOld({
          id: `approval-batch2-${i}`,
          targetId: `fact-batch2-${i}`,
        }),
      );

      mockApprovalRepository.find
        .mockResolvedValueOnce(batch1) // First batch: 100 items
        .mockResolvedValueOnce(batch2) // Second batch: 50 items (less than batchSize = end)
        .mockResolvedValueOnce([]);    // Safety fallback

      mockManager.query.mockResolvedValue([{}, 100]);
      mockManager.delete.mockResolvedValue({ affected: 100 });

      const result = await service.cleanupRejectedApprovals();

      // Should process all 150 approvals in 2 batches
      expect(result.approvals).toBe(150);
      expect(mockApprovalRepository.find).toHaveBeenCalledTimes(2);
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it('should handle mixed item types in a single batch', async () => {
      const mixedApprovals = [
        createMockRejectedApprovalOld({ id: 'a1', itemType: PendingApprovalItemType.FACT, targetId: 'fact-1' }),
        createMockRejectedApprovalOld({ id: 'a2', itemType: PendingApprovalItemType.PROJECT, targetId: 'activity-1' }),
        createMockRejectedApprovalOld({ id: 'a3', itemType: PendingApprovalItemType.COMMITMENT, targetId: 'commitment-1' }),
      ];

      mockApprovalRepository.find
        .mockResolvedValueOnce(mixedApprovals)
        .mockResolvedValueOnce([]);
      mockManager.query.mockResolvedValue([{}, 1]);
      mockManager.delete.mockResolvedValue({ affected: 3 });

      const result = await service.cleanupRejectedApprovals();

      expect(result.approvals).toBe(3);
      // Verify each table was targeted
      expect(mockManager.query).toHaveBeenCalledWith(
        'DELETE FROM entity_facts WHERE id = ANY($1::uuid[])',
        [['fact-1']],
      );
      expect(mockManager.query).toHaveBeenCalledWith(
        'DELETE FROM activities WHERE id = ANY($1::uuid[])',
        [['activity-1']],
      );
      expect(mockManager.query).toHaveBeenCalledWith(
        'DELETE FROM commitments WHERE id = ANY($1::uuid[])',
        [['commitment-1']],
      );
    });
  });

  describe('cleanupOrphanedDrafts', () => {
    it('should delete draft EntityFacts without associated PendingApproval', async () => {
      const orphanedDraft = { id: 'orphan-fact-1' };

      // Query returns draft fact, then empty for second iteration
      // Then empty for activities and commitments
      mockDataSource.query
        .mockResolvedValueOnce([orphanedDraft]) // facts - first batch
        .mockResolvedValueOnce([])              // facts - no more
        .mockResolvedValueOnce([])              // activities
        .mockResolvedValueOnce([]);             // commitments

      // No PendingApproval exists for this draft
      mockApprovalRepository.find.mockResolvedValue([]);

      mockDataSource.manager.query.mockResolvedValue([{}, 1]);

      const result = await service.cleanupOrphanedDrafts();

      expect(result.facts).toBe(1);
      expect(mockDataSource.manager.query).toHaveBeenCalledWith(
        'DELETE FROM entity_facts WHERE id = ANY($1::uuid[])',
        [['orphan-fact-1']],
      );
    });

    it('should delete draft Activities without associated PendingApproval', async () => {
      const orphanedActivity = { id: 'orphan-activity-1' };

      mockDataSource.query
        .mockResolvedValueOnce([])                  // facts - empty
        .mockResolvedValueOnce([orphanedActivity]) // activities - first batch
        .mockResolvedValueOnce([])                  // activities - no more
        .mockResolvedValueOnce([]);                 // commitments

      // No PendingApproval exists for this draft
      mockApprovalRepository.find.mockResolvedValue([]);

      mockDataSource.manager.query.mockResolvedValue([{}, 1]);

      const result = await service.cleanupOrphanedDrafts();

      expect(result.activities).toBe(1);
      expect(mockDataSource.manager.query).toHaveBeenCalledWith(
        'DELETE FROM activities WHERE id = ANY($1::uuid[])',
        [['orphan-activity-1']],
      );
    });

    it('should delete draft Commitments without associated PendingApproval', async () => {
      const orphanedCommitment = { id: 'orphan-commitment-1' };

      mockDataSource.query
        .mockResolvedValueOnce([])                   // facts - empty
        .mockResolvedValueOnce([])                   // activities - empty
        .mockResolvedValueOnce([orphanedCommitment]) // commitments - first batch
        .mockResolvedValueOnce([]);                  // commitments - no more

      // No PendingApproval exists for this draft
      mockApprovalRepository.find.mockResolvedValue([]);

      mockDataSource.manager.query.mockResolvedValue([{}, 1]);

      const result = await service.cleanupOrphanedDrafts();

      expect(result.commitments).toBe(1);
      expect(mockDataSource.manager.query).toHaveBeenCalledWith(
        'DELETE FROM commitments WHERE id = ANY($1::uuid[])',
        [['orphan-commitment-1']],
      );
    });

    it('should NOT delete drafts that have associated PendingApproval', async () => {
      const draftWithApproval = { id: 'draft-with-approval' };

      mockDataSource.query
        .mockResolvedValueOnce([draftWithApproval]) // facts - first batch
        .mockResolvedValueOnce([])                  // facts - no more
        .mockResolvedValueOnce([])                  // activities
        .mockResolvedValueOnce([]);                 // commitments

      // PendingApproval EXISTS for this draft
      mockApprovalRepository.find.mockResolvedValue([
        { targetId: 'draft-with-approval' },
      ]);

      const result = await service.cleanupOrphanedDrafts();

      expect(result.facts).toBe(0);
      // The delete query should NOT be called since all drafts have approvals
      expect(mockDataSource.manager.query).not.toHaveBeenCalled();
    });

    it('should NOT delete active/completed entities (only drafts)', async () => {
      // The cleanup only queries for DRAFT status entities
      // Mock returns empty because we're testing the status filter
      mockDataSource.query.mockResolvedValue([]);
      mockApprovalRepository.find.mockResolvedValue([]);

      const result = await service.cleanupOrphanedDrafts();

      expect(result.facts).toBe(0);
      expect(result.activities).toBe(0);
      expect(result.commitments).toBe(0);

      // Verify the query includes the draft status filter
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE status = $1'),
        expect.arrayContaining([EntityFactStatus.DRAFT]),
      );
    });

    it('should handle multiple orphaned drafts', async () => {
      const orphanedDrafts = [
        { id: 'orphan-1' },
        { id: 'orphan-2' },
        { id: 'orphan-3' },
      ];

      mockDataSource.query
        .mockResolvedValueOnce(orphanedDrafts) // facts - first batch
        .mockResolvedValueOnce([])              // facts - no more
        .mockResolvedValueOnce([])              // activities
        .mockResolvedValueOnce([]);             // commitments

      // No PendingApprovals exist
      mockApprovalRepository.find.mockResolvedValue([]);

      mockDataSource.manager.query.mockResolvedValue([{}, 3]);

      const result = await service.cleanupOrphanedDrafts();

      expect(result.facts).toBe(3);
      expect(mockDataSource.manager.query).toHaveBeenCalledWith(
        'DELETE FROM entity_facts WHERE id = ANY($1::uuid[])',
        [['orphan-1', 'orphan-2', 'orphan-3']],
      );
    });

    it('should only delete orphans when some drafts have approvals and some do not', async () => {
      const drafts = [
        { id: 'orphan-1' },
        { id: 'has-approval' },
        { id: 'orphan-2' },
      ];

      mockDataSource.query
        .mockResolvedValueOnce(drafts) // facts - first batch
        .mockResolvedValueOnce([])     // facts - no more
        .mockResolvedValueOnce([])     // activities
        .mockResolvedValueOnce([]);    // commitments

      // Only one has an approval
      mockApprovalRepository.find.mockResolvedValue([
        { targetId: 'has-approval' },
      ]);

      mockDataSource.manager.query.mockResolvedValue([{}, 2]);

      const result = await service.cleanupOrphanedDrafts();

      expect(result.facts).toBe(2);
      // Should only delete orphans, not the one with approval
      expect(mockDataSource.manager.query).toHaveBeenCalledWith(
        'DELETE FROM entity_facts WHERE id = ANY($1::uuid[])',
        [['orphan-1', 'orphan-2']],
      );
    });
  });

  describe('runCleanup', () => {
    it('should run both cleanup methods and log results', async () => {
      // Mock cleanupRejectedApprovals
      mockApprovalRepository.find.mockResolvedValue([]);

      // Mock cleanupOrphanedDrafts
      mockDataSource.query.mockResolvedValue([]);

      // Should not throw
      await expect(service.runCleanup()).resolves.not.toThrow();
    });

    it('should handle errors gracefully', async () => {
      const error = new Error('Database connection failed');
      mockApprovalRepository.find.mockRejectedValue(error);

      // Should not throw - errors are logged
      await expect(service.runCleanup()).resolves.not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty database', async () => {
      mockApprovalRepository.find.mockResolvedValue([]);
      mockDataSource.query.mockResolvedValue([]);

      const rejectedResult = await service.cleanupRejectedApprovals();

      // Reset mocks for second call
      mockApprovalRepository.find.mockResolvedValue([]);
      mockDataSource.query.mockResolvedValue([]);

      const orphanedResult = await service.cleanupOrphanedDrafts();

      expect(rejectedResult).toEqual({ approvals: 0, targets: 0 });
      expect(orphanedResult).toEqual({ facts: 0, activities: 0, commitments: 0 });
    });

    it('should handle unknown item type gracefully', async () => {
      const unknownTypeApproval = createMockRejectedApprovalOld({
        itemType: 'unknown_type' as PendingApprovalItemType,
      });

      mockApprovalRepository.find
        .mockResolvedValueOnce([unknownTypeApproval])
        .mockResolvedValueOnce([]);
      mockManager.delete.mockResolvedValue({ affected: 1 });

      const result = await service.cleanupRejectedApprovals();

      // Should still delete the approval but log warning for unknown type
      expect(result.approvals).toBe(1);
      expect(result.targets).toBe(0); // No targets deleted for unknown type
    });

    it('should handle TASK item type (maps to activities table)', async () => {
      const taskApproval = createMockRejectedApprovalOld({
        id: 'approval-task',
        itemType: PendingApprovalItemType.TASK,
        targetId: 'task-to-delete',
      });

      mockApprovalRepository.find
        .mockResolvedValueOnce([taskApproval])
        .mockResolvedValueOnce([]);
      mockManager.query.mockResolvedValue([{}, 1]);
      mockManager.delete.mockResolvedValue({ affected: 1 });

      await service.cleanupRejectedApprovals();

      expect(mockManager.query).toHaveBeenCalledWith(
        'DELETE FROM activities WHERE id = ANY($1::uuid[])',
        [['task-to-delete']],
      );
    });
  });
});
