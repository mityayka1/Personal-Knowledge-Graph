import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { InteractionService } from './interaction.service';
import { Interaction, InteractionParticipant, InteractionType, InteractionStatus } from '@pkg/entities';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_SESSION_GAP_MINUTES } from '@pkg/shared';

describe('InteractionService', () => {
  let service: InteractionService;
  let interactionRepo: Repository<Interaction>;
  let participantRepo: Repository<InteractionParticipant>;

  const mockInteraction = {
    id: 'test-uuid-1',
    type: InteractionType.TELEGRAM_SESSION,
    source: 'telegram',
    status: InteractionStatus.ACTIVE,
    startedAt: new Date(),
    endedAt: null,
    sourceMetadata: { telegram_chat_id: '123' },
    participants: [],
    messages: [],
    summary: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockInteractionRepository = {
    findAndCount: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockParticipantRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  const mockSettingsService = {
    getSessionGapMs: jest.fn().mockResolvedValue(DEFAULT_SESSION_GAP_MINUTES * 60 * 1000),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InteractionService,
        {
          provide: getRepositoryToken(Interaction),
          useValue: mockInteractionRepository,
        },
        {
          provide: getRepositoryToken(InteractionParticipant),
          useValue: mockParticipantRepository,
        },
        {
          provide: SettingsService,
          useValue: mockSettingsService,
        },
      ],
    }).compile();

    service = module.get<InteractionService>(InteractionService);
    interactionRepo = module.get<Repository<Interaction>>(getRepositoryToken(Interaction));
    participantRepo = module.get<Repository<InteractionParticipant>>(getRepositoryToken(InteractionParticipant));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('should return paginated interactions', async () => {
      const interactions = [mockInteraction];
      mockInteractionRepository.findAndCount.mockResolvedValue([interactions, 1]);

      const result = await service.findAll({ limit: 20, offset: 0 });

      expect(result).toEqual({
        items: interactions,
        total: 1,
        limit: 20,
        offset: 0,
      });
      expect(interactionRepo.findAndCount).toHaveBeenCalledWith({
        relations: ['participants', 'participants.entity'],
        order: { startedAt: 'DESC' },
        take: 20,
        skip: 0,
      });
    });

    it('should use default pagination', async () => {
      mockInteractionRepository.findAndCount.mockResolvedValue([[], 0]);

      await service.findAll();

      expect(interactionRepo.findAndCount).toHaveBeenCalledWith({
        relations: ['participants', 'participants.entity'],
        order: { startedAt: 'DESC' },
        take: 20,
        skip: 0,
      });
    });
  });

  describe('findOne', () => {
    it('should return interaction with relations', async () => {
      mockInteractionRepository.findOne.mockResolvedValue(mockInteraction);

      const result = await service.findOne('test-uuid-1');

      expect(result).toEqual(mockInteraction);
      expect(interactionRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'test-uuid-1' },
        relations: ['participants', 'participants.entity', 'messages', 'summary'],
      });
    });

    it('should throw NotFoundException if not found', async () => {
      mockInteractionRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findActiveSession', () => {
    it('should find active session by chat id', async () => {
      mockInteractionRepository.findOne.mockResolvedValue(mockInteraction);

      const result = await service.findActiveSession('123');

      expect(result).toEqual(mockInteraction);
      expect(interactionRepo.findOne).toHaveBeenCalledWith({
        where: {
          type: InteractionType.TELEGRAM_SESSION,
          status: InteractionStatus.ACTIVE,
          sourceMetadata: { telegram_chat_id: '123' },
        },
        relations: ['participants'],
      });
    });

    it('should return null if no active session', async () => {
      mockInteractionRepository.findOne.mockResolvedValue(null);

      const result = await service.findActiveSession('123');

      expect(result).toBeNull();
    });
  });

  describe('createSession', () => {
    it('should create new telegram session', async () => {
      const newSession = {
        ...mockInteraction,
        id: 'new-uuid',
      };
      mockInteractionRepository.create.mockReturnValue(newSession);
      mockInteractionRepository.save.mockResolvedValue(newSession);

      const result = await service.createSession('456');

      expect(result).toEqual(newSession);
      expect(interactionRepo.create).toHaveBeenCalledWith({
        type: InteractionType.TELEGRAM_SESSION,
        source: 'telegram',
        status: InteractionStatus.ACTIVE,
        startedAt: expect.any(Date),
        sourceMetadata: { telegram_chat_id: '456' },
      });
    });
  });

  describe('endSession', () => {
    it('should end session and set completed status', async () => {
      mockInteractionRepository.findOne.mockResolvedValue(mockInteraction);
      const endedSession = {
        ...mockInteraction,
        status: InteractionStatus.COMPLETED,
        endedAt: expect.any(Date),
      };
      mockInteractionRepository.save.mockResolvedValue(endedSession);

      const result = await service.endSession('test-uuid-1');

      expect(result.status).toBe(InteractionStatus.COMPLETED);
      expect(result.endedAt).toBeDefined();
    });
  });

  describe('addParticipant', () => {
    it('should return existing participant if already exists', async () => {
      const existingParticipant = {
        id: 'participant-1',
        interactionId: 'test-uuid-1',
        identifierType: 'telegram_user_id',
        identifierValue: '789',
      };
      mockParticipantRepository.findOne.mockResolvedValue(existingParticipant);

      const result = await service.addParticipant('test-uuid-1', {
        role: 'initiator' as any,
        identifierType: 'telegram_user_id',
        identifierValue: '789',
      });

      expect(result).toEqual(existingParticipant);
      expect(participantRepo.create).not.toHaveBeenCalled();
    });

    it('should create new participant if not exists', async () => {
      mockParticipantRepository.findOne.mockResolvedValue(null);
      const newParticipant = {
        id: 'participant-new',
        interactionId: 'test-uuid-1',
        role: 'initiator',
        identifierType: 'telegram_user_id',
        identifierValue: '789',
      };
      mockParticipantRepository.create.mockReturnValue(newParticipant);
      mockParticipantRepository.save.mockResolvedValue(newParticipant);

      const result = await service.addParticipant('test-uuid-1', {
        role: 'initiator' as any,
        identifierType: 'telegram_user_id',
        identifierValue: '789',
      });

      expect(result).toEqual(newParticipant);
      expect(participantRepo.create).toHaveBeenCalled();
    });
  });

  describe('findOrCreateSession', () => {
    beforeEach(() => {
      mockInteractionRepository.findOne.mockReset();
      mockInteractionRepository.create.mockReset();
      mockInteractionRepository.save.mockReset();
      mockSettingsService.getSessionGapMs.mockReset();
      mockSettingsService.getSessionGapMs.mockResolvedValue(DEFAULT_SESSION_GAP_MINUTES * 60 * 1000);
    });

    it('should return existing session when no messageTime provided', async () => {
      mockInteractionRepository.findOne.mockResolvedValue(mockInteraction);

      const result = await service.findOrCreateSession('123');

      expect(result).toEqual(mockInteraction);
      expect(mockSettingsService.getSessionGapMs).not.toHaveBeenCalled();
    });

    it('should create new session when no existing session found', async () => {
      mockInteractionRepository.findOne.mockResolvedValue(null);
      const newSession = { ...mockInteraction, id: 'new-uuid' };
      mockInteractionRepository.create.mockReturnValue(newSession);
      mockInteractionRepository.save.mockResolvedValue(newSession);

      const result = await service.findOrCreateSession('123', new Date());

      expect(result).toEqual(newSession);
      expect(mockInteractionRepository.create).toHaveBeenCalled();
    });

    it('should continue existing session when gap is within threshold', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const existingSession = {
        ...mockInteraction,
        id: 'existing-session',
        updatedAt: oneHourAgo,
      };
      mockInteractionRepository.findOne.mockResolvedValue(existingSession);

      // Mock updateLastActivity
      const mockExecute = jest.fn().mockResolvedValue({});
      mockInteractionRepository.createQueryBuilder = jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: mockExecute,
      });

      const result = await service.findOrCreateSession('123', new Date());

      expect(result).toEqual(existingSession);
      expect(mockExecute).toHaveBeenCalled();
      expect(mockInteractionRepository.create).not.toHaveBeenCalled();
    });

    it('should create new session when gap exceeds threshold', async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      const existingSession = {
        ...mockInteraction,
        id: 'old-session',
        updatedAt: fiveHoursAgo,
      };
      mockInteractionRepository.findOne
        .mockResolvedValueOnce(existingSession) // findActiveSession
        .mockResolvedValueOnce(existingSession); // findOne in endSession

      const newSession = { ...mockInteraction, id: 'new-session' };
      mockInteractionRepository.create.mockReturnValue(newSession);
      mockInteractionRepository.save
        .mockResolvedValueOnce({ ...existingSession, status: InteractionStatus.COMPLETED })
        .mockResolvedValueOnce(newSession);

      const result = await service.findOrCreateSession('123', new Date());

      expect(result.id).toBe('new-session');
      expect(mockSettingsService.getSessionGapMs).toHaveBeenCalled();
    });

    it('should respect custom session gap threshold', async () => {
      // Set threshold to 30 minutes
      mockSettingsService.getSessionGapMs.mockResolvedValue(30 * 60 * 1000);

      const fortyFiveMinutesAgo = new Date(Date.now() - 45 * 60 * 1000);
      const existingSession = {
        ...mockInteraction,
        id: 'old-session',
        updatedAt: fortyFiveMinutesAgo,
      };
      mockInteractionRepository.findOne
        .mockResolvedValueOnce(existingSession)
        .mockResolvedValueOnce(existingSession);

      const newSession = { ...mockInteraction, id: 'new-session' };
      mockInteractionRepository.create.mockReturnValue(newSession);
      mockInteractionRepository.save
        .mockResolvedValueOnce({ ...existingSession, status: InteractionStatus.COMPLETED })
        .mockResolvedValueOnce(newSession);

      const result = await service.findOrCreateSession('123', new Date());

      // 45 min > 30 min threshold, should create new session
      expect(result.id).toBe('new-session');
    });

    it('should use startedAt when updatedAt is null', async () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const existingSession = {
        ...mockInteraction,
        updatedAt: null,
        startedAt: threeHoursAgo,
      };
      mockInteractionRepository.findOne.mockResolvedValue(existingSession);

      // Mock updateLastActivity
      mockInteractionRepository.createQueryBuilder = jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      });

      const result = await service.findOrCreateSession('123', new Date());

      // 3 hours < 4 hours threshold, should return existing
      expect(result).toEqual(existingSession);
    });
  });
});
