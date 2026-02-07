import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, ILike } from 'typeorm';
import { Activity, ActivityType, ActivityStatus, ActivityMember } from '@pkg/entities';
import { ActivityService } from '../activity/activity.service';
import { ProjectMatchingService } from '../extraction/project-matching.service';

/**
 * Method used to assign an orphan to a parent.
 */
export type OrphanResolutionMethod =
  | 'name_containment'
  | 'batch'
  | 'single_project'
  | 'unsorted';

/**
 * Result of orphan resolution batch.
 */
export interface OrphanResolutionResult {
  resolved: number;
  unresolved: number;
  createdUnsortedProject: boolean;
  details: Array<{
    taskId: string;
    taskName: string;
    assignedParentId: string;
    assignedParentName: string;
    method: OrphanResolutionMethod;
  }>;
}

const UNSORTED_PROJECT_NAME = 'Unsorted Tasks';

/**
 * OrphanResolutionService — resolves orphaned tasks by assigning them to parents.
 *
 * Strategies (in priority order):
 * 1. Name Containment — task name contains an active project name
 * 2. Batch — task shares draftBatchId with a known assigned task
 * 3. Single Project — task owner has only one active project
 * 4. Fallback — assign to "Unsorted Tasks" project
 */
@Injectable()
export class OrphanResolutionService {
  private readonly logger = new Logger(OrphanResolutionService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(ActivityMember)
    private readonly memberRepo: Repository<ActivityMember>,
    private readonly activityService: ActivityService,
    private readonly projectMatchingService: ProjectMatchingService,
  ) {}

  /**
   * Resolve a batch of orphaned tasks by finding or creating appropriate parents.
   */
  async resolveOrphans(orphanedTasks: Activity[]): Promise<OrphanResolutionResult> {
    if (orphanedTasks.length === 0) {
      return { resolved: 0, unresolved: 0, createdUnsortedProject: false, details: [] };
    }

    this.logger.log(`Resolving ${orphanedTasks.length} orphaned tasks`);

    // Pre-load active projects for name containment matching
    const activeProjects = await this.activityRepo.find({
      where: [
        { activityType: ActivityType.PROJECT, status: ActivityStatus.ACTIVE, deletedAt: IsNull() },
        { activityType: ActivityType.PROJECT, status: ActivityStatus.DRAFT, deletedAt: IsNull() },
      ],
      select: ['id', 'name', 'ownerEntityId'],
    });

    const result: OrphanResolutionResult = {
      resolved: 0,
      unresolved: 0,
      createdUnsortedProject: false,
      details: [],
    };

    let unsortedProject: Activity | null = null;

    for (const task of orphanedTasks) {
      // Strategy 1: Name Containment
      const nameMatch = this.matchByNameContainment(task, activeProjects);
      if (nameMatch) {
        await this.assignParent(task, nameMatch);
        result.resolved++;
        result.details.push({
          taskId: task.id,
          taskName: task.name,
          assignedParentId: nameMatch.id,
          assignedParentName: nameMatch.name,
          method: 'name_containment',
        });
        continue;
      }

      // Strategy 2: Batch matching
      const batchMatch = await this.matchByBatch(task);
      if (batchMatch) {
        await this.assignParent(task, batchMatch);
        result.resolved++;
        result.details.push({
          taskId: task.id,
          taskName: task.name,
          assignedParentId: batchMatch.id,
          assignedParentName: batchMatch.name,
          method: 'batch',
        });
        continue;
      }

      // Strategy 3: Owner's single project
      const singleMatch = await this.matchBySingleProject(task, activeProjects);
      if (singleMatch) {
        await this.assignParent(task, singleMatch);
        result.resolved++;
        result.details.push({
          taskId: task.id,
          taskName: task.name,
          assignedParentId: singleMatch.id,
          assignedParentName: singleMatch.name,
          method: 'single_project',
        });
        continue;
      }

      // Strategy 4: Fallback to "Unsorted Tasks"
      if (!unsortedProject) {
        unsortedProject = await this.getOrCreateUnsortedProject(task.ownerEntityId);
        if (!unsortedProject) {
          result.unresolved++;
          continue;
        }
        // Check if we created it
        result.createdUnsortedProject = true;
      }
      await this.assignParent(task, unsortedProject);
      result.resolved++;
      result.details.push({
        taskId: task.id,
        taskName: task.name,
        assignedParentId: unsortedProject.id,
        assignedParentName: unsortedProject.name,
        method: 'unsorted',
      });
    }

    result.unresolved = orphanedTasks.length - result.resolved;

    this.logger.log(
      `Orphan resolution complete: ${result.resolved} resolved, ${result.unresolved} unresolved`,
    );

    return result;
  }

  /**
   * Strategy 1: Match if task name CONTAINS a project name (case-insensitive).
   * Example: "Fix bug in Alpha" → project "Alpha".
   */
  private matchByNameContainment(
    task: Activity,
    projects: Activity[],
  ): Activity | null {
    const taskNameLower = ProjectMatchingService.normalizeName(task.name);

    for (const project of projects) {
      const projectNameLower = ProjectMatchingService.normalizeName(project.name);
      if (projectNameLower.length >= 3 && taskNameLower.includes(projectNameLower)) {
        return project;
      }
    }

    return null;
  }

  /**
   * Strategy 2: Match by shared draftBatchId metadata.
   * If the task has metadata.draftBatchId, find other tasks in the same batch
   * that already have a parent, and use that parent.
   */
  private async matchByBatch(task: Activity): Promise<Activity | null> {
    const batchId = (task as any).metadata?.draftBatchId;
    if (!batchId) return null;

    // Find a task in the same batch that has a parent
    const siblingWithParent = await this.activityRepo
      .createQueryBuilder('a')
      .where("a.metadata->>'draftBatchId' = :batchId", { batchId })
      .andWhere('a.parent_id IS NOT NULL')
      .andWhere('a.deleted_at IS NULL')
      .andWhere('a.id != :taskId', { taskId: task.id })
      .limit(1)
      .getOne();

    if (siblingWithParent?.parentId) {
      return this.activityRepo.findOne({
        where: { id: siblingWithParent.parentId, deletedAt: IsNull() },
        select: ['id', 'name'],
      });
    }

    return null;
  }

  /**
   * Strategy 3: If task owner has exactly one active project, assign there.
   */
  private async matchBySingleProject(
    task: Activity,
    projects: Activity[],
  ): Promise<Activity | null> {
    if (!task.ownerEntityId) return null;

    const ownerProjects = projects.filter(
      (p) => p.ownerEntityId === task.ownerEntityId,
    );

    return ownerProjects.length === 1 ? ownerProjects[0] : null;
  }

  /**
   * Get or create the "Unsorted Tasks" project for a given owner.
   */
  private async getOrCreateUnsortedProject(
    ownerEntityId?: string,
  ): Promise<Activity | null> {
    if (!ownerEntityId) return null;

    // Check if it already exists
    const existing = await this.activityRepo.findOne({
      where: {
        name: UNSORTED_PROJECT_NAME,
        activityType: ActivityType.PROJECT,
        ownerEntityId,
        deletedAt: IsNull(),
      },
      select: ['id', 'name'],
    });

    if (existing) return existing;

    // Create it
    const created = await this.activityService.create({
      name: UNSORTED_PROJECT_NAME,
      activityType: ActivityType.PROJECT,
      ownerEntityId,
      status: ActivityStatus.ACTIVE,
    });

    this.logger.log(`Created "Unsorted Tasks" project: ${created.id}`);
    return created;
  }

  /**
   * Assign a parent to a task via ActivityService.update (handles depth/path cascade).
   */
  private async assignParent(task: Activity, parent: Activity): Promise<void> {
    await this.activityService.update(task.id, { parentId: parent.id });
  }
}
