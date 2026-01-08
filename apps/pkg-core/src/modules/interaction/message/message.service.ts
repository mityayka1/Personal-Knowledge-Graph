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
      // Create pending resolution
      resolutionStatus = 'pending';
      const pending = await this.pendingResolutionService.findOrCreate({
        identifierType: 'telegram_user_id',
        identifierValue: dto.telegram_user_id,
        displayName: dto.telegram_display_name || dto.telegram_username,
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

    // 4. Create message
    const message = this.messageRepo.create({
      interactionId: interaction.id,
      senderEntityId: entityId,
      content: dto.text,
      isOutgoing: dto.is_outgoing,
      timestamp: new Date(dto.timestamp),
      sourceMessageId: dto.message_id,
      mediaType: dto.media_type,
      mediaUrl: dto.media_url,
    });

    const saved = await this.messageRepo.save(message);

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

  async updateEmbedding(messageId: string, embedding: number[]) {
    await this.messageRepo.update(messageId, { embedding });
  }
}
