import { Injectable, Logger } from '@nestjs/common';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

export interface RerankItem {
  id: string;
  content: string;
  score: number;
  [key: string]: any;
}

const RERANKING_SCHEMA = {
  type: 'object',
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item ID from input' },
          relevance: { type: 'number', description: 'Relevance score 0.0-1.0' },
        },
        required: ['id', 'relevance'],
      },
    },
  },
  required: ['rankings'],
};

@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);

  constructor(private claudeAgentService: ClaudeAgentService) {}

  async rerank<T extends RerankItem>(
    items: T[],
    query: string,
    options?: { topK?: number },
  ): Promise<T[]> {
    if (items.length < 2) return items;

    const topK = options?.topK ?? items.length;

    try {
      const itemsText = items
        .map((item) => `[${item.id}] ${item.content.slice(0, 300)}`)
        .join('\n');

      const prompt = `Rate each item's relevance to the query. Return rankings sorted by relevance (highest first).

Query: "${query}"

Items:
${itemsText}

Rate relevance 0.0-1.0 for each item. Only include items with relevance > 0.1.`;

      const { data } = await this.claudeAgentService.call<{
        rankings: { id: string; relevance: number }[];
      }>({
        mode: 'oneshot',
        taskType: 'reranking',
        prompt,
        schema: RERANKING_SCHEMA,
        model: 'haiku',
      });

      if (!data?.rankings?.length) {
        return items.slice(0, topK);
      }

      const itemMap = new Map(items.map(item => [item.id, item]));
      const reranked: T[] = [];

      for (const ranking of data.rankings) {
        const item = itemMap.get(ranking.id);
        if (item) {
          reranked.push({ ...item, score: ranking.relevance });
        }
      }

      // Append items not in the ranking result (preserve them)
      for (const item of items) {
        if (!reranked.find(r => r.id === item.id)) {
          reranked.push(item);
        }
      }

      return reranked.slice(0, topK);
    } catch (error) {
      this.logger.warn(`Reranking failed, falling back to original order: ${error}`);
      return items.slice(0, topK);
    }
  }
}
