# chain-contract

横切契约源：编排环两个包之间、以及编排环与观测环之间的业务契约。`plugin-sdk` 是零业务语义的协议壳，
不承担这些形状；本包就是它们的唯一真源。

契约分两层：

- **语言中立形状**（`schema/`）——JSON Schema，TS 与 Rust 各自校验同一份键名与字段。
- **运行子集**（`src/runtime.ts`）——类型、封闭码集、`validateBag`、结局构造器、`cause` 包裹助手、
  契约版本校验器。**自包含**：不 import 任何模块、不触网、不取时钟。

## 宿主供给、插件裸导入

本包是**第一方非载体包**：不随插件入世、不进世界，也不在插件间生成副本。消费插件运行期**裸导入
`chain-contract`**，由宿主在**准备阶段**把框架安装的 `chain-contract/` 链接进物化树
`node_modules/chain-contract`（与 `plugin-sdk` 同点，依赖恢复之后），故在**任意宿主根**下都能解析。

用链接而非复制：本包以 TS 源码发布（`package.json` 的 `exports` 指向 `./src/index.ts`），Node 类型剥离
对 `node_modules` 下的文件不生效，链接经 realpath 指回框架安装目录（不在 `node_modules` 下），类型剥离
与仓库内解析同路。

由此**插件侧零拷贝**：改 `src/` 无需重新生成任何插件文件，只需换代框架安装。本包不进 `needs` / 路由 /
装配，也不得被插件写链。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/runtime.ts` | 运行子集真源（自包含，不 import 任何模块） |
| `src/index.ts` | 契约源入口，再导出运行子集；`package.json` 的 `exports` 指向它 |
| `schema/interpret-bag.schema.json` | chat -> loop-policy 的 `interpret` bag 形状 |
| `schema/step-record.schema.json` | 回合事件日志五种步记录 |
| `schema/turn-outcome.schema.json` | 回合结局 |
| `schema/contract-version.schema.json` | 契约主版本标记 |
| `fixtures/` | 共享夹具（真实形状），仅测试期 |
| `invariants.ts` | I5 码透传、I6 bag 单真源断言器，仅测试期 |

## 封闭集

两个维度封闭，码本身在结局层是小集、在 `cause` 层开放：

- `attributableTo`（8）：`model` / `tool` / `guard` / `approval` / `graph` / `owner` / `transport` / `budget`；
- 结局层码（`OUTCOME_CODES`）：既有码一律沿用（`model_not_configured` 不是 `model_unconfigured`），
  下游节点的业务码不改名，原样放进 `cause.code`。`cause` 形如
  `{ from: "<命名空间>", code: "<下游原码>", message? }`。

运行期校验一律回结构化结局，不抛异常：插件侧抛异常会经服务协议变成 error 帧，绕开结局契约。

## 契约边界与待对齐项

### `interpret` bag

`schema/interpret-bag.schema.json` 记录生产方 `buildInterpretBag`（`plugins/chat/execute/assemble.ts`）与
chat 方法实际写出的键。消费方（`plugins/loop-policy/execute/`）读取但生产方不写出的键属契约缺口，
已登记在测试的 `allowedConsumerOnly`，逐项列出。

## 用法

```js
import { validateBag, refused, causeOf, checkContractVersion } from 'chain-contract'

const checked = validateBag(bag)
if (!checked.ok) return render(checked.outcome)

const outcome = refused({
  code: 'loop_unavailable',
  attributableTo: 'transport',
  retryable: true,
  cause: causeOf('loop-policy.interpret', 'transport_failed'),
})
```

## 测试

```sh
npm test              # node --test，校验器 / 构造器 / 夹具 / 不变量
```
