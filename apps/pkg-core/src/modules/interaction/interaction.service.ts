import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interaction, InteractionType, InteractionStatus, InteractionParticipant, ParticipantRole } from '@pkg/entities';
import { SESSION_GAP_THRESHOLD_MS } from '@pkg/shared';

@Injectable()
export class InteractionService {
  constructor(
    @InjectRepository(Interaction)
    private interactionRepo: Repository<Interaction>,
    @InjectRepository(InteractionParticipant)
    private participantRepo: Repository<InteractionParticipant>,
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

  async findOrCreateSession(chatId: string, lastMessageTime?: Date) {
    const existing = await this.findActiveSession(chatId);

    if (existing && lastMessageTime) {
      const lastActivity = existing.updatedAt || existing.startedAt;
      const gap = lastMessageTime.getTime() - lastActivity.getTime();

      if (gap > SESSION_GAP_THRESHOLD_MS) {
        // End current session and create new one
        await this.endSession(existing.id);
        return this.createSession(chatId);
      }

      return existing;
    }

    if (existing) {
      return existing;
    }

    return this.createSession(chatId);
  }

  async createSession(chatId: string) {
    const interaction = this.interactionRepo.create({
      type: InteractionType.TELEGRAM_SESSION,
      source: 'telegram',
      status: InteractionStatus.ACTIVE,
      startedAt: new Date(),
      sourceMetadata: { telegram_chat_id: chatId },
    });

    return this.interactionRepo.save(interaction);
  }

  async endSession(id: string) {
    const interaction = await this.findOne(id);

    interaction.status = InteractionStatus.COMPLETED;
    interaction.endedAt = new Date();

    return this.interactionRepo.save(interaction);
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
