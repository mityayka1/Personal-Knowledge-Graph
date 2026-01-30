/**
 * Types for DailySynthesisExtractionService — extracts structured data
 * (projects, tasks, commitments) from daily synthesis text.
 *
 * This is Phase 2 of Jarvis Foundation:
 * /daily command → DailySynthesisExtractionService → structured Activity/Commitment
 */

import { CommitmentType, CommitmentPriority } from '@pkg/entities';

// ─────────────────────────────────────────────────────────────
// Extracted Data Structures
// ─────────────────────────────────────────────────────────────

/**
 * Extracted project from daily synthesis.
 */
export interface ExtractedProject {
  /** Project name as mentioned in synthesis */
  name: string;
  /** Is this a new project or reference to existing? */
  isNew: boolean;
  /** If existing, the matched activity ID */
  existingActivityId?: string;
  /** Mentioned participants (names) */
  participants: string[];
  /** Client name if mentioned */
  client?: string;
  /** Status if mentioned (active, blocked, completed) */
  status?: string;
  /** Context snippet for this extraction */
  sourceQuote?: string;
  /** Confidence of extraction (0-1) */
  confidence: number;
}

/**
 * Extracted task from daily synthesis.
 */
export interface ExtractedTask {
  /** Task title */
  title: string;
  /** Parent project name if mentioned */
  projectName?: string;
  /** Deadline if mentioned (ISO 8601) */
  deadline?: string;
  /** Who should do this task */
  assignee?: 'self' | string;
  /** Task status */
  status: 'pending' | 'in_progress' | 'done';
  /** Priority if inferable */
  priority?: 'high' | 'medium' | 'low';
  /** Context snippet */
  sourceQuote?: string;
  /** Confidence of extraction (0-1) */
  confidence: number;
}

/**
 * Extracted commitment from daily synthesis.
 */
export interface ExtractedCommitment {
  /** What was promised/agreed */
  what: string;
  /** Who made the promise (name or 'self') */
  from: string;
  /** Who receives the promise (name or 'self') */
  to: string;
  /** Due date if mentioned (ISO 8601) */
  deadline?: string;
  /** Type of commitment */
  type: 'promise' | 'request' | 'agreement' | 'deadline' | 'reminder';
  /** Priority if inferable */
  priority?: 'high' | 'medium' | 'low';
  /** Context snippet */
  sourceQuote?: string;
  /** Confidence of extraction (0-1) */
  confidence: number;
}

/**
 * Inferred relation from daily synthesis.
 * These suggest new links between entities/activities.
 */
export interface InferredRelation {
  /** Relation type */
  type: 'project_member' | 'works_on' | 'client_of' | 'responsible_for';
  /** Entity names involved in this relation */
  entities: string[];
  /** Activity name if relation is about activity membership */
  activityName?: string;
  /** Confidence of inference (0-1) */
  confidence: number;
}

// ─────────────────────────────────────────────────────────────
// Service Input/Output
// ─────────────────────────────────────────────────────────────

/**
 * Parameters for daily synthesis extraction.
 */
export interface DailySynthesisExtractionParams {
  /** Daily synthesis text to analyze */
  synthesisText: string;
  /** Optional: date of the daily (for context) */
  date?: string;
  /** Optional: focus topic if daily was focused */
  focusTopic?: string;
  /** Optional: owner entity ID for matching existing activities */
  ownerEntityId?: string;
}

/**
 * Raw output from Claude extraction.
 * This is the JSON Schema-validated response.
 */
export interface DailySynthesisExtractionResponse {
  /** Detected/mentioned projects */
  projects: ExtractedProject[];
  /** Extracted tasks */
  tasks: ExtractedTask[];
  /** Extracted commitments */
  commitments: ExtractedCommitment[];
  /** Inferred entity-activity relations */
  inferredRelations: InferredRelation[];
  /** Brief summary of what was extracted */
  extractionSummary: string;
}

/**
 * Full result returned by DailySynthesisExtractionService.
 */
export interface DailySynthesisExtractionResult extends DailySynthesisExtractionResponse {
  /** Token usage */
  tokensUsed: number;
  /** Extraction took this many ms */
  durationMs: number;
  /** Date of extraction */
  extractedAt: Date;
}

// ─────────────────────────────────────────────────────────────
// JSON Schema for Claude Output
// ─────────────────────────────────────────────────────────────

/**
 * JSON Schema for structured output.
 * Used with ClaudeAgentService.call({ mode: 'oneshot', schema: ... })
 */
export const DAILY_SYNTHESIS_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    projects: {
      type: 'array',
      description: 'Detected projects mentioned in synthesis',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name' },
          isNew: { type: 'boolean', description: 'Is this a newly mentioned project?' },
          existingActivityId: { type: 'string', description: 'Matched existing activity UUID if found' },
          participants: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of participants',
          },
          client: { type: 'string', description: 'Client name if mentioned' },
          status: { type: 'string', description: 'Status: active, blocked, completed' },
          sourceQuote: { type: 'string', description: 'Relevant quote from synthesis' },
          confidence: { type: 'number', description: 'Confidence 0-1' },
        },
        required: ['name', 'isNew', 'participants', 'confidence'],
      },
    },
    tasks: {
      type: 'array',
      description: 'Extracted actionable tasks',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          projectName: { type: 'string', description: 'Parent project name' },
          deadline: { type: 'string', description: 'ISO 8601 deadline if known' },
          assignee: { type: 'string', description: '"self" or person name' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Task status' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority' },
          sourceQuote: { type: 'string', description: 'Relevant quote' },
          confidence: { type: 'number', description: 'Confidence 0-1' },
        },
        required: ['title', 'status', 'confidence'],
      },
    },
    commitments: {
      type: 'array',
      description: 'Extracted promises and agreements',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string', description: 'What was promised/agreed' },
          from: { type: 'string', description: 'Who made promise ("self" or name)' },
          to: { type: 'string', description: 'Promise recipient ("self" or name)' },
          deadline: { type: 'string', description: 'Due date ISO 8601' },
          type: {
            type: 'string',
            enum: ['promise', 'request', 'agreement', 'deadline', 'reminder'],
            description: 'Commitment type',
          },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          sourceQuote: { type: 'string', description: 'Relevant quote' },
          confidence: { type: 'number', description: 'Confidence 0-1' },
        },
        required: ['what', 'from', 'to', 'type', 'confidence'],
      },
    },
    inferredRelations: {
      type: 'array',
      description: 'Inferred entity-activity relations',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['project_member', 'works_on', 'client_of', 'responsible_for'],
            description: 'Relation type',
          },
          entities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Entity names involved',
          },
          activityName: { type: 'string', description: 'Activity name if applicable' },
          confidence: { type: 'number', description: 'Confidence 0-1' },
        },
        required: ['type', 'entities', 'confidence'],
      },
    },
    extractionSummary: {
      type: 'string',
      description: 'Brief summary of what was extracted',
    },
  },
  required: ['projects', 'tasks', 'commitments', 'inferredRelations', 'extractionSummary'],
};
