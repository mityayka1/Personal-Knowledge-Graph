import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CarouselStateService, CarouselState } from './carousel-state.service';
import { ExtractedEvent, ExtractedEventType, ExtractedEventStatus } from '@pkg/entities';

// Mock Redis
const mockRedis = {
  setex: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
};

// Mock ioredis injection token
const IOREDIS_TOKEN = 'default_IORedisModuleConnectionToken';

describe('CarouselStateService', () => {
  let service: CarouselStateService;
  let extractedEventRepo: jest.Mocked<Repository<ExtractedEvent>>;

  const mockEvent1: ExtractedEvent = {
    id: '11111111-1111-1111-1111-111111111111',
    sourceMessageId: 'msg-1',
    sourceInteractionId: null,
    eventType: ExtractedEventType.TASK,
    extractedData: { what: 'Test task 1' },
    confidence: 0.8,
    status: ExtractedEventStatus.PENDING,
    resultEntityType: null,
    resultEntityId: null,
    notificationSentAt: null,
    userResponseAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sourceMessage: null as any,
    sourceInteraction: null as any,
    entityId: null,
    sourceQuote: null,
    linkedEventId: null,
    linkedEvent: null,
    needsContext: false,
    enrichmentData: null,
  };

  const mockEvent2: ExtractedEvent = {
    id: '22222222-2222-2222-2222-222222222222',
    sourceMessageId: 'msg-2',
    sourceInteractionId: null,
    eventType: ExtractedEventType.MEETING,
    extractedData: { topic: 'Meeting', dateText: 'tomorrow' },
    confidence: 0.9,
    status: ExtractedEventStatus.PENDING,
    resultEntityType: null,
    resultEntityId: null,
    notificationSentAt: null,
    userResponseAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sourceMessage: null as any,
    sourceInteraction: null as any,
    entityId: null,
    sourceQuote: null,
    linkedEventId: null,
    linkedEvent: null,
    needsContext: false,
    enrichmentData: null,
  };

  const mockEvent3: ExtractedEvent = {
    id: '33333333-3333-3333-3333-333333333333',
    sourceMessageId: 'msg-3',
    sourceInteractionId: null,
    eventType: ExtractedEventType.PROMISE_BY_ME,
    extractedData: { what: 'Send report' },
    confidence: 0.85,
    status: ExtractedEventStatus.PENDING,
    resultEntityType: null,
    resultEntityId: null,
    notificationSentAt: null,
    userResponseAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sourceMessage: null as any,
    sourceInteraction: null as any,
    entityId: null,
    sourceQuote: null,
    linkedEventId: null,
    linkedEvent: null,
    needsContext: false,
    enrichmentData: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarouselStateService,
        {
          provide: IOREDIS_TOKEN,
          useValue: mockRedis,
        },
        {
          provide: getRepositoryToken(ExtractedEvent),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CarouselStateService>(CarouselStateService);
    extractedEventRepo = module.get(getRepositoryToken(ExtractedEvent));
  });

  describe('create', () => {
    it('should create a new carousel and return its ID', async () => {
      const chatId = '123456';
      const messageId = 999;
      const eventIds = [mockEvent1.id, mockEvent2.id];

      mockRedis.setex.mockResolvedValue('OK');

      const carouselId = await service.create(chatId, messageId, eventIds);

      expect(carouselId).toMatch(/^c_[a-f0-9]{12}$/);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `carousel:${carouselId}`,
        86400,
        expect.stringContaining('"eventIds"'),
      );
    });

    it('should throw error for empty event list', async () => {
      await expect(service.create('123', 999, [])).rejects.toThrow(
        'Cannot create carousel with empty event list',
      );
    });
  });

  describe('get', () => {
    it('should return carousel state if found', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id],
        currentIndex: 0,
        processedIds: [],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.get('c_test123');

      expect(result).toEqual(state);
    });

    it('should return null if carousel not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.get('c_nonexistent');

      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', async () => {
      mockRedis.get.mockResolvedValue('invalid json');

      const result = await service.get('c_invalid');

      expect(result).toBeNull();
    });
  });

  describe('getCurrentEvent', () => {
    it('should return current event with position info', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id, mockEvent3.id],
        currentIndex: 0,
        processedIds: [],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));
      extractedEventRepo.findOne.mockResolvedValue(mockEvent1);

      const result = await service.getCurrentEvent('c_test');

      expect(result).not.toBeNull();
      expect(result!.event.id).toBe(mockEvent1.id);
      expect(result!.index).toBe(0);
      expect(result!.total).toBe(3);
      expect(result!.remaining).toBe(3);
    });

    it('should skip processed events', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id, mockEvent3.id],
        currentIndex: 0,
        processedIds: [mockEvent1.id],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));
      extractedEventRepo.findOne.mockResolvedValue(mockEvent2);

      const result = await service.getCurrentEvent('c_test');

      expect(result).not.toBeNull();
      expect(result!.event.id).toBe(mockEvent2.id);
      expect(result!.index).toBe(1);
      expect(result!.remaining).toBe(2);
    });

    it('should return null when all events processed', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id],
        currentIndex: 0,
        processedIds: [mockEvent1.id, mockEvent2.id],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.getCurrentEvent('c_test');

      expect(result).toBeNull();
    });
  });

  describe('next', () => {
    it('should navigate to next unprocessed event', async () => {
      const originalState: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id, mockEvent3.id],
        currentIndex: 0,
        processedIds: [],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };
      const updatedState: CarouselState = {
        ...originalState,
        currentIndex: 1, // After next
      };

      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(originalState))
        .mockResolvedValueOnce(JSON.stringify(updatedState));
      mockRedis.setex.mockResolvedValue('OK');
      extractedEventRepo.findOne.mockResolvedValue(mockEvent2);

      const result = await service.next('c_test');

      expect(result).not.toBeNull();
      expect(result!.event.id).toBe(mockEvent2.id);
      expect(result!.index).toBe(1);
    });

    it('should wrap around to beginning', async () => {
      const originalState: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id, mockEvent3.id],
        currentIndex: 2,
        processedIds: [mockEvent3.id],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };
      const updatedState: CarouselState = {
        ...originalState,
        currentIndex: 0, // After wrapping
      };

      // First call in next(), second call in getCurrentEvent()
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(originalState))
        .mockResolvedValueOnce(JSON.stringify(updatedState));
      mockRedis.setex.mockResolvedValue('OK');
      extractedEventRepo.findOne.mockResolvedValue(mockEvent1);

      const result = await service.next('c_test');

      expect(result).not.toBeNull();
      expect(result!.event.id).toBe(mockEvent1.id);
      expect(result!.index).toBe(0);
    });

    it('should return null when all events processed', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id],
        currentIndex: 0,
        processedIds: [mockEvent1.id],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.next('c_test');

      expect(result).toBeNull();
    });
  });

  describe('prev', () => {
    it('should navigate to previous unprocessed event', async () => {
      const originalState: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id, mockEvent3.id],
        currentIndex: 2,
        processedIds: [],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };
      const updatedState: CarouselState = {
        ...originalState,
        currentIndex: 1, // After prev
      };

      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(originalState))
        .mockResolvedValueOnce(JSON.stringify(updatedState));
      mockRedis.setex.mockResolvedValue('OK');
      extractedEventRepo.findOne.mockResolvedValue(mockEvent2);

      const result = await service.prev('c_test');

      expect(result).not.toBeNull();
      expect(result!.event.id).toBe(mockEvent2.id);
      expect(result!.index).toBe(1);
    });

    it('should wrap around to end', async () => {
      const originalState: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id, mockEvent3.id],
        currentIndex: 0,
        processedIds: [mockEvent1.id],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };
      const updatedState: CarouselState = {
        ...originalState,
        currentIndex: 2, // After wrapping to end
      };

      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(originalState))
        .mockResolvedValueOnce(JSON.stringify(updatedState));
      mockRedis.setex.mockResolvedValue('OK');
      extractedEventRepo.findOne.mockResolvedValue(mockEvent3);

      const result = await service.prev('c_test');

      expect(result).not.toBeNull();
      expect(result!.event.id).toBe(mockEvent3.id);
      expect(result!.index).toBe(2);
    });
  });

  describe('markProcessed', () => {
    it('should mark event as processed', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id],
        currentIndex: 0,
        processedIds: [],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));
      mockRedis.setex.mockResolvedValue('OK');

      await service.markProcessed('c_test', mockEvent1.id);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'carousel:c_test',
        86400,
        expect.stringContaining(mockEvent1.id),
      );

      // Verify processedIds was updated
      const savedState = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedState.processedIds).toContain(mockEvent1.id);
    });

    it('should not duplicate already processed events', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id],
        currentIndex: 0,
        processedIds: [mockEvent1.id],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      await service.markProcessed('c_test', mockEvent1.id);

      // setex should not be called because event already processed
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('isComplete', () => {
    it('should return true when all events processed', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id],
        currentIndex: 0,
        processedIds: [mockEvent1.id, mockEvent2.id],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.isComplete('c_test');

      expect(result).toBe(true);
    });

    it('should return false when events remain', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id, mockEvent2.id],
        currentIndex: 0,
        processedIds: [mockEvent1.id],
        chatId: '123456',
        messageId: 999,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.isComplete('c_test');

      expect(result).toBe(false);
    });

    it('should return true when carousel not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.isComplete('c_nonexistent');

      expect(result).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete carousel from Redis', async () => {
      mockRedis.del.mockResolvedValue(1);

      await service.delete('c_test');

      expect(mockRedis.del).toHaveBeenCalledWith('carousel:c_test');
    });
  });

  describe('updateMessageId', () => {
    it('should update message ID in carousel state', async () => {
      const state: CarouselState = {
        eventIds: [mockEvent1.id],
        currentIndex: 0,
        processedIds: [],
        chatId: '123456',
        messageId: 0,
        createdAt: Date.now(),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(state));
      mockRedis.setex.mockResolvedValue('OK');

      await service.updateMessageId('c_test', 12345);

      const savedState = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedState.messageId).toBe(12345);
    });

    it('should not throw when carousel not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      await expect(service.updateMessageId('c_nonexistent', 12345)).resolves.not.toThrow();
    });
  });

  describe('getEventsByIds', () => {
    it('should return events by IDs', async () => {
      const events = [mockEvent1, mockEvent2];
      extractedEventRepo.find.mockResolvedValue(events);

      const result = await service.getEventsByIds([mockEvent1.id, mockEvent2.id]);

      expect(result).toEqual(events);
      expect(extractedEventRepo.find).toHaveBeenCalledWith({
        where: { id: expect.any(Object) }, // In() operator
      });
    });

    it('should return empty array for empty input', async () => {
      const result = await service.getEventsByIds([]);

      expect(result).toEqual([]);
      expect(extractedEventRepo.find).not.toHaveBeenCalled();
    });
  });
});
