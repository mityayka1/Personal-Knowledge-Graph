import { Test, TestingModule } from '@nestjs/testing';
import { Job as BullJob } from 'bullmq';
import { DataSource } from 'typeorm';
import { FactExtractionProcessor } from './fact-extraction.processor';
import { UnifiedExtractionService } from '../../extraction/unified-extraction.service';
import { GroupExtractionService } from '../../extraction/group-extraction.service';
import { EntityService } from '../../entity/entity.service';
import { InteractionService } from '../../interaction/interaction.service';
import { TopicBoundaryDetectorService } from '../../segmentation/topic-boundary-detector.service';
import { SegmentationService } from '../../segmentation/segmentation.service';
import { OrphanSegmentLinkerService } from '../../segmentation/orphan-segment-linker.service';
import { ChatCategoryService } from '../../chat-category/chat-category.service';
import { ExtractionJobData } from '../job.service';

describe('FactExtractionProcessor', () => {
  let processor: FactExtractionProcessor;
  let unifiedExtractionService: jest.Mocked<UnifiedExtractionService>;
  let entityService: jest.Mocked<EntityService>;
  let groupExtractionService: jest.Mocked<GroupExtractionService>;
  let interactionService: jest.Mocked<InteractionService>;

  const mockUnifiedExtractionService = {
    extract: jest.fn(),
  };

  const mockGroupExtractionService = {
    extract: jest.fn(),
  };

  const mockEntityService = {
    findOne: jest.fn(),
  };

  const mockInteractionService = {
    findOne: jest.fn(),
  };

  const mockTopicDetector = {
    detectAndCreate: jest.fn().mockResolvedValue({
      segmentIds: [],
      segmentCount: 0,
      messagesAssigned: 0,
      messagesSkipped: 0,
      tokensUsed: 0,
      durationMs: 0,
    }),
  };

  const mockSegmentationService = {
    findRelatedSegments: jest.fn().mockResolvedValue([]),
    linkRelatedSegments: jest.fn().mockResolvedValue(undefined),
  };

  const mockOrphanLinker = {
    linkOrphanSegment: jest.fn().mockResolvedValue({ activityId: null, similarity: 0 }),
  };

  const mockChatCategoryService = {
    getCategory: jest.fn().mockResolvedValue(null),
  };

  const mockDataSource = {
    query: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FactExtractionProcessor,
        {
          provide: UnifiedExtractionService,
          useValue: mockUnifiedExtractionService,
        },
        {
          provide: GroupExtractionService,
          useValue: mockGroupExtractionService,
        },
        {
          provide: EntityService,
          useValue: mockEntityService,
        },
        {
          provide: InteractionService,
          useValue: mockInteractionService,
        },
        {
          provide: TopicBoundaryDetectorService,
          useValue: mockTopicDetector,
        },
        {
          provide: SegmentationService,
          useValue: mockSegmentationService,
        },
        {
          provide: OrphanSegmentLinkerService,
          useValue: mockOrphanLinker,
        },
        {
          provide: ChatCategoryService,
          useValue: mockChatCategoryService,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    processor = module.get<FactExtractionProcessor>(FactExtractionProcessor);
    unifiedExtractionService = module.get(UnifiedExtractionService);
    groupExtractionService = module.get(GroupExtractionService);
    entityService = module.get(EntityService);
    interactionService = module.get(InteractionService);
  });

  const createMockJob = (data: ExtractionJobData): BullJob<ExtractionJobData> => ({
    id: 'job-123',
    data,
  } as BullJob<ExtractionJobData>);

  describe('process', () => {
    const baseJobData: ExtractionJobData = {
      interactionId: 'interaction-123',
      entityId: 'entity-456',
      messageIds: ['msg-1'],
      messages: [
        {
          id: 'msg-1',
          content: 'Test message content',
          timestamp: '2026-01-20T10:00:00Z',
          isOutgoing: false,
        },
      ],
    };

    beforeEach(() => {
      // Default: interaction with private chat_type so existing tests route to private chat flow
      mockInteractionService.findOne.mockResolvedValue({
        id: 'interaction-123',
        sourceMetadata: { chat_type: 'private' },
        participants: [],
      });
      mockEntityService.findOne.mockResolvedValue({
        id: 'entity-456',
        name: 'Test User',
        isBot: false,
      });
      mockUnifiedExtractionService.extract.mockResolvedValue({
        factsCreated: 0,
        eventsCreated: 0,
        relationsCreated: 0,
        pendingEntities: 0,
        turns: 1,
        toolsUsed: [],
        tokensUsed: 100,
      });
    });

    it('should process extraction job successfully', async () => {
      const job = createMockJob(baseJobData);

      const result = await processor.process(job);

      expect(result).toEqual({
        success: true,
        factsCreated: 0,
        eventsCreated: 0,
        relationsCreated: 0,
        pendingEntities: 0,
      });

      expect(mockEntityService.findOne).toHaveBeenCalledWith('entity-456');
      expect(mockUnifiedExtractionService.extract).toHaveBeenCalledWith({
        entityId: 'entity-456',
        entityName: 'Test User',
        messages: baseJobData.messages,
        interactionId: 'interaction-123',
      });
    });

    describe('bot entity handling', () => {
      it('should skip extraction for bot entities', async () => {
        mockEntityService.findOne.mockResolvedValue({
          id: 'bot-entity',
          name: 'SeBra Bot',
          isBot: true,
        });

        const job = createMockJob({
          ...baseJobData,
          entityId: 'bot-entity',
        });

        const result = await processor.process(job);

        expect(result).toEqual({
          success: true,
          skipped: 'bot',
        });

        expect(mockUnifiedExtractionService.extract).not.toHaveBeenCalled();
      });

      it('should process extraction for non-bot entities', async () => {
        const job = createMockJob(baseJobData);

        await processor.process(job);

        expect(mockUnifiedExtractionService.extract).toHaveBeenCalled();
      });
    });

    describe('extraction results', () => {
      it('should return counts from unified extraction', async () => {
        mockUnifiedExtractionService.extract.mockResolvedValue({
          factsCreated: 3,
          eventsCreated: 2,
          relationsCreated: 1,
          pendingEntities: 1,
          turns: 5,
          toolsUsed: ['create_fact', 'create_event', 'create_relation'],
          tokensUsed: 2500,
        });

        const job = createMockJob(baseJobData);

        const result = await processor.process(job);

        expect(result).toEqual({
          success: true,
          factsCreated: 3,
          eventsCreated: 2,
          relationsCreated: 1,
          pendingEntities: 1,
        });
      });

      it('should pass entity name and messages to unified extraction', async () => {
        const jobData: ExtractionJobData = {
          interactionId: 'interaction-789',
          entityId: 'entity-abc',
          messageIds: ['msg-1', 'msg-2'],
          messages: [
            { id: 'msg-1', content: 'First message', timestamp: '2026-01-20T10:00:00Z', isOutgoing: false },
            { id: 'msg-2', content: 'Second message', timestamp: '2026-01-20T10:01:00Z', isOutgoing: true },
          ],
        };

        mockEntityService.findOne.mockResolvedValue({
          id: 'entity-abc',
          name: 'Алексей',
          isBot: false,
        });

        const job = createMockJob(jobData);

        await processor.process(job);

        expect(mockUnifiedExtractionService.extract).toHaveBeenCalledWith({
          entityId: 'entity-abc',
          entityName: 'Алексей',
          messages: jobData.messages,
          interactionId: 'interaction-789',
        });
      });
    });

    describe('chat type routing', () => {
      const groupExtractionResult = {
        factsCreated: 2,
        eventsCreated: 1,
        relationsCreated: 0,
        pendingEntities: 1,
        turns: 3,
        toolsUsed: ['create_fact'],
        tokensUsed: 500,
      };

      beforeEach(() => {
        mockGroupExtractionService.extract.mockResolvedValue(groupExtractionResult);
      });

      it('should route to group extraction for group chat_type', async () => {
        mockInteractionService.findOne.mockResolvedValue({
          id: 'interaction-123',
          sourceMetadata: { chat_type: 'group' },
          participants: [{ id: 'p-1', entity: { id: 'e-1', name: 'Alice' } }],
        });

        const job = createMockJob(baseJobData);
        const result = await processor.process(job);

        expect(result).toEqual({
          success: true,
          factsCreated: 2,
          eventsCreated: 1,
          relationsCreated: 0,
          pendingEntities: 1,
        });

        expect(mockGroupExtractionService.extract).toHaveBeenCalledWith({
          interactionId: 'interaction-123',
          messages: baseJobData.messages,
          participants: [{ id: 'p-1', entity: { id: 'e-1', name: 'Alice' } }],
          chatName: undefined,
        });
        expect(mockUnifiedExtractionService.extract).not.toHaveBeenCalled();
      });

      it('should route to group extraction for supergroup chat_type', async () => {
        mockInteractionService.findOne.mockResolvedValue({
          id: 'interaction-123',
          sourceMetadata: { chat_type: 'supergroup' },
          participants: [],
        });

        const job = createMockJob(baseJobData);
        const result = await processor.process(job);

        expect(result).toEqual({
          success: true,
          factsCreated: 2,
          eventsCreated: 1,
          relationsCreated: 0,
          pendingEntities: 1,
        });

        expect(mockGroupExtractionService.extract).toHaveBeenCalled();
        expect(mockUnifiedExtractionService.extract).not.toHaveBeenCalled();
      });

      it('should throw when interaction cannot be loaded (prevents wrong chat type routing)', async () => {
        mockInteractionService.findOne.mockRejectedValue(new Error('DB connection error'));

        const job = createMockJob(baseJobData);

        await expect(processor.process(job)).rejects.toThrow('DB connection error');

        expect(mockGroupExtractionService.extract).not.toHaveBeenCalled();
        expect(mockUnifiedExtractionService.extract).not.toHaveBeenCalled();
      });

      it('should route to private chat when chat_type is private', async () => {
        mockInteractionService.findOne.mockResolvedValue({
          id: 'interaction-123',
          sourceMetadata: { chat_type: 'private' },
          participants: [],
        });

        const job = createMockJob(baseJobData);
        await processor.process(job);

        expect(mockGroupExtractionService.extract).not.toHaveBeenCalled();
        expect(mockUnifiedExtractionService.extract).toHaveBeenCalled();
      });

      it('should route to private chat when sourceMetadata is missing', async () => {
        mockInteractionService.findOne.mockResolvedValue({
          id: 'interaction-123',
          sourceMetadata: null,
          participants: [],
        });

        const job = createMockJob(baseJobData);
        await processor.process(job);

        expect(mockGroupExtractionService.extract).not.toHaveBeenCalled();
        expect(mockUnifiedExtractionService.extract).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should throw error when entity is not found', async () => {
        mockEntityService.findOne.mockRejectedValue(new Error('Entity not found'));

        const job = createMockJob(baseJobData);

        await expect(processor.process(job)).rejects.toThrow('Entity not found');
      });

      it('should throw error when unified extraction fails', async () => {
        mockUnifiedExtractionService.extract.mockRejectedValue(
          new Error('LLM service unavailable'),
        );

        const job = createMockJob(baseJobData);

        await expect(processor.process(job)).rejects.toThrow('LLM service unavailable');
      });
    });
  });
});
