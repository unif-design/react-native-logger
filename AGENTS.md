# Logger 开发入口

<!-- BEGIN UNIF REACT NATIVE STANDARD -->

## 开发入口

本仓库为 `react-native-logger`，通用工程规范使用 `uni-skills`，项目约定与库能力使用 `unif-portal-dev-skills`。

- 本库能力的接入与排障以本仓公开文档和开发资料为准。
- 目录、文件职责、命名与公共入口使用 `code-organization`。
- React Native 组件、Hook、样式与平台实现使用 `react-native-development`。
- 库创建、维护、打包、发布及运行示例使用 `react-native-library`。
- 文档编写、文档站与生成构建使用 `documentation`。
- 实际开发和修改源码时使用 `unif-portal-dev-skills:code-development`；单纯接口查询不启动开发阶段。
- 设计、测试、审查、交付分别使用同插件的 architecture-design、code-testing、code-review、code-delivery，按需读取所属专题。
- 项目设计、规范来源及实现入口见[开发资料](docs/DEVELOPMENT.md)。

<!-- END UNIF REACT NATIVE STANDARD -->

本库为 `@unif/react-native-logger`。使用 TypeScript 实现 React Native 日志能力，库本体不包含自有原生模块，文件系统通过 `react-native-blob-util` 接入。

开发、架构、测试、审查与交付分别采用 `unif-portal-dev-skills` 的对应技能。范围、接口与本地验证见 README 和 `docs/DEVELOPMENT.md`。不从 Portal 导入业务配置、身份对象、路由或私有类型。

使用 MIT 许可，npm、GitHub Release 与文档站分别按组织交付流程验证。提交、推送、发布及远端配置以当前任务明确授权为准。
