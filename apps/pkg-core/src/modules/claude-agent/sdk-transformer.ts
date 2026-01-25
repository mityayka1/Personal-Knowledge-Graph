/**
 * SDK Response Transformer
 *
 * Claude Agent SDK returns fields in snake_case, but our codebase uses camelCase.
 * This module provides centralized transformation to avoid ad-hoc patches.
 *
 * @see docs/solutions/integration-issues/claude-sdk-snake-case-systemic-20250125.md
 */

import { UsageStats } from './claude-agent.types';

// ============================================
// SDK Response Types (what SDK actually returns)
// ============================================

/**
 * Usage stats as returned by SDK (snake_case)
 */
export interface SDKUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Assistant message usage from SDK
 */
export interface SDKAssistantUsage extends SDKUsage {
  // Some SDK versions might include cost here
  cost_usd?: number;
}

/**
 * Result message fields from SDK (snake_case)
 */
export interface SDKResultFields {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_tool';
  result?: string;
  structured_output?: unknown;
  usage?: SDKUsage;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  session_id?: string;
  is_error?: boolean;
}

// ============================================
// Normalized Types (camelCase for our code)
// ============================================

/**
 * Normalized result after transformation
 */
export interface NormalizedResultFields<T = unknown> {
  result?: string;
  structuredOutput?: T;
  usage: UsageStats;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  sessionId?: string;
  isError: boolean;
}

// ============================================
// Transformer Functions
// ============================================

/**
 * Normalize SDK usage stats to our camelCase format
 */
export function normalizeUsage(sdkUsage?: SDKUsage | null): UsageStats {
  if (!sdkUsage) {
    return { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
  }

  return {
    inputTokens: sdkUsage.input_tokens ?? 0,
    outputTokens: sdkUsage.output_tokens ?? 0,
    totalCostUsd: 0, // Cost comes from result message, not usage
  };
}

/**
 * Normalize SDK result message to our camelCase format
 *
 * @example
 * ```typescript
 * const normalized = normalizeSDKResult<MyResponseType>(resultMessage);
 * console.log(normalized.structuredOutput); // T | undefined
 * console.log(normalized.usage.inputTokens); // number
 * ```
 */
export function normalizeSDKResult<T = unknown>(
  sdkResult: SDKResultFields,
): NormalizedResultFields<T> {
  return {
    result: sdkResult.result,
    structuredOutput: sdkResult.structured_output as T | undefined,
    usage: {
      inputTokens: sdkResult.usage?.input_tokens ?? 0,
      outputTokens: sdkResult.usage?.output_tokens ?? 0,
      totalCostUsd: sdkResult.total_cost_usd ?? 0,
    },
    durationMs: sdkResult.duration_ms,
    durationApiMs: sdkResult.duration_api_ms,
    numTurns: sdkResult.num_turns,
    sessionId: sdkResult.session_id,
    isError: sdkResult.is_error ?? sdkResult.subtype !== 'success',
  };
}

/**
 * Accumulate usage from SDK assistant message into existing stats
 *
 * @param sdkUsage - Usage from SDK assistant message (snake_case)
 * @param target - Target stats object to accumulate into (camelCase)
 */
export function accumulateSDKUsage(
  sdkUsage: SDKAssistantUsage | null | undefined,
  target: UsageStats,
): void {
  if (!sdkUsage) return;

  target.inputTokens += sdkUsage.input_tokens ?? 0;
  target.outputTokens += sdkUsage.output_tokens ?? 0;
  if (sdkUsage.cost_usd) {
    target.totalCostUsd += sdkUsage.cost_usd;
  }
}

/**
 * Accumulate usage from SDK result message into existing stats
 *
 * @param sdkResult - Result message from SDK (snake_case)
 * @param target - Target stats object to accumulate into (camelCase)
 */
export function accumulateSDKResultUsage(
  sdkResult: SDKResultFields,
  target: UsageStats,
): void {
  if (sdkResult.usage) {
    target.inputTokens += sdkResult.usage.input_tokens ?? 0;
    target.outputTokens += sdkResult.usage.output_tokens ?? 0;
  }
  if (sdkResult.total_cost_usd) {
    target.totalCostUsd += sdkResult.total_cost_usd;
  }
}
