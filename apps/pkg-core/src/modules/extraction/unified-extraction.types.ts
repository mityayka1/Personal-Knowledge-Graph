/**
 * Types for UnifiedExtractionService — single agent call
 * that replaces 3 separate extraction flows (facts, events, second-brain).
 */

/**
 * Input message format from ExtractionJobData.
 * Matches the message shape provided by FactExtractionProcessor.
 */
export interface ExtractionMessage {
  id: string;
  content: string;
  timestamp?: string;
  isOutgoing?: boolean;
  senderEntityId?: string;
  senderEntityName?: string;
  isBotSender?: boolean;
  replyToSourceMessageId?: string;
  topicName?: string;
}

/**
 * Parameters for unified extraction.
 */
export interface UnifiedExtractionParams {
  entityId: string;
  entityName: string;
  messages: ExtractionMessage[];
  interactionId: string;
}

/**
 * Enriched message with resolved promise recipient and reply-to context.
 */
export interface EnrichedMessage extends ExtractionMessage {
  /** Resolved entity ID for this message sender */
  entityId: string;
  /** Resolved entity name for this message sender */
  entityName: string;
  /** ID of entity who receives the promise (for outgoing promise messages) */
  promiseToEntityId?: string;
  /** Content of the message being replied to */
  replyToContent?: string;
  /** Name of the sender of the replied-to message */
  replyToSenderName?: string;
}

/**
 * Structured response from the unified extraction agent.
 * Agent fills this after completing all tool calls.
 */
export interface UnifiedExtractionResponse {
  factsCreated: number;
  eventsCreated: number;
  relationsCreated: number;
  pendingEntities: number;
  summary: string;
}

/**
 * Result returned by UnifiedExtractionService.extract().
 */
export interface UnifiedExtractionResult {
  factsCreated: number;
  eventsCreated: number;
  relationsCreated: number;
  pendingEntities: number;
  turns: number;
  toolsUsed: string[];
  tokensUsed: number;
}
