import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityPriority,
  CommitmentType,
  CommitmentPriority,
  EntityRecord,
} from '@pkg/entities';
import { ActivityService } from '../activity/activity.service';
import { CommitmentService, CreateCommitmentDto } from '../activity/commitment.service';
import {
  ExtractedProject,
  ExtractedTask,
  ExtractedCommitment,
} from './daily-synthesis-extraction.types';

/**
 * Input for persisting extracted items.
 */
export interface PersistExtractionInput {
  /** Owner entity ID (usually the user's own entity) */
  ownerEntityId: string;
  /** Projects to persist */
  projects: ExtractedProject[];
  /** Tasks to persist */
  tasks: ExtractedTask[];
  /** Commitments to persist */
  commitments: ExtractedCommitment[];
  /** Optional: synthesis date for metadata */
  synthesisDate?: string;
  /** Optional: focus topic for metadata */
  focusTopic?: string;
}

/**
 * Result of persisting extracted items.
 */
export interface PersistExtractionResult {
  /** Created Activity IDs (projects + tasks) */
  activityIds: string[];
  /** Created Commitment IDs */
  commitmentIds: string[];
  /** Count of projects created */
  projectsCreated: number;
  /** Count of tasks created */
  tasksCreated: number;
  /** Count of commitments created */
  commitmentsCreated: number;
  /** Items that failed to persist */
  errors: Array<{ item: string; error: string }>;
}

/**
 * ExtractionPersistenceService — converts confirmed extracted items
 * into database entities (Activity, Commitment).
 *
 * Flow:
 * 1. Carousel completion → getConfirmedItems()
 * 2. PersistExtractionInput passed to this service
 * 3. Each item type converted to appropriate entity
 * 4. Created in database with metadata linking to extraction
 */
@Injectable()
export class ExtractionPersistenceService {
  private readonly logger = new Logger(ExtractionPersistenceService.name);

  constructor(
    private readonly activityService: ActivityService,
    private readonly commitmentService: CommitmentService,
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
  ) {}

  /**
   * Persist all confirmed items from extraction.
   */
  async persist(input: PersistExtractionInput): Promise<PersistExtractionResult> {
    const result: PersistExtractionResult = {
      activityIds: [],
      commitmentIds: [],
      projectsCreated: 0,
      tasksCreated: 0,
      commitmentsCreated: 0,
      errors: [],
    };

    // Build project name → Activity ID map for task parent resolution
    const projectMap = new Map<string, string>();

    // 1. Persist projects first (tasks may reference them)
    for (const project of input.projects) {
      try {
        const activity = await this.persistProject(project, input);
        result.activityIds.push(activity.id);
        result.projectsCreated++;
        projectMap.set(project.name.toLowerCase(), activity.id);
        this.logger.debug(`Created project: ${activity.name} (${activity.id})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `project:${project.name}`, error: message });
        this.logger.error(`Failed to persist project "${project.name}": ${message}`);
      }
    }

    // 2. Persist tasks (may link to projects)
    for (const task of input.tasks) {
      try {
        const parentId = task.projectName
          ? projectMap.get(task.projectName.toLowerCase())
          : undefined;
        const activity = await this.persistTask(task, input, parentId);
        result.activityIds.push(activity.id);
        result.tasksCreated++;
        this.logger.debug(`Created task: ${activity.name} (${activity.id})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `task:${task.title}`, error: message });
        this.logger.error(`Failed to persist task "${task.title}": ${message}`);
      }
    }

    // 3. Persist commitments
    for (const commitment of input.commitments) {
      try {
        const created = await this.persistCommitment(commitment, input);
        result.commitmentIds.push(created.id);
        result.commitmentsCreated++;
        this.logger.debug(`Created commitment: ${created.title} (${created.id})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `commitment:${commitment.what}`, error: message });
        this.logger.error(`Failed to persist commitment "${commitment.what}": ${message}`);
      }
    }

    this.logger.log(
      `Persistence complete: ${result.projectsCreated} projects, ` +
        `${result.tasksCreated} tasks, ${result.commitmentsCreated} commitments ` +
        `(${result.errors.length} errors)`,
    );

    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Conversion Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Convert ExtractedProject → Activity (type: PROJECT).
   */
  private async persistProject(
    project: ExtractedProject,
    input: PersistExtractionInput,
  ): Promise<Activity> {
    // If existing activity found, skip creation
    if (project.existingActivityId) {
      const existing = await this.activityService.findOne(project.existingActivityId);
      this.logger.debug(`Matched existing project: ${existing.name}`);
      return existing;
    }

    // Try to resolve client entity
    let clientEntityId: string | undefined;
    if (project.client) {
      const client = await this.findEntityByName(project.client);
      clientEntityId = client?.id;
    }

    return this.activityService.create({
      name: project.name,
      activityType: ActivityType.PROJECT,
      status: this.mapProjectStatus(project.status),
      ownerEntityId: input.ownerEntityId,
      clientEntityId,
      metadata: {
        extractedFrom: 'daily_synthesis',
        synthesisDate: input.synthesisDate,
        focusTopic: input.focusTopic,
        participants: project.participants,
        sourceQuote: project.sourceQuote,
        confidence: project.confidence,
      },
    });
  }

  /**
   * Convert ExtractedTask → Activity (type: TASK).
   */
  private async persistTask(
    task: ExtractedTask,
    input: PersistExtractionInput,
    parentId?: string,
  ): Promise<Activity> {
    return this.activityService.create({
      name: task.title,
      activityType: ActivityType.TASK,
      status: this.mapTaskStatus(task.status),
      priority: this.mapPriority(task.priority),
      parentId,
      ownerEntityId: input.ownerEntityId,
      deadline: task.deadline,
      metadata: {
        extractedFrom: 'daily_synthesis',
        synthesisDate: input.synthesisDate,
        focusTopic: input.focusTopic,
        assignee: task.assignee,
        sourceQuote: task.sourceQuote,
        confidence: task.confidence,
      },
    });
  }

  /**
   * Convert ExtractedCommitment → Commitment entity.
   */
  private async persistCommitment(
    commitment: ExtractedCommitment,
    input: PersistExtractionInput,
  ): Promise<{ id: string; title: string }> {
    // Resolve from/to entities
    let fromEntityId = input.ownerEntityId;
    let toEntityId = input.ownerEntityId;

    if (commitment.from !== 'self') {
      const fromEntity = await this.findEntityByName(commitment.from);
      if (fromEntity) {
        fromEntityId = fromEntity.id;
      }
    }

    if (commitment.to !== 'self') {
      const toEntity = await this.findEntityByName(commitment.to);
      if (toEntity) {
        toEntityId = toEntity.id;
      }
    }

    const dto: CreateCommitmentDto = {
      type: this.mapCommitmentType(commitment.type),
      title: commitment.what,
      fromEntityId,
      toEntityId,
      priority: this.mapCommitmentPriority(commitment.priority),
      dueDate: commitment.deadline ? new Date(commitment.deadline) : undefined,
      confidence: commitment.confidence,
      metadata: {
        extractedFrom: 'daily_synthesis',
        synthesisDate: input.synthesisDate,
        focusTopic: input.focusTopic,
        sourceQuote: commitment.sourceQuote,
      },
    };

    const created = await this.commitmentService.create(dto);
    return { id: created.id, title: created.title };
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Entity Resolution
  // ─────────────────────────────────────────────────────────────

  /**
   * Find entity by name (fuzzy match).
   */
  private async findEntityByName(name: string): Promise<EntityRecord | null> {
    return this.entityRepo
      .createQueryBuilder('e')
      .where('e.name ILIKE :pattern', { pattern: `%${name}%` })
      .orderBy('e.updatedAt', 'DESC')
      .getOne();
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Mapping Functions
  // ─────────────────────────────────────────────────────────────

  private mapProjectStatus(status?: string): ActivityStatus {
    switch (status?.toLowerCase()) {
      case 'active':
        return ActivityStatus.ACTIVE;
      case 'blocked':
      case 'paused':
        return ActivityStatus.PAUSED;
      case 'completed':
      case 'done':
        return ActivityStatus.COMPLETED;
      default:
        return ActivityStatus.ACTIVE;
    }
  }

  private mapTaskStatus(status: string): ActivityStatus {
    switch (status) {
      case 'in_progress':
        return ActivityStatus.ACTIVE;
      case 'done':
        return ActivityStatus.COMPLETED;
      case 'pending':
      default:
        return ActivityStatus.IDEA;
    }
  }

  private mapPriority(priority?: string): ActivityPriority {
    switch (priority?.toLowerCase()) {
      case 'high':
        return ActivityPriority.HIGH;
      case 'low':
        return ActivityPriority.LOW;
      case 'medium':
      default:
        return ActivityPriority.MEDIUM;
    }
  }

  private mapCommitmentType(type: string): CommitmentType {
    switch (type) {
      case 'promise':
        return CommitmentType.PROMISE;
      case 'request':
        return CommitmentType.REQUEST;
      case 'agreement':
        return CommitmentType.AGREEMENT;
      case 'deadline':
        return CommitmentType.DEADLINE;
      case 'reminder':
        return CommitmentType.REMINDER;
      default:
        return CommitmentType.PROMISE;
    }
  }

  private mapCommitmentPriority(priority?: string): CommitmentPriority {
    switch (priority?.toLowerCase()) {
      case 'high':
        return CommitmentPriority.HIGH;
      case 'low':
        return CommitmentPriority.LOW;
      case 'critical':
        return CommitmentPriority.CRITICAL;
      case 'medium':
      default:
        return CommitmentPriority.MEDIUM;
    }
  }
}
