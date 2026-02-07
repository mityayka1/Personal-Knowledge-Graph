import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In, IsNull, Not } from 'typeorm';
import {
  DataQualityReport,
  DataQualityReportStatus,
  DataQualityIssueType,
  DataQualityIssueSeverity,
  DataQualityMetrics,
  DataQualityIssue,
  DataQualityResolution,
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityMember,
  Commitment,
  EntityRelation,
  RelationSource,
} from '@pkg/entities';
import { OrphanResolutionService, OrphanResolutionResult } from './orphan-resolution.service';
import {
  ClientResolutionService,
  ClientResolutionMethod,
} from '../extraction/client-resolution.service';

/**
 * Group of duplicate activities (same LOWER(name) and type)
 */
export interface DuplicateGroup {
  name: string;
  type: ActivityType;
  count: number;
  activities: Array<{
    id: string;
    name: string;
    status: ActivityStatus;
    createdAt: Date;
  }>;
}

/**
 * Activity member coverage stats
 */
export interface MemberCoverage {
  total: number;
  withMembers: number;
  rate: number;
}

/**
 * Commitment linkage stats
 */
export interface CommitmentLinkage {
  total: number;
  linked: number;
  rate: number;
}

/**
 * Field fill rate stats
 */
export interface FieldFillRate {
  total: number;
  avgFillRate: number;
}

/**
 * Result of automatic client resolution batch.
 */
export interface ClientResolutionBatchResult {
  resolved: number;
  unresolved: number;
  details: Array<{
    activityId: string;
    activityName: string;
    clientEntityId: string;
    clientName: string;
    method: ClientResolutionMethod;
  }>;
}

/**
 * Result of automatic duplicate merging.
 */
export interface AutoMergeResult {
  mergedGroups: number;
  totalMerged: number;
  errors: Array<{ group: string; error: string }>;
  details: Array<{ keptId: string; keptName: string; mergedIds: string[] }>;
}

/**
 * Raw data collected for metrics calculation.
 * Used by both runFullAudit() and getCurrentMetrics() to avoid duplicate queries.
 */
interface MetricsData {
  totalActivities: number;
  duplicates: DuplicateGroup[];
  orphanedTasks: Activity[];
  missingClient: Activity[];
  memberCoverage: MemberCoverage;
  commitmentLinkage: CommitmentLinkage;
  inferredRelations: number;
  fieldFill: FieldFillRate;
}

/**
 * DataQualityService — runs data quality audits, detects issues,
 * and provides merge/resolution capabilities.
 *
 * Detects:
 * - Duplicate projects (same normalized name + type)
 * - Orphaned tasks (no valid parent)
 * - Missing client entities on PROJECT/BUSINESS
 * - Activities without members
 * - Unlinked commitments (no activityId)
 * - Empty fields (description, priority, deadline, tags)
 */
@Injectable()
export class DataQualityService {
  private readonly logger = new Logger(DataQualityService.name);

  constructor(
    @InjectRepository(DataQualityReport)
    private readonly reportRepo: Repository<DataQualityReport>,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(ActivityMember)
    private readonly memberRepo: Repository<ActivityMember>,
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
    @InjectRepository(EntityRelation)
    private readonly relationRepo: Repository<EntityRelation>,
    private readonly dataSource: DataSource,
    private readonly orphanResolutionService: OrphanResolutionService,
    private readonly clientResolutionService: ClientResolutionService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Full Audit
  // ─────────────────────────────────────────────────────────────

  /**
   * Run a comprehensive data quality audit.
   * Collects all metrics, detects issues, and persists a DataQualityReport.
   *
   * Fetches shared data (duplicates, orphans, missingClients) once
   * and builds both metrics and issues from it — avoiding double queries.
   */
  async runFullAudit(): Promise<DataQualityReport> {
    this.logger.log('Starting full data quality audit...');

    const data = await this.collectMetricsData();
    const metrics = this.buildMetrics(data);
    const issues = this.buildIssuesFromData(data.duplicates, data.orphanedTasks, data.missingClient);

    const report = this.reportRepo.create({
      reportDate: new Date(),
      metrics,
      issues,
      resolutions: null,
      status: DataQualityReportStatus.PENDING,
    });

    const saved = await this.reportRepo.save(report);

    this.logger.log(
      `Audit complete: ${issues.length} issues found, report ${saved.id}`,
    );

    return saved;
  }

  // ─────────────────────────────────────────────────────────────
  // Duplicate Detection
  // ─────────────────────────────────────────────────────────────

  /**
   * Find activities with duplicate names (case-insensitive) and same type.
   * Uses GROUP BY LOWER(name), activity_type HAVING COUNT(*) > 1.
   */
  async findDuplicateProjects(): Promise<DuplicateGroup[]> {
    // Find groups with duplicate normalized names
    const duplicateGroups = await this.activityRepo
      .createQueryBuilder('a')
      .select('LOWER(a.name)', 'lowerName')
      .addSelect('a.activity_type', 'activityType')
      .addSelect('COUNT(*)', 'cnt')
      .where('a.deleted_at IS NULL')
      .groupBy('LOWER(a.name)')
      .addGroupBy('a.activity_type')
      .having('COUNT(*) > 1')
      .getRawMany();

    const result: DuplicateGroup[] = [];

    for (const group of duplicateGroups) {
      const activities = await this.activityRepo
        .createQueryBuilder('a')
        .select(['a.id', 'a.name', 'a.status', 'a.createdAt'])
        .where('LOWER(a.name) = :name', { name: group.lowerName })
        .andWhere('a.activity_type = :type', { type: group.activityType })
        .andWhere('a.deleted_at IS NULL')
        .orderBy('a.created_at', 'ASC')
        .getMany();

      result.push({
        name: group.lowerName,
        type: group.activityType as ActivityType,
        count: parseInt(group.cnt, 10),
        activities: activities.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          createdAt: a.createdAt,
        })),
      });
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Orphan Detection
  // ─────────────────────────────────────────────────────────────

  /**
   * Find tasks without a valid parent.
   * A task is orphaned if:
   * - parentId is NULL (tasks should have a parent)
   * - parentId references a non-existent Activity
   */
  async findOrphanedTasks(): Promise<Activity[]> {
    // Tasks without parentId
    const tasksWithoutParent = await this.activityRepo.find({
      where: {
        activityType: ActivityType.TASK,
        parentId: IsNull(),
        deletedAt: IsNull(),
      },
      select: ['id', 'name', 'status', 'activityType', 'createdAt'],
    });

    // Tasks with parentId referencing non-existent Activity
    const tasksWithInvalidParent = await this.activityRepo
      .createQueryBuilder('a')
      .leftJoin('activities', 'p', 'p.id = a.parent_id AND p.deleted_at IS NULL')
      .where('a.activity_type = :type', { type: ActivityType.TASK })
      .andWhere('a.parent_id IS NOT NULL')
      .andWhere('p.id IS NULL')
      .andWhere('a.deleted_at IS NULL')
      .select(['a.id', 'a.name', 'a.status', 'a.activity_type', 'a.created_at'])
      .getMany();

    return [...tasksWithoutParent, ...tasksWithInvalidParent];
  }

  // ─────────────────────────────────────────────────────────────
  // Missing Client Detection
  // ─────────────────────────────────────────────────────────────

  /**
   * Find PROJECT or BUSINESS activities without a clientEntityId.
   */
  async findMissingClientEntity(): Promise<Activity[]> {
    return this.activityRepo.find({
      where: [
        {
          activityType: ActivityType.PROJECT,
          clientEntityId: IsNull(),
          deletedAt: IsNull(),
        },
        {
          activityType: ActivityType.BUSINESS,
          clientEntityId: IsNull(),
          deletedAt: IsNull(),
        },
      ],
      select: ['id', 'name', 'activityType', 'status', 'createdAt'],
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Coverage Metrics
  // ─────────────────────────────────────────────────────────────

  /**
   * Calculate what percentage of activities have at least one ActivityMember.
   */
  async calculateActivityMemberCoverage(): Promise<MemberCoverage> {
    const total = await this.activityRepo.count({
      where: { deletedAt: IsNull() },
    });

    if (total === 0) {
      return { total: 0, withMembers: 0, rate: 0 };
    }

    // Count distinct activityIds that have members
    const result = await this.memberRepo
      .createQueryBuilder('m')
      .select('COUNT(DISTINCT m.activity_id)', 'count')
      .innerJoin('activities', 'a', 'a.id = m.activity_id AND a.deleted_at IS NULL')
      .getRawOne();

    const withMembers = parseInt(result?.count || '0', 10);

    return {
      total,
      withMembers,
      rate: Math.round((withMembers / total) * 100) / 100,
    };
  }

  /**
   * Calculate what percentage of Commitments have an activityId.
   */
  async calculateCommitmentLinkageRate(): Promise<CommitmentLinkage> {
    const total = await this.commitmentRepo.count({
      where: { deletedAt: IsNull() },
    });

    if (total === 0) {
      return { total: 0, linked: 0, rate: 0 };
    }

    const linked = await this.commitmentRepo.count({
      where: {
        activityId: Not(IsNull()),
        deletedAt: IsNull(),
      },
    });

    return {
      total,
      linked,
      rate: Math.round((linked / total) * 100) / 100,
    };
  }

  /**
   * Count EntityRelations with source = EXTRACTED or INFERRED.
   */
  async countInferredRelations(): Promise<number> {
    return this.relationRepo.count({
      where: [
        { source: RelationSource.EXTRACTED },
        { source: RelationSource.INFERRED },
      ],
    });
  }

  /**
   * Calculate average fill rate for key fields: description, priority, deadline, tags.
   * Returns the percentage of non-null fields across all active activities.
   */
  async calculateFieldFillRate(): Promise<FieldFillRate> {
    const activities = await this.activityRepo.find({
      where: { deletedAt: IsNull() },
      select: ['id', 'description', 'priority', 'deadline', 'tags'],
    });

    const total = activities.length;
    if (total === 0) {
      return { total: 0, avgFillRate: 0 };
    }

    let totalFields = 0;
    let filledFields = 0;
    const fieldsToCheck = 4; // description, priority, deadline, tags

    for (const activity of activities) {
      totalFields += fieldsToCheck;
      if (activity.description) filledFields++;
      if (activity.priority) filledFields++;
      if (activity.deadline) filledFields++;
      if (activity.tags && activity.tags.length > 0) filledFields++;
    }

    return {
      total,
      avgFillRate: Math.round((filledFields / totalFields) * 100) / 100,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Aggregated Metrics
  // ─────────────────────────────────────────────────────────────

  /**
   * Collect all metrics without creating a report.
   */
  async getCurrentMetrics(): Promise<DataQualityMetrics> {
    const data = await this.collectMetricsData();
    return this.buildMetrics(data);
  }

  // ─────────────────────────────────────────────────────────────
  // Report Access
  // ─────────────────────────────────────────────────────────────

  /**
   * Get paginated list of data quality reports, ordered by reportDate DESC.
   */
  async getReports(
    limit = 20,
    offset = 0,
  ): Promise<{ data: DataQualityReport[]; total: number }> {
    const [data, total] = await this.reportRepo.findAndCount({
      order: { reportDate: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { data, total };
  }

  /**
   * Get the latest data quality report.
   */
  async getLatestReport(): Promise<DataQualityReport | null> {
    return this.reportRepo.findOne({
      where: {},
      order: { reportDate: 'DESC' },
    });
  }

  /**
   * Get a specific report by ID.
   */
  async getReportById(id: string): Promise<DataQualityReport> {
    const report = await this.reportRepo.findOne({ where: { id } });
    if (!report) {
      throw new NotFoundException(`DataQualityReport ${id} not found`);
    }
    return report;
  }

  // ─────────────────────────────────────────────────────────────
  // Issue Resolution
  // ─────────────────────────────────────────────────────────────

  /**
   * Add a resolution entry to a report issue.
   */
  async resolveIssue(
    reportId: string,
    issueIndex: number,
    action: string,
  ): Promise<DataQualityReport> {
    const report = await this.getReportById(reportId);

    if (issueIndex < 0 || issueIndex >= report.issues.length) {
      throw new BadRequestException(
        `Issue index ${issueIndex} out of range (0-${report.issues.length - 1})`,
      );
    }

    const resolution: DataQualityResolution = {
      issueIndex,
      resolvedAt: new Date(),
      resolvedBy: 'manual',
      action,
    };

    const resolutions = report.resolutions ?? [];
    resolutions.push(resolution);
    report.resolutions = resolutions;

    // Update status if all issues are resolved
    const resolvedIndices = new Set(resolutions.map((r) => r.issueIndex));
    if (resolvedIndices.size >= report.issues.length) {
      report.status = DataQualityReportStatus.RESOLVED;
    } else {
      report.status = DataQualityReportStatus.REVIEWED;
    }

    return this.reportRepo.save(report);
  }

  // ─────────────────────────────────────────────────────────────
  // Merge Duplicates
  // ─────────────────────────────────────────────────────────────

  /**
   * Merge duplicate activities into one.
   *
   * Strategy (all within a single transaction):
   * 1. Move children from merged activities to keep activity
   * 2. Move members from merged activities to keep activity (skip duplicates)
   * 3. Reassign commitments from merged activities to keep activity
   * 4. Soft-delete merged activities (status = ARCHIVED)
   */
  async mergeActivities(
    keepId: string,
    mergeIds: string[],
  ): Promise<Activity> {
    // R6: Guard against keepId appearing in mergeIds
    if (mergeIds.includes(keepId)) {
      throw new BadRequestException('keepId must not appear in mergeIds');
    }

    const keepActivity = await this.activityRepo.findOne({
      where: { id: keepId, deletedAt: IsNull() },
    });

    if (!keepActivity) {
      throw new NotFoundException(`Activity to keep (${keepId}) not found`);
    }

    const activitiesToMerge = await this.activityRepo.find({
      where: {
        id: In(mergeIds),
        deletedAt: IsNull(),
      },
    });

    if (activitiesToMerge.length !== mergeIds.length) {
      const foundIds = activitiesToMerge.map((a) => a.id);
      const missingIds = mergeIds.filter((id) => !foundIds.includes(id));
      throw new NotFoundException(
        `Activities to merge not found: ${missingIds.join(', ')}`,
      );
    }

    this.logger.log(
      `Merging ${mergeIds.length} activities into ${keepId} (${keepActivity.name})`,
    );

    // C1: All write operations within a single transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Move children to keep activity
      await queryRunner.manager
        .createQueryBuilder()
        .update(Activity)
        .set({ parentId: keepId })
        .where('parent_id IN (:...ids)', { ids: mergeIds })
        .andWhere('deleted_at IS NULL')
        .execute();

      // 1a. Cascade materializedPath and depth for moved children + descendants
      const keepFullPath = keepActivity.materializedPath
        ? `${keepActivity.materializedPath}/${keepId}`
        : keepId;

      for (const merged of activitiesToMerge) {
        const oldPrefix = merged.materializedPath
          ? `${merged.materializedPath}/${merged.id}`
          : merged.id;
        const depthDelta = keepActivity.depth - merged.depth;

        await queryRunner.query(
          `UPDATE activities
           SET materialized_path = $1 || SUBSTRING(materialized_path FROM $2),
               depth = depth + $3
           WHERE materialized_path LIKE $4
             AND deleted_at IS NULL`,
          [keepFullPath, oldPrefix.length + 1, depthDelta, `${oldPrefix}%`],
        );
      }

      // 2. Move members (skip if already exists with same entity+role)
      for (const mergeId of mergeIds) {
        const members = await queryRunner.manager.find(ActivityMember, {
          where: { activityId: mergeId },
        });

        for (const member of members) {
          const existing = await queryRunner.manager.findOne(ActivityMember, {
            where: {
              activityId: keepId,
              entityId: member.entityId,
              role: member.role,
            },
          });

          if (!existing) {
            await queryRunner.manager
              .createQueryBuilder()
              .update(ActivityMember)
              .set({ activityId: keepId })
              .where('id = :id', { id: member.id })
              .execute();
          }
        }
      }

      // 3. Reassign commitments
      await queryRunner.manager
        .createQueryBuilder()
        .update(Commitment)
        .set({ activityId: keepId })
        .where('activity_id IN (:...ids)', { ids: mergeIds })
        .andWhere('deleted_at IS NULL')
        .execute();

      // 4. Soft-delete merged activities
      await queryRunner.manager
        .createQueryBuilder()
        .update(Activity)
        .set({ status: ActivityStatus.ARCHIVED, deletedAt: new Date() })
        .where('id IN (:...ids)', { ids: mergeIds })
        .execute();

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.logger.log(
      `Merge complete: ${mergeIds.length} activities merged into ${keepId}`,
    );

    // Return updated keep activity
    return this.activityRepo.findOneOrFail({
      where: { id: keepId },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Auto-Merge All Duplicates
  // ─────────────────────────────────────────────────────────────

  /**
   * Automatically merge all detected duplicate groups.
   *
   * For each group, selects a "keeper" by:
   * 1. Most children (tasks assigned under it)
   * 2. Most ActivityMembers
   * 3. Oldest createdAt (first created wins)
   *
   * Then calls mergeActivities(keepId, otherIds) for each group.
   * Errors per-group are caught and collected — one failure does not stop others.
   */
  async autoMergeAllDuplicates(): Promise<{
    mergedGroups: number;
    totalMerged: number;
    errors: Array<{ group: string; error: string }>;
    details: Array<{ keptId: string; keptName: string; mergedIds: string[] }>;
  }> {
    const duplicates = await this.findDuplicateProjects();

    if (duplicates.length === 0) {
      this.logger.log('No duplicate groups found — nothing to merge');
      return { mergedGroups: 0, totalMerged: 0, errors: [], details: [] };
    }

    this.logger.log(`Found ${duplicates.length} duplicate groups to auto-merge`);

    const result = {
      mergedGroups: 0,
      totalMerged: 0,
      errors: [] as Array<{ group: string; error: string }>,
      details: [] as Array<{ keptId: string; keptName: string; mergedIds: string[] }>,
    };

    for (const group of duplicates) {
      try {
        const keeper = await this.selectKeeper(group.activities.map((a) => a.id));
        const mergeIds = group.activities
          .map((a) => a.id)
          .filter((id) => id !== keeper.id);

        if (mergeIds.length === 0) continue;

        await this.mergeActivities(keeper.id, mergeIds);

        result.mergedGroups++;
        result.totalMerged += mergeIds.length;
        result.details.push({
          keptId: keeper.id,
          keptName: keeper.name,
          mergedIds: mergeIds,
        });

        this.logger.log(
          `Merged group "${group.name}": kept ${keeper.id}, merged ${mergeIds.length}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to merge group "${group.name}": ${message}`);
        result.errors.push({ group: group.name, error: message });
      }
    }

    this.logger.log(
      `Auto-merge complete: ${result.mergedGroups} groups, ${result.totalMerged} merged, ${result.errors.length} errors`,
    );

    return result;
  }

  /**
   * Select the best "keeper" activity from a set of duplicate IDs.
   *
   * Priority:
   * 1. Most children (sub-activities)
   * 2. Most ActivityMembers
   * 3. Oldest createdAt
   */
  private async selectKeeper(activityIds: string[]): Promise<Activity> {
    // Count children per activity
    const childCounts = await this.activityRepo
      .createQueryBuilder('a')
      .select('a.parent_id', 'parentId')
      .addSelect('COUNT(*)', 'cnt')
      .where('a.parent_id IN (:...ids)', { ids: activityIds })
      .andWhere('a.deleted_at IS NULL')
      .groupBy('a.parent_id')
      .getRawMany<{ parentId: string; cnt: string }>();

    const childMap = new Map(childCounts.map((r) => [r.parentId, parseInt(r.cnt, 10)]));

    // Count members per activity
    const memberCounts = await this.memberRepo
      .createQueryBuilder('m')
      .select('m.activity_id', 'activityId')
      .addSelect('COUNT(*)', 'cnt')
      .where('m.activity_id IN (:...ids)', { ids: activityIds })
      .groupBy('m.activity_id')
      .getRawMany<{ activityId: string; cnt: string }>();

    const memberMap = new Map(memberCounts.map((r) => [r.activityId, parseInt(r.cnt, 10)]));

    // Fetch activities with createdAt for tiebreak
    const activities = await this.activityRepo.find({
      where: { id: In(activityIds), deletedAt: IsNull() },
      select: ['id', 'name', 'createdAt'],
    });

    // Sort: most children → most members → oldest createdAt
    activities.sort((a, b) => {
      const childDiff = (childMap.get(b.id) ?? 0) - (childMap.get(a.id) ?? 0);
      if (childDiff !== 0) return childDiff;

      const memberDiff = (memberMap.get(b.id) ?? 0) - (memberMap.get(a.id) ?? 0);
      if (memberDiff !== 0) return memberDiff;

      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return activities[0];
  }

  // ─────────────────────────────────────────────────────────────
  // Auto-Assign Orphaned Tasks
  // ─────────────────────────────────────────────────────────────

  /**
   * Automatically assign orphaned tasks to appropriate parent projects.
   * Delegates to OrphanResolutionService which applies multi-strategy resolution.
   *
   * Fetches full task data (including ownerEntityId) since findOrphanedTasks()
   * returns only summary fields for audit purposes.
   */
  async autoAssignOrphanedTasks(): Promise<OrphanResolutionResult> {
    const orphanSummary = await this.findOrphanedTasks();

    if (orphanSummary.length === 0) {
      this.logger.log('No orphaned tasks found — nothing to assign');
      return { resolved: 0, unresolved: 0, createdUnsortedProject: false, details: [] };
    }

    this.logger.log(`Found ${orphanSummary.length} orphaned tasks to auto-assign`);

    // Fetch full task data needed for resolution strategies
    const orphanIds = orphanSummary.map((t) => t.id);
    const fullTasks = await this.activityRepo.find({
      where: { id: In(orphanIds), deletedAt: IsNull() },
    });

    return this.orphanResolutionService.resolveOrphans(fullTasks);
  }

  // ─────────────────────────────────────────────────────────────
  // Auto-Resolve Missing Clients
  // ─────────────────────────────────────────────────────────────

  /**
   * Automatically resolve missing clientEntityId for PROJECT/BUSINESS activities.
   *
   * For each activity without a client:
   * 1. Load its ActivityMembers with entity relations (to get participant names)
   * 2. Call ClientResolutionService.resolveClient() with participant context
   * 3. If resolved, update the activity's clientEntityId
   */
  async autoResolveClients(): Promise<ClientResolutionBatchResult> {
    const missingClientSummary = await this.findMissingClientEntity();

    if (missingClientSummary.length === 0) {
      this.logger.log('No activities with missing clients — nothing to resolve');
      return { resolved: 0, unresolved: 0, details: [] };
    }

    this.logger.log(`Found ${missingClientSummary.length} activities with missing clients`);

    // Fetch full activity data (including ownerEntityId)
    const activityIds = missingClientSummary.map((a) => a.id);
    const fullActivities = await this.activityRepo.find({
      where: { id: In(activityIds), deletedAt: IsNull() },
    });

    const result: ClientResolutionBatchResult = { resolved: 0, unresolved: 0, details: [] };

    for (const activity of fullActivities) {
      if (!activity.ownerEntityId) {
        result.unresolved++;
        continue;
      }

      // Load members with entity relation to get participant names
      const members = await this.memberRepo.find({
        where: { activityId: activity.id },
        relations: ['entity'],
      });

      const participantNames = members
        .map((m) => m.entity?.name)
        .filter((name): name is string => !!name);

      const resolution = await this.clientResolutionService.resolveClient({
        participants: participantNames,
        ownerEntityId: activity.ownerEntityId,
      });

      if (resolution) {
        await this.activityRepo.update(activity.id, {
          clientEntityId: resolution.entityId,
        });
        result.resolved++;
        result.details.push({
          activityId: activity.id,
          activityName: activity.name,
          clientEntityId: resolution.entityId,
          clientName: resolution.entityName,
          method: resolution.method,
        });
      } else {
        result.unresolved++;
      }
    }

    this.logger.log(
      `Client resolution complete: ${result.resolved} resolved, ${result.unresolved} unresolved`,
    );

    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Metrics Collection
  // ─────────────────────────────────────────────────────────────

  /**
   * Collect all raw metrics data in parallel.
   * Shared by runFullAudit() and getCurrentMetrics() to avoid duplicate queries.
   */
  private async collectMetricsData(): Promise<MetricsData> {
    const [
      totalActivities,
      duplicates,
      orphanedTasks,
      missingClient,
      memberCoverage,
      commitmentLinkage,
      inferredRelations,
      fieldFill,
    ] = await Promise.all([
      this.activityRepo.count({ where: { deletedAt: IsNull() } }),
      this.findDuplicateProjects(),
      this.findOrphanedTasks(),
      this.findMissingClientEntity(),
      this.calculateActivityMemberCoverage(),
      this.calculateCommitmentLinkageRate(),
      this.countInferredRelations(),
      this.calculateFieldFillRate(),
    ]);

    return {
      totalActivities,
      duplicates,
      orphanedTasks,
      missingClient,
      memberCoverage,
      commitmentLinkage,
      inferredRelations,
      fieldFill,
    };
  }

  /**
   * Build DataQualityMetrics from raw collected data.
   */
  private buildMetrics(data: MetricsData): DataQualityMetrics {
    return {
      totalActivities: data.totalActivities,
      duplicateGroups: data.duplicates.length,
      orphanedTasks: data.orphanedTasks.length,
      missingClientEntity: data.missingClient.length,
      activityMemberCoverage: data.memberCoverage.rate,
      commitmentLinkageRate: data.commitmentLinkage.rate,
      inferredRelationsCount: data.inferredRelations,
      fieldFillRate: data.fieldFill.avgFillRate,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Issue Detection
  // ─────────────────────────────────────────────────────────────

  /**
   * Build issue list from pre-fetched data.
   * Used by runFullAudit to avoid double-querying the same data.
   */
  private buildIssuesFromData(
    duplicates: DuplicateGroup[],
    orphans: Activity[],
    missingClients: Activity[],
  ): DataQualityIssue[] {
    const issues: DataQualityIssue[] = [];

    // Duplicate issues
    for (const group of duplicates) {
      for (const activity of group.activities.slice(1)) {
        // First one is "original", rest are duplicates
        issues.push({
          type: DataQualityIssueType.DUPLICATE,
          severity: DataQualityIssueSeverity.HIGH,
          activityId: activity.id,
          activityName: activity.name,
          description: `Duplicate of "${group.activities[0].name}" (${group.count} total with same name and type "${group.type}")`,
          suggestedAction: `Merge with activity ${group.activities[0].id} using merge_activities tool`,
        });
      }
    }

    // Orphaned task issues
    for (const task of orphans) {
      issues.push({
        type: DataQualityIssueType.ORPHAN,
        severity: DataQualityIssueSeverity.MEDIUM,
        activityId: task.id,
        activityName: task.name,
        description: 'Task has no valid parent activity',
        suggestedAction: 'Assign to appropriate parent project or initiative',
      });
    }

    // Missing client issues
    for (const activity of missingClients) {
      issues.push({
        type: DataQualityIssueType.MISSING_CLIENT,
        severity: DataQualityIssueSeverity.LOW,
        activityId: activity.id,
        activityName: activity.name,
        description: `${activity.activityType} without client entity`,
        suggestedAction: 'Link to client entity or mark as internal',
      });
    }

    return issues;
  }
}
