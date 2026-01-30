import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan, IsNull, In, Not, And } from 'typeorm';
import {
  EntityEvent,
  EventType,
  EventStatus,
  EntityRecord,
  Activity,
  ActivityStatus,
  ActivityType,
  Commitment,
  CommitmentStatus,
  CommitmentType,
} from '@pkg/entities';

export interface MorningBriefData {
  meetings: EntityEvent[];
  deadlines: EntityEvent[];
  birthdays: EntityRecord[];
  overdueCommitments: EntityEvent[];
  pendingFollowups: EntityEvent[];
  overdueActivities: Activity[];
  pendingCommitments: Commitment[];
}

/**
 * Data provider for Morning Brief.
 * Encapsulates all database queries needed for brief generation.
 * Separates data fetching from presentation logic.
 */
@Injectable()
export class BriefDataProvider {
  private readonly logger = new Logger(BriefDataProvider.name);

  constructor(
    @InjectRepository(EntityEvent)
    private entityEventRepo: Repository<EntityEvent>,
    @InjectRepository(EntityRecord)
    private entityRepo: Repository<EntityRecord>,
    @InjectRepository(Activity)
    private activityRepo: Repository<Activity>,
    @InjectRepository(Commitment)
    private commitmentRepo: Repository<Commitment>,
  ) {}

  /**
   * Fetch all data needed for morning brief.
   * Consolidated queries: 5 Promise.all calls instead of 7.
   */
  async getMorningBriefData(startOfDay: Date, endOfDay: Date): Promise<MorningBriefData> {
    const [
      todayEvents,
      birthdays,
      overdueEntityEvents,
      overdueActivities,
      pendingCommitments,
    ] = await Promise.all([
      this.getTodayEvents(startOfDay, endOfDay),
      this.getEntitiesWithBirthdayToday(),
      this.getOverdueEntityEvents(),
      this.getOverdueActivities(),
      this.getPendingCommitments(),
    ]);

    return {
      meetings: todayEvents.meetings,
      deadlines: todayEvents.deadlines,
      birthdays,
      overdueCommitments: overdueEntityEvents.overdueCommitments,
      pendingFollowups: overdueEntityEvents.pendingFollowups,
      overdueActivities,
      pendingCommitments,
    };
  }

  /**
   * Get today's events (meetings and deadlines) in a single query.
   * Results are split by type in memory.
   */
  private async getTodayEvents(
    start: Date,
    end: Date,
  ): Promise<{ meetings: EntityEvent[]; deadlines: EntityEvent[] }> {
    const events = await this.entityEventRepo.find({
      where: {
        eventType: In([EventType.MEETING, EventType.DEADLINE]),
        eventDate: Between(start, end),
        status: In([EventStatus.SCHEDULED]),
      },
      relations: ['entity'],
      order: { eventDate: 'ASC' },
    });

    // Split by type in memory
    const meetings = events.filter(e => e.eventType === EventType.MEETING);
    const deadlines = events.filter(e => e.eventType === EventType.DEADLINE);

    return { meetings, deadlines };
  }

  private async getEntitiesWithBirthdayToday(): Promise<EntityRecord[]> {
    // TODO: Implement birthday lookup via EntityFact
    return [];
  }

  /**
   * Get overdue events (commitments and follow-ups) in a single query.
   * Results are split by type in memory with individual limits.
   */
  private async getOverdueEntityEvents(): Promise<{
    overdueCommitments: EntityEvent[];
    pendingFollowups: EntityEvent[];
  }> {
    const now = new Date();

    const events = await this.entityEventRepo.find({
      where: {
        eventType: In([EventType.COMMITMENT, EventType.FOLLOW_UP]),
        eventDate: LessThan(now),
        status: EventStatus.SCHEDULED,
      },
      relations: ['entity'],
      order: { eventDate: 'ASC' },
      take: 20, // Combined limit to ensure we get enough of each type
    });

    // Split by type in memory and apply individual limits
    const overdueCommitments = events
      .filter(e => e.eventType === EventType.COMMITMENT)
      .slice(0, 10);
    const pendingFollowups = events
      .filter(e => e.eventType === EventType.FOLLOW_UP)
      .slice(0, 10);

    return { overdueCommitments, pendingFollowups };
  }

  /**
   * Get overdue activities (tasks with past deadline, still active/idea).
   *
   * Note: Activities without deadline (NULL) are excluded.
   *
   * PAUSED activities are intentionally excluded:
   * - User explicitly chose to pause the activity
   * - Showing paused items as "overdue" would be confusing
   * - If user wants to see paused items, they can use /tasks command
   *
   * Product decision: Don't nag about things the user consciously deferred.
   */
  private async getOverdueActivities(): Promise<Activity[]> {
    const now = new Date();

    return this.activityRepo.find({
      where: {
        activityType: In([ActivityType.TASK, ActivityType.MILESTONE]),
        deadline: And(Not(IsNull()), LessThan(now)),
        status: In([ActivityStatus.ACTIVE, ActivityStatus.IDEA]),
      },
      relations: ['ownerEntity'],
      order: { deadline: 'ASC' },
      take: 10,
    });
  }

  /**
   * Get pending/overdue commitments from Commitment table.
   */
  private async getPendingCommitments(): Promise<Commitment[]> {
    const now = new Date();

    return this.commitmentRepo.find({
      where: [
        // Overdue: pending with past due date
        {
          status: CommitmentStatus.PENDING,
          dueDate: LessThan(now),
        },
        // In progress with past due date
        {
          status: CommitmentStatus.IN_PROGRESS,
          dueDate: LessThan(now),
        },
        // Pending without due date (waiting for response)
        {
          status: CommitmentStatus.PENDING,
          type: In([CommitmentType.REQUEST, CommitmentType.PROMISE]),
          dueDate: IsNull(),
        },
      ],
      relations: ['fromEntity', 'toEntity'],
      order: { dueDate: 'ASC' },
      take: 10,
    });
  }
}
