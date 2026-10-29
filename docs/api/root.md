---
title: 根 API
description: 日志安装、策略、结构化记录、诊断以及自定义后端契约。
---

# 根 API

全部接口从 `@unif/react-native-logger` 导入。根入口不加载 React Native 文件模块；文件适配从 `/files` 独立导入。

## installLogging(options)

安装并返回 `LoggingHandle`。同一运行时重复安装返回已有句柄；策略和选项只在首次安装生效。配置错误会抛出并释放传入的文件存储，初始化调用方应捕获错误。默认使用库内部后端，生产环境跳过 debug。

| 参数              | 类型                         | 行为                                                          |
| ----------------- | ---------------------------- | ------------------------------------------------------------- |
| `policy`          | `LoggingPolicy`，必填        | `service`、`allowedFields`、`startupScopes`，安装时验证并固定 |
| `environment`     | `LogEnvironment`，必填       | 应用与设备的安全诊断信息，见下表                              |
| `files`           | `LogFileStore`，必填         | `/files` 创建的存储或调用方实现                               |
| `createId`        | `() => string`，必填         | 应用已有的唯一诊断标识生成函数                                |
| `backend`         | `LogBackend`                 | 注入已有后端；省略使用内部实现                                |
| `console`         | `ConsoleCaptureOptions`      | 显式连接实际 console transport，并启用原始 console 采集       |
| `consoleTimeZone` | `'UTC'` 或 `'Asia/Shanghai'` | 默认 UTC，仅影响可读控制台展示                                |
| `now`             | `() => number`               | 可注入毫秒时间源，默认 `Date.now`                             |
| `monotonicNow`    | `() => number`               | 可注入单调时间源，默认 `performance.now`，用于操作耗时        |

`LogEnvironment` 必填 `appVersion: string`、`platform: string`、`osVersion: string`、`development: boolean`。可选字符串为 `installedAppVersion`、`bundleId`、`buildNumber`、`deviceModel`、`systemName`、`systemVersion`；值均由应用取得，不由库猜测。

`LoggingHandle` 提供 `setOwner(ownerKey: string | null)`、`flush()`、`dispose()`，以及 [文件和快照管理](files.md) 中的 `readSummary`、`clear`、`createSnapshot`、`readSnapshot`、`releaseSnapshot`、`takeSnapshotFile`。`setOwner` 与 `flush` 的内部失败写入健康状态，不等于成功落盘；文件管理方法按其契约返回结果或拒绝。

## createLogger(scope)

返回 `AppLogger`，提供 `debug`、`info`、`warn`、`error` 和 `captureError`。前四个签名为 `(event: string, metadata?: LogMetadata) => void`；`captureError` 返回同一次安全序列化的 JSONL 或 null。返回文本只代表规范化成功，不证明写入文件成功。

未安装时普通调用静默返回，`captureError` 返回 null。生产环境忽略 debug。Warn、Error 和 captureError 有界提取记录位置；Info／Debug 不额外创建调用栈。

| `LogMetadata` 字段               | 类型               | 用途                                                                          |
| -------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `context`                        | `OperationContext` | 操作关联与耗时；旧身份或旧运行的上下文被拒绝                                  |
| `phase`、`code`、`serverTraceId` | string             | 阶段、受控错误码与服务端关联                                                  |
| `outcome`                        | `LogOutcome`       | success、failed、unknown、cancelled、superseded、unsupported、requires_action |
| `httpStatus`                     | number             | HTTP 状态                                                                     |
| `businessCode`                   | string 或 number   | 业务结果码                                                                    |
| `fields`                         | 只读键值对象       | 仅保留安装策略白名单和可序列化安全值                                          |
| `error`                          | unknown            | 有界提取并脱敏的异常信息                                                      |

## createOperationContext(trigger, parent?)

`trigger` 是 `user`、`startup`、`background`、`h5` 或 `system`。可传父 `OperationContext` 关联子操作。返回只读上下文，含 `runId`、`operationId`、可选 `parentOperationId`、`identityEpoch`、`trigger` 和单调时间 `startedAt`。

未安装时返回不可记录的 `uninstalled` 上下文。上下文不能跨身份、安装周期或进程持久化复用。

## 健康状态和诊断

| 接口                                    | 参数与返回                      | 行为                                                                           |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `getLogStatus()`                        | `LogStatus`                     | 安装状态、运行和身份周期、存储状态、队列字节、丢弃／损坏计数、失败码与受控诊断 |
| `markLoggingUnavailable(code?, error?)` | 可选 string、unknown；返回 void | 记录初始化不可用；默认码 `logger.initialize_failed`，不会安装或释放运行时      |
| `getFailureDiagnostics(error)`          | unknown → `FailureDiagnostics`  | 提取受控错误类型、原因、来源码、原因链与位置，不直接输出异常正文               |
| `getLogRetentionPolicy()`               | 只读 `LogRetentionPolicy`       | 默认 `maxAgeMs`、`fileCount`、`fileBytes`；不反映调用方自定义 IO 的限额覆盖    |
| `redactDiagnosticText(text)`            | string → string                 | 脱敏诊断文本中的敏感内容                                                       |
| `isSensitiveDiagnosticField(name)`      | string → boolean                | 判断字段名是否敏感；不能代替字段白名单和数据边界校验                           |

`LogStatus.state` 为 `unbound`、`ready`、`blocked` 或 `disposed`；`storageMode` 为 `native` 或 `memory`。`writable`、`lastFailureCode` 和可选 `lastFailure` 用于诊断，不作为业务成功依据。

## consoleTransport 和自定义后端

```ts
import { consoleTransport, installLogging } from '@unif/react-native-logger';
import type { LoggingOptions } from '@unif/react-native-logger';

export function installWithConsole(options: LoggingOptions) {
  return installLogging({
    ...options,
    console: { target: console, transport: consoleTransport },
  });
}
```

省略 `console` 不替换全局 console。默认内部后端仍按统一格式输出结构化日志。注入自定义 backend 时，应传该后端真正使用的 console transport，不要用文本前缀猜测并重写第三方输出。

`LogBackend` 要求实现 `createLogger(scope): Logger`、`addTransport(LogTransport)`、`removeTransport(id)`、`getLogLevel(): LogLevel`、`setLogLevel(LogLevel)`。相关类型均由根入口导出，无需导入内部 backend 文件。

- `Logger` 是后端接线类型，方法签名为 `(message: string, ...args: unknown[]) => void`；应用生产者使用 `AppLogger`。
- `LogTransport` 含只读 `id` 和 `log(record: LogRecord): void`。
- `LogRecord` 含 `level`、`scope`、`message`、`args: unknown[]` 和毫秒时间 `ts`，与结构化 `DiagnosticRecord` 不同。
- `ConsoleCaptureOptions` 含目标 `target` 和后端的 `transport`。释放时恢复原 console 和 transport 行为。

序列化规则、控制台时区与 JSONL 字段见 [输出格式](../FORMAT.md)。
