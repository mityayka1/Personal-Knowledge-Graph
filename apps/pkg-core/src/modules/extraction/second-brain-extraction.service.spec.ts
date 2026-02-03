import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
} from '@pkg/entities';
import { SecondBrainExtractionService } from './second-brain-extraction.service';
import { DraftExtractionService } from './draft-extraction.service';

// Mock ClaudeAgentService to avoid ESM import issues
const mockClaudeAgentService = {
  call: jest.fn(),
};

// Mock DraftExtractionService
const mockDraftExtractionService = {
  createDrafts: jest.fn(),
};

jest.mock('../claude-agent/claude-agent.service', () => ({
  ClaudeAgentService: jest.fn().mockImplementation(() => mockClaudeAgentService),
}));

// Import after mock
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';
import { ConversationGrouperService } from './conversation-grouper.service';
import { CrossChatContextService } from './cross-chat-context.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { ConversationGroup, MessageData } from './extraction.types';

describe('SecondBrainExtractionService', () => {
  let service: SecondBrainExtractionService;
  let extractedEventRepo: jest.Mocked<Repository<ExtractedEvent>>;
  let draftExtractionService: jest.Mocked<DraftExtractionService>;
  let conversationGrouperService: jest.Mocked<ConversationGrouperService>;
  let crossChatContextService: jest.Mocked<CrossChatContextService>;
  let entityFactService: jest.Mocked<EntityFactService>;

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
        {
          provide: SettingsService,
          useValue: {
            getExtractionSettings: jest.fn().mockResolvedValue({
              autoSaveThreshold: 0.95,
              minConfidence: 0.6,
              model: 'haiku',
              minMessageLength: 20,
              maxQuoteLength: 500,
              maxContentLength: 1000,
            }),
            getNotificationSettings: jest.fn().mockResolvedValue({
              highConfidenceThreshold: 0.9,
              urgentMeetingHoursWindow: 24,
              expirationDays: 7,
            }),
          },
        },
        {
          provide: ConversationGrouperService,
          useValue: {
            formatConversationForPrompt: jest.fn().mockReturnValue(
              '[14:00] Собеседник: Привет!\n[14:01] Я: Привет, как дела?',
            ),
          },
        },
        {
          provide: CrossChatContextService,
          useValue: {
            getContext: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: EntityFactService,
          useValue: {
            getContextForExtraction: jest.fn().mockResolvedValue(''),
          },
        },
        {
          provide: DraftExtractionService,
          useValue: mockDraftExtractionService,
        },
      ],
    }).compile();

    service = module.get<SecondBrainExtractionService>(SecondBrainExtractionService);
    extractedEventRepo = module.get(getRepositoryToken(ExtractedEvent));
    draftExtractionService = module.get(DraftExtractionService);
    conversationGrouperService = module.get(ConversationGrouperService);
    crossChatContextService = module.get(CrossChatContextService);
    entityFactService = module.get(EntityFactService);
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

  describe('extractFromConversation', () => {
    const mockConversation: ConversationGroup = {
      messages: [
        {
          id: 'msg-1',
          content: 'Привет! Созвонимся завтра в 15:00?',
          timestamp: '2025-01-25T14:00:00.000Z',
          isOutgoing: false,
          senderEntityId: 'entity-1',
          senderEntityName: 'Пётр',
        },
        {
          id: 'msg-2',
          content: 'Да, давай! Я подготовлю документы.',
          timestamp: '2025-01-25T14:01:00.000Z',
          isOutgoing: true,
        },
      ],
      startedAt: new Date('2025-01-25T14:00:00.000Z'),
      endedAt: new Date('2025-01-25T14:01:00.000Z'),
      participantEntityIds: ['entity-1'],
    };

    it('should extract events from conversation', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          events: [
            {
              type: 'meeting',
              confidence: 0.85,
              sourceQuote: 'Созвонимся завтра в 15:00',
              data: {
                datetime: '2025-01-26T15:00:00Z',
                dateText: 'завтра в 15:00',
              },
            },
            {
              type: 'promise_by_me',
              confidence: 0.9,
              sourceQuote: 'Я подготовлю документы',
              data: {
                what: 'Подготовить документы',
              },
            },
          ],
        },
        usage: { inputTokens: 200, outputTokens: 100, totalCostUsd: 0.002 },
        run: { id: 'run-conv-1' } as any,
      });

      // Mock DraftExtractionService.createDrafts
      mockDraftExtractionService.createDrafts.mockResolvedValue({
        batchId: 'batch-123',
        counts: { facts: 0, tasks: 0, commitments: 2, projects: 0 },
        skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        approvals: [],
        errors: [],
      });

      const result = await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      expect(conversationGrouperService.formatConversationForPrompt).toHaveBeenCalledWith(
        mockConversation,
        { includeTimestamps: true, maxLength: 6000 },
      );
      expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'oneshot',
          taskType: 'event_extraction',
          model: 'haiku',
          timeout: 90000,
        }),
      );
      expect(result.sourceMessageIds).toEqual(['msg-1', 'msg-2']);
      expect(result.extractedCount).toBe(2);
      expect(result.counts.commitments).toBe(2);
      expect(result.tokensUsed).toBe(300);
    });

    it('should filter low confidence events', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          events: [
            {
              type: 'meeting',
              confidence: 0.3, // Below threshold 0.6
              data: { topic: 'maybe meeting' },
            },
            {
              type: 'task',
              confidence: 0.8, // Above threshold
              data: { what: 'Review code' },
            },
          ],
        },
        usage: { inputTokens: 150, outputTokens: 80, totalCostUsd: 0.0015 },
        run: { id: 'run-conv-2' } as any,
      });

      // Mock DraftExtractionService.createDrafts
      mockDraftExtractionService.createDrafts.mockResolvedValue({
        batchId: 'batch-456',
        counts: { facts: 0, tasks: 1, commitments: 0, projects: 0 },
        skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        approvals: [],
        errors: [],
      });

      const result = await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      // Only task event should be extracted (confidence 0.8 >= 0.6)
      // Low confidence meeting (0.3) should be filtered out before createDrafts
      expect(mockDraftExtractionService.createDrafts).toHaveBeenCalledWith(
        expect.objectContaining({
          tasks: expect.arrayContaining([
            expect.objectContaining({ title: 'Review code' }),
          ]),
        }),
      );
      expect(result.extractedCount).toBe(1);
    });

    it('should handle fact extraction', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          events: [
            {
              type: 'fact',
              confidence: 0.9,
              sourceQuote: 'У меня ДР 10 августа',
              data: {
                factType: 'birthday',
                value: '10 августа',
                quote: 'У меня ДР 10 августа',
              },
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
        run: { id: 'run-conv-3' } as any,
      });

      // Mock DraftExtractionService.createDrafts
      mockDraftExtractionService.createDrafts.mockResolvedValue({
        batchId: 'batch-789',
        counts: { facts: 1, tasks: 0, commitments: 0, projects: 0 },
        skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        approvals: [],
        errors: [],
      });

      const result = await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      // Check that createDrafts was called with facts array
      expect(mockDraftExtractionService.createDrafts).toHaveBeenCalledWith(
        expect.objectContaining({
          facts: expect.arrayContaining([
            expect.objectContaining({
              factType: 'birthday',
              value: '10 августа',
            }),
          ]),
        }),
      );
      expect(result.extractedCount).toBe(1);
      expect(result.counts.facts).toBe(1);
    });

    it('should include entity context in prompt', async () => {
      entityFactService.getContextForExtraction.mockResolvedValue(
        'Должность: менеджер\nКомпания: Acme Corp',
      );

      mockClaudeAgentService.call.mockResolvedValue({
        data: { events: [] },
        usage: { inputTokens: 100, outputTokens: 20, totalCostUsd: 0.0005 },
        run: { id: 'run-conv-4' } as any,
      });

      // Mock DraftExtractionService.createDrafts
      mockDraftExtractionService.createDrafts.mockResolvedValue({
        batchId: 'batch-empty',
        counts: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        approvals: [],
        errors: [],
      });

      await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      expect(entityFactService.getContextForExtraction).toHaveBeenCalledWith('entity-1');
      expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('ИЗВЕСТНЫЕ ФАКТЫ О СОБЕСЕДНИКЕ'),
        }),
      );
    });

    it('should include cross-chat context when available', async () => {
      crossChatContextService.getContext.mockResolvedValue(
        '[13:50] Личный чат | Собеседник: Встретимся в 15:00 в офисе',
      );

      mockClaudeAgentService.call.mockResolvedValue({
        data: { events: [] },
        usage: { inputTokens: 150, outputTokens: 30, totalCostUsd: 0.0008 },
        run: { id: 'run-conv-5' } as any,
      });

      // Mock DraftExtractionService.createDrafts
      mockDraftExtractionService.createDrafts.mockResolvedValue({
        batchId: 'batch-empty',
        counts: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        approvals: [],
        errors: [],
      });

      await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      expect(crossChatContextService.getContext).toHaveBeenCalledWith(
        'interaction-1',
        ['entity-1'],
        mockConversation.endedAt,
      );
      expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('СВЯЗАННЫЙ КОНТЕКСТ'),
        }),
      );
    });

    it('should handle extraction errors gracefully', async () => {
      mockClaudeAgentService.call.mockRejectedValue(new Error('LLM timeout'));

      const result = await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      expect(result.extractedCount).toBe(0);
      expect(result.tokensUsed).toBe(0);
      expect(result.sourceMessageIds).toEqual(['msg-1', 'msg-2']);
    });

    it('should handle failed entity context retrieval gracefully', async () => {
      entityFactService.getContextForExtraction.mockRejectedValue(
        new Error('Entity not found'),
      );

      mockClaudeAgentService.call.mockResolvedValue({
        data: { events: [] },
        usage: { inputTokens: 100, outputTokens: 20, totalCostUsd: 0.0005 },
        run: { id: 'run-conv-6' } as any,
      });

      // Mock DraftExtractionService.createDrafts
      mockDraftExtractionService.createDrafts.mockResolvedValue({
        batchId: 'batch-empty',
        counts: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        approvals: [],
        errors: [],
      });

      // Should not throw
      const result = await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      expect(result.extractedCount).toBe(0);
      expect(mockClaudeAgentService.call).toHaveBeenCalled();
    });

    it('should handle failed cross-chat context retrieval gracefully', async () => {
      crossChatContextService.getContext.mockRejectedValue(
        new Error('Database error'),
      );

      mockClaudeAgentService.call.mockResolvedValue({
        data: { events: [] },
        usage: { inputTokens: 100, outputTokens: 20, totalCostUsd: 0.0005 },
        run: { id: 'run-conv-7' } as any,
      });

      // Mock DraftExtractionService.createDrafts
      mockDraftExtractionService.createDrafts.mockResolvedValue({
        batchId: 'batch-empty',
        counts: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        approvals: [],
        errors: [],
      });

      // Should not throw
      const result = await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      expect(result.extractedCount).toBe(0);
      expect(mockClaudeAgentService.call).toHaveBeenCalled();
    });

    it('should pass sourceInteractionId to createDrafts', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          events: [
            {
              type: 'task',
              confidence: 0.85,
              data: { what: 'Test task' },
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
        run: { id: 'run-conv-8' } as any,
      });

      // Mock DraftExtractionService.createDrafts
      mockDraftExtractionService.createDrafts.mockResolvedValue({
        batchId: 'batch-task',
        counts: { facts: 0, tasks: 1, commitments: 0, projects: 0 },
        skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
        approvals: [],
        errors: [],
      });

      await service.extractFromConversation(
        mockConversation,
        'entity-1',
        'interaction-1',
        'owner-123',
      );

      expect(mockDraftExtractionService.createDrafts).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceInteractionId: 'interaction-1',
          ownerEntityId: 'owner-123',
        }),
      );
    });
  });
});
