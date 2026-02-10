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
  FactType,
  FactSource,
  FactCategory,
} from '@pkg/entities';
import { InteractionService } from '../interaction.service';
import { EntityIdentifierService } from '../../entity/entity-identifier/entity-identifier.service';
import { EntityService } from '../../entity/entity.service';
import { EntityFactService } from '../../entity/entity-fact/entity-fact.service';
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
    @Inject(forwardRef(() => EntityFactService))
    private entityFactService: EntityFactService,
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
    // For private chats, use display name as title; for groups, use chat_title
    const chatTitle = dto.chat_title || (dto.chat_type === 'private' ? dto.telegram_display_name : null);
    const chatCategory = await this.chatCategoryService.categorize({
      telegramChatId: dto.telegram_chat_id,
      chatType: dto.chat_type || 'group',
      participantsCount: dto.participants_count,
      title: chatTitle,
    });

    // 2. Find or create interaction (session)
    // Pass chat_type to store in sourceMetadata (only private/group/supergroup are relevant)
    const chatTypeForSession = dto.chat_type as 'private' | 'group' | 'supergroup' | undefined;
    const interaction = await this.interactionService.findOrCreateSession(
      dto.telegram_chat_id,
      new Date(dto.timestamp),
      chatTypeForSession,
    );

    // 3. Resolve entity based on category
    let entityId: string | null = null;
    let senderEntityName: string | null = null; // For proper attribution in group chats
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

      // Load entity name for extraction attribution
      const existingEntity = await this.entityService.findOne(entityId);
      senderEntityName = existingEntity?.name || dto.telegram_display_name || null;

      // Update missing identifiers (e.g., username became available)
      await this.updateMissingIdentifiers(entityId, dto);
    } else if (chatCategory.category === ChatCategory.PERSONAL && !dto.is_outgoing) {
      // Private chat with unknown contact - auto-create Entity with all available data
      const entityName = this.buildEntityName(dto);
      const identifiers = this.buildIdentifiers(dto);
      const entity = await this.entityService.create({
        type: EntityType.PERSON,
        name: entityName,
        notes: 'Auto-created from Telegram private chat',
        profilePhoto: dto.telegram_user_info?.photoBase64,
        creationSource: CreationSource.PRIVATE_CHAT,
        isBot: dto.telegram_user_info?.isBot ?? false,
        identifiers,
      });
      entityId = entity.id;
      senderEntityName = entityName;
      autoCreatedEntity = true;
      this.logger.log(
        `Auto-created Entity "${entityName}" for private chat contact ${dto.telegram_user_id} with ${identifiers.length} identifiers (isBot: ${entity.isBot})`,
      );
    } else if (chatCategory.category === ChatCategory.WORKING && !dto.is_outgoing) {
      // Working group (<=20 people) - auto-create Entity with all available data
      const entityName = this.buildEntityName(dto);
      const identifiers = this.buildIdentifiers(dto);
      const entity = await this.entityService.create({
        type: EntityType.PERSON,
        name: entityName,
        notes: 'Auto-created from working group',
        profilePhoto: dto.telegram_user_info?.photoBase64,
        creationSource: CreationSource.WORKING_GROUP,
        isBot: dto.telegram_user_info?.isBot ?? false,
        identifiers,
      });
      entityId = entity.id;
      senderEntityName = entityName;
      autoCreatedEntity = true;
      this.logger.log(
        `Auto-created Entity "${entityName}" for working group participant ${dto.telegram_user_id} with ${identifiers.length} identifiers (isBot: ${entity.isBot})`,
      );
    } else if (!dto.is_outgoing) {
      // Mass group or channel - create pending resolution
      resolutionStatus = 'pending';
      const pending = await this.pendingResolutionService.findOrCreate({
        identifierType: IdentifierType.TELEGRAM_USER_ID,
        identifierValue: dto.telegram_user_id,
        displayName: dto.telegram_display_name || dto.telegram_username,
        messageTimestamp: new Date(dto.timestamp),
        // Spread to convert class instance to plain object for index signature compatibility
        metadata: dto.telegram_user_info ? { ...dto.telegram_user_info } : undefined,
      });
      pendingResolutionId = pending.id;
      // Use display name as fallback for pending entities
      senderEntityName = dto.telegram_display_name || dto.telegram_username || null;
    }

    // 3b. Resolve RECIPIENT entity for outgoing messages in private chats
    let recipientEntityId: string | null = null;
    if (dto.is_outgoing && chatCategory.category === ChatCategory.PERSONAL && dto.recipient_user_id) {
      recipientEntityId = await this.resolveRecipientEntity(dto);
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
        existingMessage.recipientEntityId = recipientEntityId;
        existingMessage.senderIdentifierType = IdentifierType.TELEGRAM_USER_ID;
        existingMessage.senderIdentifierValue = dto.telegram_user_id;
        // Also update content and media in case message was edited
        if (dto.text !== undefined) existingMessage.content = dto.text;
        if (dto.media_type !== undefined) existingMessage.mediaType = dto.media_type;
        if (dto.media_url !== undefined) existingMessage.mediaUrl = dto.media_url;
        if (dto.media_metadata !== undefined) existingMessage.mediaMetadata = dto.media_metadata;
        saved = await messageRepo.save(existingMessage);
        this.logger.debug(`Updated existing message ${saved.id} for sourceMessageId ${dto.message_id}`);
      } else {
        // Create new message
        const message = messageRepo.create({
          interactionId: interaction.id,
          senderEntityId: entityId,
          recipientEntityId: recipientEntityId, // For outgoing private chat messages
          senderIdentifierType: IdentifierType.TELEGRAM_USER_ID,
          senderIdentifierValue: dto.telegram_user_id,
          content: dto.text,
          isOutgoing: dto.is_outgoing,
          timestamp: new Date(dto.timestamp),
          sourceMessageId: dto.message_id,
          replyToSourceMessageId: dto.reply_to_message_id, // FIX: Save reply_to for context
          mediaType: dto.media_type,
          mediaUrl: dto.media_url,
          mediaMetadata: dto.media_metadata,
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

    // 5. Resolve reply_to reference if present
    // This must happen AFTER transaction commit so the referenced message is visible
    if (dto.reply_to_message_id && !result.isUpdate) {
      try {
        const replyToMessage = await this.messageRepo.findOne({
          where: {
            interactionId: interaction.id,
            sourceMessageId: dto.reply_to_message_id,
          },
          select: ['id'],
        });
        if (replyToMessage) {
          await this.messageRepo.update(result.saved.id, {
            replyToMessageId: replyToMessage.id,
          });
          this.logger.debug(
            `Resolved reply_to: ${dto.reply_to_message_id} -> ${replyToMessage.id}`,
          );
        }
      } catch (error) {
        // Non-critical: reply chain is nice-to-have, don't fail message creation
        this.logger.warn(`Failed to resolve reply_to for ${dto.reply_to_message_id}: ${error}`);
      }
    }

    // 6. Queue embedding job (only for new messages with text, or if text was updated)
    if (dto.text && !result.isUpdate) {
      await this.jobService.createEmbeddingJob({
        messageId: result.saved.id,
        content: dto.text,
      });
    }

    // 7. Schedule fact extraction if auto-extraction enabled for this category
    // IMPORTANT: Called AFTER transaction commit to ensure message is visible
    const minMessageLength = await this.settingsService.getValue<number>(
      'extraction.minMessageLength',
    ) ?? 20;

    if (
      chatCategory.autoExtractionEnabled &&
      entityId &&
      dto.text &&
      dto.text.length > minMessageLength &&
      !result.isUpdate &&
      !dto.telegram_user_info?.isBot // Skip bot messages
    ) {
      try {
        await this.jobService.scheduleExtraction({
          interactionId: interaction.id,
          entityId,
          messageId: result.saved.id,
          messageContent: dto.text,
          isOutgoing: dto.is_outgoing,
          replyToSourceMessageId: dto.reply_to_message_id,
          topicName: dto.topic_name,
          // For proper attribution in group chats
          senderEntityId: entityId,
          senderEntityName: senderEntityName || undefined,
          // Note: isBotSender is always false here due to the check above,
          // but included for consistency and safety in batch processing
          isBotSender: dto.telegram_user_info?.isBot ?? false,
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
      recipient_entity_id: recipientEntityId,
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

  /**
   * Build all available identifiers from Telegram user info.
   * Creates: telegram_user_id (always), telegram_username (if present), phone (if present)
   */
  private buildIdentifiers(dto: CreateMessageDto): Array<{
    type: IdentifierType;
    value: string;
    metadata?: Record<string, unknown>;
  }> {
    const identifiers: Array<{
      type: IdentifierType;
      value: string;
      metadata?: Record<string, unknown>;
    }> = [];

    // 1. Always add telegram_user_id
    identifiers.push({
      type: IdentifierType.TELEGRAM_USER_ID,
      value: dto.telegram_user_id,
      metadata: dto.telegram_user_info as Record<string, unknown>,
    });

    // 2. Add telegram_username if present
    const username = dto.telegram_username || dto.telegram_user_info?.username;
    if (username) {
      identifiers.push({
        type: IdentifierType.TELEGRAM_USERNAME,
        value: username.replace(/^@/, ''), // Remove @ prefix if present
      });
    }

    // 3. Add phone if present in user info
    const phone = dto.telegram_user_info?.phone;
    if (phone) {
      identifiers.push({
        type: IdentifierType.PHONE,
        value: phone,
      });
    }

    return identifiers;
  }

  /**
   * Update entity data and identifiers when new information becomes available.
   * Updates: name (if was auto-generated), profile photo, identifiers (username, phone).
   */
  private async updateMissingIdentifiers(
    entityId: string,
    dto: CreateMessageDto,
  ): Promise<void> {
    // 1. Update entity data (name, photo) if improved info available
    await this.updateEntityData(entityId, dto);

    // 2. Add telegram_username if not exists
    const username = dto.telegram_username || dto.telegram_user_info?.username;
    if (username) {
      const cleanUsername = username.replace(/^@/, '');
      const existingUsername = await this.identifierService.findByIdentifier(
        IdentifierType.TELEGRAM_USERNAME,
        cleanUsername,
      );
      if (!existingUsername) {
        try {
          await this.identifierService.create(entityId, {
            type: IdentifierType.TELEGRAM_USERNAME,
            value: cleanUsername,
          });
          this.logger.log(`Added telegram_username "${cleanUsername}" to entity ${entityId}`);
        } catch (error) {
          // Ignore duplicate key errors (race condition)
          if (!(error instanceof Error) || !error.message.includes('duplicate')) {
            this.logger.warn(`Failed to add username: ${error}`);
          }
        }
      }
    }

    // 3. Add phone if not exists
    const phone = dto.telegram_user_info?.phone;
    if (phone) {
      const existingPhone = await this.identifierService.findByIdentifier(
        IdentifierType.PHONE,
        phone,
      );
      if (!existingPhone) {
        try {
          await this.identifierService.create(entityId, {
            type: IdentifierType.PHONE,
            value: phone,
          });
          this.logger.log(`Added phone "${phone}" to entity ${entityId}`);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('duplicate')) {
            this.logger.warn(`Failed to add phone: ${error}`);
          }
        }
      }
    }
  }

  /**
   * Update entity name, photo, and facts if better data is available.
   * - Updates name if it was auto-generated ("Telegram XXXXX")
   * - Updates profile photo if not set
   * - Saves birthday as EntityFact if available and not already stored
   */
  private async updateEntityData(
    entityId: string,
    dto: CreateMessageDto,
  ): Promise<void> {
    try {
      const entity = await this.entityService.findOne(entityId);
      const updates: { name?: string; profilePhoto?: string } = {};

      // Update name if it was auto-generated (starts with "Telegram ") and we have a better one
      if (entity.name.startsWith('Telegram ')) {
        const newName = this.buildEntityName(dto);
        if (!newName.startsWith('Telegram ')) {
          updates.name = newName;
          this.logger.log(`Updating entity name from "${entity.name}" to "${newName}"`);
        }
      }

      // Update profile photo if not set
      if (!entity.profilePhoto && dto.telegram_user_info?.photoBase64) {
        updates.profilePhoto = dto.telegram_user_info.photoBase64;
        this.logger.log(`Adding profile photo to entity ${entityId}`);
      }

      // Apply updates if any
      if (Object.keys(updates).length > 0) {
        await this.entityService.update(entityId, updates);
      }

      // Save birthday as fact if available
      if (dto.telegram_user_info?.birthday) {
        await this.saveBirthdayFact(entityId, dto.telegram_user_info.birthday);
      }
    } catch (error) {
      this.logger.warn(`Failed to update entity data: ${error}`);
    }
  }

  /**
   * Save birthday as EntityFact if not already exists.
   * Birthday format: "YYYY-MM-DD" or "MM-DD" (if year not shared)
   */
  private async saveBirthdayFact(entityId: string, birthday: string): Promise<void> {
    try {
      // Check if birthday fact already exists
      const existingFacts = await this.entityFactService.findByEntity(entityId);
      const hasBirthday = existingFacts.some(f => f.factType === FactType.BIRTHDAY);

      if (hasBirthday) {
        return; // Birthday already stored
      }

      // Parse birthday and create fact
      // Format: "YYYY-MM-DD" or "MM-DD"
      let valueDate: Date | undefined;
      if (birthday.length === 10) {
        // Full date with year: YYYY-MM-DD
        valueDate = new Date(birthday);
      } else if (birthday.length === 5) {
        // Only month-day: MM-DD, use year 1900 as placeholder
        valueDate = new Date(`1900-${birthday}`);
      }

      await this.entityFactService.create(entityId, {
        type: FactType.BIRTHDAY,
        category: FactCategory.PERSONAL,
        value: birthday,
        valueDate,
        source: FactSource.IMPORTED,
      });

      this.logger.log(`Saved birthday fact "${birthday}" for entity ${entityId}`);
    } catch (error) {
      this.logger.warn(`Failed to save birthday fact: ${error}`);
    }
  }

  /**
   * Resolve or create recipient entity for outgoing messages in private chats.
   * Updates entity data (name, photo, birthday) if entity exists.
   */
  private async resolveRecipientEntity(dto: CreateMessageDto): Promise<string | null> {
    if (!dto.recipient_user_id) {
      return null;
    }

    try {
      // Find existing entity by recipient's telegram_user_id
      const identifier = await this.identifierService.findByIdentifier(
        IdentifierType.TELEGRAM_USER_ID,
        dto.recipient_user_id,
      );

      if (identifier) {
        // Known recipient - update their data if improved info available
        await this.updateRecipientEntityData(identifier.entityId, dto);
        return identifier.entityId;
      }

      // Unknown recipient - auto-create entity
      const recipientInfo = dto.recipient_user_info;
      const entityName = this.buildRecipientEntityName(dto);
      const identifiers = this.buildRecipientIdentifiers(dto);

      const entity = await this.entityService.create({
        type: EntityType.PERSON,
        name: entityName,
        notes: 'Auto-created from outgoing Telegram message',
        profilePhoto: recipientInfo?.photoBase64,
        creationSource: CreationSource.PRIVATE_CHAT,
        isBot: recipientInfo?.isBot ?? false,
        identifiers,
      });

      this.logger.log(
        `Auto-created recipient Entity "${entityName}" from outgoing message to ${dto.recipient_user_id}`,
      );

      // Save birthday if available
      if (recipientInfo?.birthday) {
        await this.saveBirthdayFact(entity.id, recipientInfo.birthday);
      }

      return entity.id;
    } catch (error) {
      this.logger.warn(`Failed to resolve recipient entity: ${error}`);
      return null;
    }
  }

  /**
   * Build entity name from recipient's Telegram user info.
   */
  private buildRecipientEntityName(dto: CreateMessageDto): string {
    const userInfo = dto.recipient_user_info;

    // Try firstName + lastName
    if (userInfo?.firstName || userInfo?.lastName) {
      return [userInfo.firstName, userInfo.lastName].filter(Boolean).join(' ');
    }

    // Try username
    if (userInfo?.username) {
      return userInfo.username;
    }

    // Fallback to telegram_user_id
    return `Telegram ${dto.recipient_user_id}`;
  }

  /**
   * Build identifiers from recipient's Telegram user info.
   */
  private buildRecipientIdentifiers(dto: CreateMessageDto): Array<{
    type: IdentifierType;
    value: string;
    metadata?: Record<string, unknown>;
  }> {
    const identifiers: Array<{
      type: IdentifierType;
      value: string;
      metadata?: Record<string, unknown>;
    }> = [];

    // Always add telegram_user_id
    if (dto.recipient_user_id) {
      identifiers.push({
        type: IdentifierType.TELEGRAM_USER_ID,
        value: dto.recipient_user_id,
        metadata: dto.recipient_user_info as Record<string, unknown>,
      });
    }

    // Add telegram_username if present
    const username = dto.recipient_user_info?.username;
    if (username) {
      identifiers.push({
        type: IdentifierType.TELEGRAM_USERNAME,
        value: username.replace(/^@/, ''),
      });
    }

    // Add phone if present
    const phone = dto.recipient_user_info?.phone;
    if (phone) {
      identifiers.push({
        type: IdentifierType.PHONE,
        value: phone,
      });
    }

    return identifiers;
  }

  /**
   * Update recipient entity data (name, photo, birthday) if better info available.
   */
  private async updateRecipientEntityData(entityId: string, dto: CreateMessageDto): Promise<void> {
    const recipientInfo = dto.recipient_user_info;
    if (!recipientInfo) {
      return;
    }

    try {
      const entity = await this.entityService.findOne(entityId);
      const updates: { name?: string; profilePhoto?: string } = {};

      // Update name if it was auto-generated
      if (entity.name.startsWith('Telegram ')) {
        const newName = this.buildRecipientEntityName(dto);
        if (!newName.startsWith('Telegram ')) {
          updates.name = newName;
          this.logger.log(`Updating recipient entity name from "${entity.name}" to "${newName}"`);
        }
      }

      // Update profile photo if not set
      if (!entity.profilePhoto && recipientInfo.photoBase64) {
        updates.profilePhoto = recipientInfo.photoBase64;
        this.logger.log(`Adding profile photo to recipient entity ${entityId}`);
      }

      // Apply updates if any
      if (Object.keys(updates).length > 0) {
        await this.entityService.update(entityId, updates);
      }

      // Save birthday if available
      if (recipientInfo.birthday) {
        await this.saveBirthdayFact(entityId, recipientInfo.birthday);
      }

      // Add missing identifiers (username, phone)
      await this.addRecipientIdentifiers(entityId, dto);
    } catch (error) {
      this.logger.warn(`Failed to update recipient entity data: ${error}`);
    }
  }

  /**
   * Add missing identifiers to recipient entity.
   */
  private async addRecipientIdentifiers(entityId: string, dto: CreateMessageDto): Promise<void> {
    const recipientInfo = dto.recipient_user_info;
    if (!recipientInfo) {
      return;
    }

    // Add telegram_username if not exists
    const username = recipientInfo.username;
    if (username) {
      const cleanUsername = username.replace(/^@/, '');
      const existingUsername = await this.identifierService.findByIdentifier(
        IdentifierType.TELEGRAM_USERNAME,
        cleanUsername,
      );
      if (!existingUsername) {
        try {
          await this.identifierService.create(entityId, {
            type: IdentifierType.TELEGRAM_USERNAME,
            value: cleanUsername,
          });
          this.logger.log(`Added telegram_username "${cleanUsername}" to recipient entity ${entityId}`);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('duplicate')) {
            this.logger.warn(`Failed to add recipient username: ${error}`);
          }
        }
      }
    }

    // Add phone if not exists
    const phone = recipientInfo.phone;
    if (phone) {
      const existingPhone = await this.identifierService.findByIdentifier(
        IdentifierType.PHONE,
        phone,
      );
      if (!existingPhone) {
        try {
          await this.identifierService.create(entityId, {
            type: IdentifierType.PHONE,
            value: phone,
          });
          this.logger.log(`Added phone "${phone}" to recipient entity ${entityId}`);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('duplicate')) {
            this.logger.warn(`Failed to add recipient phone: ${error}`);
          }
        }
      }
    }
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

  /**
   * Get messages by Telegram chat ID
   * Joins through interaction to find messages belonging to this chat
   */
  async findByTelegramChatId(
    telegramChatId: string,
    options?: {
      limit?: number;
      offset?: number;
      order?: 'ASC' | 'DESC';
    },
  ) {
    const { limit = 100, offset = 0, order = 'DESC' } = options || {};

    const [items, total] = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin('interactions', 'i', 'm.interaction_id = i.id')
      .where("i.source_metadata->>'telegram_chat_id' = :chatId", { chatId: telegramChatId })
      .orderBy('m.timestamp', order)
      .limit(limit)
      .offset(offset)
      .getManyAndCount();

    return { items, total, limit, offset };
  }

  /**
   * Get message with sender info for display
   */
  async findByTelegramChatIdWithSenders(
    telegramChatId: string,
    options?: {
      limit?: number;
      offset?: number;
      order?: 'ASC' | 'DESC';
    },
  ) {
    const { limit = 100, offset = 0, order = 'DESC' } = options || {};

    const [items, total] = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin('interactions', 'i', 'm.interaction_id = i.id')
      .leftJoinAndSelect('m.senderEntity', 'entity')
      .where("i.source_metadata->>'telegram_chat_id' = :chatId", { chatId: telegramChatId })
      .orderBy('m.timestamp', order)
      .limit(limit)
      .offset(offset)
      .getManyAndCount();

    return { items, total, limit, offset };
  }

  /**
   * Find messages from interactions where specified entities are participants.
   * Used for cross-chat context - fetching related messages from other chats
   * involving the same people within a time window.
   */
  async findByEntitiesInTimeWindow(params: {
    entityIds: string[];
    from: Date;
    to: Date;
    excludeInteractionId?: string;
    limit?: number;
  }): Promise<Message[]> {
    if (params.entityIds.length === 0) {
      return [];
    }

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .innerJoinAndSelect('m.interaction', 'interaction')
      .innerJoin('interaction.participants', 'p')
      .where('p.entityId IN (:...entityIds)', { entityIds: params.entityIds })
      .andWhere('m.timestamp BETWEEN :from AND :to', {
        from: params.from,
        to: params.to,
      });

    if (params.excludeInteractionId) {
      qb.andWhere('m.interactionId != :excludeId', {
        excludeId: params.excludeInteractionId,
      });
    }

    return qb
      .orderBy('m.timestamp', 'DESC')
      .take(params.limit ?? 20)
      .getMany();
  }
}
