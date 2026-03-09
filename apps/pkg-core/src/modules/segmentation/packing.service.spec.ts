import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  KnowledgePack,
  PackType,
  PackStatus,
  TopicalSegment,
  SegmentStatus,
} from '@pkg/entities';
import { PackingService } from './packing.service';
import { SegmentationService } from './segmentation.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let segmentCounter = 0;
let packCounter = 0;

const createSegment = (
  overrides: Partial<TopicalSegment> = {},
): TopicalSegment =>
  ({
    id: overrides.id ?? `segment-${++segmentCounter}`,
    topic: overrides.topic ?? `Topic ${segmentCounter}`,
    summary: overrides.summary ?? null,
    chatId: overrides.chatId ?? 'chat-1',
    interactionId: overrides.interactionId ?? null,
    activityId: overrides.activityId ?? null,
    participantIds: overrides.participantIds ?? ['entity-1'],
    primaryParticipantId: overrides.primaryParticipantId ?? 'entity-1',
    status: overrides.status ?? SegmentStatus.ACTIVE,
    messageCount: overrides.messageCount ?? 5,
    startedAt: overrides.startedAt ?? new Date('2026-01-01'),
    endedAt: overrides.endedAt ?? new Date('2026-01-02'),
    keywords: overrides.keywords ?? ['test'],
    knowledgePackId: overrides.knowledgePackId ?? null,
    ...overrides,
  }) as TopicalSegment;

const createKnowledgePack = (
  overrides: Partial<KnowledgePack> = {},
): KnowledgePack =>
  ({
    id: overrides.id ?? `pack-${++packCounter}`,
    title: overrides.title ?? `Pack ${packCounter}`,
    packType: overrides.packType ?? PackType.ACTIVITY,
    activityId: overrides.activityId ?? 'activity-1',
    entityId: overrides.entityId ?? null,
    periodStart: overrides.periodStart ?? new Date('2026-01-01'),
    periodEnd: overrides.periodEnd ?? new Date('2026-01-15'),
    summary: overrides.summary ?? 'Existing summary',
    decisions: overrides.decisions ?? [],
    openQuestions: overrides.openQuestions ?? [],
    keyFacts: overrides.keyFacts ?? [],
    conflicts: overrides.conflicts ?? [],
    participantIds: overrides.participantIds ?? ['entity-1'],
    sourceSegmentIds: overrides.sourceSegmentIds ?? ['seg-old-1'],
    segmentCount: overrides.segmentCount ?? 1,
    totalMessageCount: overrides.totalMessageCount ?? 5,
    status: overrides.status ?? PackStatus.ACTIVE,
    metadata: overrides.metadata ?? null,
    ...overrides,
  }) as KnowledgePack;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPackRepo = {
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockSegmentRepo = {
  find: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockSegmentationService = {
  findOnePack: jest.fn(),
};

const mockClaudeAgentService = {
  call: jest.fn(),
};

const mockDataSource = {
  query: jest.fn(),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PackingService', () => {
  let service: PackingService;

  beforeEach(async () => {
    segmentCounter = 0;
    packCounter = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PackingService,
        {
          provide: getRepositoryToken(KnowledgePack),
          useValue: mockPackRepo,
        },
        {
          provide: getRepositoryToken(TopicalSegment),
          useValue: mockSegmentRepo,
        },
        {
          provide: SegmentationService,
          useValue: mockSegmentationService,
        },
        {
          provide: ClaudeAgentService,
          useValue: mockClaudeAgentService,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<PackingService>(PackingService);

    jest.clearAllMocks();
  });

  // =========================================================================
  // packByActivityIncremental
  // =========================================================================

  describe('packByActivityIncremental', () => {
    const activityId = 'activity-1';

    const synthesisResponse = {
      keyFacts: [
        { factType: 'agreement', value: 'Agreed on timeline', confidence: 0.9 },
      ],
      decisions: [
        { what: 'Use NestJS', when: '2026-01-10', context: 'Framework choice' },
      ],
      openQuestions: [
        { question: 'Budget?', raisedAt: '2026-01-12', context: 'Needs approval' },
      ],
      conflicts: [],
      timeline: [
        { date: '2026-01-10', event: 'Project started' },
      ],
      summary: 'Project kickoff and initial decisions.',
    };

    it('should create new KP when none exists', async () => {
      const segments = [
        createSegment({ id: 'seg-1', activityId }),
        createSegment({ id: 'seg-2', activityId }),
      ];

      // No existing pack
      mockPackRepo.findOne.mockResolvedValue(null);

      // Claude synthesis
      mockClaudeAgentService.call.mockResolvedValue({
        data: synthesisResponse,
        usage: { inputTokens: 500, outputTokens: 200, totalCostUsd: 0.005 },
        run: {} as any,
      });

      // Pack creation
      const createdPack = createKnowledgePack({
        id: 'new-pack-id',
        activityId,
        sourceSegmentIds: ['seg-1', 'seg-2'],
      });
      mockPackRepo.create.mockReturnValue(createdPack);
      mockPackRepo.save.mockResolvedValue(createdPack);

      // Mark segments packed — mock the query builder chain
      const updateQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        whereInIds: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      };
      mockSegmentRepo.createQueryBuilder.mockReturnValue(updateQb as any);

      const result = await service.packByActivityIncremental(activityId, segments);

      expect(result).toBeDefined();
      expect(result.segmentCount).toBe(2);
      expect(mockPackRepo.findOne).toHaveBeenCalledWith({
        where: { activityId, packType: PackType.ACTIVITY, status: PackStatus.ACTIVE },
      });
      expect(mockClaudeAgentService.call).toHaveBeenCalledTimes(1);
      expect(mockPackRepo.save).toHaveBeenCalled();
    });

    it('should update existing KP with new segments', async () => {
      const existingPack = createKnowledgePack({
        id: 'existing-pack-id',
        activityId,
        sourceSegmentIds: ['seg-old-1'],
        summary: 'Old summary',
      });

      const segments = [
        createSegment({ id: 'seg-old-1', activityId }),
        createSegment({ id: 'seg-new-1', activityId }),
        createSegment({ id: 'seg-new-2', activityId }),
      ];

      // Existing pack found
      mockPackRepo.findOne.mockResolvedValue(existingPack);

      // Claude synthesis (incremental update with existing context)
      mockClaudeAgentService.call.mockResolvedValue({
        data: synthesisResponse,
        usage: { inputTokens: 800, outputTokens: 300, totalCostUsd: 0.008 },
        run: {} as any,
      });

      // Save updated pack
      mockPackRepo.save.mockResolvedValue({ ...existingPack, summary: synthesisResponse.summary });

      // Mark segments packed
      const updateQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        whereInIds: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      };
      mockSegmentRepo.createQueryBuilder.mockReturnValue(updateQb as any);

      const result = await service.packByActivityIncremental(activityId, segments);

      expect(result).toBeDefined();
      // Only new segments should be counted
      expect(result.segmentCount).toBe(2);
      expect(mockClaudeAgentService.call).toHaveBeenCalledTimes(1);

      // Verify Claude was called with existing context
      const callArgs = mockClaudeAgentService.call.mock.calls[0][0];
      expect(callArgs.prompt).toContain('Old summary');
      expect(mockPackRepo.save).toHaveBeenCalled();
    });

    it('should skip when no truly new segments', async () => {
      const existingPack = createKnowledgePack({
        id: 'existing-pack-id',
        activityId,
        sourceSegmentIds: ['seg-1', 'seg-2'],
      });

      // All segments are already packed into this KP
      const segments = [
        createSegment({ id: 'seg-1', activityId }),
        createSegment({ id: 'seg-2', activityId }),
      ];

      mockPackRepo.findOne.mockResolvedValue(existingPack);

      const result = await service.packByActivityIncremental(activityId, segments);

      expect(result.segmentCount).toBe(0);
      expect(result.tokensUsed).toBe(0);
      // Should NOT call Claude
      expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
    });
  });
});
