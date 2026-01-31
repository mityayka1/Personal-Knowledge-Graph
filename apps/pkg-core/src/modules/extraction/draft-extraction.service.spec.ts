import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DraftExtractionService, DraftExtractionInput } from './draft-extraction.service';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityPriority,
  Commitment,
  CommitmentType,
  CommitmentStatus,
  CommitmentPriority,
  PendingApproval,
  PendingApprovalItemType,
  PendingApprovalStatus,
  EntityRecord,
} from '@pkg/entities';

describe('DraftExtractionService', () => {
  let service: DraftExtractionService;
  let activityRepo: jest.Mocked<Repository<Activity>>;
  let commitmentRepo: jest.Mocked<Repository<Commitment>>;
  let approvalRepo: jest.Mocked<Repository<PendingApproval>>;
  let entityRepo: jest.Mocked<Repository<EntityRecord>>;

  // Helper to create chainable query builder mock
  const createQueryBuilderMock = (result: unknown = null) => ({
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ identifiers: [{ id: 'mock-id' }] }),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DraftExtractionService,
        {
          provide: getRepositoryToken(Activity),
          useValue: {
            create: jest.fn((data) => ({ id: 'activity-id', ...data })),
            save: jest.fn((data) => Promise.resolve({ id: 'activity-id', ...data })),
            createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilderMock()),
            findOneOrFail: jest.fn().mockImplementation(({ where }) =>
              Promise.resolve({
                id: where.id,
                name: 'Mock Activity',
                activityType: ActivityType.PROJECT,
                status: ActivityStatus.DRAFT,
                depth: 0,
              }),
            ),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getRepositoryToken(Commitment),
          useValue: {
            create: jest.fn((data) => ({ id: 'commitment-id', ...data })),
            save: jest.fn((data) => Promise.resolve({ id: 'commitment-id', ...data })),
            createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilderMock()),
          },
        },
        {
          provide: getRepositoryToken(PendingApproval),
          useValue: {
            create: jest.fn((data) => ({ id: 'approval-id', ...data })),
            save: jest.fn((data) => Promise.resolve({ id: 'approval-id', ...data })),
            find: jest.fn().mockResolvedValue([]), // No existing pending by default
          },
        },
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilderMock()),
          },
        },
      ],
    }).compile();

    service = module.get<DraftExtractionService>(DraftExtractionService);
    activityRepo = module.get(getRepositoryToken(Activity));
    commitmentRepo = module.get(getRepositoryToken(Commitment));
    approvalRepo = module.get(getRepositoryToken(PendingApproval));
    entityRepo = module.get(getRepositoryToken(EntityRecord));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createDrafts', () => {
    it('should create draft project with pending approval', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Test Project',
            isNew: true,
            participants: ['Alice', 'Bob'],
            status: 'active',
            confidence: 0.9,
            sourceQuote: 'We need to start Test Project',
          },
        ],
        tasks: [],
        commitments: [],
        sourceInteractionId: 'interaction-123',
        messageRef: 'telegram:12345',
      };

      const result = await service.createDrafts(input);

      // Verify batchId is generated
      expect(result.batchId).toBeDefined();
      expect(result.batchId).toMatch(/^[a-f0-9-]{36}$/);

      // Verify counts
      expect(result.counts.projects).toBe(1);
      expect(result.counts.tasks).toBe(0);
      expect(result.counts.commitments).toBe(0);
      expect(result.skipped.projects).toBe(0);

      // Verify approval created
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].itemType).toBe(PendingApprovalItemType.PROJECT);

      // Verify Activity insert was called
      expect(activityRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('should create draft task with pending approval', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [],
        tasks: [
          {
            title: 'Complete report',
            status: 'pending',
            priority: 'high',
            confidence: 0.85,
            sourceQuote: 'Need to complete the report',
          },
        ],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.tasks).toBe(1);
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].itemType).toBe(PendingApprovalItemType.TASK);
    });

    it('should create draft commitment with pending approval', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'Send the document',
            from: 'self',
            to: 'self',
            confidence: 0.95,
            sourceQuote: 'I will send the document tomorrow',
          },
        ],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.commitments).toBe(1);
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].itemType).toBe(PendingApprovalItemType.COMMITMENT);

      // Verify Commitment created with DRAFT status
      expect(commitmentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Send the document',
          type: CommitmentType.PROMISE,
          status: CommitmentStatus.DRAFT,
        }),
      );
    });

    it('should create all drafts in a batch with same batchId', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [{ name: 'Project A', isNew: true, participants: [], confidence: 0.9 }],
        tasks: [{ title: 'Task B', status: 'pending', confidence: 0.85 }],
        commitments: [
          { type: 'promise', what: 'Commitment C', from: 'self', to: 'self', confidence: 0.8 },
        ],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(1);
      expect(result.counts.tasks).toBe(1);
      expect(result.counts.commitments).toBe(1);
      expect(result.approvals).toHaveLength(3);

      // All approvals should have the same batchId
      const batchIds = result.approvals.map((a) => a.batchId);
      expect(new Set(batchIds).size).toBe(1);
      expect(batchIds[0]).toBe(result.batchId);
    });

    it('should skip existing activity for project', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Existing Project',
            isNew: false,
            participants: [],
            existingActivityId: 'existing-activity-123',
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(0);
      expect(result.approvals).toHaveLength(0);
    });

    it('should link task to parent project by name', async () => {
      const projectId = 'project-uuid-123';

      // Mock findOneOrFail to return project with specific ID
      activityRepo.findOneOrFail = jest
        .fn()
        .mockResolvedValueOnce({
          id: projectId,
          name: 'Parent Project',
          activityType: ActivityType.PROJECT,
          status: ActivityStatus.DRAFT,
          depth: 0,
          materializedPath: null,
        })
        .mockResolvedValueOnce({
          id: 'task-id',
          name: 'Child Task',
          activityType: ActivityType.TASK,
          status: ActivityStatus.DRAFT,
        });

      // Mock findOne for parent lookup
      activityRepo.findOne = jest.fn().mockResolvedValue({
        id: projectId,
        name: 'Parent Project',
        depth: 0,
        materializedPath: null,
      });

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [{ name: 'Parent Project', isNew: true, participants: [], confidence: 0.9 }],
        tasks: [
          {
            title: 'Child Task',
            projectName: 'Parent Project',
            status: 'pending',
            confidence: 0.85,
          },
        ],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(1);
      expect(result.counts.tasks).toBe(1);
    });

    it('should record errors for failed items', async () => {
      // Make the insert execute fail
      const failingQueryBuilder = createQueryBuilderMock();
      failingQueryBuilder.execute = jest.fn().mockRejectedValue(new Error('Database error'));
      activityRepo.createQueryBuilder = jest.fn().mockReturnValue(failingQueryBuilder);

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [{ name: 'Failing Project', isNew: true, participants: [], confidence: 0.9 }],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].item).toBe('project:Failing Project');
      expect(result.errors[0].error).toContain('Database error');
    });

    it('should preserve messageRef for Telegram updates', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [{ name: 'Test', isNew: true, participants: [], confidence: 0.9 }],
        tasks: [],
        commitments: [],
        messageRef: 'telegram:chat:12345:msg:67890',
      };

      const result = await service.createDrafts(input);

      expect(result.approvals[0].messageRef).toBe('telegram:chat:12345:msg:67890');
    });
  });

  describe('deduplication', () => {
    it('should skip duplicate project if pending approval exists', async () => {
      // Mock existing pending approval for project
      approvalRepo.find = jest.fn().mockResolvedValue([
        {
          id: 'existing-approval',
          itemType: PendingApprovalItemType.PROJECT,
          targetId: 'existing-project-id',
          status: PendingApprovalStatus.PENDING,
        },
      ]);

      // Mock activity query to find matching project
      const activityQueryBuilder = createQueryBuilderMock({
        id: 'existing-project-id',
        name: 'Test Project',
      });
      activityRepo.createQueryBuilder = jest.fn().mockReturnValue(activityQueryBuilder);

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [{ name: 'Test Project', isNew: true, participants: [], confidence: 0.9 }],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(0);
      expect(result.skipped.projects).toBe(1);
      expect(result.approvals).toHaveLength(0);
    });

    it('should skip duplicate commitment if pending approval exists', async () => {
      // Return pending for commitments, empty for projects/tasks
      approvalRepo.find = jest.fn().mockImplementation(({ where }) => {
        if (where.itemType === PendingApprovalItemType.COMMITMENT) {
          return Promise.resolve([
            {
              id: 'existing-approval',
              itemType: PendingApprovalItemType.COMMITMENT,
              targetId: 'existing-commitment-id',
              status: PendingApprovalStatus.PENDING,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      // Mock commitment query to find matching commitment
      const commitmentQueryBuilder = createQueryBuilderMock({
        id: 'existing-commitment-id',
        title: 'Call to discuss integration',
      });
      commitmentRepo.createQueryBuilder = jest.fn().mockReturnValue(commitmentQueryBuilder);

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'Call to discuss integration',
            from: 'self',
            to: 'self',
            confidence: 0.95,
          },
        ],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.commitments).toBe(0);
      expect(result.skipped.commitments).toBe(1);
      expect(result.approvals).toHaveLength(0);
    });

    it('should create new item if no duplicate pending exists', async () => {
      // No pending approvals exist
      approvalRepo.find = jest.fn().mockResolvedValue([]);

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'New unique commitment',
            from: 'self',
            to: 'self',
            confidence: 0.95,
          },
        ],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.commitments).toBe(1);
      expect(result.skipped.commitments).toBe(0);
      expect(result.approvals).toHaveLength(1);
    });
  });
});
