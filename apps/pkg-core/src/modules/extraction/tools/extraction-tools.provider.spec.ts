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
      items: [{ id: 'entity-1', name: 'John', type: 'person', organization: null }],
      total: 1,
    }),
    findById: jest.fn().mockResolvedValue({ id: 'entity-1', name: 'John' }),
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
    );
  });

  describe('getTools', () => {
    const testContext = { messageId: 'msg-123', interactionId: 'interaction-456', ownerEntityId: 'owner-uuid' };

    it('should return array of 6 tools', () => {
      const tools = provider.getTools(testContext);

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(6);
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
      expect(tools.length).toBe(6);
    });
  });

  describe('getToolNames', () => {
    it('should return MCP-formatted tool names', () => {
      const toolNames = provider.getToolNames();

      expect(toolNames.length).toBe(6);
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
