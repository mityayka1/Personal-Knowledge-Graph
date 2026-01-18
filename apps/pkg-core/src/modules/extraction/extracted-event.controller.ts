import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
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
import { EnrichmentQueueService } from './enrichment-queue.service';
import { ContextEnrichmentService } from './context-enrichment.service';

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

interface RemindResponse {
  success: boolean;
  createdEntityId?: string;
  reminderDate?: string;
}

interface RescheduleRequestDto {
  days: number;
}

interface RescheduleResponse {
  success: boolean;
  newDate?: string;
  updatedEntityEventId?: string;
}

@ApiTags('extracted-events')
@Controller('extracted-events')
export class ExtractedEventController {
  private readonly logger = new Logger(ExtractedEventController.name);

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    private entityEventService: EntityEventService,
    private enrichmentQueueService: EnrichmentQueueService,
    private contextEnrichmentService: ContextEnrichmentService,
  ) {}

  /**
   * Get enrichment queue statistics
   * GET /extracted-events/queue/stats
   */
  @Get('queue/stats')
  @ApiOperation({
    summary: 'Get enrichment queue statistics',
    description: 'Returns counts for waiting, active, completed, and failed jobs',
  })
  @ApiResponse({ status: 200, description: 'Queue statistics returned successfully' })
  @ApiResponse({ status: 503, description: 'Queue service unavailable' })
  async getQueueStats() {
    try {
      return await this.enrichmentQueueService.getQueueStats();
    } catch (error) {
      this.logger.error('Failed to get queue stats:', error);
      throw new ServiceUnavailableException('Queue service unavailable');
    }
  }

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
  @ApiOperation({ summary: 'Reject extracted event' })
  @ApiParam({ name: 'id', description: 'ExtractedEvent UUID' })
  @ApiResponse({ status: 200, description: 'Event rejected successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
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

  /**
   * Create a reminder for an extracted event (+7 days)
   * POST /extracted-events/:id/remind
   *
   * Creates a FOLLOW_UP EntityEvent 7 days from now and marks
   * the extracted event as CONFIRMED.
   */
  @Post(':id/remind')
  @ApiOperation({
    summary: 'Create reminder for extracted event',
    description: 'Creates a follow-up reminder 7 days from now',
  })
  @ApiParam({ name: 'id', description: 'ExtractedEvent UUID' })
  @ApiResponse({ status: 200, description: 'Reminder created successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  async remind(@Param('id', ParseUUIDPipe) id: string): Promise<RemindResponse> {
    const event = await this.extractedEventRepo.findOne({
      where: { id },
      relations: [
        'sourceMessage',
        'sourceMessage.interaction',
        'sourceMessage.interaction.participants',
      ],
    });

    if (!event) {
      throw new NotFoundException(`ExtractedEvent ${id} not found`);
    }

    try {
      // Get entity ID from source message's interaction participants
      const interaction = event.sourceMessage?.interaction;
      let entityId: string | null = null;

      if (interaction?.participants) {
        const nonSelfParticipant = interaction.participants.find(
          (p) => p.role !== ParticipantRole.SELF && p.entityId,
        );
        entityId = nonSelfParticipant?.entityId || null;
      }

      if (!entityId) {
        this.logger.warn(`No entity ID found for remind event ${id}`);
        // Still mark as confirmed but without creating reminder
        await this.extractedEventRepo.update(id, {
          status: ExtractedEventStatus.CONFIRMED,
          userResponseAt: new Date(),
        });
        return { success: true };
      }

      // Create reminder +7 days from now
      const reminderDate = new Date();
      reminderDate.setDate(reminderDate.getDate() + 7);

      const title = this.extractTitle(event);
      const entityEvent = await this.entityEventService.create({
        entityId,
        eventType: EventType.FOLLOW_UP,
        title: `Напоминание: ${title}`,
        eventDate: reminderDate,
        description: JSON.stringify(event.extractedData),
      });

      // Update extracted event status
      await this.extractedEventRepo.update(id, {
        status: ExtractedEventStatus.CONFIRMED,
        userResponseAt: new Date(),
        resultEntityType: 'EntityEvent',
        resultEntityId: entityEvent.id,
      });

      this.logger.log(
        `Created reminder for event ${id}, EntityEvent: ${entityEvent.id}`,
      );

      return {
        success: true,
        createdEntityId: entityEvent.id,
        reminderDate: reminderDate.toISOString(),
      };
    } catch (error) {
      this.logger.error(`Failed to create reminder for event ${id}:`, error);
      return { success: false };
    }
  }

  /**
   * Reschedule an extracted event
   * POST /extracted-events/:id/reschedule
   *
   * Updates the datetime in extractedData and, if an EntityEvent
   * was already created, updates its eventDate as well.
   */
  @Post(':id/reschedule')
  @ApiOperation({
    summary: 'Reschedule extracted event',
    description: 'Move event date by specified number of days',
  })
  @ApiParam({ name: 'id', description: 'ExtractedEvent UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to reschedule (1=tomorrow, 2, 7, etc.)',
          example: 1,
        },
      },
      required: ['days'],
    },
  })
  @ApiResponse({ status: 200, description: 'Event rescheduled successfully' })
  @ApiResponse({ status: 400, description: 'Invalid days parameter' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  async reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RescheduleRequestDto,
  ): Promise<RescheduleResponse> {
    const { days } = body;

    if (!days || days < 1 || days > 365) {
      throw new BadRequestException('days must be between 1 and 365');
    }

    const event = await this.extractedEventRepo.findOne({
      where: { id },
    });

    if (!event) {
      throw new NotFoundException(`ExtractedEvent ${id} not found`);
    }

    try {
      // Calculate new date
      const newDate = new Date();
      newDate.setDate(newDate.getDate() + days);

      // Update extractedData with new datetime
      const updatedData = {
        ...event.extractedData,
        datetime: newDate.toISOString(),
        dateText: this.formatDateText(days),
      };

      await this.extractedEventRepo.update(id, {
        extractedData: updatedData,
        userResponseAt: new Date(),
      });

      // If EntityEvent was already created, update it too
      let updatedEntityEventId: string | undefined;
      if (event.resultEntityId && event.resultEntityType === 'EntityEvent') {
        await this.entityEventService.update(event.resultEntityId, {
          eventDate: newDate,
        });
        updatedEntityEventId = event.resultEntityId;
        this.logger.log(
          `Updated EntityEvent ${event.resultEntityId} date to ${newDate.toISOString()}`,
        );
      }

      this.logger.log(`Rescheduled event ${id} to ${newDate.toISOString()}`);

      return {
        success: true,
        newDate: newDate.toISOString(),
        updatedEntityEventId,
      };
    } catch (error) {
      this.logger.error(`Failed to reschedule event ${id}:`, error);
      return { success: false };
    }
  }

  private formatDateText(days: number): string {
    if (days === 1) return 'завтра';
    if (days === 2) return 'послезавтра';
    if (days === 7) return 'через неделю';
    return `через ${days} дней`;
  }

  /**
   * Manually trigger enrichment for an extracted event
   * POST /extracted-events/:id/enrich
   *
   * Useful for testing the enrichment flow or re-enriching events.
   */
  @Post(':id/enrich')
  @ApiOperation({
    summary: 'Trigger enrichment for extracted event',
    description: 'Manually runs context enrichment on the event',
  })
  @ApiParam({ name: 'id', description: 'ExtractedEvent UUID' })
  @ApiResponse({ status: 200, description: 'Enrichment completed' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  async enrich(@Param('id', ParseUUIDPipe) id: string) {
    const event = await this.extractedEventRepo.findOne({ where: { id } });

    if (!event) {
      throw new NotFoundException(`ExtractedEvent ${id} not found`);
    }

    try {
      this.logger.log(`Starting manual enrichment for event ${id}`);

      // Run enrichment directly (not via queue for immediate feedback)
      const result = await this.contextEnrichmentService.enrichEvent(event);

      // Apply result using centralized logic (DRY)
      await this.contextEnrichmentService.applyEnrichmentResult(id, result);

      this.logger.log(
        `Manual enrichment completed for event ${id}: ` +
          `success=${result.success}, needsContext=${result.needsContext}`,
      );

      return {
        success: result.success,
        needsContext: result.needsContext,
        linkedEventId: result.linkedEventId,
        enrichmentData: result.enrichmentData,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Manual enrichment failed for event ${id}: ${errorMessage}`);
      throw new BadRequestException(`Enrichment failed: ${errorMessage}`);
    }
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
