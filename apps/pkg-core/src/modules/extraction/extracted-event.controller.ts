import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  ParseUUIDPipe,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventStatus,
  ExtractedEventType,
  EntityEvent,
  EventType,
  ParticipantRole,
} from '@pkg/entities';
import { EntityEventService } from '../entity-event/entity-event.service';

interface ExtractedEventQueryDto {
  status?: ExtractedEventStatus;
  type?: ExtractedEventType;
  limit?: number;
  offset?: number;
}

interface ConfirmResponse {
  success: boolean;
  createdEntityId?: string;
}

interface RejectResponse {
  success: boolean;
}

@Controller('extracted-events')
export class ExtractedEventController {
  private readonly logger = new Logger(ExtractedEventController.name);

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    private entityEventService: EntityEventService,
  ) {}

  /**
   * List extracted events with optional filtering
   * GET /extracted-events?status=pending&type=meeting&limit=20
   */
  @Get()
  async list(@Query() query: ExtractedEventQueryDto) {
    const qb = this.extractedEventRepo
      .createQueryBuilder('event')
      .orderBy('event.createdAt', 'DESC');

    if (query.status) {
      qb.andWhere('event.status = :status', { status: query.status });
    }

    if (query.type) {
      qb.andWhere('event.eventType = :type', { type: query.type });
    }

    const limit = query.limit || 20;
    const offset = query.offset || 0;

    const [items, total] = await qb
      .take(limit)
      .skip(offset)
      .getManyAndCount();

    return { items, total, limit, offset };
  }

  /**
   * Get single extracted event by ID
   * GET /extracted-events/:id
   */
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const event = await this.extractedEventRepo.findOne({
      where: { id },
      relations: ['sourceMessage'],
    });

    if (!event) {
      throw new NotFoundException(`ExtractedEvent ${id} not found`);
    }

    return event;
  }

  /**
   * Confirm an extracted event and create corresponding entity
   * POST /extracted-events/:id/confirm
   */
  @Post(':id/confirm')
  async confirm(@Param('id', ParseUUIDPipe) id: string): Promise<ConfirmResponse> {
    const event = await this.extractedEventRepo.findOne({
      where: { id },
      relations: ['sourceMessage', 'sourceMessage.interaction', 'sourceMessage.interaction.participants'],
    });

    if (!event) {
      throw new NotFoundException(`ExtractedEvent ${id} not found`);
    }

    if (event.status !== ExtractedEventStatus.PENDING) {
      return { success: false };
    }

    try {
      // Get entity ID from source message's interaction participants
      // We need to find a non-self participant's entity ID
      const interaction = event.sourceMessage?.interaction;
      let entityId: string | null = null;

      if (interaction?.participants) {
        const nonSelfParticipant = interaction.participants.find(
          (p) => p.role !== ParticipantRole.SELF && p.entityId,
        );
        entityId = nonSelfParticipant?.entityId || null;
      }

      if (!entityId) {
        this.logger.warn(`No entity ID found for event ${id}`);
        // Still mark as confirmed but without creating entity event
        await this.extractedEventRepo.update(id, {
          status: ExtractedEventStatus.CONFIRMED,
          userResponseAt: new Date(),
        });
        return { success: true };
      }

      // Create corresponding entity based on event type
      let createdEvent: EntityEvent | null = null;

      if (this.shouldCreateEntityEvent(event.eventType)) {
        createdEvent = await this.createEntityEvent(event, entityId);
      }

      // Update extracted event status
      await this.extractedEventRepo.update(id, {
        status: ExtractedEventStatus.CONFIRMED,
        userResponseAt: new Date(),
        resultEntityType: createdEvent ? 'EntityEvent' : null,
        resultEntityId: createdEvent?.id || null,
      });

      this.logger.log(`Confirmed event ${id}, created EntityEvent: ${createdEvent?.id}`);

      return {
        success: true,
        createdEntityId: createdEvent?.id,
      };
    } catch (error) {
      this.logger.error(`Failed to confirm event ${id}:`, error);
      return { success: false };
    }
  }

  /**
   * Reject an extracted event
   * POST /extracted-events/:id/reject
   */
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string): Promise<RejectResponse> {
    const event = await this.extractedEventRepo.findOne({ where: { id } });

    if (!event) {
      throw new NotFoundException(`ExtractedEvent ${id} not found`);
    }

    await this.extractedEventRepo.update(id, {
      status: ExtractedEventStatus.REJECTED,
      userResponseAt: new Date(),
    });

    this.logger.log(`Rejected event ${id}`);

    return { success: true };
  }

  private shouldCreateEntityEvent(eventType: ExtractedEventType): boolean {
    return [
      ExtractedEventType.MEETING,
      ExtractedEventType.PROMISE_BY_ME,
      ExtractedEventType.PROMISE_BY_THEM,
      ExtractedEventType.TASK,
    ].includes(eventType);
  }

  private async createEntityEvent(
    event: ExtractedEvent,
    entityId: string,
  ): Promise<EntityEvent> {
    const eventType = this.mapToEntityEventType(event.eventType);
    const title = this.extractTitle(event);
    const eventDate = this.extractDate(event);

    return this.entityEventService.create({
      entityId,
      eventType,
      title,
      eventDate,
      description: JSON.stringify(event.extractedData),
    });
  }

  private mapToEntityEventType(extractedType: ExtractedEventType): EventType {
    switch (extractedType) {
      case ExtractedEventType.MEETING:
        return EventType.MEETING;
      case ExtractedEventType.PROMISE_BY_ME:
        return EventType.COMMITMENT;
      case ExtractedEventType.PROMISE_BY_THEM:
        return EventType.FOLLOW_UP;
      case ExtractedEventType.TASK:
        return EventType.DEADLINE;
      default:
        return EventType.DEADLINE;
    }
  }

  private extractTitle(event: ExtractedEvent): string {
    const data = event.extractedData as Record<string, unknown>;

    if (data.topic) return String(data.topic);
    if (data.what) return String(data.what);
    if (data.value) return `${data.factType}: ${data.value}`;

    return `Extracted: ${event.eventType}`;
  }

  private extractDate(event: ExtractedEvent): Date | undefined {
    const data = event.extractedData as Record<string, unknown>;

    if (data.datetime) {
      const date = new Date(String(data.datetime));
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    if (data.deadline) {
      const date = new Date(String(data.deadline));
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    return undefined;
  }
}
