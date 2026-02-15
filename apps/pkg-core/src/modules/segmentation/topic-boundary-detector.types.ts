/**
 * Types for TopicBoundaryDetectorService — Claude-based topic segmentation.
 *
 * Takes a stream of messages and identifies topic boundaries,
 * creating TopicalSegments for each coherent discussion unit.
 */

import { MessageData } from '../extraction/extraction.types';

// ─────────────────────────────────────────────────────────────
// Service Input/Output
// ─────────────────────────────────────────────────────────────

export interface DetectBoundariesParams {
  /** Telegram chat ID */
  chatId: string;
  /** Interaction ID (technical session) */
  interactionId: string;
  /** Messages to segment (chronological order) */
  messages: MessageData[];
  /** Entity IDs of participants */
  participantIds: string[];
  /** Primary counterparty entity ID */
  primaryParticipantId?: string;
  /** Chat title for additional context */
  chatTitle?: string;
  /** Activity ID to link segments to (if known) */
  activityId?: string;
}

export interface DetectedSegment {
  /** Topic name (concise, specific) */
  topic: string;
  /** Keywords for search */
  keywords: string[];
  /** Brief summary of the discussion */
  summary: string;
  /** Indices into the input messages array (0-based) */
  messageIndices: number[];
  /** Confidence score 0-1 */
  confidence: number;
  /** Why this boundary was detected */
  reason: 'topic_change' | 'time_gap' | 'explicit_marker';
  /** Is this work-related discussion? */
  isWorkRelated: boolean;
}

export interface DetectBoundariesResult {
  /** Created segment IDs */
  segmentIds: string[];
  /** Number of segments created */
  segmentCount: number;
  /** Number of messages that were assigned to segments */
  messagesAssigned: number;
  /** Number of messages left unassigned (noise, greetings, etc.) */
  messagesSkipped: number;
  /** Total tokens used */
  tokensUsed: number;
  /** Processing time in ms */
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// Claude Response Schema
// ─────────────────────────────────────────────────────────────

/** Raw Claude response matching the JSON Schema */
export interface SegmentationResponse {
  segments: DetectedSegment[];
  /** Messages that don't belong to any topic (noise, greetings) */
  skippedMessageIndices: number[];
}

/**
 * JSON Schema for Claude structured output.
 * Defines the expected response format for topic segmentation.
 */
export const TOPIC_SEGMENTATION_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      description: 'Identified topic segments. Each segment is a group of messages about one coherent topic.',
      items: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Concise topic name (3-10 words). Must be specific, not generic. E.g. "Выбор сервиса транскрипции для invapp-panavto", NOT "Обсуждение технических вопросов".',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keywords for search (3-7 words)',
          },
          summary: {
            type: 'string',
            description: 'Brief summary of what was discussed and decided (1-3 sentences)',
          },
          messageIndices: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Zero-based indices of messages belonging to this topic segment',
          },
          confidence: {
            type: 'number',
            description: 'Confidence that these messages form a coherent topic (0-1)',
          },
          reason: {
            type: 'string',
            enum: ['topic_change', 'time_gap', 'explicit_marker'],
            description: 'Why this segment boundary was detected',
          },
          isWorkRelated: {
            type: 'boolean',
            description: 'Whether this is a work/business discussion (vs personal/casual)',
          },
        },
        required: ['topic', 'keywords', 'summary', 'messageIndices', 'confidence', 'reason', 'isWorkRelated'],
      },
    },
    skippedMessageIndices: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Indices of messages that are noise (greetings, stickers, single emoji) and do not belong to any topic',
    },
  },
  required: ['segments', 'skippedMessageIndices'],
};
