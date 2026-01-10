import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  Message,
  IdentifierType,
  ParticipantRole,
  ChatType,
  EntityType,
  CreationSource,
  ChatCategory,
} from '@pkg/entities';
import { InteractionService } from '../interaction.service';
import { EntityIdentifierService } from '../../entity/entity-identifier/entity-identifier.service';
import { EntityService } from '../../entity/entity.service';
import { PendingResolutionService } from '../../resolution/pending-resolution.service';
import { JobService } from '../../job/job.service';
import { ChatCategoryService } from '../../chat-category/chat-category.service';
import { SettingsService } from '../../settings/settings.service';
import { CreateMessageDto } from '../dto/create-message.dto';

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    private dataSource: DataSource,
    private interactionService: InteractionService,
    private identifierService: EntityIdentifierService,
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService,
    @Inject(forwardRef(() => PendingResolutionService))
    private pendingResolutionService: PendingResolutionService,
    @Inject(forwardRef(() => JobService))
    private jobService: JobService,
    @Inject(forwardRef(() => ChatCategoryService))
    private chatCategoryService: ChatCategoryService,
    private settingsService: SettingsService,
  ) {}

  async create(dto: CreateMessageDto) {
    // 1. Categorize chat
    const chatCategory = await this.chatCategoryService.categorize({
      telegramChatId: dto.telegram_chat_id,
      chatType: dto.chat_type || 'group',
      participantsCount: dto.participants_count,
    });

    // 2. Find or create interaction (session)
    const interaction = await this.interactionService.findOrCreateSession(
      dto.telegram_chat_id,
      new Date(dto.timestamp),
    );

    // 3. Resolve entity based on category
    let entityId: string | null = null;
    let resolutionStatus = 'resolved';
    let pendingResolutionId: string | null = null;
    let autoCreatedEntity = false;

    const identifier = await this.identifierService.findByIdentifier(
      IdentifierType.TELEGRAM_USER_ID,
      dto.telegram_user_id,
    );

    if (identifier) {
      // Known contact - use existing entity
      entityId = identifier.entityId;
    } else if (chatCategory.category === ChatCategory.PERSONAL && !dto.is_outgoing) {
      // Private chat with unknown contact - auto-create Entity
      const entityName = this.buildEntityName(dto);
      const entity = await this.entityService.create({
        type: EntityType.PERSON,
        name: entityName,
        notes: 'Auto-created from Telegram private chat',
        creationSource: CreationSource.PRIVATE_CHAT,
        identifiers: [
          {
            type: IdentifierType.TELEGRAM_USER_ID,
            value: dto.telegram_user_id,
            metadata: dto.telegram_user_info as Record<string, unknown>,
          },
        ],
      });
      entityId = entity.id;
      autoCreatedEntity = true;
      this.logger.log(
        `Auto-created Entity "${entityName}" for private chat contact ${dto.telegram_user_id}`,
      );
    } else if (chatCategory.category === ChatCategory.WORKING && !dto.is_outgoing) {
      // Working group (<=20 people) - auto-create Entity for all participants
      const entityName = this.buildEntityName(dto);
      const entity = await this.entityService.create({
        type: EntityType.PERSON,
        name: entityName,
        notes: 'Auto-created from working group',
        creationSource: CreationSource.WORKING_GROUP,
        identifiers: [
          {
            type: IdentifierType.TELEGRAM_USER_ID,
            value: dto.telegram_user_id,
            metadata: dto.telegram_user_info as Record<string, unknown>,
          },
        ],
      });
      entityId = entity.id;
      autoCreatedEntity = true;
      this.logger.log(
        `Auto-created Entity "${entityName}" for working group participant ${dto.telegram_user_id}`,
      );
    } else if (!dto.is_outgoing) {
      // Mass group or channel - create pending resolution
      resolutionStatus = 'pending';
      const pending = await this.pendingResolutionService.findOrCreate({
        identifierType: IdentifierType.TELEGRAM_USER_ID,
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
      identifierType: IdentifierType.TELEGRAM_USER_ID,
      identifierValue: dto.telegram_user_id,
      displayName: dto.telegram_display_name,
    });

    // 4. Create or update message with sender identifier for proper attribution
    // Use transaction with SELECT FOR UPDATE to prevent race conditions
    const result = await this.dataSource.transaction(async (manager) => {
      const messageRepo = manager.getRepository(Message);
      let isUpdate = false;

      // Check if message already exists (by sourceMessageId in this interaction)
      let existingMessage: Message | null = null;
      if (dto.message_id) {
        existingMessage = await messageRepo.findOne({
          where: {
            interactionId: interaction.id,
            sourceMessageId: dto.message_id,
          },
          lock: { mode: 'pessimistic_write' }, // Lock to prevent race conditions
        });
      }

      let saved: Message;

      if (existingMessage) {
        // Update existing message with sender identifier and content
        isUpdate = true;
        existingMessage.senderEntityId = entityId;
        existingMessage.senderIdentifierType = IdentifierType.TELEGRAM_USER_ID;
        existingMessage.senderIdentifierValue = dto.telegram_user_id;
        // Also update content and media in case message was edited
        if (dto.text !== undefined) existingMessage.content = dto.text;
        if (dto.media_type !== undefined) existingMessage.mediaType = dto.media_type;
        if (dto.media_url !== undefined) existingMessage.mediaUrl = dto.media_url;
        saved = await messageRepo.save(existingMessage);
        this.logger.debug(`Updated existing message ${saved.id} for sourceMessageId ${dto.message_id}`);
      } else {
        // Create new message
        const message = messageRepo.create({
          interactionId: interaction.id,
          senderEntityId: entityId,
          senderIdentifierType: IdentifierType.TELEGRAM_USER_ID,
          senderIdentifierValue: dto.telegram_user_id,
          content: dto.text,
          isOutgoing: dto.is_outgoing,
          timestamp: new Date(dto.timestamp),
          sourceMessageId: dto.message_id,
          replyToSourceMessageId: dto.reply_to_message_id, // FIX: Save reply_to for context
          mediaType: dto.media_type,
          mediaUrl: dto.media_url,
          // New fields for import logic and forum support
          chatType: dto.chat_type,
          topicId: dto.topic_id,
          topicName: dto.topic_name,
        });

        saved = await messageRepo.save(message);
        this.logger.debug(`Created new message ${saved.id}`);
      }

      return { saved, isUpdate };
    });

    // 5. Queue embedding job (only for new messages with text, or if text was updated)
    if (dto.text && !result.isUpdate) {
      await this.jobService.createEmbeddingJob({
        messageId: result.saved.id,
        content: dto.text,
      });
    }

    // 6. Schedule fact extraction if auto-extraction enabled for this category
    // IMPORTANT: Called AFTER transaction commit to ensure message is visible
    const minMessageLength = await this.settingsService.getValue<number>(
      'extraction.minMessageLength',
    ) ?? 20;

    if (
      chatCategory.autoExtractionEnabled &&
      entityId &&
      dto.text &&
      dto.text.length > minMessageLength &&
      !result.isUpdate
    ) {
      try {
        await this.jobService.scheduleExtraction({
          interactionId: interaction.id,
          entityId,
          messageId: result.saved.id,
          messageContent: dto.text,
        });
      } catch (error) {
        // Don't fail message creation if extraction scheduling fails
        // Facts will be extracted later via historical processing
        this.logger.error(
          `Failed to schedule extraction for message ${result.saved.id}: ${error}`,
        );
      }
    }

    return {
      id: result.saved.id,
      interaction_id: interaction.id,
      entity_id: entityId,
      entity_resolution_status: resolutionStatus,
      pending_resolution_id: pendingResolutionId,
      auto_created_entity: autoCreatedEntity,
      created_at: result.saved.createdAt,
      is_update: result.isUpdate,
      chat_category: chatCategory.category,
    };
  }

  /**
   * Build entity name from Telegram user info.
   * Priority: firstName + lastName > username > displayName > telegram_user_id
   */
  private buildEntityName(dto: CreateMessageDto): string {
    const userInfo = dto.telegram_user_info;

    // Try firstName + lastName
    if (userInfo?.firstName || userInfo?.lastName) {
      return [userInfo.firstName, userInfo.lastName].filter(Boolean).join(' ');
    }

    // Try username
    if (dto.telegram_username) {
      return dto.telegram_username;
    }

    // Try display name
    if (dto.telegram_display_name) {
      return dto.telegram_display_name;
    }

    // Fallback to telegram_user_id
    return `Telegram ${dto.telegram_user_id}`;
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
