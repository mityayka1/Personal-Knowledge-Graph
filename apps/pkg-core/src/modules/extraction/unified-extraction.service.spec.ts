import { Test, TestingModule } from '@nestjs/testing';
import { UnifiedExtractionService } from './unified-extraction.service';
import { MessageData } from './extraction.types';

// Mock ClaudeAgentService to avoid ESM import issues
const mockClaudeAgentService = {
  call: jest.fn(),
};

jest.mock('../claude-agent/claude-agent.service', () => ({
  ClaudeAgentService: jest.fn().mockImplementation(() => mockClaudeAgentService),
}));

// Import after mock
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { EntityRelationService } from '../entity/entity-relation/entity-relation.service';
import { EntityService } from '../entity/entity.service';
import { PromiseRecipientService } from './promise-recipient.service';
import { ExtractionToolsProvider, EXTRACTION_MCP_NAME } from './tools/extraction-tools.provider';

describe('UnifiedExtractionService', () => {
  let service: UnifiedExtractionService;
  let entityFactService: jest.Mocked<EntityFactService>;
  let entityRelationService: jest.Mocked<EntityRelationService>;
  let promiseRecipientService: jest.Mocked<PromiseRecipientService>;
  let extractionToolsProvider: jest.Mocked<ExtractionToolsProvider>;

  const mockMcpServer = { mockServer: true };
  const mockToolNames = ['get_entity_context', 'find_entity_by_name', 'create_fact', 'create_relation', 'create_pending_entity', 'create_event'];

  const createMockMessage = (overrides: Partial<MessageData> = {}): MessageData => ({
    id: 'msg-1',
    content: 'Это достаточно длинное сообщение для обработки extraction service',
    timestamp: '2025-01-25T10:00:00.000Z',
    isOutgoing: false,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UnifiedExtractionService,
        {
          provide: ClaudeAgentService,
          useValue: mockClaudeAgentService,
        },
        {
          provide: EntityFactService,
          useValue: {
            getContextForExtraction: jest.fn().mockResolvedValue(''),
          },
        },
        {
          provide: EntityRelationService,
          useValue: {
            findByEntityWithContext: jest.fn().mockResolvedValue([]),
            formatForContext: jest.fn().mockReturnValue(''),
          },
        },
        {
          provide: EntityService,
          useValue: {
            findMe: jest.fn().mockResolvedValue({ id: 'owner-entity-1', name: 'Owner', isOwner: true }),
          },
        },
        {
          provide: PromiseRecipientService,
          useValue: {
            loadReplyToInfo: jest.fn().mockResolvedValue(new Map()),
            resolveRecipient: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ExtractionToolsProvider,
          useValue: {
            createMcpServer: jest.fn().mockReturnValue(mockMcpServer),
            getToolNames: jest.fn().mockReturnValue(mockToolNames),
          },
        },
      ],
    }).compile();

    service = module.get<UnifiedExtractionService>(UnifiedExtractionService);
    entityFactService = module.get(EntityFactService);
    entityRelationService = module.get(EntityRelationService);
    promiseRecipientService = module.get(PromiseRecipientService);
    extractionToolsProvider = module.get(ExtractionToolsProvider);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('extract', () => {
    describe('message filtering', () => {
      it('should return empty result for no messages', async () => {
        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [],
          interactionId: 'interaction-1',
        });

        expect(result).toEqual({
          factsCreated: 0,
          eventsCreated: 0,
          relationsCreated: 0,
          pendingEntities: 0,
          turns: 0,
          toolsUsed: [],
          tokensUsed: 0,
        });
        expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
      });

      it('should filter out bot messages', async () => {
        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Бот',
          messages: [
            createMockMessage({ isBotSender: true }),
          ],
          interactionId: 'interaction-1',
        });

        expect(result.factsCreated).toBe(0);
        expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
      });

      it('should filter out short messages (< 20 chars)', async () => {
        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [
            createMockMessage({ content: 'Короткое' }), // < 20 chars
          ],
          interactionId: 'interaction-1',
        });

        expect(result.factsCreated).toBe(0);
        expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
      });

      it('should process valid messages after filtering', async () => {
        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 1, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'Extracted 1 fact' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 2,
          toolsUsed: ['create_fact'],
        });

        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [
            createMockMessage({ content: 'Короткое', isBotSender: false }), // Too short
            createMockMessage({ content: 'Это валидное сообщение достаточной длины', id: 'msg-2' }), // Valid
          ],
          interactionId: 'interaction-1',
        });

        expect(mockClaudeAgentService.call).toHaveBeenCalled();
        expect(result.factsCreated).toBe(1);
      });
    });

    describe('extraction tools provider', () => {
      it('should return empty result when ExtractionToolsProvider is not available', async () => {
        // Create service with null extractionToolsProvider
        const moduleWithNullProvider = await Test.createTestingModule({
          providers: [
            UnifiedExtractionService,
            { provide: ClaudeAgentService, useValue: mockClaudeAgentService },
            { provide: EntityFactService, useValue: { getContextForExtraction: jest.fn() } },
            { provide: EntityRelationService, useValue: null },
            { provide: EntityService, useValue: { findMe: jest.fn().mockResolvedValue({ id: 'owner-1' }) } },
            { provide: PromiseRecipientService, useValue: { loadReplyToInfo: jest.fn(), resolveRecipient: jest.fn() } },
            { provide: ExtractionToolsProvider, useValue: null },
          ],
        }).compile();

        const serviceWithNullProvider = moduleWithNullProvider.get<UnifiedExtractionService>(UnifiedExtractionService);

        const result = await serviceWithNullProvider.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        expect(result.factsCreated).toBe(0);
        expect(mockClaudeAgentService.call).not.toHaveBeenCalled();
      });
    });

    describe('agent call', () => {
      it('should call agent with correct parameters', async () => {
        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 2, eventsCreated: 1, relationsCreated: 0, pendingEntities: 0, summary: 'Extracted' },
          usage: { inputTokens: 200, outputTokens: 100 },
          turns: 3,
          toolsUsed: ['create_fact', 'create_event'],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Пётр Иванов',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'agent',
            taskType: 'unified_extraction',
            model: 'haiku',
            maxTurns: 15,
            timeout: 180_000,
            referenceType: 'interaction',
            referenceId: 'interaction-1',
            customMcp: {
              name: EXTRACTION_MCP_NAME,
              server: mockMcpServer,
              toolNames: mockToolNames,
            },
            outputFormat: expect.objectContaining({
              type: 'json_schema',
              strict: true,
            }),
          }),
        );
      });

      it('should include entity context in prompt', async () => {
        entityFactService.getContextForExtraction.mockResolvedValue(
          'Должность: CTO\nКомпания: Acme Corp',
        );

        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        expect(entityFactService.getContextForExtraction).toHaveBeenCalledWith('entity-1');
        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('ПАМЯТЬ О Иван'),
          }),
        );
      });

      it('should include relations context in prompt', async () => {
        entityRelationService.findByEntityWithContext.mockResolvedValue([{ id: 'rel-1' }] as any);
        entityRelationService.formatForContext.mockReturnValue('СВЯЗИ:\n- Работает в Acme Corp');

        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        expect(entityRelationService.findByEntityWithContext).toHaveBeenCalledWith('entity-1');
        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('СВЯЗИ:'),
          }),
        );
      });

      it('should return extraction result with counts', async () => {
        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 3, eventsCreated: 2, relationsCreated: 1, pendingEntities: 1, summary: 'Extracted data' },
          usage: { inputTokens: 300, outputTokens: 150 },
          turns: 5,
          toolsUsed: ['create_fact', 'create_event', 'create_relation', 'create_pending_entity'],
        });

        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        expect(result).toEqual({
          factsCreated: 3,
          eventsCreated: 2,
          relationsCreated: 1,
          pendingEntities: 1,
          turns: 5,
          toolsUsed: ['create_fact', 'create_event', 'create_relation', 'create_pending_entity'],
          tokensUsed: 450,
        });
      });

      it('should handle missing data fields gracefully', async () => {
        mockClaudeAgentService.call.mockResolvedValue({
          data: null, // Agent returned no structured output
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        expect(result).toEqual({
          factsCreated: 0,
          eventsCreated: 0,
          relationsCreated: 0,
          pendingEntities: 0,
          turns: 1,
          toolsUsed: [],
          tokensUsed: 150,
        });
      });
    });

    describe('error handling', () => {
      it('should propagate agent errors to caller (for BullMQ retry)', async () => {
        mockClaudeAgentService.call.mockRejectedValue(new Error('Agent timeout'));

        await expect(service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        })).rejects.toThrow('Agent timeout');
      });

      it('should handle entity context retrieval error gracefully', async () => {
        entityFactService.getContextForExtraction.mockRejectedValue(new Error('Entity not found'));

        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        // Should not throw - handles error gracefully
        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        expect(result.factsCreated).toBe(0);
        expect(mockClaudeAgentService.call).toHaveBeenCalled();
      });

      it('should handle relations context retrieval error gracefully', async () => {
        entityRelationService.findByEntityWithContext.mockRejectedValue(new Error('DB error'));

        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        // Should not throw - handles error gracefully
        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        expect(result.factsCreated).toBe(0);
        expect(mockClaudeAgentService.call).toHaveBeenCalled();
      });
    });

    describe('message enrichment', () => {
      it('should enrich messages with reply-to info', async () => {
        const replyToInfoMap = new Map([
          ['msg-original', { content: 'Original message content', senderName: 'Пётр', senderEntityId: 'entity-2' }],
        ]);
        promiseRecipientService.loadReplyToInfo.mockResolvedValue(replyToInfoMap);

        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [
            createMockMessage({ replyToSourceMessageId: 'msg-original' }),
          ],
          interactionId: 'interaction-1',
        });

        expect(promiseRecipientService.loadReplyToInfo).toHaveBeenCalled();
        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('В ответ на:'),
          }),
        );
      });

      it('should resolve promise recipient for outgoing messages', async () => {
        promiseRecipientService.resolveRecipient.mockResolvedValue('entity-recipient');

        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [
            createMockMessage({ isOutgoing: true }),
          ],
          interactionId: 'interaction-1',
        });

        expect(promiseRecipientService.resolveRecipient).toHaveBeenCalledWith(
          expect.objectContaining({
            interactionId: 'interaction-1',
            isOutgoing: true,
          }),
        );
        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('promiseToEntityId: entity-recipient'),
          }),
        );
      });

      it('should use sender entity info from message when available', async () => {
        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-default',
          entityName: 'Default Name',
          messages: [
            createMockMessage({
              senderEntityId: 'entity-sender',
              senderEntityName: 'Sender Name',
            }),
          ],
          interactionId: 'interaction-1',
        });

        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('Sender Name'),
          }),
        );
        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('entity-sender'),
          }),
        );
      });

      it('should handle enrichment errors gracefully per message', async () => {
        promiseRecipientService.resolveRecipient
          .mockRejectedValueOnce(new Error('Resolve error'))
          .mockResolvedValueOnce('entity-2');

        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        // Should not throw - handles per-message errors gracefully
        const result = await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [
            createMockMessage({ id: 'msg-1' }),
            createMockMessage({ id: 'msg-2', content: 'Второе достаточно длинное сообщение' }),
          ],
          interactionId: 'interaction-1',
        });

        expect(result.factsCreated).toBe(0);
        expect(mockClaudeAgentService.call).toHaveBeenCalled();
      });
    });

    describe('prompt building', () => {
      it('should include message direction in prompt', async () => {
        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [
            createMockMessage({ isOutgoing: false }),
            createMockMessage({ id: 'msg-2', content: 'Мой ответ достаточной длины для обработки', isOutgoing: true }),
          ],
          interactionId: 'interaction-1',
        });

        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('← ВХОДЯЩЕЕ'),
          }),
        );
        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('→ ИСХОДЯЩЕЕ'),
          }),
        );
      });

      it('should include topic name when available', async () => {
        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [
            createMockMessage({ topicName: 'Проект PKG' }),
          ],
          interactionId: 'interaction-1',
        });

        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining('[Тема: Проект PKG]'),
          }),
        );
      });

      it('should include current date in prompt', async () => {
        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage()],
          interactionId: 'interaction-1',
        });

        const today = new Date().toISOString().split('T')[0];
        expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining(`Сегодняшняя дата: ${today}`),
          }),
        );
      });

      it('should truncate message content to CONTENT_LIMIT', async () => {
        const longContent = 'A'.repeat(10000); // Way over 8000 limit

        mockClaudeAgentService.call.mockResolvedValue({
          data: { factsCreated: 0, eventsCreated: 0, relationsCreated: 0, pendingEntities: 0, summary: 'No data' },
          usage: { inputTokens: 100, outputTokens: 50 },
          turns: 1,
          toolsUsed: [],
        });

        await service.extract({
          entityId: 'entity-1',
          entityName: 'Иван',
          messages: [createMockMessage({ content: longContent })],
          interactionId: 'interaction-1',
        });

        const callArgs = mockClaudeAgentService.call.mock.calls[0][0];
        // Message block should be truncated to around 8000 chars
        expect(callArgs.prompt.length).toBeLessThan(15000);
      });
    });
  });
});
