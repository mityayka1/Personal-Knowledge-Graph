import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType, ActivityStatus } from '@pkg/entities';
import { DailySynthesisExtractionService } from './daily-synthesis-extraction.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';
import { DraftExtractionService } from './draft-extraction.service';
import { DailySynthesisExtractionResponse } from './daily-synthesis-extraction.types';

describe('DailySynthesisExtractionService', () => {
  let service: DailySynthesisExtractionService;
  let claudeAgentService: jest.Mocked<ClaudeAgentService>;
  let activityRepo: jest.Mocked<Repository<Activity>>;

  const mockActivities: Partial<Activity>[] = [
    {
      id: 'act-1',
      name: 'Хаб для Панавто',
      activityType: ActivityType.PROJECT,
      status: ActivityStatus.ACTIVE,
      clientEntity: { id: 'client-1', name: 'Панавто' } as any,
    },
    {
      id: 'act-2',
      name: 'ГуглШитс.ру',
      activityType: ActivityType.BUSINESS,
      status: ActivityStatus.ACTIVE,
      clientEntity: null,
    },
  ];

  const mockExtractionResponse: DailySynthesisExtractionResponse = {
    projects: [
      {
        name: 'Хаб для Панавто',
        isNew: false,
        existingActivityId: 'act-1',
        participants: ['Маша', 'Сергей'],
        client: 'Панавто',
        status: 'active',
        confidence: 0.95,
        projectIndicators: {
          hasDuration: true,
          hasStructure: true,
          hasDeliverable: true,
          hasTeam: true,
          hasExplicitContext: false,
        },
      },
      {
        name: 'Новая интеграция',
        isNew: true,
        participants: ['Иван'],
        confidence: 0.8,
        projectIndicators: {
          hasDuration: true,
          hasStructure: false,
          hasDeliverable: true,
          hasTeam: false,
          hasExplicitContext: false,
        },
      },
    ],
    tasks: [
      {
        title: 'Подготовить демо',
        projectName: 'Хаб для Панавто',
        status: 'pending',
        assignee: 'self',
        confidence: 0.9,
      },
    ],
    commitments: [
      {
        what: 'Отправить документацию',
        from: 'self',
        to: 'Сергей',
        type: 'promise',
        deadline: '2026-02-01',
        confidence: 0.85,
      },
    ],
    inferredRelations: [
      {
        type: 'project_member',
        entities: ['Маша', 'Сергей'],
        activityName: 'Хаб для Панавто',
        confidence: 0.9,
      },
    ],
    extractionSummary: 'Extracted 2 projects, 1 task, 1 commitment',
  };

  beforeEach(async () => {
    const mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(mockActivities),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailySynthesisExtractionService,
        {
          provide: ClaudeAgentService,
          useValue: {
            call: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Activity),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
          },
        },
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn().mockResolvedValue({ theme: 'light' }),
            getDailySynthesisModel: jest.fn().mockResolvedValue('haiku'),
          },
        },
        {
          provide: DraftExtractionService,
          useValue: {
            createDrafts: jest.fn().mockResolvedValue({
              batchId: 'batch-123',
              counts: { projects: 0, tasks: 0, commitments: 0 },
              approvals: [],
            }),
          },
        },
      ],
    }).compile();

    service = module.get<DailySynthesisExtractionService>(
      DailySynthesisExtractionService,
    );
    claudeAgentService = module.get(ClaudeAgentService);
    activityRepo = module.get(getRepositoryToken(Activity));
  });

  describe('extract', () => {
    it('should extract structured data from daily synthesis', async () => {
      claudeAgentService.call.mockResolvedValue({
        data: mockExtractionResponse,
        usage: { inputTokens: 1000, outputTokens: 500, totalCostUsd: 0.01 },
        run: {} as any,
      });

      const result = await service.extract({
        synthesisText: 'Сегодня работал над Хабом для Панавто с Машей и Сергеем...',
        date: '2026-01-30',
      });

      expect(result.projects).toHaveLength(2);
      expect(result.tasks).toHaveLength(1);
      expect(result.commitments).toHaveLength(1);
      expect(result.inferredRelations).toHaveLength(1);
      expect(result.tokensUsed).toBe(1500);
      expect(result.extractedAt).toBeInstanceOf(Date);
    });

    it('should match existing projects by ID from LLM response', async () => {
      claudeAgentService.call.mockResolvedValue({
        data: mockExtractionResponse,
        usage: { inputTokens: 500, outputTokens: 300, totalCostUsd: 0.005 },
        run: {} as any,
      });

      const result = await service.extract({
        synthesisText: 'Работа над хабом продолжается...',
      });

      const existingProject = result.projects.find((p) => !p.isNew);
      expect(existingProject).toBeDefined();
      expect(existingProject?.existingActivityId).toBe('act-1');
    });

    it('should match projects by name fuzzy matching', async () => {
      // Response without existingActivityId — service should match by name
      const responseWithoutIds: DailySynthesisExtractionResponse = {
        projects: [
          {
            name: 'хаб для панавто', // Lowercase, should still match
            isNew: true, // Will be corrected to false after matching
            participants: [],
            confidence: 0.8,
          },
        ],
        tasks: [],
        commitments: [],
        inferredRelations: [],
        extractionSummary: 'test',
      };

      claudeAgentService.call.mockResolvedValue({
        data: responseWithoutIds,
        usage: { inputTokens: 500, outputTokens: 200, totalCostUsd: 0.004 },
        run: {} as any,
      });

      const result = await service.extract({
        synthesisText: 'Работа над хабом для панавто...',
      });

      // Should match existing activity by fuzzy name comparison
      expect(result.projects[0].isNew).toBe(false);
      expect(result.projects[0].existingActivityId).toBe('act-1');
    });

    it('should use haiku model for extraction', async () => {
      claudeAgentService.call.mockResolvedValue({
        data: mockExtractionResponse,
        usage: { inputTokens: 100, outputTokens: 100, totalCostUsd: 0.001 },
        run: {} as any,
      });

      await service.extract({
        synthesisText: 'Test synthesis',
      });

      expect(claudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'oneshot',
          model: 'haiku',
          taskType: 'daily_brief',
        }),
      );
    });

    it('should include focus topic in prompt when provided', async () => {
      claudeAgentService.call.mockResolvedValue({
        data: mockExtractionResponse,
        usage: { inputTokens: 100, outputTokens: 100, totalCostUsd: 0.001 },
        run: {} as any,
      });

      await service.extract({
        synthesisText: 'Test',
        focusTopic: 'Панавто',
      });

      const callArgs = claudeAgentService.call.mock.calls[0][0];
      expect(callArgs.prompt).toContain('Фокус: "Панавто"');
    });
  });

  describe('filterLowQualityProjects (via extract)', () => {
    it('should filter out project with confidence < 0.6', async () => {
      const responseWithLowConfidence: DailySynthesisExtractionResponse = {
        projects: [
          {
            name: 'Low Confidence Project',
            isNew: true,
            participants: [],
            confidence: 0.4,
            projectIndicators: {
              hasDuration: true,
              hasStructure: true,
              hasDeliverable: true,
              hasTeam: false,
              hasExplicitContext: false,
            },
          },
        ],
        tasks: [],
        commitments: [],
        inferredRelations: [],
        extractionSummary: 'test',
      };

      claudeAgentService.call.mockResolvedValue({
        data: responseWithLowConfidence,
        usage: { inputTokens: 100, outputTokens: 100, totalCostUsd: 0.001 },
        run: {} as any,
      });

      const result = await service.extract({
        synthesisText: 'Some synthesis text',
      });

      expect(result.projects).toHaveLength(0);
    });

    it('should filter out project with fewer than 2 indicators', async () => {
      const responseWithFewIndicators: DailySynthesisExtractionResponse = {
        projects: [
          {
            name: 'Weak Project',
            isNew: true,
            participants: [],
            confidence: 0.8,
            projectIndicators: {
              hasDuration: true,
              hasStructure: false,
              hasDeliverable: false,
              hasTeam: false,
              hasExplicitContext: false,
            },
          },
        ],
        tasks: [],
        commitments: [],
        inferredRelations: [],
        extractionSummary: 'test',
      };

      claudeAgentService.call.mockResolvedValue({
        data: responseWithFewIndicators,
        usage: { inputTokens: 100, outputTokens: 100, totalCostUsd: 0.001 },
        run: {} as any,
      });

      const result = await service.extract({
        synthesisText: 'Some synthesis text',
      });

      // Only 1 indicator (hasDuration) => should be filtered
      expect(result.projects).toHaveLength(0);
    });

    it('should keep project with >= 2 indicators and confidence >= 0.6', async () => {
      const responseWithGoodProject: DailySynthesisExtractionResponse = {
        projects: [
          {
            name: 'Good Project',
            isNew: true,
            participants: [],
            confidence: 0.7,
            projectIndicators: {
              hasDuration: true,
              hasStructure: true,
              hasDeliverable: false,
              hasTeam: false,
              hasExplicitContext: false,
            },
          },
        ],
        tasks: [],
        commitments: [],
        inferredRelations: [],
        extractionSummary: 'test',
      };

      claudeAgentService.call.mockResolvedValue({
        data: responseWithGoodProject,
        usage: { inputTokens: 100, outputTokens: 100, totalCostUsd: 0.001 },
        run: {} as any,
      });

      const result = await service.extract({
        synthesisText: 'Some synthesis text',
      });

      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].name).toBe('Good Project');
    });

    it('should keep project without projectIndicators (legacy)', async () => {
      const responseWithLegacyProject: DailySynthesisExtractionResponse = {
        projects: [
          {
            name: 'Legacy Project',
            isNew: true,
            participants: [],
            confidence: 0.8,
            // No projectIndicators field
          },
        ],
        tasks: [],
        commitments: [],
        inferredRelations: [],
        extractionSummary: 'test',
      };

      claudeAgentService.call.mockResolvedValue({
        data: responseWithLegacyProject,
        usage: { inputTokens: 100, outputTokens: 100, totalCostUsd: 0.001 },
        run: {} as any,
      });

      const result = await service.extract({
        synthesisText: 'Some synthesis text',
      });

      // Legacy project without indicators should be kept (only confidence check applies)
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].name).toBe('Legacy Project');
    });
  });
});
