import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, toolEmptyResult, handleToolError, parseDate, type ToolDefinition } from './tool.types';
import type { ToolsProviderInterface } from './tools-provider.interface';
import { ToolsRegistryService } from '../tools-registry.service';
import { EntityEventService } from '../../entity-event/entity-event.service';
import { EventType, type EntityEvent } from '@pkg/entities';

/**
 * Default title for events without a name
 */
const DEFAULT_EVENT_TITLE = '(untitled)';

/**
 * Locale settings for date formatting
 */
const DATE_LOCALE = 'ru-RU';
const DATE_TIMEZONE = 'Europe/Moscow';

/**
 * Provider for event-related tools (reminders, meetings, deadlines)
 * Implements NestJS Injectable pattern with tool caching
 */
@Injectable()
export class EventToolsProvider implements OnModuleInit, ToolsProviderInterface {
  private readonly logger = new Logger(EventToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  constructor(
    private readonly entityEventService: EntityEventService,
    private readonly toolsRegistry: ToolsRegistryService,
  ) {}

  onModuleInit() {
    this.toolsRegistry.registerProvider('events', this);
  }

  /**
   * Get event tools (cached)
   */
  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
      this.logger.debug(`Created ${this.cachedTools.length} event tools`);
    }
    return this.cachedTools;
  }

  /**
   * Format event for API response
   */
  private formatEvent(event: EntityEvent): Record<string, unknown> {
    return {
      id: event.id,
      type: event.eventType,
      title: event.title || DEFAULT_EVENT_TITLE,
      description: event.description,
      date: event.eventDate?.toISOString() || null,
      status: event.status,
      entity: event.entity?.name || null,
    };
  }

  /**
   * Create tool definitions
   */
  private createTools() {
    return [
      tool(
        'get_upcoming_events',
        `Get upcoming scheduled events: meetings, deadlines, commitments, and follow-ups.
Use for daily briefings, checking what's planned, or finding conflicts.
Returns events sorted by date with status and related entity information.`,
        {
          entityId: z.string().uuid().optional().describe(
            'Filter events for specific person/organization. Omit to get all upcoming events.'
          ),
          limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of events to return'),
          includeOverdue: z.boolean().default(true).describe('Include past events that are still scheduled (not completed)'),
        },
        async (args) => {
          try {
            const [upcoming, overdue] = await Promise.all([
              this.entityEventService.getUpcoming(args.entityId, args.limit),
              args.includeOverdue
                ? this.entityEventService.getOverdue(args.entityId, args.limit)
                : Promise.resolve([]),
            ]);

            if (upcoming.length === 0 && overdue.length === 0) {
              return toolEmptyResult('upcoming events');
            }

            return toolSuccess({
              upcoming: upcoming.map(e => this.formatEvent(e)),
              overdue: overdue.map(e => this.formatEvent(e)),
              counts: {
                upcoming: upcoming.length,
                overdue: overdue.length,
              },
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'get_upcoming_events');
          }
        }
      ),

      tool(
        'create_reminder',
        `Create a new reminder, meeting, deadline, or follow-up event.
Use this when the user asks to remind them about something, schedule a follow-up,
or note an upcoming deadline or meeting.`,
        {
          entityId: z.string().uuid().describe('ID of the person/organization this event relates to'),
          eventType: z.enum(['meeting', 'deadline', 'commitment', 'follow_up']).describe(
            'Type of event: "meeting" for scheduled calls/meetings, "deadline" for due dates, ' +
            '"commitment" for promises made, "follow_up" for reminders to check back'
          ),
          title: z.string().min(1).max(255).describe('Brief title for the event'),
          description: z.string().optional().describe('Detailed description or notes'),
          eventDate: z.string().optional().describe(
            'When the event occurs (ISO 8601 datetime, e.g., "2025-01-20T14:00:00Z"). ' +
            'Omit for events without specific date.'
          ),
        },
        async (args) => {
          try {
            // Validate and parse date if provided
            const eventDate = args.eventDate ? parseDate(args.eventDate) : null;

            const event = await this.entityEventService.create({
              entityId: args.entityId,
              eventType: args.eventType as EventType,
              title: args.title,
              description: args.description || null,
              eventDate,
            });

            return toolSuccess({
              created: true,
              id: event.id,
              status: event.status,
              message: `Event "${args.title}" created successfully.` +
                (eventDate ? ` Scheduled for ${eventDate.toLocaleString(DATE_LOCALE, { timeZone: DATE_TIMEZONE, dateStyle: 'long', timeStyle: 'short' })}.` : ''),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'create_reminder');
          }
        }
      ),
    ] as ToolDefinition[];
  }
}
