import { Injectable, Logger } from '@nestjs/common';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { ToolDefinition } from './tools';
import type { ToolCategory } from './claude-agent.types';
import type { ToolsProviderInterface } from './tools/tools-provider.interface';

/**
 * Service for managing agent tools
 *
 * Aggregates tools from specialized providers and creates MCP servers.
 * Uses registration pattern: domain modules register their tool providers
 * via registerProvider() during OnModuleInit lifecycle.
 */
@Injectable()
export class ToolsRegistryService {
  private readonly logger = new Logger(ToolsRegistryService.name);

  /** Registered tool providers by category */
  private readonly providers = new Map<ToolCategory, ToolsProviderInterface>();

  /** Cache for all tools to avoid repeated aggregation */
  private cachedAllTools: ToolDefinition[] | null = null;

  /** Cache for tools by category */
  private categoryCache = new Map<string, ToolDefinition[]>();

  /**
   * Register a tool provider for a given category.
   * Called by domain modules during OnModuleInit.
   */
  registerProvider(category: ToolCategory, provider: ToolsProviderInterface): void {
    this.providers.set(category, provider);
    this.invalidateCache();
    this.logger.log(`Registered tool provider for category: ${category}`);
  }

  /**
   * Invalidate all caches (called when providers change)
   */
  private invalidateCache(): void {
    this.cachedAllTools = null;
    this.categoryCache.clear();
  }

  /**
   * Get all available tools (cached)
   */
  getAllTools(): ToolDefinition[] {
    if (!this.cachedAllTools) {
      this.cachedAllTools = [];
      for (const provider of this.providers.values()) {
        this.cachedAllTools.push(...provider.getTools());
      }
      this.logger.debug(`Aggregated ${this.cachedAllTools.length} tools from ${this.providers.size} providers`);
    }
    return this.cachedAllTools;
  }

  /**
   * Get tools by category (cached)
   */
  getToolsByCategory(categories: ToolCategory[]): ToolDefinition[] {
    const cacheKey = [...categories].sort().join(',');

    const cached = this.categoryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const tools: ToolDefinition[] = [];

    for (const category of categories) {
      if (category === 'all') {
        const allTools = this.getAllTools();
        this.categoryCache.set(cacheKey, allTools);
        return allTools;
      }
      const provider = this.providers.get(category);
      if (provider) {
        tools.push(...provider.getTools());
      }
    }

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
    const provider = this.providers.get('context');
    return provider?.hasTools?.() ?? (provider?.getTools()?.length ?? 0) > 0;
  }
}
