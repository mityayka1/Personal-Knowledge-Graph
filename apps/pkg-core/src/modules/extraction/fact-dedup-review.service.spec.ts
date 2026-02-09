import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityFact, EntityRecord } from '@pkg/entities';
import {
  FactDedupReviewService,
  ReviewCandidate,
} from './fact-dedup-review.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';

// ─── Helpers ──────────────────────────────────────────────────────────

const createCandidate = (
  overrides: Partial<ReviewCandidate> = {},
): ReviewCandidate => ({
  index: 0,
  entityId: 'entity-aaa',
  newFact: {
    entityId: 'entity-aaa',
    factType: 'birthday',
    value: 'ДР 15 марта',
    confidence: 0.8,
  },
  matchedFactId: 'fact-111',
  similarity: 0.55,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('FactDedupReviewService', () => {
  let service: FactDedupReviewService;

  const mockFactRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockEntityRepo = {
    findOne: jest.fn(),
  };

  const mockClaudeAgentService = {
    call: jest.fn(),
  };

  const mockSettingsService = {
    getDedupSettings: jest.fn().mockResolvedValue({
      reviewThreshold: 0.40,
      reviewModel: 'haiku',
    }),
  };

  // ─── Setup with ClaudeAgentService available ──────────────────────

  const buildModule = async (
    claudeService: Record<string, jest.Mock> | null = mockClaudeAgentService,
  ): Promise<TestingModule> => {
    const providers: any[] = [
      FactDedupReviewService,
      {
        provide: getRepositoryToken(EntityFact),
        useValue: mockFactRepo,
      },
      {
        provide: getRepositoryToken(EntityRecord),
        useValue: mockEntityRepo,
      },
      {
        provide: SettingsService,
        useValue: mockSettingsService,
      },
    ];

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
    service = module.get(FactDedupReviewService);
    jest.clearAllMocks();

    // Restore default mock values after clearAllMocks
    mockSettingsService.getDedupSettings.mockResolvedValue({
      reviewThreshold: 0.40,
      reviewModel: 'haiku',
    });
  });

  // ─── reviewBatch ──────────────────────────────────────────────────

  describe('reviewBatch', () => {
    it('should return empty array for empty candidates list', async () => {
      const result = await service.reviewBatch([]);

      expect(result).toEqual([]);
      expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
    });

    it('should return create for all candidates when ClaudeAgentService is null', async () => {
      // Build module without ClaudeAgentService
      const module = await buildModule(null);
      const svcNoLlm = module.get(FactDedupReviewService);

      const candidates = [
        createCandidate({ index: 0 }),
        createCandidate({ index: 1, matchedFactId: 'fact-222' }),
      ];

      const result = await svcNoLlm.reviewBatch(candidates);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({ newFactIndex: 0, action: 'create' }),
      );
      expect(result[1]).toEqual(
        expect.objectContaining({ newFactIndex: 1, action: 'create' }),
      );
      // Every decision should mention unavailability
      result.forEach((d) => expect(d.reason).toContain('unavailable'));
    });

    it('should return skip when LLM says skip', async () => {
      mockEntityRepo.findOne.mockResolvedValue({
        id: 'entity-aaa',
        name: 'Иванов Иван',
        type: 'person',
      });
      mockFactRepo.find
        // First call — existing facts for entity
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'birthday', value: '15 марта 1985' },
        ])
        // Second call — matched facts by IDs
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'birthday', value: '15 марта 1985' },
        ]);

      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            {
              newFactIndex: 0,
              action: 'skip',
              reason: 'Duplicate birthday',
              duplicateOfId: 'fact-111',
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
      });

      const candidates = [createCandidate({ index: 0 })];
      const result = await service.reviewBatch(candidates);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        newFactIndex: 0,
        action: 'skip',
        reason: 'Duplicate birthday',
        duplicateOfId: 'fact-111',
      });
      expect(mockClaudeAgentService.call).toHaveBeenCalledTimes(1);
    });

    it('should return create when LLM says create', async () => {
      mockEntityRepo.findOne.mockResolvedValue({
        id: 'entity-aaa',
        name: 'Иванов Иван',
        type: 'person',
      });
      mockFactRepo.find
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'birthday', value: '15 марта 1985' },
        ])
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'birthday', value: '15 марта 1985' },
        ]);

      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            {
              newFactIndex: 0,
              action: 'create',
              reason: 'Different information despite similar wording',
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
      });

      const candidates = [createCandidate({ index: 0 })];
      const result = await service.reviewBatch(candidates);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        newFactIndex: 0,
        action: 'create',
        reason: 'Different information despite similar wording',
        duplicateOfId: undefined,
      });
    });

    it('should group candidates by entityId and call Claude once per entity', async () => {
      // Entity A
      mockEntityRepo.findOne
        .mockResolvedValueOnce({
          id: 'entity-aaa',
          name: 'Иванов',
          type: 'person',
        })
        .mockResolvedValueOnce({
          id: 'entity-bbb',
          name: 'Петров',
          type: 'person',
        });

      // Existing facts for entity-aaa, then matched facts for entity-aaa
      // Then existing facts for entity-bbb, then matched facts for entity-bbb
      mockFactRepo.find
        .mockResolvedValueOnce([{ id: 'fact-111', factType: 'birthday', value: '15 марта' }])
        .mockResolvedValueOnce([{ id: 'fact-111', factType: 'birthday', value: '15 марта' }])
        .mockResolvedValueOnce([{ id: 'fact-333', factType: 'phone', value: '+7999' }])
        .mockResolvedValueOnce([{ id: 'fact-333', factType: 'phone', value: '+7999' }]);

      mockClaudeAgentService.call
        .mockResolvedValueOnce({
          data: {
            decisions: [
              { newFactIndex: 0, action: 'skip', reason: 'dup birthday' },
              { newFactIndex: 1, action: 'create', reason: 'new info' },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            decisions: [
              { newFactIndex: 2, action: 'create', reason: 'unique' },
            ],
          },
        });

      const candidates = [
        createCandidate({
          index: 0,
          entityId: 'entity-aaa',
          matchedFactId: 'fact-111',
        }),
        createCandidate({
          index: 1,
          entityId: 'entity-aaa',
          matchedFactId: 'fact-111',
          newFact: {
            entityId: 'entity-aaa',
            factType: 'position',
            value: 'Developer',
            confidence: 0.7,
          },
        }),
        createCandidate({
          index: 2,
          entityId: 'entity-bbb',
          matchedFactId: 'fact-333',
          newFact: {
            entityId: 'entity-bbb',
            factType: 'phone',
            value: '+79990001122',
            confidence: 0.6,
          },
        }),
      ];

      const result = await service.reviewBatch(candidates);

      // Exactly 2 Claude calls: one per entity group
      expect(mockClaudeAgentService.call).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(3);

      // Check entity-aaa decisions
      expect(result.find((d) => d.newFactIndex === 0)?.action).toBe('skip');
      expect(result.find((d) => d.newFactIndex === 1)?.action).toBe('create');
      // Check entity-bbb decision
      expect(result.find((d) => d.newFactIndex === 2)?.action).toBe('create');
    });

    it('should fallback to create when LLM fails for one entity group', async () => {
      mockEntityRepo.findOne
        .mockResolvedValueOnce({
          id: 'entity-aaa',
          name: 'Иванов',
          type: 'person',
        })
        .mockResolvedValueOnce({
          id: 'entity-bbb',
          name: 'Петров',
          type: 'person',
        });

      mockFactRepo.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      // First entity group fails, second succeeds
      mockClaudeAgentService.call
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce({
          data: {
            decisions: [
              { newFactIndex: 1, action: 'skip', reason: 'dup' },
            ],
          },
        });

      const candidates = [
        createCandidate({ index: 0, entityId: 'entity-aaa' }),
        createCandidate({ index: 1, entityId: 'entity-bbb' }),
      ];

      const result = await service.reviewBatch(candidates);

      expect(result).toHaveLength(2);

      // Failed group → create
      const decisionA = result.find((d) => d.newFactIndex === 0)!;
      expect(decisionA.action).toBe('create');
      expect(decisionA.reason).toContain('LLM review failed');

      // Successful group → skip
      const decisionB = result.find((d) => d.newFactIndex === 1)!;
      expect(decisionB.action).toBe('skip');
    });

    it('should fallback to create when LLM omits a decision for a candidate', async () => {
      mockEntityRepo.findOne.mockResolvedValue({
        id: 'entity-aaa',
        name: 'Иванов',
        type: 'person',
      });

      mockFactRepo.find
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'birthday', value: '15 марта' },
        ])
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'birthday', value: '15 марта' },
        ]);

      // LLM only returns decision for index 0, omits index 1
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            { newFactIndex: 0, action: 'skip', reason: 'dup' },
            // No decision for index 1
          ],
        },
      });

      const candidates = [
        createCandidate({ index: 0 }),
        createCandidate({
          index: 1,
          newFact: {
            entityId: 'entity-aaa',
            factType: 'email',
            value: 'test@mail.ru',
            confidence: 0.7,
          },
        }),
      ];

      const result = await service.reviewBatch(candidates);

      expect(result).toHaveLength(2);
      expect(result.find((d) => d.newFactIndex === 0)?.action).toBe('skip');

      const missingDecision = result.find((d) => d.newFactIndex === 1)!;
      expect(missingDecision.action).toBe('create');
      expect(missingDecision.reason).toContain('did not return decision');
    });

    it('should return create for all candidates when entity is not found', async () => {
      mockEntityRepo.findOne.mockResolvedValue(null);

      const candidates = [
        createCandidate({ index: 0 }),
        createCandidate({ index: 1 }),
      ];

      const result = await service.reviewBatch(candidates);

      expect(result).toHaveLength(2);
      result.forEach((d) => {
        expect(d.action).toBe('create');
        expect(d.reason).toContain('not found');
      });
      // Should not call Claude when entity is not found
      expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
    });

    it('should use matchedFactId as duplicateOfId when LLM skip decision lacks duplicateOfId', async () => {
      mockEntityRepo.findOne.mockResolvedValue({
        id: 'entity-aaa',
        name: 'Иванов',
        type: 'person',
      });

      mockFactRepo.find
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'birthday', value: '15 марта 1985' },
        ])
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'birthday', value: '15 марта 1985' },
        ]);

      // LLM says skip but does not provide duplicateOfId
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          decisions: [
            { newFactIndex: 0, action: 'skip', reason: 'Same birthday' },
          ],
        },
      });

      const candidates = [
        createCandidate({ index: 0, matchedFactId: 'fact-111' }),
      ];

      const result = await service.reviewBatch(candidates);

      expect(result[0].action).toBe('skip');
      // Should fallback to candidate's matchedFactId
      expect(result[0].duplicateOfId).toBe('fact-111');
    });

    it('should pass reviewModel from settings to Claude call', async () => {
      mockSettingsService.getDedupSettings.mockResolvedValue({
        reviewThreshold: 0.40,
        reviewModel: 'sonnet',
      });

      mockEntityRepo.findOne.mockResolvedValue({
        id: 'entity-aaa',
        name: 'Иванов',
        type: 'person',
      });

      mockFactRepo.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      mockClaudeAgentService.call.mockResolvedValue({
        data: { decisions: [{ newFactIndex: 0, action: 'create', reason: 'ok' }] },
      });

      await service.reviewBatch([createCandidate({ index: 0 })]);

      expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'sonnet' }),
      );
    });
  });

  // ─── Prompt content (validated through Claude call arguments) ──────

  describe('prompt building (via reviewBatch)', () => {
    it('should include entity name, existing facts and candidates in prompt', async () => {
      mockEntityRepo.findOne.mockResolvedValue({
        id: 'entity-aaa',
        name: 'Сергей Петрович',
        type: 'person',
      });

      mockFactRepo.find
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'company', value: 'Яндекс' },
          { id: 'fact-222', factType: 'birthday', value: '15 марта' },
        ])
        .mockResolvedValueOnce([
          { id: 'fact-111', factType: 'company', value: 'Яндекс' },
        ]);

      mockClaudeAgentService.call.mockResolvedValue({
        data: { decisions: [{ newFactIndex: 0, action: 'create', reason: 'ok' }] },
      });

      const candidate = createCandidate({
        index: 0,
        matchedFactId: 'fact-111',
        newFact: {
          entityId: 'entity-aaa',
          factType: 'company',
          value: 'Работает в Яндексе',
          confidence: 0.8,
        },
        similarity: 0.55,
      });

      await service.reviewBatch([candidate]);

      const callArgs = mockClaudeAgentService.call.mock.calls[0][0];
      const prompt: string = callArgs.prompt;

      // Entity name present
      expect(prompt).toContain('Сергей Петрович');
      // Existing facts mentioned
      expect(prompt).toContain('Яндекс');
      expect(prompt).toContain('15 марта');
      // Candidate info present
      expect(prompt).toContain('Работает в Яндексе');
      expect(prompt).toContain('0.550');
    });

    it('should show "(нет фактов)" when entity has no existing facts', async () => {
      mockEntityRepo.findOne.mockResolvedValue({
        id: 'entity-aaa',
        name: 'Новый Контакт',
        type: 'person',
      });

      mockFactRepo.find
        .mockResolvedValueOnce([]) // No existing facts
        .mockResolvedValueOnce([{ id: 'fact-111', factType: 'birthday', value: '15 марта' }]);

      mockClaudeAgentService.call.mockResolvedValue({
        data: { decisions: [{ newFactIndex: 0, action: 'create', reason: 'ok' }] },
      });

      await service.reviewBatch([createCandidate({ index: 0 })]);

      const callArgs = mockClaudeAgentService.call.mock.calls[0][0];
      const prompt: string = callArgs.prompt;

      expect(prompt).toContain('(нет фактов)');
    });
  });
});
