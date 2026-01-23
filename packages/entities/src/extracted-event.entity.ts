import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Message } from './message.entity';
import { Interaction } from './interaction.entity';

/**
 * Types of events that can be extracted from messages
 */
export enum ExtractedEventType {
  /** Planned meeting/call - "созвонимся завтра в 15:00" */
  MEETING = 'meeting',
  /** Promise made by the user - "я пришлю завтра" */
  PROMISE_BY_ME = 'promise_by_me',
  /** Promise made by the contact - "я тебе перезвоню" */
  PROMISE_BY_THEM = 'promise_by_them',
  /** Task/request from contact - "можешь глянуть документ?" */
  TASK = 'task',
  /** Personal fact about contact - "у меня ДР 15 марта" */
  FACT = 'fact',
  /** Cancellation or rescheduling - "давай перенесём" */
  CANCELLATION = 'cancellation',
}

/**
 * Processing status of extracted event
 */
export enum ExtractedEventStatus {
  /** Waiting for user confirmation */
  PENDING = 'pending',
  /** User confirmed the event */
  CONFIRMED = 'confirmed',
  /** User rejected/dismissed the event */
  REJECTED = 'rejected',
  /** Automatically processed (high confidence) */
  AUTO_PROCESSED = 'auto_processed',
  /** Expired without user action */
  EXPIRED = 'expired',
}

/**
 * Data structure for meeting events
 */
export interface MeetingEventData {
  /** ISO datetime if parsed */
  datetime?: string;
  /** Original text reference - "завтра в 15:00" */
  dateText?: string;
  /** Meeting topic if mentioned */
  topic?: string;
  /** Mentioned participants */
  participants?: string[];
}

/**
 * Data structure for promise events
 */
export interface PromiseEventData {
  /** What was promised */
  what: string;
  /** ISO datetime deadline if parsed */
  deadline?: string;
  /** Original deadline text - "до пятницы" */
  deadlineText?: string;
}

/**
 * Data structure for task events
 */
export interface TaskEventData {
  /** What is being requested */
  what: string;
  /** Priority if mentioned */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** ISO datetime deadline if mentioned */
  deadline?: string;
  /** Original deadline text */
  deadlineText?: string;
}

/**
 * Data structure for fact events
 */
export interface FactEventData {
  /** Type of fact - birthday, phone, email, position, etc. */
  factType: string;
  /** Extracted value */
  value: string;
  /** Original quote from message */
  quote: string;
}

/**
 * Data structure for cancellation events
 */
export interface CancellationEventData {
  /** What is being cancelled/rescheduled */
  what: string;
  /** New date/time if rescheduling */
  newDateTime?: string;
  /** Original text */
  newDateText?: string;
  /** Reason if provided */
  reason?: string;
}

/**
 * Data structure for context enrichment results
 */
export interface EnrichmentData {
  /** Keywords extracted from the abstract event */
  keywords?: string[];
  /** Message IDs that were found as potential context */
  relatedMessageIds?: string[];
  /** Event IDs that were considered as potential links */
  candidateEventIds?: string[];
  /** LLM synthesis of the context */
  synthesis?: string;
  /** Whether enrichment was successful */
  enrichmentSuccess?: boolean;
  /** Reason if enrichment failed */
  enrichmentFailureReason?: string;
  /** Timestamp when enrichment was performed */
  enrichedAt?: string;
}

/**
 * Union type for all extracted event data
 */
export type ExtractedEventData =
  | MeetingEventData
  | PromiseEventData
  | TaskEventData
  | FactEventData
  | CancellationEventData
  | Record<string, unknown>;

/**
 * Entity for storing events extracted from messages by AI
 *
 * Events are extracted automatically and wait for user confirmation
 * before being converted to EntityEvent or EntityFact.
 */
@Entity('extracted_events')
export class ExtractedEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ==================== Source References ====================

  /** ID of the message this event was extracted from */
  @Column({ name: 'source_message_id', type: 'uuid' })
  @Index()
  sourceMessageId: string;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'source_message_id' })
  sourceMessage: Message;

  /** ID of the interaction (chat session) */
  @Column({ name: 'source_interaction_id', type: 'uuid', nullable: true })
  sourceInteractionId: string | null;

  @ManyToOne(() => Interaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_interaction_id' })
  sourceInteraction: Interaction | null;

  /** ID of the entity (person/org) this event is about */
  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  @Index()
  entityId: string | null;

  /**
   * ID of the entity the promise was made TO (for promise_by_me events)
   * Determined from:
   * - Private chats: the other participant
   * - Group chats with reply: sender of the replied message
   * - Group chats without reply: null (unknown)
   */
  @Column({ name: 'promise_to_entity_id', type: 'uuid', nullable: true })
  @Index()
  promiseToEntityId: string | null;

  // ==================== Event Data ====================

  /** Type of extracted event */
  @Column({ name: 'event_type', type: 'varchar', length: 30 })
  @Index()
  eventType: ExtractedEventType;

  /** Extracted data specific to event type */
  @Column({ name: 'extracted_data', type: 'jsonb' })
  extractedData: ExtractedEventData;

  /** Original quote from message that triggered extraction */
  @Column({ name: 'source_quote', type: 'text', nullable: true })
  sourceQuote: string | null;

  // ==================== Confidence & Status ====================

  /** AI confidence score 0.00 - 1.00 */
  @Column({ type: 'numeric', precision: 3, scale: 2 })
  confidence: number;

  /** Processing status */
  @Column({ type: 'varchar', length: 20, default: ExtractedEventStatus.PENDING })
  @Index()
  status: ExtractedEventStatus;

  // ==================== Result Tracking ====================

  /** Type of entity created when confirmed */
  @Column({ name: 'result_entity_type', type: 'varchar', length: 30, nullable: true })
  resultEntityType: 'EntityEvent' | 'EntityFact' | null;

  /** ID of created entity */
  @Column({ name: 'result_entity_id', type: 'uuid', nullable: true })
  resultEntityId: string | null;

  // ==================== Notification Tracking ====================

  /** When notification was sent to user */
  @Column({ name: 'notification_sent_at', type: 'timestamp with time zone', nullable: true })
  notificationSentAt: Date | null;

  /** When user responded to notification */
  @Column({ name: 'user_response_at', type: 'timestamp with time zone', nullable: true })
  userResponseAt: Date | null;

  // ==================== Context Enrichment ====================

  /**
   * ID of a linked event (e.g., "prepare report" -> "start working on report")
   * Used for context-aware extraction to connect follow-up actions with original tasks
   */
  @Column({ name: 'linked_event_id', type: 'uuid', nullable: true })
  @Index()
  linkedEventId: string | null;

  @ManyToOne(() => ExtractedEvent, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'linked_event_id' })
  linkedEvent: ExtractedEvent | null;

  /**
   * Flag indicating this event is abstract and needs user clarification
   * Set to true when context enrichment couldn't find related events
   * Example: "приступить к задаче" without clear context
   */
  @Column({ name: 'needs_context', type: 'boolean', default: false })
  needsContext: boolean;

  /**
   * Data from context enrichment process
   * Contains: keywords extracted, search results, synthesis, etc.
   */
  @Column({ name: 'enrichment_data', type: 'jsonb', nullable: true })
  enrichmentData: EnrichmentData | null;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
