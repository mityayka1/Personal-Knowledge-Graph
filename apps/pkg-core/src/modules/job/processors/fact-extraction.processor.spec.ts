import { Test, TestingModule } from '@nestjs/testing';
import { Job as BullJob } from 'bullmq';
import { FactExtractionProcessor } from './fact-extraction.processor';
import { FactExtractionService } from '../../extraction/fact-extraction.service';
import { EventExtractionService } from '../../extraction/event-extraction.service';
import { SecondBrainExtractionService } from '../../extraction/second-brain-extraction.service';
import { PromiseRecipientService } from '../../extraction/promise-recipient.service';
import { EntityService } from '../../entity/entity.service';
import { ExtractionJobData } from '../job.service';

describe('FactExtractionProcessor', () => {
  let processor: FactExtractionProcessor;
  let factExtractionService: jest.Mocked<FactExtractionService>;
  let eventExtractionService: jest.Mocked<EventExtractionService>;
  let secondBrainExtractionService: jest.Mocked<SecondBrainExtractionService>;
  let promiseRecipientService: jest.Mocked<PromiseRecipientService>;
  let entityService: jest.Mocked<EntityService>;

  const mockFactExtractionService = {
    extractFactsBatch: jest.fn(),
  };

  const mockEventExtractionService = {
    extractEventsBatch: jest.fn(),
  };

  const mockSecondBrainExtractionService = {
    extractFromMessages: jest.fn(),
  };

  const mockPromiseRecipientService = {
    loadReplyToInfo: jest.fn(),
    resolveRecipient: jest.fn(),
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
          provide: FactExtractionService,
          useValue: mockFactExtractionService,
        },
        {
          provide: EventExtractionService,
          useValue: mockEventExtractionService,
        },
        {
          provide: SecondBrainExtractionService,
          useValue: mockSecondBrainExtractionService,
        },
        {
          provide: PromiseRecipientService,
          useValue: mockPromiseRecipientService,
        },
        {
          provide: EntityService,
          useValue: mockEntityService,
        },
      ],
    }).compile();

    processor = module.get<FactExtractionProcessor>(FactExtractionProcessor);
    factExtractionService = module.get(FactExtractionService);
    eventExtractionService = module.get(EventExtractionService);
    secondBrainExtractionService = module.get(SecondBrainExtractionService);
    promiseRecipientService = module.get(PromiseRecipientService);
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
      mockFactExtractionService.extractFactsBatch.mockResolvedValue({ facts: [] });
      mockEventExtractionService.extractEventsBatch.mockResolvedValue({ events: [] });
      mockPromiseRecipientService.loadReplyToInfo.mockResolvedValue(new Map());
      mockPromiseRecipientService.resolveRecipient.mockResolvedValue(null);
      mockSecondBrainExtractionService.extractFromMessages.mockResolvedValue([
        { extractedEvents: [] },
      ]);
    });

    it('should process extraction job successfully', async () => {
      const job = createMockJob(baseJobData);

      const result = await processor.process(job);

      expect(result).toEqual({
        success: true,
        factsExtracted: 0,
        eventsExtracted: 0,
        pendingEventsExtracted: 0,
      });

      expect(mockEntityService.findOne).toHaveBeenCalledWith('entity-456');
      expect(mockFactExtractionService.extractFactsBatch).toHaveBeenCalled();
      expect(mockEventExtractionService.extractEventsBatch).toHaveBeenCalled();
      expect(mockSecondBrainExtractionService.extractFromMessages).toHaveBeenCalled();
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
          factsExtracted: 0,
          eventsExtracted: 0,
          pendingEventsExtracted: 0,
          skipped: 'bot',
        });

        // Extraction services should NOT be called for bots
        expect(mockFactExtractionService.extractFactsBatch).not.toHaveBeenCalled();
        expect(mockEventExtractionService.extractEventsBatch).not.toHaveBeenCalled();
        expect(mockSecondBrainExtractionService.extractFromMessages).not.toHaveBeenCalled();
      });

      it('should process extraction for non-bot entities', async () => {
        mockEntityService.findOne.mockResolvedValue({
          id: 'entity-456',
          name: 'Human User',
          isBot: false,
        });

        const job = createMockJob(baseJobData);

        await processor.process(job);

        expect(mockFactExtractionService.extractFactsBatch).toHaveBeenCalled();
        expect(mockEventExtractionService.extractEventsBatch).toHaveBeenCalled();
        expect(mockSecondBrainExtractionService.extractFromMessages).toHaveBeenCalled();
      });
    });

    describe('sender attribution in group chats', () => {
      it('should use message-level senderEntityId when available', async () => {
        const jobData: ExtractionJobData = {
          interactionId: 'group-chat-123',
          entityId: 'first-sender', // Job-level entityId (deprecated)
          messageIds: ['msg-1'],
          messages: [
            {
              id: 'msg-1',
              content: 'Message from specific sender',
              timestamp: '2026-01-20T10:00:00Z',
              isOutgoing: false,
              senderEntityId: 'actual-sender-entity',
              senderEntityName: 'Лёха Перформанс',
            },
          ],
        };

        mockEntityService.findOne.mockResolvedValue({
          id: 'first-sender',
          name: 'First Sender Name',
          isBot: false,
        });

        const job = createMockJob(jobData);

        await processor.process(job);

        // Check that secondBrainExtractionService receives message-level entityId
        expect(mockSecondBrainExtractionService.extractFromMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              entityId: 'actual-sender-entity',
              entityName: 'Лёха Перформанс',
            }),
          ]),
        );
      });

      it('should fallback to job-level entityId when senderEntityId is not provided', async () => {
        const jobData: ExtractionJobData = {
          interactionId: 'private-chat-123',
          entityId: 'job-level-entity',
          messageIds: ['msg-1'],
          messages: [
            {
              id: 'msg-1',
              content: 'Message without sender info',
              timestamp: '2026-01-20T10:00:00Z',
              isOutgoing: false,
              // No senderEntityId or senderEntityName
            },
          ],
        };

        mockEntityService.findOne.mockResolvedValue({
          id: 'job-level-entity',
          name: 'Entity from DB',
          isBot: false,
        });

        const job = createMockJob(jobData);

        await processor.process(job);

        // Should fallback to job-level entityId and loaded entity name
        expect(mockSecondBrainExtractionService.extractFromMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              entityId: 'job-level-entity',
              entityName: 'Entity from DB',
            }),
          ]),
        );
      });

      it('should handle mixed senders in a batch correctly', async () => {
        const jobData: ExtractionJobData = {
          interactionId: 'group-chat-456',
          entityId: 'entity-alice', // First message sender
          messageIds: ['msg-1', 'msg-2', 'msg-3'],
          messages: [
            {
              id: 'msg-1',
              content: 'Message from Alice',
              timestamp: '2026-01-20T10:00:00Z',
              isOutgoing: false,
              senderEntityId: 'entity-alice',
              senderEntityName: 'Alice',
            },
            {
              id: 'msg-2',
              content: 'Message from Bob',
              timestamp: '2026-01-20T10:01:00Z',
              isOutgoing: false,
              senderEntityId: 'entity-bob',
              senderEntityName: 'Bob',
            },
            {
              id: 'msg-3',
              content: 'Another from Alice',
              timestamp: '2026-01-20T10:02:00Z',
              isOutgoing: false,
              senderEntityId: 'entity-alice',
              senderEntityName: 'Alice',
            },
          ],
        };

        mockEntityService.findOne.mockResolvedValue({
          id: 'entity-alice',
          name: 'Alice (from DB)',
          isBot: false,
        });

        const job = createMockJob(jobData);

        await processor.process(job);

        const extractFromMessagesCall = mockSecondBrainExtractionService.extractFromMessages.mock.calls[0][0];

        // Verify each message has correct attribution
        expect(extractFromMessagesCall[0].entityId).toBe('entity-alice');
        expect(extractFromMessagesCall[0].entityName).toBe('Alice');

        expect(extractFromMessagesCall[1].entityId).toBe('entity-bob');
        expect(extractFromMessagesCall[1].entityName).toBe('Bob');

        expect(extractFromMessagesCall[2].entityId).toBe('entity-alice');
        expect(extractFromMessagesCall[2].entityName).toBe('Alice');
      });

      it('should use senderEntityId for promiseRecipient resolution', async () => {
        const jobData: ExtractionJobData = {
          interactionId: 'group-chat-789',
          entityId: 'first-entity',
          messageIds: ['msg-1'],
          messages: [
            {
              id: 'msg-1',
              content: 'Я сделаю это завтра',
              timestamp: '2026-01-20T10:00:00Z',
              isOutgoing: true,
              senderEntityId: 'my-entity',
              senderEntityName: 'Me',
            },
          ],
        };

        mockEntityService.findOne.mockResolvedValue({
          id: 'first-entity',
          name: 'First Entity',
          isBot: false,
        });

        const job = createMockJob(jobData);

        await processor.process(job);

        // Verify promiseRecipient uses message-level entityId
        expect(mockPromiseRecipientService.resolveRecipient).toHaveBeenCalledWith(
          expect.objectContaining({
            entityId: 'my-entity',
            isOutgoing: true,
          }),
        );
      });
    });

    describe('reply-to context', () => {
      it('should load reply-to info for messages with replyToSourceMessageId', async () => {
        const jobData: ExtractionJobData = {
          interactionId: 'interaction-123',
          entityId: 'entity-456',
          messageIds: ['msg-reply'],
          messages: [
            {
              id: 'msg-reply',
              content: 'This is a reply',
              timestamp: '2026-01-20T10:00:00Z',
              isOutgoing: false,
              replyToSourceMessageId: 'original-msg-id',
            },
          ],
        };

        const replyToMap = new Map([
          ['original-msg-id', { content: 'Original message', senderName: 'Sender', senderEntityId: 'sender-entity' }],
        ]);
        mockPromiseRecipientService.loadReplyToInfo.mockResolvedValue(replyToMap);

        mockEntityService.findOne.mockResolvedValue({
          id: 'entity-456',
          name: 'Test User',
          isBot: false,
        });

        const job = createMockJob(jobData);

        await processor.process(job);

        expect(mockPromiseRecipientService.loadReplyToInfo).toHaveBeenCalledWith(
          jobData.messages,
          'interaction-123',
        );

        expect(mockSecondBrainExtractionService.extractFromMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              replyToContent: 'Original message',
              replyToSenderName: 'Sender',
            }),
          ]),
        );
      });
    });

    describe('topic name handling', () => {
      it('should pass topicName to second brain extraction', async () => {
        const jobData: ExtractionJobData = {
          interactionId: 'forum-interaction',
          entityId: 'entity-456',
          messageIds: ['msg-1'],
          messages: [
            {
              id: 'msg-1',
              content: 'Message in forum topic',
              timestamp: '2026-01-20T10:00:00Z',
              isOutgoing: false,
              topicName: 'Рабочие вопросы',
            },
          ],
        };

        mockEntityService.findOne.mockResolvedValue({
          id: 'entity-456',
          name: 'Test User',
          isBot: false,
        });

        const job = createMockJob(jobData);

        await processor.process(job);

        expect(mockSecondBrainExtractionService.extractFromMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              topicName: 'Рабочие вопросы',
            }),
          ]),
        );
      });
    });

    describe('extraction results aggregation', () => {
      it('should count extracted facts, events, and pending events', async () => {
        mockFactExtractionService.extractFactsBatch.mockResolvedValue({
          facts: [{ id: 'fact-1' }, { id: 'fact-2' }],
        });

        mockEventExtractionService.extractEventsBatch.mockResolvedValue({
          events: [{ id: 'event-1' }],
        });

        mockSecondBrainExtractionService.extractFromMessages.mockResolvedValue([
          { extractedEvents: [{ id: 'pending-1' }, { id: 'pending-2' }, { id: 'pending-3' }] },
        ]);

        const job = createMockJob(baseJobData);

        const result = await processor.process(job);

        expect(result).toEqual({
          success: true,
          factsExtracted: 2,
          eventsExtracted: 1,
          pendingEventsExtracted: 3,
        });
      });

      it('should aggregate pending events from multiple messages', async () => {
        const jobData: ExtractionJobData = {
          ...baseJobData,
          messageIds: ['msg-1', 'msg-2'],
          messages: [
            { id: 'msg-1', content: 'First', timestamp: '2026-01-20T10:00:00Z', isOutgoing: false },
            { id: 'msg-2', content: 'Second', timestamp: '2026-01-20T10:01:00Z', isOutgoing: false },
          ],
        };

        mockSecondBrainExtractionService.extractFromMessages.mockResolvedValue([
          { extractedEvents: [{ id: 'e1' }, { id: 'e2' }] },
          { extractedEvents: [{ id: 'e3' }] },
        ]);

        const job = createMockJob(jobData);

        const result = await processor.process(job);

        expect(result.pendingEventsExtracted).toBe(3);
      });
    });

    describe('error handling', () => {
      it('should throw error when entity is not found', async () => {
        mockEntityService.findOne.mockRejectedValue(new Error('Entity not found'));

        const job = createMockJob(baseJobData);

        await expect(processor.process(job)).rejects.toThrow('Entity not found');
      });

      it('should throw error when extraction fails', async () => {
        mockFactExtractionService.extractFactsBatch.mockRejectedValue(
          new Error('LLM service unavailable'),
        );

        const job = createMockJob(baseJobData);

        await expect(processor.process(job)).rejects.toThrow('LLM service unavailable');
      });
    });
  });
});
