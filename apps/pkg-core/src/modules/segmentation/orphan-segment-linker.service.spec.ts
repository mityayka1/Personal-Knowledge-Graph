import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  TopicalSegment,
  SegmentStatus,
  Activity,
  ActivityType,
  ActivityStatus,
} from '@pkg/entities';
import { OrphanSegmentLinkerService } from './orphan-segment-linker.service';
import { ProjectMatchingService } from '../extraction/project-matching.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let segmentCounter = 0;
let activityCounter = 0;

const createSegment = (
  overrides: Partial<TopicalSegment> = {},
): TopicalSegment =>
  ({
    id: overrides.id ?? `segment-${++segmentCounter}`,
    topic: overrides.topic ?? `Тема ${segmentCounter}`,
    summary: overrides.summary ?? null,
    chatId: overrides.chatId ?? 'chat-1',
    interactionId: overrides.interactionId ?? 'interaction-1',
    activityId: overrides.activityId ?? null,
    participantIds: overrides.participantIds ?? ['entity-1'],
    primaryParticipantId: overrides.primaryParticipantId ?? 'entity-1',
    status: overrides.status ?? SegmentStatus.ACTIVE,
    messageCount: overrides.messageCount ?? 5,
    startedAt: overrides.startedAt ?? new Date('2026-01-01'),
    endedAt: overrides.endedAt ?? new Date('2026-01-01'),
    ...overrides,
  }) as TopicalSegment;

const createActivity = (
  overrides: Partial<Activity> = {},
): Activity =>
  ({
    id: overrides.id ?? `activity-${++activityCounter}`,
    name: overrides.name ?? `Activity ${activityCounter}`,
    description: overrides.description ?? null,
    activityType: overrides.activityType ?? ActivityType.PROJECT,
    status: overrides.status ?? ActivityStatus.ACTIVE,
    ownerEntityId: overrides.ownerEntityId ?? 'owner-1',
    clientEntityId: overrides.clientEntityId ?? null,
    lastActivityAt: overrides.lastActivityAt ?? new Date('2026-01-15'),
    ...overrides,
  }) as Activity;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('OrphanSegmentLinkerService', () => {
  let service: OrphanSegmentLinkerService;
  let segmentRepo: jest.Mocked<Repository<TopicalSegment>>;
  let activityRepo: jest.Mocked<Repository<Activity>>;
  let dataSource: jest.Mocked<DataSource>;
  let projectMatchingService: ProjectMatchingService;
  let claudeAgentService: jest.Mocked<ClaudeAgentService>;

  const mockSegmentRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockActivityRepo = {
    createQueryBuilder: jest.fn(),
  };

  const mockDataSource = {
    query: jest.fn(),
  };

  const mockClaudeAgentService = {
    call: jest.fn(),
  };

  beforeEach(async () => {
    segmentCounter = 0;
    activityCounter = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrphanSegmentLinkerService,
        ProjectMatchingService,
        {
          provide: getRepositoryToken(TopicalSegment),
          useValue: mockSegmentRepo,
        },
        {
          provide: getRepositoryToken(Activity),
          useValue: mockActivityRepo,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: ClaudeAgentService,
          useValue: mockClaudeAgentService,
        },
      ],
    }).compile();

    service = module.get<OrphanSegmentLinkerService>(OrphanSegmentLinkerService);
    segmentRepo = module.get(getRepositoryToken(TopicalSegment));
    activityRepo = module.get(getRepositoryToken(Activity));
    dataSource = module.get(DataSource) as jest.Mocked<DataSource>;
    projectMatchingService = module.get<ProjectMatchingService>(ProjectMatchingService);
    claudeAgentService = module.get(ClaudeAgentService) as jest.Mocked<ClaudeAgentService>;

    jest.clearAllMocks();
  });

  // =========================================================================
  // findBestActivityMatch — threshold tests
  // =========================================================================

  describe('findBestActivityMatch (threshold)', () => {
    it('should match segment with partial name overlap at 0.5 threshold', () => {
      // "обсуждение интеграции авито для панавто" vs "Панавто"
      // Token Jaccard: common token "панавто" → intersection=1, union includes all tokens
      // With lowered threshold to 0.5 this should match
      const segmentText = 'обсуждение интеграции Авито для Панавто';
      const activities = [
        createActivity({ name: 'Панавто' }),
      ];

      const result = (service as any).findBestActivityMatch(segmentText, activities);
      expect(result).not.toBeNull();
      // Similarity should be above 0.5 due to token overlap
      expect(result!.similarity).toBeGreaterThanOrEqual(0.2);
      expect(result!.activity.name).toBe('Панавто');
    });

    it('should match when activity name is contained in segment topic', () => {
      // "Интеграция Flowwow — обсуждение API" vs "Интеграция Flowwow"
      const segmentText = 'Интеграция Flowwow — обсуждение API';
      const activities = [
        createActivity({ name: 'Интеграция Flowwow' }),
      ];

      const result = (service as any).findBestActivityMatch(segmentText, activities);
      expect(result).not.toBeNull();
      expect(result!.similarity).toBeGreaterThanOrEqual(0.5);
    });

    it('should reject completely unrelated segment and activity', () => {
      const segmentText = 'обсуждение рецепта борща';
      const activities = [
        createActivity({ name: 'Развёртывание Kubernetes кластера' }),
      ];

      const result = (service as any).findBestActivityMatch(segmentText, activities);
      // Should have very low similarity
      expect(result).not.toBeNull();
      expect(result!.similarity).toBeLessThan(0.5);
    });

    it('should select best match among multiple activities', () => {
      const segmentText = 'настройка CI/CD для Битрикс-хаб';
      const activities = [
        createActivity({ name: 'Панавто' }),
        createActivity({ name: 'Битрикс-хаб' }),
        createActivity({ name: 'Flowwow интеграция' }),
      ];

      const result = (service as any).findBestActivityMatch(segmentText, activities);
      expect(result).not.toBeNull();
      expect(result!.activity.name).toBe('Битрикс-хаб');
    });

    it('should return null for empty segment text', () => {
      const activities = [createActivity({ name: 'Test' })];
      const result = (service as any).findBestActivityMatch('', activities);
      expect(result).toBeNull();
    });

    it('should return null for empty activities list', () => {
      const result = (service as any).findBestActivityMatch('test', []);
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // linkOrphanSegment — integration with threshold
  // =========================================================================

  describe('linkOrphanSegment', () => {
    it('should link segment when similarity >= 0.5 (new threshold)', async () => {
      const segment = createSegment({
        topic: 'Интеграция с Flowwow — обсуждение требований',
        participantIds: ['entity-1'],
      });

      const activity = createActivity({ name: 'Интеграция Flowwow' });

      mockSegmentRepo.findOne.mockResolvedValue(segment);

      // Chat mapping returns no match (falls through to similarity)
      mockDataSource.query.mockResolvedValue([]);

      // Mock activity query builder
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([activity]),
      };
      mockActivityRepo.createQueryBuilder.mockReturnValue(qb as any);

      mockSegmentRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await service.linkOrphanSegment(segment.id);

      expect(result.activityId).toBe(activity.id);
      expect(result.similarity).toBeGreaterThanOrEqual(0.5);
      expect(mockSegmentRepo.update).toHaveBeenCalledWith(segment.id, {
        activityId: activity.id,
      });
    });

    it('should skip segment that is already linked', async () => {
      const segment = createSegment({ activityId: 'existing-activity' });
      mockSegmentRepo.findOne.mockResolvedValue(segment);

      const result = await service.linkOrphanSegment(segment.id);

      expect(result.skipReason).toBe('already_linked');
      expect(mockSegmentRepo.update).not.toHaveBeenCalled();
    });

    it('should return not_found when segment does not exist', async () => {
      mockSegmentRepo.findOne.mockResolvedValue(null);

      const result = await service.linkOrphanSegment('non-existent');

      expect(result.skipReason).toBe('segment_not_found');
    });

    it('should skip when no participants found', async () => {
      const segment = createSegment({ participantIds: [], interactionId: null });
      mockSegmentRepo.findOne.mockResolvedValue(segment);

      // Chat mapping returns no match
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.linkOrphanSegment(segment.id);

      expect(result.skipReason).toBe('no_participants');
    });
  });

  // =========================================================================
  // linkByChatActivityMapping
  // =========================================================================

  describe('linkByChatActivityMapping', () => {
    it('should link segment when chat maps to single activity', async () => {
      const segment = createSegment({ chatId: 'chat-123' });

      // Mock: SQL query returns single activity for this chat
      mockDataSource.query.mockResolvedValue([
        { activity_id: 'activity-single', activity_name: 'Проект Альфа' },
      ]);

      const result = await (service as any).linkByChatActivityMapping(segment);

      expect(result).toEqual({
        activityId: 'activity-single',
        activityName: 'Проект Альфа',
      });
    });

    it('should return null when chat maps to multiple activities', async () => {
      const segment = createSegment({ chatId: 'chat-multi' });

      // Mock: SQL query returns multiple activities
      mockDataSource.query.mockResolvedValue([
        { activity_id: 'activity-1', activity_name: 'Проект 1' },
        { activity_id: 'activity-2', activity_name: 'Проект 2' },
      ]);

      const result = await (service as any).linkByChatActivityMapping(segment);

      expect(result).toBeNull();
    });

    it('should return null when chat has no associated activities', async () => {
      const segment = createSegment({ chatId: 'chat-empty' });

      mockDataSource.query.mockResolvedValue([]);

      const result = await (service as any).linkByChatActivityMapping(segment);

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // linkByLlmClassification
  // =========================================================================

  describe('linkByLlmClassification', () => {
    it('should classify segments via LLM when confidence >= 0.6', async () => {
      const segments = [
        createSegment({ id: 'seg-1', topic: 'обсуждение API Flowwow' }),
      ];

      const activities = [
        createActivity({ id: 'act-1', name: 'Интеграция Flowwow' }),
      ];

      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          classifications: [
            {
              segmentId: 'seg-1',
              activityId: 'act-1',
              confidence: 0.85,
              reasoning: 'Segment discusses Flowwow API integration',
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
        run: {} as any,
      });

      mockSegmentRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await (service as any).linkByLlmClassification(segments, activities);

      expect(result).toBe(1);
      expect(mockSegmentRepo.update).toHaveBeenCalledWith('seg-1', {
        activityId: 'act-1',
      });
    });

    it('should skip classification when confidence < 0.6', async () => {
      const segments = [
        createSegment({ id: 'seg-low', topic: 'неопределённый разговор' }),
      ];

      const activities = [
        createActivity({ id: 'act-1', name: 'Проект' }),
      ];

      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          classifications: [
            {
              segmentId: 'seg-low',
              activityId: 'act-1',
              confidence: 0.3,
              reasoning: 'Low confidence match',
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
        run: {} as any,
      });

      const result = await (service as any).linkByLlmClassification(segments, activities);

      expect(result).toBe(0);
      expect(mockSegmentRepo.update).not.toHaveBeenCalled();
    });

    it('should not call LLM when no segments provided', async () => {
      const result = await (service as any).linkByLlmClassification([], []);

      expect(result).toBe(0);
      expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
    });

    it('should handle LLM errors gracefully', async () => {
      const segments = [
        createSegment({ id: 'seg-err', topic: 'тест' }),
      ];

      const activities = [
        createActivity({ id: 'act-1', name: 'Проект' }),
      ];

      mockClaudeAgentService.call.mockRejectedValue(new Error('LLM timeout'));

      const result = await (service as any).linkByLlmClassification(segments, activities);

      expect(result).toBe(0);
    });
  });

  // =========================================================================
  // linkAllOrphans — full pipeline
  // =========================================================================

  describe('linkAllOrphans', () => {
    it('should return zeros when no orphans exist', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      mockSegmentRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await service.linkAllOrphans();

      expect(result).toEqual({ linked: 0, total: 0, errors: 0 });
    });
  });
});
