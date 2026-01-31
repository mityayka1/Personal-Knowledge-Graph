import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DraftExtractionService, DraftExtractionInput } from './draft-extraction.service';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  Commitment,
  CommitmentType,
  CommitmentStatus,
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
  let dataSource: jest.Mocked<DataSource>;

  // Mock entity manager for transactions
  const mockManager = {
    create: jest.fn().mockImplementation((entity, data) => ({ id: 'mock-id', ...data })),
    save: jest.fn().mockImplementation((entity, data) => Promise.resolve({ id: 'mock-id', ...data })),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DraftExtractionService,
        {
          provide: getRepositoryToken(Activity),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Commitment),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(PendingApproval),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue(null),
            }),
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn().mockImplementation(async (callback) => {
              return callback(mockManager);
            }),
          },
        },
      ],
    }).compile();

    service = module.get<DraftExtractionService>(DraftExtractionService);
    activityRepo = module.get(getRepositoryToken(Activity));
    commitmentRepo = module.get(getRepositoryToken(Commitment));
    approvalRepo = module.get(getRepositoryToken(PendingApproval));
    entityRepo = module.get(getRepositoryToken(EntityRecord));
    dataSource = module.get(DataSource);
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

      // Verify approval created
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].itemType).toBe(PendingApprovalItemType.PROJECT);

      // Verify transaction was called
      expect(dataSource.transaction).toHaveBeenCalled();

      // Verify Activity created with DRAFT status
      expect(mockManager.create).toHaveBeenCalledWith(
        Activity,
        expect.objectContaining({
          name: 'Test Project',
          activityType: ActivityType.PROJECT,
          status: ActivityStatus.DRAFT,
          ownerEntityId: 'owner-123',
        }),
      );

      // Verify PendingApproval created
      expect(mockManager.create).toHaveBeenCalledWith(
        PendingApproval,
        expect.objectContaining({
          itemType: PendingApprovalItemType.PROJECT,
          status: PendingApprovalStatus.PENDING,
          confidence: 0.9,
          sourceQuote: 'We need to start Test Project',
          messageRef: 'telegram:12345',
        }),
      );
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

      // Verify Activity created with DRAFT status
      expect(mockManager.create).toHaveBeenCalledWith(
        Activity,
        expect.objectContaining({
          name: 'Complete report',
          activityType: ActivityType.TASK,
          status: ActivityStatus.DRAFT,
        }),
      );
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
      expect(mockManager.create).toHaveBeenCalledWith(
        Commitment,
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
        commitments: [{ type: 'promise', what: 'Commitment C', from: 'self', to: 'self', confidence: 0.8 }],
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
      let saveCallCount = 0;

      // Override mock to return project ID for first Activity save
      mockManager.save.mockImplementation((entity, data) => {
        saveCallCount++;
        if (saveCallCount === 1) {
          // First save is the project — id LAST to override mock-id from create()
          return Promise.resolve({ ...data, id: projectId });
        }
        return Promise.resolve({ ...data, id: `mock-id-${saveCallCount}` });
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

      // Task should be created with parentId pointing to project
      expect(mockManager.create).toHaveBeenCalledWith(
        Activity,
        expect.objectContaining({
          name: 'Child Task',
          activityType: ActivityType.TASK,
          parentId: projectId,
        }),
      );
    });

    it('should record errors for failed items', async () => {
      mockManager.save.mockRejectedValueOnce(new Error('Database error'));

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
});
