import { Injectable, Logger } from '@nestjs/common';
import { FtsService } from './fts.service';
import { VectorService } from './vector.service';
import { RerankerService, RerankItem } from './reranker.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { SearchQuery, SearchResult, SearchType } from '@pkg/shared';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private ftsService: FtsService,
    private vectorService: VectorService,
    private rerankerService: RerankerService,
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

    // Weighted Reciprocal Rank Fusion (RRF)
    const k = 60;
    const FTS_WEIGHT = 0.4;
    const VECTOR_WEIGHT = 0.6;
    const DUAL_SIGNAL_BOOST = 1.2;

    const scores = new Map<string, number>();

    // Track which results appear in both signals
    const ftsIds = new Set(ftsResults.map(r => r.id));
    const vectorIds = new Set(vectorResults.map(r => r.id));
    const inBothSignals = new Set<string>();
    ftsIds.forEach(id => { if (vectorIds.has(id)) inBothSignals.add(id); });

    ftsResults.forEach((result, rank) => {
      const rrfScore = FTS_WEIGHT * (1 / (k + rank + 1));
      scores.set(result.id, (scores.get(result.id) || 0) + rrfScore);
    });

    vectorResults.forEach((result, rank) => {
      const rrfScore = VECTOR_WEIGHT * (1 / (k + rank + 1));
      scores.set(result.id, (scores.get(result.id) || 0) + rrfScore);
    });

    // Dual-signal boost
    for (const id of inBothSignals) {
      scores.set(id, (scores.get(id) || 0) * DUAL_SIGNAL_BOOST);
    }

    // Merge results and sort by RRF score
    const resultMap = new Map<string, SearchResult>();
    [...ftsResults, ...vectorResults].forEach(r => {
      if (!resultMap.has(r.id)) {
        resultMap.set(r.id, r);
      }
    });

    let sorted = Array.from(resultMap.values())
      .map(r => ({ ...r, score: scores.get(r.id) || 0 }))
      .sort((a, b) => b.score - a.score);

    // LLM reranking for top-20 candidates (opt-in via query.rerank)
    if (query.rerank && sorted.length > 3) {
      const candidateCount = Math.min(sorted.length, 20);
      const candidates = sorted.slice(0, candidateCount);
      const rest = sorted.slice(candidateCount);

      try {
        const rerankItems: RerankItem[] = candidates.map(r => ({
          id: r.id,
          content: r.content || '',
          score: r.score,
        }));

        const reranked = await this.rerankerService.rerank(rerankItems, query.query, { topK: candidateCount });

        // Rebuild sorted array with reranked order
        const rerankedMap = new Map(reranked.map((r, idx) => [r.id, idx]));
        candidates.sort((a, b) => {
          const aIdx = rerankedMap.get(a.id) ?? candidateCount;
          const bIdx = rerankedMap.get(b.id) ?? candidateCount;
          return aIdx - bIdx;
        });
        // Update scores from reranking
        for (const candidate of candidates) {
          const rerankedItem = reranked.find(r => r.id === candidate.id);
          if (rerankedItem) {
            candidate.score = rerankedItem.score;
          }
        }

        sorted = [...candidates, ...rest];
      } catch (error) {
        this.logger.warn(`LLM reranking failed, using RRF order: ${error}`);
        // Keep original sorted order on failure
      }
    }

    return sorted.slice(0, limit);
  }
}
