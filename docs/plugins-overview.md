# 插件总览

> 本文件由 `tools/gen-plugins-overview.mjs` 从各 `plugins/*/plugin.json` 经唯一解析器 `plugin-sdk/decl.ts` 生成，`tests/static/plugins-overview.test.mjs` 守护不漂，**勿手改**。
> 各插件「做什么 / 不做什么」见其自带自述 `README.md`；插件之间不 import、不相识，跨身份依赖只经**能力类**表达。
> 角色挂在能力类上：**拥有方** `slots`（声明契约）/ **提供方** `implements` / **消费方** `needs`。一个插件跨能力类可同时持有三种角色；同一能力类不得既 `implements` 又 `needs`（拥有方可 `implements` 自产自用、或用 `many` 消费自己的扩展点）；无拥有方时契约回落提供方 `methods`。

共 66 个插件。

## 角色总览

| 插件 | 拥有 `slots` | 提供 `implements` | 消费 `needs` | state | transport |
| --- | --- | --- | --- | --- | --- |
| `agents` | — | — | — | recomputable | — |
| `approval` | — | `approval` | — | durable | `stdio` |
| `budget` | — | `budget` | — | recomputable | `stdio` |
| `chat` | — | `chat` | `config`→(one)、`host`→(one)、`input`→(one)、`loop-policy`→(one)、`mcp`→(one)、`model`→(one)、`ref-hydrate`→(one)、`session`→(one)、`skill`→(one)、`todo`→(one)、`workspace`→(one) | recomputable | `stdio` |
| `config` | — | `config` | — | durable | `stdio` |
| `context-window` | `context-source` | `context` | `budget`→(one)、`token-estimate`→(one) | recomputable | `stdio` |
| `embedding` | `embedding-provider` | `embedding` | `embedding-provider`→(many) | recomputable | `stdio` |
| `embedding-local` | — | `embedding-provider` | `tokenizer`→(one) | recomputable | `stdio` |
| `evolution` | — | — | — | recomputable | — |
| `evolve-ledger` | — | `evolve-ledger`、`evolve-metrics` | `host`→(one) | recomputable | `stdio` |
| `graph-gate` | — | `graph-gate` | — | recomputable | `stdio` |
| `graph-run` | — | `graph-run` | `approval`→(one)、`context`→(one)、`context-source`→(many)、`graph-gate`→(one)、`guard`→(one)、`loop-rule`→(many)、`model`→(one)、`router`→(one)、`session`→(one)、`tool-dispatch`→(one)、`tool-registry`→(one)、`turn-hook`→(many) | recomputable | `stdio` |
| `guard` | — | `guard` | — | recomputable | `stdio` |
| `input` | — | `input` | — | durable | `stdio` |
| `loop-policy` | `loop-rule`、`turn-hook` | `loop-policy`、`loop-rule`、`turn-hook` | `approval`→(one)、`context`→(one)、`evolve-metrics`→(one)、`graph-gate`→(one)、`graph-run`→(one)、`guard`→(one)、`host`→(one)、`model`→(one)、`ref-hydrate`→(one)、`router`→(one)、`session`→(one)、`tool-dispatch`→(one)、`turn-ledger`→(one) | recomputable | `stdio` |
| `mcp` | — | `mcp`、`tool-provider` | `mcp-client`→(one)、`secrets`→(one) | durable | `stdio` |
| `mcp-client` | — | `mcp-client` | — | recomputable | `stdio` |
| `model-protocol` | — | `model` | `config`→(one)、`msg-dialect`→(one)、`secrets`→(one)、`throttle`→(one) | recomputable | `stdio` |
| `msg-dialect` | — | `msg-dialect` | `host`→(one) | recomputable | `stdio` |
| `orchestration` | — | `orchestration`、`tool-provider` | `graph-gate`→(one) | recomputable | `stdio` |
| `plugin` | — | `plugin` | `host`→(one) | recomputable | `stdio` |
| `plugin-admin` | — | `plugin-admin`、`tool-provider` | `plugin`→(one) | recomputable | `stdio` |
| `question` | — | `question`、`tool-provider` | `input`→(one) | durable | `stdio` |
| `ref-hydrate` | — | `ref-hydrate` | `host`→(one) | recomputable | `stdio` |
| `router` | — | `router` | — | recomputable | — |
| `sandbox` | — | `sandbox` | `sandbox-exec`→(one)、`sandbox-fs`→(one)、`sandbox-policy`→(one) | recomputable | `stdio` |
| `sandbox-exec` | — | `sandbox-exec` | `sandbox-policy`→(one) | recomputable | `stdio` |
| `sandbox-fs` | — | `sandbox-fs` | `sandbox-policy`→(one) | recomputable | `stdio` |
| `sandbox-policy` | — | `sandbox-policy` | — | recomputable | `stdio` |
| `search-index` | `search-index-provider` | `search-index` | `search-index-provider`→(many) | recomputable | `stdio` |
| `search-index-sql` | — | `search-index-provider` | — | durable | `stdio` |
| `secrets` | `secrets-backend` | `secrets` | `secrets-backend`→(many) | recomputable | `stdio` |
| `secrets-env` | — | `secrets-backend` | — | recomputable | `stdio` |
| `secrets-local` | — | `secrets-backend` | — | recomputable | `stdio` |
| `session` | — | `session` | `input`→(one) | durable | `stdio` |
| `skill` | — | `skill` | — | durable | `stdio` |
| `storage-kv` | — | `storage-kv` | — | durable | `stdio` |
| `storage-sql` | — | `storage-sql` | — | durable | `stdio` |
| `throttle` | — | `throttle` | — | recomputable | `stdio` |
| `todo` | — | `todo`、`tool-provider` | `storage-kv`→(one) | durable | `stdio` |
| `token-estimate` | — | `token-estimate` | — | recomputable | `stdio` |
| `tokenizer` | — | `tokenizer` | — | recomputable | `stdio` |
| `tool-browser` | — | `tool-browser`、`tool-provider` | `host`→(one)、`sandbox`→(one) | recomputable | `stdio` |
| `tool-dispatch` | — | `tool-dispatch` | `evolve-metrics`→(one)、`guard`→(one)、`session`→(one)、`tool-provider`→(many)、`tool-registry`→(one) | recomputable | `stdio` |
| `tool-fs` | — | `tool-provider` | `host`→(one)、`sandbox`→(one) | recomputable | `stdio` |
| `tool-http` | — | `tool-http`、`tool-provider` | `host`→(one)、`sandbox`→(one)、`search-index`→(many) | recomputable | `stdio` |
| `tool-registry` | `tool-provider` | `tool-registry` | `evolve-metrics`→(one)、`session`→(one)、`tool-provider`→(many) | recomputable | `stdio` |
| `tool-shell` | — | `tool-shell`、`tool-provider` | `sandbox`→(one)、`secrets`→(one) | recomputable | `stdio` |
| `turn-ledger` | — | `turn-ledger` | `approval`→(one)、`evolve-metrics`→(one)、`graph-gate`→(one) | recomputable | `stdio` |
| `ui-approval` | — | `ui-approval`、`ui-slot` | `approval`→(one)、`input`→(one)、`ref-hydrate`→(one) | recomputable | `stdio` |
| `ui-chat` | — | `ui-chat`、`ui-slot` | — | recomputable | `stdio` |
| `ui-composer` | — | `ui-composer`、`ui-slot` | — | recomputable | `stdio` |
| `ui-notify` | — | `ui-notify`、`ui-slot` | — | recomputable | `stdio` |
| `ui-settings` | — | `ui-settings`、`ui-nav`、`ui-slot` | `config`→(one)、`host`→(one)、`input`→(one)、`model`→(one)、`ref-hydrate`→(one)、`secrets`→(one)、`skill`→(one) | recomputable | `stdio` |
| `ui-shell` | `ui-nav`、`ui-slot` | `ui-shell` | `host`→(one)、`ui-nav`→(many)、`ui-slot`→(many) | recomputable | `stdio` |
| `ui-sidebar` | — | `ui-sidebar`、`ui-slot` | `host`→(one)、`input`→(one)、`session`→(one)、`workspace`→(one)、`workspace-picker`→(one) | recomputable | `stdio` |
| `ui-threads` | — | `ui-threads`、`ui-slot` | `session`→(one)、`todo`→(one) | recomputable | `stdio` |
| `vector-index` | — | `vector-index` | — | recomputable | `stdio` |
| `vendor-dashscope` | — | — | — | recomputable | — |
| `vendor-deepseek` | — | — | — | recomputable | — |
| `vendor-google` | — | — | — | recomputable | — |
| `vendor-kimi` | — | — | — | recomputable | — |
| `vendor-openai` | — | — | — | recomputable | — |
| `vendor-zai` | — | — | — | recomputable | — |
| `workspace` | — | `workspace` | — | durable | `stdio` |
| `workspace-picker` | — | `workspace-picker` | — | recomputable | `stdio` |

## 全字段明细

逐插件列出 `plugin.json` 的全部字段（`identity` / `schema` / `implements` / `methods` / `concurrent_methods` / `needs` / `slots` / `judgments` / `start` / `transport` / `build` / `exclusive` / `protocol` / `restart` / `health` / `state` / `members` / `commands`）；省略 / 缺省字段记 `—`。

### `agents`

- `identity`: `agents`
- `schema`: `schema/agents.json`
- `implements`: —
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `schema:schema/`
- `commands`: —

### `approval`

- `identity`: `approval`
- `schema`: `schema/approval.json`
- `implements`: `approval`
- `methods`: `approval`→`enqueue`、`list`、`decide`、`decide_all`、`sweep`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `budget`

- `identity`: `budget`
- `schema`: `schema/budget.json`
- `implements`: `budget`
- `methods`: `budget`→`model`、`factor`、`observe`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `chat`

- `identity`: `chat`
- `schema`: `schema/wiring.json`
- `implements`: `chat`
- `methods`: `chat`→`send`、`history`、`resume`、`cancel`、`insert`
- `concurrent_methods`: `send`、`resume`、`history`、`cancel`、`insert`
- `needs`: `config`→(one)、`host`→(one)、`input`→(one)、`loop-policy`→(one)、`mcp`→(one)、`model`→(one)、`ref-hydrate`→(one)、`session`→(one)、`skill`→(one)、`todo`→(one)、`workspace`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`、`schema:schema/`
- `commands`: `chat.send`、`chat.history(ro)`、`chat.resume`、`chat.cancel`、`chat.insert`

### `config`

- `identity`: `config`
- `schema`: `schema/config.json`
- `implements`: `config`
- `methods`: `config`→`read`、`write`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`term:terms/`、`schema:schema/`
- `commands`: `config.read(ro)`、`config.write`

### `context-window`

- `identity`: `context-window`
- `schema`: `schema/policy.json`
- `implements`: `context`
- `methods`: `context`→`build`
- `concurrent_methods`: —
- `needs`: `budget`→(one)、`token-estimate`→(one)
- `slots`: `context-source`→`collect`
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `embedding`

- `identity`: `embedding`
- `schema`: `schema/embedding.json`
- `implements`: `embedding`
- `methods`: `embedding`→`embed`
- `concurrent_methods`: —
- `needs`: `embedding-provider`→(many)
- `slots`: `embedding-provider`→`embed`、`describe-models`
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `embedding-local`

- `identity`: `embedding-local`
- `schema`: `schema/embedding-local.json`
- `implements`: `embedding-provider`
- `methods`: —
- `concurrent_methods`: —
- `needs`: `tokenizer`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `evolution`

- `identity`: `evolution`
- `schema`: `schema/evolution.json`
- `implements`: —
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `schema:schema/`
- `commands`: —

### `evolve-ledger`

- `identity`: `evolve-ledger`
- `schema`: `schema/evolve-ledger.json`
- `implements`: `evolve-ledger`、`evolve-metrics`
- `methods`: `evolve-ledger`→`read-chain`、`patch-plan`、`thresholds`、`hash`、`evolve-metrics`→`aggregate`、`sweep`、`shadow`、`record`
- `concurrent_methods`: —
- `needs`: `host`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`execute:src/`、`schema:schema/`
- `commands`: —

### `graph-gate`

- `identity`: `graph-gate`
- `schema`: `schema/graph-gate.json`
- `implements`: `graph-gate`
- `methods`: `graph-gate`→`validate`、`closure`、`select`、`hash`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `graph-run`

- `identity`: `graph-run`
- `schema`: `schema/graph-run.json`
- `implements`: `graph-run`
- `methods`: `graph-run`→`run`、`cancel`
- `concurrent_methods`: `run`、`cancel`
- `needs`: `approval`→(one)、`context`→(one)、`context-source`→(many)、`graph-gate`→(one)、`guard`→(one)、`loop-rule`→(many)、`model`→(one)、`router`→(one)、`session`→(one)、`tool-dispatch`→(one)、`tool-registry`→(one)、`turn-hook`→(many)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `guard`

- `identity`: `guard`
- `schema`: `schema/guard.json`
- `implements`: `guard`
- `methods`: `guard`→`judge`、`facts`、`collect`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: `guard.judge`→`terms/guard.json`
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`、`schema:schema/`
- `commands`: —

### `input`

- `identity`: `input`
- `schema`: `schema/slot.schema.json`
- `implements`: `input`
- `methods`: `input`→`read`、`write`、`clear`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`term:terms/`、`schema:schema/`
- `commands`: `input.read(ro)`、`input.write`

### `loop-policy`

- `identity`: `loop-policy`
- `schema`: `schema/graph.json`
- `implements`: `loop-policy`、`loop-rule`、`turn-hook`
- `methods`: `loop-policy`→`interpret`、`cancel`、`note-input`、`promote-input`
- `concurrent_methods`: `interpret`、`cancel`、`note-input`、`promote-input`、`when`、`pre`、`post`、`before-assemble`、`after-step`、`before-settle`、`after-settle`
- `needs`: `approval`→(one)、`context`→(one)、`evolve-metrics`→(one)、`graph-gate`→(one)、`graph-run`→(one)、`guard`→(one)、`host`→(one)、`model`→(one)、`ref-hydrate`→(one)、`router`→(one)、`session`→(one)、`tool-dispatch`→(one)、`turn-ledger`→(one)
- `slots`: `loop-rule`→`when`、`pre`、`post`、`turn-hook`→`before-assemble`、`after-step`、`before-settle`、`after-settle`
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `mcp`

- `identity`: `mcp`
- `schema`: `schema/mcp.json`
- `implements`: `mcp`、`tool-provider`
- `methods`: `mcp`→`describe`、`invoke`、`discover`、`read`、`write`
- `concurrent_methods`: —
- `needs`: `mcp-client`→(one)、`secrets`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`term:terms/`、`schema:schema/`
- `commands`: `mcp.in.ping(ro)`、`mcp.in.tools_list(ro)`、`mcp.in.tools_call`

### `mcp-client`

- `identity`: `mcp-client`
- `schema`: `schema/mcp-client.json`
- `implements`: `mcp-client`
- `methods`: `mcp-client`→`list_tools`、`call_tool`、`close`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `model-protocol`

- `identity`: `model-protocol`
- `schema`: `schema/protocol.json`
- `implements`: `model`
- `methods`: `model`→`chat`、`complete`、`abort`、`vendors`、`discover`、`profile`、`sync`
- `concurrent_methods`: `chat`、`complete`、`abort`
- `needs`: `config`→(one)、`msg-dialect`→(one)、`secrets`→(one)、`throttle`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `npm ci --no-audit --no-fund`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `msg-dialect`

- `identity`: `msg-dialect`
- `schema`: `schema/msg-dialect.json`
- `implements`: `msg-dialect`
- `methods`: `msg-dialect`→`normalize-quirks`、`reasoning-capability`、`encode-tools`、`apply-auth`、`build`、`parse-full`、`inline-assets`
- `concurrent_methods`: —
- `needs`: `host`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `orchestration`

- `identity`: `orchestration`
- `schema`: `schema/orchestration.json`
- `implements`: `orchestration`、`tool-provider`
- `methods`: `orchestration`→`list`、`read`、`validate`、`propose`
- `concurrent_methods`: —
- `needs`: `graph-gate`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `plugin`

- `identity`: `plugin`
- `schema`: `schema/plugin.json`
- `implements`: `plugin`
- `methods`: `plugin`→`list`、`read`、`validate`、`write`
- `concurrent_methods`: —
- `needs`: `host`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `plugin-admin`

- `identity`: `plugin-admin`
- `schema`: `schema/plugin-admin.json`
- `implements`: `plugin-admin`、`tool-provider`
- `methods`: `plugin-admin`→`describe`、`invoke`
- `concurrent_methods`: —
- `needs`: `plugin`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `question`

- `identity`: `question`
- `schema`: `schema/question.json`
- `implements`: `question`、`tool-provider`
- `methods`: `question`→`describe`、`invoke`、`list`、`state`、`sweep`
- `concurrent_methods`: —
- `needs`: `input`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `term:terms/`、`execute:execute/`、`schema:schema/`
- `commands`: `question.answer`、`question.state(ro)`

### `ref-hydrate`

- `identity`: `ref-hydrate`
- `schema`: `schema/ref-hydrate.json`
- `implements`: `ref-hydrate`
- `methods`: `ref-hydrate`→`hydrate`
- `concurrent_methods`: —
- `needs`: `host`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `router`

- `identity`: `router`
- `schema`: `schema/router.json`
- `implements`: `router`
- `methods`: `router`→`select`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: `router.select`→`terms/select.json`
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `term:terms/`、`schema:schema/`
- `commands`: —

### `sandbox`

- `identity`: `sandbox`
- `schema`: `schema/sandbox.json`
- `implements`: `sandbox`
- `methods`: `sandbox`→`exec`、`exec_start`、`exec_poll`、`exec_kill`、`session_close`、`fsop`、`capabilities`
- `concurrent_methods`: —
- `needs`: `sandbox-exec`→(one)、`sandbox-fs`→(one)、`sandbox-policy`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `sandbox-exec`

- `identity`: `sandbox-exec`
- `schema`: `schema/sandbox-exec.json`
- `implements`: `sandbox-exec`
- `methods`: `sandbox-exec`→`exec`、`exec_start`、`exec_poll`、`exec_kill`、`session_close`、`capabilities`
- `concurrent_methods`: —
- `needs`: `sandbox-policy`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `sandbox-fs`

- `identity`: `sandbox-fs`
- `schema`: `schema/sandbox-fs.json`
- `implements`: `sandbox-fs`
- `methods`: `sandbox-fs`→`fsop`、`capabilities`
- `concurrent_methods`: —
- `needs`: `sandbox-policy`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `sandbox-policy`

- `identity`: `sandbox-policy`
- `schema`: `schema/sandbox-policy.json`
- `implements`: `sandbox-policy`
- `methods`: `sandbox-policy`→`resolve`、`consume`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `search-index`

- `identity`: `search-index`
- `schema`: `schema/search-index.json`
- `implements`: `search-index`
- `methods`: `search-index`→`search`、`put`、`stats`
- `concurrent_methods`: —
- `needs`: `search-index-provider`→(many)
- `slots`: `search-index-provider`→`search`、`put`、`stats`
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `search-index-sql`

- `identity`: `search-index-sql`
- `schema`: `schema/search-index-sql.json`
- `implements`: `search-index-provider`
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `secrets`

- `identity`: `secrets`
- `schema`: `schema/secrets.json`
- `implements`: `secrets`
- `methods`: `secrets`→`resolve`、`list`
- `concurrent_methods`: —
- `needs`: `secrets-backend`→(many)
- `slots`: `secrets-backend`→`read`、`list`、`kinds`
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `secrets-env`

- `identity`: `secrets-env`
- `schema`: `schema/secrets-env.json`
- `implements`: `secrets-backend`
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `secrets-local`

- `identity`: `secrets-local`
- `schema`: `schema/secrets-local.json`
- `implements`: `secrets-backend`
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `session`

- `identity`: `session`
- `schema`: `schema/session.json`
- `implements`: `session`
- `methods`: `session`→`commit`、`new_conversation`、`select`、`rename`、`set_title`、`delete`、`restore`、`branch`、`deliver`、`ack_inbox`、`turn_open`、`turn_insert`、`turn_note_input`、`turn_has_pending_input`、`turn_promote_input`、`step_append`、`turn_settle`、`turn_cancel`、`read`、`list`、`history`
- `concurrent_methods`: —
- `needs`: `input`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`term:terms/`、`schema:schema/`
- `commands`: —

### `skill`

- `identity`: `skill`
- `schema`: `schema/skill.json`
- `implements`: `skill`
- `methods`: `skill`→`read`、`write`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`term:terms/`、`schema:schema/`
- `commands`: `skill.read(ro)`、`skill.write`

### `storage-kv`

- `identity`: `storage-kv`
- `schema`: `schema/storage-kv.json`
- `implements`: `storage-kv`
- `methods`: `storage-kv`→`get`、`put`、`delete`、`list`、`batch`、`info`、`dropNamespace`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `storage-sql`

- `identity`: `storage-sql`
- `schema`: `schema/storage-sql.json`
- `implements`: `storage-sql`
- `methods`: `storage-sql`→`createTable`、`query`、`write`、`batch`、`listTables`、`info`、`dropNamespace`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `throttle`

- `identity`: `throttle`
- `schema`: `schema/throttle.json`
- `implements`: `throttle`
- `methods`: `throttle`→`acquire`、`plan`、`penalize`、`policy`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `todo`

- `identity`: `todo`
- `schema`: `schema/todo.json`
- `implements`: `todo`、`tool-provider`
- `methods`: `todo`→`describe`、`invoke`
- `concurrent_methods`: —
- `needs`: `storage-kv`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `token-estimate`

- `identity`: `token-estimate`
- `schema`: `schema/token-estimate.json`
- `implements`: `token-estimate`
- `methods`: `token-estimate`→`count`、`version`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`execute:native/`、`schema:schema/`
- `commands`: —

### `tokenizer`

- `identity`: `tokenizer`
- `schema`: `schema/tokenizer.json`
- `implements`: `tokenizer`
- `methods`: `tokenizer`→`encode`、`chunk`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `tool-browser`

- `identity`: `tool-browser`
- `schema`: `schema/tool-browser.json`
- `implements`: `tool-browser`、`tool-provider`
- `methods`: `tool-browser`→`describe`、`invoke`
- `concurrent_methods`: —
- `needs`: `host`→(one)、`sandbox`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `tool-dispatch`

- `identity`: `tool-dispatch`
- `schema`: `schema/tool-dispatch.json`
- `implements`: `tool-dispatch`
- `methods`: `tool-dispatch`→`dispatch`
- `concurrent_methods`: `dispatch`
- `needs`: `evolve-metrics`→(one)、`guard`→(one)、`session`→(one)、`tool-provider`→(many)、`tool-registry`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `tool-fs`

- `identity`: `tool-fs`
- `schema`: `schema/tool-fs.json`
- `implements`: `tool-provider`
- `methods`: —
- `concurrent_methods`: —
- `needs`: `host`→(one)、`sandbox`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `tool-http`

- `identity`: `tool-http`
- `schema`: `schema/tool-http.json`
- `implements`: `tool-http`、`tool-provider`
- `methods`: `tool-http`→`describe`、`invoke`
- `concurrent_methods`: —
- `needs`: `host`→(one)、`sandbox`→(one)、`search-index`→(many)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `tool-registry`

- `identity`: `tool-registry`
- `schema`: `schema/tool-registry.json`
- `implements`: `tool-registry`
- `methods`: `tool-registry`→`list`、`validate-args`
- `concurrent_methods`: —
- `needs`: `evolve-metrics`→(one)、`session`→(one)、`tool-provider`→(many)
- `slots`: `tool-provider`→`describe`、`invoke`
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `tool-shell`

- `identity`: `tool-shell`
- `schema`: `schema/tool-shell.json`
- `implements`: `tool-shell`、`tool-provider`
- `methods`: `tool-shell`→`describe`、`invoke`
- `concurrent_methods`: —
- `needs`: `sandbox`→(one)、`secrets`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `turn-ledger`

- `identity`: `turn-ledger`
- `schema`: `schema/turn-ledger.json`
- `implements`: `turn-ledger`
- `methods`: `turn-ledger`→`settle`、`decide`
- `concurrent_methods`: `settle`、`decide`
- `needs`: `approval`→(one)、`evolve-metrics`→(one)、`graph-gate`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `ui-approval`

- `identity`: `ui-approval`
- `schema`: —
- `implements`: `ui-approval`、`ui-slot`
- `methods`: `ui-approval`→`ping`、`list`、`decide`、`decide_all`、`client.read`、`ui-slot`→`list`
- `concurrent_methods`: `list`、`client.read`
- `needs`: `approval`→(one)、`input`→(one)、`ref-hydrate`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `npm ci --no-audit --no-fund`、`node ../../plugin-sdk/tools/build-ui.mjs`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`
- `commands`: `approval.list(ro)`、`approval.decide`、`approval.decide_all`、`ui-approval.client.read(ro)`

### `ui-chat`

- `identity`: `ui-chat`
- `schema`: —
- `implements`: `ui-chat`、`ui-slot`
- `methods`: `ui-chat`→`ping`、`client.read`、`ui-slot`→`list`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `npm ci`、`node ../../plugin-sdk/tools/build-ui.mjs`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`
- `commands`: `ui-chat.client.read(ro)`

### `ui-composer`

- `identity`: `ui-composer`
- `schema`: —
- `implements`: `ui-composer`、`ui-slot`
- `methods`: `ui-composer`→`ping`、`client.read`、`ui-slot`→`list`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `npm ci`、`node ../../plugin-sdk/tools/build-ui.mjs`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`
- `commands`: `ui-composer.client.read(ro)`

### `ui-notify`

- `identity`: `ui-notify`
- `schema`: —
- `implements`: `ui-notify`、`ui-slot`
- `methods`: `ui-notify`→`ping`、`ui-slot`→`list`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`
- `commands`: `notify.state(ro)`

### `ui-settings`

- `identity`: `ui-settings`
- `schema`: —
- `implements`: `ui-settings`、`ui-nav`、`ui-slot`
- `methods`: `ui-settings`→`ping`、`vendors`、`profile`、`discover`、`health`、`graph`、`scopes`、`client.read`、`secret`、`ui-slot`→`list`
- `concurrent_methods`: `vendors`、`health`、`graph`、`scopes`、`client.read`
- `needs`: `config`→(one)、`host`→(one)、`input`→(one)、`model`→(one)、`ref-hydrate`→(one)、`secrets`→(one)、`skill`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `npm ci`、`node ../../plugin-sdk/tools/build-ui.mjs`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`
- `commands`: `model.vendors(ro)`、`model.discover`、`model.profile`、`secrets.status(ro)`、`settings.identities(ro)`、`settings.skills(ro)`、`orchestration.graph(ro)`、`orchestration.scopes(ro)`、`orchestration.health(ro)`、`ui-settings.client.read(ro)`、`ui-settings.secret(ro)`

### `ui-shell`

- `identity`: `ui-shell`
- `schema`: `schema/shell.json`
- `implements`: `ui-shell`
- `methods`: `ui-shell`→`ping`、`nav`
- `concurrent_methods`: —
- `needs`: `host`→(one)、`ui-nav`→(many)、`ui-slot`→(many)
- `slots`: `ui-nav`→`list`、`ui-slot`→`list`
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: `port`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`、`term:terms/`
- `commands`: `ui-shell.nav(ro)`

### `ui-sidebar`

- `identity`: `ui-sidebar`
- `schema`: —
- `implements`: `ui-sidebar`、`ui-slot`
- `methods`: `ui-sidebar`→`ping`、`clientRead`、`newConversation`、`selectConversation`、`renameConversation`、`deleteConversation`、`restoreConversation`、`branchConversation`、`listTurns`、`listConversations`、`listWorkspaces`、`addWorkspace`、`removeWorkspace`、`ui-slot`→`list`
- `concurrent_methods`: —
- `needs`: `host`→(one)、`input`→(one)、`session`→(one)、`workspace`→(one)、`workspace-picker`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `npm ci`、`node ../../plugin-sdk/tools/build-ui.mjs`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`
- `commands`: `session.new`、`session.select`、`session.rename`、`session.delete`、`session.restore`、`session.branch`、`session.turns(ro)`、`session.list(ro)`、`workspace.list(ro)`、`workspace.pick`、`workspace.add`、`workspace.remove`、`workspace.reveal`、`ui-sidebar.client.read(ro)`

### `ui-threads`

- `identity`: `ui-threads`
- `schema`: —
- `implements`: `ui-threads`、`ui-slot`
- `methods`: `ui-slot`→`list`、`ui-threads`→`ping`、`threads.state`、`client.read`
- `concurrent_methods`: —
- `needs`: `session`→(one)、`todo`→(one)
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `npm ci --no-audit --no-fund`、`node ../../plugin-sdk/tools/build-ui.mjs`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`term:terms/`
- `commands`: `threads.state(ro)`、`ui-threads.client.read(ro)`

### `vector-index`

- `identity`: `vector-index`
- `schema`: `schema/vector-index.json`
- `implements`: `vector-index`
- `methods`: `vector-index`→`upsert`、`remove`、`search`、`info`、`clear`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/main.ts`
- `transport`: `stdio`
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `vendor-dashscope`

- `identity`: `vendor-dashscope`
- `schema`: `schema/vendor.json`
- `implements`: —
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `schema:schema/`
- `commands`: —

### `vendor-deepseek`

- `identity`: `vendor-deepseek`
- `schema`: `schema/vendor.json`
- `implements`: —
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `schema:schema/`
- `commands`: —

### `vendor-google`

- `identity`: `vendor-google`
- `schema`: `schema/vendor.json`
- `implements`: —
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `schema:schema/`
- `commands`: —

### `vendor-kimi`

- `identity`: `vendor-kimi`
- `schema`: `schema/vendor.json`
- `implements`: —
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `schema:schema/`
- `commands`: —

### `vendor-openai`

- `identity`: `vendor-openai`
- `schema`: `schema/vendor.json`
- `implements`: —
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `schema:schema/`
- `commands`: —

### `vendor-zai`

- `identity`: `vendor-zai`
- `schema`: `schema/vendor.json`
- `implements`: —
- `methods`: —
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: ``
- `transport`: —
- `build`: `[]`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{}`
- `health`: `{}`
- `state`: `recomputable`
- `members`: `schema:schema/`
- `commands`: —

### `workspace`

- `identity`: `workspace`
- `schema`: `schema/workspace.json`
- `implements`: `workspace`
- `methods`: `workspace`→`list`、`read`、`add`、`remove`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: `data`
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `durable`
- `members`: `execute:execute/`、`schema:schema/`
- `commands`: —

### `workspace-picker`

- `identity`: `workspace-picker`
- `schema`: —
- `implements`: `workspace-picker`
- `methods`: `workspace-picker`→`pick`、`reveal`
- `concurrent_methods`: —
- `needs`: —
- `slots`: —
- `judgments`: —
- `start`: `node execute/launch.mjs`
- `transport`: `stdio`
- `build`: `cargo build --release`
- `exclusive`: —
- `protocol`: `1`
- `restart`: `{"policy":"on-exit","backoff":"exponential","backoff_ms":500,"backoff_max_ms":30000,"max":5,"window_ms":60000,"drain_ms":5000}`
- `health`: `{"interval_ms":10000,"timeout_ms":2000}`
- `state`: `recomputable`
- `members`: `execute:execute/`
- `commands`: —
