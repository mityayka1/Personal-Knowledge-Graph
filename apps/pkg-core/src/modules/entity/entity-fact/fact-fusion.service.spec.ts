import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact, FactType, FactCategory, FactSource } from '@pkg/entities';
import { FactFusionService } from './fact-fusion.service';
import { FusionAction, FusionDecision } from './fact-fusion.constants';
import { ClaudeAgentService } from '../../claude-agent/claude-agent.service';

describe('FactFusionService', () => {
  let service: FactFusionService;
  let factRepo: jest.Mocked<Repository<EntityFact>>;
  let claudeAgentService: jest.Mocked<ClaudeAgentService>;

  const mockFactRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };

  const mockClaudeAgentService = {
    call: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FactFusionService,
        {
          provide: getRepositoryToken(EntityFact),
          useValue: mockFactRepo,
        },
        {
          provide: ClaudeAgentService,
          useValue: mockClaudeAgentService,
        },
      ],
    }).compile();

    service = module.get<FactFusionService>(FactFusionService);
    factRepo = module.get(getRepositoryToken(EntityFact));
    claudeAgentService = module.get(ClaudeAgentService);

    jest.clearAllMocks();
  });

  describe('decideFusion', () => {
    const existingFact: Partial<EntityFact> = {
      id: 'fact-1',
      factType: FactType.POSITION,
      value: 'Работает в Сбере',
      source: FactSource.EXTRACTED,
      confidence: 0.8,
      createdAt: new Date('2025-01-01'),
    };

    it('should return CONFIRM for same information', async () => {
      const decision: FusionDecision = {
        action: FusionAction.CONFIRM,
        explanation: 'Та же информация о работе',
        confidence: 0.95,
      };

      mockClaudeAgentService.call.mockResolvedValue({ data: decision });

      const result = await service.decideFusion(
        existingFact as EntityFact,
        'Сотрудник Сбербанка',
        FactSource.EXTRACTED,
      );

      expect(result.action).toBe(FusionAction.CONFIRM);
      expect(result.confidence).toBe(0.95);
    });

    it('should return ENRICH with mergedValue for complementary info', async () => {
      const decision: FusionDecision = {
        action: FusionAction.ENRICH,
        mergedValue: 'Ведущий разработчик в Сбербанке',
        explanation: 'Объединяем информацию о должности и компании',
        confidence: 0.9,
      };

      mockClaudeAgentService.call.mockResolvedValue({ data: decision });

      const result = await service.decideFusion(
        existingFact as EntityFact,
        'Ведущий разработчик',
        FactSource.EXTRACTED,
      );

      expect(result.action).toBe(FusionAction.ENRICH);
      expect(result.mergedValue).toBe('Ведущий разработчик в Сбербанке');
    });

    it('should escalate to CONFLICT on low confidence', async () => {
      const decision: FusionDecision = {
        action: FusionAction.ENRICH,
        mergedValue: 'Some value',
        explanation: 'Не уверен',
        confidence: 0.5, // Below threshold
      };

      mockClaudeAgentService.call.mockResolvedValue({ data: decision });

      const result = await service.decideFusion(
        existingFact as EntityFact,
        'Some new value',
        FactSource.EXTRACTED,
      );

      expect(result.action).toBe(FusionAction.CONFLICT);
      expect(result.explanation).toContain('Низкая уверенность');
    });

    it('should return CONFLICT on LLM error', async () => {
      mockClaudeAgentService.call.mockRejectedValue(new Error('LLM unavailable'));

      const result = await service.decideFusion(
        existingFact as EntityFact,
        'Some value',
        FactSource.EXTRACTED,
      );

      expect(result.action).toBe(FusionAction.CONFLICT);
      expect(result.explanation).toContain('Ошибка');
    });
  });

  describe('applyDecision', () => {
    const entityId = 'entity-123';
    const existingFact: Partial<EntityFact> = {
      id: 'fact-1',
      entityId,
      factType: FactType.POSITION,
      category: FactCategory.PROFESSIONAL,
      value: 'Работает в Сбере',
      source: FactSource.EXTRACTED,
      confidence: 0.8,
      confirmationCount: 1,
    };

    const newFactDto = {
      type: FactType.POSITION,
      category: FactCategory.PROFESSIONAL,
      value: 'Ведущий разработчик в Сбербанке',
      source: FactSource.EXTRACTED,
    };

    describe('CONFIRM action', () => {
      it('should increase confirmation count', async () => {
        const decision: FusionDecision = {
          action: FusionAction.CONFIRM,
          explanation: 'Подтверждение',
          confidence: 0.95,
        };

        mockFactRepo.update.mockResolvedValue({ affected: 1 });
        mockFactRepo.findOne.mockResolvedValue({
          ...existingFact,
          confirmationCount: 2,
          confidence: 0.85,
        });

        const result = await service.applyDecision(
          existingFact as EntityFact,
          newFactDto,
          decision,
          entityId,
        );

        expect(result.action).toBe('updated');
        expect(mockFactRepo.update).toHaveBeenCalledWith(existingFact.id, {
          confirmationCount: 2,
          confidence: expect.any(Number),
        });
      });
    });

    describe('ENRICH action', () => {
      it('should update value with merged content', async () => {
        const decision: FusionDecision = {
          action: FusionAction.ENRICH,
          mergedValue: 'Ведущий разработчик в Сбербанке',
          explanation: 'Объединили должность и компанию',
          confidence: 0.9,
        };

        mockFactRepo.update.mockResolvedValue({ affected: 1 });
        mockFactRepo.findOne.mockResolvedValue({
          ...existingFact,
          value: decision.mergedValue,
        });

        const result = await service.applyDecision(
          existingFact as EntityFact,
          newFactDto,
          decision,
          entityId,
        );

        expect(result.action).toBe('updated');
        expect(result.reason).toContain('ENRICH');
        expect(result.reason).toContain(decision.mergedValue);
      });

      it('should skip if mergedValue is missing', async () => {
        const decision: FusionDecision = {
          action: FusionAction.ENRICH,
          explanation: 'Missing merged value',
          confidence: 0.9,
        };

        const result = await service.applyDecision(
          existingFact as EntityFact,
          newFactDto,
          decision,
          entityId,
        );

        expect(result.action).toBe('skipped');
        expect(result.reason).toContain('без mergedValue');
      });
    });

    describe('SUPERSEDE action', () => {
      it('should create new fact and deprecate old', async () => {
        const decision: FusionDecision = {
          action: FusionAction.SUPERSEDE,
          explanation: 'Новая информация точнее',
          confidence: 0.85,
        };

        const newFact = {
          id: 'new-fact-1',
          entityId,
          ...newFactDto,
          factType: newFactDto.type,
          rank: 'preferred',
        };

        mockFactRepo.create.mockReturnValue(newFact);
        mockFactRepo.save.mockResolvedValue(newFact);
        mockFactRepo.update.mockResolvedValue({ affected: 1 });

        const result = await service.applyDecision(
          existingFact as EntityFact,
          newFactDto,
          decision,
          entityId,
        );

        expect(result.action).toBe('created');
        expect(result.fact.id).toBe('new-fact-1');
        expect(mockFactRepo.update).toHaveBeenCalledWith(existingFact.id, {
          rank: 'deprecated',
          validUntil: expect.any(Date),
          supersededById: 'new-fact-1',
        });
      });
    });

    describe('COEXIST action', () => {
      it('should create new fact without deprecating old', async () => {
        const decision: FusionDecision = {
          action: FusionAction.COEXIST,
          explanation: 'Оба факта валидны',
          confidence: 0.9,
        };

        const newFact = {
          id: 'new-fact-1',
          entityId,
          ...newFactDto,
          factType: newFactDto.type,
          rank: 'normal',
        };

        mockFactRepo.create.mockReturnValue(newFact);
        mockFactRepo.save.mockResolvedValue(newFact);

        const result = await service.applyDecision(
          existingFact as EntityFact,
          newFactDto,
          decision,
          entityId,
        );

        expect(result.action).toBe('created');
        expect(result.reason).toContain('COEXIST');
        // Should not update the existing fact
        expect(mockFactRepo.update).not.toHaveBeenCalled();
      });
    });

    describe('CONFLICT action', () => {
      it('should mark existing fact for review', async () => {
        const decision: FusionDecision = {
          action: FusionAction.CONFLICT,
          explanation: 'Противоречивая информация',
          confidence: 0.8,
        };

        mockFactRepo.update.mockResolvedValue({ affected: 1 });
        mockFactRepo.findOne.mockResolvedValue({
          ...existingFact,
          needsReview: true,
          reviewReason: expect.any(String),
        });

        const result = await service.applyDecision(
          existingFact as EntityFact,
          newFactDto,
          decision,
          entityId,
        );

        expect(result.action).toBe('skipped');
        expect(result.needsReview).toBe(true);
        expect(result.newFactData).toEqual(newFactDto);
        expect(mockFactRepo.update).toHaveBeenCalledWith(existingFact.id, {
          needsReview: true,
          reviewReason: expect.stringContaining(newFactDto.value),
        });
      });
    });
  });
});
