---
title: 排障
description: 定位安装、字段过滤、身份切换、原生文件与快照失败。
---

# 排障

## 没有记录

先读取 `getLogStatus()`，确认 `installed`、`state`、`writable`、`lastFailureCode`。未安装时日志静默返回；身份未绑定时仅接受 `startupScopes`，生产环境跳过 debug。字段不在 `allowedFields` 或包含敏感内容时会被过滤。

确认所有生产者使用同一 Logger 实例。各库将 Logger 声明为 peer dependency，不内嵌另一份运行时。不要通过再次安装去覆盖已固定的策略。

## 原生文件不可用

核对 `react-native-blob-util` 已安装、iOS Pods 已同步且应用已重新构建；仅重启 Metro 不会安装原生模块。检查目录名称满足 [文件 API](api/files.md) 的约束，并读取受控的 `lastFailure` 判断存储空间、权限或 IO 错误。

本库目录位于应用私有存储，不应为日志擅自增加相册、任意外部目录或业务上传权限。浏览器消费只支持内存，`logger.files.unsupported` 是明确能力边界。

## 身份或快照失效

`logger.files.identity_changed` 或 `logger.files.snapshot_invalid` 常见于账号切换后继续使用旧句柄、交接后再读原快照、跨实例使用或重复释放。以当前身份重新创建快照。已交付文件只能由接收方调用返回的 `release()`；不要提前释放正在分享的文件。

`clear()` 返回 partial 时仍有文件未删除，应按结果处理；不要把尝试清理当作清理成功。日志健康状态不影响原业务结果。

## 时间或控制台看起来不同

`consoleTimeZone` 只支持 UTC 和 Asia/Shanghai。JSONL 中的 `timestamp` 始终为 UTC，不随设备时区或控制台选项变化。默认不采集全局 console；显式启用时连接后端真实的 transport，不手工拼接整条日志。

## 如何提交复现

在 [GitHub Issues](https://github.com/unif-design/react-native-logger/issues) 提供版本、平台、最小步骤、受控错误码和已脱敏的必要输出。不要附原始账号、令牌、请求体或完整业务日志。检查命令和设备验证边界见 [研发入口](DEVELOPMENT.md)。
