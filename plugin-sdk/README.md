# plugin-sdk

插件服务 SDK：把「宿主 ↔ 插件服务」的服务协议壳收成一份实现，插件不再各自重写帧编解码、
帧循环、manifest 派生与反向调用通道。

- **定位**：插件侧库，与 `toolchain/` 同级的第一方非载体包。**零内核零宿主依赖**：
  自带规范序列化实现，不 import `packages/*`；`packages/*` 也不 import 本包。
- **依赖方向**：插件经裸导入 `plugin-sdk` 使用；仓库根 `package.json` 以
  `"plugin-sdk": "file:./plugin-sdk"` 声明，`npm install` 在根 `node_modules/` 建链接。
  插件与宿主在仓库根下运行时据此解析；SDK 不进入世界、不随插件打包。
- **三形态**：同一服务实例在 `stdio` 下由 `runStdio` 起帧循环；`inproc` / `worker` 下入口
  导出 `createService({ emit, env })` 供宿主直调。三种形态共用同一派发器，结果与事件一致。

## 公开面

| 模块           | 内容                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| `wire.ts`      | 帧编解码（4 字节大端长度 + 规范 JSON）、`MAX_FRAME_BYTES`、入站 / 出站 kind 集合          |
| `canonical.ts` | 规范序列化（键 code-unit 升序、剔除 undefined、-0 归一、最短往返数字）                    |
| `manifest.ts`  | 读同包 `plugin.json` 派生 manifest                                                        |
| `service.ts`   | `createService` 派发器、`runStdio` 帧循环、`packageRootOf` / `isDirectRun` / `makeLogger` |
| `port-link.ts` | 反向调用通道 `PortLink`（`port.call` / `port.result` / `port.error`）                     |
| `plan.ts`      | 计划值 helper：`externOnly` / `errorValue` / `isErrorValue` / `mergeDirectives`           |
| `json.ts`      | `Json` / `Rec` / `isRecord` / `asString`                                                  |
| `env.ts`       | 调用帧 `env` 解析与 `nowOf`（固定时钟）                                                   |
| `types.ts`     | `CallEnv` / `Handler` / `HandlerResult` / `PortCaller`、`ServiceError` / `BadArgsError`   |
| `driver.ts`    | 测试驱动 `startService` + `request` + port bridge                                         |

## 插件侧约定

- 方法实现、持久化、领域校验与领域错误码留在插件；错误经 `ServiceError` 子类带码上抛，
  `BadArgsError` 映射 `bad_args`，未知错误映射 `internal`。
- 服务入口同时满足两种调用：导出具名 `createService`（宿主 `inproc` / `worker` 直调），
  直接运行时经 `isDirectRun` 起 stdio 帧循环。
