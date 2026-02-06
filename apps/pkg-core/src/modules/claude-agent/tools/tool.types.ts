import { Logger } from '@nestjs/common';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Tool definition type from Claude Agent SDK
 * Uses `any` for Schema to allow mixing tools with different schemas
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolDefinition = SdkMcpToolDefinition<any>;

/**
 * Tool result helper - success response
 */
export function toolSuccess(data: unknown): CallToolResult {
  return {
    content: [{
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  };
}

/**
 * Tool result helper - error response
 * @param message - Error message
 * @param hint - Optional recovery hint for Claude
 */
export function toolError(message: string, hint?: string): CallToolResult {
  const text = hint
    ? `Error: ${message}. Suggestion: ${hint}`
    : `Error: ${message}`;
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

/**
 * Tool result helper - empty result (not an error, just no data found)
 * Use for search queries that return no results
 */
export function toolEmptyResult(what: string, hint?: string): CallToolResult {
  const defaultHint = 'Try different search terms, broader date range, or fewer filters.';
  return {
    content: [{
      type: 'text',
      text: `No ${what} found. ${hint || defaultHint}`,
    }],
  };
}

/**
 * Tool result helper - not found error (entity/resource doesn't exist)
 * Use when a specific resource by ID is not found
 */
export function toolNotFoundError(what: string): CallToolResult {
  return {
    content: [{
      type: 'text',
      text: `${what} not found. Suggestions: 1) Verify the ID is correct, 2) Use list_entities to search by name first, 3) Check if the resource was deleted.`,
    }],
    isError: true,
  };
}

/**
 * Centralized error handler for tools
 * Classifies errors and logs them appropriately
 *
 * Best practice: "Every error response is an opportunity to teach the AI how to do better."
 */
export function handleToolError(error: unknown, logger?: Logger, toolName?: string): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);

  // Log with context
  if (logger) {
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error(`Tool error${toolName ? ` [${toolName}]` : ''}: ${message}`, stack);
  }

  // Classify known NestJS exceptions with actionable hints
  if (error instanceof NotFoundException) {
    return toolNotFoundError(toolName || 'Resource');
  }
  if (error instanceof BadRequestException) {
    return toolError(
      `Invalid input: ${message}`,
      'Check parameter types and formats. Use ISO 8601 for dates, UUIDs for IDs.'
    );
  }

  // Unknown errors - suggest retry
  return toolError(
    message,
    'This may be a temporary issue. Try again or use a different approach.'
  );
}

/**
 * Parse and validate ISO 8601 date string
 * @throws BadRequestException if date is invalid
 */
export function parseDate(dateStr: string): Date {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new BadRequestException(`Invalid date format: ${dateStr}. Use ISO 8601 format (e.g., "2025-01-20T14:00:00Z").`);
  }
  return date;
}

