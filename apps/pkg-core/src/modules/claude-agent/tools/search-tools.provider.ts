import { Injectable, Logger } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, toolEmptyResult, handleToolError, type ToolDefinition } from './tool.types';
import { SearchService } from '../../search/search.service';

/**
 * Maximum content preview length for search results
 */
const MAX_CONTENT_PREVIEW_LENGTH = 500;

/**
 * Provider for search-related tools
 * Implements NestJS Injectable pattern with tool caching
 */
@Injectable()
export class SearchToolsProvider {
  private readonly logger = new Logger(SearchToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  constructor(private readonly searchService: SearchService) {}

  /**
   * Get search tools (cached)
   */
  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
      this.logger.debug(`Created ${this.cachedTools.length} search tools`);
    }
    return this.cachedTools;
  }

  /**
   * Create tool definitions
   */
  private createTools() {
    return [
      tool(
        'search_messages',
        `Search through messages and conversations using semantic or full-text search.
Use this to find past discussions, decisions, or any information from conversation history.
Returns relevant messages with timestamps, senders, and relevance scores.`,
        {
          query: z.string().min(2).describe('Search query - can be keywords, phrases, or semantic questions'),
          entityId: z.string().uuid().optional().describe('Filter results to conversations with specific person/organization'),
          period: z.object({
            from: z.string().describe('Start date (ISO 8601 format, e.g., "2025-01-01")'),
            to: z.string().describe('End date (ISO 8601 format, e.g., "2025-12-31")'),
          }).optional().describe('Filter results to specific time period'),
          searchType: z.enum(['fts', 'vector', 'hybrid']).default('hybrid').describe(
            'Search type: "fts" for exact keyword match, "vector" for semantic similarity, "hybrid" for combined (recommended)'
          ),
          limit: z.number().int().min(1).max(50).default(20).describe('Maximum number of results to return'),
        },
        async (args) => {
          try {
            const results = await this.searchService.search({
              query: args.query,
              entityId: args.entityId,
              period: args.period,
              searchType: args.searchType,
              limit: args.limit,
            });

            if (results.results.length === 0) {
              return toolEmptyResult('messages matching your query');
            }

            // Format results for readability
            const formattedResults = results.results.map(r => ({
              id: r.id,  // UUID of the message - required for sources
              type: r.type,
              timestamp: r.timestamp,
              entity: r.entity?.name || 'Unknown',
              content: r.content.slice(0, MAX_CONTENT_PREVIEW_LENGTH) + (r.content.length > MAX_CONTENT_PREVIEW_LENGTH ? '...' : ''),
              relevance: Math.round(r.score * 100) + '%',
              highlight: r.highlight,
            }));

            return toolSuccess({
              total: results.total,
              showing: formattedResults.length,
              results: formattedResults,
            });
          } catch (error) {
            return handleToolError(error, this.logger, 'search_messages');
          }
        }
      ),
    ] as ToolDefinition[];
  }
}
