import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
 */
export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Tool result helper - not found response
 */
export function toolNotFound(what: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `No ${what} found. Try different search terms or parameters.` }],
  };
}
