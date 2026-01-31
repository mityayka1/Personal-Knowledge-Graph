/**
 * E2E tests for Draft Extraction + PendingApproval workflow.
 *
 * Tests the complete flow:
 * 1. DraftExtractionService.createDrafts() → Activity/Commitment with status=DRAFT
 * 2. PendingApprovalService.approve() → target.status changes to ACTIVE
 * 3. PendingApprovalService.reject() → target.deletedAt is set (soft delete)
 * 4. Batch operations
 *
 * Uses full AppModule like other e2e tests for reliable database connectivity.
 *
 * Run: pnpm test:e2e -- --testPathPattern=draft-extraction
 *
 * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  Commitment,
  CommitmentStatus,
  PendingApproval,
  PendingApprovalStatus,
  PendingApprovalItemType,
  EntityRecord,
  EntityType,
} from '@pkg/entities';
import { DraftExtractionService, DraftExtractionInput } from '../src/modules/extraction/draft-extraction.service';
import { PendingApprovalService } from '../src/modules/pending-approval/pending-approval.service';

describe('Draft Extraction Flow (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let draftService: DraftExtractionService;
  let approvalService: PendingApprovalService;
  let activityRepo: Repository<Activity>;
  let commitmentRepo: Repository<Commitment>;
  let approvalRepo: Repository<PendingApproval>;
  let entityRepo: Repository<EntityRecord>;

  // Test data prefix for cleanup
  const testPrefix = `draft_e2e_${Date.now()}`;
  const testOwnerEntityId = randomUUID();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    draftService = moduleFixture.get(DraftExtractionService);
    approvalService = moduleFixture.get(PendingApprovalService);
    activityRepo = moduleFixture.get<Repository<Activity>>(getRepositoryToken(Activity));
    commitmentRepo = moduleFixture.get<Repository<Commitment>>(getRepositoryToken(Commitment));
    approvalRepo = moduleFixture.get<Repository<PendingApproval>>(getRepositoryToken(PendingApproval));
    entityRepo = moduleFixture.get<Repository<EntityRecord>>(getRepositoryToken(EntityRecord));

    // Create test owner entity
    await entityRepo.save({
      id: testOwnerEntityId,
      type: EntityType.PERSON,
      name: `${testPrefix}_owner`,
    });
  });

  afterAll(async () => {
    await cleanupTestData();
    await app.close();
  });

  afterEach(async () => {
    // Cleanup created data between tests
    await cleanupTestData();
  });

  async function cleanupTestData() {
    try {
      // Delete pending approvals first (FK constraints)
      await dataSource.query(`
        DELETE FROM pending_approvals
        WHERE batch_id LIKE '${testPrefix}%'
           OR target_id IN (
             SELECT id FROM activities WHERE owner_entity_id = '${testOwnerEntityId}'
           )
           OR target_id IN (
             SELECT id FROM commitments WHERE from_entity_id = '${testOwnerEntityId}'
           )
      `);

      // Delete activities
      await dataSource.query(`
        DELETE FROM activities WHERE owner_entity_id = '${testOwnerEntityId}'
      `);

      // Delete commitments
      await dataSource.query(`
        DELETE FROM commitments WHERE from_entity_id = '${testOwnerEntityId}'
      `);
    } catch (e) {
      console.warn('Cleanup warning:', (e as Error).message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test: Create Drafts
  // ─────────────────────────────────────────────────────────────

  describe('DraftExtractionService.createDrafts()', () => {
    it('should create draft Activity with status=DRAFT for project', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          {
            name: `${testPrefix}_Project Alpha`,
            isNew: true,
            participants: ['Alice', 'Bob'],
            confidence: 0.9,
            sourceQuote: 'Начинаем проект Alpha',
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await draftService.createDrafts(input);

      // Verify result
      expect(result.batchId).toBeDefined();
      expect(result.counts.projects).toBe(1);
      expect(result.approvals).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      // Verify Activity in DB
      const activity = await activityRepo.findOne({
        where: { name: `${testPrefix}_Project Alpha` },
      });

      expect(activity).not.toBeNull();
      expect(activity!.status).toBe(ActivityStatus.DRAFT);
      expect(activity!.activityType).toBe(ActivityType.PROJECT);
      expect(activity!.ownerEntityId).toBe(testOwnerEntityId);

      // Verify PendingApproval in DB
      const approval = await approvalRepo.findOne({
        where: { targetId: activity!.id },
      });

      expect(approval).not.toBeNull();
      expect(approval!.itemType).toBe(PendingApprovalItemType.PROJECT);
      expect(approval!.status).toBe(PendingApprovalStatus.PENDING);
      expect(approval!.batchId).toBe(result.batchId);
      expect(approval!.confidence).toBe(0.9);
    });

    it('should create draft Activity with status=DRAFT for task', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [],
        tasks: [
          {
            title: `${testPrefix}_Task One`,
            status: 'pending',
            priority: 'high',
            confidence: 0.85,
            sourceQuote: 'Нужно сделать Task One',
          },
        ],
        commitments: [],
      };

      const result = await draftService.createDrafts(input);

      expect(result.counts.tasks).toBe(1);

      const activity = await activityRepo.findOne({
        where: { name: `${testPrefix}_Task One` },
      });

      expect(activity).not.toBeNull();
      expect(activity!.status).toBe(ActivityStatus.DRAFT);
      expect(activity!.activityType).toBe(ActivityType.TASK);
    });

    it('should create draft Commitment with status=DRAFT', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: `${testPrefix}_Send document`,
            from: 'self',
            to: 'self',
            confidence: 0.95,
            sourceQuote: 'Я отправлю документ завтра',
          },
        ],
      };

      const result = await draftService.createDrafts(input);

      expect(result.counts.commitments).toBe(1);

      const commitment = await commitmentRepo.findOne({
        where: { title: `${testPrefix}_Send document` },
      });

      expect(commitment).not.toBeNull();
      expect(commitment!.status).toBe(CommitmentStatus.DRAFT);
    });

    it('should create all items in same batch with same batchId', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [{ name: `${testPrefix}_Proj`, isNew: true, participants: [], confidence: 0.9 }],
        tasks: [{ title: `${testPrefix}_Task`, status: 'pending', confidence: 0.85 }],
        commitments: [
          { type: 'promise', what: `${testPrefix}_Commit`, from: 'self', to: 'self', confidence: 0.8 },
        ],
      };

      const result = await draftService.createDrafts(input);

      expect(result.counts.projects).toBe(1);
      expect(result.counts.tasks).toBe(1);
      expect(result.counts.commitments).toBe(1);
      expect(result.approvals).toHaveLength(3);

      // All approvals should have same batchId
      const batchIds = new Set(result.approvals.map((a) => a.batchId));
      expect(batchIds.size).toBe(1);

      // Verify in DB
      const approvals = await approvalRepo.find({
        where: { batchId: result.batchId },
      });
      expect(approvals).toHaveLength(3);
    });

    it('should link task to parent project by name', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          { name: `${testPrefix}_Parent Project`, isNew: true, participants: [], confidence: 0.9 },
        ],
        tasks: [
          {
            title: `${testPrefix}_Child Task`,
            projectName: `${testPrefix}_Parent Project`,
            status: 'pending',
            confidence: 0.85,
          },
        ],
        commitments: [],
      };

      const result = await draftService.createDrafts(input);

      expect(result.counts.projects).toBe(1);
      expect(result.counts.tasks).toBe(1);

      const project = await activityRepo.findOne({
        where: { name: `${testPrefix}_Parent Project` },
      });
      const task = await activityRepo.findOne({
        where: { name: `${testPrefix}_Child Task` },
      });

      expect(task!.parentId).toBe(project!.id);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test: Approve Flow
  // ─────────────────────────────────────────────────────────────

  describe('PendingApprovalService.approve()', () => {
    it('should activate Activity (status DRAFT → ACTIVE) on approve', async () => {
      // Setup: create draft
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          { name: `${testPrefix}_Approve Project`, isNew: true, participants: [], confidence: 0.9 },
        ],
        tasks: [],
        commitments: [],
      };

      const { approvals } = await draftService.createDrafts(input);
      const approvalId = approvals[0].id;
      const targetId = approvals[0].targetId;

      // Verify initial state
      const beforeActivity = await activityRepo.findOne({ where: { id: targetId } });
      expect(beforeActivity!.status).toBe(ActivityStatus.DRAFT);

      // Act: approve
      await approvalService.approve(approvalId);

      // Verify Activity status changed
      const afterActivity = await activityRepo.findOne({ where: { id: targetId } });
      expect(afterActivity!.status).toBe(ActivityStatus.ACTIVE);

      // Verify PendingApproval status changed
      const afterApproval = await approvalRepo.findOne({ where: { id: approvalId } });
      expect(afterApproval!.status).toBe(PendingApprovalStatus.APPROVED);
      expect(afterApproval!.reviewedAt).not.toBeNull();
    });

    it('should activate Commitment (status DRAFT → PENDING) on approve', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: `${testPrefix}_Approve Commitment`,
            from: 'self',
            to: 'self',
            confidence: 0.9,
          },
        ],
      };

      const { approvals } = await draftService.createDrafts(input);
      const approvalId = approvals[0].id;
      const targetId = approvals[0].targetId;

      // Approve
      await approvalService.approve(approvalId);

      // Commitment should go to PENDING (not ACTIVE - commitments have different lifecycle)
      const commitment = await commitmentRepo.findOne({ where: { id: targetId } });
      expect(commitment!.status).toBe(CommitmentStatus.PENDING);
    });

    it('should throw ConflictException if already approved', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          { name: `${testPrefix}_Double Approve`, isNew: true, participants: [], confidence: 0.9 },
        ],
        tasks: [],
        commitments: [],
      };

      const { approvals } = await draftService.createDrafts(input);
      const approvalId = approvals[0].id;

      // First approve succeeds
      await approvalService.approve(approvalId);

      // Second approve should throw ConflictException
      await expect(approvalService.approve(approvalId)).rejects.toThrow('already approved');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test: Reject Flow (Soft Delete)
  // ─────────────────────────────────────────────────────────────

  describe('PendingApprovalService.reject()', () => {
    it('should soft delete Activity (set deletedAt) on reject', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          { name: `${testPrefix}_Reject Project`, isNew: true, participants: [], confidence: 0.9 },
        ],
        tasks: [],
        commitments: [],
      };

      const { approvals } = await draftService.createDrafts(input);
      const approvalId = approvals[0].id;
      const targetId = approvals[0].targetId;

      // Verify initial state
      const beforeActivity = await activityRepo.findOne({ where: { id: targetId } });
      expect(beforeActivity!.deletedAt).toBeNull();

      // Act: reject
      await approvalService.reject(approvalId);

      // Verify Activity soft deleted (need to use withDeleted)
      const afterActivity = await activityRepo.findOne({
        where: { id: targetId },
        withDeleted: true,
      });
      expect(afterActivity!.deletedAt).not.toBeNull();

      // Verify PendingApproval status changed
      const afterApproval = await approvalRepo.findOne({ where: { id: approvalId } });
      expect(afterApproval!.status).toBe(PendingApprovalStatus.REJECTED);
      expect(afterApproval!.reviewedAt).not.toBeNull();
    });

    it('should soft delete Commitment on reject', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: `${testPrefix}_Reject Commitment`,
            from: 'self',
            to: 'self',
            confidence: 0.9,
          },
        ],
      };

      const { approvals } = await draftService.createDrafts(input);
      const approvalId = approvals[0].id;
      const targetId = approvals[0].targetId;

      // Reject
      await approvalService.reject(approvalId);

      // Commitment should be soft deleted
      const commitment = await commitmentRepo.findOne({
        where: { id: targetId },
        withDeleted: true,
      });
      expect(commitment!.deletedAt).not.toBeNull();
    });

    it('should throw ConflictException if already rejected', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          { name: `${testPrefix}_Double Reject`, isNew: true, participants: [], confidence: 0.9 },
        ],
        tasks: [],
        commitments: [],
      };

      const { approvals } = await draftService.createDrafts(input);
      const approvalId = approvals[0].id;

      // First reject succeeds
      await approvalService.reject(approvalId);

      // Second reject should throw ConflictException
      await expect(approvalService.reject(approvalId)).rejects.toThrow('already rejected');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test: Batch Operations
  // ─────────────────────────────────────────────────────────────

  describe('Batch Operations', () => {
    it('should approve all items in batch with approveBatch()', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          { name: `${testPrefix}_Batch Proj 1`, isNew: true, participants: [], confidence: 0.9 },
          { name: `${testPrefix}_Batch Proj 2`, isNew: true, participants: [], confidence: 0.85 },
        ],
        tasks: [{ title: `${testPrefix}_Batch Task`, status: 'pending', confidence: 0.8 }],
        commitments: [],
      };

      const { batchId, approvals } = await draftService.createDrafts(input);

      // Approve batch
      const result = await approvalService.approveBatch(batchId);

      expect(result.processed).toBe(3);
      expect(result.failed).toBe(0);

      // Verify all approvals are approved
      const dbApprovals = await approvalRepo.find({ where: { batchId } });
      expect(dbApprovals.every((a) => a.status === PendingApprovalStatus.APPROVED)).toBe(true);

      // Verify all targets are active
      for (const approval of approvals) {
        if (
          approval.itemType === PendingApprovalItemType.PROJECT ||
          approval.itemType === PendingApprovalItemType.TASK
        ) {
          const activity = await activityRepo.findOne({ where: { id: approval.targetId } });
          expect(activity!.status).toBe(ActivityStatus.ACTIVE);
        }
      }
    });

    it('should reject all items in batch with rejectBatch()', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          { name: `${testPrefix}_Reject Batch 1`, isNew: true, participants: [], confidence: 0.9 },
        ],
        tasks: [{ title: `${testPrefix}_Reject Batch Task`, status: 'pending', confidence: 0.8 }],
        commitments: [
          {
            type: 'promise',
            what: `${testPrefix}_Reject Batch Commit`,
            from: 'self',
            to: 'self',
            confidence: 0.85,
          },
        ],
      };

      const { batchId, approvals } = await draftService.createDrafts(input);

      // Reject batch
      const result = await approvalService.rejectBatch(batchId);

      expect(result.processed).toBe(3);
      expect(result.failed).toBe(0);

      // Verify all approvals are rejected
      const dbApprovals = await approvalRepo.find({ where: { batchId } });
      expect(dbApprovals.every((a) => a.status === PendingApprovalStatus.REJECTED)).toBe(true);

      // Verify all targets are soft deleted
      for (const approval of approvals) {
        if (
          approval.itemType === PendingApprovalItemType.PROJECT ||
          approval.itemType === PendingApprovalItemType.TASK
        ) {
          const activity = await activityRepo.findOne({
            where: { id: approval.targetId },
            withDeleted: true,
          });
          expect(activity!.deletedAt).not.toBeNull();
        } else if (approval.itemType === PendingApprovalItemType.COMMITMENT) {
          const commitment = await commitmentRepo.findOne({
            where: { id: approval.targetId },
            withDeleted: true,
          });
          expect(commitment!.deletedAt).not.toBeNull();
        }
      }
    });

    it('should return 0 processed for empty batch', async () => {
      const fakeBatchId = randomUUID();

      const approveResult = await approvalService.approveBatch(fakeBatchId);
      expect(approveResult.processed).toBe(0);
      expect(approveResult.failed).toBe(0);

      const rejectResult = await approvalService.rejectBatch(fakeBatchId);
      expect(rejectResult.processed).toBe(0);
      expect(rejectResult.failed).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test: Deduplication
  // ─────────────────────────────────────────────────────────────

  describe('Deduplication', () => {
    it('should skip creating duplicate commitment if pending approval exists', async () => {
      const commitmentTitle = `${testPrefix}_Duplicate Commitment`;

      // First extraction - creates the commitment
      const input1: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: commitmentTitle,
            from: 'self',
            to: 'self',
            confidence: 0.9,
          },
        ],
      };

      const result1 = await draftService.createDrafts(input1);
      expect(result1.counts.commitments).toBe(1);
      expect(result1.skipped.commitments).toBe(0);

      // Second extraction - should skip the same commitment
      const input2: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: commitmentTitle, // Same title
            from: 'self',
            to: 'self',
            confidence: 0.95, // Different confidence
          },
        ],
      };

      const result2 = await draftService.createDrafts(input2);
      expect(result2.counts.commitments).toBe(0); // Not created
      expect(result2.skipped.commitments).toBe(1); // Skipped as duplicate

      // Verify only one commitment in DB
      const commitments = await commitmentRepo.find({
        where: { title: commitmentTitle },
      });
      expect(commitments).toHaveLength(1);
    });

    it('should skip creating duplicate project if pending approval exists', async () => {
      const projectName = `${testPrefix}_Duplicate Project`;

      // First extraction
      const input1: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [{ name: projectName, isNew: true, participants: [], confidence: 0.9 }],
        tasks: [],
        commitments: [],
      };

      const result1 = await draftService.createDrafts(input1);
      expect(result1.counts.projects).toBe(1);
      expect(result1.skipped.projects).toBe(0);

      // Second extraction - should skip
      const input2: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [{ name: projectName, isNew: true, participants: [], confidence: 0.85 }],
        tasks: [],
        commitments: [],
      };

      const result2 = await draftService.createDrafts(input2);
      expect(result2.counts.projects).toBe(0);
      expect(result2.skipped.projects).toBe(1);

      // Verify only one activity in DB
      const activities = await activityRepo.find({
        where: { name: projectName },
      });
      expect(activities).toHaveLength(1);
    });

    it('should create new item after approving the pending one', async () => {
      const commitmentTitle = `${testPrefix}_Approve Then Create`;

      // Create and approve first commitment
      const input1: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [],
        tasks: [],
        commitments: [
          { type: 'promise', what: commitmentTitle, from: 'self', to: 'self', confidence: 0.9 },
        ],
      };

      const result1 = await draftService.createDrafts(input1);
      expect(result1.counts.commitments).toBe(1);

      // Approve the pending approval
      await approvalService.approve(result1.approvals[0].id);

      // Now create another with same title - should NOT be skipped
      // because the first one is no longer PENDING
      const input2: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [],
        tasks: [],
        commitments: [
          { type: 'promise', what: commitmentTitle, from: 'self', to: 'self', confidence: 0.85 },
        ],
      };

      const result2 = await draftService.createDrafts(input2);
      expect(result2.counts.commitments).toBe(1); // Created (not skipped)
      expect(result2.skipped.commitments).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test: Batch Stats
  // ─────────────────────────────────────────────────────────────

  describe('getBatchStats()', () => {
    it('should return correct stats after partial processing', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: testOwnerEntityId,
        projects: [
          { name: `${testPrefix}_Stats 1`, isNew: true, participants: [], confidence: 0.9 },
          { name: `${testPrefix}_Stats 2`, isNew: true, participants: [], confidence: 0.85 },
          { name: `${testPrefix}_Stats 3`, isNew: true, participants: [], confidence: 0.8 },
        ],
        tasks: [],
        commitments: [],
      };

      const { batchId, approvals } = await draftService.createDrafts(input);

      // Approve first, reject second, leave third pending
      await approvalService.approve(approvals[0].id);
      await approvalService.reject(approvals[1].id);

      const stats = await approvalService.getBatchStats(batchId);

      expect(stats.total).toBe(3);
      expect(stats.approved).toBe(1);
      expect(stats.rejected).toBe(1);
      expect(stats.pending).toBe(1);
    });
  });
});
