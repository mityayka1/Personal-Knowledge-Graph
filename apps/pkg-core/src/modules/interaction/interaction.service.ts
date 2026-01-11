import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interaction, InteractionType, InteractionStatus, InteractionParticipant, ParticipantRole } from '@pkg/entities';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class InteractionService {
  constructor(
    @InjectRepository(Interaction)
    private interactionRepo: Repository<Interaction>,
    @InjectRepository(InteractionParticipant)
    private participantRepo: Repository<InteractionParticipant>,
    private settingsService: SettingsService,
  ) {}

  async findAll(params: { limit?: number; offset?: number } = {}) {
    const limit = params.limit || 20;
    const offset = params.offset || 0;

    const [items, total] = await this.interactionRepo.findAndCount({
      relations: ['participants'],
      order: { startedAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { items, total, limit, offset };
  }

  async findOne(id: string) {
    const interaction = await this.interactionRepo.findOne({
      where: { id },
      relations: ['participants', 'messages', 'summary'],
    });

    if (!interaction) {
      throw new NotFoundException(`Interaction with id '${id}' not found`);
    }

    return interaction;
  }

  async findActiveSession(chatId: string): Promise<Interaction | null> {
    return this.interactionRepo.findOne({
      where: {
        type: InteractionType.TELEGRAM_SESSION,
        status: InteractionStatus.ACTIVE,
        sourceMetadata: { telegram_chat_id: chatId } as any,
      },
      relations: ['participants'],
    });
  }

  /**
   * Find an active session or create a new one.
   * If the gap between the message time and last activity exceeds threshold,
   * the existing session is ended and a new one is created.
   *
   * @param chatId - Telegram chat ID
   * @param messageTime - Timestamp of the current message
   */
  async findOrCreateSession(chatId: string, messageTime?: Date) {
    const existing = await this.findActiveSession(chatId);

    if (existing && messageTime) {
      const lastActivity = existing.updatedAt || existing.startedAt;
      const gap = messageTime.getTime() - lastActivity.getTime();

      // Get configurable session gap threshold
      const sessionGapMs = await this.settingsService.getSessionGapMs();

      if (gap > sessionGapMs) {
        // End current session with last known activity time (not current time)
        await this.endSession(existing.id, lastActivity);
        // Create new session with message timestamp as startedAt
        return this.createSession(chatId, messageTime);
      }

      // Update interaction's updatedAt to track last message time for gap calculation
      await this.updateLastActivity(existing.id);
      return existing;
    }

    if (existing) {
      return existing;
    }

    // Create new session with message timestamp (or now if not provided)
    return this.createSession(chatId, messageTime);
  }

  /**
   * Create a new Telegram session.
   * @param chatId - Telegram chat ID
   * @param startedAt - Timestamp of the first message in the session (defaults to now for real-time)
   */
  async createSession(chatId: string, startedAt?: Date) {
    const interaction = this.interactionRepo.create({
      type: InteractionType.TELEGRAM_SESSION,
      source: 'telegram',
      status: InteractionStatus.ACTIVE,
      startedAt: startedAt || new Date(),
      sourceMetadata: { telegram_chat_id: chatId },
    });

    return this.interactionRepo.save(interaction);
  }

  /**
   * End a session and mark it as completed.
   * @param id - Interaction ID
   * @param endedAt - Timestamp of the last message in the session (defaults to now for real-time)
   */
  async endSession(id: string, endedAt?: Date) {
    const interaction = await this.findOne(id);

    interaction.status = InteractionStatus.COMPLETED;
    interaction.endedAt = endedAt || new Date();

    return this.interactionRepo.save(interaction);
  }

  /**
   * Update interaction's updatedAt timestamp.
   * Used to track last activity for session gap calculation.
   * Note: TypeORM's @UpdateDateColumn doesn't auto-update on raw UPDATE queries,
   * so we explicitly set updated_at = NOW().
   */
  async updateLastActivity(id: string): Promise<void> {
    await this.interactionRepo
      .createQueryBuilder()
      .update(Interaction)
      .set({ updatedAt: () => 'NOW()' })
      .where('id = :id', { id })
      .execute();
  }

  async addParticipant(
    interactionId: string,
    data: {
      entityId?: string;
      role: ParticipantRole;
      identifierType: string;
      identifierValue: string;
      displayName?: string;
    },
  ) {
    // Check if participant already exists
    const existing = await this.participantRepo.findOne({
      where: {
        interactionId,
        identifierType: data.identifierType,
        identifierValue: data.identifierValue,
      },
    });

    if (existing) {
      return existing;
    }

    const participant = this.participantRepo.create({
      interactionId,
      entityId: data.entityId,
      role: data.role,
      identifierType: data.identifierType,
      identifierValue: data.identifierValue,
      displayName: data.displayName,
    });

    return this.participantRepo.save(participant);
  }

  async updateParticipantEntity(
    interactionId: string,
    identifierType: string,
    identifierValue: string,
    entityId: string,
  ) {
    await this.participantRepo.update(
      { interactionId, identifierType, identifierValue },
      { entityId },
    );
  }

  async findByIdentifier(identifierType: string, identifierValue: string, limit = 10) {
    const participants = await this.participantRepo.find({
      where: { identifierType, identifierValue },
      relations: ['interaction', 'interaction.participants', 'interaction.messages'],
      order: { interaction: { startedAt: 'DESC' } },
      take: limit,
    });

    return participants.map(p => ({
      ...p.interaction,
      messageCount: p.interaction.messages?.length || 0,
    }));
  }

  /**
   * Get statistics for all Telegram chats (for import optimization).
   * Returns telegram_chat_id, last message info, and message count.
   */
  async getChatStats(): Promise<{
    chats: Array<{
      telegramChatId: string;
      lastMessageId: string | null;
      lastMessageTimestamp: string | null;
      messageCount: number;
    }>;
  }> {
    // Query to get chat stats with last message info
    // Note: source_message_id is VARCHAR, so we cast to BIGINT for proper numeric MAX
    const result = await this.interactionRepo
      .createQueryBuilder('i')
      .select("i.source_metadata->>'telegram_chat_id'", 'telegramChatId')
      .addSelect('COUNT(DISTINCT m.id)', 'messageCount')
      .addSelect('MAX(m.source_message_id::BIGINT)', 'lastMessageId')
      .addSelect('MAX(m.timestamp)', 'lastMessageTimestamp')
      .leftJoin('messages', 'm', 'm.interaction_id = i.id')
      .where('i.source = :source', { source: 'telegram' })
      .andWhere("i.source_metadata->>'telegram_chat_id' IS NOT NULL")
      .groupBy("i.source_metadata->>'telegram_chat_id'")
      .getRawMany();

    return {
      chats: result.map(r => {
        // Handle lastMessageTimestamp - could be Date or string from raw query
        let timestamp: string | null = null;
        if (r.lastMessageTimestamp) {
          timestamp = r.lastMessageTimestamp instanceof Date
            ? r.lastMessageTimestamp.toISOString()
            : String(r.lastMessageTimestamp);
        }

        // lastMessageId is now BIGINT from MAX, convert to string
        const lastMessageId = r.lastMessageId != null ? String(r.lastMessageId) : null;

        return {
          telegramChatId: r.telegramChatId,
          lastMessageId,
          lastMessageTimestamp: timestamp,
          messageCount: parseInt(r.messageCount, 10) || 0,
        };
      }),
    };
  }
}
