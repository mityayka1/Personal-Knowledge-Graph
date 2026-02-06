import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not } from 'typeorm';
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
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Full Audit
  // ─────────────────────────────────────────────────────────────

  /**
   * Run a comprehensive data quality audit.
   * Collects all metrics, detects issues, and persists a DataQualityReport.
   */
  async runFullAudit(): Promise<DataQualityReport> {
    this.logger.log('Starting full data quality audit...');

    const metrics = await this.getCurrentMetrics();
    const issues = await this.detectIssues();

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
      duplicateGroups: duplicates.length,
      orphanedTasks: orphanedTasks.length,
      missingClientEntity: missingClient.length,
      activityMemberCoverage: memberCoverage.rate,
      commitmentLinkageRate: commitmentLinkage.rate,
      inferredRelationsCount: inferredRelations,
      fieldFillRate: fieldFill.avgFillRate,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Report Access
  // ─────────────────────────────────────────────────────────────

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
      throw new NotFoundException(
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
   * Strategy:
   * 1. Move children from merged activities to keep activity
   * 2. Move members from merged activities to keep activity (skip duplicates)
   * 3. Reassign commitments from merged activities to keep activity
   * 4. Soft-delete merged activities (status = ARCHIVED)
   */
  async mergeActivities(
    keepId: string,
    mergeIds: string[],
  ): Promise<Activity> {
    const keepActivity = await this.activityRepo.findOne({
      where: { id: keepId, deletedAt: IsNull() },
    });

    if (!keepActivity) {
      throw new NotFoundException(`Activity to keep (${keepId}) not found`);
    }

    const mergeActivities = await this.activityRepo.find({
      where: {
        id: In(mergeIds),
        deletedAt: IsNull(),
      },
    });

    if (mergeActivities.length !== mergeIds.length) {
      const foundIds = mergeActivities.map((a) => a.id);
      const missingIds = mergeIds.filter((id) => !foundIds.includes(id));
      throw new NotFoundException(
        `Activities to merge not found: ${missingIds.join(', ')}`,
      );
    }

    this.logger.log(
      `Merging ${mergeIds.length} activities into ${keepId} (${keepActivity.name})`,
    );

    // 1. Move children to keep activity
    await this.activityRepo
      .createQueryBuilder()
      .update(Activity)
      .set({ parentId: keepId })
      .where('parent_id IN (:...ids)', { ids: mergeIds })
      .andWhere('deleted_at IS NULL')
      .execute();

    // 2. Move members (skip if already exists with same entity+role)
    for (const mergeId of mergeIds) {
      const members = await this.memberRepo.find({
        where: { activityId: mergeId },
      });

      for (const member of members) {
        // Check if keep activity already has this member with same role
        const existing = await this.memberRepo.findOne({
          where: {
            activityId: keepId,
            entityId: member.entityId,
            role: member.role,
          },
        });

        if (!existing) {
          await this.memberRepo
            .createQueryBuilder()
            .update(ActivityMember)
            .set({ activityId: keepId })
            .where('id = :id', { id: member.id })
            .execute();
        }
      }
    }

    // 3. Reassign commitments
    await this.commitmentRepo
      .createQueryBuilder()
      .update(Commitment)
      .set({ activityId: keepId })
      .where('activity_id IN (:...ids)', { ids: mergeIds })
      .andWhere('deleted_at IS NULL')
      .execute();

    // 4. Soft-delete merged activities
    await this.activityRepo
      .createQueryBuilder()
      .update(Activity)
      .set({ status: ActivityStatus.ARCHIVED, deletedAt: new Date() })
      .where('id IN (:...ids)', { ids: mergeIds })
      .execute();

    this.logger.log(
      `Merge complete: ${mergeIds.length} activities merged into ${keepId}`,
    );

    // Return updated keep activity
    return this.activityRepo.findOneOrFail({
      where: { id: keepId },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Issue Detection
  // ─────────────────────────────────────────────────────────────

  /**
   * Detect all data quality issues for report generation.
   */
  private async detectIssues(): Promise<DataQualityIssue[]> {
    const issues: DataQualityIssue[] = [];

    const [duplicates, orphans, missingClients] = await Promise.all([
      this.findDuplicateProjects(),
      this.findOrphanedTasks(),
      this.findMissingClientEntity(),
    ]);

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
