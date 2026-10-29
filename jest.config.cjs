module.exports = {
  preset: '@unif/react-native-design/jest-preset',
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
  clearMocks: true,
  restoreMocks: true,
};
