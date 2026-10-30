---
id: development
slug: /development
title: 研发入口
description: 工程标准、真实消费者、文档同源与分层验证。
---

# 工程与接入边界

## 依据

- 上游模板：create-react-native-library 0.63.1，`type=library`、`languages=js`。库本体无自有 iOS／Android 模块；example 使用官方 RN 0.88.1 模板。
- 组织标准：unif-design/.github 的 main `c730bf65623a4dc938714771aaa24dd53e141a0b`，通过 `scripts/sync-repo.sh` 同步本库适用内容。CI、release、PR 标题／审查、共享 Actions、Lefthook、安全和 Issue 模板保持组织来源。
- 功能依据：Portal 当前日志契约、文件摘要／快照交接，以及 unif-platform-architecture 的日志与独立验证规则。

模板存在不证明远端规则、CI、npm 发布或文档部署已经完成；各项交付按组织流程分别读取实际结果。本库包含 Docusaurus 文档站，没有自有 native 源码。

通用规范使用 `uni-skills`：`code-organization` 说明目录与文件组织，`react-native-development` 说明 RN 实现要求，`react-native-library` 说明独立库与消费者验证，`documentation` 说明文档与文档站维护。Unif 的设计、测试、审查和交付按 `unif-portal-dev-skills` 对应技能执行；本库接口与行为以公开类型和有效契约为准。

## 实现归属

`backend` 承接已有基础日志分发实现，保持级别、transport 错误隔离和重入语义；源许可见 NOTICE。应用结构化记录、统一诊断、文件队列、身份与快照保护从 Portal 原实现提取。

公开记录默认不依赖安装状态之外的业务对象。应用策略、目录、设备信息、身份来源、日志管理页面及文件分享继续由应用提供。核心不复制业务事件清单或企业域名，不依赖 Agent 契约。

公共代码入口只保留根入口和 `/files`，另保留 package.json 元数据。声明与运行产物必须匹配；根入口的记录、安装和脱敏接口不提前加载原生文件模块。`/files` 提供明确 browser 出口，原生平台由对应文件适配操作真实 SDK。

## Portal 接入

正式切换须使用已确认的发行版本。迁移时将 `@/capabilities/logger`、`/runtime`、`/files`、`/normalization` 改为根入口或 `/files`，私有 `/types` 引用改用公开类型；删除被替代的日志核心及已迁入库的单测。

应用保存原 service、字段白名单、启动匿名 scope 和 `PortalLogs` 目录。bootstrap 显式传入这些策略以及现有 Design 后端，保留设备读取、AppState 刷新、既有账号身份摘要和清理／分享入口。不能在包迁移时更换日志目录、身份算法或业务事件。

本地消费验证使用打包后的发行布局，应用生产清单不写临时路径或源码别名。正式迁移前核对应用当前日志实现与拟采用版本的差异，保留任务范围外的工作区修改。

## 其他库接入

新生产者使用根入口 `createLogger(scope)`，宿主统一安装。宿主可通过根入口的 `LogBackend` 契约注入已有 Design 后端；内部 backend 不作为独立公共子入口。其他已发布库按实际消费者逐库验证，不把本库就绪当作它们已经完成迁移。

## 检查

库回归覆盖策略白名单、脱敏、错误原因、级别与 transport 重入、控制台递归、文件队列、轮转、身份切换、快照及清理。另检查打包文件、公开入口、应用初始化和实际消费者。

Jest 的外部文件 SDK 替身不证明手机实际落盘。双端 JS bundle、原生编译、设备验证、远端 CI 和正式发行分别提供证据；本地类型检查不替代这些检查。

## 既有验收记录（2026-10-29）

- 实际库目录完成 Lint、严格类型检查、22 套／445 项回归、Bob ESM／声明构建；缺失 lib 的入口检查已接入 typecheck，随组织 CI 运行。
- 原生示例类型检查及 iOS／Android 生产 JavaScript 打包通过；本轮没有执行原生编译或安装设备。
- 打包产物在没有 Portal、Design 和 RN 安装的隔离消费者中通过当时的根／runtime／Web 文件入口验证；这只证明这些 JS 入口的隔离，不表示原生文件能力无需 SDK。
- Portal 隔离副本使用实际 tarball，保留原日志策略、Design 后端、目录和身份接线，类型检查及 46 套／708 项消费者回归通过。原 Portal 工程尚未采用该打包产物。
- 独立审查发现的示例源码出口及 iOS 缓存输入问题已修复并复核。日志提取未改变 Toast、业务成功判断、重试或原生日志权限。

上述记录对应当时的源码与入口，不表示当前提交、远端 CI 或设备已验收。许可采用 MIT；npm、GitHub Release 和文档站分别验收，不能据本地结果声明发行成功。

## 控制台时区与产物验收增补（2026-10-29）

基于本地初始化提交 `e02b8f3`，增加 `consoleTimeZone`：默认 UTC，显式 `Asia/Shanghai` 以 UTC+08:00 展示。参数固定于本次安装，文件 JSONL、快照与复制诊断仍采用 UTC，其他字段和身份规则不变。`/files` 及现有目录名称保留。

本增补的 Lint、类型、22 套／456 项回归及 Bob 构建通过；真实 tarball 的公开入口在纽约进程时区下仍输出北京时间，并验证结构化时间不变。Git 忽略规则和 npm 文件白名单分别检查：当前跟踪文件没有生成物或本地配置，必要的示例 debug keystore、锁文件和 Yarn 运行时保留。未重跑原生编译、设备或远端 CI，也未切换 Portal 正式依赖。

## 文档站与当前检查

`website/docs` 指向仓库 `docs`，Docusaurus 和 LLM 资料使用同一批 Markdown，`FORMAT.md` 不复制维护。首页仅使用已发布 Design 的 `docs-home.css`；不依赖原生预览或 RN Web 模拟。

```sh
yarn install --immutable
yarn lint
yarn typecheck
yarn test --runInBand
yarn build
yarn example typecheck
node website/scripts/build-llms.test.js
yarn website typecheck
yarn website build
```

LLM 构建实现由组织 `.github/templates/llms` 维护，通过组织 `scripts/sync-llms.cjs react-native-logger` 同步；不要在库内修改共享实现。公共出口回归检查根 API、原生隔离和 exports 白名单，类型检查同时验证没有 lib 产物时的 example。分发验收还应使用真实 tarball 验证根入口和 `/files` 的 browser 条件。
