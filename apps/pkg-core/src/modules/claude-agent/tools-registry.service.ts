import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createSearchTools } from './tools/search.tools';
import { createContextTools } from './tools/context.tools';
import { createEventTools } from './tools/event.tools';
import { createEntityTools } from './tools/entity.tools';
import { SearchService } from '../search/search.service';
import { ContextService } from '../context/context.service';
import { EntityEventService } from '../entity-event/entity-event.service';
import { EntityService } from '../entity/entity.service';
import type { ToolCategory } from './claude-agent.types';

/**
 * MCP server configuration with instance
 */
export interface McpServerConfig {
  name: string;
  version: string;
  instance: unknown; // MCP server instance
}

@Injectable()
export class ToolsRegistryService {
  private readonly logger = new Logger(ToolsRegistryService.name);

  constructor(
    private searchService: SearchService,
    @Inject(forwardRef(() => ContextService))
    private contextService: ContextService,
    private entityEventService: EntityEventService,
    private entityService: EntityService,
  ) {}

  /**
   * Get all available tools
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllTools(): any[] {
    return [
      ...createSearchTools(this.searchService),
      ...createContextTools(this.contextService),
      ...createEventTools(this.entityEventService),
      ...createEntityTools(this.entityService),
    ];
  }

  /**
   * Get tools by category
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getToolsByCategory(categories: ToolCategory[]): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [];

    for (const category of categories) {
      switch (category) {
        case 'all':
          return this.getAllTools();
        case 'search':
          tools.push(...createSearchTools(this.searchService));
          break;
        case 'context':
          tools.push(...createContextTools(this.contextService));
          break;
        case 'events':
          tools.push(...createEventTools(this.entityEventService));
          break;
        case 'entities':
          tools.push(...createEntityTools(this.entityService));
          break;
      }
    }

    return tools;
  }

  /**
   * Create MCP server with specified tool categories
   */
  createMcpServer(categories: ToolCategory[] = ['all']): ReturnType<typeof createSdkMcpServer> {
    const tools = this.getToolsByCategory(categories);

    this.logger.debug(`Creating MCP server with ${tools.length} tools: ${tools.map((t: { name: string }) => t.name).join(', ')}`);

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
    return tools.map((t: { name: string }) => `mcp__pkg-tools__${t.name}`);
  }

  /**
   * Get available tool names (short form, for logging/display)
   */
  getAvailableToolNames(): string[] {
    return this.getAllTools().map((t: { name: string }) => t.name);
  }
}
