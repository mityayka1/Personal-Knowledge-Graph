// Mock for @anthropic-ai/claude-agent-sdk
// This mock is used to avoid ESM import issues in Jest tests

module.exports = {
  query: jest.fn().mockImplementation(async function* () {
    yield { type: 'result', result: '{}' };
  }),
  tool: jest.fn().mockReturnValue({
    name: 'mock_tool',
    description: 'Mock tool',
    inputSchema: {},
    handler: jest.fn(),
  }),
  createSdkMcpServer: jest.fn().mockReturnValue({
    name: 'mock-server',
    version: '1.0.0',
    tools: [],
  }),
};
