---
title: 文件 API
description: 原生文件适配、自定义 IO、身份分区和快照所有权。
---

# 文件 API

```ts
import {
  createLogFiles,
  createLogFileStore,
} from '@unif/react-native-logger/files';
```

`/files` 是唯一文件入口；浏览器使用 package exports 的 `browser` 条件自动选择内存实现。

## createLogFiles(options)

返回 `LogFileStore`。`NativeLogFilesOptions` 仅要求 `directoryName: string` 与 `createId(): string`。目录名须以字母或数字开始，只能包含字母、数字、下划线、点和短横线，总长最多 64；不接受绝对路径、分隔符或父目录。

iOS 使用应用 Library，Android 使用 DocumentDir 下的该子目录。本库只管理自有日志和快照文件，不提供业务附件或缓存清理。已有应用接入时继续传原目录名称和身份摘要。

Web 使用有界内存。`flush()` 无磁盘写入；`readSummary`、快照和导出方法以 `logger.files.unsupported` 拒绝，`clear()` 返回相同码的 failed 结果。Web 不能通过显式原生入口获得文件能力。

## createLogFileStore(options)

需要真实的其他存储后端时使用；默认原生适配不需重写。

| `LogFileStoreOptions`             | 说明                                     |
| --------------------------------- | ---------------------------------------- |
| `io: LogFileIO`                   | 必填，提供下表中的真实异步 IO            |
| `createId(): string`              | 必填，唯一诊断标识生成函数               |
| `now?: () => number`              | 可选毫秒时间源                           |
| `limits?: Partial<LogFileLimits>` | 可选有界限制；不改变全局默认保留策略查询 |

`LogFileIO`：`ensureRoot(): Promise<void>`；`list(): Promise<LogFileInfo[]>`；`read(name): Promise<string>`；`getFile(name): Promise<{ uri: string; bytes: number }>`；`write(name, text)`、`append(name, text)`、`remove(name)` 均返回 `Promise<void>`。`LogFileInfo` 包含 `name`、`bytes`、毫秒时间 `modifiedAt`；导出 URI 必须是有效 `file:///` 文件引用。

| `LogFileLimits`   | 默认值    |
| ----------------- | --------- |
| `recordBytes`     | 8 KiB     |
| `fileBytes`       | 1 MiB     |
| `fileCount`       | 10        |
| `maxAgeMs`        | 7 天      |
| `queueBytes`      | 256 KiB   |
| `batchBytes`      | 64 KiB    |
| `flushIntervalMs` | 1000 毫秒 |

## 存储和管理接口

应用通常调用 `installLogging()` 返回的句柄；底层 `LogFileStore` 由安装运行时持有。底层 `setOwner(ownerKey, identityEpoch)`、`append(LogWrite)`、`getStatus()` 供运行时和自定义适配接线，不让业务自行生成身份周期或 JSONL。

| 方法                         | 返回                       | 生命周期与失败                                          |
| ---------------------------- | -------------------------- | ------------------------------------------------------- |
| `setOwner(ownerKey)`         | Promise void               | 安装句柄使用单参数；匿名为 null，切换身份使旧上下文失效 |
| `flush()`                    | Promise void               | 请求刷出待写队列；结合健康状态确认是否失败              |
| `readSummary()`              | `Promise<LogFileSummary>`  | 当前身份的 `fileCount` 与 `bytes`；失败拒绝             |
| `clear()`                    | `Promise<LogClearResult>`  | success、partial 或 failed，按实际结果反馈              |
| `createSnapshot()`           | `Promise<LogSnapshot>`     | 当前实例与身份的只读句柄，含 id、bytes、identityEpoch   |
| `readSnapshot(snapshot)`     | Promise string             | 读取受控 JSONL；过期、错误身份或读取失败会拒绝          |
| `releaseSnapshot(snapshot)`  | Promise void               | 删除尚未交付的快照；失败可重试                          |
| `takeSnapshotFile(snapshot)` | `Promise<LogSnapshotFile>` | 转移文件所有权，原快照句柄立即失效                      |
| `dispose()`                  | void                       | 释放本实例；不会替接收方释放已交付文件                  |

`LogClearResult`：success 仅含 `status`；partial 还含 `removedFiles`、`remainingFiles`、`message`；failed 含 `code`、`message`。不要将 partial 当作全部清理完成。

## 文本快照

```ts
import type { LoggingHandle } from '@unif/react-native-logger';

export async function readDiagnostics(logging: LoggingHandle) {
  const snapshot = await logging.createSnapshot();
  try {
    return await logging.readSnapshot(snapshot);
  } finally {
    await logging.releaseSnapshot(snapshot);
  }
}
```

调用方处理创建、读取和释放错误。未交付的快照随身份切换、清理或实例释放失效；不能序列化后恢复、跨实例使用或并发重复交接。

## 文件交接

```ts
import type { LoggingHandle } from '@unif/react-native-logger';

export async function shareDiagnostics(
  logging: LoggingHandle,
  shareFile: (uri: string) => Promise<void>,
) {
  const snapshot = await logging.createSnapshot();
  const file = await logging.takeSnapshotFile(snapshot).catch(async (error) => {
    await logging.releaseSnapshot(snapshot);
    throw error;
  });
  try {
    await shareFile(file.uri);
  } finally {
    await file.release();
  }
}
```

交接成功后，`LogSnapshotFile` 包含只读 `uri`、`bytes` 和 `release(): Promise<void>`。在接收方异步读取结束后释放；释放成功可重复调用，失败可重试。身份变化、清理和日志实例释放不能提前删除已交付且未释放的文件。

文件管理操作可能拒绝，尤其是身份已切换时清理旧句柄；宿主须捕获并反馈诊断失败。文件导出不自动上传，不决定业务执行结果。
