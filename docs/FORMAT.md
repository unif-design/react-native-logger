# 日志输出格式

本库定义字段、输出顺序、序列化与脱敏规则；调用方提供具体内容，不自行拼接整条日志。

## 内容归属

- 应用安装时提供 service、可记录字段白名单和启动匿名 scope；各库调用时提供 scope、event、错误码及安全业务上下文。
- 库按实际运行生成 UTC 时间、序号、运行／操作关联与耗时；从真实调用栈或错误中提取受控位置和诊断原因。缺失信息省略，不猜测原始 TS 行号。
- 错误的业务处理、提示文案和 Toast 均归调用方。日志异常只更新健康状态，不替调用方判定成功或失败。

## 控制台

```text
2026-10-29T00:00:00.000Z WARN [sample-app] [storage] write_failed op=run:operation:1 phase=write log_source=save.ts:46:9 error_source=adapter.ts:42:9 reason=storage_full
```

固定顺序为时间、级别、应用、模块和事件，后续展示实际存在的关联、阶段、错误码、位置及白名单字段。log_source／log_function 是记录点，error_source／error_function 是异常来源，两者不互相替代。字段控制字符转义，可读行不展开错误正文或完整堆栈。

默认后端的结构化记录采用同一格式。显式传入自定义后端时，应用通过 console 选项连接该后端的实际控制台 transport；第三方原始输出不根据文本前缀猜测改写。console 选项同时明确启用原始 console 采集，省略时不替换全局 console。

## 文件与复制诊断

文件为每行一个 JSON 对象的 JSONL，schemaVersion 保持 1；captureError 返回同一次规范化结果。保留 timestamp、sequence、service、level、scope、event、运行与身份周期、环境、操作关联、fields 和经过脱敏的 error。位置使用 source／errorSource 字段，控制台仅将它们转换成可检索的文本名称。

Warn／Error／captureError 有界提取调用点，Info／Debug 不为补位置新建堆栈。原因链最多四层，循环、访问器或裁剪明确标记；绝对路径、认证材料和非白名单原始数据不进入记录。单条上限 8 KiB，裁剪时保留关联与核心字段并标记 truncated。

应用迁移继续传入原 service 及既有策略，保持原目录和身份摘要。组件库仅提供自己的 scope、event 与安全上下文，不创建另一套日志格式。
