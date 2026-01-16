import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
} from '@pkg/entities';
import { SecondBrainExtractionService } from './second-brain-extraction.service';

// Mock ClaudeAgentService to avoid ESM import issues
const mockClaudeAgentService = {
  call: jest.fn(),
};

jest.mock('../claude-agent/claude-agent.service', () => ({
  ClaudeAgentService: jest.fn().mockImplementation(() => mockClaudeAgentService),
}));

// Import after mock
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

describe('SecondBrainExtractionService', () => {
  let service: SecondBrainExtractionService;
  let extractedEventRepo: jest.Mocked<Repository<ExtractedEvent>>;

  const mockExtractedEvent: Partial<ExtractedEvent> = {
    id: 'test-event-id',
    sourceMessageId: 'msg-123',
    eventType: ExtractedEventType.MEETING,
    extractedData: { datetime: '2025-01-20T15:00:00Z', topic: 'Созвон по проекту' },
    confidence: 0.85,
    status: ExtractedEventStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    // Reset mock before each test
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecondBrainExtractionService,
        {
          provide: getRepositoryToken(ExtractedEvent),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
            findOneOrFail: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: ClaudeAgentService,
          useValue: mockClaudeAgentService,
        },
      ],
    }).compile();

    service = module.get<SecondBrainExtractionService>(SecondBrainExtractionService);
    extractedEventRepo = module.get(getRepositoryToken(ExtractedEvent));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('extractFromMessage', () => {
    it('should skip very short messages', async () => {
      const result = await service.extractFromMessage({
        messageId: 'msg-1',
        messageContent: 'Привет',
        entityName: 'Иван',
        isOutgoing: false,
      });

      expect(result.extractedEvents).toHaveLength(0);
      expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
    });

    it('should extract meeting event from message', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          events: [
            {
              type: 'meeting',
              confidence: 0.85,
              sourceQuote: 'созвонимся завтра в 15:00',
              data: {
                datetime: '2025-01-20T15:00:00Z',
                dateText: 'завтра в 15:00',
                topic: 'Обсуждение проекта',
              },
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
        run: { id: 'run-1' } as any,
      });

      extractedEventRepo.create.mockReturnValue(mockExtractedEvent as ExtractedEvent);
      extractedEventRepo.save.mockResolvedValue(mockExtractedEvent as ExtractedEvent);

      const result = await service.extractFromMessage({
        messageId: 'msg-123',
        messageContent: 'Привет! Давай созвонимся завтра в 15:00, обсудим проект.',
        entityName: 'Пётр Иванов',
        isOutgoing: false,
      });

      expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'oneshot',
          taskType: 'event_extraction',
          model: 'haiku',
        }),
      );
      expect(extractedEventRepo.create).toHaveBeenCalled();
      expect(extractedEventRepo.save).toHaveBeenCalled();
      expect(result.extractedEvents).toHaveLength(1);
      expect(result.tokensUsed).toBe(150);
    });

    it('should extract promise_by_me when user promises something', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          events: [
            {
              type: 'promise_by_me',
              confidence: 0.9,
              sourceQuote: 'я пришлю документы до пятницы',
              data: {
                what: 'Прислать документы',
                deadlineText: 'до пятницы',
              },
            },
          ],
        },
        usage: { inputTokens: 80, outputTokens: 40, totalCostUsd: 0.0008 },
        run: { id: 'run-2' } as any,
      });

      const promiseEvent = {
        ...mockExtractedEvent,
        eventType: ExtractedEventType.PROMISE_BY_ME,
        extractedData: { what: 'Прислать документы', deadlineText: 'до пятницы' },
      };
      extractedEventRepo.create.mockReturnValue(promiseEvent as ExtractedEvent);
      extractedEventRepo.save.mockResolvedValue(promiseEvent as ExtractedEvent);

      const result = await service.extractFromMessage({
        messageId: 'msg-124',
        messageContent: 'Хорошо, я пришлю документы до пятницы.',
        entityName: 'Мария',
        isOutgoing: true,
      });

      expect(result.extractedEvents).toHaveLength(1);
      expect(result.extractedEvents[0].eventType).toBe(ExtractedEventType.PROMISE_BY_ME);
    });

    it('should filter out low confidence events', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          events: [
            {
              type: 'meeting',
              confidence: 0.3, // Below threshold
              data: { topic: 'Maybe meeting' },
            },
            {
              type: 'task',
              confidence: 0.7, // Above threshold
              data: { what: 'Review code' },
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 60, totalCostUsd: 0.001 },
        run: { id: 'run-3' } as any,
      });

      const taskEvent = {
        ...mockExtractedEvent,
        eventType: ExtractedEventType.TASK,
        extractedData: { what: 'Review code' },
      };
      extractedEventRepo.create.mockReturnValue(taskEvent as ExtractedEvent);
      extractedEventRepo.save.mockResolvedValue(taskEvent as ExtractedEvent);

      const result = await service.extractFromMessage({
        messageId: 'msg-125',
        messageContent: 'Может созвонимся когда-нибудь? И посмотри код обязательно.',
        entityName: 'Алексей',
        isOutgoing: false,
      });

      // Only task event should be saved (confidence 0.7 >= 0.5)
      expect(extractedEventRepo.save).toHaveBeenCalledTimes(1);
      expect(result.extractedEvents).toHaveLength(1);
    });

    it('should handle extraction errors gracefully', async () => {
      mockClaudeAgentService.call.mockRejectedValue(new Error('LLM timeout'));

      const result = await service.extractFromMessage({
        messageId: 'msg-126',
        messageContent: 'Some message that will fail to process',
        entityName: 'Test User',
        isOutgoing: false,
      });

      expect(result.extractedEvents).toHaveLength(0);
      expect(result.tokensUsed).toBe(0);
    });
  });

  describe('getPendingEvents', () => {
    it('should return pending events ordered by creation date', async () => {
      const pendingEvents = [mockExtractedEvent as ExtractedEvent];
      extractedEventRepo.find.mockResolvedValue(pendingEvents);

      const result = await service.getPendingEvents(10);

      expect(extractedEventRepo.find).toHaveBeenCalledWith({
        where: { status: ExtractedEventStatus.PENDING },
        order: { createdAt: 'DESC' },
        take: 10,
        relations: ['sourceMessage'],
      });
      expect(result).toEqual(pendingEvents);
    });
  });

  describe('confirmEvent', () => {
    it('should update event status to confirmed', async () => {
      const confirmedEvent = {
        ...mockExtractedEvent,
        status: ExtractedEventStatus.CONFIRMED,
        resultEntityType: 'EntityEvent' as const,
        resultEntityId: 'entity-event-123',
      };
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);
      extractedEventRepo.findOneOrFail.mockResolvedValue(confirmedEvent as ExtractedEvent);

      const result = await service.confirmEvent(
        'test-event-id',
        'EntityEvent',
        'entity-event-123',
      );

      expect(extractedEventRepo.update).toHaveBeenCalledWith('test-event-id', {
        status: ExtractedEventStatus.CONFIRMED,
        resultEntityType: 'EntityEvent',
        resultEntityId: 'entity-event-123',
        userResponseAt: expect.any(Date),
      });
      expect(result.status).toBe(ExtractedEventStatus.CONFIRMED);
    });
  });

  describe('rejectEvent', () => {
    it('should update event status to rejected', async () => {
      const rejectedEvent = {
        ...mockExtractedEvent,
        status: ExtractedEventStatus.REJECTED,
      };
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);
      extractedEventRepo.findOneOrFail.mockResolvedValue(rejectedEvent as ExtractedEvent);

      const result = await service.rejectEvent('test-event-id');

      expect(extractedEventRepo.update).toHaveBeenCalledWith('test-event-id', {
        status: ExtractedEventStatus.REJECTED,
        userResponseAt: expect.any(Date),
      });
      expect(result.status).toBe(ExtractedEventStatus.REJECTED);
    });
  });

  describe('markAsNotified', () => {
    it('should set notificationSentAt timestamp', async () => {
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      await service.markAsNotified('test-event-id');

      expect(extractedEventRepo.update).toHaveBeenCalledWith('test-event-id', {
        notificationSentAt: expect.any(Date),
      });
    });
  });

  describe('expireOldEvents', () => {
    it('should expire events older than specified days', async () => {
      const mockQueryBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 5 }),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const result = await service.expireOldEvents(7);

      expect(result).toBe(5);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        status: ExtractedEventStatus.EXPIRED,
      });
    });
  });
});
