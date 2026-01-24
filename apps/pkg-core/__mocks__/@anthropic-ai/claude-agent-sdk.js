// Mock for @anthropic-ai/claude-agent-sdk
// This mock is used to avoid ESM import issues in Jest tests

module.exports = {
  query: jest.fn().mockImplementation(async function* () {
    // Return structured_output for agent calls that expect it
    yield {
      type: 'result',
      subtype: 'success',
      result: '{}',
      structured_output: {
        // For recall endpoint
        answer: 'Мок-ответ: информация не найдена в тестовом режиме.',
        sources: [],
        // For prepare endpoint
        brief: 'Мок-бриф: данные недоступны в тестовом режиме.',
        recentInteractions: 0,
        openQuestions: [],
        // For extraction
        facts: [],
        factsCreated: 0,
        relationsCreated: 0,
        pendingEntitiesCreated: 0,
        // For act endpoint
        result: 'Мок-результат: действие выполнено в тестовом режиме.',
        actions: [],
      },
    };
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
