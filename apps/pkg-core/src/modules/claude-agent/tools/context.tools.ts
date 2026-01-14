import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, toolError } from './tool.types';
import type { ContextService } from '../../context/context.service';

/**
 * Create context-related tools
 */
export function createContextTools(contextService: ContextService) {
  return [
    tool(
      'get_entity_context',
      `Get comprehensive context about a person or organization for meeting preparation.
Returns synthesized information including: current status, recent interactions,
key facts, and recommended discussion points.
Uses tiered data retrieval: recent messages (< 7 days), summaries (7-90 days), and entity profile.`,
      {
        entityId: z.string().uuid().describe('ID of the person or organization to get context for'),
        taskHint: z.string().optional().describe(
          'Optional: specific topic or task to focus on (e.g., "project status", "contract discussion")'
        ),
      },
      async (args) => {
        try {
          const context = await contextService.generateContext({
            entityId: args.entityId,
            taskHint: args.taskHint,
          });

          return toolSuccess({
            entityId: context.entityId,
            entityName: context.entityName,
            context: context.contextMarkdown,
            synthesized: context.synthesizedContext || null,
            sources: context.sources,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Handle not found specially
          if (message.includes('not found')) {
            return toolError(`Entity not found. Please verify the entity ID or search for the person/organization first.`);
          }
          return toolError(message);
        }
      }
    ),
  ];
}
