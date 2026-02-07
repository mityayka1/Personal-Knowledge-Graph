import { Injectable, Logger } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  toolSuccess,
  toolEmptyResult,
  handleToolError,
  type ToolDefinition,
} from '../claude-agent/tools/tool.types';
import { DataQualityService } from './data-quality.service';

/**
 * Provider for data quality audit tools.
 *
 * Enables Claude to:
 * - Run comprehensive data quality audits
 * - Find duplicate projects by name similarity
 * - Merge duplicate activities
 * - Find orphaned tasks without valid parents
 * - Get data quality reports
 * - Auto-fix detected data quality issues (duplicates, orphans, missing clients)
 */
@Injectable()
export class DataQualityToolsProvider {
  private readonly logger = new Logger(DataQualityToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  constructor(private readonly dataQualityService: DataQualityService) {}

  /**
   * Check if tools are available
   */
  hasTools(): boolean {
    return true;
  }

  /**
   * Get data quality tools (cached)
   */
  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
      this.logger.debug(`Created ${this.cachedTools.length} data quality tools`);
    }
    return this.cachedTools;
  }

  /**
   * Create tool definitions
   */
  private createTools(): ToolDefinition[] {
    return [
      tool(
        'run_data_quality_audit',
        `Run comprehensive data quality audit across all activities, commitments, and relations.
Returns a report with metrics (duplicates, orphans, missing clients, coverage rates) and detected issues.
The report is saved to the database for future reference.`,
        {},
        async () => {
          try {
            const report = await this.dataQualityService.runFullAudit();

            return toolSuccess({
              reportId: report.id,
              reportDate: report.reportDate.toISOString(),
              status: report.status,
              metrics: report.metrics,
              issuesCount: report.issues.length,
              issues: report.issues.map((issue, index) => ({
                index,
                type: issue.type,
                severity: issue.severity,
                activityId: issue.activityId,
                activityName: issue.activityName,
                description: issue.description,
                suggestedAction: issue.suggestedAction,
              })),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'run_data_quality_audit');
          }
        },
      ),

      tool(
        'find_duplicate_projects',
        `Find activities with similar or identical names (case-insensitive) and same type.
Uses exact normalized name matching (LOWER). Returns groups of duplicates with their IDs for merging.
Use merge_activities tool to resolve found duplicates.`,
        {},
        async () => {
          try {
            const groups = await this.dataQualityService.findDuplicateProjects();

            if (groups.length === 0) {
              return toolEmptyResult(
                'duplicate activities',
                'All activity names are unique. No duplicates detected.',
              );
            }

            return toolSuccess({
              totalGroups: groups.length,
              groups: groups.map((g) => ({
                name: g.name,
                type: g.type,
                count: g.count,
                activities: g.activities.map((a) => ({
                  id: a.id,
                  name: a.name,
                  status: a.status,
                  createdAt: a.createdAt.toISOString(),
                })),
              })),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'find_duplicate_projects');
          }
        },
      ),

      tool(
        'merge_activities',
        `Merge duplicate activities into one. Keeps the target activity and archives the others.
Transfers children, members (skipping duplicates), and commitments to the kept activity.
Use find_duplicate_projects first to identify duplicates.`,
        {
          keepId: z
            .string()
            .uuid()
            .describe(
              'UUID of the activity to keep (primary). This activity will receive all children, members, and commitments.',
            ),
          mergeIds: z
            .array(z.string().uuid())
            .min(1)
            .describe(
              'UUIDs of activities to merge into the kept one. These will be archived after merge.',
            ),
        },
        async (args) => {
          try {
            const result = await this.dataQualityService.mergeActivities(
              args.keepId,
              args.mergeIds,
            );

            return toolSuccess({
              message: `Successfully merged ${args.mergeIds.length} activities into "${result.name}"`,
              keptActivity: {
                id: result.id,
                name: result.name,
                type: result.activityType,
                status: result.status,
              },
              mergedCount: args.mergeIds.length,
              mergedIds: args.mergeIds,
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'merge_activities');
          }
        },
      ),

      tool(
        'find_orphaned_tasks',
        `Find tasks without a valid parent activity.
Returns tasks that either have no parentId or reference a deleted/non-existent parent.
These tasks should be assigned to an appropriate project or initiative.`,
        {},
        async () => {
          try {
            const orphans = await this.dataQualityService.findOrphanedTasks();

            if (orphans.length === 0) {
              return toolEmptyResult(
                'orphaned tasks',
                'All tasks have valid parent activities.',
              );
            }

            return toolSuccess({
              total: orphans.length,
              orphanedTasks: orphans.map((t) => ({
                id: t.id,
                name: t.name,
                status: t.status,
                createdAt: t.createdAt.toISOString(),
              })),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'find_orphaned_tasks');
          }
        },
      ),

      tool(
        'get_data_quality_report',
        `Get the latest or a specific data quality report.
Reports contain metrics, detected issues, and resolution status.
Run run_data_quality_audit first if no reports exist.`,
        {
          reportId: z
            .string()
            .uuid()
            .optional()
            .describe(
              'Specific report UUID. If not provided, returns the latest report.',
            ),
        },
        async (args) => {
          try {
            const report = args.reportId
              ? await this.dataQualityService.getReportById(args.reportId)
              : await this.dataQualityService.getLatestReport();

            if (!report) {
              return toolEmptyResult(
                'data quality reports',
                'No reports exist yet. Run run_data_quality_audit to create one.',
              );
            }

            return toolSuccess({
              id: report.id,
              reportDate: report.reportDate.toISOString(),
              status: report.status,
              metrics: report.metrics,
              issuesCount: report.issues.length,
              issues: report.issues.map((issue, index) => ({
                index,
                type: issue.type,
                severity: issue.severity,
                activityId: issue.activityId,
                activityName: issue.activityName,
                description: issue.description,
                suggestedAction: issue.suggestedAction,
              })),
              resolutions: report.resolutions?.map((r) => ({
                issueIndex: r.issueIndex,
                resolvedAt: r.resolvedAt,
                resolvedBy: r.resolvedBy,
                action: r.action,
              })) || [],
              createdAt: report.createdAt.toISOString(),
              updatedAt: report.updatedAt.toISOString(),
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'get_data_quality_report');
          }
        },
      ),

      tool(
        'auto_fix_data_quality',
        `Auto-fix detected data quality issues. Sequentially runs: 1) merge duplicate activities, 2) assign orphaned tasks to parents, 3) resolve missing client entities. Each step is independent — failures in one step won't affect others.`,
        {
          fixDuplicates: z
            .boolean()
            .default(true)
            .describe(
              'Merge duplicate activity groups found by name similarity. Default: true.',
            ),
          fixOrphans: z
            .boolean()
            .default(true)
            .describe(
              'Assign orphaned tasks (no valid parent) to appropriate parent projects. Default: true.',
            ),
          fixClients: z
            .boolean()
            .default(true)
            .describe(
              'Resolve missing client entities on activities. Default: true.',
            ),
        },
        async (args) => {
          try {
            const errors: string[] = [];
            let duplicates = null;
            let orphans = null;
            let clients = null;

            // Step 1: Merge duplicates
            if (args.fixDuplicates) {
              try {
                duplicates =
                  await this.dataQualityService.autoMergeAllDuplicates();
              } catch (error) {
                const msg =
                  error instanceof Error ? error.message : String(error);
                errors.push(`fixDuplicates failed: ${msg}`);
                this.logger.error(
                  `auto_fix_data_quality: fixDuplicates failed: ${msg}`,
                );
              }
            }

            // Step 2: Assign orphaned tasks
            if (args.fixOrphans) {
              try {
                orphans =
                  await this.dataQualityService.autoAssignOrphanedTasks();
              } catch (error) {
                const msg =
                  error instanceof Error ? error.message : String(error);
                errors.push(`fixOrphans failed: ${msg}`);
                this.logger.error(
                  `auto_fix_data_quality: fixOrphans failed: ${msg}`,
                );
              }
            }

            // Step 3: Resolve missing clients
            if (args.fixClients) {
              try {
                clients =
                  await this.dataQualityService.autoResolveClients();
              } catch (error) {
                const msg =
                  error instanceof Error ? error.message : String(error);
                errors.push(`fixClients failed: ${msg}`);
                this.logger.error(
                  `auto_fix_data_quality: fixClients failed: ${msg}`,
                );
              }
            }

            return toolSuccess({
              summary: {
                duplicatesMerged: duplicates?.totalMerged ?? 0,
                orphansResolved: orphans?.resolved ?? 0,
                clientsResolved: clients?.resolved ?? 0,
                errors,
              },
              duplicates,
              orphans,
              clients,
            });
          } catch (error) {
            return handleToolError(
              error,
              this.logger,
              'auto_fix_data_quality',
            );
          }
        },
      ),
    ] as ToolDefinition[];
  }
}
