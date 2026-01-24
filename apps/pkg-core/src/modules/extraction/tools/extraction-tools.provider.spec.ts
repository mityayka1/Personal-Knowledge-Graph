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
    it('should return array of 5 tools', () => {
      const tools = provider.getTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(5);
    });

    it('should cache tools on subsequent calls', () => {
      const tools1 = provider.getTools();
      const tools2 = provider.getTools();

      expect(tools1).toBe(tools2); // Same reference (cached)
    });

    it('should return tools with name property', () => {
      const tools = provider.getTools();

      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
      }
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
      const server = provider.createMcpServer();

      expect(server).toBeDefined();
    });
  });

  describe('hasRequiredServices', () => {
    it('should return true when required services are available', () => {
      expect(provider.hasRequiredServices()).toBe(true);
    });
  });

  describe('setMessageContext', () => {
    it('should set message context without throwing', () => {
      expect(() => {
        provider.setMessageContext('msg-123', 'interaction-456');
      }).not.toThrow();
    });

    it('should accept null values', () => {
      expect(() => {
        provider.setMessageContext(null, null);
      }).not.toThrow();
    });
  });

  describe('tool structure', () => {
    it('each tool should have description defined', () => {
      const tools = provider.getTools();

      for (const tool of tools) {
        expect(tool.description).toBeDefined();
      }
    });
  });
});
