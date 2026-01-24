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

  beforeEach(async () => {
    jest.clearAllMocks();

    // Directly instantiate the provider with mocked dependencies
    // This bypasses NestJS DI issues with @Optional + forwardRef
    provider = new ExtractionToolsProvider(
      mockEntityFactService as any,
      mockEntityService as any,
      mockEntityRelationService as any,
      mockPendingResolutionService as any,
    );
  });

  describe('getTools', () => {
    const testContext = { messageId: 'msg-123', interactionId: 'interaction-456' };

    it('should return array of 5 tools', () => {
      const tools = provider.getTools(testContext);

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(5);
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
      expect(tools.length).toBe(5);
    });
  });

  describe('getToolNames', () => {
    it('should return MCP-formatted tool names', () => {
      const toolNames = provider.getToolNames();

      expect(toolNames.length).toBe(5);
      toolNames.forEach((name) => {
        expect(name).toMatch(new RegExp(`^mcp__${EXTRACTION_MCP_NAME}__`));
      });
    });
  });

  describe('createMcpServer', () => {
    it('should create MCP server with tools', () => {
      const server = provider.createMcpServer({ messageId: 'msg-123', interactionId: 'interaction-456' });

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
      const tools = provider.getTools({ messageId: 'msg-123', interactionId: 'interaction-456' });

      for (const tool of tools) {
        expect(tool.description).toBeDefined();
      }
    });
  });
});
