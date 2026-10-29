# 工程与接入边界

## 依据

- 上游模板：create-react-native-library 0.63.1，`type=library`、`languages=js`。库本体无自有 iOS／Android 模块；example 使用官方 RN 0.88.1 模板。
- 组织标准：unif-design/.github 的 main `c730bf65623a4dc938714771aaa24dd53e141a0b`，通过 `scripts/sync-repo.sh` 同步本库适用内容。CI、release、PR 标题／审查、共享 Actions、Lefthook、安全和 Issue 模板保持组织来源。
- 功能依据：Portal 当前日志契约、文件摘要／快照交接，以及 unif-platform-architecture 的日志与独立验证规则。

模板存在不证明远端规则、CI 或发布权限已经配置。当前没有执行 setup-repo、推送、远端 CI 或发布；没有 website 和自有 native 源码，不生成对应空模板。

## 实现归属

`backend` 承接已有基础日志分发实现，保持级别、transport 错误隔离和重入语义；源许可见 NOTICE。应用结构化记录、统一诊断、文件队列、身份与快照保护从 Portal 原实现提取。

公开记录默认不依赖安装状态之外的业务对象。应用策略、目录、设备信息、身份来源、日志管理页面及文件分享继续由应用提供。核心不复制业务事件清单或企业域名，不依赖 Agent 契约。

公开子入口按功能分开。声明与运行产物必须匹配；根入口、runtime、normalization 不提前加载原生文件模块。`/files` 提供明确 browser 出口，原生平台由对应文件适配操作真实 SDK。

## Portal 接入

正式切换须使用已确认的发行版本。迁移时将 `@/capabilities/logger`、`/runtime`、`/files`、`/normalization` 改为对应包入口，私有 `/types` 引用改用公开类型；删除被替代的日志核心及已迁入库的单测。

应用保存原 service、字段白名单、启动匿名 scope 和 `PortalLogs` 目录。bootstrap 显式传入这些策略以及现有 Design 后端，保留设备读取、AppState 刷新、既有账号身份摘要和清理／分享入口。不能在包迁移时更换日志目录、身份算法或业务事件。

本地消费验证使用打包后的发行布局，应用生产清单不写临时路径或源码别名。Portal 工作区仍有其他任务的修改，正式迁移前核对当前日志源与本库快照差异。

## 其他库接入

新生产者使用根入口 `createLogger(scope)`，宿主统一安装。Design 现有基础日志出口可在正式采用本包后委托 `/backend`，保留已有公开签名；其他已发布库按实际消费者逐库验证，不把本库就绪当作它们已经完成迁移。

## 检查

库回归覆盖策略白名单、脱敏、错误原因、级别与 transport 重入、控制台递归、文件队列、轮转、身份切换、快照及清理。另检查打包文件、公开入口、应用初始化和实际消费者。

Jest 的外部文件 SDK 替身不证明手机实际落盘。双端 JS bundle、原生编译、设备验证、远端 CI 和正式发行分别提供证据；本地类型检查不替代这些检查。

## 本地候选验证（2026-10-29）

- 实际库目录完成 Lint、严格类型检查、22 套／445 项回归、Bob ESM／声明构建；缺失 lib 的入口检查已接入 typecheck，随组织 CI 运行。
- 原生示例类型检查及 iOS／Android 生产 JavaScript 打包通过；本轮没有执行原生编译或安装设备。
- 打包产物在没有 Portal、Design 和 RN 安装的隔离消费者中通过根／runtime／Web 文件入口验证；这只证明这些 JS 入口的隔离，不表示原生文件能力无需 SDK。
- Portal 隔离副本使用实际 tarball，保留原日志策略、Design 后端、目录和身份接线，类型检查及 46 套／708 项消费者回归通过。原 Portal 工程尚未采用候选包。
- 独立审查发现的示例源码出口及 iOS 缓存输入问题已修复并复核。日志提取未改变 Toast、业务成功判断、重试或原生日志权限。

组织标准模板已落地；远端保护、CI 注册、Trusted Publisher、发布可见性和许可证仍须按后续明确交付范围确认。当前未提交、推送或发布，不能据本地结果声明远端／设备验收完成。
