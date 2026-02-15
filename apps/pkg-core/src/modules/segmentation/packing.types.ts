/**
 * Types for PackingService — consolidates TopicalSegments into KnowledgePacks.
 *
 * Phase E: Knowledge Segmentation & Packing
 */

import { KnowledgePack, PackType } from '@pkg/entities';

// ─────────────────────────────────────────────────────────────
// Service Input
// ─────────────────────────────────────────────────────────────

/**
 * Parameters for packing segments by activity.
 */
export interface PackByActivityParams {
  /** Activity UUID to pack segments for */
  activityId: string;
  /** Optional title override (auto-generated if not provided) */
  title?: string;
}

/**
 * Parameters for packing segments by entity.
 */
export interface PackByEntityParams {
  /** Entity UUID (primaryParticipantId) */
  entityId: string;
  /** Optional title override */
  title?: string;
}

/**
 * Parameters for packing segments by period in a chat.
 */
export interface PackByPeriodParams {
  /** Telegram chat ID */
  chatId: string;
  /** Start of period (inclusive) */
  startDate: Date;
  /** End of period (inclusive) */
  endDate: Date;
  /** Optional title override */
  title?: string;
}

// ─────────────────────────────────────────────────────────────
// Claude Synthesis Output
// ─────────────────────────────────────────────────────────────

/**
 * Conflict detected between segments.
 */
export interface SynthesizedConflict {
  /** First conflicting statement */
  fact1: string;
  /** Second conflicting statement */
  fact2: string;
  /** Suggested resolution or explanation */
  resolution: string;
}

/**
 * Synthesized decision from segments.
 */
export interface SynthesizedDecision {
  /** What was decided */
  what: string;
  /** When it was decided (approximate date or context) */
  when: string;
  /** Context or reasoning behind the decision */
  context: string;
}

/**
 * Synthesized open question from segments.
 */
export interface SynthesizedOpenQuestion {
  /** The question itself */
  question: string;
  /** When it was raised (approximate date or context) */
  raisedAt: string;
  /** Additional context */
  context: string;
}

/**
 * Synthesized key fact from segments.
 */
export interface SynthesizedKeyFact {
  /** Type of fact (e.g., "agreement", "requirement", "status") */
  factType: string;
  /** Fact value */
  value: string;
  /** Confidence level 0-1 */
  confidence: number;
}

/**
 * Raw output from Claude synthesis.
 * Matches the PACKING_SYNTHESIS_SCHEMA below.
 */
export interface PackingSynthesisResponse {
  /** Consolidated summary of all segments */
  summary: string;
  /** Key decisions made across segments */
  decisions: SynthesizedDecision[];
  /** Unresolved questions */
  openQuestions: SynthesizedOpenQuestion[];
  /** Important facts extracted and consolidated */
  keyFacts: SynthesizedKeyFact[];
  /** Contradictions detected between segments */
  conflicts: SynthesizedConflict[];
  /** Suggested title for the knowledge pack */
  suggestedTitle: string;
}

// ─────────────────────────────────────────────────────────────
// Service Output
// ─────────────────────────────────────────────────────────────

/**
 * Result from a packing operation.
 */
export interface PackingResult {
  /** Created KnowledgePack */
  pack: KnowledgePack;
  /** Number of segments packed */
  segmentCount: number;
  /** Total messages across all segments */
  totalMessageCount: number;
  /** Token usage from Claude */
  tokensUsed: number;
  /** Duration in milliseconds */
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// JSON Schema for Claude Output
// ─────────────────────────────────────────────────────────────

/**
 * JSON Schema for structured output from Claude synthesis.
 * Used with ClaudeAgentService.call({ mode: 'oneshot', schema: ... })
 *
 * IMPORTANT: Uses raw JSON Schema, NOT z.toJSONSchema().
 * See CLAUDE.md for rationale.
 */
export const PACKING_SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'Consolidated summary of all segments in Russian. ' +
        'Should capture the overall picture: what was discussed, what progress was made, ' +
        'what remains to be done. 3-5 paragraphs.',
    },
    decisions: {
      type: 'array',
      description: 'Key decisions made across all segments',
      items: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            description: 'What was decided',
          },
          when: {
            type: 'string',
            description: 'When it was decided (date or context, e.g., "2025-01-15" or "during sprint planning")',
          },
          context: {
            type: 'string',
            description: 'Context or reasoning behind the decision',
          },
        },
        required: ['what', 'when', 'context'],
      },
    },
    openQuestions: {
      type: 'array',
      description: 'Unresolved questions that need attention',
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question itself',
          },
          raisedAt: {
            type: 'string',
            description: 'When the question was raised (date or context)',
          },
          context: {
            type: 'string',
            description: 'Additional context about why this is important',
          },
        },
        required: ['question', 'raisedAt', 'context'],
      },
    },
    keyFacts: {
      type: 'array',
      description: 'Important facts extracted and consolidated from all segments',
      items: {
        type: 'object',
        properties: {
          factType: {
            type: 'string',
            description:
              'Category of fact: "agreement", "requirement", "status", "contact", ' +
              '"deadline", "budget", "technical", "other"',
          },
          value: {
            type: 'string',
            description: 'The fact value as a clear statement',
          },
          confidence: {
            type: 'number',
            description: 'Confidence level 0-1 (how certain is this fact)',
          },
        },
        required: ['factType', 'value', 'confidence'],
      },
    },
    conflicts: {
      type: 'array',
      description:
        'Contradictions or inconsistencies detected between different segments. ' +
        'Only include real conflicts, not mere updates or changes over time.',
      items: {
        type: 'object',
        properties: {
          fact1: {
            type: 'string',
            description: 'First conflicting statement (with segment context)',
          },
          fact2: {
            type: 'string',
            description: 'Second conflicting statement (with segment context)',
          },
          resolution: {
            type: 'string',
            description:
              'Suggested resolution: which is more likely correct, or explanation of the discrepancy',
          },
        },
        required: ['fact1', 'fact2', 'resolution'],
      },
    },
    suggestedTitle: {
      type: 'string',
      description:
        'Suggested title for the knowledge pack (concise, in Russian, max 100 chars). ' +
        'Should reflect the main topic or scope.',
    },
  },
  required: ['summary', 'decisions', 'openQuestions', 'keyFacts', 'conflicts', 'suggestedTitle'],
};
