---
title: 快速开始
description: 安装依赖，初始化一套运行时，并接入身份和日志记录。
---

# 快速开始

## 安装和平台

安装本库与原生文件依赖：

```sh
npm install @unif/react-native-logger react-native-blob-util
cd ios && bundle exec pod install
```

Peer 范围为 React `^19.3.0`、React Native `>=0.88.0`、`react-native-blob-util ^0.25.1`。本仓实际安装版本为 19.3.1／0.88.1／0.25.1，范围声明不代表每个组合都完成设备验证。安装原生依赖后重新编译 iOS／Android 应用。

根入口不加载原生文件 SDK。浏览器 bundler 使用 `browser` 条件时，`/files` 自动解析为内存实现；不需要额外 Web 子入口。内存实现不提供文件、快照或导出能力。

## 应用安装一次

```ts
import { Platform } from 'react-native';
import {
  createLogger,
  installLogging,
  markLoggingUnavailable,
} from '@unif/react-native-logger';
import { createLogFiles } from '@unif/react-native-logger/files';

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
      createId,
      files: createLogFiles({ directoryName: 'SampleLogs', createId }),
      consoleTimeZone: 'Asia/Shanghai',
    });
    await logging.setOwner(null);
    return logging;
  } catch (error) {
    markLoggingUnavailable(undefined, error);
    return null;
  }
}

const log = createLogger('bootstrap');
log.info('initialized', { fields: { count: 1 } });
```

`createId` 使用应用已有的唯一诊断标识生成函数。`service`、字段白名单和启动 scope 在安装时固定；敏感或原型字段会使安装失败。未绑定身份时，仅允许启动 scope。初始化中的配置和存储错误可抛出，调用方处理后决定诊断反馈。

## 身份和应用生命周期

保存安装返回的 `LoggingHandle`。恢复账号后调用 `await logging.setOwner(ownerKey)`，`ownerKey` 由应用提供稳定的身份摘要；匿名使用 `null`。更换身份会使旧操作上下文和未交付快照失效，不能复用旧句柄写入新身份。

应用进入后台时调用 `flush()`；结束使用时先等待需要保留的写入，再调用 `dispose()` 释放 transport、计时器和文件资源。重复安装返回现有运行时，不重新配置策略。组件库不自行安装或切换身份。

## 关联一次操作

```ts
import {
  createLogger,
  createOperationContext,
} from '@unif/react-native-logger';

const log = createLogger('storage');
const context = createOperationContext('user');
log.info('save.started', { context, phase: 'write' });
log.info('save.completed', {
  context,
  outcome: 'success',
  fields: { count: 1 },
});
```

日志不决定操作成功与否。完整参数见 [根 API](api/root.md)；导出文本和文件见 [文件 API](api/files.md)。真实设备入口是仓库的 [原生 example](https://github.com/unif-design/react-native-logger/tree/main/example)，本站不模拟原生落盘。
