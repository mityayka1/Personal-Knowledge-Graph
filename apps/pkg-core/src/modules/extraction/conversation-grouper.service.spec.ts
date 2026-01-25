import { Test } from '@nestjs/testing';
import { ConversationGrouperService } from './conversation-grouper.service';
import { SettingsService } from '../settings/settings.service';
import { MessageData } from './extraction.types';

describe('ConversationGrouperService', () => {
  let service: ConversationGrouperService;
  let settingsService: jest.Mocked<SettingsService>;

  const DEFAULT_GAP_MS = 30 * 60 * 1000; // 30 minutes in ms

  beforeEach(async () => {
    const mockSettingsService = {
      getConversationGapMs: jest.fn().mockResolvedValue(DEFAULT_GAP_MS),
    };

    const module = await Test.createTestingModule({
      providers: [
        ConversationGrouperService,
        { provide: SettingsService, useValue: mockSettingsService },
      ],
    }).compile();

    service = module.get(ConversationGrouperService);
    settingsService = module.get(SettingsService);
  });

  /** Helper to create MessageData with timestamp */
  function createMessage(
    id: string,
    timestamp: string,
    options?: Partial<MessageData>,
  ): MessageData {
    return {
      id,
      content: `Message ${id}`,
      timestamp,
      isOutgoing: false,
      ...options,
    };
  }

  describe('groupMessages', () => {
    it('should return empty array for empty input', async () => {
      const result = await service.groupMessages([]);
      expect(result).toEqual([]);
    });

    it('should create single group for one message', async () => {
      const messages = [createMessage('1', '2025-01-25T14:00:00.000Z')];

      const result = await service.groupMessages(messages);

      expect(result).toHaveLength(1);
      expect(result[0].messages).toHaveLength(1);
      expect(result[0].messages[0].id).toBe('1');
    });

    it('should group messages within gap threshold into single conversation', async () => {
      const messages = [
        createMessage('1', '2025-01-25T14:00:00.000Z'),
        createMessage('2', '2025-01-25T14:05:00.000Z'), // +5 min
        createMessage('3', '2025-01-25T14:10:00.000Z'), // +5 min
      ];

      const result = await service.groupMessages(messages);

      expect(result).toHaveLength(1);
      expect(result[0].messages).toHaveLength(3);
      expect(result[0].messages.map((m) => m.id)).toEqual(['1', '2', '3']);
    });

    it('should split messages into separate conversations when gap exceeds threshold', async () => {
      const messages = [
        createMessage('1', '2025-01-25T14:00:00.000Z'),
        createMessage('2', '2025-01-25T14:05:00.000Z'), // +5 min
        createMessage('3', '2025-01-25T15:00:00.000Z'), // +55 min (exceeds 30 min)
        createMessage('4', '2025-01-25T15:05:00.000Z'), // +5 min
      ];

      const result = await service.groupMessages(messages);

      expect(result).toHaveLength(2);
      expect(result[0].messages.map((m) => m.id)).toEqual(['1', '2']);
      expect(result[1].messages.map((m) => m.id)).toEqual(['3', '4']);
    });

    it('should handle messages at exact gap boundary', async () => {
      const messages = [
        createMessage('1', '2025-01-25T14:00:00.000Z'),
        createMessage('2', '2025-01-25T14:30:00.000Z'), // exactly 30 min
      ];

      const result = await service.groupMessages(messages);

      // At exactly 30 min, it's NOT > 30 min, so should be same group
      expect(result).toHaveLength(1);
      expect(result[0].messages).toHaveLength(2);
    });

    it('should handle messages at 1ms over gap boundary', async () => {
      const messages = [
        createMessage('1', '2025-01-25T14:00:00.000Z'),
        createMessage('2', '2025-01-25T14:30:00.001Z'), // 30 min + 1 ms
      ];

      const result = await service.groupMessages(messages);

      // At 30 min + 1 ms, it IS > 30 min, so should be separate groups
      expect(result).toHaveLength(2);
    });

    it('should sort unsorted messages by timestamp', async () => {
      const messages = [
        createMessage('3', '2025-01-25T15:00:00.000Z'),
        createMessage('1', '2025-01-25T14:00:00.000Z'),
        createMessage('2', '2025-01-25T14:30:00.000Z'),
      ];

      const result = await service.groupMessages(messages);

      // Should be sorted and all in one group (gaps are under 30 min)
      expect(result).toHaveLength(1);
      expect(result[0].messages.map((m) => m.id)).toEqual(['1', '2', '3']);
    });

    it('should create multiple conversations correctly', async () => {
      const messages = [
        createMessage('1', '2025-01-25T10:00:00.000Z'),
        createMessage('2', '2025-01-25T10:05:00.000Z'),
        // 2 hour gap
        createMessage('3', '2025-01-25T12:00:00.000Z'),
        createMessage('4', '2025-01-25T12:10:00.000Z'),
        // 3 hour gap
        createMessage('5', '2025-01-25T15:00:00.000Z'),
      ];

      const result = await service.groupMessages(messages);

      expect(result).toHaveLength(3);
      expect(result[0].messages.map((m) => m.id)).toEqual(['1', '2']);
      expect(result[1].messages.map((m) => m.id)).toEqual(['3', '4']);
      expect(result[2].messages.map((m) => m.id)).toEqual(['5']);
    });

    it('should use custom gap from settings', async () => {
      // Set a 10 minute gap
      settingsService.getConversationGapMs.mockResolvedValue(10 * 60 * 1000);

      const messages = [
        createMessage('1', '2025-01-25T14:00:00.000Z'),
        createMessage('2', '2025-01-25T14:05:00.000Z'), // +5 min (same group)
        createMessage('3', '2025-01-25T14:20:00.000Z'), // +15 min (new group)
      ];

      const result = await service.groupMessages(messages);

      expect(result).toHaveLength(2);
      expect(result[0].messages).toHaveLength(2);
      expect(result[1].messages).toHaveLength(1);
    });

    it('should set startedAt and endedAt correctly', async () => {
      const messages = [
        createMessage('1', '2025-01-25T14:00:00.000Z'),
        createMessage('2', '2025-01-25T14:05:00.000Z'),
        createMessage('3', '2025-01-25T14:10:00.000Z'),
      ];

      const result = await service.groupMessages(messages);

      expect(result[0].startedAt).toEqual(new Date('2025-01-25T14:00:00.000Z'));
      expect(result[0].endedAt).toEqual(new Date('2025-01-25T14:10:00.000Z'));
    });

    it('should collect participant entity IDs', async () => {
      const messages = [
        createMessage('1', '2025-01-25T14:00:00.000Z', {
          senderEntityId: 'entity-1',
        }),
        createMessage('2', '2025-01-25T14:05:00.000Z', {
          senderEntityId: 'entity-2',
        }),
        createMessage('3', '2025-01-25T14:10:00.000Z', {
          senderEntityId: 'entity-1', // duplicate
        }),
      ];

      const result = await service.groupMessages(messages);

      expect(result[0].participantEntityIds).toHaveLength(2);
      expect(result[0].participantEntityIds).toContain('entity-1');
      expect(result[0].participantEntityIds).toContain('entity-2');
    });

    it('should handle messages without senderEntityId', async () => {
      const messages = [
        createMessage('1', '2025-01-25T14:00:00.000Z', {
          senderEntityId: 'entity-1',
        }),
        createMessage('2', '2025-01-25T14:05:00.000Z'), // no senderEntityId
      ];

      const result = await service.groupMessages(messages);

      expect(result[0].participantEntityIds).toHaveLength(1);
      expect(result[0].participantEntityIds).toContain('entity-1');
    });
  });

  describe('formatConversationForPrompt', () => {
    it('should format conversation with timestamps', () => {
      const conversation = {
        messages: [
          createMessage('1', '2025-01-25T14:00:00.000Z', {
            isOutgoing: true,
            content: 'Привет!',
          }),
          createMessage('2', '2025-01-25T14:05:00.000Z', {
            isOutgoing: false,
            senderEntityName: 'Иван',
            content: 'Привет, как дела?',
          }),
        ],
        startedAt: new Date('2025-01-25T14:00:00.000Z'),
        endedAt: new Date('2025-01-25T14:05:00.000Z'),
        participantEntityIds: ['entity-1'],
      };

      const result = service.formatConversationForPrompt(conversation);

      expect(result).toContain('Я: Привет!');
      expect(result).toContain('Иван: Привет, как дела?');
      // Should include timestamps
      expect(result).toMatch(/\[\d{2}:\d{2}\]/);
    });

    it('should format without timestamps when disabled', () => {
      const conversation = {
        messages: [
          createMessage('1', '2025-01-25T14:00:00.000Z', {
            isOutgoing: true,
            content: 'Test',
          }),
        ],
        startedAt: new Date('2025-01-25T14:00:00.000Z'),
        endedAt: new Date('2025-01-25T14:00:00.000Z'),
        participantEntityIds: [],
      };

      const result = service.formatConversationForPrompt(conversation, {
        includeTimestamps: false,
      });

      expect(result).not.toMatch(/\[\d{2}:\d{2}\]/);
      expect(result).toBe('Я: Test');
    });

    it('should use "Собеседник" for unknown sender', () => {
      const conversation = {
        messages: [
          createMessage('1', '2025-01-25T14:00:00.000Z', {
            isOutgoing: false,
            content: 'Hello',
          }),
        ],
        startedAt: new Date('2025-01-25T14:00:00.000Z'),
        endedAt: new Date('2025-01-25T14:00:00.000Z'),
        participantEntityIds: [],
      };

      const result = service.formatConversationForPrompt(conversation, {
        includeTimestamps: false,
      });

      expect(result).toContain('Собеседник: Hello');
    });

    it('should truncate when exceeding maxLength', () => {
      const conversation = {
        messages: [
          createMessage('1', '2025-01-25T14:00:00.000Z', {
            content: 'A'.repeat(100),
          }),
          createMessage('2', '2025-01-25T14:01:00.000Z', {
            content: 'B'.repeat(100),
          }),
          createMessage('3', '2025-01-25T14:02:00.000Z', {
            content: 'C'.repeat(100),
          }),
        ],
        startedAt: new Date('2025-01-25T14:00:00.000Z'),
        endedAt: new Date('2025-01-25T14:02:00.000Z'),
        participantEntityIds: [],
      };

      const result = service.formatConversationForPrompt(conversation, {
        maxLength: 150,
        includeTimestamps: false,
      });

      expect(result).toContain('сокращены');
      expect(result.length).toBeLessThan(300);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const groups = [
        {
          messages: [
            createMessage('1', '2025-01-25T14:00:00.000Z'),
            createMessage('2', '2025-01-25T14:05:00.000Z'),
            createMessage('3', '2025-01-25T14:10:00.000Z'),
          ],
          startedAt: new Date(),
          endedAt: new Date(),
          participantEntityIds: [],
        },
        {
          messages: [createMessage('4', '2025-01-25T15:00:00.000Z')],
          startedAt: new Date(),
          endedAt: new Date(),
          participantEntityIds: [],
        },
      ];

      const stats = service.getStats(groups);

      expect(stats.totalMessages).toBe(4);
      expect(stats.conversationCount).toBe(2);
      expect(stats.avgMessagesPerConversation).toBe(2);
      expect(stats.longestConversation).toBe(3);
    });

    it('should handle empty groups array', () => {
      const stats = service.getStats([]);

      expect(stats.totalMessages).toBe(0);
      expect(stats.conversationCount).toBe(0);
      expect(stats.avgMessagesPerConversation).toBe(0);
      expect(stats.longestConversation).toBe(0);
    });
  });
});
