import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, toolEmptyResult, handleToolError, type ToolDefinition } from './tool.types';
import { ActivityService } from '../../activity/activity.service';
import { ActivityValidationService } from '../../activity/activity-validation.service';
import { ActivityMemberService } from '../../activity/activity-member.service';
import { CommitmentService } from '../../activity/commitment.service';
import {
  ActivityType,
  ActivityStatus,
  ActivityContext,
  ActivityPriority,
  ActivityMemberRole,
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
    @Inject(forwardRef(() => ActivityValidationService))
    private readonly activityValidationService: ActivityValidationService,
    @Inject(forwardRef(() => ActivityMemberService))
    private readonly activityMemberService: ActivityMemberService,
    @Inject(forwardRef(() => CommitmentService))
    private readonly commitmentService: CommitmentService,
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
            const activities = await this.activityService.getProjectsByClient(
              args.clientId,
              args.includeCompleted,
            );

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

      // ─────────────────────────────────────────────────────────────
      // Mutation tools
      // ─────────────────────────────────────────────────────────────

      tool(
        'create_activity',
        `Create a new activity (project, task, area, etc.).
Validates hierarchy rules: e.g. task can only be under project/initiative/habit/learning/event_series.
TYPES: area, business, direction, project, task, initiative, milestone, habit, learning, event_series
CONTEXT: work, personal, any, location_based
PRIORITY: critical, high, medium, low, none`,
        {
          name: z.string().min(1).max(500).describe('Activity name'),
          activityType: z.enum([
            'area', 'business', 'direction', 'project', 'task',
            'initiative', 'milestone', 'habit', 'learning', 'event_series',
          ]).describe('Type of activity to create'),
          description: z.string().optional()
            .describe('Detailed description of the activity'),
          parentId: z.string().uuid().optional()
            .describe('Parent activity ID for nesting (e.g. task under project)'),
          ownerEntityId: z.string().uuid()
            .describe('Entity ID of the owner/responsible person'),
          clientEntityId: z.string().uuid().optional()
            .describe('Entity ID of the client (for client projects)'),
          context: z.enum(['work', 'personal', 'any', 'location_based']).optional()
            .describe('Life context for the activity'),
          priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional()
            .describe('Priority level'),
          deadline: z.string().optional()
            .describe('Deadline in ISO 8601 format (e.g. "2025-03-15T18:00:00Z")'),
          tags: z.array(z.string()).optional()
            .describe('Tags for categorization (e.g. ["urgent", "frontend"])'),
        },
        async (args) => {
          try {
            // Validate hierarchy before creation
            await this.activityValidationService.validateCreate({
              activityType: args.activityType as ActivityType,
              parentId: args.parentId,
            });

            const activity = await this.activityService.create({
              name: args.name,
              activityType: args.activityType as ActivityType,
              description: args.description,
              parentId: args.parentId,
              ownerEntityId: args.ownerEntityId,
              clientEntityId: args.clientEntityId,
              context: args.context as ActivityContext,
              priority: args.priority as ActivityPriority,
              deadline: args.deadline,
              tags: args.tags,
            });

            return toolSuccess({
              message: `Activity "${activity.name}" created successfully`,
              activity: {
                id: activity.id,
                name: activity.name,
                type: activity.activityType,
                parentId: activity.parentId,
                status: activity.status,
              },
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'create_activity');
          }
        }
      ),

      tool(
        'update_activity',
        `Update an existing activity. Only provided fields are changed, others remain unchanged.
Use null to clear optional fields (description, parentId, clientEntityId, deadline, tags, progress).
Moving to a new parent validates hierarchy rules and checks for cycles.`,
        {
          activityId: z.string().uuid().describe('ID of the activity to update'),
          name: z.string().min(1).max(500).optional()
            .describe('New name for the activity'),
          description: z.string().nullable().optional()
            .describe('New description (null to clear)'),
          parentId: z.string().uuid().nullable().optional()
            .describe('New parent activity ID (null to move to root)'),
          clientEntityId: z.string().uuid().nullable().optional()
            .describe('New client entity ID (null to unlink)'),
          context: z.enum(['work', 'personal', 'any', 'location_based']).optional()
            .describe('New life context'),
          priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional()
            .describe('New priority level'),
          deadline: z.string().nullable().optional()
            .describe('New deadline ISO 8601 (null to clear)'),
          tags: z.array(z.string()).nullable().optional()
            .describe('New tags array (null to clear)'),
          progress: z.number().int().min(0).max(100).optional()
            .describe('Progress percentage 0-100'),
        },
        async (args) => {
          try {
            // If parentId is changing, validate hierarchy and cycles
            if (args.parentId !== undefined) {
              const current = await this.activityService.findOne(args.activityId);
              await this.activityValidationService.validateUpdate({
                activityId: args.activityId,
                activityType: current.activityType,
                newParentId: args.parentId,
              });
            }

            const activity = await this.activityService.update(args.activityId, {
              name: args.name,
              description: args.description,
              parentId: args.parentId,
              clientEntityId: args.clientEntityId,
              context: args.context as ActivityContext,
              priority: args.priority as ActivityPriority,
              deadline: args.deadline,
              tags: args.tags,
              progress: args.progress,
            });

            return toolSuccess({
              message: `Activity "${activity.name}" updated successfully`,
              activity: {
                id: activity.id,
                name: activity.name,
                type: activity.activityType,
                status: activity.status,
              },
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'update_activity');
          }
        }
      ),

      tool(
        'manage_activity_members',
        `Add or remove a member from an activity.
Use to assign people to projects/tasks or remove them.
Duplicate adds are ignored (idempotent).
ROLES: owner, member, observer, assignee, reviewer, client, consultant`,
        {
          activityId: z.string().uuid().describe('Activity ID'),
          action: z.enum(['add', 'remove']).describe('Action: add or remove member'),
          entityId: z.string().uuid().describe('Entity ID of the person/organization'),
          role: z.enum(['owner', 'member', 'observer', 'assignee', 'reviewer', 'client', 'consultant'])
            .default('member')
            .describe('Role of the member in the activity (default: member)'),
        },
        async (args) => {
          try {
            if (args.action === 'add') {
              const member = await this.activityMemberService.addMember({
                activityId: args.activityId,
                entityId: args.entityId,
                role: args.role as ActivityMemberRole,
              });

              if (member) {
                return toolSuccess({
                  message: `Member added to activity with role "${args.role}"`,
                  member: {
                    id: member.id,
                    activityId: member.activityId,
                    entityId: member.entityId,
                    role: member.role,
                  },
                });
              }

              return toolSuccess({
                message: `Member already exists in this activity with role "${args.role}" (no changes made)`,
              });
            }

            // action === 'remove'
            await this.activityMemberService.deactivateMember(
              args.activityId,
              args.entityId,
            );

            return toolSuccess({
              message: 'Member removed from activity',
              activityId: args.activityId,
              entityId: args.entityId,
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'manage_activity_members');
          }
        }
      ),

      tool(
        'assign_commitment_to_activity',
        `Link or unlink a commitment (promise/obligation) to an activity.
Use to associate commitments with relevant projects or tasks.
Pass null for activityId to unlink.`,
        {
          commitmentId: z.string().uuid().describe('Commitment ID to update'),
          activityId: z.string().uuid().nullable()
            .describe('Activity ID to link to (null to unlink from current activity)'),
        },
        async (args) => {
          try {
            const commitment = await this.commitmentService.update(
              args.commitmentId,
              { activityId: args.activityId ?? undefined },
            );

            return toolSuccess({
              message: args.activityId
                ? `Commitment linked to activity`
                : `Commitment unlinked from activity`,
              commitment: {
                id: commitment.id,
                title: commitment.title,
                activityId: commitment.activityId ?? null,
              },
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'assign_commitment_to_activity');
          }
        }
      ),
    ] as ToolDefinition[];
  }
}
