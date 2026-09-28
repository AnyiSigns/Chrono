# chain-contract

横切契约源：编排环两个包之间、以及编排环与观测环之间的业务契约。`plugin-sdk` 是零业务语义的协议壳，
不承担这些形状；本包就是它们的唯一真源。

契约分两层：

- **语言中立形状**（`schema/`）——JSON Schema，TS 与 Rust 各自校验同一份键名与字段。
- **运行子集**（`src/runtime.ts`）——类型、封闭码集、`validateBag`、结局构造器、`cause` 包裹助手、
  契约版本校验器。**自包含**：不 import 任何模块、不触网、不取时钟。

## 为什么生成而不是 import

运行期代码不在插件之间共享，而是由 `tools/generate.mjs` 从 `src/runtime.ts` **生成**进各消费插件的
`execute/contract/index.ts`：

- 插件不得 import `packages/*`，也不得互相 import（`docs/plugins.md` 红线 1 / 4）；
- UI 浏览器半边的 esbuild 打包早于宿主供给 SDK，运行期只能拿到插件树内的文件；
- 生成物随插件世代入世、随回滚一致，不需要宿主供给，也不要求解冻 `packages/`。

生成物**不留任何 import**，可随插件入世，也可在浏览器半边运行。手改生成物会造成漂移，
由生成头里的源哈希与 `tools/check-drift.mjs` 静态比对兜住。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/runtime.ts` | 运行子集真源（生成源，勿手改生成物） |
| `src/index.ts` | 契约源入口，再导出运行子集供根测试取用 |
| `schema/interpret-bag.schema.json` | chat -> loop-policy 的 `interpret` bag 形状 |
| `schema/step-record.schema.json` | 回合事件日志五种步记录 |
| `schema/turn-outcome.schema.json` | 回合结局 |
| `schema/retrieval-search.schema.json` | `retrieval.search` bag（TS 发、Rust 收） |
| `schema/contract-version.schema.json` | 契约主版本标记 |
| `fixtures/` | 共享夹具（真实形状），仅测试期 |
| `invariants.ts` | I5 码透传、I6 bag 单真源断言器，仅测试期 |
| `tools/generate.mjs` | 生成器 |
| `tools/check-drift.mjs` | 生成物漂移检查 |

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

### `retrieval.search` bag

权威键名取自消费方 `memory-retrieval` 的既有契约（`src/bag.rs` / `src/config.rs` 与 `schema/retrieval.json`）：
工作区键是 **`workspace`**，预算键是 **`recall_budget`**。生产方 `plugins/loop-policy/execute/dispatch.ts`
已按权威键名发出，三键逐键对齐（此前的 `workspace_id` / `budget` 错位已修）：

| 权威键 | 生产方发出的键 | 生产方位置 | 消费方位置 |
| --- | --- | --- | --- |
| `workspace` | `workspace` | `plugins/loop-policy/execute/dispatch.ts`（源值取内部键 `workspace_id`） | `plugins/memory-retrieval/src/bag.rs` |
| `recall_budget` | `recall_budget` | `plugins/loop-policy/execute/dispatch.ts`（源值取内部键 `budget`） | `plugins/memory-retrieval/src/config.rs` |
| `query` | `query` | `plugins/loop-policy/execute/dispatch.ts` | `plugins/memory-retrieval/src/bag.rs` |

契约以权威键名冻结；跨语言双向断言（TS 发、Rust 收）见
`tests/contract/loop-policy-retrieval.seam.contract.test.mjs`。本包不改任何一侧的代码。

## 用法

```js
import { validateBag, refused, causeOf, checkContractVersion } from './execute/contract/index.ts'

const checked = validateBag(bag)
if (!checked.ok) return render(checked.outcome)

const outcome = refused({
  code: 'loop_unavailable',
  attributableTo: 'transport',
  retryable: true,
  cause: causeOf('loop-policy.interpret', 'transport_failed'),
})
```

## 生成与漂移检查

```sh
npm run generate      # node tools/generate.mjs，派生三份 execute/contract/index.ts
npm run check-drift   # node tools/check-drift.mjs，逐份比对并点名漂移文件
npm test              # node --test，校验器 / 构造器 / 夹具 / 不变量
```

生成脚本以 `src/` 全部 TS 文件计算源哈希写进生成头；漂移检查重新派生逐字节比对，任一份不一致即退出码 1。
