/**
 * Types for conversation-based extraction.
 *
 * Conversations are virtual groupings of messages within a session,
 * separated by gaps of 30 minutes (configurable via extraction.conversationGapMinutes).
 *
 * Session (4h gap) -> Conversation 1 (30m gap) -> [msg1, msg2, msg3]
 *                  -> Conversation 2 (30m gap) -> [msg4, msg5]
 */

/**
 * Minimal message data for extraction processing.
 * Extracted from Message entity for lightweight handling.
 */
export interface MessageData {
  id: string;
  content: string;
  timestamp: string; // ISO 8601
  isOutgoing: boolean;
  replyToSourceMessageId?: string;
  topicName?: string;
  senderEntityId?: string;
  senderEntityName?: string;
  isBotSender?: boolean;
}

/**
 * A group of messages forming a logical conversation.
 * Messages within a conversation have gaps < conversationGapMinutes.
 */
export interface ConversationGroup {
  /** Messages in chronological order */
  messages: MessageData[];

  /** Timestamp of first message */
  startedAt: Date;

  /** Timestamp of last message */
  endedAt: Date;

  /** Entity IDs of all participants (senders) in this conversation */
  participantEntityIds: string[];
}

/**
 * Extended job data for conversation-based extraction.
 */
export interface ConversationExtractionJobData {
  interactionId: string;
  entityId: string;

  /** Grouped conversations for extraction */
  conversations: ConversationGroup[];

  /** Legacy: single messages array for backward compatibility */
  messages?: MessageData[];
}

/**
 * Cross-chat context data for extraction prompt.
 */
export interface CrossChatContext {
  /** Interaction (chat) name */
  chatName: string;

  /** Type of chat (private, group, channel) */
  chatType: string;

  /** Messages from this chat */
  messages: MessageData[];

  /** Time window description (e.g., "last 30 minutes") */
  timeWindow: string;
}
