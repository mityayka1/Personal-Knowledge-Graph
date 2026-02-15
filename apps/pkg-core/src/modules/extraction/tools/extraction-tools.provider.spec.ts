import { PendingApprovalItemType } from '@pkg/entities';
import { ExtractionToolsProvider, EXTRACTION_MCP_NAME } from './extraction-tools.provider';

describe('ExtractionToolsProvider', () => {
  let provider: ExtractionToolsProvider;

  // Create minimal mocks for all dependencies
  const mockEntityFactService = {
    getContextForExtraction: jest.fn().mockResolvedValue('ПАМЯТЬ О John:\n• position: Developer'),
    createWithDedup: jest.fn().mockResolvedValue({
      fact: { id: 'fact-uuid-1' },
      action: 'created',
      reason: 'New fact',
      existingFactId: null,
    }),
    findByEntityWithRanking: jest.fn().mockResolvedValue([]),
    findHistory: jest.fn().mockResolvedValue([]),
  };

  const mockEntityService = {
    findAll: jest.fn().mockResolvedValue({
      items: [{ id: 'entity-1', name: 'John', type: 'person', organization: null, identifiers: [] }],
      total: 1,
    }),
    findById: jest.fn().mockResolvedValue({ id: 'entity-1', name: 'John' }),
    create: jest.fn().mockResolvedValue({ id: 'new-entity-uuid', name: 'Created Entity' }),
  };

  const mockEntityRelationService = {
    create: jest.fn().mockResolvedValue({
      id: 'relation-uuid-1',
      relationType: 'employment',
      members: [{}, {}],
    }),
    findByEntity: jest.fn().mockResolvedValue([]),
  };

  const mockPendingResolutionService = {
    findOrCreate: jest.fn().mockResolvedValue({
      id: 'pending-uuid-1',
      status: 'pending',
    }),
    linkToEntity: jest.fn().mockResolvedValue(undefined),
  };

  const mockExtractedEventRepo = {
    create: jest.fn().mockReturnValue({ id: 'event-uuid-1' }),
    save: jest.fn().mockResolvedValue({ id: 'event-uuid-1' }),
  };

  const mockEnrichmentQueueService = {
    queueForEnrichment: jest.fn().mockResolvedValue(undefined),
  };

  const mockDraftExtractionService = {
    createDrafts: jest.fn().mockResolvedValue({
      batchId: 'batch-uuid-1',
      counts: { facts: 1, tasks: 0, commitments: 0, projects: 0 },
      skipped: { facts: 0, tasks: 0, commitments: 0, projects: 0 },
      errors: [],
      approvals: [{ id: 'approval-uuid-1', itemType: PendingApprovalItemType.FACT }],
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Directly instantiate the provider with mocked dependencies
    // This bypasses NestJS DI issues with @Optional + forwardRef
    provider = new ExtractionToolsProvider(
      mockEntityFactService as any,
      mockEntityService as any,
      mockEntityRelationService as any,
      mockPendingResolutionService as any,
      mockExtractedEventRepo as any,
      mockEnrichmentQueueService as any,
      mockDraftExtractionService as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      { findCandidates: jest.fn().mockResolvedValue([]) } as any,
      null, // EntityDisambiguationService (optional)
    );
  });

  describe('getTools', () => {
    const testContext = { messageId: 'msg-123', interactionId: 'interaction-456', ownerEntityId: 'owner-uuid' };

    it('should return array of 6 tools', () => {
      const tools = provider.getTools(testContext);

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(7);
    });

    it('should create new tools for each context (no singleton caching)', () => {
      const tools1 = provider.getTools(testContext);
      const tools2 = provider.getTools(testContext);

      // Tools are created fresh per context to avoid race conditions
      expect(tools1).not.toBe(tools2);
    });

    it('should return tools with name property', () => {
      const tools = provider.getTools(testContext);

      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
      }
    });

    it('should work with empty context', () => {
      const tools = provider.getTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(7);
    });
  });

  describe('getToolNames', () => {
    it('should return MCP-formatted tool names', () => {
      const toolNames = provider.getToolNames();

      expect(toolNames.length).toBe(7);
      toolNames.forEach((name) => {
        expect(name).toMatch(new RegExp(`^mcp__${EXTRACTION_MCP_NAME}__`));
      });
    });
  });

  describe('createMcpServer', () => {
    it('should create MCP server with tools', () => {
      const server = provider.createMcpServer({ messageId: 'msg-123', interactionId: 'interaction-456', ownerEntityId: 'owner-uuid' });

      expect(server).toBeDefined();
    });
  });

  describe('hasRequiredServices', () => {
    it('should return true when required services are available', () => {
      expect(provider.hasRequiredServices()).toBe(true);
    });
  });

  describe('tool structure', () => {
    it('each tool should have description defined', () => {
      const tools = provider.getTools({ messageId: 'msg-123', interactionId: 'interaction-456', ownerEntityId: 'owner-uuid' });

      for (const tool of tools) {
        expect(tool.description).toBeDefined();
      }
    });
  });

  describe('create_pending_entity - telegram_username prevention', () => {
    const testContext = { messageId: 'msg-123', interactionId: 'interaction-456', ownerEntityId: 'owner-uuid' };

    it('should return existing entity when telegram_username matches suggestedName', async () => {
      const tools = provider.getTools(testContext);
      const createPendingTool = tools.find((t) => t.name === 'create_pending_entity');
      expect(createPendingTool).toBeDefined();

      // Entity "Александра" has telegram_username "vasunya91"
      mockEntityService.findAll.mockResolvedValueOnce({
        items: [{
          id: 'aleksandra-uuid',
          name: 'Александра',
          type: 'person',
          organization: null,
          identifiers: [
            { identifierType: 'telegram_username', identifierValue: 'vasunya91' },
            { identifierType: 'telegram_user_id', identifierValue: '903703857' },
          ],
        }],
        total: 1,
      });

      const result = await (createPendingTool as any).handler({
        suggestedName: 'vasunya91',
        mentionedAs: 'упомянут в чате',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('already_exists');
      expect(data.entityId).toBe('aleksandra-uuid');
      expect(data.suggestedName).toBe('Александра');

      // Should NOT create new entity or pending resolution
      expect(mockEntityService.create).not.toHaveBeenCalled();
      expect(mockPendingResolutionService.findOrCreate).not.toHaveBeenCalled();
    });

    it('should handle @-prefixed username', async () => {
      const tools = provider.getTools(testContext);
      const createPendingTool = tools.find((t) => t.name === 'create_pending_entity');

      mockEntityService.findAll.mockResolvedValueOnce({
        items: [{
          id: 'user-uuid',
          name: 'Иван',
          type: 'person',
          organization: null,
          identifiers: [
            { identifierType: 'telegram_username', identifierValue: 'ivan_dev' },
          ],
        }],
        total: 1,
      });

      const result = await (createPendingTool as any).handler({
        suggestedName: '@ivan_dev',
        mentionedAs: 'разработчик',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('already_exists');
      expect(data.entityId).toBe('user-uuid');
    });

    it('should create new entity when no telegram_username match', async () => {
      const tools = provider.getTools(testContext);
      const createPendingTool = tools.find((t) => t.name === 'create_pending_entity');

      // No matching identifier
      mockEntityService.findAll.mockResolvedValueOnce({
        items: [{ id: 'other-uuid', name: 'Маша', type: 'person', organization: null, identifiers: [] }],
        total: 1,
      });

      mockEntityService.create.mockResolvedValueOnce({ id: 'new-entity-uuid', name: 'Катя' });

      const result = await (createPendingTool as any).handler({
        suggestedName: 'Катя',
        mentionedAs: 'подруга',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.entityId).toBe('new-entity-uuid');
      expect(data.status).not.toBe('already_exists');

      expect(mockEntityService.create).toHaveBeenCalled();
      expect(mockPendingResolutionService.findOrCreate).toHaveBeenCalled();
    });

    it('should be case-insensitive when matching username', async () => {
      const tools = provider.getTools(testContext);
      const createPendingTool = tools.find((t) => t.name === 'create_pending_entity');

      mockEntityService.findAll.mockResolvedValueOnce({
        items: [{
          id: 'user-uuid',
          name: 'Олег',
          type: 'person',
          organization: null,
          identifiers: [
            { identifierType: 'telegram_username', identifierValue: 'OlegDev' },
          ],
        }],
        total: 1,
      });

      const result = await (createPendingTool as any).handler({
        suggestedName: 'olegdev',
        mentionedAs: 'коллега',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('already_exists');
      expect(data.entityId).toBe('user-uuid');
    });
  });

  describe('cross-entity routing', () => {
    const testContext = { messageId: 'msg-123', interactionId: 'interaction-456', ownerEntityId: 'owner-uuid' };

    /**
     * Cross-entity routing allows facts to be created for ANY entity, not just the "current" contact.
     * Example: "Маша перешла в Сбер" → create fact for Маша's entity, not current chat contact.
     */

    it('create_fact should route to specified entityId via DraftExtractionService', async () => {
      const tools = provider.getTools(testContext);
      const createFactTool = tools.find((t) => t.name === 'create_fact');
      expect(createFactTool).toBeDefined();

      // Target entity is different from chat contact - this is the cross-entity routing
      const targetEntityId = 'different-entity-uuid';

      // Invoke the tool handler with explicit entityId
      const result = await (createFactTool as any).handler({
        entityId: targetEntityId,
        factType: 'company',
        value: 'Сбер',
        confidence: 0.9,
        sourceQuote: 'Маша перешла в Сбер',
      });

      // Verify fact was created through DraftExtractionService
      expect(mockDraftExtractionService.createDrafts).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerEntityId: testContext.ownerEntityId,
          facts: [
            expect.objectContaining({
              entityId: targetEntityId,
              factType: 'company',
              value: 'Сбер',
            }),
          ],
        }),
      );

      expect(result.isError).toBeFalsy();
    });

    it('find_entity_by_name should enable discovery for routing', async () => {
      const tools = provider.getTools(testContext);
      const findTool = tools.find((t) => t.name === 'find_entity_by_name');
      expect(findTool).toBeDefined();

      // Mock returns entity that LLM can route facts to
      mockEntityService.findAll.mockResolvedValueOnce({
        items: [
          { id: 'masha-entity-uuid', name: 'Маша', type: 'person', organization: null },
        ],
        total: 1,
      });

      // LLM uses this tool to find the entity to route the fact to
      const result = await (findTool as any).handler({
        name: 'Маша',
        limit: 5,
      });

      // Tool returns entity ID that can be used in create_fact
      expect(result.isError).toBeFalsy();
      const resultData = JSON.parse(result.content[0].text);
      expect(resultData.entities[0].id).toBe('masha-entity-uuid');
    });

    it('full routing flow: find entity then create draft fact for it', async () => {
      const tools = provider.getTools(testContext);
      const findTool = tools.find((t) => t.name === 'find_entity_by_name');
      const createFactTool = tools.find((t) => t.name === 'create_fact');

      // Step 1: LLM finds Маша's entity
      mockEntityService.findAll.mockResolvedValueOnce({
        items: [
          { id: 'masha-uuid', name: 'Мария Иванова', type: 'person', organization: null },
        ],
        total: 1,
      });

      const findResult = await (findTool as any).handler({ name: 'Маша', limit: 1 });
      const foundEntity = JSON.parse(findResult.content[0].text).entities[0];

      // Step 2: LLM creates draft fact for that entity (not current contact)
      await (createFactTool as any).handler({
        entityId: foundEntity.id,
        factType: 'company',
        value: 'Сбербанк',
        confidence: 0.85,
        sourceQuote: 'Маша перешла в Сбер',
      });

      // Verify routing: draft fact created for Маша via DraftExtractionService
      expect(mockDraftExtractionService.createDrafts).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerEntityId: testContext.ownerEntityId,
          facts: [
            expect.objectContaining({
              entityId: 'masha-uuid',
              factType: 'company',
              value: 'Сбербанк',
            }),
          ],
        }),
      );
    });
  });
});
