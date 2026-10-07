# 插件作者指南

面向**插件作者**：一个插件怎么写、它和宿主是什么关系、多个插件怎么组成一套系统。
字段的完整规范见 `docs/plugins.md`；协议细节见 `docs/protocol.md`。

> 本仓库是**框架源码**，不含任何生产插件；`fixtures/plugins/**` 为测试夹具。下面所有形状都对应真实代码（`plugin-sdk/decl.ts`、
> `plugin-sdk/service.ts`、`packages/host`），可对照 `fixtures/plugins/*` 的测试夹具理解。

## 0. 一句话

**插件 = 一个 npm 包**，里面声明「我提供什么能力、需要谁的能力、怎么启动」，并实现自己的服务方法。
宿主负责：读世界、按 `needs` 装配、路由调用、管生命周期。插件之间**不直连、不 import、不开端口**。

## 1. 插件与宿主的关系

```
                   声明(plugin.json)              服务(execute/)
用户/客户端 ──socket──► 宿主 ──装配+路由──► 插件服务进程 ──stdio管道──► 你的方法
                        │  ▲
                        │  └── needs 注入(pins / manyNeeds)
                        └── 世界(唯一定义真源)：按 needs 图决定谁连谁
```

- 宿主是**唯一写世界的人**；插件服务**永不写链**，只能经调用返回结果 / 发事件。
- 插件与其它插件的耦合**只写能力类名 + 方法名**（`needs`），实际连路由由宿主按世界解析。
- 调用分两个方向：**宿主 → 插件**（`call`，你的 handler），**插件 → 宿主**（`port.call`，反向调用，
  宿主再按你的 `needs` 路由到别的插件或宿主能力）。

## 2. 最小插件：目录

```
my-plugin/
├── package.json      # npm 信封；可选 "chrono": { "plugin": "plugin.json", "api": 1 }
├── plugin.json       # 插件契约（宿主解释）
├── README.md         # 人读自述（必需，会入世）
├── .worldignore      # 入世排除表（可选）
├── execute/          # 服务源码 / 产物
│   └── main.mjs
├── terms/            # term 判定产物（可选，入世）
├── terms.src/        # 判定糖化源（可选，不入世）
└── schema/           # 声明 schema（可选）
```

## 3. 第一个插件：echo（完整可跑）

`package.json`：

```json
{ "name": "my-echo", "version": "0.0.0", "chrono": { "plugin": "plugin.json", "api": 1 } }
```

`plugin.json`：

```json
{
  "identity": "my-echo",
  "implements": ["echo"],
  "methods": { "echo": ["say"] },
  "start": "node execute/main.mjs",
  "build": [],
  "protocol": "1",
  "restart": {
    "policy": "on-exit",
    "backoff": "none",
    "max": 3,
    "window_ms": 60000,
    "drain_ms": 500
  },
  "health": { "interval_ms": 10000, "timeout_ms": 1000 },
  "state": "recomputable",
  "members": [
    { "kind": "execute", "path": "execute/" },
    { "kind": "term", "path": "terms/" },
    { "kind": "schema", "path": "schema/" }
  ],
  "commands": [{ "name": "echo.say", "entry": "terms/say.json" }]
}
```

`execute/main.mjs`（用 `plugin-sdk` 的 `defineService`，同一份代码兼容三种 transport）：

```js
import { defineService, ServiceError, packageRootOf } from 'plugin-sdk'

export const createService = defineService({
  entry: import.meta.url,
  capability: 'echo',
  setup(ctx) {
    return {
      handlers: {
        say: (args, env, call) => {
          if (args === null || typeof args !== 'object' || typeof args.text !== 'string') {
            throw new ServiceError('bad_args', 'text must be a string')
          }
          return { value: { echo: args.text, run: env.run, by: call.port }, events: [] }
        },
      },
    }
  },
})
```

`terms/say.json`（命令入口 term：把命令参数原样转给自己服务的 `echo.say`；这里是手写 AST，等价糖化源与编译见 §8）：

```json
["eff", "echo", "say", ["v", 0]]
```

`.worldignore`：

```
test/
```

加入并运行：

```
chrono add ./my-plugin       # 你的世界里
chrono start
chrono echo.say '{"text":"hi"}'   # 命令形式；或经 run / 客户端调用
```

要点：

- `defineService` 返回的工厂**同时**满足两种调用：直接运行时自动起 stdio 帧循环；被宿主 `inproc` / `worker`
  载入时导出 `createService` 供直调。**三形态结果逐字节一致**——同一派发器。
- handler 签名 `(args, env, call) => { value, events }` 或返回 Promise。`args` 是 JSON 对象或 `null`；
  `env` 是宿主填的 `{ run, thread, now, emitter }`（**时间只能取 `env.now`**）；`call` 是 `{ callId, port, method, env }`。
- 失败抛 `BadArgsError`（映射 `bad_args`）或 `ServiceError('code', 'msg')`（映射你的稳定错误码）；
  未知异常映射 `internal`。**错误作数据、不崩进程**。

## 4. `plugin.json` 字段

必填 10 个、可省略 9 个，共 19 个（完整语义与约束见 `docs/plugins.md` §二）：

| 字段                 | 必填 | 作用                                                                                         |
| -------------------- | ---- | -------------------------------------------------------------------------------------------- |
| `identity`           | 是   | 世界里的身份名（安全单段名，不得为 `host`）                                                  |
| `implements`         | 是   | 本插件**提供**的能力类名列表                                                                 |
| `methods`            | 否   | `能力类 → [方法名]`；省略即 `{}`，方法契约单源在拥有方 `slots`                               |
| `start`              | 是   | 启动命令；空串 = 无执行件（纯数据 / 判定身份）                                               |
| `build`              | 是   | 构建声明 `[{cmd,args}]`；`[]` = 无需构建                                                     |
| `protocol`           | 是   | 服务协议版本（当前 `"1"`）                                                                   |
| `restart` / `health` | 是   | 重启策略 / 健康探测                                                                          |
| `state`              | 是   | `recomputable`（可重算缓存）/ `durable`（不可重算运行数据）                                  |
| `members`            | 是   | 入世成员 `{kind:'execute'                                      \| 'term' \| 'schema', path}` |
| `commands`           | 是   | 命名入口 `{name, entry, argsSchema?, readonly?}`                                             |
| `schema`             | 否   | 默认声明 schema 路径                                                                         |
| `needs` / `slots`    | 否   | 依赖（能力类）/ 提供契约（拥有方方法集）                                                     |
| `judgments`          | 否   | 由 term 承载的能力方法 `{cap:{method:'terms/xx.json'}}`                                      |
| `concurrent_methods` | 否   | 可并发执行的方法（脱出串行链）                                                               |
| `transport`          | 否   | `stdio`（缺省）/ `inproc` / `worker`                                                         |
| `hot`                | 否   | `auto`（缺省）/ `manual` / `off` —— 来源热更跟随策略                                         |
| `exclusive`          | 否   | 独占资源类（`port` / `data`；`data` 须配 `state:'durable'`）                                 |

## 5. 服务怎么写

- **入口**：`execute/main.mjs`（或 `.js/.ts`），用 `defineService({ entry, capability, setup })`；
  `setup` 返回 `{ handlers, portLinks?, concurrentMethods?, intercept?, onReload?, onDrain?, onClose? }`。
- **三形态**由 `plugin.json.transport` 选：
  - `stdio`（缺省）：`start: "node execute/main.mjs"`，宿主 spawn 子进程、走 stdin/stdout 帧。
  - `inproc` / `worker`：`start: "execute/main.mjs"`（**同语言入口模块路径**，不能带空白/命令），
    宿主 import 该模块、调用导出的 `createService(ctx)`；`worker` 独立堆，`inproc` 与宿主同线程。
- **反向调用**（服务 → 别的插件 / 宿主）：用 `PortLink`：

```js
import { defineService, PortLink } from 'plugin-sdk'

export const createService = defineService({
  entry: import.meta.url,
  capability: 'orchestrator',
  setup(ctx) {
    const link = new PortLink({ write: ctx.emit }) // stdio 下可省略 write
    return {
      handlers: {
        run: async (args, env, call) => {
          const out = await link.call(
            'agent.llm',
            'complete',
            { prompt: args.prompt },
            { callId: call.callId },
          )
          return out.ok
            ? { value: out.value, events: [] }
            : { value: { error: out.code }, events: [] }
        },
      },
      portLinks: [link], // SDK 自动结算应答帧
    }
  },
})
```

- **事件**：handler 返回的 `events: [{ topic, payload }]` 由宿主透传给发起者（不落账、不推进）。
- **drain**：`runStdio` 收到 `drain` 会等 `onDrain` 落地再退进程；inproc / worker 由宿主 teardown 负责。

## 6. 插件之间怎么组合（`needs`）

插件**不互相调用、不互相 import**，只声明：

```json
{
  "identity": "orchestrator",
  "implements": ["agent.orchestrator"],
  "needs": {
    "agent.llm": { "mode": "one" },
    "agent.memory": { "mode": "one" },
    "tools": { "mode": "many" }
  }
}
```

- `needs.one`：入世时解析到**唯一提供方身份**并写进该代码世代；运行时按能力类路由。
- `needs.many`：解析到世界里的**一组**提供方（扩展点）；宿主注入成员表。
- `slots`：**拥有方**声明某能力类的方法契约（`{ "cap": { "methods": [...] } }`）；提供方 `implements` 它。
- 宿主起服务时注入：
  - `CHRONO_PLUGIN_PINS`（stdio）/ `ctx.pins`（inproc/worker）：`one` 绑定 `{能力类: 身份名}`。
  - `CHRONO_PLUGIN_MANY_NEEDS` / `ctx.manyNeeds`：`many` 成员 `{能力类: [身份名]}`。
  - `CHRONO_PLUGIN_STATE` / `CHRONO_PLUGIN_DATA`：③/④ 目录。
- 你的代码只写**能力类名 + 方法名**（如 `link.call('agent.llm', 'complete', ...)` 或经命令路由），
  不写对方身份、不写地址、不写端口。

## 7. 组装一套"插件系统"

例如一个 agent 系统：

| 插件             | 提供                   | 需要                                  |
| ---------------- | ---------------------- | ------------------------------------- |
| `orchestrator`   | `agent.orchestrator`   | `agent.llm`(one)、`agent.memory`(one) |
| `llm-openai`     | `agent.llm`            | —                                     |
| `memory-sqlite`  | `agent.memory`         | —                                     |
| `tool-*`（多个） | `tools`（many 扩展点） | —                                     |

宿主会：

1. 按 `needs` 求**依赖闭包**、拓扑排序（依赖者先装配，停机逆序摘除）。
2. 逐个物化（装依赖 / 跑 `build`）、spawn / 载入服务、握手，建立端点表。
3. 运行时按能力类把 `orchestrator` 的调用路由到被绑定的 `llm` / `memory`。
4. **换提供方 = 新代码世代**；提交前有**兼容性门禁**：若新提供方不再覆盖消费方声明的方法契约，整次换代被拒，
   旧版继续服务。**数据世代（term）热生效**，不改进程。

所以你写的插件是"接线图上的端点"，**宿主才是总机 + 路由 + 生命周期**。插件间无需端口、无需直连。

## 8. 判定用 term 承载（`judgments`）

纯判定（选择 / 路由 / 打分）不必写服务，写 term 即可：

```json
{
  "implements": ["router"],
  "methods": { "router": ["select"] },
  "judgments": { "router": { "select": "terms/select.json" } },
  "start": "",
  "members": [
    { "kind": "term", "path": "terms/" },
    { "kind": "schema", "path": "schema/" }
  ]
}
```

- 命中 `judgments` 的方法**就地求值 term**（`args[0]` = 调用参数），**不 spawn 服务、不登记端点**。
- 判定源住 `terms.src/*.json`（糖化），用 `chrono term build <目录>` 编译成 `terms/*.json` **产物**；
  **产物入世**（是定义本体），`terms.src/` **排除**。
- 参考形状：`fixtures/plugins/router`（`judgments`）、`fixtures/plugins/toy-term`（`terms.src/` 糖化 → `terms/` 产物）。

## 9. 命令、schema 与参数校验

- `commands`: `[{ "name": "my-echo.say", "entry": "terms/xxx.json" }]` 把命名入口映射到某个 term/入口；
  `commands[].readonly: true` 表示纯查询（不广播 run、不落审计、不推进链头）。
- `schema`: 声明 schema 路径；命令 `argsSchema` 用 **JSON Schema 白名单子集**校验 `args`，
  不符 → `bad_args`，不跑、不落账。

## 10. 状态与运行目录

- `state: "recomputable"`（默认值；字段必填、不可省略）：可重算缓存 / 索引 / 水位 → `CHRONO_PLUGIN_STATE`（`state/plugins/<id>/`），可随时删。
- `state: "durable"`：不可重算运行数据 → `CHRONO_PLUGIN_DATA`（`state/data/<id>/`），跨代存活、进备份。
- **引擎与格式归你**（SQLite / 追加日志 / 裸文件 / KV 皆可）；宿主只划地盘、注入路径，不读不校验不迁移。
- 未声明 `durable` 时**不要把物化目录当持久层**（它是 ③、跨代不保留）。

## 11. 生命周期声明

| 字段        | 取值                                                                                                      | 含义                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `restart`   | `{policy:'on-exit'            \| 'never', backoff, backoff_ms, backoff_max_ms, max, window_ms, drain_ms}` | 退出后是否重启、退避、窗口、drain 上限               |
| `health`    | `{interval_ms, timeout_ms}`                                                                               | 健康探测节奏                                         |
| `hot`       | `auto` / `manual` / `off`                                                                                 | 来源热更跟随：watcher / 仅 `chrono upgrade` / 不跟随 |
| `exclusive` | `["port"]` / `["data"]`                                                                                   | 独占资源：换代走"先 drain 旧再起新"                  |
| `transport` | `stdio` / `inproc` / `worker`                                                                             | 服务形态                                             |

## 12. 入世规则与 `.worldignore`

- 入世 = 包内**源码树**减去 `node_modules` / `.git` 与 `.worldignore` 声明项；契约必需文件不可被排除。
- **源码入世供回退**（内容寻址）；**运行期跑的是你构建的产物**。
- 构建产物（`dist/` / `target/` / `__pycache__/` 等）应由 `.worldignore` 排除。
- **例外：`terms/` 产物入世**（判定定义本体），被排除的是糖化源 `terms.src/` 与构建脚本。

## 13. 本地开发、验证与发布

```
chrono add ./my-plugin            # 你的世界里：本地 link，边写边热更（hot=auto）
chrono start --watch              # 打开源码热更
chrono upgrade my-plugin          # 手动触发新代码世代
chrono remove my-plugin           # 退役
chrono seed ./my-plugin           # 离线入世（宿主未运行）
chrono pack ./my-plugin --identity my-plugin   # 单目录入世
```

发布：普通 npm 包 / git 仓库；使用者用 `chrono add <npm 名 | git+https://...>` 取用。
**框架不发布插件，也不会内置你的插件**。

## 14. 红线（会被门禁拦）

- 插件运行期源码**不得 import `packages/*`**（宿主 / 内核）；只经线协议 + `needs`。
- 插件之间**不 import、不直连、不开端口**（要暴露网络是插件自己的事，用 `exclusive:["port"]`）。
- 服务**不得直接写世界链**；改世界一律经宿主 / 内核 `commit`。
- 运行期与入世内容**不得 import `toolchain`**（只有 `.worldignore` 排除的 dev/build 脚本可）。
- 保留判定方法名（`judge`/`select`/`verdict`/`gate`/`score`/`rank`）必须由 term 承载。

## 15. 可参考的夹具

`fixtures/plugins/` 下有可跑的示例（框架测试用；形状可直接借鉴）：

| 夹具          | 演示                                                  |
| ------------- | ----------------------------------------------------- |
| `toy-alpha`   | 最小 stdio 服务（`toy.alpha.echo`）                   |
| `toy-beta`    | `needs.one` 依赖 `toy.alpha`                          |
| `toy-channel` | 同一 `main.mjs` 覆盖 `stdio`/`inproc`/`worker` 三形态 |
| `toy-python`  | 非 JS 语言（Python）服务，宿主不解释语言              |
| `toy-term`    | `terms.src/` 糖化 → `terms/` 产物（数据身份）         |
| `toy-router`  | `terms.src/` 糖化选择判定，编译成 `terms/`            |
| `router`      | 判定由 term 承载（`judgments`），无服务进程           |
