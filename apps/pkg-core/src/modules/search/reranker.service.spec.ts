import { Test, TestingModule } from '@nestjs/testing';
import { RerankerService, RerankItem } from './reranker.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

describe('RerankerService', () => {
  let service: RerankerService;
  let claudeAgentService: ClaudeAgentService;

  const mockClaudeAgentService = {
    call: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RerankerService,
        {
          provide: ClaudeAgentService,
          useValue: mockClaudeAgentService,
        },
      ],
    }).compile();

    service = module.get<RerankerService>(RerankerService);
    claudeAgentService = module.get<ClaudeAgentService>(ClaudeAgentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should rerank items by relevance', async () => {
    const items: RerankItem[] = [
      { id: '1', content: 'First item about cats', score: 0.5 },
      { id: '2', content: 'Second item about dogs', score: 0.8 },
      { id: '3', content: 'Third item about cats and kittens', score: 0.3 },
    ];

    mockClaudeAgentService.call.mockResolvedValue({
      data: {
        rankings: [
          { id: '3', relevance: 0.95 },
          { id: '1', relevance: 0.85 },
          { id: '2', relevance: 0.2 },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
    });

    const result = await service.rerank(items, 'cats');

    expect(result[0].id).toBe('3');
    expect(result[0].score).toBe(0.95);
    expect(result[1].id).toBe('1');
    expect(result[1].score).toBe(0.85);
    expect(result[2].id).toBe('2');
    expect(result[2].score).toBe(0.2);

    expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'oneshot',
        taskType: 'reranking',
        model: 'haiku',
      }),
    );
  });

  it('should return original order when LLM fails', async () => {
    const items: RerankItem[] = [
      { id: '1', content: 'First item', score: 0.5 },
      { id: '2', content: 'Second item', score: 0.8 },
      { id: '3', content: 'Third item', score: 0.3 },
    ];

    mockClaudeAgentService.call.mockRejectedValue(new Error('LLM unavailable'));

    const result = await service.rerank(items, 'test query');

    expect(result).toEqual(items);
    expect(result.length).toBe(3);
  });

  it('should skip reranking if less than 2 items', async () => {
    const items: RerankItem[] = [
      { id: '1', content: 'Only item', score: 0.5 },
    ];

    const result = await service.rerank(items, 'test query');

    expect(result).toEqual(items);
    expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
  });
});
