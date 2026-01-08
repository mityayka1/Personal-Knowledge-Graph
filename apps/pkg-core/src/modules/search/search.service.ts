import { Injectable } from '@nestjs/common';
import { FtsService } from './fts.service';
import { VectorService } from './vector.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { SearchQuery, SearchResult, SearchType } from '@pkg/shared';

@Injectable()
export class SearchService {
  constructor(
    private ftsService: FtsService,
    private vectorService: VectorService,
    private embeddingService: EmbeddingService,
  ) {}

  async search(query: SearchQuery): Promise<{ results: SearchResult[]; total: number; search_type: SearchType }> {
    const searchType = query.searchType || 'hybrid';
    const limit = query.limit || 20;

    let results: SearchResult[] = [];

    if (searchType === 'fts') {
      results = await this.ftsService.search(query.query, query.entityId, query.period, limit);
    } else if (searchType === 'vector') {
      const embedding = await this.embeddingService.generate(query.query);
      results = await this.vectorService.search(embedding, query.entityId, query.period, limit);
    } else {
      // Hybrid: combine FTS and vector search with RRF
      results = await this.hybridSearch(query, limit);
    }

    return {
      results,
      total: results.length,
      search_type: searchType,
    };
  }

  private async hybridSearch(query: SearchQuery, limit: number): Promise<SearchResult[]> {
    // Get FTS results
    const ftsResults = await this.ftsService.search(
      query.query,
      query.entityId,
      query.period,
      limit * 2,
    );

    // Get vector results
    const embedding = await this.embeddingService.generate(query.query);
    const vectorResults = await this.vectorService.search(
      embedding,
      query.entityId,
      query.period,
      limit * 2,
    );

    // Reciprocal Rank Fusion (RRF)
    const k = 60; // RRF constant
    const scores = new Map<string, number>();

    ftsResults.forEach((result, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      scores.set(result.id, (scores.get(result.id) || 0) + rrfScore);
    });

    vectorResults.forEach((result, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      scores.set(result.id, (scores.get(result.id) || 0) + rrfScore);
    });

    // Merge results and sort by RRF score
    const resultMap = new Map<string, SearchResult>();
    [...ftsResults, ...vectorResults].forEach(r => {
      if (!resultMap.has(r.id)) {
        resultMap.set(r.id, r);
      }
    });

    return Array.from(resultMap.values())
      .map(r => ({ ...r, score: scores.get(r.id) || 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
