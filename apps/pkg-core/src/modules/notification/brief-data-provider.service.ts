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
   */
  async getMorningBriefData(startOfDay: Date, endOfDay: Date): Promise<MorningBriefData> {
    const [
      meetings,
      deadlines,
      birthdays,
      overdueCommitments,
      pendingFollowups,
      overdueActivities,
      pendingCommitments,
    ] = await Promise.all([
      this.getEventsByDateRange(startOfDay, endOfDay, EventType.MEETING),
      this.getEventsByDateRange(startOfDay, endOfDay, EventType.DEADLINE),
      this.getEntitiesWithBirthdayToday(),
      this.getOverdueEvents(EventType.COMMITMENT),
      this.getOverdueEvents(EventType.FOLLOW_UP),
      this.getOverdueActivities(),
      this.getPendingCommitments(),
    ]);

    return {
      meetings,
      deadlines,
      birthdays,
      overdueCommitments,
      pendingFollowups,
      overdueActivities,
      pendingCommitments,
    };
  }

  private async getEventsByDateRange(
    start: Date,
    end: Date,
    eventType: EventType,
  ): Promise<EntityEvent[]> {
    return this.entityEventRepo.find({
      where: {
        eventType,
        eventDate: Between(start, end),
        status: In([EventStatus.SCHEDULED]),
      },
      relations: ['entity'],
      order: { eventDate: 'ASC' },
    });
  }

  private async getEntitiesWithBirthdayToday(): Promise<EntityRecord[]> {
    // TODO: Implement birthday lookup via EntityFact
    return [];
  }

  private async getOverdueEvents(eventType: EventType): Promise<EntityEvent[]> {
    const now = new Date();

    return this.entityEventRepo.find({
      where: {
        eventType,
        eventDate: LessThan(now),
        status: EventStatus.SCHEDULED,
      },
      relations: ['entity'],
      order: { eventDate: 'ASC' },
      take: 10,
    });
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
