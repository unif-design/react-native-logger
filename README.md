# @unif/react-native-logger

Unif React Native 日志基础库：结构化记录、操作关联、敏感信息脱敏、有界队列、文件轮转、身份分区和受控诊断快照。日志失败不改变业务控制流，库不自动上传日志。

[文档站](https://unif-design.github.io/react-native-logger/) · [快速开始](docs/quick-start.md) · [根 API](docs/api/root.md) · [文件 API](docs/api/files.md) · [输出格式](docs/FORMAT.md) · [npm](https://www.npmjs.com/package/@unif/react-native-logger)

## 安装

正式版本发布后，使用以下命令安装；可安装版本以 npm registry 为准。

```sh
npm install @unif/react-native-logger react-native-blob-util
cd ios && bundle exec pod install
```

| Peer dependency          | 声明范围   | 本仓实际验证版本 |
| ------------------------ | ---------- | ---------------- |
| `react`                  | `^19.3.0`  | 19.3.1           |
| `react-native`           | `>=0.88.0` | 0.88.1           |
| `react-native-blob-util` | `^0.25.1`  | 0.25.1           |

库本体没有自有原生模块；iOS／Android 文件接线依赖 `react-native-blob-util`，安装后重新构建原生应用。根入口不加载原生文件 SDK，也不依赖 Design。Web 消费 `/files` 时通过 `browser` 条件使用有界内存，文件和快照操作返回不支持。原生鸿蒙不在本包支持范围内。

## 快速开始

```ts
import { Platform } from 'react-native';
import {
  createLogger,
  installLogging,
  markLoggingUnavailable,
} from '@unif/react-native-logger';
import { createLogFiles } from '@unif/react-native-logger/files';

// 在应用启动时调用；createId 使用应用已有的唯一诊断标识生成函数。
export async function initializeLogger(createId: () => string) {
  try {
    const logging = installLogging({
      policy: {
        service: 'sample-app',
        allowedFields: ['reason', 'count'],
        startupScopes: ['bootstrap'],
      },
      environment: {
        appVersion: '1.0.0',
        platform: Platform.OS,
        osVersion: String(Platform.Version),
        development: __DEV__,
      },
      consoleTimeZone: 'Asia/Shanghai',
      createId,
      files: createLogFiles({ directoryName: 'SampleLogs', createId }),
    });
    await logging.setOwner(null); // 匿名；账号恢复后传应用已有的身份摘要。
    return logging;
  } catch (error) {
    markLoggingUnavailable(undefined, error);
    return null; // 由应用决定后续诊断反馈，不改变业务结果。
  }
}

const log = createLogger('camera');
log.warn('capture.unavailable', { fields: { reason: 'permission_denied' } });
```

宿主安装一次并保存返回句柄，负责身份变化、后台 `flush()` 和退出前 `dispose()`。生产者只创建 scope，不安装第二套运行时。各组件库将 Logger 声明为 peer dependency，宿主统一版本和实例。

策略、目录、身份来源、设备信息、业务提示及文件分享均由调用方提供。`directoryName` 只能是单个安全目录名；iOS 使用应用 Library，Android 使用 DocumentDir。迁移应用继续使用已有目录名和身份摘要。

## 公共接口

| 入口            | 接口                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 根入口          | `installLogging`、`markLoggingUnavailable`、`createLogger`、`createOperationContext`、`getLogStatus`                                  |
| 根入口          | `getFailureDiagnostics`、`getLogRetentionPolicy`、`redactDiagnosticText`、`isSensitiveDiagnosticField`、`consoleTransport` 及公共类型 |
| `/files`        | `createLogFiles`、`createLogFileStore`、文件 IO、状态及快照类型；Web 由 `browser` 条件选择                                            |
| `/package.json` | 包元数据                                                                                                                              |

后端实现为内部细节。宿主可通过根入口的 `LogBackend`、`Logger`、`LogRecord`、`LogTransport` 类型注入已有后端；新日志生产者使用结构化的 `createLogger()`。完整参数与返回行为见 [根 API](docs/api/root.md)。

默认不替换全局 console。显式传入 `console: { target: console, transport: consoleTransport }` 才启用原始 console 采集；自定义后端应连接自己的实际控制台 transport。`consoleTimeZone` 默认 UTC，也支持 `Asia/Shanghai`，只改变可读控制台时间；文件 JSONL、`captureError` 和快照的时间始终为 UTC。

## 文件和快照生命周期

`setOwner(null)` 代表匿名；身份变化使旧操作上下文失效。未绑定身份时只接收允许的启动 scope。普通日志未安装时静默返回，`captureError` 返回 null；成功返回的 JSONL 也不等于已落盘。

`createSnapshot()` 返回仅属于当前实例和身份的句柄。读取文本后调用 `releaseSnapshot()`；交付文件使用 `takeSnapshotFile()` 转移所有权，此后由接收方在异步读取结束后调用返回对象的 `release()`。不要混用两种释放方式。快照、读取及文件交接可能拒绝，调用方须处理错误和释放失败；详见 [文件 API](docs/api/files.md)。

默认单条上限 8 KiB、单文件 1 MiB、最多 10 个日志段、保留 7 天、队列上限 256 KiB。`clear()` 只清理当前身份的受控日志，不清理业务附件或应用缓存。系统终止、原生崩溃和存储错误仍可能丢失未刷新的尾部，日志不是业务成功凭据。

## 示例与开发

[原生 example](example/App.tsx) 展示写入、快照和清理操作；[研发入口](docs/DEVELOPMENT.md) 说明工程标准、实际消费者和验证边界。

```sh
yarn install --immutable
yarn lint
yarn typecheck
yarn test --runInBand
yarn build
yarn example typecheck
yarn website typecheck
node website/scripts/build-llms.test.js
yarn website build
```

文档站使用 Docusaurus；`website/docs` 指向仓库 `docs`，输出格式和 API 只维护一份。LLM 文档由组织共享脚本生成。

## 许可

[MIT License](LICENSE)。上游日志分发实现的署名与许可保留在 [NOTICE](NOTICE)。
