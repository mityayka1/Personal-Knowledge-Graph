import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { ClaudeAgentService } from './claude-agent.service';
import { RecallSessionService, RecallSession } from './recall-session.service';
import { EntityService } from '../entity/entity.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { DailySynthesisExtractionService } from '../extraction/daily-synthesis-extraction.service';
import { FactType, FactCategory, FactSource } from '@pkg/entities';

describe('AgentController - saveRecallSession', () => {
  let controller: AgentController;
  let recallSessionService: jest.Mocked<RecallSessionService>;
  let entityService: jest.Mocked<EntityService>;
  let entityFactService: jest.Mocked<EntityFactService>;

  const mockSession: RecallSession = {
    id: 'rs_test123456',
    query: 'test query',
    dateStr: '2026-01-30',
    answer: 'Test answer for saving',
    sources: [{ type: 'message', id: 'msg-uuid', preview: 'preview' }],
    model: 'sonnet',
    userId: 'user123',
    createdAt: Date.now(),
  };

  const mockOwner = {
    id: 'owner-uuid',
    name: 'Test Owner',
    isOwner: true,
  };

  const mockFact = {
    id: 'fact-uuid-123',
    type: FactType.DAILY_SUMMARY,
    category: FactCategory.PERSONAL,
    value: 'Test answer for saving',
    source: FactSource.EXTRACTED,
    confidence: 1.0,
  };

  beforeEach(async () => {
    const mockRecallSessionService = {
      get: jest.fn(),
      create: jest.fn(),
      markAsSaved: jest.fn(),
      updateAnswer: jest.fn(),
      verifyUser: jest.fn(),
    };

    const mockEntityService = {
      findMe: jest.fn(),
      findOne: jest.fn(),
    };

    const mockEntityFactService = {
      create: jest.fn(),
    };

    const mockClaudeAgentService = {
      call: jest.fn(),
    };

    const mockDailySynthesisExtractionService = {
      extract: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: ClaudeAgentService, useValue: mockClaudeAgentService },
        { provide: RecallSessionService, useValue: mockRecallSessionService },
        { provide: EntityService, useValue: mockEntityService },
        { provide: EntityFactService, useValue: mockEntityFactService },
        { provide: DailySynthesisExtractionService, useValue: mockDailySynthesisExtractionService },
      ],
    }).compile();

    controller = module.get<AgentController>(AgentController);
    recallSessionService = module.get(RecallSessionService);
    entityService = module.get(EntityService);
    entityFactService = module.get(EntityFactService);
  });

  describe('saveRecallSession', () => {
    it('should save session and create fact successfully', async () => {
      recallSessionService.get.mockResolvedValue(mockSession);
      entityService.findMe.mockResolvedValue(mockOwner as any);
      entityFactService.create.mockResolvedValue(mockFact as any);
      recallSessionService.markAsSaved.mockResolvedValue({
        success: true,
        alreadySaved: false,
      });

      const result = await controller.saveRecallSession('rs_test123456', {
        userId: 'user123',
      });

      expect(result).toEqual({
        success: true,
        alreadySaved: false,
        factId: 'fact-uuid-123',
      });

      expect(entityFactService.create).toHaveBeenCalledWith('owner-uuid', {
        type: FactType.DAILY_SUMMARY,
        category: FactCategory.PERSONAL,
        value: expect.any(String),
        valueJson: expect.objectContaining({
          fullContent: mockSession.answer,
          sessionId: mockSession.id,
        }),
        source: FactSource.EXTRACTED,
        confidence: 1.0,
      });

      expect(recallSessionService.markAsSaved).toHaveBeenCalledWith(
        'rs_test123456',
        'fact-uuid-123',
        'user123',
      );
    });

    it('should return 404 when session not found', async () => {
      recallSessionService.get.mockResolvedValue(null);

      await expect(
        controller.saveRecallSession('rs_nonexistent', { userId: 'user123' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return 403 when userId does not match', async () => {
      recallSessionService.get.mockResolvedValue(mockSession);

      await expect(
        controller.saveRecallSession('rs_test123456', { userId: 'wrong_user' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return alreadySaved when session was previously saved', async () => {
      const savedSession: RecallSession = {
        ...mockSession,
        savedAt: Date.now() - 1000,
        savedFactId: 'existing-fact-uuid',
      };
      recallSessionService.get.mockResolvedValue(savedSession);

      const result = await controller.saveRecallSession('rs_test123456', {
        userId: 'user123',
      });

      expect(result).toEqual({
        success: true,
        alreadySaved: true,
        factId: 'existing-fact-uuid',
      });

      // Should not create new fact
      expect(entityFactService.create).not.toHaveBeenCalled();
    });

    it('should return error when owner entity not found', async () => {
      recallSessionService.get.mockResolvedValue(mockSession);
      entityService.findMe.mockResolvedValue(null);

      const result = await controller.saveRecallSession('rs_test123456', {
        userId: 'user123',
      });

      expect(result).toEqual({
        success: false,
        error: 'Owner entity not configured. Please set an owner entity first.',
      });
    });

    it('should handle concurrent save (race condition)', async () => {
      recallSessionService.get.mockResolvedValue(mockSession);
      entityService.findMe.mockResolvedValue(mockOwner as any);
      entityFactService.create.mockResolvedValue(mockFact as any);

      // Simulate race condition - another request saved while we were creating fact
      recallSessionService.markAsSaved.mockResolvedValue({
        success: false,
        alreadySaved: true,
        existingFactId: 'other-fact-uuid',
      });

      const result = await controller.saveRecallSession('rs_test123456', {
        userId: 'user123',
      });

      expect(result).toEqual({
        success: true,
        alreadySaved: true,
        factId: 'other-fact-uuid',
      });
    });

    it('should return error when fact creation fails', async () => {
      recallSessionService.get.mockResolvedValue(mockSession);
      entityService.findMe.mockResolvedValue(mockOwner as any);
      entityFactService.create.mockRejectedValue(new Error('Database error'));

      const result = await controller.saveRecallSession('rs_test123456', {
        userId: 'user123',
      });

      expect(result).toEqual({
        success: false,
        error: 'Failed to save daily summary: Database error',
      });
    });

    it('should truncate long answers for value field', async () => {
      const longAnswer = 'A'.repeat(1000);
      const sessionWithLongAnswer = { ...mockSession, answer: longAnswer };
      recallSessionService.get.mockResolvedValue(sessionWithLongAnswer);
      entityService.findMe.mockResolvedValue(mockOwner as any);
      entityFactService.create.mockResolvedValue(mockFact as any);
      recallSessionService.markAsSaved.mockResolvedValue({
        success: true,
        alreadySaved: false,
      });

      await controller.saveRecallSession('rs_test123456', { userId: 'user123' });

      expect(entityFactService.create).toHaveBeenCalledWith(
        'owner-uuid',
        expect.objectContaining({
          value: 'A'.repeat(500), // Truncated to FACT_VALUE_PREVIEW_LENGTH
          valueJson: expect.objectContaining({
            fullContent: longAnswer, // Full content preserved in valueJson
          }),
        }),
      );
    });
  });
});
