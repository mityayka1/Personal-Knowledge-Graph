import { Test, TestingModule } from '@nestjs/testing';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchResult } from '@pkg/shared';

describe('SearchController', () => {
  let controller: SearchController;
  let service: SearchService;

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

  const mockSearchService = {
    search: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [
        {
          provide: SearchService,
          useValue: mockSearchService,
        },
      ],
    }).compile();

    controller = module.get<SearchController>(SearchController);
    service = module.get<SearchService>(SearchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('search', () => {
    it('should call search service with query', async () => {
      const expected = {
        results: [mockSearchResult],
        total: 1,
        search_type: 'hybrid' as const,
      };
      mockSearchService.search.mockResolvedValue(expected);

      const query = { query: 'test query' };
      const result = await controller.search(query);

      expect(result).toEqual(expected);
      expect(service.search).toHaveBeenCalledWith(query);
    });

    it('should pass all search parameters', async () => {
      mockSearchService.search.mockResolvedValue({ results: [], total: 0, search_type: 'fts' });

      const query = {
        query: 'test',
        searchType: 'fts' as const,
        entityId: 'entity-1',
        period: { from: '2024-01-01', to: '2024-01-07' },
        limit: 50,
      };
      await controller.search(query);

      expect(service.search).toHaveBeenCalledWith(query);
    });
  });
});
