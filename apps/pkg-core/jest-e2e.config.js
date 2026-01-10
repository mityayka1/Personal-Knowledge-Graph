module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.e2e-spec.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@pkg/entities$': '<rootDir>/../../packages/entities/src',
    '^@pkg/shared$': '<rootDir>/../../packages/shared/src',
  },
  testTimeout: 30000,
};
