import { getLogSource } from '../src/normalization/getLogSource';
import { normalizeLogSource } from '../src/normalization/normalizeLogSource';

describe('safe diagnostic source extraction', () => {
  it('captures the real call site of an Error without retaining the local directory', () => {
    const original = Object.getOwnPropertyDescriptor(
      Error,
      'prepareStackTrace',
    );
    Object.defineProperty(Error, 'prepareStackTrace', {
      configurable: true,
      value: undefined,
    });
    try {
      function createFailure() {
        return new Error('PRIVATE_ERROR_MESSAGE');
      }
      const source = getLogSource(createFailure());
      expect(source).toMatchObject({
        file: 'logSource.test.ts',
        line: expect.any(Number),
      });
      expect(source!.line).toBeGreaterThan(0);
      expect(JSON.stringify(source)).not.toMatch(/Users|PRIVATE_ERROR_MESSAGE/);
    } finally {
      if (original) Object.defineProperty(Error, 'prepareStackTrace', original);
      else Reflect.deleteProperty(Error, 'prepareStackTrace');
    }
  });

  it.each([
    {
      label: 'V8 macOS',
      frame: '    at restore (/Users/alice/private-project/storage.ts:87:19)',
      source: {
        file: 'storage.ts',
        line: 87,
        column: 19,
        functionName: 'restore',
      },
    },
    {
      label: 'V8 Windows',
      frame:
        '    at restore (C:\\Users\\Alice\\private-project\\storage.ts:87:19)',
      source: {
        file: 'storage.ts',
        line: 87,
        column: 19,
        functionName: 'restore',
      },
    },
    {
      label: 'V8 file URL and spaces',
      frame:
        '    at restore (file:///Users/Alice Smith/private project/storage.ts:87:19)',
      source: {
        file: 'storage.ts',
        line: 87,
        column: 19,
        functionName: 'restore',
      },
    },
    {
      label: 'Metro URL',
      frame:
        '    at restore (http://alice:secret@localhost:8081/private/index.bundle?token=PRIVATE&source=/secret.js:817:27)',
      source: {
        file: 'index.bundle',
        line: 817,
        column: 27,
        functionName: 'restore',
      },
    },
    {
      label: 'JSC function URL',
      frame:
        'restore@http://localhost:8081/private/index.bundle?platform=ios&token=PRIVATE:817:27',
      source: {
        file: 'index.bundle',
        line: 817,
        column: 27,
        functionName: 'restore',
      },
    },
    {
      label: 'JSC anonymous function',
      frame: '@http://localhost:8081/private/index.bundle?token=PRIVATE:817:27',
      source: { file: 'index.bundle', line: 817, column: 27 },
    },
    {
      label: 'Hermes Android address',
      frame:
        '    at restore (address at /data/user/0/com.portal/private/index.android.bundle:1:273813)',
      source: {
        file: 'index.android.bundle',
        line: 1,
        column: 273813,
        functionName: 'restore',
      },
    },
    {
      label: 'Hermes bytecode',
      frame:
        '    at anonymous (address at /private/var/owner/main.hbc:1:28371)',
      source: { file: 'main.hbc', line: 1, column: 28371 },
    },
    {
      label: 'iOS packaged bundle',
      frame:
        '    at restore (/private/var/containers/owner/App.app/main.jsbundle:173:33)',
      source: {
        file: 'main.jsbundle',
        line: 173,
        column: 33,
        functionName: 'restore',
      },
    },
    {
      label: 'safe project relative source',
      frame: '    at account.restore (src/app/account/restore.ts:14:2)',
      source: {
        file: 'src/app/account/restore.ts',
        line: 14,
        column: 2,
        functionName: 'account.restore',
      },
    },
    {
      label: 'line without column',
      frame: '    at restore (storage.ts:87)',
      source: { file: 'storage.ts', line: 87, functionName: 'restore' },
    },
  ])('retains the actual $label location', ({ frame, source }) => {
    expect(
      getLogSource({
        message: 'PRIVATE_MESSAGE',
        stack: `Error: PRIVATE_MESSAGE\n${frame}`,
      }),
    ).toEqual(source);
  });

  it('skips logger frames without counting the error header', () => {
    expect(
      getLogSource(
        {
          message: 'PRIVATE_MESSAGE',
          stack: [
            'Error: PRIVATE_MESSAGE',
            '    at emit (createLogger.ts:20:3)',
            '    at Object.warn (createLogger.ts:70:8)',
            '    at restore (restore.ts:42:9)',
          ].join('\n'),
        },
        2,
      ),
    ).toEqual({
      file: 'restore.ts',
      line: 42,
      column: 9,
      functionName: 'restore',
    });
  });

  it('excludes frame-shaped lines inside the original multiline error message', () => {
    const message =
      'PRIVATE_BODY\n    at privateMessage (private.ts:1:2)\nPRIVATE_END';
    const error = new Error(message);
    Object.defineProperty(error, 'stack', {
      value: `Error: ${message}\n    at restore (storage.ts:42:9)`,
    });
    expect(getLogSource(error)).toEqual({
      file: 'storage.ts',
      line: 42,
      column: 9,
      functionName: 'restore',
    });
  });

  it('excludes frame-shaped lines inside the original multiline error name', () => {
    const name = 'Error\n    at privateName (/Users/secret/payload.ts:1:2)';
    expect(
      getLogSource({
        name,
        message: '',
        stack: `${name}\n    at restore (storage.ts:42:9)`,
      }),
    ).toEqual({
      file: 'storage.ts',
      line: 42,
      column: 9,
      functionName: 'restore',
    });
  });

  it('omits a source when the stack header does not match the safely read error fields', () => {
    expect(
      getLogSource({
        name: 'Error',
        message: 'different message',
        stack: 'Error: PRIVATE_BODY\n    at privateMessage (private.ts:1:2)',
      }),
    ).toBeUndefined();
  });

  it('retains JSC frames that have no error header', () => {
    expect(
      getLogSource({
        name: 'TypeError',
        message: 'failed',
        stack:
          'restore@http://localhost/private/index.bundle?token=PRIVATE:817:27',
      }),
    ).toEqual({
      file: 'index.bundle',
      line: 817,
      column: 27,
      functionName: 'restore',
    });
  });

  it.each(['\n', '\r\n'])(
    'retains the native empty-message header variant (%#)',
    (newline) => {
      expect(
        getLogSource({
          stack: `Error: ${newline}    at restore (storage.ts:42:9)`,
        }),
      ).toEqual({
        file: 'storage.ts',
        line: 42,
        column: 9,
        functionName: 'restore',
      });
    },
  );

  it.each(['name', 'message'])(
    'does not infer a header through an unsafe %s getter',
    (field) => {
      const unsafe = jest.fn(() => 'PRIVATE_HEADER');
      const error = { stack: 'Error\n    at privateMessage (private.ts:1:2)' };
      Object.defineProperty(error, field, { get: unsafe });
      expect(getLogSource(error)).toBeUndefined();
      expect(unsafe).not.toHaveBeenCalled();
    },
  );

  it('prefers the deepest available error source and keeps an earlier source when the cause has none', () => {
    const outer = Object.freeze({
      message: 'outer',
      stack: 'Error: outer\n    at wrapper (wrapper.ts:8:1)',
      cause: Object.freeze({
        message: 'inner',
        stack: 'Error: inner\n    at read (storage.ts:42:9)',
        cause: Object.freeze({ stack: '' }),
      }),
    });
    expect(getLogSource(outer)).toEqual({
      file: 'storage.ts',
      line: 42,
      column: 9,
      functionName: 'read',
    });
    expect(outer.cause.stack).toContain('storage.ts:42:9');
  });

  it('bounds cause depth and terminates circular causes', () => {
    const valid = { stack: 'Error\n    at deep (private.ts:99:9)' };
    expect(
      getLogSource({ cause: { cause: { cause: { cause: valid } } } }),
    ).toBeUndefined();
    const cyclic: { cause?: unknown; stack: string } = {
      stack: 'Error\n    at restore (storage.ts:42:9)',
    };
    cyclic.cause = cyclic;
    expect(getLogSource(cyclic)?.file).toBe('storage.ts');
  });

  it.each([
    '',
    'Error: PRIVATE_MESSAGE (secret.ts:42:9)',
    'Error: PRIVATE_MESSAGE@secret.ts:42:9',
    'storage.ts:42:9',
    'Error\n    at restore (native)',
    'Error\n    at restore (/private/token=PRIVATE.js:42:9)',
    'Error\n    at restore (/private/storage.ts%3Ftoken%3DPRIVATE:42:9)',
    'Error\n    at restore (/private/storage.json:42:9)',
    'Error\n    at restore (storage.ts:0:9)',
    'Error\n    at restore (storage.ts:9999999999:9)',
    `Error\n${'    at unknown (native)\n'.repeat(32)}    at outside (private.ts:99:9)`,
    `Error\n    at quotedPrivate (storage.ts:42:9)\n${'PRIVATE'.repeat(1000)}`,
  ])(
    'omits empty, forged, unsupported, or oversized stack input (%#)',
    (stack) => {
      expect(getLogSource({ stack })).toBeUndefined();
    },
  );

  it.each([-1, 0.5, Infinity, NaN, 33])(
    'rejects invalid or out of budget skipFrames %s',
    (skipFrames) => {
      expect(
        getLogSource(
          { stack: 'Error\n    at restore (storage.ts:42:9)' },
          skipFrames,
        ),
      ).toBeUndefined();
    },
  );

  it('does not invoke user getters, serializers, or inherited stack properties', () => {
    const unsafe = jest.fn(() => {
      throw new Error('PRIVATE_GETTER');
    });
    const error = Object.create({
      stack: 'Error\n    at forged (forged.ts:1:1)',
    });
    Object.defineProperties(error, {
      stack: { get: unsafe },
      cause: { get: unsafe },
      message: { get: unsafe },
      toString: { value: unsafe },
      toJSON: { value: unsafe },
    });
    expect(getLogSource(error)).toBeUndefined();
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('contains hostile proxy failures instead of throwing into the caller', () => {
    const error = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('PRIVATE_DESCRIPTOR');
        },
      },
    );
    expect(getLogSource(error)).toBeUndefined();
  });

  it('does not execute prepareStackTrace for a fresh native Error', () => {
    const original = Object.getOwnPropertyDescriptor(
      Error,
      'prepareStackTrace',
    );
    const unsafe = jest.fn(() => 'PRIVATE_STACK');
    Object.defineProperty(Error, 'prepareStackTrace', {
      configurable: true,
      value: unsafe,
    });
    try {
      expect(getLogSource(new Error('PRIVATE_MESSAGE'))).toBeUndefined();
      expect(unsafe).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(Error, 'prepareStackTrace', original);
      else Reflect.deleteProperty(Error, 'prepareStackTrace');
    }
  });
});

describe('safe diagnostic source normalization', () => {
  it('copies only validated source data and never serializes caller objects', () => {
    const unsafe = jest.fn();
    const input = Object.freeze({
      file: 'src/app/restore.ts',
      line: 42,
      column: 9,
      functionName: 'account.restore',
      body: 'PRIVATE_BODY',
      toJSON: unsafe,
    });
    const state = { truncated: false };
    const source = normalizeLogSource(input, state);
    expect(source).toEqual({
      file: 'src/app/restore.ts',
      line: 42,
      column: 9,
      functionName: 'account.restore',
    });
    expect(source).not.toBe(input);
    expect(input.body).toBe('PRIVATE_BODY');
    expect(unsafe).not.toHaveBeenCalled();
  });

  it.each([
    '/Users/alice/private/restore.ts',
    'C:\\Users\\Alice\\private\\restore.ts',
    'https://alice:PRIVATE@host.example/private/restore.ts?token=PRIVATE',
    '../../private/restore.ts',
    'src/13812345678/restore.ts',
    'src/user@example.com/restore.ts',
    'src/token=PRIVATE/restore.ts',
    'src/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.c2lnbmF0dXJl/restore.ts',
  ])('projects untrusted directories to a safe basename (%#)', (file) => {
    expect(
      normalizeLogSource({ file, line: 42 }, { truncated: false }),
    ).toEqual({ file: 'restore.ts', line: 42 });
  });

  it.each([
    undefined,
    null,
    'restore.ts:1:1',
    [],
    { file: { toString: () => 'restore.ts' }, line: 42 },
    { file: 'restore.ts', line: '42' },
    { file: 'restore.ts', line: 0 },
    { file: 'restore.ts', line: -1 },
    { file: 'restore.ts', line: 1.5 },
    { file: 'restore.ts', line: Infinity },
    { file: 'restore.ts', line: 2147483648 },
    { file: 'restore.ts', line: 42, column: -1 },
    { file: 'restore.ts', line: 42, column: NaN },
    { file: 'restore.ts', line: 42, column: 2147483648 },
    { file: '13812345678.ts', line: 42 },
    { file: 'token=PRIVATE.js', line: 42 },
    { file: 'restore.ts%3Ftoken%3DPRIVATE', line: 42 },
    { file: 'restore.json', line: 42 },
    { file: `${'a'.repeat(129)}.ts`, line: 42 },
    { file: `${'PRIVATE/'.repeat(1000)}restore.ts`, line: 42 },
    Object.create({ file: 'restore.ts', line: 42 }),
  ])('omits malformed source fields without coercion (%#)', (value) => {
    expect(normalizeLogSource(value, { truncated: false })).toBeUndefined();
  });

  it.each([
    'anonymous',
    '<anonymous>',
    'Error: PRIVATE_MESSAGE',
    'user@example.com',
    'restore13812345678 PRIVATE',
    'a'.repeat(129),
  ])(
    'omits an unconfirmed function name while retaining the valid position (%#)',
    (functionName) => {
      expect(
        normalizeLogSource(
          { file: 'restore.ts', line: 42, functionName },
          { truncated: false },
        ),
      ).toEqual({ file: 'restore.ts', line: 42 });
    },
  );

  it('does not invoke source getters or inherited fields', () => {
    const unsafe = jest.fn(() => 'PRIVATE_FIELD');
    const source = Object.create({ line: 42 });
    Object.defineProperty(source, 'file', { get: unsafe });
    expect(normalizeLogSource(source, { truncated: false })).toBeUndefined();
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('omits revoked proxies instead of throwing while inspecting the source', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const state = { truncated: false };
    expect(normalizeLogSource(proxy, state)).toBeUndefined();
    expect(state.truncated).toBe(true);
  });
});
