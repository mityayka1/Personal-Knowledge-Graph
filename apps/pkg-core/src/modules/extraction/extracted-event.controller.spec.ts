import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
} from '@pkg/entities';
import { ExtractedEventController } from './extracted-event.controller';
import { EntityEventService } from '../entity-event/entity-event.service';
import { EnrichmentQueueService } from './enrichment-queue.service';
import { ContextEnrichmentService } from './context-enrichment.service';

describe('ExtractedEventController', () => {
  let controller: ExtractedEventController;
  let extractedEventRepo: jest.Mocked<Repository<ExtractedEvent>>;
  let entityEventService: jest.Mocked<EntityEventService>;
  let enrichmentQueueService: jest.Mocked<EnrichmentQueueService>;
  let contextEnrichmentService: jest.Mocked<ContextEnrichmentService>;

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
    createdAt: new Date(),
    updatedAt: new Date(),
    sourceMessage: null as any,
    sourceInteraction: null,
    linkedEvent: null as any,
    ...overrides,
  });

  beforeEach(async () => {
    const mockQueryBuilder = {
      orderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExtractedEventController],
      providers: [
        {
          provide: getRepositoryToken(ExtractedEvent),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
          },
        },
        {
          provide: EntityEventService,
          useValue: {
            create: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: EnrichmentQueueService,
          useValue: {
            getQueueStats: jest.fn(),
          },
        },
        {
          provide: ContextEnrichmentService,
          useValue: {
            enrichEvent: jest.fn(),
            applyEnrichmentResult: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ExtractedEventController>(ExtractedEventController);
    extractedEventRepo = module.get(getRepositoryToken(ExtractedEvent));
    entityEventService = module.get(EntityEventService);
    enrichmentQueueService = module.get(EnrichmentQueueService);
    contextEnrichmentService = module.get(ContextEnrichmentService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /queue/stats', () => {
    it('should return queue statistics', async () => {
      const mockStats = {
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
      };
      enrichmentQueueService.getQueueStats.mockResolvedValue(mockStats);

      const result = await controller.getQueueStats();

      expect(result).toEqual(mockStats);
      expect(enrichmentQueueService.getQueueStats).toHaveBeenCalled();
    });

    it('should throw ServiceUnavailableException when queue fails', async () => {
      enrichmentQueueService.getQueueStats.mockRejectedValue(
        new Error('Redis connection failed'),
      );

      await expect(controller.getQueueStats()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('GET /', () => {
    it('should return paginated list of events', async () => {
      const events = [createMockEvent()];
      const mockQueryBuilder = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([events, 1]),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder as any,
      );

      const result = await controller.list({});

      expect(result).toEqual({
        items: events,
        total: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('should filter by status when provided', async () => {
      const mockQueryBuilder = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder as any,
      );

      await controller.list({ status: ExtractedEventStatus.PENDING });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'event.status = :status',
        { status: ExtractedEventStatus.PENDING },
      );
    });

    it('should filter by type when provided', async () => {
      const mockQueryBuilder = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      extractedEventRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder as any,
      );

      await controller.list({ type: ExtractedEventType.MEETING });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'event.eventType = :type',
        { type: ExtractedEventType.MEETING },
      );
    });
  });

  describe('GET /:id', () => {
    it('should return event by ID', async () => {
      const event = createMockEvent();
      extractedEventRepo.findOne.mockResolvedValue(event);

      const result = await controller.findOne('event-123');

      expect(result).toEqual(event);
    });

    it('should throw NotFoundException for non-existent event', async () => {
      extractedEventRepo.findOne.mockResolvedValue(null);

      await expect(controller.findOne('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /:id/confirm', () => {
    it('should confirm event and update status', async () => {
      const event = createMockEvent({
        status: ExtractedEventStatus.PENDING,
        sourceMessage: {
          interaction: {
            participants: [],
          },
        } as any,
      });
      extractedEventRepo.findOne.mockResolvedValue(event);
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await controller.confirm('event-123');

      expect(result.success).toBe(true);
    });

    it('should return success=false for non-pending events', async () => {
      const event = createMockEvent({
        status: ExtractedEventStatus.CONFIRMED,
      });
      extractedEventRepo.findOne.mockResolvedValue(event);

      const result = await controller.confirm('event-123');

      expect(result.success).toBe(false);
    });

    it('should throw NotFoundException for non-existent event', async () => {
      extractedEventRepo.findOne.mockResolvedValue(null);

      await expect(controller.confirm('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /:id/reject', () => {
    it('should reject event and update status', async () => {
      const event = createMockEvent();
      extractedEventRepo.findOne.mockResolvedValue(event);
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await controller.reject('event-123');

      expect(result.success).toBe(true);
      expect(extractedEventRepo.update).toHaveBeenCalledWith('event-123', {
        status: ExtractedEventStatus.REJECTED,
        userResponseAt: expect.any(Date),
      });
    });

    it('should throw NotFoundException for non-existent event', async () => {
      extractedEventRepo.findOne.mockResolvedValue(null);

      await expect(controller.reject('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /:id/remind', () => {
    it('should create reminder +7 days from now', async () => {
      const event = createMockEvent({
        sourceMessage: {
          interaction: {
            participants: [{ role: 'contact', entityId: 'entity-123' }],
          },
        } as any,
      });
      extractedEventRepo.findOne.mockResolvedValue(event);
      entityEventService.create.mockResolvedValue({
        id: 'reminder-123',
      } as any);
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await controller.remind('event-123');

      expect(result.success).toBe(true);
      expect(result.createdEntityId).toBe('reminder-123');
      expect(result.reminderDate).toBeDefined();
    });

    it('should throw NotFoundException for non-existent event', async () => {
      extractedEventRepo.findOne.mockResolvedValue(null);

      await expect(controller.remind('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /:id/reschedule', () => {
    it('should reschedule event by specified days', async () => {
      const event = createMockEvent();
      extractedEventRepo.findOne.mockResolvedValue(event);
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await controller.reschedule('event-123', { days: 7 });

      expect(result.success).toBe(true);
      expect(result.newDate).toBeDefined();
    });

    it('should throw BadRequestException for invalid days', async () => {
      await expect(
        controller.reschedule('event-123', { days: 0 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.reschedule('event-123', { days: 500 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent event', async () => {
      extractedEventRepo.findOne.mockResolvedValue(null);

      await expect(
        controller.reschedule('non-existent', { days: 1 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update linked EntityEvent if exists', async () => {
      const event = createMockEvent({
        resultEntityId: 'entity-event-123',
        resultEntityType: 'EntityEvent',
      });
      extractedEventRepo.findOne.mockResolvedValue(event);
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);
      entityEventService.update.mockResolvedValue({ id: 'entity-event-123' } as any);

      const result = await controller.reschedule('event-123', { days: 2 });

      expect(result.success).toBe(true);
      expect(result.updatedEntityEventId).toBe('entity-event-123');
      expect(entityEventService.update).toHaveBeenCalled();
    });
  });

  describe('POST /:id/enrich', () => {
    it('should run enrichment and return results', async () => {
      const event = createMockEvent();
      extractedEventRepo.findOne.mockResolvedValue(event);

      const enrichmentResult = {
        success: true,
        needsContext: false,
        linkedEventId: 'linked-123',
        enrichmentData: {
          keywords: ['test'],
          relatedMessageIds: [],
          candidateEventIds: [],
          enrichmentSuccess: true,
          enrichedAt: new Date().toISOString(),
        },
      };
      contextEnrichmentService.enrichEvent.mockResolvedValue(enrichmentResult);
      contextEnrichmentService.applyEnrichmentResult.mockResolvedValue(undefined);

      const result = await controller.enrich('event-123');

      expect(result.success).toBe(true);
      expect(result.linkedEventId).toBe('linked-123');
      expect(contextEnrichmentService.applyEnrichmentResult).toHaveBeenCalledWith(
        'event-123',
        enrichmentResult,
      );
    });

    it('should throw NotFoundException for non-existent event', async () => {
      extractedEventRepo.findOne.mockResolvedValue(null);

      await expect(controller.enrich('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when enrichment fails', async () => {
      const event = createMockEvent();
      extractedEventRepo.findOne.mockResolvedValue(event);
      contextEnrichmentService.enrichEvent.mockRejectedValue(
        new Error('LLM timeout'),
      );

      await expect(controller.enrich('event-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
