import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, toolError, toolNotFound } from './tool.types';
import type { EntityEventService } from '../../entity-event/entity-event.service';
import { EventType, type EntityEvent } from '@pkg/entities';

/**
 * Create event-related tools (reminders, meetings, deadlines)
 */
export function createEventTools(entityEventService: EntityEventService) {
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
            entityEventService.getUpcoming(args.entityId, args.limit),
            args.includeOverdue
              ? entityEventService.getOverdue(args.entityId, args.limit)
              : Promise.resolve([]),
          ]);

          if (upcoming.length === 0 && overdue.length === 0) {
            return toolNotFound('upcoming events');
          }

          const formatEvent = (e: EntityEvent) => ({
            id: e.id,
            type: e.eventType,
            title: e.title || '(без названия)',
            description: e.description,
            date: e.eventDate?.toISOString() || null,
            status: e.status,
            entity: e.entity?.name || null,
          });

          return toolSuccess({
            upcoming: upcoming.map(formatEvent),
            overdue: overdue.map(formatEvent),
            counts: {
              upcoming: upcoming.length,
              overdue: overdue.length,
            },
          });
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error));
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
          const event = await entityEventService.create({
            entityId: args.entityId,
            eventType: args.eventType as EventType,
            title: args.title,
            description: args.description || null,
            eventDate: args.eventDate ? new Date(args.eventDate) : null,
          });

          return toolSuccess({
            created: true,
            id: event.id,
            status: event.status,
            message: `Event "${args.title}" created successfully.` +
              (args.eventDate ? ` Scheduled for ${new Date(args.eventDate).toLocaleString()}.` : ''),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('not found')) {
            return toolError('Entity not found. Please verify the entity ID or search for the person/organization first.');
          }
          return toolError(message);
        }
      }
    ),
  ];
}
