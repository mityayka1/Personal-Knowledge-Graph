import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, IsNull } from 'typeorm';
import { EntityEvent, EventType, EventStatus } from '@pkg/entities';

export interface CreateEventDto {
  entityId: string;
  relatedEntityId?: string | null;
  eventType: EventType;
  title?: string | null;
  description?: string | null;
  eventDate?: Date | null;
  status?: EventStatus;
  confidence?: number | null;
  sourceMessageId?: string | null;
  sourceQuote?: string | null;
}

export interface UpdateEventDto {
  title?: string | null;
  description?: string | null;
  eventDate?: Date | null;
  status?: EventStatus;
}

export interface EventQueryParams {
  entityId?: string;
  eventType?: EventType;
  status?: EventStatus;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class EntityEventService {
  private readonly logger = new Logger(EntityEventService.name);

  constructor(
    @InjectRepository(EntityEvent)
    private eventRepo: Repository<EntityEvent>,
  ) {}

  /**
   * Create a new event
   */
  async create(dto: CreateEventDto): Promise<EntityEvent> {
    const event = this.eventRepo.create({
      entityId: dto.entityId,
      relatedEntityId: dto.relatedEntityId ?? null,
      eventType: dto.eventType,
      title: dto.title ?? null,
      description: dto.description ?? null,
      eventDate: dto.eventDate ?? null,
      status: dto.status ?? EventStatus.SCHEDULED,
      confidence: dto.confidence ?? null,
      sourceMessageId: dto.sourceMessageId ?? null,
      sourceQuote: dto.sourceQuote ?? null,
    });

    const saved = await this.eventRepo.save(event);
    this.logger.log(`Created event ${saved.id} for entity ${dto.entityId}: ${dto.eventType}`);
    return saved;
  }

  /**
   * Get event by ID
   */
  async findById(id: string): Promise<EntityEvent | null> {
    return this.eventRepo.findOne({
      where: { id },
      relations: ['entity', 'relatedEntity', 'sourceMessage'],
    });
  }

  /**
   * List events with filters
   */
  async findAll(params: EventQueryParams) {
    const { entityId, eventType, status, fromDate, toDate, limit = 50, offset = 0 } = params;

    const query = this.eventRepo.createQueryBuilder('ee')
      .leftJoinAndSelect('ee.entity', 'entity')
      .leftJoinAndSelect('ee.relatedEntity', 'relatedEntity');

    if (entityId) {
      query.andWhere('(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)', { entityId });
    }

    if (eventType) {
      query.andWhere('ee.eventType = :eventType', { eventType });
    }

    if (status) {
      query.andWhere('ee.status = :status', { status });
    }

    if (fromDate) {
      query.andWhere('ee.eventDate >= :fromDate', { fromDate });
    }

    if (toDate) {
      query.andWhere('ee.eventDate <= :toDate', { toDate });
    }

    const [items, total] = await query
      .orderBy('ee.eventDate', 'ASC', 'NULLS LAST')
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return { items, total, limit, offset };
  }

  /**
   * Get upcoming events (optionally for specific entity)
   */
  async getUpcoming(entityId?: string, limit: number = 10): Promise<EntityEvent[]> {
    const now = new Date();

    const query = this.eventRepo.createQueryBuilder('ee')
      .leftJoinAndSelect('ee.entity', 'entity')
      .leftJoinAndSelect('ee.relatedEntity', 'relatedEntity')
      .where('ee.status = :status', { status: EventStatus.SCHEDULED })
      .andWhere('ee.eventDate >= :now', { now });

    if (entityId) {
      query.andWhere('(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)', { entityId });
    }

    return query
      .orderBy('ee.eventDate', 'ASC')
      .take(limit)
      .getMany();
  }

  /**
   * Get overdue events (past scheduled events)
   */
  async getOverdue(entityId?: string, limit: number = 10): Promise<EntityEvent[]> {
    const now = new Date();

    const query = this.eventRepo.createQueryBuilder('ee')
      .leftJoinAndSelect('ee.entity', 'entity')
      .leftJoinAndSelect('ee.relatedEntity', 'relatedEntity')
      .where('ee.status = :status', { status: EventStatus.SCHEDULED })
      .andWhere('ee.eventDate < :now', { now });

    if (entityId) {
      query.andWhere('(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)', { entityId });
    }

    return query
      .orderBy('ee.eventDate', 'DESC')
      .take(limit)
      .getMany();
  }

  /**
   * Update event
   */
  async update(id: string, dto: UpdateEventDto): Promise<EntityEvent | null> {
    const event = await this.eventRepo.findOne({ where: { id } });
    if (!event) return null;

    if (dto.title !== undefined) event.title = dto.title;
    if (dto.description !== undefined) event.description = dto.description;
    if (dto.eventDate !== undefined) event.eventDate = dto.eventDate;
    if (dto.status !== undefined) event.status = dto.status;

    const updated = await this.eventRepo.save(event);
    this.logger.log(`Updated event ${id}: status=${event.status}`);
    return updated;
  }

  /**
   * Mark event as completed
   */
  async complete(id: string): Promise<EntityEvent | null> {
    return this.update(id, { status: EventStatus.COMPLETED });
  }

  /**
   * Mark event as cancelled
   */
  async cancel(id: string): Promise<EntityEvent | null> {
    return this.update(id, { status: EventStatus.CANCELLED });
  }

  /**
   * Delete event
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.eventRepo.delete(id);
    return (result.affected ?? 0) > 0;
  }

  /**
   * Get event statistics
   */
  async getStats(entityId?: string) {
    const now = new Date();

    const query = this.eventRepo.createQueryBuilder('ee')
      .select('ee.status', 'status')
      .addSelect('ee.eventType', 'eventType')
      .addSelect('COUNT(*)', 'count');

    if (entityId) {
      query.where('(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)', { entityId });
    }

    const stats = await query
      .groupBy('ee.status')
      .addGroupBy('ee.eventType')
      .getRawMany();

    // Aggregate
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let total = 0;

    for (const s of stats) {
      const count = parseInt(s.count, 10);
      total += count;
      byStatus[s.status] = (byStatus[s.status] ?? 0) + count;
      byType[s.eventType] = (byType[s.eventType] ?? 0) + count;
    }

    // Count upcoming and overdue separately
    const upcomingQuery = this.eventRepo.createQueryBuilder('ee')
      .where('ee.status = :status', { status: EventStatus.SCHEDULED })
      .andWhere('ee.eventDate >= :now', { now });

    const overdueQuery = this.eventRepo.createQueryBuilder('ee')
      .where('ee.status = :status', { status: EventStatus.SCHEDULED })
      .andWhere('ee.eventDate < :now', { now });

    if (entityId) {
      upcomingQuery.andWhere('(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)', { entityId });
      overdueQuery.andWhere('(ee.entityId = :entityId OR ee.relatedEntityId = :entityId)', { entityId });
    }

    const [upcoming, overdue] = await Promise.all([
      upcomingQuery.getCount(),
      overdueQuery.getCount(),
    ]);

    return {
      total,
      byStatus,
      byType,
      scheduled: byStatus[EventStatus.SCHEDULED] ?? 0,
      completed: byStatus[EventStatus.COMPLETED] ?? 0,
      cancelled: byStatus[EventStatus.CANCELLED] ?? 0,
      upcoming,
      overdue,
    };
  }
}
