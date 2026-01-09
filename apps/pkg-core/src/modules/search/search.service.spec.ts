import { Test, TestingModule } from '@nestjs/testing';
import { SearchService } from './search.service';
import { FtsService } from './fts.service';
import { VectorService } from './vector.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { SearchResult } from '@pkg/shared';

describe('SearchService', () => {
  let service: SearchService;
  let ftsService: FtsService;
  let vectorService: VectorService;
  let embeddingService: EmbeddingService;

  const mockSearchResult: SearchResult = {
    id: 'msg-1',
    type: 'message',
    content: 'Test message content',
    timestamp: new Date().toISOString(),
    interactionId: 'interaction-1',
    entity: {
      id: 'entity-1',
      name: 'John Doe',
    },
    score: 0.95,
  };

  const mockEmbedding = new Array(1536).fill(0.1);

  const mockFtsService = {
    search: jest.fn(),
  };

  const mockVectorService = {
    search: jest.fn(),
  };

  const mockEmbeddingService = {
    generate: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        {
          provide: FtsService,
          useValue: mockFtsService,
        },
        {
          provide: VectorService,
          useValue: mockVectorService,
        },
        {
          provide: EmbeddingService,
          useValue: mockEmbeddingService,
        },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
    ftsService = module.get<FtsService>(FtsService);
    vectorService = module.get<VectorService>(VectorService);
    embeddingService = module.get<EmbeddingService>(EmbeddingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('search', () => {
    it('should perform FTS search when searchType is fts', async () => {
      mockFtsService.search.mockResolvedValue([mockSearchResult]);

      const result = await service.search({
        query: 'test query',
        searchType: 'fts',
        limit: 20,
      });

      expect(result).toEqual({
        results: [mockSearchResult],
        total: 1,
        search_type: 'fts',
      });
      expect(ftsService.search).toHaveBeenCalledWith('test query', undefined, undefined, 20);
      expect(vectorService.search).not.toHaveBeenCalled();
    });

    it('should perform vector search when searchType is vector', async () => {
      mockEmbeddingService.generate.mockResolvedValue(mockEmbedding);
      mockVectorService.search.mockResolvedValue([mockSearchResult]);

      const result = await service.search({
        query: 'test query',
        searchType: 'vector',
        limit: 20,
      });

      expect(result).toEqual({
        results: [mockSearchResult],
        total: 1,
        search_type: 'vector',
      });
      expect(embeddingService.generate).toHaveBeenCalledWith('test query');
      expect(vectorService.search).toHaveBeenCalledWith(mockEmbedding, undefined, undefined, 20);
    });

    it('should perform hybrid search by default', async () => {
      const ftsResult = { ...mockSearchResult, id: 'fts-1', score: 0.8 };
      const vectorResult = { ...mockSearchResult, id: 'vector-1', score: 0.9 };

      mockFtsService.search.mockResolvedValue([ftsResult]);
      mockEmbeddingService.generate.mockResolvedValue(mockEmbedding);
      mockVectorService.search.mockResolvedValue([vectorResult]);

      const result = await service.search({
        query: 'test query',
      });

      expect(result.search_type).toBe('hybrid');
      expect(ftsService.search).toHaveBeenCalled();
      expect(vectorService.search).toHaveBeenCalled();
      expect(result.results.length).toBeLessThanOrEqual(20);
    });

    it('should apply entity filter', async () => {
      mockFtsService.search.mockResolvedValue([mockSearchResult]);

      await service.search({
        query: 'test',
        searchType: 'fts',
        entityId: 'entity-1',
      });

      expect(ftsService.search).toHaveBeenCalledWith('test', 'entity-1', undefined, 20);
    });

    it('should apply period filter', async () => {
      mockFtsService.search.mockResolvedValue([mockSearchResult]);

      const period = { from: '2024-01-01', to: '2024-01-07' };
      await service.search({
        query: 'test',
        searchType: 'fts',
        period,
      });

      expect(ftsService.search).toHaveBeenCalledWith('test', undefined, period, 20);
    });
  });

  describe('hybrid search RRF', () => {
    it('should combine results using Reciprocal Rank Fusion', async () => {
      const ftsResults = [
        { ...mockSearchResult, id: 'both-1' },
        { ...mockSearchResult, id: 'fts-only' },
      ];
      const vectorResults = [
        { ...mockSearchResult, id: 'both-1' },
        { ...mockSearchResult, id: 'vector-only' },
      ];

      mockFtsService.search.mockResolvedValue(ftsResults);
      mockEmbeddingService.generate.mockResolvedValue(mockEmbedding);
      mockVectorService.search.mockResolvedValue(vectorResults);

      const result = await service.search({
        query: 'test query',
        searchType: 'hybrid',
        limit: 10,
      });

      // 'both-1' should have highest score (appears in both)
      expect(result.results[0].id).toBe('both-1');
      expect(result.results.length).toBe(3);
    });
  });
});
