# plugin-sdk

插件服务 SDK：把「宿主 ↔ 插件服务」的服务协议壳收成一份实现，插件不再各自重写帧编解码、
帧循环、manifest 派生与反向调用通道。

- **定位**：插件侧库，与 `toolchain/` 同级的第一方非载体包。**零内核零宿主依赖**：
  自带规范序列化实现，不 import `packages/*`；`packages/*` 也不 import 本包。
- **依赖方向**：插件经裸导入 `plugin-sdk` 使用。宿主在**准备阶段**把框架安装的顶层
  `plugin-sdk/` 链接进每个物化树的 `node_modules/plugin-sdk`，故插件服务在**任意宿主根**下都能解析它；
  仓库内开发时根 `node_modules/plugin-sdk` 由根 `package.json` 的 `"plugin-sdk": "file:./plugin-sdk"` 提供。
  用链接而非复制：SDK 以 TS 源码发布，Node 的类型剥离对 `node_modules` 下的文件不生效，
  链接经 realpath 指回框架安装目录（不在 `node_modules` 下）。SDK 不进入世界、不随插件打包。
- **三形态**：同一服务实例在 `stdio` 下由 `runStdio` 起帧循环；`inproc` / `worker` 下入口
  导出 `createService({ emit, env })` 供宿主直调。三种形态共用同一派发器，结果与事件一致。

## 公开面

| 模块           | 内容                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| `wire.ts`      | 帧编解码（4 字节大端长度 + 规范 JSON）、`MAX_FRAME_BYTES`、入站 / 出站 kind 集合          |
| `canonical.ts` | 规范序列化（键 code-unit 升序、剔除 undefined、-0 归一、最短往返数字）                    |
| `manifest.ts`  | 读同包 `plugin.json` 派生 manifest、按能力类取声明方法集                                  |
| `service.ts`   | `createService` 派发器、`runStdio` 帧循环、`packageRootOf` / `isDirectRun` / `makeLogger` |
| `port-link.ts` | 反向调用通道 `PortLink`（`port.call` / `port.result` / `port.error`）与 `settlePortLinks` |
| `plan.ts`      | 计划值 helper：`externOnly` / `errorValue` / `isErrorValue` / `mergeDirectives`           |
| `json.ts`      | `Json` / `Rec` / `isRecord` / `asString`                                                  |
| `env.ts`       | 调用帧 `env` 解析与 `nowOf`（固定时钟）                                                   |
| `types.ts`     | `CallEnv` / `CallContext` / `Handler` / `HandlerResult` / `PortCaller`、错误类            |
| `driver.ts`    | 测试驱动 `startService` + `request` + port bridge                                         |

## 派发能力

- **调用身份**：处理器第三参数 `CallContext` 带 `{ callId, port, method, env }`；`callId` 回带进反向调用的
  `call_id` 字段，宿主据此把反向调用归属到正确回合（并发在途不串台）。只关心 `args` / `env` 的处理器可忽略它。
- **反向调用**：`PortLink.call(port, method, args, { callId?, timeoutMs? })`——`callId` 回带发起帧，
  `timeoutMs` 覆盖单次等待上限。`settle` 只结算本链登记过的 id，多链共存互不吞并；
  `createService` 的 `portLinks` 自动结算应答并在 `drain` / 关闭时 `failAll`，插件不必自写 `intercept`。
- **并发方法**：`plugin.json.concurrent_methods`（或 `createService.concurrentMethods`）声明的方法，
  其 `call` 脱出串行链、彼此可并发；`drain` 会等脱链调用落地后再回 `bye`。
- **多能力类**：门禁按帧内 `port` 逐能力类取 `plugin.json.methods` 声明的方法集，多能力类插件无需哨兵键。
- **drain 收口**：stdio 形态在回 `bye` 后等 `onDrain`（可异步）落地再退出进程；inproc / worker 不退出进程，
  由宿主的执行体 teardown 负责。
- **坏帧处理**：`runStdio` 的 `onMalformedFrame` 缺省 `ignore`（记日志后继续，同块内剩余帧照常解）；
  选 `exit` 则协议损坏即退非 0（fail-closed）。

## 插件侧约定

- 方法实现、持久化、领域校验与领域错误码留在插件；错误经 `ServiceError` 子类带码上抛，
  `BadArgsError` 映射 `bad_args`，未知错误映射 `internal`。
- 服务入口同时满足两种调用：导出具名 `createService`（宿主 `inproc` / `worker` 直调），
  直接运行时经 `isDirectRun` 起 stdio 帧循环。

## Rust 侧（`rust/`）

Rust 插件服务同样只写方法实现与领域逻辑，协议壳由 `plugin-sdk` crate（lib `plugin_sdk`）吸收：

| 模块      | 内容                                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wire`    | 帧编解码（4 字节大端 + 规范 JSON）、`MAX_FRAME_BYTES`、`canonical_json`（与 TS `canonical.ts` 逐字节一致）、`log`                                                           |
| `service` | `ServiceSpec` / `manifest` 派生、`ServiceHandler` 派发 trait、`run_service` 帧循环（控制帧 / 在途计数 / 线程派发 / drain 收口）、`ServiceError`、`CallEnv`、`shared_writer` |
| `port`    | `PortLink` 反向调用通道（`port.call` / 应答结算 / `fail_all`），`call_id` 回带由 `service` 的线程局部记录                                                                   |

- `canonical_json` 数字口径与 TS / 内核一致：JS 最短往返 f64 排版（`1e21 → 1e+21`、`1e-6 → 0.000001`、
  `1e-7 → 1e-7`）、`-0 → 0`、键按 UTF-16 code-unit 升序、深度上限 `MAX_JSON_DEPTH`。
- 插件 `Cargo.toml` 以相对路径 `../../plugin-sdk/rust` 依赖 crate；`ServiceHandler` 的 `call` 只接方法名 /
  `args` / `env`，`intercept` 结算反向调用应答、`on_close` 收口未结算调用。
- **任意宿主根**：宿主在准备阶段、依赖恢复 / 构建**之前**，于物化目录两级之上建 `plugin-sdk` 链接
  （任意宿主根下 = `<宿主根>/state/runtime/plugin-sdk`），使该相对路径解析到框架安装的 SDK crate。
  与 TS 侧一样用链接而非复制，宿主只按路径供给、不 import SDK。
- 手工核对：`node tools/rust-sdk-temp-root-check.mjs`——在非仓库临时根下供给 SDK、
  `cargo build --release --offline` 并起服务走 hello / call / drain 往返。
