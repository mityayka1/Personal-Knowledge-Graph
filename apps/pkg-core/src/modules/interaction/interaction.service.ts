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
}
