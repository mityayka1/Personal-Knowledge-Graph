import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ConversationGroup, MessageData } from './extraction.types';

/**
 * Groups messages into conversations based on time gaps.
 *
 * A conversation is a sequence of messages where the gap between
 * any two consecutive messages is less than conversationGapMinutes (default: 30).
 *
 * This enables extraction to process logically connected messages together,
 * providing context that single-message extraction lacks.
 *
 * Example:
 *   Messages: [14:00, 14:05, 14:10, 15:00, 15:05]
 *   With 30min gap: [[14:00, 14:05, 14:10], [15:00, 15:05]]
 */
@Injectable()
export class ConversationGrouperService {
  private readonly logger = new Logger(ConversationGrouperService.name);

  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Group messages into conversations based on time gaps.
   *
   * @param messages - Messages sorted by timestamp (ascending)
   * @returns Array of conversation groups
   */
  async groupMessages(messages: MessageData[]): Promise<ConversationGroup[]> {
    if (messages.length === 0) {
      return [];
    }

    const gapMs = await this.settingsService.getConversationGapMs();

    // Ensure messages are sorted by timestamp
    const sortedMessages = [...messages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const groups: ConversationGroup[] = [];
    let currentGroup: MessageData[] = [sortedMessages[0]];

    for (let i = 1; i < sortedMessages.length; i++) {
      const prevTimestamp = new Date(sortedMessages[i - 1].timestamp).getTime();
      const currTimestamp = new Date(sortedMessages[i].timestamp).getTime();
      const gap = currTimestamp - prevTimestamp;

      if (gap > gapMs) {
        // Gap exceeds threshold - start new conversation
        groups.push(this.createConversationGroup(currentGroup));
        currentGroup = [sortedMessages[i]];
      } else {
        // Continue current conversation
        currentGroup.push(sortedMessages[i]);
      }
    }

    // Don't forget the last group
    if (currentGroup.length > 0) {
      groups.push(this.createConversationGroup(currentGroup));
    }

    this.logger.debug(
      `Grouped ${messages.length} messages into ${groups.length} conversations (gap=${gapMs / 60000}min)`,
    );

    return groups;
  }

  /**
   * Create a ConversationGroup from a list of messages.
   */
  private createConversationGroup(messages: MessageData[]): ConversationGroup {
    const participantIds = new Set<string>();

    for (const msg of messages) {
      if (msg.senderEntityId) {
        participantIds.add(msg.senderEntityId);
      }
    }

    return {
      messages,
      startedAt: new Date(messages[0].timestamp),
      endedAt: new Date(messages[messages.length - 1].timestamp),
      participantEntityIds: Array.from(participantIds),
    };
  }

  /**
   * Format a conversation group for LLM prompt.
   * Returns a human-readable representation of the conversation.
   */
  formatConversationForPrompt(
    conversation: ConversationGroup,
    options?: {
      includeTimestamps?: boolean;
      maxLength?: number;
    },
  ): string {
    const { includeTimestamps = true, maxLength = 5000 } = options ?? {};

    const lines: string[] = [];
    let totalLength = 0;

    for (const msg of conversation.messages) {
      const sender = msg.isOutgoing ? 'Я' : msg.senderEntityName ?? 'Собеседник';
      const timestamp = includeTimestamps
        ? `[${this.formatTime(msg.timestamp)}] `
        : '';
      const content = msg.content;

      const line = `${timestamp}${sender}: ${content}`;

      if (totalLength + line.length > maxLength) {
        lines.push('... (сообщения сокращены)');
        break;
      }

      lines.push(line);
      totalLength += line.length;
    }

    return lines.join('\n');
  }

  /**
   * Format timestamp as HH:MM for display.
   */
  private formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Get conversation statistics for logging/debugging.
   */
  getStats(groups: ConversationGroup[]): {
    totalMessages: number;
    conversationCount: number;
    avgMessagesPerConversation: number;
    longestConversation: number;
  } {
    const totalMessages = groups.reduce((sum, g) => sum + g.messages.length, 0);
    const longestConversation = Math.max(...groups.map((g) => g.messages.length), 0);

    return {
      totalMessages,
      conversationCount: groups.length,
      avgMessagesPerConversation:
        groups.length > 0 ? Math.round(totalMessages / groups.length) : 0,
      longestConversation,
    };
  }
}
