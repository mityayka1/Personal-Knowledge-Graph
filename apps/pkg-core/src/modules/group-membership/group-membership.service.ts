import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { GroupMembership, EntityRecord, CreationSource, EntityType, IdentifierType } from '@pkg/entities';
import { EntityService } from '../entity/entity.service';
import { EntityIdentifierService } from '../entity/entity-identifier/entity-identifier.service';

export interface MembershipChangeDto {
  telegramChatId: string;
  telegramUserId: string;
  displayName?: string;
  action: 'joined' | 'left';
  timestamp: Date;
}

export interface CreateMembershipDto {
  telegramChatId: string;
  telegramUserId: string;
  displayName?: string;
  joinedAt?: Date;
}

@Injectable()
export class GroupMembershipService {
  private readonly logger = new Logger(GroupMembershipService.name);

  constructor(
    @InjectRepository(GroupMembership)
    private membershipRepo: Repository<GroupMembership>,
    private entityService: EntityService,
    private entityIdentifierService: EntityIdentifierService,
  ) {}

  /**
   * Handle membership change (join/leave) from Telegram
   */
  async handleMembershipChange(dto: MembershipChangeDto): Promise<GroupMembership> {
    const { telegramChatId, telegramUserId, displayName, action, timestamp } = dto;

    if (action === 'joined') {
      return this.recordJoin({
        telegramChatId,
        telegramUserId,
        displayName,
        joinedAt: timestamp,
      });
    } else {
      return this.recordLeave(telegramChatId, telegramUserId, timestamp);
    }
  }

  /**
   * Record a user joining a group
   */
  async recordJoin(dto: CreateMembershipDto): Promise<GroupMembership> {
    const { telegramChatId, telegramUserId, displayName, joinedAt = new Date() } = dto;

    // Check if there's an active membership
    const existing = await this.findActiveMembership(telegramChatId, telegramUserId);
    if (existing) {
      this.logger.debug(`User ${telegramUserId} already active in ${telegramChatId}`);
      // Update display name if provided
      if (displayName && displayName !== existing.displayName) {
        existing.displayName = displayName;
        await this.membershipRepo.save(existing);
      }
      return existing;
    }

    // Find or create entity for this user
    const entity = await this.findOrCreateEntityForUser(telegramUserId, displayName);

    // Create new membership record
    const membership = this.membershipRepo.create({
      telegramChatId,
      telegramUserId,
      entityId: entity?.id ?? null,
      displayName,
      joinedAt,
    });

    const saved = await this.membershipRepo.save(membership);
    this.logger.log(`Recorded join: user ${telegramUserId} in chat ${telegramChatId}`);

    return saved;
  }

  /**
   * Record a user leaving a group
   */
  async recordLeave(
    telegramChatId: string,
    telegramUserId: string,
    leftAt: Date = new Date(),
  ): Promise<GroupMembership> {
    const existing = await this.findActiveMembership(telegramChatId, telegramUserId);

    if (!existing) {
      // Create a record with both joined and left (for historical data)
      const membership = this.membershipRepo.create({
        telegramChatId,
        telegramUserId,
        joinedAt: leftAt, // Unknown join time
        leftAt,
      });
      return this.membershipRepo.save(membership);
    }

    existing.leftAt = leftAt;
    const saved = await this.membershipRepo.save(existing);
    this.logger.log(`Recorded leave: user ${telegramUserId} from chat ${telegramChatId}`);

    return saved;
  }

  /**
   * Find active membership (not left)
   */
  async findActiveMembership(
    telegramChatId: string,
    telegramUserId: string,
  ): Promise<GroupMembership | null> {
    return this.membershipRepo.findOne({
      where: {
        telegramChatId,
        telegramUserId,
        leftAt: IsNull(),
      },
    });
  }

  /**
   * Get all active members of a group
   */
  async getActiveMembers(telegramChatId: string): Promise<GroupMembership[]> {
    return this.membershipRepo.find({
      where: {
        telegramChatId,
        leftAt: IsNull(),
      },
      relations: ['entity'],
      order: { joinedAt: 'ASC' },
    });
  }

  /**
   * Get all groups a user is a member of (active)
   */
  async getUserGroups(telegramUserId: string): Promise<GroupMembership[]> {
    return this.membershipRepo.find({
      where: {
        telegramUserId,
        leftAt: IsNull(),
      },
      order: { joinedAt: 'DESC' },
    });
  }

  /**
   * Get membership history for a user in a group
   */
  async getMembershipHistory(
    telegramChatId: string,
    telegramUserId: string,
  ): Promise<GroupMembership[]> {
    return this.membershipRepo.find({
      where: {
        telegramChatId,
        telegramUserId,
      },
      order: { joinedAt: 'DESC' },
    });
  }

  /**
   * Bulk create memberships for all participants in a working group
   */
  async bulkCreateMemberships(
    telegramChatId: string,
    participants: Array<{ telegramUserId: string; displayName?: string }>,
  ): Promise<number> {
    let created = 0;

    for (const participant of participants) {
      const existing = await this.findActiveMembership(
        telegramChatId,
        participant.telegramUserId,
      );

      if (!existing) {
        await this.recordJoin({
          telegramChatId,
          telegramUserId: participant.telegramUserId,
          displayName: participant.displayName,
        });
        created++;
      }
    }

    this.logger.log(`Bulk created ${created} memberships for chat ${telegramChatId}`);
    return created;
  }

  /**
   * Find or create entity for a Telegram user
   */
  private async findOrCreateEntityForUser(
    telegramUserId: string,
    displayName?: string,
  ): Promise<EntityRecord | null> {
    // Try to find existing entity by telegram_user_id identifier
    const existingIdentifier = await this.entityIdentifierService.findByIdentifier(
      IdentifierType.TELEGRAM_USER_ID,
      telegramUserId,
    );

    if (existingIdentifier) {
      return existingIdentifier.entity;
    }

    // Create new entity
    try {
      const entity = await this.entityService.create({
        type: EntityType.PERSON,
        name: displayName || `User ${telegramUserId}`,
        creationSource: CreationSource.WORKING_GROUP,
      });

      // Create identifier
      await this.entityIdentifierService.create(entity.id, {
        type: IdentifierType.TELEGRAM_USER_ID,
        value: telegramUserId,
      });

      this.logger.log(`Created entity ${entity.id} for telegram user ${telegramUserId}`);
      return entity;
    } catch (error) {
      // Handle race condition - another process might have created the entity
      if (this.isUniqueViolation(error)) {
        const retry = await this.entityIdentifierService.findByIdentifier(
          IdentifierType.TELEGRAM_USER_ID,
          telegramUserId,
        );
        if (retry) {
          return retry.entity;
        }
      }
      this.logger.error(`Failed to create entity for user ${telegramUserId}`, error);
      return null;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === '23505'
    );
  }

  /**
   * Get statistics for memberships
   */
  async getStats() {
    const totalMemberships = await this.membershipRepo.count();
    const activeMemberships = await this.membershipRepo.count({
      where: { leftAt: IsNull() },
    });

    const uniqueChats = await this.membershipRepo
      .createQueryBuilder('gm')
      .select('COUNT(DISTINCT gm.telegram_chat_id)', 'count')
      .getRawOne();

    const uniqueUsers = await this.membershipRepo
      .createQueryBuilder('gm')
      .select('COUNT(DISTINCT gm.telegram_user_id)', 'count')
      .getRawOne();

    return {
      totalMemberships,
      activeMemberships,
      uniqueChats: parseInt(uniqueChats?.count || '0', 10),
      uniqueUsers: parseInt(uniqueUsers?.count || '0', 10),
    };
  }
}
