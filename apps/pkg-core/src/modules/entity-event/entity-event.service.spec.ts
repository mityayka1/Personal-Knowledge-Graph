import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { EntityEvent, EventType, EventStatus } from '@pkg/entities';
import { EntityEventService, CreateEventDto } from './entity-event.service';

describe('EntityEventService', () => {
  let service: EntityEventService;
  let repo: jest.Mocked<Repository<EntityEvent>>;

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    getRawMany: jest.fn().mockResolvedValue([]),
  };

  const mockRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityEventService,
        {
          provide: getRepositoryToken(EntityEvent),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<EntityEventService>(EntityEventService);
    repo = module.get(getRepositoryToken(EntityEvent));

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new event with default status', async () => {
      const dto: CreateEventDto = {
        entityId: 'entity-123',
        eventType: EventType.MEETING,
        title: 'Team Meeting',
        eventDate: new Date('2025-01-15T15:00:00Z'),
      };

      mockRepo.create.mockReturnValue({
        ...dto,
        id: 'event-1',
        status: EventStatus.SCHEDULED,
      });
      mockRepo.save.mockResolvedValue({
        ...dto,
        id: 'event-1',
        status: EventStatus.SCHEDULED,
      });

      const result = await service.create(dto);

      expect(result.id).toBe('event-1');
      expect(result.status).toBe(EventStatus.SCHEDULED);
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'entity-123',
          eventType: EventType.MEETING,
        })
      );
    });

    it('should create event with related entity', async () => {
      const dto: CreateEventDto = {
        entityId: 'entity-123',
        relatedEntityId: 'entity-456',
        eventType: EventType.MEETING,
        title: 'One-on-One',
      };

      mockRepo.create.mockReturnValue({ ...dto, id: 'event-1' });
      mockRepo.save.mockResolvedValue({ ...dto, id: 'event-1' });

      const result = await service.create(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          relatedEntityId: 'entity-456',
        })
      );
    });

    it('should create event with source quote', async () => {
      const dto: CreateEventDto = {
        entityId: 'entity-123',
        eventType: EventType.COMMITMENT,
        title: 'Send documents',
        sourceQuote: 'Я пришлю документы завтра',
        confidence: 0.85,
      };

      mockRepo.create.mockReturnValue({ ...dto, id: 'event-1' });
      mockRepo.save.mockResolvedValue({ ...dto, id: 'event-1' });

      const result = await service.create(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceQuote: 'Я пришлю документы завтра',
          confidence: 0.85,
        })
      );
    });
  });

  describe('findById', () => {
    it('should return event with relations', async () => {
      const event = {
        id: 'event-1',
        entityId: 'entity-123',
        eventType: EventType.DEADLINE,
      };
      mockRepo.findOne.mockResolvedValue(event);

      const result = await service.findById('event-1');

      expect(result).toEqual(event);
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        relations: ['entity', 'relatedEntity', 'sourceMessage'],
      });
    });

    it('should return null for non-existent event', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await service.findById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should filter by entityId', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({ entityId: 'entity-123' });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)',
        { entityId: 'entity-123' }
      );
    });

    it('should filter by eventType', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({ eventType: EventType.MEETING });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ee.eventType = :eventType',
        { eventType: EventType.MEETING }
      );
    });

    it('should filter by status', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({ status: EventStatus.SCHEDULED });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ee.status = :status',
        { status: EventStatus.SCHEDULED }
      );
    });

    it('should filter by date range', async () => {
      const fromDate = new Date('2025-01-01');
      const toDate = new Date('2025-01-31');
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({ fromDate, toDate });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ee.eventDate >= :fromDate',
        { fromDate }
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ee.eventDate <= :toDate',
        { toDate }
      );
    });

    it('should apply pagination', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({ limit: 10, offset: 20 });

      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(20);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(10);
    });
  });

  describe('getUpcoming', () => {
    it('should return upcoming events globally', async () => {
      const events = [
        { id: 'event-1', eventDate: new Date('2025-01-15') },
        { id: 'event-2', eventDate: new Date('2025-01-16') },
      ];
      mockQueryBuilder.getMany.mockResolvedValue(events);

      const result = await service.getUpcoming(undefined, 10);

      expect(result).toEqual(events);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'ee.status = :status',
        { status: EventStatus.SCHEDULED }
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ee.eventDate >= :now',
        expect.any(Object)
      );
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(10);
    });

    it('should filter by entityId when provided', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.getUpcoming('entity-123', 5);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)',
        { entityId: 'entity-123' }
      );
    });
  });

  describe('getOverdue', () => {
    it('should return overdue events globally', async () => {
      const events = [
        { id: 'event-1', eventDate: new Date('2025-01-01') },
      ];
      mockQueryBuilder.getMany.mockResolvedValue(events);

      const result = await service.getOverdue(undefined, 10);

      expect(result).toEqual(events);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'ee.status = :status',
        { status: EventStatus.SCHEDULED }
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ee.eventDate < :now',
        expect.any(Object)
      );
    });

    it('should filter by entityId when provided', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.getOverdue('entity-123', 5);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)',
        { entityId: 'entity-123' }
      );
    });
  });

  describe('update', () => {
    it('should update event fields', async () => {
      const existingEvent = {
        id: 'event-1',
        title: 'Old Title',
        status: EventStatus.SCHEDULED,
      };
      mockRepo.findOne.mockResolvedValue(existingEvent);
      mockRepo.save.mockResolvedValue({ ...existingEvent, title: 'New Title' });

      const result = await service.update('event-1', { title: 'New Title' });

      expect(result?.title).toBe('New Title');
      expect(mockRepo.save).toHaveBeenCalled();
    });

    it('should return null for non-existent event', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await service.update('non-existent', { title: 'Test' });

      expect(result).toBeNull();
    });
  });

  describe('complete', () => {
    it('should mark event as completed', async () => {
      const event = {
        id: 'event-1',
        status: EventStatus.SCHEDULED,
      };
      mockRepo.findOne.mockResolvedValue(event);
      mockRepo.save.mockResolvedValue({ ...event, status: EventStatus.COMPLETED });

      const result = await service.complete('event-1');

      expect(result?.status).toBe(EventStatus.COMPLETED);
    });
  });

  describe('cancel', () => {
    it('should mark event as cancelled', async () => {
      const event = {
        id: 'event-1',
        status: EventStatus.SCHEDULED,
      };
      mockRepo.findOne.mockResolvedValue(event);
      mockRepo.save.mockResolvedValue({ ...event, status: EventStatus.CANCELLED });

      const result = await service.cancel('event-1');

      expect(result?.status).toBe(EventStatus.CANCELLED);
    });
  });

  describe('delete', () => {
    it('should delete event and return true', async () => {
      mockRepo.delete.mockResolvedValue({ affected: 1 });

      const result = await service.delete('event-1');

      expect(result).toBe(true);
      expect(mockRepo.delete).toHaveBeenCalledWith('event-1');
    });

    it('should return false if event not found', async () => {
      mockRepo.delete.mockResolvedValue({ affected: 0 });

      const result = await service.delete('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return aggregated statistics', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { status: EventStatus.SCHEDULED, eventType: EventType.MEETING, count: '5' },
        { status: EventStatus.COMPLETED, eventType: EventType.MEETING, count: '3' },
        { status: EventStatus.SCHEDULED, eventType: EventType.DEADLINE, count: '2' },
      ]);
      mockQueryBuilder.getCount.mockResolvedValueOnce(4).mockResolvedValueOnce(1);

      const result = await service.getStats();

      expect(result.total).toBe(10);
      expect(result.scheduled).toBe(7);
      expect(result.completed).toBe(3);
      expect(result.byType[EventType.MEETING]).toBe(8);
      expect(result.byType[EventType.DEADLINE]).toBe(2);
      expect(result.upcoming).toBe(4);
      expect(result.overdue).toBe(1);
    });

    it('should filter stats by entityId', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);
      mockQueryBuilder.getCount.mockResolvedValue(0);

      await service.getStats('entity-123');

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        '(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)',
        { entityId: 'entity-123' }
      );
    });

    it('should handle empty results', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);
      mockQueryBuilder.getCount.mockResolvedValue(0);

      const result = await service.getStats();

      expect(result.total).toBe(0);
      expect(result.scheduled).toBe(0);
      expect(result.completed).toBe(0);
      expect(result.cancelled).toBe(0);
      expect(result.upcoming).toBe(0);
      expect(result.overdue).toBe(0);
    });
  });
});
