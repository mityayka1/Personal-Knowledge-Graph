import { Test, TestingModule } from '@nestjs/testing';
import {
  ExtractionPersistenceService,
  PersistExtractionInput,
} from './extraction-persistence.service';
import { ActivityService } from '../activity/activity.service';
import { CommitmentService } from '../activity/commitment.service';
import { ClientResolutionService } from './client-resolution.service';
import { ActivityMemberService } from '../activity/activity-member.service';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  CommitmentType,
  CommitmentPriority,
} from '@pkg/entities';

describe('ExtractionPersistenceService', () => {
  let service: ExtractionPersistenceService;
  let activityService: jest.Mocked<ActivityService>;
  let commitmentService: jest.Mocked<CommitmentService>;
  let clientResolutionService: jest.Mocked<ClientResolutionService>;
  let activityMemberService: jest.Mocked<ActivityMemberService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtractionPersistenceService,
        {
          provide: ActivityService,
          useValue: {
            create: jest.fn().mockResolvedValue({
              id: 'activity-id',
              name: 'Test Project',
              activityType: ActivityType.PROJECT,
              status: ActivityStatus.ACTIVE,
              clientEntityId: null,
            }),
            findOne: jest.fn().mockResolvedValue({
              id: 'existing-id',
              name: 'Existing',
              activityType: ActivityType.PROJECT,
              status: ActivityStatus.ACTIVE,
              clientEntityId: null,
            }),
          },
        },
        {
          provide: CommitmentService,
          useValue: {
            create: jest
              .fn()
              .mockResolvedValue({ id: 'commitment-id', title: 'Test Commitment' }),
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

    service = module.get<ExtractionPersistenceService>(ExtractionPersistenceService);
    activityService = module.get(ActivityService);
    commitmentService = module.get(CommitmentService);
    clientResolutionService = module.get(ClientResolutionService);
    activityMemberService = module.get(ActivityMemberService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('persist', () => {
    it('should persist project and return activity ID', async () => {
      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'New Project',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.persist(input);

      expect(activityService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Project',
          activityType: ActivityType.PROJECT,
        }),
      );
      expect(result.projectsCreated).toBe(1);
      expect(result.activityIds).toHaveLength(1);
    });

    it('should persist task with parent project reference', async () => {
      // Make activityService.create return different IDs for project and task
      activityService.create
        .mockResolvedValueOnce({
          id: 'project-id',
          name: 'Parent Project',
          activityType: ActivityType.PROJECT,
          status: ActivityStatus.ACTIVE,
          clientEntityId: null,
        } as Activity)
        .mockResolvedValueOnce({
          id: 'task-id',
          name: 'Child Task',
          activityType: ActivityType.TASK,
          status: ActivityStatus.IDEA,
        } as Activity);

      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Parent Project',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
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

      const result = await service.persist(input);

      expect(result.projectsCreated).toBe(1);
      expect(result.tasksCreated).toBe(1);

      // Task should be created with parentId matching the project's ID
      const taskCreateCall = activityService.create.mock.calls[1][0];
      expect(taskCreateCall.parentId).toBe('project-id');
    });

    it('should persist commitment with resolved activityId from projectMap', async () => {
      activityService.create.mockResolvedValueOnce({
        id: 'project-x-id',
        name: 'Project X',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        clientEntityId: null,
      } as Activity);

      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Project X',
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
            projectName: 'Project X',
            confidence: 0.85,
          },
        ],
      };

      const result = await service.persist(input);

      expect(result.commitmentsCreated).toBe(1);
      expect(commitmentService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: 'project-x-id',
        }),
      );
    });

    it('should set commitment activityId to undefined when no projectName', async () => {
      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
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

      const result = await service.persist(input);

      expect(result.commitmentsCreated).toBe(1);
      expect(commitmentService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: undefined,
        }),
      );
    });

    it('should call ClientResolutionService for new projects', async () => {
      clientResolutionService.resolveClient.mockResolvedValueOnce({
        entityId: 'client-id',
        entityName: 'Client Corp',
        method: 'explicit',
      });

      activityService.create.mockResolvedValueOnce({
        id: 'activity-id',
        name: 'Client Project',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        clientEntityId: 'client-id',
      } as Activity);

      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Client Project',
            isNew: true,
            participants: [],
            client: 'Client Corp',
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      await service.persist(input);

      expect(clientResolutionService.resolveClient).toHaveBeenCalledWith(
        expect.objectContaining({
          clientName: 'Client Corp',
          ownerEntityId: 'owner-123',
        }),
      );
      expect(activityService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          clientEntityId: 'client-id',
        }),
      );
    });

    it('should skip existing project by existingActivityId', async () => {
      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Existing Project',
            isNew: false,
            existingActivityId: 'existing-id',
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.persist(input);

      // findOne called instead of create
      expect(activityService.findOne).toHaveBeenCalledWith('existing-id');
      expect(activityService.create).not.toHaveBeenCalled();
      // Still counted as persisted project (matched existing)
      expect(result.projectsCreated).toBe(1);
      expect(result.activityIds).toContain('existing-id');
    });

    it('should call ActivityMemberService for projects with participants', async () => {
      activityService.create.mockResolvedValueOnce({
        id: 'proj-id',
        name: 'Team Project',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        clientEntityId: null,
      } as Activity);

      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Team Project',
            isNew: true,
            participants: ['Alice'],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      await service.persist(input);

      expect(activityMemberService.resolveAndCreateMembers).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: 'proj-id',
          participants: ['Alice'],
          ownerEntityId: 'owner-123',
        }),
      );
    });

    it('should continue on ActivityMemberService failure', async () => {
      activityMemberService.resolveAndCreateMembers.mockRejectedValueOnce(
        new Error('Member resolution failed'),
      );

      activityService.create.mockResolvedValueOnce({
        id: 'proj-id',
        name: 'Project',
        activityType: ActivityType.PROJECT,
        status: ActivityStatus.ACTIVE,
        clientEntityId: null,
      } as Activity);

      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Project',
            isNew: true,
            participants: ['Alice'],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.persist(input);

      // Project still counted despite member failure
      expect(result.projectsCreated).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass description, deadline, tags to activityService.create', async () => {
      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Detailed Project',
            isNew: true,
            participants: [],
            description: 'A detailed description',
            deadline: '2026-03-01',
            tags: ['backend', 'api'],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      await service.persist(input);

      expect(activityService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'A detailed description',
          deadline: '2026-03-01',
          tags: ['backend', 'api'],
        }),
      );
    });

    it('should resolve commitment from/to entities via ClientResolutionService', async () => {
      clientResolutionService.findEntityByName.mockImplementation(async (name: string) => {
        if (name === 'Sergey') {
          return { id: 'sergey-id', name: 'Sergey' } as any;
        }
        return null;
      });

      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'Send report',
            from: 'self',
            to: 'Sergey',
            confidence: 0.85,
          },
        ],
      };

      await service.persist(input);

      expect(clientResolutionService.findEntityByName).toHaveBeenCalledWith('Sergey');
      expect(commitmentService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          toEntityId: 'sergey-id',
          fromEntityId: 'owner-123',
        }),
      );
    });

    it('should record errors for failed items', async () => {
      activityService.create.mockRejectedValueOnce(new Error('DB connection lost'));

      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [
          {
            name: 'Failing Project',
            isNew: true,
            participants: [],
            confidence: 0.9,
          },
        ],
        tasks: [],
        commitments: [],
      };

      const result = await service.persist(input);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].item).toBe('project:Failing Project');
      expect(result.errors[0].error).toContain('DB connection lost');
    });

    it('should use ownerEntityId for self commitments', async () => {
      const input: PersistExtractionInput = {
        ownerEntityId: 'owner-123',
        projects: [],
        tasks: [],
        commitments: [
          {
            type: 'promise',
            what: 'Self commitment',
            from: 'self',
            to: 'self',
            confidence: 0.9,
          },
        ],
      };

      await service.persist(input);

      expect(commitmentService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fromEntityId: 'owner-123',
          toEntityId: 'owner-123',
        }),
      );
    });
  });
});
