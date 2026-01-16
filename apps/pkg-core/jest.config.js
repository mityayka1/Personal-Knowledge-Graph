module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@pkg/entities$': '<rootDir>/../../../packages/entities/src',
    '^@pkg/shared$': '<rootDir>/../../../packages/shared/src',
    '^@anthropic-ai/claude-agent-sdk$': '<rootDir>/../__mocks__/@anthropic-ai/claude-agent-sdk.js',
  },
};
