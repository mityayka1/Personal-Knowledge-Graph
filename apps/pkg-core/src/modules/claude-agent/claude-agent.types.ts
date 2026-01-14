import { ClaudeAgentRun, ReferenceType } from '@pkg/entities';

/**
 * Task types for Claude Agent runs
 */
export type ClaudeTaskType =
  | 'summarization'
  | 'profile_aggregation'
  | 'context_synthesis'
  | 'fact_extraction'
  | 'recall'
  | 'meeting_prep'
  | 'daily_brief'
  | 'action';

/**
 * Model types
 */
export type ModelType = 'sonnet' | 'haiku' | 'opus';

/**
 * Execution mode
 */
export type ExecutionMode = 'oneshot' | 'agent';

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
}

/**
 * Tool definition for agent mode
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  handler: (input: unknown) => Promise<string>;
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
 * Parameters for agent (multi-turn with tools) calls
 */
export interface AgentParams extends BaseParams {
  mode: 'agent';
  tools?: ToolDefinition[];
  hooks?: AgentHooks;
  maxTurns?: number;
  budgetUsd?: number;
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
