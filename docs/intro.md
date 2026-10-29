---
title: Logger 简介
description: 应用与组件库共用的结构化日志和受控文件诊断。
---

# Logger 简介

`@unif/react-native-logger` 提供结构化记录、操作关联、脱敏、身份分区与受控快照。宿主安装一次，各库只记录自己的 scope 和事件。

- [快速开始](quick-start.md)：安装原生依赖、初始化和记录。
- [根 API](api/root.md)：策略、环境、日志、诊断与自定义后端。
- [文件 API](api/files.md)：文件存储、清理与快照所有权。
- [输出格式](FORMAT.md)：同一份控制台和 JSONL 契约。
- [排障](troubleshooting.md)：没有日志、文件失败和身份变化。
- [研发入口](DEVELOPMENT.md)：示例、检查和组织标准。

库不依赖 Portal 业务对象，不创建提示或 Toast，不自动上传。应用负责业务判断、身份来源、目录名称和诊断文件分享。iOS／Android 使用原生文件适配；Web 只提供有界内存，不声明原生鸿蒙支持。

采用 [MIT 许可](https://github.com/unif-design/react-native-logger/blob/main/LICENSE)，保留 [上游署名](https://github.com/unif-design/react-native-logger/blob/main/NOTICE)。
