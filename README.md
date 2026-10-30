# @unif/react-native-logger

React Native 结构化日志库，提供操作关联、敏感信息脱敏、文件轮转、身份分区和诊断快照。日志失败不改变业务结果，库不自动上传日志。

[文档站](https://unif-design.github.io/react-native-logger/) · [快速开始](docs/quick-start.md) · [API](docs/api/root.md) · [原生示例](example/App.tsx) · [npm](https://www.npmjs.com/package/@unif/react-native-logger) · [MIT 许可证](LICENSE)

## 接入要求

| 依赖                   | 支持范围   | 本仓开发组合 |
| ---------------------- | ---------- | ------------ |
| React                  | `^19.3.0`  | 19.3.1       |
| React Native           | `>=0.88.0` | 0.88.1       |
| react-native-blob-util | `^0.25.1`  | 0.25.1       |

iOS／Android 通过 BlobUtil 操作文件。Web 的 `/files` 入口使用有界内存，不支持文件或快照；原生鸿蒙不在本包范围内。根入口不加载原生文件 SDK，也不依赖 Design。开发组合不表示整个支持范围均已通过设备验证。

## 安装与初始化

1. 安装日志库和文件依赖：

   ```sh
   npm install @unif/react-native-logger react-native-blob-util@^0.25.1
   ```

2. iOS 同步 Pods，再重新构建原生应用。
3. 应用按[初始化示例](docs/quick-start.md#应用安装一次)调用一次 `installLogging`，提供日志策略、环境、唯一标识函数和文件存储，并保存返回句柄。使用 `setOwner(null)` 绑定匿名身份，登录后传入应用的身份摘要。

组件库只记录日志，由应用统一安装运行时。未安装时普通记录会静默返回，`captureError` 返回 `null`，因此应先完成上面的初始化。

## 记录事件

在已初始化的应用或组件库中使用：

```ts
import { createLogger } from '@unif/react-native-logger';

const log = createLogger('camera');
log.warn('capture.unavailable', { code: 'camera.permission_denied' });
```

`camera` 是日志模块，`capture.unavailable` 是事件。需要记录附加字段时，由应用在安装策略中设置白名单，详见[结构化记录](docs/api/root.md#createloggerscope)。默认不采集全局 console。

应用负责身份变化、后台 `flush()` 和结束使用时的 `dispose()`。快照文件应在接收方完成读取后释放，具体交接与失败处理见[文件 API](docs/api/files.md)。`captureError` 返回的 JSONL 文本不代表日志已落盘。

## 更多用法

- [根 API](docs/api/root.md)：策略、操作关联、健康状态、脱敏和自定义后端。
- [文件 API](docs/api/files.md)：目录配置、保留限额、清理和快照所有权。
- [输出格式](docs/FORMAT.md)：控制台、UTC 时间、JSONL 与脱敏契约。
- [原生示例](example/App.tsx)与[开发资料](docs/DEVELOPMENT.md)：实际文件操作、检查和交付流程。

上游日志分发实现的署名与许可保留在 [NOTICE](NOTICE)。
