import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import {
  SearchToolsProvider,
  EntityToolsProvider,
  EventToolsProvider,
  ContextToolsProvider,
  ActionToolsProvider,
  ActivityToolsProvider,
  DataQualityToolsProvider,
  KnowledgeToolsProvider,
  type ToolDefinition,
} from './tools';
import type { ToolCategory } from './claude-agent.types';

/**
 * Service for managing agent tools
 *
 * Aggregates tools from specialized providers and creates MCP servers.
 * Uses NestJS DI to inject tool providers, avoiding the factory anti-pattern.
 *
 * ContextToolsProvider is @Optional to handle bidirectional module imports:
 * ContextModule ↔ ClaudeAgentModule. If ContextService is not yet available
 * during DI resolution, context tools will be disabled.
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
    @Inject(forwardRef(() => ContextToolsProvider))
    private readonly contextToolsProvider: ContextToolsProvider | null,
    @Optional()
    @Inject(forwardRef(() => ActionToolsProvider))
    private readonly actionToolsProvider: ActionToolsProvider | null,
    @Optional()
    @Inject(forwardRef(() => ActivityToolsProvider))
    private readonly activityToolsProvider: ActivityToolsProvider | null,
    @Optional()
    @Inject(forwardRef(() => DataQualityToolsProvider))
    private readonly dataQualityToolsProvider: DataQualityToolsProvider | null,
    @Optional()
    @Inject(forwardRef(() => KnowledgeToolsProvider))
    private readonly knowledgeToolsProvider: KnowledgeToolsProvider | null,
  ) {
    // Log availability of context tools
    if (!this.contextToolsProvider?.hasTools()) {
      this.logger.warn('ContextToolsProvider not available - context tools disabled');
    }
    // Log availability of action tools
    this.logger.log(`ActionToolsProvider available: ${!!this.actionToolsProvider}`);
    if (this.actionToolsProvider) {
      const actionTools = this.actionToolsProvider.getTools();
      this.logger.log(`Action tools count: ${actionTools.length}, names: ${actionTools.map(t => t.name).join(', ')}`);
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
        ...(this.actionToolsProvider?.getTools() ?? []),
        ...(this.activityToolsProvider?.getTools() ?? []),
        ...(this.dataQualityToolsProvider?.getTools() ?? []),
        ...(this.knowledgeToolsProvider?.getTools() ?? []),
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
        case 'all': {
          // 'all' is already cached in cachedAllTools, but also cache it in categoryCache
          const allTools = this.getAllTools();
          this.categoryCache.set(cacheKey, allTools);
          return allTools;
        }
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
        case 'actions':
          if (this.actionToolsProvider) {
            tools.push(...this.actionToolsProvider.getTools());
          }
          break;
        case 'activities':
          if (this.activityToolsProvider) {
            tools.push(...this.activityToolsProvider.getTools());
          }
          break;
        case 'data-quality':
          if (this.dataQualityToolsProvider) {
            tools.push(...this.dataQualityToolsProvider.getTools());
          }
          break;
        case 'knowledge':
          if (this.knowledgeToolsProvider) {
            tools.push(...this.knowledgeToolsProvider.getTools());
          }
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

    this.logger.log(
      `Creating MCP server with ${tools.length} tools for categories [${categories.join(',')}]: ${tools.map(t => t.name).join(', ')}`
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
