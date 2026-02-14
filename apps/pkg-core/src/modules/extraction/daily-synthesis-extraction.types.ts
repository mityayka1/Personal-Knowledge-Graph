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
 * Indicators that help determine whether an extraction is a real project
 * vs a one-off task or purchase.
 */
export interface ProjectIndicators {
  /** Project spans multiple days/weeks/months */
  hasDuration: boolean;
  /** There are sub-tasks, phases, or milestones */
  hasStructure: boolean;
  /** There is a concrete deliverable (document, product, event) */
  hasDeliverable: boolean;
  /** Multiple people are involved */
  hasTeam: boolean;
  /** Explicitly mentioned as "project", "work", or "initiative" */
  hasExplicitContext: boolean;
}

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
  /** Brief description of the project scope */
  description?: string;
  /** Priority level */
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  /** Project deadline if mentioned (ISO 8601) */
  deadline?: string;
  /** Tags/labels for categorization */
  tags?: string[];
  /** Indicators that classify this as a real project */
  projectIndicators?: ProjectIndicators;
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
  /** Who requested this task ('self' or entity name/ID) */
  requestedBy?: 'self' | string;
  /** Who should do this task ('self' or entity name) */
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
  type: 'promise' | 'request' | 'agreement' | 'deadline' | 'reminder' | 'meeting';
  /** Priority if inferable */
  priority?: 'high' | 'medium' | 'low';
  /** Related project name if commitment is tied to a project */
  projectName?: string;
  /** Context snippet */
  sourceQuote?: string;
  /** Confidence of extraction (0-1) */
  confidence: number;
}

/**
 * Extracted fact from conversation/synthesis.
 * Used by SecondBrainExtractionService for FACT type events.
 */
export interface ExtractedFact {
  /** Entity ID this fact belongs to */
  entityId: string;
  /** Entity name for display/logging purposes */
  entityName?: string;
  /** Fact type (birthday, position, company, etc. or custom) */
  factType: string;
  /** Fact value as text */
  value: string;
  /** Original quote from source */
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
      description: 'Detected projects mentioned in synthesis. Must satisfy at least 3 of 5 project indicators.',
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
          description: { type: 'string', description: 'Описание проекта: что делается, для чего, какой результат ожидается (2-3 предложения). ОБЯЗАТЕЛЬНО.' },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'Priority level if inferable',
          },
          deadline: { type: 'string', description: 'Project deadline in ISO 8601 format if mentioned' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags or labels for categorization (e.g., "backend", "design", "marketing")',
          },
          projectIndicators: {
            type: 'object',
            description: 'Indicators that classify this as a real project (at least 3 of 5 should be true)',
            properties: {
              hasDuration: { type: 'boolean', description: 'Project spans multiple days/weeks/months' },
              hasStructure: { type: 'boolean', description: 'There are sub-tasks, phases, or milestones' },
              hasDeliverable: { type: 'boolean', description: 'There is a concrete deliverable (document, product, event)' },
              hasTeam: { type: 'boolean', description: 'Multiple people are involved' },
              hasExplicitContext: { type: 'boolean', description: 'Explicitly mentioned as "project", "work", or "initiative"' },
            },
            required: ['hasDuration', 'hasStructure', 'hasDeliverable', 'hasTeam', 'hasExplicitContext'],
          },
          sourceQuote: { type: 'string', description: 'Relevant quote from synthesis' },
          confidence: { type: 'number', description: 'Confidence 0-1' },
        },
        required: ['name', 'isNew', 'participants', 'confidence', 'projectIndicators', 'description'],
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
          requestedBy: { type: 'string', description: 'Who requested this task ("self" or entity name/UUID)' },
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
            enum: ['promise', 'request', 'agreement', 'deadline', 'reminder', 'meeting'],
            description: 'Commitment type',
          },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          projectName: { type: 'string', description: 'Related project name if commitment is tied to a project' },
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
