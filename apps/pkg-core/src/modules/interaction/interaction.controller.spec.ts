import { Test, TestingModule } from '@nestjs/testing';
import { InteractionController } from './interaction.controller';
import { InteractionService } from './interaction.service';
import { NotFoundException } from '@nestjs/common';

describe('InteractionController', () => {
  let controller: InteractionController;
  let service: InteractionService;

  const mockInteraction = {
    id: 'test-uuid-1',
    type: 'telegram_session',
    source: 'telegram',
    status: 'active',
    startedAt: new Date(),
    endedAt: null,
    sourceMetadata: { telegram_chat_id: '123' },
    participants: [],
    messages: [],
    summary: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockInteractionService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    endSession: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InteractionController],
      providers: [
        {
          provide: InteractionService,
          useValue: mockInteractionService,
        },
      ],
    }).compile();

    controller = module.get<InteractionController>(InteractionController);
    service = module.get<InteractionService>(InteractionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('should return paginated list of interactions', async () => {
      const result = {
        items: [mockInteraction],
        total: 1,
        limit: 20,
        offset: 0,
      };
      mockInteractionService.findAll.mockResolvedValue(result);

      const response = await controller.findAll(20, 0);

      expect(response).toEqual(result);
      expect(service.findAll).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    });

    it('should use default pagination values', async () => {
      const result = {
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      };
      mockInteractionService.findAll.mockResolvedValue(result);

      await controller.findAll();

      expect(service.findAll).toHaveBeenCalledWith({ limit: undefined, offset: undefined });
    });
  });

  describe('findOne', () => {
    it('should return a single interaction by id', async () => {
      mockInteractionService.findOne.mockResolvedValue(mockInteraction);

      const response = await controller.findOne('test-uuid-1');

      expect(response).toEqual(mockInteraction);
      expect(service.findOne).toHaveBeenCalledWith('test-uuid-1');
    });

    it('should throw NotFoundException if interaction not found', async () => {
      mockInteractionService.findOne.mockRejectedValue(new NotFoundException());

      await expect(controller.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('endSession', () => {
    it('should end an active session', async () => {
      const endedInteraction = {
        ...mockInteraction,
        status: 'completed',
        endedAt: new Date(),
      };
      mockInteractionService.endSession.mockResolvedValue(endedInteraction);

      const response = await controller.endSession('test-uuid-1');

      expect(response.status).toBe('completed');
      expect(service.endSession).toHaveBeenCalledWith('test-uuid-1');
    });
  });
});
