---
title: 根 API
description: 日志安装、策略、结构化记录、诊断以及自定义后端契约。
---

# 根 API

全部接口从 `@unif/react-native-logger` 导入。根入口不加载 React Native 文件模块；文件适配从 `/files` 独立导入。

## installLogging(options)

安装并返回 `LoggingHandle`。同一运行时重复安装返回已有句柄；策略和选项只在首次安装生效。配置错误会抛出并释放传入的文件存储，初始化调用方应捕获错误。默认使用库内部后端，生产环境跳过 debug。

`LoggingPolicy` 可选的 `eventDescriptions`、`reasonDescriptions` 均为 `Readonly<Record<string, string>>`，安装时复制并冻结。键为技术标识，固定说明最多 160 字符；命中后在 `fields.summary` 交付，继续采用单条 8 KiB 预算。未知原因不补猜，动态用户数据不能作为描述字典。

```ts
policy: {
  service: 'sample-app',
  allowedFields: ['method', 'reason'],
  startupScopes: ['bootstrap'],
  eventDescriptions: { request_failed: '请求失败' },
  reasonDescriptions: { connection_reset: '连接被重置' },
}
```

| 参数                | 类型                         | 行为                                                                      |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `policy`            | `LoggingPolicy`，必填        | `service`、`allowedFields`、`startupScopes`，安装时验证并固定             |
| `environment`       | `LogEnvironment`，必填       | 应用与设备的安全诊断信息，见下表                                          |
| `files`             | `LogFileStore`，必填         | `/files` 创建的存储或调用方实现                                           |
| `createId`          | `() => string`，必填         | 应用已有的唯一诊断标识生成函数                                            |
| `backend`           | `LogBackend`                 | 注入已有后端；省略使用内部实现                                            |
| `console`           | `ConsoleCaptureOptions`      | 显式连接实际 console transport，并启用原始 console 采集                   |
| `consoleTimeZone`   | `'UTC'` 或 `'Asia/Shanghai'` | 默认 UTC，仅影响可读控制台展示                                            |
| `consoleTimeFormat` | `'iso'` 或 `'datetime'`      | 默认 ISO；datetime 按所选时区显示 `YYYY-MM-DD HH:mm:ss`，仅影响可读控制台 |
| `now`               | `() => number`               | 可注入毫秒时间源，默认 `Date.now`                                         |
| `monotonicNow`      | `() => number`               | 可注入单调时间源，默认 `performance.now`，用于操作耗时                    |

`LogEnvironment` 必填 `appVersion: string`、`platform: string`、`osVersion: string`、`development: boolean`。可选字符串为 `installedAppVersion`、`bundleId`、`buildNumber`、`deviceModel`、`systemName`、`systemVersion`；值均由应用取得，不由库猜测。

`LoggingHandle` 提供 `setOwner(ownerKey: string | null)`、`flush()`、`dispose()`，以及 [文件和快照管理](files.md) 中的 `readSummary`、`clear`、`createSnapshot`、`readSnapshot`、`releaseSnapshot`、`takeSnapshotFile`。`setOwner` 在调用时立即改变身份周期，使旧上下文失效，实际绑定进入同一异步队列；首次未绑定阶段已准入的启动记录仍固定匿名分区。普通跨身份未处理任务丢弃，不能改归新用户。

`flush`、`readSummary`、`clear` 和 `createSnapshot` 包含调用前提交的日志及其同步派生分发，后来的独立日志不拖延边界。管理操作在调用时捕获身份，等待期间变更身份会拒绝或记入 flush 健康失败，不转去操作新用户文件。未交付快照的读取、交付和释放同样在运行时身份边界内，旧快照不会趁文件绑定尚未完成读取原账号内容；交付中的文件晚到且身份失效时释放该文件后拒绝。已经交付的 `LogSnapshotFile.release()` 仍可跨身份释放原文件。`setOwner` 与 `flush` 的内部失败写入健康状态，不等于成功落盘；文件管理方法按其契约返回结果或拒绝。

统一队列最多待处理 1000 个任务，每个宏任务最多处理 16 个，单次记录的重入派生最多 64 个；过量及失效任务丢弃并计数，不阻塞或同步排空业务。身份和文件管理控制任务遇到普通日志占满时可淘汰一条普通任务取得槽位，总量仍有界；未成功绑定的身份可用同值重试，不把旧文件存储的 ready 状态误作新身份绑定成功。`dispose` 立即停止接收并取消本运行时待处理／等待任务，不同步强制排空；需要保留已提交记录时先显式 `await handle.flush()`。纯 TypeScript 异步任务仍运行在 JavaScript 线程，不能宣称独立原生后台线程或零 CPU 开销。

## createLogger(scope)

返回 `AppLogger`，提供 `debug`、`info`、`warn`、`error` 和 `captureError`。前四个签名为 `(event: string, metadata?: LogMetadataInput) => void`，只提交任务，业务不等待格式化、后端或文件写入。`captureError` 为 `(event: string, metadata?: LogMetadataInput) => Promise<string | null>`，异步返回同一次安全序列化的 JSONL；未安装、过期、队列丢弃或记录失败均解析为 null，不向业务拒绝。返回文本只代表规范化成功，不证明写入文件成功。

`LogMetadataInput` 为 `LogMetadata | (() => LogMetadata)`。集中诊断可用同步生产器把错误投影等工作延迟到记录任务，生产器不得返回 Promise，不应执行业务副作用。任务仍使用调用现场固定的运行、身份、时间与调用点；身份或运行时已经失效时不执行生产器。传入元数据按只读数据使用，其值在任务中读取；容易被原生重置的连接状态等事实由接入处先固定。

```ts
log.warn('request_failed', () => ({
  context,
  error,
  fields: getFailureDiagnostics(error),
}));

// 错误页先展示；报告生成后补充复制内容，业务流程不等待它。
log
  .captureError('startup_failed', { error })
  .then((report) => updateReport(report));
```

未安装时普通调用静默返回。生产环境忽略 debug，忽略的日志不会执行元数据生产器。Warn、Error 和 captureError 仅在现场捕获调用点，堆栈解析在任务中处理；Info／Debug 不额外创建调用栈。

这是 0.3 的返回契约变更：原来同步读取 `captureError` 文本的消费者需要异步接收，保留卸载、身份及重试后的迟到结果保护，不能把 Promise 传给字符串消费者。纯查询接口 `getErrorDiagnostics`、`getFailureDiagnostics` 等保持同步。

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

省略 `console` 不替换全局 console。显式接入的 console 方法只异步提交并返回，不透传原输出函数的特殊返回值或异常；输出失败隔离，不改变业务控制流。默认内部后端仍按统一格式输出结构化日志。注入自定义 backend 时，应传该后端真正使用的 console transport，不要用文本前缀猜测并重写第三方输出。

`LogBackend` 要求实现 `createLogger(scope): Logger`、`addTransport(LogTransport)`、`removeTransport(id)`、`getLogLevel(): LogLevel`、`setLogLevel(LogLevel)`。相关类型均由根入口导出，无需导入内部 backend 文件。

- `Logger` 是后端接线类型，方法签名为 `(message: string, ...args: unknown[]) => void`；应用生产者使用 `AppLogger`。
- `LogTransport` 含只读 `id` 和 `log(record: LogRecord): void`。默认后端在提交时固定 transport 及其方法，异步执行时不改接后来安装的 transport；访问器只在任务内读取并隔离异常。
- `LogRecord` 含 `level`、`scope`、`message`、`args: unknown[]` 和毫秒时间 `ts`，与结构化 `DiagnosticRecord` 不同。
- `ConsoleCaptureOptions` 含目标 `target` 和后端的 `transport`。释放时恢复原 console 和 transport 行为；旧 wrapper 的已排队输出丢弃，不在重新安装后补发原文。

序列化规则、控制台时区与 JSONL 字段见 [输出格式](../FORMAT.md)。

## defaultLogBackend

根入口导出默认分发器的同一对象，包含 `createLogger`、`setLogLevel`、`getLogLevel`、`addTransport`、`removeTransport` 和 `consoleTransport`。它使用既有 `Logger` 可变参数签名，供已有基础日志 API 转导，保留级别、transport 异常隔离与重入语义；不创建另一份状态。

应用通常省略 `installLogging` 的 `backend`，由默认分发器采集这些 SDK 诊断。组件库不要再次安装运行时；新增结构化生产者仍使用根入口 `createLogger`。两者签名与用途不同，不能用结构化 `createLogger` 代替后端方法。

## getErrorDiagnostics(error)

从根入口导入，返回受控 `DiagnosticError`，可直接交给 `metadata.error`；再次归一化保留同样的技术事实。它只读取错误名、已知技术码、message、stack、cause和已投影source，不读取Axios的request/config/response或任意扩展属性，不调用自定义字符串转换或访问器。

已识别的网络、TLS、文件、权限、存储、数据库、解析、类型及SDK技术消息交付固定短语，动态主机、SQL、字段值与业务正文不输出。任意未识别message为 `[REDACTED]`，不可读取为 `[unserializable]`，循环和原因链上限分别标记 `[circular]`、`[cause limit]`；`messageStatus` 区分技术投影与截断，整体截断另标记 `truncated`。安全stack只含定位帧，source使用可确认的安全文件与行列，未取得的来源不猜测。

```ts
import {
  createLogger,
  getErrorDiagnostics,
  getFailureDiagnostics,
} from '@unif/react-native-logger';

const log = createLogger('storage');
try {
  await save();
} catch (error) {
  log.warn('save.failed', {
    fields: getFailureDiagnostics(error),
    error: getErrorDiagnostics(error),
  });
  throw error;
}
```

非 Error 拒绝值保留 `NonError` 类型，数字、布尔值、null、undefined 等只输出固定类型标记，不记录其原值；SDK 对象的数值技术错误码仍按范围保留。已取得的安全 source 优先于其脱敏 stack 的再次解析，重复投影和序列化保留路径、函数与行列。

`getFailureDiagnostics` 保留紧凑分类、技术码和来源，并可从固定技术消息识别原因；不含任意错误正文。宿主只有传入实际异常或公开取得的底层原因，导出才可能包含这些证据。无底层原因时不能从通用ERR_NETWORK猜出DNS、TLS或服务端故障。
