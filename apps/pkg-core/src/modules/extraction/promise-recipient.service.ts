import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, Interaction } from '@pkg/entities';

/** Chat type constants */
const CHAT_TYPE_PRIVATE = 'private';

/** Information about a replied-to message */
export interface ReplyToInfo {
  content?: string;
  senderEntityId?: string;
  senderName?: string;
}

/** Message data needed for reply info loading */
export interface MessageWithReplyInfo {
  replyToSourceMessageId?: string;
}

/**
 * Service for determining promise recipients.
 * Handles the domain logic for figuring out WHO a promise was made to.
 */
@Injectable()
export class PromiseRecipientService {
  private readonly logger = new Logger(PromiseRecipientService.name);

  constructor(
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(Interaction)
    private readonly interactionRepo: Repository<Interaction>,
  ) {}

  /**
   * Resolve the recipient of a promise based on context.
   *
   * Logic:
   * 1. Only outgoing messages can have a promise recipient (I made the promise)
   * 2. For private chats: recipient is the contact (entityId)
   * 3. For group chats with reply: recipient is the sender of the replied message
   * 4. Otherwise: no specific recipient
   */
  async resolveRecipient(params: {
    interactionId: string;
    entityId: string;
    isOutgoing: boolean;
    replyToSenderEntityId?: string;
  }): Promise<string | undefined> {
    // Only outgoing messages can have a promise recipient
    if (!params.isOutgoing) {
      return undefined;
    }

    // 1. For private chats: recipient is the contact (entityId)
    const isPrivate = await this.isPrivateChat(params.interactionId);
    if (isPrivate) {
      // In private chat context, entityId IS the contact we're chatting with
      return params.entityId;
    }

    // 2. For group chats with reply: recipient is the sender of the replied message
    if (params.replyToSenderEntityId) {
      return params.replyToSenderEntityId;
    }

    // 3. No specific recipient determined
    return undefined;
  }

  /**
   * Check if an interaction is a private chat.
   */
  async isPrivateChat(interactionId: string): Promise<boolean> {
    const interaction = await this.interactionRepo.findOne({
      where: { id: interactionId },
    });

    if (!interaction) {
      return false;
    }

    const sourceMetadata = interaction.sourceMetadata as Record<string, unknown> | null;
    const chatType = sourceMetadata?.chat_type as string | undefined;

    return chatType === CHAT_TYPE_PRIVATE;
  }

  /**
   * Load info about messages that are being replied to.
   * Returns a map of sourceMessageId -> ReplyToInfo (content, senderEntityId, senderName)
   */
  async loadReplyToInfo(
    messages: MessageWithReplyInfo[],
    interactionId: string,
  ): Promise<Map<string, ReplyToInfo>> {
    const replyToIds = messages
      .map((m) => m.replyToSourceMessageId)
      .filter((id): id is string => !!id);

    if (replyToIds.length === 0) {
      return new Map();
    }

    // Find messages by their source_message_id (Telegram message ID)
    // Include sender info for determining promiseToEntityId
    const replyToMessages = await this.messageRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.senderEntity', 'sender')
      .where('m.sourceMessageId IN (:...ids)', { ids: replyToIds })
      .andWhere('m.interactionId = :interactionId', { interactionId })
      .getMany();

    const infoMap = new Map<string, ReplyToInfo>();
    for (const msg of replyToMessages) {
      if (msg.sourceMessageId) {
        infoMap.set(msg.sourceMessageId, {
          content: msg.content || undefined,
          senderEntityId: msg.senderEntityId || undefined,
          senderName: msg.senderEntity?.name || undefined,
        });
      }
    }

    this.logger.debug(
      `Loaded ${infoMap.size} reply-to messages for ${replyToIds.length} replies`,
    );

    return infoMap;
  }
}
