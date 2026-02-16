import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, handleToolError, type ToolDefinition } from './tool.types';
import type { ToolsProviderInterface } from './tools-provider.interface';
import { ToolsRegistryService } from '../tools-registry.service';
import { ContextService } from '../../context/context.service';

/**
 * Provider for context-related tools.
 * Registered in ContextModule, self-registers with ToolsRegistryService.
 */
@Injectable()
export class ContextToolsProvider implements OnModuleInit, ToolsProviderInterface {
  private readonly logger = new Logger(ContextToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  constructor(
    private readonly contextService: ContextService,
    private readonly toolsRegistry: ToolsRegistryService,
  ) {}

  onModuleInit() {
    this.toolsRegistry.registerProvider('context', this);
  }

  /**
   * Check if context tools are available
   */
  hasTools(): boolean {
    return true;
  }

  /**
   * Get context tools (cached)
   */
  getTools(): ToolDefinition[] {
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
            const context = await this.contextService.generateContext({
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
