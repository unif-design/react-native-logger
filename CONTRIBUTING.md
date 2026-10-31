# 参与开发

本仓使用 Yarn workspaces，包含日志库、`example/` 原生应用与 `website/` 文档站。先阅读[开发资料](docs/DEVELOPMENT.md)和[输出格式契约](docs/FORMAT.md)。交流遵循[行为准则](CODE_OF_CONDUCT.md)，安全问题使用[安全报告入口](SECURITY.md)。

## 开发与检查

使用 `.nvmrc` 与 `package.json` 指定的 Node／Yarn，在仓库根目录执行：

```sh
yarn install --immutable
yarn lint
yarn typecheck
yarn test --runInBand
yarn build
yarn example typecheck
yarn website typecheck
node website/scripts/build-llms.test.js
yarn website build
```

公开接口位于包根和 `/files`。修改时同步类型、示例和文档，保留脱敏、身份隔离、队列限制及快照释放契约。根入口不应加载原生文件 SDK，组件库只记录日志，由应用统一安装运行时。

文档源位于 `docs/`，网站与 LLM 资料共用这批 Markdown；生成器由 `github-delivery` 的 `templates/llms` 维护，修改文档后执行本库构建，不手改生成结果。

## 原生示例

[`example/App.tsx`](example/App.tsx) 使用当前库公开入口，展示记录、快照读取和清理。执行这些操作会写入或删除示例应用自己的日志。

从仓库根目录运行 `yarn example start`，另开终端运行 `yarn example android` 或 `yarn example ios`。iOS 首次接入或原生依赖更新后，先在 `example/` 执行 `bundle install` 和 `bundle exec pod install --project-directory=ios`。

外部文件 SDK 的替身测试不证明实际落盘。按变更影响分别检查 JS 打包、原生构建、身份切换、文件写入和快照交接；设备与真实业务验收单独记录。

## 提交与交付

调整公开 API 或既有实现行为前，先通过 issue 与维护者确认范围；已获授权的任务按确认范围执行。提交与 PR 标题、正文使用中文，保留 Conventional Commits 类型前缀。CI 与发布配置由 `github-delivery` 的模板和工具维护，Unif 组织值落实为本库 `.github/organization.json`；检查入口见[交付配置与检查](docs/DEVELOPMENT.md#交付配置与检查)。正式发行沿用本库 PR、发布机器人和 npm Trusted Publisher 流程，具体操作以当前任务授权为准。保留许可与 [NOTICE](NOTICE) 中的上游署名。
