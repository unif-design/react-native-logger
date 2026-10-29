import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as design from '@unif/react-native-design';
import { createLogger, getLogStatus } from '@unif/react-native-logger';
import type { LoggingHandle } from '@unif/react-native-logger';
import { createLogFiles } from '@unif/react-native-logger/files';
import { installLogging } from '@unif/react-native-logger/runtime';

let sequence = 0;
const createId = () => `example-${Date.now()}-${++sequence}`;

function Diagnostics() {
  const handle = useRef<LoggingHandle | null>(null);
  const [output, setOutput] = useState('日志尚未初始化');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let installed: LoggingHandle | undefined;
    let active = true;
    try {
      installed = installLogging({
        policy: {
          service: 'logger-example',
          allowedFields: ['reason'],
          startupScopes: ['example'],
        },
        environment: {
          appVersion: '0.1.0',
          platform: Platform.OS,
          osVersion: String(Platform.Version),
          development: __DEV__,
        },
        files: createLogFiles({ directoryName: 'UnifLoggerExample', createId }),
        createId,
      });
      handle.current = installed;
      installed.setOwner(null).then(() => {
        if (active) setOutput(JSON.stringify(getLogStatus(), null, 2));
      });
    } catch {
      setOutput('初始化失败，请检查文件 SDK 接线');
    }
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') installed?.flush();
    });
    return () => {
      active = false;
      handle.current = null;
      subscription.remove();
      installed?.dispose();
    };
  }, []);

  async function run(operation: (logging: LoggingHandle) => Promise<string>) {
    const logging = handle.current;
    if (!logging || busy) return;
    setBusy(true);
    try {
      const result = await operation(logging);
      if (handle.current === logging) setOutput(result);
    } catch {
      if (handle.current === logging) setOutput('本次操作失败或当前平台不支持');
    } finally {
      if (handle.current === logging) setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Logger 文件与脱敏验证</Text>
      <design.Button
        label="写入并刷新"
        disabled={busy}
        onPress={() =>
          run(async logging => {
            createLogger('example').warn('sample', {
              fields: { reason: 'token=synthetic-secret' },
            });
            await logging.flush();
            return JSON.stringify(getLogStatus(), null, 2);
          })
        }
      />
      <design.Button
        label="读取当前快照"
        disabled={busy}
        onPress={() =>
          run(async logging => {
            const snapshot = await logging.createSnapshot();
            try {
              return await logging.readSnapshot(snapshot);
            } finally {
              await logging.releaseSnapshot(snapshot);
            }
          })
        }
      />
      <design.Button
        label="清理示例日志"
        variant="danger"
        disabled={busy}
        onPress={() =>
          run(async logging => JSON.stringify(await logging.clear(), null, 2))
        }
      />
      <Text selectable accessibilityLiveRegion="polite">
        {output}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 20, fontWeight: '600' },
});

export default function App() {
  return (
    <SafeAreaProvider>
      <design.ThemeProvider>
        <SafeAreaView style={styles.screen}>
          <Diagnostics />
        </SafeAreaView>
      </design.ThemeProvider>
    </SafeAreaProvider>
  );
}
