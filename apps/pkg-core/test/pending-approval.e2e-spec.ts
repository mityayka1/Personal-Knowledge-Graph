/**
 * E2E tests for Pending Approval REST API.
 *
 * Tests the API endpoints for the pending approval workflow:
 * - List pending approvals with filters
 * - Get single pending approval
 * - Approve/reject single items
 * - Batch operations
 * - Batch statistics
 *
 * Run: pnpm test:e2e -- --testPathPattern=pending-approval
 *
 * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  Commitment,
  CommitmentStatus,
  CommitmentType,
  PendingApproval,
  PendingApprovalStatus,
  PendingApprovalItemType,
  EntityRecord,
  EntityType,
  EntityFact,
  EntityFactStatus,
  FactSource,
  FactCategory,
} from '@pkg/entities';

describe('Pending Approval API (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let activityRepo: Repository<Activity>;
  let commitmentRepo: Repository<Commitment>;
  let approvalRepo: Repository<PendingApproval>;
  let entityRepo: Repository<EntityRecord>;
  let factRepo: Repository<EntityFact>;

  // Test data prefix for cleanup
  const testPrefix = `pa_api_e2e_${Date.now()}`;
  const testOwnerEntityId = randomUUID();
  const testBatchId = randomUUID();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    activityRepo = moduleFixture.get<Repository<Activity>>(
      getRepositoryToken(Activity),
    );
    commitmentRepo = moduleFixture.get<Repository<Commitment>>(
      getRepositoryToken(Commitment),
    );
    approvalRepo = moduleFixture.get<Repository<PendingApproval>>(
      getRepositoryToken(PendingApproval),
    );
    entityRepo = moduleFixture.get<Repository<EntityRecord>>(
      getRepositoryToken(EntityRecord),
    );
    factRepo = moduleFixture.get<Repository<EntityFact>>(
      getRepositoryToken(EntityFact),
    );

    // Create test owner entity
    await entityRepo.save({
      id: testOwnerEntityId,
      type: EntityType.PERSON,
      name: `${testPrefix}_owner`,
    });
  });

  afterAll(async () => {
    await cleanupTestData();
    // Also cleanup test entity (after activities due to FK)
    try {
      await dataSource.query(`DELETE FROM entities WHERE id = $1`, [
        testOwnerEntityId,
      ]);
    } catch (e) {
      console.warn('Entity cleanup warning:', (e as Error).message);
    }
    await app.close();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  async function cleanupTestData() {
    try {
      // Delete pending approvals first (no FK, but clean before targets)
      await dataSource.query(`
        DELETE FROM pending_approvals
        WHERE batch_id = $1
           OR target_id IN (
             SELECT id FROM activities WHERE owner_entity_id = $2
           )
           OR target_id IN (
             SELECT id FROM commitments WHERE from_entity_id = $2
           )
           OR target_id IN (
             SELECT id FROM entity_facts WHERE entity_id = $2
           )
      `, [testBatchId, testOwnerEntityId]);

      // Delete activities
      await dataSource.query(
        `DELETE FROM activities WHERE owner_entity_id = $1`,
        [testOwnerEntityId],
      );

      // Delete commitments
      await dataSource.query(
        `DELETE FROM commitments WHERE from_entity_id = $1`,
        [testOwnerEntityId],
      );

      // Delete entity facts
      await dataSource.query(
        `DELETE FROM entity_facts WHERE entity_id = $1`,
        [testOwnerEntityId],
      );
    } catch (e) {
      console.warn('Cleanup warning:', (e as Error).message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Helper: Create test data
  // ─────────────────────────────────────────────────────────────

  async function createTestActivity(
    name: string,
    status: ActivityStatus = ActivityStatus.DRAFT,
  ): Promise<Activity> {
    const id = randomUUID();
    await activityRepo
      .createQueryBuilder()
      .insert()
      .into(Activity)
      .values({
        id,
        name,
        activityType: ActivityType.TASK,
        status,
        ownerEntityId: testOwnerEntityId,
        depth: 0,
      })
      .execute();
    return activityRepo.findOneOrFail({ where: { id } });
  }

  async function createTestCommitment(
    title: string,
    status: CommitmentStatus = CommitmentStatus.DRAFT,
  ): Promise<Commitment> {
    return commitmentRepo.save({
      title,
      type: CommitmentType.PROMISE,
      status,
      fromEntityId: testOwnerEntityId,
      toEntityId: testOwnerEntityId,
    });
  }

  async function createTestFact(
    factType: string,
    value: string,
    status: EntityFactStatus = EntityFactStatus.DRAFT,
  ): Promise<EntityFact> {
    return factRepo.save({
      entityId: testOwnerEntityId,
      factType,
      value,
      status,
      source: FactSource.EXTRACTED,
      category: FactCategory.PROFESSIONAL,
    });
  }

  async function createTestApproval(
    targetId: string,
    itemType: PendingApprovalItemType,
    batchId: string = testBatchId,
    status: PendingApprovalStatus = PendingApprovalStatus.PENDING,
  ): Promise<PendingApproval> {
    return approvalRepo.save({
      targetId,
      itemType,
      batchId,
      status,
      confidence: 0.85,
      sourceQuote: 'Test source quote',
      reviewedAt: status !== PendingApprovalStatus.PENDING ? new Date() : null,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // GET /pending-approval - List pending approvals
  // ─────────────────────────────────────────────────────────────

  describe('GET /pending-approval', () => {
    it('should return list of pending approvals', async () => {
      // Setup
      const activity = await createTestActivity(`${testPrefix}_Task1`);
      await createTestApproval(activity.id, PendingApprovalItemType.TASK);

      const response = await request(app.getHttpServer())
        .get('/pending-approval')
        .expect(200);

      expect(response.body.items.length).toBeGreaterThanOrEqual(1);
      expect(response.body.total).toBeGreaterThanOrEqual(1);
    });

    it('should filter by batchId', async () => {
      // Setup: create approvals in different batches
      const batch1 = randomUUID();
      const batch2 = randomUUID();

      const activity1 = await createTestActivity(`${testPrefix}_Batch1Task`);
      const activity2 = await createTestActivity(`${testPrefix}_Batch2Task`);
      await createTestApproval(activity1.id, PendingApprovalItemType.TASK, batch1);
      await createTestApproval(activity2.id, PendingApprovalItemType.TASK, batch2);

      const response = await request(app.getHttpServer())
        .get(`/pending-approval?batchId=${batch1}`)
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].batchId).toBe(batch1);
    });

    it('should filter by status', async () => {
      // Setup: create approvals with different statuses
      const activity1 = await createTestActivity(`${testPrefix}_Pending`);
      const activity2 = await createTestActivity(
        `${testPrefix}_Approved`,
        ActivityStatus.ACTIVE,
      );

      await createTestApproval(
        activity1.id,
        PendingApprovalItemType.TASK,
        testBatchId,
        PendingApprovalStatus.PENDING,
      );
      await createTestApproval(
        activity2.id,
        PendingApprovalItemType.TASK,
        testBatchId,
        PendingApprovalStatus.APPROVED,
      );

      const response = await request(app.getHttpServer())
        .get(`/pending-approval?status=pending&batchId=${testBatchId}`)
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].status).toBe('pending');
    });

    it('should support pagination with limit and offset', async () => {
      // Setup: create 3 approvals
      const activities = await Promise.all([
        createTestActivity(`${testPrefix}_Page1`),
        createTestActivity(`${testPrefix}_Page2`),
        createTestActivity(`${testPrefix}_Page3`),
      ]);

      const batchId = randomUUID();
      for (const activity of activities) {
        await createTestApproval(activity.id, PendingApprovalItemType.TASK, batchId);
      }

      // Get first page
      const page1 = await request(app.getHttpServer())
        .get(`/pending-approval?batchId=${batchId}&limit=2&offset=0`)
        .expect(200);

      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.total).toBe(3);
      expect(page1.body.limit).toBe(2);
      expect(page1.body.offset).toBe(0);

      // Get second page
      const page2 = await request(app.getHttpServer())
        .get(`/pending-approval?batchId=${batchId}&limit=2&offset=2`)
        .expect(200);

      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.offset).toBe(2);
    });

    it('should clamp limit to max 100', async () => {
      const response = await request(app.getHttpServer())
        .get('/pending-approval?limit=200')
        .expect(200);

      expect(response.body.limit).toBe(100);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /pending-approval/:id - Get single approval
  // ─────────────────────────────────────────────────────────────

  describe('GET /pending-approval/:id', () => {
    it('should return pending approval by ID', async () => {
      const activity = await createTestActivity(`${testPrefix}_GetById`);
      const approval = await createTestApproval(
        activity.id,
        PendingApprovalItemType.TASK,
      );

      const response = await request(app.getHttpServer())
        .get(`/pending-approval/${approval.id}`)
        .expect(200);

      expect(response.body.id).toBe(approval.id);
      expect(response.body.targetId).toBe(activity.id);
      expect(response.body.itemType).toBe('task');
      expect(response.body.status).toBe('pending');
      expect(response.body.confidence).toBe('0.85');
      expect(response.body.sourceQuote).toBe('Test source quote');
    });

    it('should return 404 for non-existent ID', async () => {
      const fakeId = randomUUID();

      const response = await request(app.getHttpServer())
        .get(`/pending-approval/${fakeId}`)
        .expect(404);

      expect(response.body.message).toContain('not found');
    });

    it('should return 400 for invalid UUID', async () => {
      await request(app.getHttpServer())
        .get('/pending-approval/not-a-uuid')
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /pending-approval/:id/approve - Approve single item
  // ─────────────────────────────────────────────────────────────

  describe('POST /pending-approval/:id/approve', () => {
    it('should approve Activity and change status to ACTIVE', async () => {
      const activity = await createTestActivity(`${testPrefix}_ApproveAct`);
      const approval = await createTestApproval(
        activity.id,
        PendingApprovalItemType.TASK,
      );

      // Verify initial state
      expect(activity.status).toBe(ActivityStatus.DRAFT);

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/approve`)
        .expect(200);

      expect(response.body).toEqual({ success: true, id: approval.id });

      // Verify Activity status changed
      const updatedActivity = await activityRepo.findOne({
        where: { id: activity.id },
      });
      expect(updatedActivity!.status).toBe(ActivityStatus.ACTIVE);

      // Verify approval status and reviewedAt
      const updatedApproval = await approvalRepo.findOne({
        where: { id: approval.id },
      });
      expect(updatedApproval!.status).toBe(PendingApprovalStatus.APPROVED);
      expect(updatedApproval!.reviewedAt).not.toBeNull();
    });

    it('should approve Commitment and change status to PENDING', async () => {
      const commitment = await createTestCommitment(`${testPrefix}_ApproveCommit`);
      const approval = await createTestApproval(
        commitment.id,
        PendingApprovalItemType.COMMITMENT,
      );

      await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/approve`)
        .expect(200);

      // Commitment goes to PENDING (its natural initial active state)
      const updatedCommitment = await commitmentRepo.findOne({
        where: { id: commitment.id },
      });
      expect(updatedCommitment!.status).toBe(CommitmentStatus.PENDING);
    });

    it('should approve EntityFact and change status to ACTIVE', async () => {
      const fact = await createTestFact('job_title', 'Software Engineer');
      const approval = await createTestApproval(
        fact.id,
        PendingApprovalItemType.FACT,
      );

      await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/approve`)
        .expect(200);

      const updatedFact = await factRepo.findOne({ where: { id: fact.id } });
      expect(updatedFact!.status).toBe(EntityFactStatus.ACTIVE);
    });

    it('should return 404 for non-existent approval', async () => {
      const fakeId = randomUUID();

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${fakeId}/approve`)
        .expect(404);

      expect(response.body.message).toContain('not found');
    });

    it('should return 409 Conflict when approving already approved item', async () => {
      const activity = await createTestActivity(
        `${testPrefix}_DoubleApprove`,
        ActivityStatus.ACTIVE,
      );
      const approval = await createTestApproval(
        activity.id,
        PendingApprovalItemType.TASK,
        testBatchId,
        PendingApprovalStatus.APPROVED,
      );

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/approve`)
        .expect(409);

      expect(response.body.message).toContain('already');
    });

    it('should return 409 Conflict when approving already rejected item', async () => {
      const activity = await createTestActivity(`${testPrefix}_ApproveRejected`);
      // Soft delete the activity
      await activityRepo.softDelete(activity.id);
      const approval = await createTestApproval(
        activity.id,
        PendingApprovalItemType.TASK,
        testBatchId,
        PendingApprovalStatus.REJECTED,
      );

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/approve`)
        .expect(409);

      expect(response.body.message).toContain('already');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /pending-approval/:id/reject - Reject single item
  // ─────────────────────────────────────────────────────────────

  describe('POST /pending-approval/:id/reject', () => {
    it('should reject Activity and soft-delete it', async () => {
      const activity = await createTestActivity(`${testPrefix}_RejectAct`);
      const approval = await createTestApproval(
        activity.id,
        PendingApprovalItemType.TASK,
      );

      // Verify initial state
      expect(activity.deletedAt).toBeNull();

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/reject`)
        .expect(200);

      expect(response.body).toEqual({ success: true, id: approval.id });

      // Verify Activity is soft deleted (need withDeleted)
      const deletedActivity = await activityRepo.findOne({
        where: { id: activity.id },
        withDeleted: true,
      });
      expect(deletedActivity!.deletedAt).not.toBeNull();

      // Verify approval status and reviewedAt
      const updatedApproval = await approvalRepo.findOne({
        where: { id: approval.id },
      });
      expect(updatedApproval!.status).toBe(PendingApprovalStatus.REJECTED);
      expect(updatedApproval!.reviewedAt).not.toBeNull();
    });

    it('should reject Commitment and soft-delete it', async () => {
      const commitment = await createTestCommitment(`${testPrefix}_RejectCommit`);
      const approval = await createTestApproval(
        commitment.id,
        PendingApprovalItemType.COMMITMENT,
      );

      await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/reject`)
        .expect(200);

      const deletedCommitment = await commitmentRepo.findOne({
        where: { id: commitment.id },
        withDeleted: true,
      });
      expect(deletedCommitment!.deletedAt).not.toBeNull();
    });

    it('should reject EntityFact and soft-delete it', async () => {
      const fact = await createTestFact('company', 'Test Corp');
      const approval = await createTestApproval(
        fact.id,
        PendingApprovalItemType.FACT,
      );

      await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/reject`)
        .expect(200);

      const deletedFact = await factRepo.findOne({
        where: { id: fact.id },
        withDeleted: true,
      });
      expect(deletedFact!.deletedAt).not.toBeNull();
    });

    it('should return 404 for non-existent approval', async () => {
      const fakeId = randomUUID();

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${fakeId}/reject`)
        .expect(404);

      expect(response.body.message).toContain('not found');
    });

    it('should return 409 Conflict when rejecting already rejected item', async () => {
      const activity = await createTestActivity(`${testPrefix}_DoubleReject`);
      await activityRepo.softDelete(activity.id);
      const approval = await createTestApproval(
        activity.id,
        PendingApprovalItemType.TASK,
        testBatchId,
        PendingApprovalStatus.REJECTED,
      );

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/reject`)
        .expect(409);

      expect(response.body.message).toContain('already');
    });

    it('should return 409 Conflict when rejecting already approved item', async () => {
      const activity = await createTestActivity(
        `${testPrefix}_RejectApproved`,
        ActivityStatus.ACTIVE,
      );
      const approval = await createTestApproval(
        activity.id,
        PendingApprovalItemType.TASK,
        testBatchId,
        PendingApprovalStatus.APPROVED,
      );

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/reject`)
        .expect(409);

      expect(response.body.message).toContain('already');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /pending-approval/batch/:batchId/stats - Batch statistics
  // ─────────────────────────────────────────────────────────────

  describe('GET /pending-approval/batch/:batchId/stats', () => {
    it('should return correct stats for batch with mixed statuses', async () => {
      const batchId = randomUUID();

      // Create 3 activities with different approval statuses
      const activity1 = await createTestActivity(`${testPrefix}_Stats1`);
      const activity2 = await createTestActivity(
        `${testPrefix}_Stats2`,
        ActivityStatus.ACTIVE,
      );
      const activity3 = await createTestActivity(`${testPrefix}_Stats3`);
      await activityRepo.softDelete(activity3.id);

      await createTestApproval(
        activity1.id,
        PendingApprovalItemType.TASK,
        batchId,
        PendingApprovalStatus.PENDING,
      );
      await createTestApproval(
        activity2.id,
        PendingApprovalItemType.TASK,
        batchId,
        PendingApprovalStatus.APPROVED,
      );
      await createTestApproval(
        activity3.id,
        PendingApprovalItemType.TASK,
        batchId,
        PendingApprovalStatus.REJECTED,
      );

      const response = await request(app.getHttpServer())
        .get(`/pending-approval/batch/${batchId}/stats`)
        .expect(200);

      expect(response.body).toEqual({
        batchId,
        total: 3,
        pending: 1,
        approved: 1,
        rejected: 1,
      });
    });

    it('should return zeros for empty batch', async () => {
      const emptyBatchId = randomUUID();

      const response = await request(app.getHttpServer())
        .get(`/pending-approval/batch/${emptyBatchId}/stats`)
        .expect(200);

      expect(response.body).toEqual({
        batchId: emptyBatchId,
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
      });
    });

    it('should return 400 for invalid UUID', async () => {
      await request(app.getHttpServer())
        .get('/pending-approval/batch/not-a-uuid/stats')
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /pending-approval/batch/:batchId/approve - Approve all in batch
  // ─────────────────────────────────────────────────────────────

  describe('POST /pending-approval/batch/:batchId/approve', () => {
    it('should approve all pending items in batch', async () => {
      const batchId = randomUUID();

      // Create 3 activities
      const activities = await Promise.all([
        createTestActivity(`${testPrefix}_BatchApprove1`),
        createTestActivity(`${testPrefix}_BatchApprove2`),
        createTestActivity(`${testPrefix}_BatchApprove3`),
      ]);

      for (const activity of activities) {
        await createTestApproval(activity.id, PendingApprovalItemType.TASK, batchId);
      }

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/batch/${batchId}/approve`)
        .expect(200);

      expect(response.body).toEqual({
        processed: 3,
        failed: 0,
        batchId,
      });

      // Verify all activities are now ACTIVE
      for (const activity of activities) {
        const updated = await activityRepo.findOne({ where: { id: activity.id } });
        expect(updated!.status).toBe(ActivityStatus.ACTIVE);
      }

      // Verify all approvals are APPROVED
      const approvals = await approvalRepo.find({ where: { batchId } });
      expect(
        approvals.every((a) => a.status === PendingApprovalStatus.APPROVED),
      ).toBe(true);
      expect(approvals.every((a) => a.reviewedAt !== null)).toBe(true);
    });

    it('should skip already processed items', async () => {
      const batchId = randomUUID();

      const activity1 = await createTestActivity(`${testPrefix}_BatchSkip1`);
      const activity2 = await createTestActivity(
        `${testPrefix}_BatchSkip2`,
        ActivityStatus.ACTIVE,
      );

      await createTestApproval(
        activity1.id,
        PendingApprovalItemType.TASK,
        batchId,
        PendingApprovalStatus.PENDING,
      );
      await createTestApproval(
        activity2.id,
        PendingApprovalItemType.TASK,
        batchId,
        PendingApprovalStatus.APPROVED,
      );

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/batch/${batchId}/approve`)
        .expect(200);

      // Only 1 pending item should be processed
      expect(response.body.processed).toBe(1);
      expect(response.body.failed).toBe(0);
    });

    it('should return processed=0 for empty batch', async () => {
      const emptyBatchId = randomUUID();

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/batch/${emptyBatchId}/approve`)
        .expect(200);

      expect(response.body).toEqual({
        processed: 0,
        failed: 0,
        batchId: emptyBatchId,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /pending-approval/batch/:batchId/reject - Reject all in batch
  // ─────────────────────────────────────────────────────────────

  describe('POST /pending-approval/batch/:batchId/reject', () => {
    it('should reject all pending items in batch', async () => {
      const batchId = randomUUID();

      // Create mixed items
      const activity = await createTestActivity(`${testPrefix}_BatchReject1`);
      const commitment = await createTestCommitment(`${testPrefix}_BatchReject2`);
      const fact = await createTestFact('email', 'test@example.com');

      await createTestApproval(activity.id, PendingApprovalItemType.TASK, batchId);
      await createTestApproval(
        commitment.id,
        PendingApprovalItemType.COMMITMENT,
        batchId,
      );
      await createTestApproval(fact.id, PendingApprovalItemType.FACT, batchId);

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/batch/${batchId}/reject`)
        .expect(200);

      expect(response.body).toEqual({
        processed: 3,
        failed: 0,
        batchId,
      });

      // Verify all items are soft deleted
      const deletedActivity = await activityRepo.findOne({
        where: { id: activity.id },
        withDeleted: true,
      });
      expect(deletedActivity!.deletedAt).not.toBeNull();

      const deletedCommitment = await commitmentRepo.findOne({
        where: { id: commitment.id },
        withDeleted: true,
      });
      expect(deletedCommitment!.deletedAt).not.toBeNull();

      const deletedFact = await factRepo.findOne({
        where: { id: fact.id },
        withDeleted: true,
      });
      expect(deletedFact!.deletedAt).not.toBeNull();

      // Verify all approvals are REJECTED
      const approvals = await approvalRepo.find({ where: { batchId } });
      expect(
        approvals.every((a) => a.status === PendingApprovalStatus.REJECTED),
      ).toBe(true);
    });

    it('should skip already processed items', async () => {
      const batchId = randomUUID();

      const activity1 = await createTestActivity(`${testPrefix}_BatchRejectSkip1`);
      const activity2 = await createTestActivity(`${testPrefix}_BatchRejectSkip2`);
      await activityRepo.softDelete(activity2.id);

      await createTestApproval(
        activity1.id,
        PendingApprovalItemType.TASK,
        batchId,
        PendingApprovalStatus.PENDING,
      );
      await createTestApproval(
        activity2.id,
        PendingApprovalItemType.TASK,
        batchId,
        PendingApprovalStatus.REJECTED,
      );

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/batch/${batchId}/reject`)
        .expect(200);

      expect(response.body.processed).toBe(1);
      expect(response.body.failed).toBe(0);
    });

    it('should return processed=0 for empty batch', async () => {
      const emptyBatchId = randomUUID();

      const response = await request(app.getHttpServer())
        .post(`/pending-approval/batch/${emptyBatchId}/reject`)
        .expect(200);

      expect(response.body).toEqual({
        processed: 0,
        failed: 0,
        batchId: emptyBatchId,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('should handle concurrent approve requests gracefully', async () => {
      const activity = await createTestActivity(`${testPrefix}_ConcurrentApprove`);
      const approval = await createTestApproval(
        activity.id,
        PendingApprovalItemType.TASK,
      );

      // Send 2 concurrent approve requests
      const results = await Promise.allSettled([
        request(app.getHttpServer()).post(`/pending-approval/${approval.id}/approve`),
        request(app.getHttpServer()).post(`/pending-approval/${approval.id}/approve`),
      ]);

      // One should succeed (200), one should fail (409)
      const statuses = results.map((r) =>
        r.status === 'fulfilled' ? r.value.status : 500,
      );

      expect(statuses).toContain(200);
      expect(statuses).toContain(409);
    });

    it('should maintain data consistency after failed approval', async () => {
      // Create approval without target entity
      const fakeTargetId = randomUUID();
      const approval = await approvalRepo.save({
        targetId: fakeTargetId,
        itemType: PendingApprovalItemType.TASK,
        batchId: testBatchId,
        status: PendingApprovalStatus.PENDING,
        confidence: 0.9,
      });

      // Approve should fail because target doesn't exist
      const response = await request(app.getHttpServer())
        .post(`/pending-approval/${approval.id}/approve`)
        .expect(404);

      expect(response.body.message).toContain('not found');

      // Approval should still be PENDING
      const unchangedApproval = await approvalRepo.findOne({
        where: { id: approval.id },
      });
      expect(unchangedApproval!.status).toBe(PendingApprovalStatus.PENDING);
    });
  });
});
