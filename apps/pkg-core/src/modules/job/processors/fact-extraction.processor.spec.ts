import { Test, TestingModule } from '@nestjs/testing';
import { Job as BullJob } from 'bullmq';
import { FactExtractionProcessor } from './fact-extraction.processor';
import { UnifiedExtractionService } from '../../extraction/unified-extraction.service';
import { EntityService } from '../../entity/entity.service';
import { ExtractionJobData } from '../job.service';

describe('FactExtractionProcessor', () => {
  let processor: FactExtractionProcessor;
  let unifiedExtractionService: jest.Mocked<UnifiedExtractionService>;
  let entityService: jest.Mocked<EntityService>;

  const mockUnifiedExtractionService = {
    extract: jest.fn(),
  };

  const mockEntityService = {
    findOne: jest.fn(),
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
          provide: EntityService,
          useValue: mockEntityService,
        },
      ],
    }).compile();

    processor = module.get<FactExtractionProcessor>(FactExtractionProcessor);
    unifiedExtractionService = module.get(UnifiedExtractionService);
    entityService = module.get(EntityService);
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
