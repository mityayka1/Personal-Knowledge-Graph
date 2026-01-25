import { Test } from '@nestjs/testing';
import { CrossChatContextService } from './cross-chat-context.service';
import { MessageService } from '../interaction/message/message.service';
import { SettingsService } from '../settings/settings.service';
import { Message, InteractionType, InteractionSource, InteractionStatus } from '@pkg/entities';

describe('CrossChatContextService', () => {
  let service: CrossChatContextService;
  let messageService: jest.Mocked<MessageService>;
  let settingsService: jest.Mocked<SettingsService>;

  const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

  beforeEach(async () => {
    const mockMessageService = {
      findByEntitiesInTimeWindow: jest.fn(),
    };

    const mockSettingsService = {
      getCrossChatContextMs: jest.fn().mockResolvedValue(DEFAULT_WINDOW_MS),
    };

    const module = await Test.createTestingModule({
      providers: [
        CrossChatContextService,
        { provide: MessageService, useValue: mockMessageService },
        { provide: SettingsService, useValue: mockSettingsService },
      ],
    }).compile();

    service = module.get(CrossChatContextService);
    messageService = module.get(MessageService);
    settingsService = module.get(SettingsService);
  });

  /** Helper to create Message with minimal required fields */
  function createMessage(
    id: string,
    content: string,
    timestamp: Date,
    options?: {
      isOutgoing?: boolean;
      interactionMetadata?: Record<string, unknown>;
    },
  ): Message {
    const message = new Message();
    message.id = id;
    message.content = content;
    message.timestamp = timestamp;
    message.isOutgoing = options?.isOutgoing ?? false;

    if (options?.interactionMetadata) {
      message.interaction = {
        id: 'interaction-1',
        type: InteractionType.TELEGRAM_SESSION,
        source: InteractionSource.TELEGRAM,
        status: InteractionStatus.ACTIVE,
        startedAt: timestamp,
        endedAt: null,
        sourceMetadata: options.interactionMetadata,
        participants: [],
        messages: [],
        transcriptSegments: [],
        summary: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    }

    return message;
  }

  describe('getContext', () => {
    const referenceTime = new Date('2025-01-25T15:00:00.000Z');
    const interactionId = 'current-interaction-id';
    const entityIds = ['entity-1', 'entity-2'];

    it('should return null for empty entityIds', async () => {
      const result = await service.getContext(interactionId, [], referenceTime);

      expect(result).toBeNull();
      expect(messageService.findByEntitiesInTimeWindow).not.toHaveBeenCalled();
    });

    it('should return null when no messages found', async () => {
      messageService.findByEntitiesInTimeWindow.mockResolvedValue([]);

      const result = await service.getContext(interactionId, entityIds, referenceTime);

      expect(result).toBeNull();
      expect(messageService.findByEntitiesInTimeWindow).toHaveBeenCalledWith({
        entityIds,
        from: new Date(referenceTime.getTime() - DEFAULT_WINDOW_MS),
        to: referenceTime,
        excludeInteractionId: interactionId,
        limit: 20,
      });
    });

    it('should format messages with timestamps and chat info', async () => {
      const messages = [
        createMessage('1', 'Привет!', new Date('2025-01-25T14:50:00.000Z'), {
          isOutgoing: false,
          interactionMetadata: { telegram_chat_id: '123456789', chat_type: 'private' },
        }),
        createMessage('2', 'Как дела?', new Date('2025-01-25T14:55:00.000Z'), {
          isOutgoing: true,
          interactionMetadata: { telegram_chat_id: '123456789', chat_type: 'private' },
        }),
      ];
      messageService.findByEntitiesInTimeWindow.mockResolvedValue(messages);

      const result = await service.getContext(interactionId, entityIds, referenceTime);

      expect(result).not.toBeNull();
      expect(result).toContain('Собеседник: Привет!');
      expect(result).toContain('Я: Как дела?');
      expect(result).toContain('Личный чат');
      // Should have timestamps in HH:MM format
      expect(result).toMatch(/\[\d{2}:\d{2}\]/);
    });

    it('should sort messages chronologically', async () => {
      // Pass messages in reverse order to verify sorting
      const messages = [
        createMessage('2', 'Second', new Date('2025-01-25T14:55:00.000Z')),
        createMessage('1', 'First', new Date('2025-01-25T14:50:00.000Z')),
      ];
      messageService.findByEntitiesInTimeWindow.mockResolvedValue(messages);

      const result = await service.getContext(interactionId, entityIds, referenceTime);

      expect(result).not.toBeNull();
      const lines = result!.split('\n');
      expect(lines[0]).toContain('First');
      expect(lines[1]).toContain('Second');
    });

    it('should truncate long messages', async () => {
      const longContent = 'A'.repeat(300);
      const messages = [
        createMessage('1', longContent, new Date('2025-01-25T14:50:00.000Z')),
      ];
      messageService.findByEntitiesInTimeWindow.mockResolvedValue(messages);

      const result = await service.getContext(interactionId, entityIds, referenceTime);

      expect(result).not.toBeNull();
      expect(result!.length).toBeLessThan(longContent.length + 50); // Some overhead for formatting
      expect(result).toContain('...');
    });

    it('should use custom window from settings', async () => {
      const customWindowMs = 60 * 60 * 1000; // 60 minutes
      settingsService.getCrossChatContextMs.mockResolvedValue(customWindowMs);
      messageService.findByEntitiesInTimeWindow.mockResolvedValue([]);

      await service.getContext(interactionId, entityIds, referenceTime);

      expect(messageService.findByEntitiesInTimeWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          from: new Date(referenceTime.getTime() - customWindowMs),
        }),
      );
    });

    it('should handle messages without interaction metadata', async () => {
      const messages = [
        createMessage('1', 'Test message', new Date('2025-01-25T14:50:00.000Z')),
      ];
      messageService.findByEntitiesInTimeWindow.mockResolvedValue(messages);

      const result = await service.getContext(interactionId, entityIds, referenceTime);

      expect(result).not.toBeNull();
      expect(result).toContain('Чат');
      expect(result).toContain('Test message');
    });

    it('should show partial chat ID for group chats', async () => {
      const messages = [
        createMessage('1', 'Group message', new Date('2025-01-25T14:50:00.000Z'), {
          interactionMetadata: { telegram_chat_id: '-1001234567890', chat_type: 'supergroup' },
        }),
      ];
      messageService.findByEntitiesInTimeWindow.mockResolvedValue(messages);

      const result = await service.getContext(interactionId, entityIds, referenceTime);

      expect(result).not.toBeNull();
      // Should show last 4 digits of chat ID
      expect(result).toContain('Чат 7890');
    });

    it('should handle null content gracefully', async () => {
      const message = createMessage('1', '', new Date('2025-01-25T14:50:00.000Z'));
      message.content = null;
      messageService.findByEntitiesInTimeWindow.mockResolvedValue([message]);

      const result = await service.getContext(interactionId, entityIds, referenceTime);

      expect(result).not.toBeNull();
      // Should not throw, content should be empty string
    });
  });
});
