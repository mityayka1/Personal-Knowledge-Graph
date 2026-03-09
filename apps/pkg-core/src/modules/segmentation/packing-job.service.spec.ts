import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  TopicalSegment,
  SegmentStatus,
  KnowledgePack,
  Activity,
} from '@pkg/entities';
import { PackingJobService } from './packing-job.service';
import { PackingService } from './packing.service';
import { OrphanSegmentLinkerService } from './orphan-segment-linker.service';
import { SettingsService } from '../settings/settings.service';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let segmentCounter = 0;

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
    keywords: overrides.keywords ?? null,
    knowledgePackId: overrides.knowledgePackId ?? null,
    ...overrides,
  }) as TopicalSegment;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSegmentRepo = {
  find: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockPackingService = {
  packByActivity: jest.fn(),
  packByActivityIncremental: jest.fn(),
};

const mockOrphanLinker = {
  linkAllOrphans: jest.fn(),
};

const mockSettingsService = {
  getValue: jest.fn(),
};

const mockDataSource = {
  query: jest.fn(),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PackingJobService', () => {
  let service: PackingJobService;

  beforeEach(async () => {
    segmentCounter = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PackingJobService,
        {
          provide: getRepositoryToken(TopicalSegment),
          useValue: mockSegmentRepo,
        },
        {
          provide: PackingService,
          useValue: mockPackingService,
        },
        {
          provide: OrphanSegmentLinkerService,
          useValue: mockOrphanLinker,
        },
        {
          provide: SettingsService,
          useValue: mockSettingsService,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<PackingJobService>(PackingJobService);

    jest.clearAllMocks();
  });

  // =========================================================================
  // collectHierarchicalSegments
  // =========================================================================

  describe('collectHierarchicalSegments', () => {
    it('should collect segments from activity and its children via closure table', async () => {
      const activityId = 'parent-activity-id';
      const childActivityId = 'child-activity-id';

      const ownSegments = [
        createSegment({ id: 'seg-own-1', activityId, topic: 'Parent topic 1' }),
        createSegment({ id: 'seg-own-2', activityId, topic: 'Parent topic 2' }),
      ];

      const childSegments = [
        createSegment({ id: 'seg-child-1', activityId: childActivityId, topic: 'Child topic 1' }),
      ];

      // Mock own segments query
      mockSegmentRepo.find.mockResolvedValue(ownSegments);

      // Mock descendants query via closure table
      mockDataSource.query.mockResolvedValue([{ id: childActivityId }]);

      // Mock child segments query builder
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(childSegments),
      };
      mockSegmentRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await (service as any).collectHierarchicalSegments(activityId);

      // Should combine own + child segments
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('seg-own-1');
      expect(result[1].id).toBe('seg-own-2');
      expect(result[2].id).toBe('seg-child-1');

      // Verify own segments were fetched with correct params
      expect(mockSegmentRepo.find).toHaveBeenCalledWith({
        where: { activityId, status: SegmentStatus.ACTIVE },
        order: { startedAt: 'ASC' },
      });

      // Verify closure table query was called
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('activities_closure'),
        [activityId],
      );
    });

    it('should return only own segments when no children', async () => {
      const activityId = 'leaf-activity-id';

      const ownSegments = [
        createSegment({ id: 'seg-1', activityId, topic: 'Topic 1' }),
        createSegment({ id: 'seg-2', activityId, topic: 'Topic 2' }),
      ];

      // Mock own segments query
      mockSegmentRepo.find.mockResolvedValue(ownSegments);

      // Mock descendants query — no descendants
      mockDataSource.query.mockResolvedValue([]);

      const result = await (service as any).collectHierarchicalSegments(activityId);

      // Should return only own segments
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('seg-1');
      expect(result[1].id).toBe('seg-2');

      // Should NOT create a query builder for child segments
      expect(mockSegmentRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
