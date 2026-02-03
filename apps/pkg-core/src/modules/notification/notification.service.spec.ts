import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
  EntityRecord,
  EntityIdentifier,
  Message,
  Interaction,
} from '@pkg/entities';
import { NotificationService } from './notification.service';
import { TelegramNotifierService } from './telegram-notifier.service';
import { SettingsService } from '../settings/settings.service';
import { DigestActionStoreService } from './digest-action-store.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let extractedEventRepo: jest.Mocked<Repository<ExtractedEvent>>;
  let entityRepo: jest.Mocked<Repository<EntityRecord>>;
  let identifierRepo: jest.Mocked<Repository<EntityIdentifier>>;
  let messageRepo: jest.Mocked<Repository<Message>>;
  let interactionRepo: jest.Mocked<Repository<Interaction>>;
  let telegramNotifier: jest.Mocked<TelegramNotifierService>;
  let settingsService: jest.Mocked<SettingsService>;
  let digestActionStore: jest.Mocked<DigestActionStoreService>;

  const mockSettings = {
    highConfidenceThreshold: 0.9,
    urgentMeetingHoursWindow: 24,
  };

  const createMockEvent = (
    overrides: Partial<ExtractedEvent> = {},
  ): ExtractedEvent => ({
    id: 'event-123',
    sourceMessageId: 'msg-456',
    sourceInteractionId: null,
    eventType: ExtractedEventType.TASK,
    extractedData: { what: 'Test task' },
    confidence: 0.85,
    status: ExtractedEventStatus.PENDING,
    notificationSentAt: null,
    userResponseAt: null,
    resultEntityType: null,
    resultEntityId: null,
    needsContext: false,
    linkedEventId: null,
    enrichmentData: null,
    sourceQuote: null,
    entityId: null,
    promiseToEntityId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sourceMessage: null as any,
    sourceInteraction: null,
    linkedEvent: null as any,
    ...overrides,
  });

  beforeEach(async () => {
    const mockQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
      // For SELECT queries (getPendingEventsForDigest)
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        {
          provide: getRepositoryToken(ExtractedEvent),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(EntityIdentifier),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Message),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Interaction),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: TelegramNotifierService,
          useValue: {
            sendWithButtons: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: SettingsService,
          useValue: {
            getNotificationSettings: jest.fn().mockResolvedValue(mockSettings),
          },
        },
        {
          provide: DigestActionStoreService,
          useValue: {
            store: jest.fn().mockResolvedValue('short-id-123'),
          },
        },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
    extractedEventRepo = module.get(getRepositoryToken(ExtractedEvent));
    entityRepo = module.get(getRepositoryToken(EntityRecord));
    identifierRepo = module.get(getRepositoryToken(EntityIdentifier));
    messageRepo = module.get(getRepositoryToken(Message));
    interactionRepo = module.get(getRepositoryToken(Interaction));
    telegramNotifier = module.get(TelegramNotifierService);
    settingsService = module.get(SettingsService);
    digestActionStore = module.get(DigestActionStoreService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('calculatePriority', () => {
    it('should return high for cancellation events', async () => {
      const event = createMockEvent({
        eventType: ExtractedEventType.CANCELLATION,
      });

      const priority = await service.calculatePriority(event, mockSettings);

      expect(priority).toBe('high');
    });

    it('should return high for meetings within window with high confidence', async () => {
      const meetingDate = new Date();
      meetingDate.setHours(meetingDate.getHours() + 12); // 12 hours from now

      const event = createMockEvent({
        eventType: ExtractedEventType.MEETING,
        confidence: 0.95,
        extractedData: {
          topic: 'Project meeting',
          datetime: meetingDate.toISOString(),
        },
      });

      const priority = await service.calculatePriority(event, mockSettings);

      expect(priority).toBe('high');
    });

    it('should return medium for task events', async () => {
      const event = createMockEvent({
        eventType: ExtractedEventType.TASK,
      });

      const priority = await service.calculatePriority(event, mockSettings);

      expect(priority).toBe('medium');
    });

    it('should return medium for promises with deadlines', async () => {
      const event = createMockEvent({
        eventType: ExtractedEventType.PROMISE_BY_ME,
        extractedData: {
          what: 'Send report',
          deadline: new Date().toISOString(),
        },
      });

      const priority = await service.calculatePriority(event, mockSettings);

      expect(priority).toBe('medium');
    });

    it('should return low for facts', async () => {
      const event = createMockEvent({
        eventType: ExtractedEventType.FACT,
        extractedData: {
          factType: 'birthday',
          value: 'March 15',
        },
      });

      const priority = await service.calculatePriority(event, mockSettings);

      expect(priority).toBe('low');
    });

    it('should return low for promises without deadlines', async () => {
      const event = createMockEvent({
        eventType: ExtractedEventType.PROMISE_BY_THEM,
        extractedData: {
          what: 'Will call back',
          // No deadline
        },
      });

      const priority = await service.calculatePriority(event, mockSettings);

      expect(priority).toBe('low');
    });
  });

  describe('notifyAboutEvent', () => {
    it('should send notification and mark event as notified', async () => {
      const event = createMockEvent();

      const result = await service.notifyAboutEvent(event);

      expect(result).toBe(true);
      expect(telegramNotifier.sendWithButtons).toHaveBeenCalled();
      expect(extractedEventRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('should not mark as notified if telegram fails', async () => {
      const event = createMockEvent();
      telegramNotifier.sendWithButtons.mockResolvedValueOnce(false);

      const result = await service.notifyAboutEvent(event);

      expect(result).toBe(false);
      // Should not try to update
      expect(extractedEventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('processHighPriorityEvents', () => {
    it('should process and notify high priority events', async () => {
      const highPriorityEvent = createMockEvent({
        eventType: ExtractedEventType.CANCELLATION,
      });

      extractedEventRepo.find.mockResolvedValue([highPriorityEvent]);

      const count = await service.processHighPriorityEvents();

      expect(count).toBe(1);
      expect(telegramNotifier.sendWithButtons).toHaveBeenCalledTimes(1);
    });

    it('should skip medium/low priority events', async () => {
      const lowPriorityEvent = createMockEvent({
        eventType: ExtractedEventType.FACT,
        extractedData: { factType: 'birthday', value: 'March 15' },
      });

      extractedEventRepo.find.mockResolvedValue([lowPriorityEvent]);

      const count = await service.processHighPriorityEvents();

      expect(count).toBe(0);
      expect(telegramNotifier.sendWithButtons).not.toHaveBeenCalled();
    });

    it('should handle empty pending list', async () => {
      extractedEventRepo.find.mockResolvedValue([]);

      const count = await service.processHighPriorityEvents();

      expect(count).toBe(0);
    });
  });

  describe('markEventsAsNotified', () => {
    it('should mark multiple events as notified', async () => {
      const mockQueryBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3 }),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const eventIds = ['event-1', 'event-2', 'event-3'];
      const count = await service.markEventsAsNotified(eventIds);

      expect(count).toBe(3);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('id IN (:...ids)', {
        ids: eventIds,
      });
    });

    it('should return 0 for empty array', async () => {
      const count = await service.markEventsAsNotified([]);

      expect(count).toBe(0);
      expect(extractedEventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should return actual affected count (handles race conditions)', async () => {
      const mockQueryBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 2 }), // Only 2 were not already notified
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const eventIds = ['event-1', 'event-2', 'event-3'];
      const count = await service.markEventsAsNotified(eventIds);

      expect(count).toBe(2);
    });
  });

  describe('expireOldPendingEvents', () => {
    it('should expire events older than specified days', async () => {
      const mockQueryBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 5 }),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const count = await service.expireOldPendingEvents(7);

      expect(count).toBe(5);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        status: ExtractedEventStatus.EXPIRED,
      });
    });

    it('should use default 7 days if not specified', async () => {
      const mockQueryBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      await service.expireOldPendingEvents();

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'createdAt < :cutoff',
        expect.any(Object),
      );
    });
  });

  describe('sendNotificationForEvent', () => {
    it('should send notification for event that has not been notified', async () => {
      const event = createMockEvent();
      extractedEventRepo.findOne.mockResolvedValue(event);

      await service.sendNotificationForEvent('event-123');

      expect(telegramNotifier.sendWithButtons).toHaveBeenCalled();
    });

    it('should skip if event not found', async () => {
      extractedEventRepo.findOne.mockResolvedValue(null);

      await service.sendNotificationForEvent('non-existent');

      expect(telegramNotifier.sendWithButtons).not.toHaveBeenCalled();
    });

    it('should skip if event already notified (query returns null)', async () => {
      // findOne returns null because WHERE includes notificationSentAt IS NULL
      extractedEventRepo.findOne.mockResolvedValue(null);

      await service.sendNotificationForEvent('already-notified-event');

      expect(telegramNotifier.sendWithButtons).not.toHaveBeenCalled();
    });
  });

  describe('sendDigestForEvents', () => {
    it('should send digest for non-notified events', async () => {
      const events = [createMockEvent(), createMockEvent({ id: 'event-456' })];
      extractedEventRepo.find.mockResolvedValue(events);

      await service.sendDigestForEvents(['event-123', 'event-456'], 'hourly');

      expect(telegramNotifier.sendWithButtons).toHaveBeenCalled();
      expect(extractedEventRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('should skip if all events already notified', async () => {
      extractedEventRepo.find.mockResolvedValue([]);

      await service.sendDigestForEvents(['event-123'], 'hourly');

      expect(telegramNotifier.sendWithButtons).not.toHaveBeenCalled();
    });

    it('should skip if event list is empty', async () => {
      await service.sendDigestForEvents([], 'daily');

      expect(telegramNotifier.sendWithButtons).not.toHaveBeenCalled();
      expect(extractedEventRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('getPendingEventsForDigest', () => {
    it('should filter events by priority', async () => {
      const taskEvent = createMockEvent({
        id: 'task-1',
        eventType: ExtractedEventType.TASK,
      });
      const factEvent = createMockEvent({
        id: 'fact-1',
        eventType: ExtractedEventType.FACT,
        extractedData: { factType: 'test', value: 'test' },
      });

      // Mock query builder chain for getPendingEventsForDigest
      const mockQb = {
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([taskEvent, factEvent]),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(mockQb as any);

      const mediumEvents = await service.getPendingEventsForDigest('medium', 10);

      // Only task should be returned (medium priority)
      expect(mediumEvents).toHaveLength(1);
      expect(mediumEvents[0].id).toBe('task-1');
    });

    it('should respect limit parameter', async () => {
      const events = Array.from({ length: 10 }, (_, i) =>
        createMockEvent({
          id: `task-${i}`,
          eventType: ExtractedEventType.TASK,
        }),
      );

      // Mock query builder chain for getPendingEventsForDigest
      const mockQb = {
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(events),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(mockQb as any);

      const result = await service.getPendingEventsForDigest('medium', 3);

      expect(result).toHaveLength(3);
    });

    it('should exclude events from bot entities', async () => {
      // This test verifies that the query includes the bot filter condition
      const mockQb = {
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(mockQb as any);

      await service.getPendingEventsForDigest('low', 10);

      // Verify the query includes bot filter using NOT EXISTS subquery
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        `NOT EXISTS (
          SELECT 1 FROM entities e
          WHERE e.id = event.entity_id AND e.is_bot = true
        )`,
      );
    });
  });

});
