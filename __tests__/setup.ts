jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: { LibraryDir: '/test/Library', DocumentDir: '/test/Documents' },
    },
  },
}));
