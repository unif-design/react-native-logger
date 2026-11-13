---
id: format
slug: /format
title: 日志输出格式
description: 控制台、JSONL、UTC 时间与脱敏的唯一格式契约。
---

# 日志输出格式

本库定义字段、输出顺序、序列化与脱敏规则；调用方提供具体内容，不自行拼接整条日志。

## 可读摘要与隐私

应用可在 `policy.eventDescriptions` 配置固定事件说明，在 `policy.reasonDescriptions` 配置固定原因说明。同一次规范化生成 `fields.summary`，控制台、JSONL、复制与快照采用同一结果。原因依次匹配已登记的 `reason`、`code`、`http.<状态码>`；没有匹配时只给事件说明，不猜测余额、权限或业务结果。

账号、登录号、姓名、联系方式、邮箱、证件、地址及用户资料对象属于敏感字段；认证材料、请求响应正文、`message/text/content` 等自由文本不能进入字段白名单。异常正文统一省略为 `[REDACTED]`，保留安全类型、已知平台码或固定命名空间的应用故障码、有界原因链和源码位置。堆栈只交付定位帧，省略原异常正文与任意帧说明。

启用 console 采集后，开发环境将每次直接调用 console 的参数原样交给原控制台，保留格式串、对象与 Error。正式环境显示固定提示。两种环境的诊断文件都只记录可确认的错误信息，SDK 的自由文本和参数继续脱敏。应用结构化日志显示摘要、状态、关联和源码位置。

描述字典由应用提供固定文案，不包含动态账号、用户输入或服务报文。公共文字脱敏接口能处理带标签的个人信息、号码与凭据，不能识别任意未标注姓名或业务全文；调用方须先投影技术字段并省略自由文本，不能依靠正则替代这一边界。

## 内容归属

- 应用安装时提供 service、可记录字段白名单和启动匿名 scope；各库调用时提供 scope、event、错误码及安全业务上下文。
- 库按实际运行生成 UTC 时间、序号、运行／操作关联与耗时；从真实调用栈或错误中提取受控位置和诊断原因。缺失信息省略，不猜测原始 TS 行号。
- 错误的业务处理、提示文案和 Toast 均归调用方。日志异常只更新健康状态，不替调用方判定成功或失败。

## 控制台

```text
2026-10-29T00:00:00.000Z WARN [sample-app] [storage] write_failed op=run:operation:1 phase=write log_source=save.ts:46:9 error_source=adapter.ts:42:9 reason=storage_full
```

安装时可传 `consoleTimeZone: 'Asia/Shanghai'`，按北京时间（UTC+08:00）展示为：

```text
2026-10-29T08:00:00.000+08:00 WARN [sample-app] [storage] write_failed ...
```

默认值为 `'UTC'`。该参数只改变可读控制台时间，跨日、跨年由库转换，不依赖设备当前时区；参数在本次安装时固定。JSONL、复制诊断和快照的结构化 timestamp 保持 UTC，耗时和事件序号不受影响。只支持上述两个值，不接受任意时区或偏移量。

固定顺序为时间、级别、应用、模块和事件，后续展示实际存在的关联、阶段、错误码、位置及白名单字段。log_source／log_function 是记录点，error_source／error_function 是异常来源，两者不互相替代。字段控制字符转义，可读行不展开错误正文或完整堆栈。

默认后端的结构化记录采用同一格式。显式传入自定义后端时，应用通过 console 选项连接该后端的实际控制台 transport；第三方原始输出不根据文本前缀猜测改写。console 选项同时明确启用原始 console 采集，省略时不替换全局 console。

## 文件与复制诊断

文件为每行一个 JSON 对象的 JSONL，schemaVersion 保持 1；captureError 返回同一次规范化结果。保留 timestamp、sequence、service、level、scope、event、运行与身份周期、环境、操作关联、fields 和经过脱敏的 error。位置使用 source／errorSource 字段，控制台仅将它们转换成可检索的文本名称。

Warn／Error／captureError 有界提取调用点，Info／Debug 不为补位置新建堆栈。原因链最多四层，循环、访问器或裁剪明确标记；绝对路径、认证材料和非白名单原始数据不进入记录。单条上限 8 KiB，裁剪时保留关联与核心字段并标记 truncated。

应用迁移继续传入原 service 及既有策略，保持原目录和身份摘要。组件库仅提供自己的 scope、event 与安全上下文，不创建另一套日志格式。
