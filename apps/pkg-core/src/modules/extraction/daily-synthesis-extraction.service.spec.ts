import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType, ActivityStatus } from '@pkg/entities';
import { DailySynthesisExtractionService } from './daily-synthesis-extraction.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';
import { DraftExtractionService } from './draft-extraction.service';
import { DailySynthesisExtractionResponse } from './daily-synthesis-extraction.types';
import { ProjectMatchingService } from './project-matching.service';
import { PendingApprovalService } from '../pending-approval/pending-approval.service';
import { DeduplicationGatewayService } from './dedup-gateway.service';

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
        {
          provide: ProjectMatchingService,
          useValue: {
            findBestMatchInList: jest.fn().mockImplementation(
              (name: string, activities: Array<{ id: string; name: string }>) => {
                const normalized = name.toLowerCase();
                for (const act of activities) {
                  if (act.name.toLowerCase() === normalized) {
                    return { activity: act, similarity: 1.0 };
                  }
                  // Simple containment check for fuzzy matching mock
                  if (
                    act.name.toLowerCase().includes(normalized) ||
                    normalized.includes(act.name.toLowerCase())
                  ) {
                    return { activity: act, similarity: 0.85 };
                  }
                }
                return null;
              },
            ),
          },
        },
        {
          provide: PendingApprovalService,
          useValue: {
            findByBatchId: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: DeduplicationGatewayService,
          useValue: {
            checkTask: jest.fn().mockResolvedValue({ action: 'create', confidence: 0, reason: 'No match' }),
            checkEntity: jest.fn().mockResolvedValue({ action: 'create', confidence: 0, reason: 'No match' }),
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

    it('should keep project without projectIndicators (legacy data)', async () => {
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

  describe('filterLowQualityTasks (via extract)', () => {
    const makeResponse = (
      tasks: DailySynthesisExtractionResponse['tasks'],
    ): DailySynthesisExtractionResponse => ({
      projects: [],
      tasks,
      commitments: [],
      inferredRelations: [],
      extractionSummary: 'test',
    });

    const mockCall = (tasks: DailySynthesisExtractionResponse['tasks']) => {
      claudeAgentService.call.mockResolvedValue({
        data: makeResponse(tasks),
        usage: { inputTokens: 100, outputTokens: 100, totalCostUsd: 0.001 },
        run: {} as any,
      });
    };

    it('should filter task with vague "что-нибудь" and no anchor', async () => {
      mockCall([
        {
          title: 'Оплатить что-нибудь когда надо будет',
          status: 'pending',
          confidence: 0.85,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.tasks).toHaveLength(0);
    });

    it('should filter task with "че нить" (colloquial)', async () => {
      mockCall([
        {
          title: 'Оплатить че нить для сервера',
          status: 'pending',
          confidence: 0.8,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.tasks).toHaveLength(0);
    });

    it('should filter task with confidence < 0.7', async () => {
      mockCall([
        {
          title: 'Подготовить отчёт по продажам',
          status: 'pending',
          confidence: 0.6,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.tasks).toHaveLength(0);
    });

    it('should filter task with short title', async () => {
      mockCall([
        { title: 'Сделать', status: 'pending', confidence: 0.9 },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.tasks).toHaveLength(0);
    });

    it('should keep task with vague word but anchored to project', async () => {
      mockCall([
        {
          title: 'Оплатить что-нибудь для хостинга',
          projectName: 'PKG',
          status: 'pending',
          confidence: 0.85,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.tasks).toHaveLength(1);
    });

    it('should keep specific actionable task', async () => {
      mockCall([
        {
          title: 'Оплатить хостинг на Hetzner до 15 февраля',
          status: 'pending',
          confidence: 0.9,
          deadline: '2026-02-15',
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.tasks).toHaveLength(1);
    });
  });

  describe('filterLowQualityCommitments (via extract)', () => {
    const makeResponse = (
      commitments: DailySynthesisExtractionResponse['commitments'],
    ): DailySynthesisExtractionResponse => ({
      projects: [],
      tasks: [],
      commitments,
      inferredRelations: [],
      extractionSummary: 'test',
    });

    const mockCall = (commitments: DailySynthesisExtractionResponse['commitments']) => {
      claudeAgentService.call.mockResolvedValue({
        data: makeResponse(commitments),
        usage: { inputTokens: 100, outputTokens: 100, totalCostUsd: 0.001 },
        run: {} as any,
      });
    };

    it('should filter commitment with confidence < 0.7', async () => {
      mockCall([
        {
          what: 'Отправить отчёт до конца дня',
          from: 'self',
          to: 'Сергей',
          type: 'promise',
          confidence: 0.6,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.commitments).toHaveLength(0);
    });

    it('should filter commitment with short vague title', async () => {
      mockCall([
        {
          what: 'Написать',
          from: 'self',
          to: 'Маша',
          type: 'promise',
          confidence: 0.8,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.commitments).toHaveLength(0);
    });

    it('should filter commitment with vague pronoun and no anchor', async () => {
      mockCall([
        {
          what: 'Попытаться написать что-то',
          from: 'Маша',
          to: 'self',
          type: 'request',
          confidence: 0.7,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.commitments).toHaveLength(0);
    });

    it('should keep commitment with vague pronoun but anchored to project', async () => {
      mockCall([
        {
          what: 'Написать что-то для презентации',
          from: 'self',
          to: 'Маша',
          type: 'promise',
          confidence: 0.8,
          projectName: 'Хаб для Панавто',
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.commitments).toHaveLength(1);
    });

    it('should keep commitment with vague pronoun but anchored to deadline', async () => {
      mockCall([
        {
          what: 'Написать что-то для клиента',
          from: 'self',
          to: 'Сергей',
          type: 'promise',
          confidence: 0.75,
          deadline: '2026-02-15',
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.commitments).toHaveLength(1);
    });

    it('should keep specific actionable commitment', async () => {
      mockCall([
        {
          what: 'Отправить документацию по API до пятницы',
          from: 'self',
          to: 'Сергей',
          type: 'promise',
          deadline: '2026-02-14',
          confidence: 0.9,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.commitments).toHaveLength(1);
      expect(result.commitments[0].what).toBe('Отправить документацию по API до пятницы');
    });

    it('should filter multiple vague commitments and keep good ones', async () => {
      mockCall([
        {
          what: 'Сделать кое-что',
          from: 'self',
          to: 'Маша',
          type: 'promise',
          confidence: 0.7,
        },
        {
          what: 'Подготовить отчёт по продажам за январь',
          from: 'self',
          to: 'Директор',
          type: 'promise',
          confidence: 0.85,
        },
        {
          what: 'Позвонить',
          from: 'self',
          to: 'Клиент',
          type: 'reminder',
          confidence: 0.75,
        },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.commitments).toHaveLength(1);
      expect(result.commitments[0].what).toBe('Подготовить отчёт по продажам за январь');
    });

    it('should handle various vague patterns (как-нибудь, где-то, когда-нибудь)', async () => {
      mockCall([
        { what: 'Как-нибудь доделать форму', from: 'self', to: 'self', type: 'promise', confidence: 0.7 },
        { what: 'Где-то поправить баг', from: 'self', to: 'self', type: 'promise', confidence: 0.7 },
        { what: 'Когда-нибудь разобраться с деплоем', from: 'self', to: 'self', type: 'promise', confidence: 0.7 },
      ]);

      const result = await service.extract({ synthesisText: 'test' });
      expect(result.commitments).toHaveLength(0);
    });
  });
});
