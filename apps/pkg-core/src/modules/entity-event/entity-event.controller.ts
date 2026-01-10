import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { EntityEventService, CreateEventDto, UpdateEventDto } from './entity-event.service';
import { EventType, EventStatus } from '@pkg/entities';

/** API DTO with snake_case */
interface CreateEventApiDto {
  entity_id: string;
  related_entity_id?: string | null;
  event_type: EventType;
  title?: string | null;
  description?: string | null;
  event_date?: string | null;
  status?: EventStatus;
  confidence?: number | null;
  source_message_id?: string | null;
  source_quote?: string | null;
}

interface UpdateEventApiDto {
  title?: string | null;
  description?: string | null;
  event_date?: string | null;
  status?: EventStatus;
}

@Controller('entity-events')
export class EntityEventController {
  constructor(private readonly eventService: EntityEventService) {}

  @Post()
  async create(@Body() dto: CreateEventApiDto) {
    const serviceDto: CreateEventDto = {
      entityId: dto.entity_id,
      relatedEntityId: dto.related_entity_id,
      eventType: dto.event_type,
      title: dto.title,
      description: dto.description,
      eventDate: dto.event_date ? new Date(dto.event_date) : null,
      status: dto.status,
      confidence: dto.confidence,
      sourceMessageId: dto.source_message_id,
      sourceQuote: dto.source_quote,
    };
    return this.eventService.create(serviceDto);
  }

  @Get('stats')
  async getStats(@Query('entity_id') entityId?: string) {
    return this.eventService.getStats(entityId);
  }

  @Get('upcoming')
  async getUpcoming(
    @Query('entity_id') entityId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.eventService.getUpcoming(entityId, limit ? parseInt(limit, 10) : 10);
  }

  @Get('overdue')
  async getOverdue(
    @Query('entity_id') entityId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.eventService.getOverdue(entityId, limit ? parseInt(limit, 10) : 10);
  }

  @Get()
  async findAll(
    @Query('entity_id') entityId?: string,
    @Query('event_type') eventType?: EventType,
    @Query('status') status?: EventStatus,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.eventService.findAll({
      entityId,
      eventType,
      status,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    const event = await this.eventService.findById(id);
    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }
    return event;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateEventApiDto) {
    const serviceDto: UpdateEventDto = {
      title: dto.title,
      description: dto.description,
      eventDate: dto.event_date ? new Date(dto.event_date) : undefined,
      status: dto.status,
    };
    const event = await this.eventService.update(id, serviceDto);
    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }
    return event;
  }

  @Post(':id/complete')
  async complete(@Param('id') id: string) {
    const event = await this.eventService.complete(id);
    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }
    return event;
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    const event = await this.eventService.cancel(id);
    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }
    return event;
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    const deleted = await this.eventService.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Event ${id} not found`);
    }
    return { deleted: true };
  }
}
