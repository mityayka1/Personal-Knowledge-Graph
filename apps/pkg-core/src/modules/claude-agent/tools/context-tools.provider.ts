import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, handleToolError, type ToolDefinition } from './tool.types';
import { ContextService } from '../../context/context.service';

/**
 * Provider for context-related tools
 *
 * Uses @Optional + forwardRef injection to handle bidirectional module imports:
 * - ContextModule imports ClaudeAgentModule (for ClaudeAgentService)
 * - ClaudeAgentModule imports ContextModule (for ContextService here)
 *
 * If ContextService is not available during DI resolution (due to module
 * initialization order), context tools will be disabled gracefully.
 */
@Injectable()
export class ContextToolsProvider {
  private readonly logger = new Logger(ContextToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;
  private readonly isAvailable: boolean;

  constructor(
    @Optional()
    @Inject(forwardRef(() => ContextService))
    private readonly contextService: ContextService | null,
  ) {
    this.isAvailable = contextService !== null;
    if (!this.isAvailable) {
      this.logger.warn('ContextService not available - context tools will be disabled');
    }
  }

  /**
   * Check if context tools are available
   */
  hasTools(): boolean {
    return this.isAvailable;
  }

  /**
   * Get context tools (cached)
   * Returns empty array if ContextService is not available
   */
  getTools(): ToolDefinition[] {
    if (!this.isAvailable) {
      return [];
    }

    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
      this.logger.debug(`Created ${this.cachedTools.length} context tools`);
    }
    return this.cachedTools;
  }

  /**
   * Create tool definitions
   */
  private createTools() {
    // Capture in local variable for type safety in closure
    const contextService = this.contextService;
    if (!contextService) {
      return [];
    }

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
            return handleToolError(error, this.logger, 'get_entity_context');
          }
        }
      ),
    ] as ToolDefinition[];
  }
}
