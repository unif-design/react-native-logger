import { TEST_POLICY } from './policyFixture';
import { serializeLogRecord } from '../src/serializeLogRecord';
import type { LogRecordInput } from '../src/types';

function input(overrides: Partial<LogRecordInput>): LogRecordInput {
  return {
    schemaVersion: 1,
    timestamp: '2026-09-13T00:00:00Z',
    sequence: 1,
    runId: 'run-1',
    identityEpoch: 'epoch-1',
    appVersion: '4',
    buildNumber: '1',
    platform: 'ios',
    osVersion: '18',
    development: false,
    level: 'error',
    scope: 'bootstrap',
    event: 'restore.failed',
    ...overrides,
  };
}

describe('diagnostic source locations', () => {
  it.each([
    {
      label: 'Node macOS',
      frame:
        '    at restore (/Users/alice/private-project/src/storage.ts:87:19)',
      location: 'storage.ts:87:19',
    },
    {
      label: 'Node Linux',
      frame: '    at /home/alice/private-project/storage.js:87:19',
      location: 'storage.js:87:19',
    },
    {
      label: 'Node Windows',
      frame:
        '    at restore (C:\\Users\\Alice\\private-project\\storage.ts:87:19)',
      location: 'storage.ts:87:19',
    },
    {
      label: 'Node user path with spaces',
      frame:
        '    at restore (/Users/Alice Smith/private-project with spaces/storage.ts:87:19)',
      location: 'storage.ts:87:19',
    },
    {
      label: 'Node file URL',
      frame:
        '    at restore (file:///Users/alice/private-project/storage.ts:87:19)',
      location: 'storage.ts:87:19',
    },
    {
      label: 'Metro query',
      frame:
        '    at restore (http://localhost:8081/private-project/index.bundle?platform=ios&dev=true:817:27)',
      location: 'index.bundle:817:27',
    },
    {
      label: 'Hermes URL frame',
      frame:
        'restore@http://localhost:8081/private-project/index.bundle?platform=ios&dev=true:817:27',
      location: 'index.bundle:817:27',
    },
    {
      label: 'Hermes bytecode',
      frame:
        '    at restore (address at /data/user/0/com.portal/private-project/index.android.bundle:1:273813)',
      location: 'index.android.bundle:1:273813',
    },
    {
      label: 'iOS packaged bundle',
      frame:
        '    at restore (/private/var/containers/Bundle/Application/owner-id/private-project/main.jsbundle:173:33)',
      location: 'main.jsbundle:173:33',
    },
  ])(
    'retains a basename and line/column for $label without user directories',
    ({ frame, location }) => {
      const result = serializeLogRecord(
        input({
          error: {
            name: 'Error',
            message: 'restore failed',
            stack: `Error: restore failed\n${frame}`,
          },
        }),
        TEST_POLICY,
      );

      expect(result?.record.error?.stack).toContain(location);
      expect(result?.record.error?.stack).not.toMatch(
        /alice|Alice|Smith|private-project|owner-id|\/data\/user|platform=|dev=true/,
      );
      expect(result?.record.error?.stack).toContain('[REDACTED]');
    },
  );

  it.each([
    'https://alice:credential-secret@host.example/private-project/index.bundle?bundle=/query-secret.js&hash=hash-secret#fragment-secret:817:27',
    'https://host.example/private-project/index.bundle#fragment-secret?bundle=/query-secret.js:817:27',
    '/Users/alice/private-project/index.bundle?token=query-secret&hash=hash-secret:817:27',
  ])(
    'extracts the source filename before parsing any URL parameters (%#)',
    (source) => {
      const result = serializeLogRecord(
        input({
          error: {
            name: 'Error',
            message: 'failed',
            stack: `Error: failed\n    at restore (${source})`,
          },
        }),
        TEST_POLICY,
      );

      expect(result?.record.error?.stack).toContain('index.bundle:817:27');
      expect(result?.line).not.toMatch(
        /alice|credential-secret|private-project|query-secret|hash-secret|fragment-secret/,
      );
    },
  );

  it.each([
    '/Users/alice/private-project/token=basename-secret.js:87:19',
    'https://host.example/private-project/storage.ts%3Ftoken%3Dbasename-secret:87:19',
  ])(
    'does not expose a basename outside the controlled filename syntax (%#)',
    (source) => {
      const result = serializeLogRecord(
        input({
          error: {
            name: 'Error',
            message: 'failed',
            stack: `Error: failed\n    at restore (${source})`,
          },
        }),
        TEST_POLICY,
      );

      expect(result?.line).not.toMatch(
        /alice|private-project|basename-secret|%3F|%3D/,
      );
      expect(result?.record.error?.stack).toContain(':87:19');
    },
  );

  it('still removes trailing numeric text that belongs to an ordinary URL query', () => {
    const result = serializeLogRecord(
      input({
        fields: {
          endpoint:
            'https://host.example/api/restore?secret=query-secret:817:27',
        },
      }),
      TEST_POLICY,
    );
    expect(result?.record.fields?.endpoint).toContain(
      'host.example/api/restore',
    );
    expect(result?.line).not.toMatch(/query-secret|817:27/);
  });

  it('does not retain an absolute stack directory when no usable line numbers exist', () => {
    const result = serializeLogRecord(
      input({
        error: {
          name: 'Error',
          message: 'failed',
          stack:
            'Error: failed\n    at restore (/private/var/containers/Bundle/Application/owner-secret/App.app/main.jsbundle)\n    at restore (/Volumes/Private User/private-project/source.blob:invalid)',
        },
      }),
      TEST_POLICY,
    );
    expect(result?.record.error?.stack).toContain('main.jsbundle');
    expect(result?.line).not.toMatch(
      /owner-secret|\/private\/var|\/Volumes|Private User|private-project|source.blob/,
    );
  });
});

describe('diagnostic source before stack redaction', () => {
  it('does not turn a multiline message frame into the error source after path redaction', () => {
    const message =
      'PRIVATE_BODY\n    at privateMessage (/Users/secret/payload.ts:1:2)\nPRIVATE_END';
    const result = serializeLogRecord(
      input({
        error: {
          name: 'Error',
          message,
          stack: `Error: ${message}\n    at restore (/Users/secret/storage.ts:42:9)`,
        },
      }),
      TEST_POLICY,
    );
    expect(result?.record.errorSource).toEqual({
      file: 'storage.ts',
      line: 42,
      column: 9,
      functionName: 'restore',
    });
  });

  it('does not turn a multiline name with no message into the error source', () => {
    const name = 'Error\n    at privateName (/Users/secret/payload.ts:1:2)';
    const result = serializeLogRecord(
      input({
        error: {
          name,
          message: '',
          stack: `${name}\n    at restore (/Users/secret/storage.ts:42:9)`,
        },
      }),
      TEST_POLICY,
    );
    expect(result?.record.errorSource).toEqual({
      file: 'storage.ts',
      line: 42,
      column: 9,
      functionName: 'restore',
    });
  });
});

describe('explicit diagnostic correlation', () => {
  it('preserves phone-shaped and device-shaped IDs only in declared correlation fields', () => {
    const result = serializeLogRecord(
      input({
        runId: '13812345678',
        operationId: '490154203237518',
        parentOperationId: '138-1234-5678',
        identityEpoch: '13812345678',
        serverTraceId: '13812345678',
        fields: { reason: 'phone 13812345678 and device 490154203237518' },
        error: {
          name: 'Error',
          message: 'phone 13812345678 and device 490154203237518',
        },
      }),
      TEST_POLICY,
    );

    expect(result?.record).toMatchObject({
      runId: '13812345678',
      operationId: '490154203237518',
      parentOperationId: '138-1234-5678',
      identityEpoch: '13812345678',
      serverTraceId: '13812345678',
    });
    expect(result?.record.fields?.reason).not.toMatch(
      /13812345678|490154203237518/,
    );
    expect(result?.record.error?.message).not.toMatch(
      /13812345678|490154203237518/,
    );
  });

  it.each([
    {
      value: 'Bearer correlation-bearer-secret',
      secret: 'correlation-bearer-secret',
    },
    {
      value: 'Bearer:correlation-colon-secret',
      secret: 'correlation-colon-secret',
    },
    { value: 'Basic dXNlcjpwcml2YXRl', secret: 'dXNlcjpwcml2YXRl' },
    {
      value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.c2lnbmF0dXJl',
      secret: 'eyJzdWIiOiJzZWNyZXQifQ',
    },
    {
      value: 'token:correlation-token-secret',
      secret: 'correlation-token-secret',
    },
    {
      value: 'api_key:correlation-key-secret',
      secret: 'correlation-key-secret',
    },
    { value: 'jwt:correlation-jwt-secret', secret: 'correlation-jwt-secret' },
    {
      value: '../../private-correlation-value',
      secret: 'private-correlation-value',
    },
  ])(
    'does not treat $value as a safe raw correlation identifier',
    ({ value, secret }) => {
      const result = serializeLogRecord(
        input({
          runId: value,
          identityEpoch: value,
          operationId: value,
          parentOperationId: value,
          serverTraceId: value,
        }),
        TEST_POLICY,
      );

      expect(result).not.toBeNull();
      expect(result?.line).not.toContain(secret);
      expect(result?.record.operationId).toContain('[REDACTED]');
    },
  );

  it('retains bounded safe separators and drops an oversized identifier as a whole', () => {
    const result = serializeLogRecord(
      input({
        serverTraceId: 'region:request-4_42',
        operationId: 'long-correlation-'.repeat(32),
      }),
      TEST_POLICY,
    );
    expect(result?.record.serverTraceId).toBe('region:request-4_42');
    expect(result?.record.operationId).toBe('[REDACTED]');
    expect(result?.record.truncated).toBe(true);
  });
});

describe('bounded normalization before text scanning', () => {
  it('replaces oversized free text without preserving an arbitrary scanned prefix', () => {
    const result = serializeLogRecord(
      input({ fields: { reason: 'a-'.repeat(8192) } }),
      TEST_POLICY,
    );
    expect(result?.record.fields?.reason).toBe('[truncated]');
    expect(result?.record.truncated).toBe(true);
    expect(result?.bytes).toBeLessThan(1024);
  });

  it('retains complete projected frames within a bounded stack prefix', () => {
    const result = serializeLogRecord(
      input({
        error: {
          name: 'Error',
          message: 'failed',
          stack: `Error: failed\n    at restore (/Users/alice/private-project/storage.ts:87:19)\n${'a-'.repeat(
            8192,
          )}`,
        },
      }),
      TEST_POLICY,
    );
    expect(result?.record.error?.stack).toContain('storage.ts:87:19');
    expect(result?.record.error?.stack).not.toMatch(
      /alice|private-project|a-a-a-a-/,
    );
    expect(result?.record.truncated).toBe(true);
  });

  it('does not retain a prefix cut through a credential or quoted value', () => {
    const result = serializeLogRecord(
      input({
        error: {
          name: 'Error',
          message: 'failed',
          stack: `Error: password="prefix-secret ${'a-'.repeat(
            8192,
          )} end-secret"`,
        },
      }),
      TEST_POLICY,
    );
    expect(result?.record.error?.stack).toBe('[truncated]');
    expect(result?.line).not.toMatch(/prefix-secret|end-secret|a-a-a-a-/);
    expect(result?.record.truncated).toBe(true);
  });

  it('retains only controlled source locations from an oversized stack with a multiline quoted value', () => {
    const result = serializeLogRecord(
      input({
        error: {
          name: 'Error',
          message: 'failed',
          stack: `Error: password="prefix-secret\n    at quoted-credential-fragment (/Users/alice/private-project/storage.ts:87:19)\n${'a-'.repeat(
            8192,
          )} end-secret"`,
        },
      }),
      TEST_POLICY,
    );
    expect(result?.record.error?.stack).toContain('storage.ts:87:19');
    expect(result?.line).not.toMatch(
      /prefix-secret|quoted-credential-fragment|end-secret|alice|private-project/,
    );
    expect(result?.record.truncated).toBe(true);
  });
});
