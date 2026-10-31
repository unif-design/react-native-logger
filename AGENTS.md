# Logger 开发入口

<!-- BEGIN GITHUB DELIVERY STANDARD -->

## 开发入口

本库为 `@unif/react-native-logger`（仓库 `react-native-logger`）。

按当前任务选择适用且已安装的技能；项目约定与库能力以本仓库的实际文档和源码为准。

项目设计、约定和实现入口见[开发资料](docs/DEVELOPMENT.md)。

<!-- END GITHUB DELIVERY STANDARD -->

本库为 `@unif/react-native-logger`。使用 TypeScript 实现 React Native 日志能力，库本体不包含自有原生模块，文件系统通过 `react-native-blob-util` 接入。

开发、架构、测试、审查与交付分别采用 `unif-portal-dev-skills` 的对应技能。范围、接口与本地验证见 README 和 `docs/DEVELOPMENT.md`。不从 Portal 导入业务配置、身份对象、路由或私有类型。

使用 MIT 许可，npm、GitHub Release 与文档站分别按组织交付流程验证。提交、推送、发布及远端配置以当前任务明确授权为准。
