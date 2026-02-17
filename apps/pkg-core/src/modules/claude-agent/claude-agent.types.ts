import { ClaudeAgentRun, ReferenceType } from '@pkg/entities';

/**
 * Task types for Claude Agent runs
 */
export type ClaudeTaskType =
  | 'summarization'
  | 'profile_aggregation'
  | 'context_synthesis'
  | 'fact_extraction'
  | 'event_extraction'
  | 'context_enrichment'
  | 'fact_fusion'
  | 'recall'
  | 'meeting_prep'
  | 'daily_brief'
  | 'action'
  | 'draft_generation'
  | 'message_regeneration'
  | 'unified_extraction'
  | 'group_extraction'
  | 'fact_dedup_review'
  | 'description_enrichment'
  | 'event_cleanup_dedup'
  | 'event_activity_match'
  | 'activity_semantic_dedup'
  | 'topic_segmentation'
  | 'knowledge_packing'
  | 'project_name_match';

/**
 * Model types
 */
export type ModelType = 'sonnet' | 'haiku' | 'opus';

/**
 * Execution mode
 */
export type ExecutionMode = 'oneshot' | 'agent';

/**
 * Tool categories for selective tool loading
 */
export type ToolCategory = 'search' | 'context' | 'events' | 'entities' | 'actions' | 'activities' | 'data-quality' | 'knowledge' | 'all';

/**
 * Base parameters for all Claude calls
 */
interface BaseParams {
  taskType: ClaudeTaskType;
  prompt: string;
  model?: ModelType;
  referenceType?: ReferenceType;
  referenceId?: string;
  timeout?: number;
}

/**
 * Parameters for oneshot (structured output) calls
 */
export interface OneshotParams<T = unknown> extends BaseParams {
  mode: 'oneshot';
  schema: object;
  /** Max turns for completion (default: 1, increase for complex extractions) */
  maxTurns?: number;
}

/**
 * Hooks for agent mode
 */
export interface AgentHooks {
  onToolUse?: (toolName: string, input: unknown) => Promise<{ approve: boolean; reason?: string }>;
  onToolResult?: (toolName: string, result: string) => Promise<void>;
  onTurn?: (turnNumber: number) => Promise<void>;
}

/**
 * Structured output format configuration
 */
export interface OutputFormat {
  type: 'json_schema';
  schema: object;
  strict?: boolean;
}

/**
 * Custom MCP server configuration for agent mode.
 * Used when specialized tools are needed instead of general toolRegistry.
 */
export interface CustomMcpConfig {
  /** MCP server name */
  name: string;
  /** MCP server instance (from createSdkMcpServer) */
  server: unknown;
  /** Tool names for auto-approval */
  toolNames: string[];
}

/**
 * Parameters for agent (multi-turn with tools) calls
 */
export interface AgentParams extends BaseParams {
  mode: 'agent';
  /** Tool categories to enable (default: 'all'). Determines which PKG tools are available. */
  toolCategories?: ToolCategory[];
  /** Custom MCP server config. When provided, uses this instead of toolRegistry. */
  customMcp?: CustomMcpConfig;
  hooks?: AgentHooks;
  maxTurns?: number;
  budgetUsd?: number;
  /** JSON Schema for structured output. When provided, agent returns structured JSON */
  outputFormat?: OutputFormat;
}

/**
 * Union type for all call parameters
 */
export type CallParams<T = unknown> = OneshotParams<T> | AgentParams;

/**
 * Usage statistics from a call
 */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
}

/**
 * Result from a Claude call
 */
export interface CallResult<T> {
  data: T;
  usage: UsageStats;
  turns?: number;
  toolsUsed?: string[];
  run: ClaudeAgentRun;
}

/**
 * Statistics for a period
 */
export interface PeriodStats {
  period: string;
  startDate: Date;
  byTaskType: Array<{
    taskType: string;
    totalRuns: number;
    successfulRuns: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCostUsd: number;
    avgDurationMs: number;
  }>;
  totals: {
    totalRuns: number;
    totalCostUsd: number;
  };
}

/**
 * Daily statistics entry
 */
export interface DailyStatsEntry {
  date: string;
  runs: number;
  costUsd: number;
}

// ============================================
// Second Brain API DTOs
// ============================================

/**
 * Source reference in recall response
 */
export interface RecallSource {
  type: 'message' | 'interaction';
  id: string;
  preview: string;
}

/**
 * Request for recall endpoint
 */
export interface RecallRequestDto {
  /** Natural language query, e.g., "что обсуждали с Иваном на прошлой неделе?" */
  query: string;
  /** Owner user ID (optional, for multi-user scenarios) */
  userId?: string;
}

/**
 * Response data for recall endpoint
 */
export interface RecallResponseData {
  /** Agent's answer in natural language */
  answer: string;
  /** Sources used to generate the answer */
  sources: RecallSource[];
  /** Tools that were used during the agent loop */
  toolsUsed: string[];
}

/**
 * Full response for recall endpoint
 */
export interface RecallResponse {
  success: boolean;
  data: RecallResponseData;
}

/**
 * Response data for prepare endpoint
 */
export interface PrepareResponseData {
  /** Entity UUID */
  entityId: string;
  /** Entity display name */
  entityName: string;
  /** Structured brief about the entity */
  brief: string;
  /** Number of recent interactions */
  recentInteractions: number;
  /** List of open questions or pending items */
  openQuestions: string[];
}

/**
 * Full response for prepare endpoint
 */
export interface PrepareResponse {
  success: boolean;
  data: PrepareResponseData;
}
