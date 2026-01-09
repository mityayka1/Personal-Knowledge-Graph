import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, IdentifierType, ParticipantRole } from '@pkg/entities';
import { InteractionService } from '../interaction.service';
import { EntityIdentifierService } from '../../entity/entity-identifier/entity-identifier.service';
import { PendingResolutionService } from '../../resolution/pending-resolution.service';
import { JobService } from '../../job/job.service';
import { CreateMessageDto } from '../dto/create-message.dto';

@Injectable()
export class MessageService {
  constructor(
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    private interactionService: InteractionService,
    private identifierService: EntityIdentifierService,
    @Inject(forwardRef(() => PendingResolutionService))
    private pendingResolutionService: PendingResolutionService,
    @Inject(forwardRef(() => JobService))
    private jobService: JobService,
  ) {}

  async create(dto: CreateMessageDto) {
    // 1. Find or create interaction (session)
    const interaction = await this.interactionService.findOrCreateSession(
      dto.telegram_chat_id,
      new Date(dto.timestamp),
    );

    // 2. Resolve entity
    let entityId: string | null = null;
    let resolutionStatus = 'resolved';
    let pendingResolutionId: string | null = null;

    const identifier = await this.identifierService.findByIdentifier(
      IdentifierType.TELEGRAM_USER_ID,
      dto.telegram_user_id,
    );

    if (identifier) {
      entityId = identifier.entityId;
    } else {
      // Create pending resolution with Telegram metadata
      resolutionStatus = 'pending';
      const pending = await this.pendingResolutionService.findOrCreate({
        identifierType: 'telegram_user_id',
        identifierValue: dto.telegram_user_id,
        displayName: dto.telegram_display_name || dto.telegram_username,
        messageTimestamp: new Date(dto.timestamp),
        metadata: dto.telegram_user_info,
      });
      pendingResolutionId = pending.id;
    }

    // 3. Add participant to interaction
    await this.interactionService.addParticipant(interaction.id, {
      entityId: entityId || undefined,
      role: dto.is_outgoing ? ParticipantRole.SELF : ParticipantRole.PARTICIPANT,
      identifierType: 'telegram_user_id',
      identifierValue: dto.telegram_user_id,
      displayName: dto.telegram_display_name,
    });

    // 4. Create or update message with sender identifier for proper attribution
    // Check if message already exists (by sourceMessageId in this interaction)
    let existingMessage = dto.message_id
      ? await this.messageRepo.findOne({
          where: {
            interactionId: interaction.id,
            sourceMessageId: dto.message_id,
          },
        })
      : null;

    let saved: Message;

    if (existingMessage) {
      // Update existing message with sender identifier
      existingMessage.senderEntityId = entityId;
      existingMessage.senderIdentifierType = 'telegram_user_id';
      existingMessage.senderIdentifierValue = dto.telegram_user_id;
      saved = await this.messageRepo.save(existingMessage);
    } else {
      // Create new message
      const message = this.messageRepo.create({
        interactionId: interaction.id,
        senderEntityId: entityId,
        senderIdentifierType: 'telegram_user_id',
        senderIdentifierValue: dto.telegram_user_id,
        content: dto.text,
        isOutgoing: dto.is_outgoing,
        timestamp: new Date(dto.timestamp),
        sourceMessageId: dto.message_id,
        mediaType: dto.media_type,
        mediaUrl: dto.media_url,
      });

      saved = await this.messageRepo.save(message);
    }

    // 5. Queue embedding job
    if (dto.text) {
      await this.jobService.createEmbeddingJob({
        messageId: saved.id,
        content: dto.text,
      });
    }

    return {
      id: saved.id,
      interaction_id: interaction.id,
      entity_id: entityId,
      entity_resolution_status: resolutionStatus,
      pending_resolution_id: pendingResolutionId,
      created_at: saved.createdAt,
    };
  }

  async findByInteraction(interactionId: string, limit = 100, offset = 0) {
    return this.messageRepo.find({
      where: { interactionId },
      order: { timestamp: 'ASC' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Get messages sent by a specific entity
   * Used for fact extraction from message history
   */
  async findByEntity(entityId: string, limit = 50) {
    return this.messageRepo.find({
      where: { senderEntityId: entityId },
      order: { timestamp: 'DESC' },
      take: limit,
      select: ['id', 'content', 'timestamp', 'interactionId'],
    });
  }

  /**
   * Get messages by sender identifier (telegram_user_id, phone, etc.)
   * Used for finding messages from unresolved identifiers
   */
  async findBySenderIdentifier(
    identifierType: string,
    identifierValue: string,
    limit = 50,
  ) {
    return this.messageRepo.find({
      where: {
        senderIdentifierType: identifierType,
        senderIdentifierValue: identifierValue,
      },
      order: { timestamp: 'DESC' },
      take: limit,
      select: ['id', 'content', 'timestamp', 'interactionId'],
    });
  }

  async updateEmbedding(messageId: string, embedding: number[]) {
    await this.messageRepo.update(messageId, { embedding });
  }
}
