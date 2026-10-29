import manifest from '../package.json';

it('仅公开根入口、文件入口与包元数据', () => {
  expect(Object.keys(manifest.exports).sort()).toEqual([
    '.',
    './files',
    './package.json',
  ]);
});

it('根入口提供安装、记录与脱敏，加载时不触发原生文件 SDK', () => {
  jest.isolateModules(() => {
    jest.doMock('react-native-blob-util', () => {
      throw new Error('根入口不应加载原生文件 SDK');
    });
    const api = require('../src');
    expect(Object.keys(api).sort()).toEqual([
      'consoleTransport',
      'createLogger',
      'createOperationContext',
      'getFailureDiagnostics',
      'getLogRetentionPolicy',
      'getLogStatus',
      'installLogging',
      'isSensitiveDiagnosticField',
      'markLoggingUnavailable',
      'redactDiagnosticText',
    ]);
    expect(api.getLogStatus().installed).toBe(false);
    expect(
      api.createLogger('consumer').captureError('before_install'),
    ).toBeNull();
    expect(api.isSensitiveDiagnosticField('authorization')).toBe(true);
    expect(api.redactDiagnosticText('Bearer test-secret')).not.toContain(
      'test-secret',
    );
  });
});
