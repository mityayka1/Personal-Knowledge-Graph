import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Message } from '@pkg/entities';
import { MessageService } from '../interaction/message/message.service';
import { SettingsService } from '../settings/settings.service';

/**
 * CrossChatContextService provides context from other chats
 * involving the same participants within a time window.
 *
 * Use case: When extracting facts from a conversation, we may need
 * additional context from parallel conversations with the same people
 * to better understand references and topics being discussed.
 *
 * Example:
 *   User A sends "давай как договорились" in Chat 1
 *   Without context: unclear what they agreed on
 *   With cross-chat context: we see they discussed delivery at 15:00 in Chat 2
 */
@Injectable()
export class CrossChatContextService {
  private readonly logger = new Logger(CrossChatContextService.name);

  constructor(
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Get formatted context from other chats with the same participants.
   *
   * @param currentInteractionId - Interaction to exclude from results
   * @param participantEntityIds - Entity IDs of participants to look for
   * @param referenceTime - Reference point for the time window (usually conversation end time)
   * @returns Formatted context string or null if no relevant messages found
   */
  async getContext(
    currentInteractionId: string,
    participantEntityIds: string[],
    referenceTime: Date,
  ): Promise<string | null> {
    if (participantEntityIds.length === 0) {
      return null;
    }

    const windowMs = await this.settingsService.getCrossChatContextMs();
    const fromTime = new Date(referenceTime.getTime() - windowMs);

    this.logger.debug(
      `Searching cross-chat context for ${participantEntityIds.length} entities ` +
        `in window ${fromTime.toISOString()} - ${referenceTime.toISOString()}`,
    );

    const messages = await this.messageService.findByEntitiesInTimeWindow({
      entityIds: participantEntityIds,
      from: fromTime,
      to: referenceTime,
      excludeInteractionId: currentInteractionId,
      limit: 20,
    });

    if (messages.length === 0) {
      this.logger.debug('No cross-chat context found');
      return null;
    }

    this.logger.debug(
      `Found ${messages.length} messages from other chats for context`,
    );

    return this.formatContext(messages);
  }

  /**
   * Format messages into a context string for LLM prompt.
   * Groups by chat and shows timestamps for temporal reference.
   */
  private formatContext(messages: Message[]): string {
    // Sort by timestamp ascending for chronological display
    const sorted = [...messages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const lines = sorted.map((m) => {
      const time = this.formatTime(m.timestamp);
      const sender = m.isOutgoing ? 'Я' : 'Собеседник';
      const chat = this.getChatName(m);
      const content = this.truncateContent(m.content || '', 200);

      return `[${time}] ${chat} | ${sender}: ${content}`;
    });

    return lines.join('\n');
  }

  /**
   * Extract chat name from interaction metadata.
   */
  private getChatName(message: Message): string {
    if (!message.interaction) {
      return 'Чат';
    }

    const metadata = message.interaction.sourceMetadata;
    if (metadata?.telegram_chat_id) {
      // For Telegram, we could show chat type or ID
      return metadata.chat_type === 'private'
        ? 'Личный чат'
        : `Чат ${metadata.telegram_chat_id.slice(-4)}`;
    }

    return 'Чат';
  }

  /**
   * Format timestamp as HH:MM for display.
   */
  private formatTime(timestamp: Date | string): string {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    return date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Truncate content to max length with ellipsis.
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    return content.slice(0, maxLength - 3) + '...';
  }
}
