# @unif/react-native-logger

供应用和自有 React Native 库共用的日志基础库：结构化记录、操作关联、敏感信息脱敏、有限队列、轮转、身份分区、受控快照和控制台诊断。日志失败不改变业务控制流，不自动上传。

当前为本地候选，`private: true` 防止误发布。分发方式与许可由后续交付决定。原生鸿蒙单独处理，本包不声明鸿蒙支持。

## 职责

- logger 维护公共日志契约、分发器和文件生命周期，不依赖 Design、Portal、账号模块或业务接口。
- 其他库从根入口创建自己的 scope，只记录事件；不安装日志、不设置身份、不独立持有文件后端。
- 宿主应用在业务初始化前安装一次，提供应用策略、环境和存储；负责身份变化、后台刷新及退出时释放。
- RN 文件适配使用 `react-native-blob-util`，包本体没有自有原生模块。Web 使用有界内存，文件操作明确返回不支持。

## 宿主安装

```ts
import { Platform } from 'react-native';
import { createLogFiles } from '@unif/react-native-logger/files';
import { installLogging } from '@unif/react-native-logger/runtime';

// 应用启动时调用一次；传入应用已有的唯一诊断标识生成函数。
export async function initializeLogger(createId: () => string) {
  const logging = installLogging({
    consoleTimeZone: 'Asia/Shanghai', // 可选，默认 UTC
    policy: {
      service: 'sample-app',
      allowedFields: ['reason', 'operation', 'count'],
      startupScopes: ['bootstrap'],
    },
    environment: {
      appVersion: '1.0.0',
      platform: Platform.OS,
      osVersion: String(Platform.Version),
      development: __DEV__,
    },
    createId,
    files: createLogFiles({ directoryName: 'SampleLogs', createId }),
  });
  await logging.setOwner(null); // 匿名；账号恢复后传应用已有的身份摘要
  return logging;
}
```

上述初始化使用默认后端，不需要 Design。`consoleTimeZone` 只控制库的可读控制台输出：`'UTC'` 保持原格式，`'Asia/Shanghai'` 按北京时间（UTC+08:00）显示，例如 `2026-10-29T08:00:00.000+08:00`。文件 JSONL、`captureError` 和快照中的 `timestamp` 始终保留 UTC；时间由库生成，调用方不用传。

默认不替换全局 console。需要额外采集原始 console 时，再从 `/backend` 导入 `consoleTransport`，传入 `console: { target: console, transport: consoleTransport }`。

策略在安装时固定，缺失或包含敏感／原型字段时拒绝安装。`directoryName` 必须是单个安全目录名，不接受绝对路径、分隔符或父目录。实际目录为 iOS Library 或 Android DocumentDir 下的专属子目录；应用迁移须继续传原目录名和身份摘要，避免丢失原日志访问范围。

普通日志调用在未安装时静默返回，`captureError` 返回 null。导入包不安装监听、不读取文件、不发起请求。`setOwner` 更换诊断周期，旧上下文不能写入新身份；文件、快照保护和有限清理不因退出或身份重复出现而失效。

## 库内记录

```ts
import { createLogger } from '@unif/react-native-logger';
const log = createLogger('camera');
log.warn('capture.unavailable', { fields: { reason: 'permission_denied' } });
```

生产者采用同一实例。各库将本包声明为 `peerDependency` 并在开发依赖中安装，不内嵌／打包另一份运行时；宿主锁定一致版本。

日志字段、控制台文本与 JSONL 契约见 [输出格式](docs/FORMAT.md)。

## 存储与清理范围

`directoryName` 自定义日志目录名；iOS 存放于应用 Library 下，Android 存放于应用 DocumentDir 下。文件命名、身份分区、轮转与快照释放由库维护，默认入口不接受任意完整路径或逐条指定文件名。需要其他存储后端时，通过 `createLogFileStore({ io, createId })` 提供实际 IO。

`/files` 仅管理本库日志和快照，不提供下载、业务附件删除或应用缓存清理。`logging.clear()` 只清理当前身份的受控日志；保留期限与容量策略按日志契约管理本库日志段。

## 公开入口

| 入口             | 内容                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| 根入口           | `createLogger`、`createOperationContext`、`getLogStatus`、`getFailureDiagnostics`、`getLogRetentionPolicy` 和类型 |
| `/runtime`       | `installLogging`、`markLoggingUnavailable`                                                                        |
| `/files`         | `createLogFiles`、可注入 IO 的 `createLogFileStore`、文件及快照类型                                               |
| `/files/web`     | 显式 Web／内存适配入口，不装载原生文件 SDK                                                                        |
| `/normalization` | `redactDiagnosticText`、`isSensitiveDiagnosticField`                                                              |
| `/backend`       | 基础级别／transport 接口，用于后端扩展及现有 Design 日志 API 的迁移                                               |

`backend` 缺省使用本包分发器。已有宿主可显式提供结构兼容的 Design 后端，让旧 SDK 和应用共享同一采集链；logger 自身没有 Design 的生产依赖。`/backend` 的原始参数接口用于既有后端接线，新生产者使用根入口的结构化接口。

`captureError` 返回同一次安全序列化的 JSONL 或 null，返回文本不等于落盘成功。快照只属于原实例和身份；文件交付后调用 `release()`，异步读取结束前不能提前释放。

默认单条上限 8 KiB、单文件 1 MiB、最多 10 个日志段、保留 7 天、队列上限 256 KiB。系统终止、原生崩溃和存储错误仍可能丢失未刷新的尾部，日志不能作为业务成功依据。

## 开发

采用 `create-react-native-library@0.63.1` 的 JavaScript library 模板，源码为 TypeScript，Bob 生成 ESM 和声明。`example/` 为 RN 0.88.1 消费者，提供写入、快照和清理操作。

```sh
yarn install --immutable
yarn typecheck
yarn test --runInBand
yarn build
yarn example typecheck
yarn lint
```

Git 忽略依赖、构建产物、覆盖率、缓存、打包归档、本地环境和私有签名文件；源码、测试、文档、`.github`、锁文件、固定 Yarn 运行时及示例工程保留。示例的标准 debug keystore 是构建所需测试材料。npm 发布范围由 `package.json.files` 单独控制，包含运行所需的 `lib`，不包含示例、测试或本机配置。

组织模板、接入范围和验证边界见 [开发说明](docs/DEVELOPMENT.md)。
