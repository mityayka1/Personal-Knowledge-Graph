import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, toolEmptyResult, handleToolError, type ToolDefinition } from './tool.types';
import { ActivityService } from '../../activity/activity.service';
import {
  ActivityType,
  ActivityStatus,
  ActivityContext,
  ActivityPriority,
} from '@pkg/entities';

/**
 * Provider for activity-related tools (projects, tasks, areas)
 *
 * Enables Claude to:
 * - List and search activities by type, status, context
 * - Navigate activity hierarchy (tree operations)
 * - Update activity status (complete, pause, archive)
 * - Get upcoming deadlines
 */
@Injectable()
export class ActivityToolsProvider {
  private readonly logger = new Logger(ActivityToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  constructor(
    @Inject(forwardRef(() => ActivityService))
    private readonly activityService: ActivityService,
  ) {}

  /**
   * Check if tools are available
   */
  hasTools(): boolean {
    return !!this.activityService;
  }

  /**
   * Get activity tools (cached)
   */
  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
      this.logger.debug(`Created ${this.cachedTools.length} activity tools`);
    }
    return this.cachedTools;
  }

  /**
   * Create tool definitions
   */
  private createTools(): ToolDefinition[] {
    return [
      tool(
        'list_activities',
        `List activities with filters. Use to find projects, tasks, areas, directions.
Returns activities sorted by last update. Supports filtering by type, status, context, parent, client.

TYPES: area (life area), business, direction, project, task, initiative, milestone, habit, learning
STATUS: active, idea, paused, completed, cancelled, archived
CONTEXT: work, personal, any, location_based`,
        {
          type: z.enum([
            'area', 'business', 'direction', 'project', 'task',
            'initiative', 'milestone', 'habit', 'learning', 'event_series',
          ]).optional().describe('Filter by activity type'),
          status: z.enum(['active', 'idea', 'paused', 'completed', 'cancelled', 'archived', 'all'])
            .optional()
            .default('active')
            .describe('Filter by status. Use "all" to include all statuses'),
          context: z.enum(['work', 'personal', 'any', 'location_based'])
            .optional()
            .describe('Filter by life context'),
          parentId: z.string().uuid().optional()
            .describe('Get children of specific activity'),
          clientId: z.string().uuid().optional()
            .describe('Filter by client entity ID'),
          hasDeadline: z.boolean().optional()
            .describe('Filter activities with/without deadline'),
          limit: z.number().int().min(1).max(100).default(20)
            .describe('Maximum number of results'),
        },
        async (args) => {
          try {
            const statusFilter = args.status === 'all'
              ? undefined
              : args.status as ActivityStatus;

            const result = await this.activityService.findAll({
              type: args.type as ActivityType,
              status: statusFilter,
              context: args.context as ActivityContext,
              parentId: args.parentId,
              clientEntityId: args.clientId,
              hasDeadline: args.hasDeadline,
              limit: args.limit,
            });

            if (result.items.length === 0) {
              return toolEmptyResult('activities matching your criteria');
            }

            const activities = result.items.map(a => ({
              id: a.id,
              name: a.name,
              type: a.activityType,
              status: a.status,
              priority: a.priority,
              context: a.context,
              deadline: a.deadline?.toISOString() || null,
              progress: a.progress,
              parentId: a.parentId,
              client: a.clientEntity?.name || null,
              depth: a.depth,
            }));

            return toolSuccess({
              total: result.total,
              showing: activities.length,
              activities,
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'list_activities');
          }
        }
      ),

      tool(
        'get_activity_tree',
        `Get full hierarchy tree of an activity with all descendants.
Useful to understand project structure with all nested tasks and initiatives.
Returns nested JSON with children arrays.`,
        {
          activityId: z.string().uuid().optional()
            .describe('Root activity ID. If not provided, returns all root activities with their trees'),
        },
        async (args) => {
          try {
            const tree = await this.activityService.getActivityTree(args.activityId);

            if (tree.length === 0) {
              return toolEmptyResult('activity tree');
            }

            // Format tree for readability
            const formatNode = (node: any): any => ({
              id: node.id,
              name: node.name,
              type: node.activityType,
              status: node.status,
              deadline: node.deadline?.toISOString() || null,
              children: node.children?.map(formatNode) || [],
            });

            const formattedTree = tree.map(formatNode);

            return toolSuccess(formattedTree);
          } catch (error) {
            return handleToolError(error, this.logger, 'get_activity_tree');
          }
        }
      ),

      tool(
        'get_activity_details',
        `Get detailed information about a specific activity.
Returns full activity data including description, dates, members, progress.`,
        {
          activityId: z.string().uuid().describe('Activity ID'),
        },
        async (args) => {
          try {
            const activity = await this.activityService.findOne(args.activityId);

            return toolSuccess({
              id: activity.id,
              name: activity.name,
              type: activity.activityType,
              description: activity.description,
              status: activity.status,
              priority: activity.priority,
              context: activity.context,
              deadline: activity.deadline?.toISOString() || null,
              startDate: activity.startDate?.toISOString() || null,
              endDate: activity.endDate?.toISOString() || null,
              progress: activity.progress,
              parentId: activity.parentId,
              parent: activity.parent ? {
                id: activity.parent.id,
                name: activity.parent.name,
              } : null,
              owner: activity.ownerEntity ? {
                id: activity.ownerEntity.id,
                name: activity.ownerEntity.name,
              } : null,
              client: activity.clientEntity ? {
                id: activity.clientEntity.id,
                name: activity.clientEntity.name,
              } : null,
              tags: activity.tags,
              metadata: activity.metadata,
              recurrenceRule: activity.recurrenceRule,
              createdAt: activity.createdAt.toISOString(),
              updatedAt: activity.updatedAt.toISOString(),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'get_activity_details');
          }
        }
      ),

      tool(
        'update_activity_status',
        `Update activity status. Use to mark tasks as completed, pause projects, etc.
Available actions: complete, cancel, pause, resume, archive.`,
        {
          activityId: z.string().uuid().describe('Activity ID'),
          action: z.enum(['complete', 'cancel', 'pause', 'resume', 'archive'])
            .describe('Status action to perform'),
        },
        async (args) => {
          try {
            let activity;
            switch (args.action) {
              case 'complete':
                activity = await this.activityService.complete(args.activityId);
                break;
              case 'cancel':
                activity = await this.activityService.cancel(args.activityId);
                break;
              case 'pause':
                activity = await this.activityService.pause(args.activityId);
                break;
              case 'resume':
                activity = await this.activityService.resume(args.activityId);
                break;
              case 'archive':
                activity = await this.activityService.archive(args.activityId);
                break;
            }

            return toolSuccess({
              message: `Activity ${args.action}d successfully`,
              activity: {
                id: activity.id,
                name: activity.name,
                status: activity.status,
              },
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'update_activity_status');
          }
        }
      ),

      tool(
        'get_upcoming_deadlines',
        `Get activities with upcoming deadlines.
Returns active projects and tasks sorted by deadline (soonest first).
Useful for daily planning and deadline tracking.`,
        {
          includeOverdue: z.boolean().default(true)
            .describe('Include overdue activities'),
          context: z.enum(['work', 'personal', 'any']).optional()
            .describe('Filter by context'),
        },
        async (args) => {
          try {
            const upcomingDeadlines = await this.activityService.getActiveProjectsWithDeadlines();

            // Filter by context if specified
            let activities = upcomingDeadlines;
            if (args.context && args.context !== 'any') {
              activities = activities.filter(a =>
                a.context === args.context || a.context === ActivityContext.ANY
              );
            }

            // Split into overdue and upcoming
            const now = new Date();
            const overdue = activities.filter(a => a.deadline && a.deadline < now);
            const upcoming = activities.filter(a => a.deadline && a.deadline >= now);

            const formatActivity = (a: any) => ({
              id: a.id,
              name: a.name,
              type: a.activityType,
              deadline: a.deadline?.toISOString(),
              status: a.status,
              priority: a.priority,
              client: a.clientEntity?.name || null,
              parent: a.parent?.name || null,
            });

            const result: any = {
              upcoming: upcoming.map(formatActivity),
              upcomingCount: upcoming.length,
            };

            if (args.includeOverdue) {
              result.overdue = overdue.map(formatActivity);
              result.overdueCount = overdue.length;
            }

            if (upcoming.length === 0 && (!args.includeOverdue || overdue.length === 0)) {
              return toolEmptyResult('activities with deadlines');
            }

            return toolSuccess(result);
          } catch (error) {
            return handleToolError(error, this.logger, 'get_upcoming_deadlines');
          }
        }
      ),

      tool(
        'get_activities_by_client',
        `Get all activities for a specific client.
Useful to prepare for client meetings or review client project portfolio.`,
        {
          clientId: z.string().uuid().describe('Client entity ID'),
          includeCompleted: z.boolean().default(false)
            .describe('Include completed projects'),
        },
        async (args) => {
          try {
            const activities = await this.activityService.getProjectsByClient(args.clientId);

            if (activities.length === 0) {
              return toolEmptyResult('activities for this client');
            }

            return toolSuccess({
              total: activities.length,
              activities: activities.map(a => ({
                id: a.id,
                name: a.name,
                type: a.activityType,
                status: a.status,
                priority: a.priority,
                deadline: a.deadline?.toISOString() || null,
                progress: a.progress,
              })),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'get_activities_by_client');
          }
        }
      ),

      tool(
        'find_activity_by_name',
        `Search for an activity by name (fuzzy match).
Use when you need to find an activity mentioned in conversation.
Returns the best matching active activity.`,
        {
          name: z.string().min(2).describe('Activity name or partial name to search'),
        },
        async (args) => {
          try {
            const activity = await this.activityService.findByMention(args.name);

            if (!activity) {
              return toolEmptyResult(
                `activity matching "${args.name}"`,
                'Try a different name or use list_activities to browse.'
              );
            }

            return toolSuccess({
              id: activity.id,
              name: activity.name,
              type: activity.activityType,
              status: activity.status,
              priority: activity.priority,
              context: activity.context,
              deadline: activity.deadline?.toISOString() || null,
              parentId: activity.parentId,
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'find_activity_by_name');
          }
        }
      ),

      tool(
        'get_today_deadlines',
        `Get activities with deadlines today.
Useful for daily morning brief.`,
        {},
        async () => {
          try {
            const activities = await this.activityService.getTodayDeadlines();

            if (activities.length === 0) {
              return toolSuccess({
                message: 'No deadlines today',
                activities: [],
              });
            }

            return toolSuccess({
              count: activities.length,
              activities: activities.map(a => ({
                id: a.id,
                name: a.name,
                type: a.activityType,
                deadline: a.deadline?.toISOString(),
                priority: a.priority,
              })),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'get_today_deadlines');
          }
        }
      ),
    ] as ToolDefinition[];
  }
}
