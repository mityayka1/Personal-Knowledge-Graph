import { Injectable, Logger, Optional } from '@nestjs/common';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import {
  SearchToolsProvider,
  EntityToolsProvider,
  EventToolsProvider,
  ContextToolsProvider,
  type ToolDefinition,
} from './tools';
import type { ToolCategory } from './claude-agent.types';

/**
 * Service for managing agent tools
 *
 * Aggregates tools from specialized providers and creates MCP servers.
 * Uses NestJS DI to inject tool providers, avoiding the factory anti-pattern.
 *
 * ContextToolsProvider is @Optional to break circular dependency with ContextModule.
 */
@Injectable()
export class ToolsRegistryService {
  private readonly logger = new Logger(ToolsRegistryService.name);

  /** Cache for all tools to avoid repeated aggregation */
  private cachedAllTools: ToolDefinition[] | null = null;

  /** Cache for tools by category */
  private categoryCache = new Map<string, ToolDefinition[]>();

  constructor(
    private readonly searchToolsProvider: SearchToolsProvider,
    private readonly entityToolsProvider: EntityToolsProvider,
    private readonly eventToolsProvider: EventToolsProvider,
    @Optional()
    private readonly contextToolsProvider: ContextToolsProvider | null,
  ) {
    // Log availability of context tools
    if (!this.contextToolsProvider?.hasTools()) {
      this.logger.warn('ContextToolsProvider not available - context tools disabled');
    }
  }

  /**
   * Get all available tools (cached)
   */
  getAllTools(): ToolDefinition[] {
    if (!this.cachedAllTools) {
      this.cachedAllTools = [
        ...this.searchToolsProvider.getTools(),
        ...this.entityToolsProvider.getTools(),
        ...this.eventToolsProvider.getTools(),
        ...(this.contextToolsProvider?.getTools() ?? []),
      ];
      this.logger.debug(`Aggregated ${this.cachedAllTools.length} tools from all providers`);
    }
    return this.cachedAllTools;
  }

  /**
   * Get tools by category (cached)
   */
  getToolsByCategory(categories: ToolCategory[]): ToolDefinition[] {
    // Create sorted copy to avoid mutating input array
    const cacheKey = [...categories].sort().join(',');

    // Check cache
    const cached = this.categoryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Build tools list
    const tools: ToolDefinition[] = [];

    for (const category of categories) {
      switch (category) {
        case 'all':
          return this.getAllTools();
        case 'search':
          tools.push(...this.searchToolsProvider.getTools());
          break;
        case 'context':
          if (this.contextToolsProvider?.hasTools()) {
            tools.push(...this.contextToolsProvider.getTools());
          }
          break;
        case 'events':
          tools.push(...this.eventToolsProvider.getTools());
          break;
        case 'entities':
          tools.push(...this.entityToolsProvider.getTools());
          break;
      }
    }

    // Cache and return
    this.categoryCache.set(cacheKey, tools);
    return tools;
  }

  /**
   * Create MCP server with specified tool categories
   */
  createMcpServer(categories: ToolCategory[] = ['all']): ReturnType<typeof createSdkMcpServer> {
    const tools = this.getToolsByCategory(categories);

    this.logger.debug(
      `Creating MCP server with ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`
    );

    return createSdkMcpServer({
      name: 'pkg-tools',
      version: '1.0.0',
      tools,
    });
  }

  /**
   * Get tool names for allowedTools filter
   * Returns full MCP tool names: mcp__pkg-tools__<tool_name>
   */
  getToolNames(categories: ToolCategory[] = ['all']): string[] {
    const tools = this.getToolsByCategory(categories);
    return tools.map(t => `mcp__pkg-tools__${t.name}`);
  }

  /**
   * Get available tool names (short form, for logging/display)
   */
  getAvailableToolNames(): string[] {
    return this.getAllTools().map(t => t.name);
  }

  /**
   * Check if context tools are available
   */
  hasContextTools(): boolean {
    return this.contextToolsProvider?.hasTools() ?? false;
  }
}
