import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, Interaction } from '@pkg/entities';
import { PromiseRecipientService } from './promise-recipient.service';

describe('PromiseRecipientService', () => {
  let service: PromiseRecipientService;
  let messageRepo: jest.Mocked<Repository<Message>>;
  let interactionRepo: jest.Mocked<Repository<Interaction>>;

  const mockPrivateInteraction: Partial<Interaction> = {
    id: 'interaction-private',
    sourceMetadata: { chat_type: 'private' },
  };

  const mockGroupInteraction: Partial<Interaction> = {
    id: 'interaction-group',
    sourceMetadata: { chat_type: 'group' },
  };

  const mockSupergroupInteraction: Partial<Interaction> = {
    id: 'interaction-supergroup',
    sourceMetadata: { chat_type: 'supergroup' },
  };

  const mockInteractionNoMetadata: Partial<Interaction> = {
    id: 'interaction-no-metadata',
    sourceMetadata: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromiseRecipientService,
        {
          provide: getRepositoryToken(Message),
          useValue: {
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Interaction),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PromiseRecipientService>(PromiseRecipientService);
    messageRepo = module.get(getRepositoryToken(Message));
    interactionRepo = module.get(getRepositoryToken(Interaction));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('resolveRecipient', () => {
    describe('incoming messages', () => {
      it('should return undefined for incoming message in private chat', async () => {
        interactionRepo.findOne.mockResolvedValue(mockPrivateInteraction as Interaction);

        const result = await service.resolveRecipient({
          interactionId: 'interaction-private',
          entityId: 'entity-123',
          isOutgoing: false,
          replyToSenderEntityId: undefined,
        });

        expect(result).toBeUndefined();
        // Should NOT check chat type for incoming messages
        expect(interactionRepo.findOne).not.toHaveBeenCalled();
      });

      it('should return undefined for incoming message in group chat', async () => {
        const result = await service.resolveRecipient({
          interactionId: 'interaction-group',
          entityId: 'entity-123',
          isOutgoing: false,
          replyToSenderEntityId: 'reply-sender-456',
        });

        expect(result).toBeUndefined();
      });
    });

    describe('outgoing messages in private chat', () => {
      it('should return entityId for outgoing message in private chat', async () => {
        interactionRepo.findOne.mockResolvedValue(mockPrivateInteraction as Interaction);

        const result = await service.resolveRecipient({
          interactionId: 'interaction-private',
          entityId: 'entity-contact-123',
          isOutgoing: true,
          replyToSenderEntityId: undefined,
        });

        // In private chat, recipient is the contact (entityId)
        expect(result).toBe('entity-contact-123');
      });

      it('should return entityId even if replyToSenderEntityId is provided', async () => {
        interactionRepo.findOne.mockResolvedValue(mockPrivateInteraction as Interaction);

        const result = await service.resolveRecipient({
          interactionId: 'interaction-private',
          entityId: 'entity-contact-123',
          isOutgoing: true,
          replyToSenderEntityId: 'some-other-entity', // ignored in private chats
        });

        expect(result).toBe('entity-contact-123');
      });
    });

    describe('outgoing messages in group chat', () => {
      it('should return replyToSenderEntityId when replying to someone', async () => {
        interactionRepo.findOne.mockResolvedValue(mockGroupInteraction as Interaction);

        const result = await service.resolveRecipient({
          interactionId: 'interaction-group',
          entityId: 'entity-from-group',
          isOutgoing: true,
          replyToSenderEntityId: 'reply-to-person-789',
        });

        expect(result).toBe('reply-to-person-789');
      });

      it('should return undefined when NOT replying to anyone in group chat', async () => {
        interactionRepo.findOne.mockResolvedValue(mockGroupInteraction as Interaction);

        const result = await service.resolveRecipient({
          interactionId: 'interaction-group',
          entityId: 'entity-from-group',
          isOutgoing: true,
          replyToSenderEntityId: undefined,
        });

        expect(result).toBeUndefined();
      });

      it('should return undefined for supergroup without reply', async () => {
        interactionRepo.findOne.mockResolvedValue(mockSupergroupInteraction as Interaction);

        const result = await service.resolveRecipient({
          interactionId: 'interaction-supergroup',
          entityId: 'entity-456',
          isOutgoing: true,
          replyToSenderEntityId: undefined,
        });

        expect(result).toBeUndefined();
      });
    });

    describe('edge cases', () => {
      it('should return undefined when interaction not found', async () => {
        interactionRepo.findOne.mockResolvedValue(null);

        const result = await service.resolveRecipient({
          interactionId: 'non-existent-interaction',
          entityId: 'entity-123',
          isOutgoing: true,
          replyToSenderEntityId: undefined,
        });

        expect(result).toBeUndefined();
      });

      it('should return undefined when interaction has no sourceMetadata', async () => {
        interactionRepo.findOne.mockResolvedValue(mockInteractionNoMetadata as Interaction);

        const result = await service.resolveRecipient({
          interactionId: 'interaction-no-metadata',
          entityId: 'entity-123',
          isOutgoing: true,
          replyToSenderEntityId: undefined,
        });

        expect(result).toBeUndefined();
      });
    });
  });

  describe('isPrivateChat', () => {
    it('should return true for private chat', async () => {
      interactionRepo.findOne.mockResolvedValue(mockPrivateInteraction as Interaction);

      const result = await service.isPrivateChat('interaction-private');

      expect(result).toBe(true);
    });

    it('should return false for group chat', async () => {
      interactionRepo.findOne.mockResolvedValue(mockGroupInteraction as Interaction);

      const result = await service.isPrivateChat('interaction-group');

      expect(result).toBe(false);
    });

    it('should return false for supergroup chat', async () => {
      interactionRepo.findOne.mockResolvedValue(mockSupergroupInteraction as Interaction);

      const result = await service.isPrivateChat('interaction-supergroup');

      expect(result).toBe(false);
    });

    it('should return false when interaction not found', async () => {
      interactionRepo.findOne.mockResolvedValue(null);

      const result = await service.isPrivateChat('non-existent');

      expect(result).toBe(false);
    });

    it('should return false when sourceMetadata is null', async () => {
      interactionRepo.findOne.mockResolvedValue(mockInteractionNoMetadata as Interaction);

      const result = await service.isPrivateChat('interaction-no-metadata');

      expect(result).toBe(false);
    });
  });

  describe('loadReplyToInfo', () => {
    it('should return empty map when no messages have replyToSourceMessageId', async () => {
      const messages = [
        { replyToSourceMessageId: undefined },
        { replyToSourceMessageId: undefined },
      ];

      const result = await service.loadReplyToInfo(messages, 'interaction-123');

      expect(result.size).toBe(0);
      // Should NOT call query builder
      expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should load reply-to message info for messages with replyToSourceMessageId', async () => {
      const messages = [
        { replyToSourceMessageId: 'src-msg-100' },
        { replyToSourceMessageId: 'src-msg-200' },
        { replyToSourceMessageId: undefined },
      ];

      const mockMessages: Partial<Message>[] = [
        {
          sourceMessageId: 'src-msg-100',
          content: 'Original message content 1',
          senderEntityId: 'sender-entity-1',
          senderEntity: { name: 'Alice' } as any,
        },
        {
          sourceMessageId: 'src-msg-200',
          content: 'Original message content 2',
          senderEntityId: 'sender-entity-2',
          senderEntity: { name: 'Bob' } as any,
        },
      ];

      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockMessages),
      };
      messageRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const result = await service.loadReplyToInfo(messages, 'interaction-123');

      expect(result.size).toBe(2);

      expect(result.get('src-msg-100')).toEqual({
        content: 'Original message content 1',
        senderEntityId: 'sender-entity-1',
        senderName: 'Alice',
      });

      expect(result.get('src-msg-200')).toEqual({
        content: 'Original message content 2',
        senderEntityId: 'sender-entity-2',
        senderName: 'Bob',
      });
    });

    it('should handle messages without senderEntity', async () => {
      const messages = [{ replyToSourceMessageId: 'src-msg-300' }];

      const mockMessages: Partial<Message>[] = [
        {
          sourceMessageId: 'src-msg-300',
          content: 'Message without sender entity',
          senderEntityId: 'sender-entity-3',
          senderEntity: null as any,
        },
      ];

      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockMessages),
      };
      messageRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const result = await service.loadReplyToInfo(messages, 'interaction-123');

      expect(result.size).toBe(1);
      expect(result.get('src-msg-300')).toEqual({
        content: 'Message without sender entity',
        senderEntityId: 'sender-entity-3',
        senderName: undefined,
      });
    });

    it('should handle messages with null content', async () => {
      const messages = [{ replyToSourceMessageId: 'src-msg-400' }];

      const mockMessages: Partial<Message>[] = [
        {
          sourceMessageId: 'src-msg-400',
          content: null,
          senderEntityId: null,
          senderEntity: null as any,
        },
      ];

      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockMessages),
      };
      messageRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const result = await service.loadReplyToInfo(messages, 'interaction-123');

      expect(result.size).toBe(1);
      expect(result.get('src-msg-400')).toEqual({
        content: undefined,
        senderEntityId: undefined,
        senderName: undefined,
      });
    });

    it('should filter by interactionId', async () => {
      const messages = [{ replyToSourceMessageId: 'src-msg-500' }];

      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      messageRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      await service.loadReplyToInfo(messages, 'specific-interaction-id');

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'm.interactionId = :interactionId',
        { interactionId: 'specific-interaction-id' },
      );
    });
  });
});
