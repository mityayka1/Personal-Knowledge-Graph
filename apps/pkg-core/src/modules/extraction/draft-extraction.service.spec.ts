import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  EntityFact,
} from '@pkg/entities';
import { ProjectMatchingService } from './project-matching.service';
import { ClientResolutionService } from './client-resolution.service';
import { ActivityMemberService } from '../activity/activity-member.service';

describe('DraftExtractionService', () => {
  let service: DraftExtractionService;
  let activityRepo: jest.Mocked<Repository<Activity>>;
  let commitmentRepo: jest.Mocked<Repository<Commitment>>;
  let approvalRepo: jest.Mocked<Repository<PendingApproval>>;
  let entityRepo: jest.Mocked<Repository<EntityRecord>>;
  let projectMatchingService: jest.Mocked<ProjectMatchingService>;
  let clientResolutionService: jest.Mocked<ClientResolutionService>;
  let activityMemberService: jest.Mocked<ActivityMemberService>;

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
            find: jest.fn().mockResolvedValue([]),
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
        {
          provide: getRepositoryToken(EntityFact),
          useValue: {
            create: jest.fn((data) => ({ id: 'fact-id', ...data })),
            save: jest.fn((data) => Promise.resolve({ id: 'fact-id', ...data })),
            createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilderMock()),
          },
        },
        {
          provide: ProjectMatchingService,
          useValue: {
            findBestMatch: jest.fn().mockResolvedValue({
              matched: false,
              similarity: 0,
              activity: null,
            }),
          },
        },
        {
          provide: ClientResolutionService,
          useValue: {
            resolveClient: jest.fn().mockResolvedValue(null),
            findEntityByName: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ActivityMemberService,
          useValue: {
            resolveAndCreateMembers: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<DraftExtractionService>(DraftExtractionService);
    activityRepo = module.get(getRepositoryToken(Activity));
    commitmentRepo = module.get(getRepositoryToken(Commitment));
    approvalRepo = module.get(getRepositoryToken(PendingApproval));
    entityRepo = module.get(getRepositoryToken(EntityRecord));
    projectMatchingService = module.get(ProjectMatchingService);
    clientResolutionService = module.get(ClientResolutionService);
    activityMemberService = module.get(ActivityMemberService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createDrafts', () => {
    it('should create draft project with pending approval', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
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
        facts: [],
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
        facts: [],
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
        facts: [],
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
        facts: [],
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
        facts: [],
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
        facts: [],
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
        facts: [],
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
        facts: [],
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
        facts: [],
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
        facts: [],
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

  describe('Phase 2: project quality criteria', () => {
    it('should call ActivityMemberService.resolveAndCreateMembers when project has participants', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Team Project',
            isNew: true,
            participants: ['Alice', 'Bob'],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(1);
      expect(activityMemberService.resolveAndCreateMembers).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: ['Alice', 'Bob'],
          ownerEntityId: 'owner-123',
        }),
      );
      // Verify activityId was passed (any UUID string from the mock)
      expect(activityMemberService.resolveAndCreateMembers).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: expect.any(String),
        }),
      );
    });

    it('should not call ActivityMemberService when project has no participants', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Solo Project',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      await service.createDrafts(input);

      expect(activityMemberService.resolveAndCreateMembers).not.toHaveBeenCalled();
    });

    it('should continue on ActivityMemberService failure (warn, not throw)', async () => {
      activityMemberService.resolveAndCreateMembers.mockRejectedValueOnce(
        new Error('Member resolution failed'),
      );

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Project with failing members',
            isNew: true,
            participants: ['Alice'],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      // Project still created despite member failure
      expect(result.counts.projects).toBe(1);
      // Member failure is NOT recorded as a project error
      expect(result.errors).toHaveLength(0);
    });

    it('should resolve commitment activityId from projectMap via projectName', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'My Project',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'Deliver report',
            from: 'self',
            to: 'self',
            projectName: 'My Project',
            confidence: 0.85,
          },
        ],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(1);
      expect(result.counts.commitments).toBe(1);

      // The commitment should have an activityId matching the project's ID
      // The project ID is generated via randomUUID in the service, but findOneOrFail
      // returns it; commitmentRepo.create receives it as activityId
      expect(commitmentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: expect.any(String),
        }),
      );
      // Ensure activityId is not null (was resolved from projectMap)
      const createCall = commitmentRepo.create.mock.calls[0][0] as any;
      expect(createCall.activityId).not.toBeNull();
    });

    it('should set commitment activityId to null when projectName not found', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'Orphan commitment',
            from: 'self',
            to: 'self',
            projectName: 'Nonexistent Project',
            confidence: 0.85,
          },
        ],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.commitments).toBe(1);
      expect(commitmentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: null,
        }),
      );
    });

    it('should set commitment activityId to null when no projectName', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'Standalone commitment',
            from: 'self',
            to: 'self',
            confidence: 0.85,
          },
        ],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.commitments).toBe(1);
      expect(commitmentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: null,
        }),
      );
    });

    it('should map project description and tags to Activity', async () => {
      // Create a custom query builder to capture the values() call
      const valuesQb = createQueryBuilderMock();
      activityRepo.createQueryBuilder = jest.fn().mockReturnValue(valuesQb);

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Detailed Project',
            isNew: true,
            participants: [],
            description: 'My desc',
            tags: ['backend', 'api'],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(1);

      // Verify QueryBuilder values() was called with description and tags
      expect(valuesQb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'My desc',
          tags: ['backend', 'api'],
        }),
      );
    });

    it('should call ClientResolutionService.resolveClient for new projects', async () => {
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Client Project',
            isNew: true,
            participants: [],
            client: 'Acme Corp',
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      await service.createDrafts(input);

      expect(clientResolutionService.resolveClient).toHaveBeenCalledWith(
        expect.objectContaining({
          clientName: 'Acme Corp',
          ownerEntityId: 'owner-123',
        }),
      );
    });

    it('should call ProjectMatchingService.findBestMatch for deduplication', async () => {
      projectMatchingService.findBestMatch.mockResolvedValueOnce({
        matched: true,
        similarity: 0.95,
        activity: {
          id: 'existing-id',
          name: 'Similar Project',
        } as Activity,
      });

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Similar Projekt',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.skipped.projects).toBe(1);
      expect(result.counts.projects).toBe(0);
    });
  });

  describe('Phase 5.5: extraction pipeline prevention', () => {
    it('should create project with possibleDuplicate flag for weak match (0.6-0.8)', async () => {
      // Mock: fuzzy match returns matched=true with similarity 0.75 (weak match zone)
      projectMatchingService.findBestMatch.mockResolvedValueOnce({
        matched: true,
        similarity: 0.75,
        activity: {
          id: 'similar-activity-id',
          name: 'Existing Similar Project',
        } as Activity,
      });

      // Create a custom query builder to capture the metadata values
      const valuesQb = createQueryBuilderMock();
      activityRepo.createQueryBuilder = jest.fn().mockReturnValue(valuesQb);

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Similar Project v2',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      // Project should be CREATED (not skipped) with possibleDuplicate flag
      expect(result.counts.projects).toBe(1);
      expect(result.skipped.projects).toBe(0);

      // Verify metadata contains possibleDuplicate
      expect(valuesQb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            possibleDuplicate: {
              matchedActivityId: 'similar-activity-id',
              matchedName: 'Existing Similar Project',
              similarity: 0.75,
            },
          }),
        }),
      );
    });

    it('should skip project for strong match (>= 0.8)', async () => {
      projectMatchingService.findBestMatch.mockResolvedValueOnce({
        matched: true,
        similarity: 0.85,
        activity: {
          id: 'existing-id',
          name: 'Strong Match Project',
        } as Activity,
      });

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Strong Match Projekt',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      // Project should be SKIPPED (strong match)
      expect(result.skipped.projects).toBe(1);
      expect(result.counts.projects).toBe(0);
    });

    it('should create project normally when no match (< 0.6)', async () => {
      // Default mock: no match (matched=false, similarity=0)
      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Completely New Project',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const valuesQb = createQueryBuilderMock();
      activityRepo.createQueryBuilder = jest.fn().mockReturnValue(valuesQb);

      const result = await service.createDrafts(input);

      // Project should be CREATED without possibleDuplicate flag
      expect(result.counts.projects).toBe(1);
      expect(result.skipped.projects).toBe(0);

      // Verify metadata does NOT contain possibleDuplicate
      const callArgs = valuesQb.values.mock.calls[0][0] as any;
      expect(callArgs.metadata.possibleDuplicate).toBeUndefined();
    });

    it('should use normalizeName for projectMap keys (task parent resolution)', async () => {
      const projectId = 'project-uuid-norm';

      activityRepo.findOneOrFail = jest
        .fn()
        .mockResolvedValueOnce({
          id: projectId,
          name: 'Оплата Рег.ру - хостинг (424.39₽)',
          activityType: ActivityType.PROJECT,
          status: ActivityStatus.DRAFT,
          depth: 0,
          materializedPath: null,
        })
        .mockResolvedValueOnce({
          id: 'task-id',
          name: 'Проверить оплату',
          activityType: ActivityType.TASK,
          status: ActivityStatus.DRAFT,
        });

      activityRepo.findOne = jest.fn().mockResolvedValue({
        id: projectId,
        name: 'Оплата Рег.ру - хостинг (424.39₽)',
        depth: 0,
        materializedPath: null,
      });

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Оплата Рег.ру - хостинг (424.39₽)',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [
          {
            title: 'Проверить оплату',
            // Task references project by name WITHOUT the cost annotation
            projectName: 'Оплата Рег.ру - хостинг',
            status: 'pending',
            confidence: 0.85,
          },
        ],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(1);
      // Task should find its parent via normalized key matching
      expect(result.counts.tasks).toBe(1);
    });

    it('should skip task via fuzzy match to existing active task', async () => {
      // Mock: active tasks found for this owner
      activityRepo.find = jest.fn().mockResolvedValue([
        {
          id: 'existing-task-id',
          name: 'Отправить отчёт клиенту',
          activityType: ActivityType.TASK,
          status: ActivityStatus.ACTIVE,
        },
      ]);

      // Mock: ProjectMatchingService.calculateSimilarity for task fuzzy matching
      projectMatchingService.calculateSimilarity = jest.fn().mockReturnValue(0.85);

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [],
        tasks: [
          {
            title: 'Отправить отчет клиенту',
            status: 'pending',
            confidence: 0.85,
          },
        ],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      // Task should be SKIPPED (fuzzy match >= 0.7 threshold)
      expect(result.skipped.tasks).toBe(1);
      expect(result.counts.tasks).toBe(0);
    });

    it('should create task when fuzzy similarity below threshold', async () => {
      // Mock: active tasks found but low similarity
      activityRepo.find = jest.fn().mockResolvedValue([
        {
          id: 'unrelated-task-id',
          name: 'Completely different task',
          activityType: ActivityType.TASK,
          status: ActivityStatus.ACTIVE,
        },
      ]);

      projectMatchingService.calculateSimilarity = jest.fn().mockReturnValue(0.3);

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [],
        tasks: [
          {
            title: 'New unique task',
            status: 'pending',
            confidence: 0.85,
          },
        ],
        commitments: [],
      };

      const result = await service.createDrafts(input);

      // Task should be CREATED (no match above threshold)
      expect(result.counts.tasks).toBe(1);
      expect(result.skipped.tasks).toBe(0);
    });

    it('should use normalizeName for commitment projectName resolution', async () => {
      const projectId = 'project-uuid-commit';

      activityRepo.findOneOrFail = jest.fn().mockResolvedValueOnce({
        id: projectId,
        name: 'Проект Alpha (1.5M RUB)',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.DRAFT,
        depth: 0,
        materializedPath: null,
      });

      const input: DraftExtractionInput = {
        ownerEntityId: 'owner-123',
        facts: [],
        projects: [
          {
            name: 'Проект Alpha (1.5M RUB)',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'Deliver presentation',
            from: 'self',
            to: 'self',
            // Reference without the cost annotation
            projectName: 'Проект Alpha',
            confidence: 0.85,
          },
        ],
      };

      const result = await service.createDrafts(input);

      expect(result.counts.projects).toBe(1);
      expect(result.counts.commitments).toBe(1);

      // The commitment should have activityId resolved from normalized projectMap
      expect(commitmentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: expect.any(String),
        }),
      );
      const createCall = commitmentRepo.create.mock.calls[0][0] as any;
      expect(createCall.activityId).not.toBeNull();
    });
  });
});
