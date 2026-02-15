/**
 * Event Cleanup — types, JSON schemas, result interfaces.
 *
 * Three cleanup phases:
 * A) Event deduplication (reject duplicates & noise)
 * B) Event-to-activity matching (create Commitments)
 * C) Activity semantic dedup (merge duplicates, archive noise)
 */

// ─────────────────────────────────────────────────────────────
// Options & Result
// ─────────────────────────────────────────────────────────────

export type CleanupPhase = 'dedup' | 'match' | 'activities';

export interface CleanupOptions {
  phases: CleanupPhase[];
  dryRun: boolean;
}

export interface CleanupResult {
  dryRun: boolean;
  phaseA?: PhaseAResult;
  phaseB?: PhaseBResult;
  phaseC?: PhaseCResult;
}

// ─────────────────────────────────────────────────────────────
// Phase A: Event Deduplication
// ─────────────────────────────────────────────────────────────

export interface PhaseADuplicateGroup {
  keepId: string;
  rejectIds: string[];
  reason: string;
}

export interface PhaseAClaudeResponse {
  duplicateGroups: PhaseADuplicateGroup[];
  noiseIds: string[];
}

export interface PhaseAResult {
  totalEvents: number;
  entitiesProcessed: number;
  duplicatesRejected: number;
  noiseRejected: number;
  errors: Array<{ entityId: string; error: string }>;
}

export const PHASE_A_SCHEMA = {
  type: 'object',
  properties: {
    duplicateGroups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keepId: { type: 'string', description: 'ID лучшего события в группе дублей (самое информативное)' },
          rejectIds: { type: 'array', items: { type: 'string' }, description: 'IDs дублей для отклонения' },
          reason: { type: 'string', description: 'Краткое описание почему это дубли' },
        },
        required: ['keepId', 'rejectIds', 'reason'],
      },
    },
    noiseIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs шумовых событий без полезной информации (служебные, бессмысленные)',
    },
  },
  required: ['duplicateGroups', 'noiseIds'],
};

// ─────────────────────────────────────────────────────────────
// Phase B: Event → Activity Matching
// ─────────────────────────────────────────────────────────────

export interface PhaseBMatch {
  eventId: string;
  activityId: string | null;
  commitmentType: string;
  reason: string;
}

export interface PhaseBClaudeResponse {
  matches: PhaseBMatch[];
}

export interface PhaseBResult {
  totalEvents: number;
  matched: number;
  unmatched: number;
  commitmentsCreated: number;
  errors: Array<{ eventId: string; error: string }>;
}

export const PHASE_B_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'UUID события' },
          activityId: { type: 'string', description: 'UUID подходящей активности или null если нет подходящей' },
          commitmentType: {
            type: 'string',
            enum: ['promise', 'request', 'agreement', 'deadline', 'reminder'],
            description: 'Тип обязательства',
          },
          reason: { type: 'string', description: 'Почему это событие связано с этой активностью' },
        },
        required: ['eventId', 'activityId', 'commitmentType', 'reason'],
      },
    },
  },
  required: ['matches'],
};

// ─────────────────────────────────────────────────────────────
// Phase C: Activity Semantic Deduplication
// ─────────────────────────────────────────────────────────────

export interface PhaseCMergeGroup {
  primaryId: string;
  duplicateIds: string[];
  reason: string;
}

export interface PhaseCClaudeResponse {
  mergeGroups: PhaseCMergeGroup[];
  archiveIds: string[];
}

export interface PhaseCResult {
  totalActivities: number;
  mergedGroups: number;
  totalMerged: number;
  archived: number;
  errors: Array<{ activityId: string; error: string }>;
}

export const PHASE_C_SCHEMA = {
  type: 'object',
  properties: {
    mergeGroups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          primaryId: { type: 'string', description: 'ID основной активности (оставить — самая полная/качественная)' },
          duplicateIds: { type: 'array', items: { type: 'string' }, description: 'IDs дублей для merge в primary' },
          reason: { type: 'string', description: 'Почему это дубли' },
        },
        required: ['primaryId', 'duplicateIds', 'reason'],
      },
    },
    archiveIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs шумовых/бессмысленных активностей для архивации (служебные, нерелевантные)',
    },
  },
  required: ['mergeGroups', 'archiveIds'],
};
