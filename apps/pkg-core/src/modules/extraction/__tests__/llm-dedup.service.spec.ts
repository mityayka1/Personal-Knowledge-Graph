import { Test, TestingModule } from '@nestjs/testing';
import {
  LlmDedupService,
  DedupPair,
  DedupLlmDecision,
} from '../llm-dedup.service';
import { ClaudeAgentService } from '../../claude-agent/claude-agent.service';

// --- Helpers ---

const makePair = (overrides: Partial<DedupPair> = {}): DedupPair => ({
  newItem: {
    type: 'task',
    name: 'Настроить CI/CD',
    description: 'Настройка пайплайна для деплоя',
  },
  existingItem: {
    id: 'existing-aaa',
    type: 'task',
    name: 'Настроить CI/CD пайплайн',
    description: 'Настроить CI/CD для проекта',
  },
  ...overrides,
});

// --- Tests ---

describe('LlmDedupService', () => {
  let service: LlmDedupService;

  const mockClaudeAgentService = {
    call: jest.fn(),
  };

  const buildModule = async (
    claudeService: Record<string, jest.Mock> | null = mockClaudeAgentService,
  ): Promise<TestingModule> => {
    const providers: any[] = [LlmDedupService];

    if (claudeService) {
      providers.push({
        provide: ClaudeAgentService,
        useValue: claudeService,
      });
    }

    return Test.createTestingModule({ providers }).compile();
  };

  beforeEach(async () => {
    const module = await buildModule();
    service = module.get(LlmDedupService);
    jest.clearAllMocks();
  });

  // --- decideDuplicate ---

  describe('decideDuplicate', () => {
    it('should return isDuplicate=true with high confidence for obvious duplicates', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            {
              pairIndex: 0,
              isDuplicate: true,
              confidence: 0.95,
              reason: 'Одна и та же задача — настройка CI/CD',
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
      });

      const pair = makePair();
      const result = await service.decideDuplicate(pair);

      expect(result.isDuplicate).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.mergeIntoId).toBe('existing-aaa');
      expect(result.reason).toBeTruthy();

      // Should delegate to decideBatch (call once)
      expect(mockClaudeAgentService.call).toHaveBeenCalledTimes(1);
      expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'oneshot',
          taskType: 'dedup_decision',
          model: 'haiku',
        }),
      );
    });

    it('should return isDuplicate=false for different items', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            {
              pairIndex: 0,
              isDuplicate: false,
              confidence: 0.9,
              reason: 'Разные задачи: CI/CD vs покупка подарка',
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
      });

      const pair = makePair({
        newItem: {
          type: 'task',
          name: 'Купить подарок маме',
        },
        existingItem: {
          id: 'existing-bbb',
          type: 'task',
          name: 'Настроить CI/CD пайплайн',
        },
      });

      const result = await service.decideDuplicate(pair);

      expect(result.isDuplicate).toBe(false);
      expect(result.mergeIntoId).toBeUndefined();
    });
  });

  // --- decideBatch ---

  describe('decideBatch', () => {
    it('should process multiple pairs in single LLM call', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            {
              pairIndex: 0,
              isDuplicate: true,
              confidence: 0.95,
              reason: 'Одна и та же задача',
            },
            {
              pairIndex: 1,
              isDuplicate: false,
              confidence: 0.85,
              reason: 'Разные задачи',
            },
          ],
        },
        usage: { inputTokens: 200, outputTokens: 100, totalCostUsd: 0.002 },
      });

      const pairs: DedupPair[] = [
        makePair(),
        makePair({
          newItem: { type: 'task', name: 'Купить молоко' },
          existingItem: {
            id: 'existing-ccc',
            type: 'task',
            name: 'Написать документацию',
          },
        }),
      ];

      const results = await service.decideBatch(pairs);

      // Single LLM call for batch
      expect(mockClaudeAgentService.call).toHaveBeenCalledTimes(1);

      expect(results).toHaveLength(2);
      expect(results[0].isDuplicate).toBe(true);
      expect(results[0].mergeIntoId).toBe('existing-aaa');
      expect(results[1].isDuplicate).toBe(false);
      expect(results[1].mergeIntoId).toBeUndefined();
    });

    it('should return empty array for empty pairs', async () => {
      const results = await service.decideBatch([]);

      expect(results).toEqual([]);
      expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
    });
  });

  // --- Graceful degradation ---

  describe('graceful degradation', () => {
    it('should return isDuplicate=false when LLM call throws', async () => {
      mockClaudeAgentService.call.mockRejectedValue(
        new Error('API rate limit exceeded'),
      );

      const pair = makePair();
      const result = await service.decideDuplicate(pair);

      expect(result.isDuplicate).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain('LLM');
    });

    it('should return isDuplicate=false for all pairs when LLM call throws (batch)', async () => {
      mockClaudeAgentService.call.mockRejectedValue(
        new Error('Timeout'),
      );

      const pairs = [makePair(), makePair()];
      const results = await service.decideBatch(pairs);

      expect(results).toHaveLength(2);
      results.forEach((r: DedupLlmDecision) => {
        expect(r.isDuplicate).toBe(false);
        expect(r.confidence).toBe(0);
      });
    });

    it('should return isDuplicate=false when ClaudeAgentService is null', async () => {
      const module = await buildModule(null);
      const svcNoLlm = module.get(LlmDedupService);

      const pair = makePair();
      const result = await svcNoLlm.decideDuplicate(pair);

      expect(result.isDuplicate).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain('unavailable');
    });

    it('should return isDuplicate=false when LLM returns null data', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: null,
        usage: { inputTokens: 100, outputTokens: 0, totalCostUsd: 0.001 },
      });

      const pair = makePair();
      const result = await service.decideDuplicate(pair);

      expect(result.isDuplicate).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain('no structured data');
    });

    it('should handle missing pairIndex in LLM response gracefully', async () => {
      // LLM returns only 1 decision for 2 pairs
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            {
              pairIndex: 0,
              isDuplicate: true,
              confidence: 0.9,
              reason: 'Дубликат',
            },
            // Missing pairIndex: 1
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
      });

      const pairs = [makePair(), makePair()];
      const results = await service.decideBatch(pairs);

      expect(results).toHaveLength(2);
      expect(results[0].isDuplicate).toBe(true);
      // Missing decision defaults to non-duplicate
      expect(results[1].isDuplicate).toBe(false);
      expect(results[1].confidence).toBe(0);
      expect(results[1].reason).toContain('not return decision');
    });
  });

  // --- Prompt content ---

  describe('prompt building (via decideBatch)', () => {
    it('should include item type, names, descriptions, and activity context in prompt', async () => {
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            { pairIndex: 0, isDuplicate: false, confidence: 0.5, reason: 'test' },
          ],
        },
      });

      const pair = makePair({
        newItem: {
          type: 'commitment',
          name: 'Отправить отчёт до пятницы',
          description: 'Подготовить квартальный отчёт',
          context: 'Из переписки с Ивановым',
        },
        existingItem: {
          id: 'existing-xxx',
          type: 'commitment',
          name: 'Подготовить отчёт',
          description: 'Отчёт за Q4',
        },
        activityContext: 'Проект: Интеграция с Битрикс',
      });

      await service.decideBatch([pair]);

      const callArgs = mockClaudeAgentService.call.mock.calls[0][0];
      const prompt: string = callArgs.prompt;

      expect(prompt).toContain('commitment');
      expect(prompt).toContain('Отправить отчёт до пятницы');
      expect(prompt).toContain('Подготовить отчёт');
      expect(prompt).toContain('Подготовить квартальный отчёт');
      expect(prompt).toContain('Интеграция с Битрикс');
    });
  });
});
