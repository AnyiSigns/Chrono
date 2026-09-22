# tools（工具注册与派发）

工具注册表与唯一派发者：维护**工具目录**，按调用把请求路由到具体提供者。
本插件**冻结 `tool` 端口契约**（提供者怎么写工具声明），自身**不认识任何工具语义**——
具体工具实现归各工具插件，工具语义门归 `guard`，隔离执行归 `sandbox`，审批归 `approval`。

- 身份 / 能力类：`tools`，`methods: {tools:["list","dispatch"]}`；无命令。
- `pins`：工具提供者**按各自能力类名**（类名 = 身份名），逐条指向被依赖身份；另有 `guard`（语义门）
  与保留身份 `host`（线程控制转交）。绑定提供者用其能力类名（`memory` / `retrieval` /
  `memory-maintenance` / `session` / `compress` / `evolve-metrics`）。
- 状态档：`recomputable`；启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 两类工具提供者

1. **`describe` / `invoke` 提供者**（工具类名 = 身份名）：一次回报自己暴露的全部工具，
   每个工具带**描述四要素**（`intent` / `when_to_use` / `param_semantics` / `boundaries`）+
   `argsSchema`（JSON Schema 白名单子集）+ `caps` + `idempotent` + 可选 `render` / `modes`。
   `invoke {tool, args, ...上下文}` 按工具名派发，回 `{ok:true,result}` / `{ok:false,error}`。
2. **能力类工具绑定提供者**：当工具就是某插件既有能力类方法的薄封装时，改用**绑定表**声明
   （`tool 名 -> {class, method?, argsSchema, render?, caps, idempotent, read?}` + 四要素）。
   `method` 缺省 = **投影读**（无服务调用；值由调用方入口 term 读出后随 bag 传入）。
   绑定表住**数据世代 body**（加绑定 = 数据换代热生效），由调用方入口 term 读出随 `bag.tools_bindings` 传入。

两类一视同仁：都进目录、都可派发（绑定项在派发时映射为对目标能力类的反向 `port.call`）。

**已就位的绑定**：`evolve-metrics` → evolve-metrics `record`（`{class:"evolve-metrics", method:"record", caps:{fs:{read:"none",write:"none"},net:"none"}, idempotent:false}`），
`pins` 含 `evolve-metrics`；工具名 `record` 直绑 evolve-metrics 能力类方法，落 `class:'user_request'` 证据、返回 `evidence_id`（orchestration-admin `propose` 引用它）。

## `list(bag) -> 目录`

目录 = `pins` 里 describe/invoke 提供者各自的 `describe` 并集 + `bag.tools_bindings` 绑定表
+ `bag.mcp_tools`（外部 MCP 工具，工具名已命名空间化 `mcp.<server>.<tool>`）。

- 逐项校验：四要素缺一 / `argsSchema` 含白名单外关键词 / `param_semantics` 未覆盖必填参数 /
  `caps` 形状非法 → **`bad_tool_decl`**（该项不进目录、不派发），并在 `rejected` 里留诊断。
- **外部 MCP 工具例外**：四要素由 MCP description 兜底、缺项不拒；`argsSchema` 净化到白名单子集。
- **工具名全局唯一**：重名后者被拒。
- 返回 `{tools:[声明], rejected:[{name,code,message}]}`；`description` 缺省由四要素机械拼装。
- 目录由调用方（如 `loop-policy` 的 `context.assemble`）eff 后写进 bag / 上下文，模型才看得到。

## `dispatch(bag) -> 管道（整批 + 并发）`

`bag.calls = [{call_id, tool, args}]`；返回 `{results:[{call_id, ok, result|error}]}`，**按 `call_id` 保序**。

```
0 批级：解析 bag.workspace_root（缺失只对相对路径调用拒 workspace_missing，绝对路径仍可派发）
   guard 兜底：bag.verdicts 已给则跳过；否则批级一次 port.call guard.judge
   批级取最严：any deny → 整批 denied；否则 any escalate → 整批 needs_approval；否则 allow
1 allow：逐 call 进程内并发扇出（上限住 schema，缺省 4；超限排队不丢弃）
2 绑定项 method 缺省 → 投影读（不调服务）；其余 → port.call 提供者
```

- **本插件只返回 `results`**：不落账、不冒泡 `$directives`（写类工具的计划值由调用方收集并入顶层）；
  `escalate` **只回 `needs_approval` 标记、不入队、不等审批**；`deny` **零副作用**。
- 派发时发 `tool.start` / `tool.end` 事件（宿主只透传，不落账）；`tool.delta` 由提供者自行上行。
- 结果缓存：**只缓存 `idempotent:true` 的工具结果**（键 = `canonicalJson({tool, workspace_root, args})`，
  同键并发单飞）；写类 / 模型调用 / 有会话类永不缓存。

### 提供者调用形状

- describe/invoke 提供者：`port.call <类名> invoke {tool, args, workspace_root, tier, caps, grant, ...上下文}`，
  其中 `caps` **以工具声明为准**（调用级 `caps` 被覆盖）。
- 绑定项：`port.call <class> <method> {...上下文, ...args, caps}`；`grant` / `tier` / `workspace_root` 原样透传。

## bag 键

| 键 | 用途 |
| --- | --- |
| `calls` | 整批调用 `[{call_id, tool, args}]` |
| `workspace_root` | 执行根；由调用方入口 term 解析后传入（服务不读投影） |
| `tier` / `caps` / `grant` | 透传给 guard 与提供者；`grant` 只透传不解释 |
| `verdicts` | 调用方已按 call 判好的 verdict（给出则跳过 guard 兜底） |
| `tools_bindings` | 能力类工具绑定表（数据世代 body 读出） |
| `mcp_tools` | 外部 MCP 工具清单（取自 `mcp` 身份投影） |
| `projection_reads` | 投影读绑定项的值（键 = 绑定 `read` 或工具名） |
| `concurrency` / `cache` | 单次调用覆盖私有参数（非法回落缺省） |

## 错误码

本插件出：`unknown_tool` / `bad_tool_decl` / `bad_args` / `workspace_missing` / `needs_approval` / `denied`。
提供者错误（`tool_failed` / `timeout` / `fs_denied` / `sandbox_unsupported` 等）**原样透传、不改写**；
反向调用失败（未就绪 / 未 pin）同样透传（`unresolved_cap` / `not_loaded` / `transport_failed`）。

## 私有参数（`schema/tools.json`）

`concurrency`（缺省 4，硬顶 64）与 `cache`（`enabled` 缺省 true、`max_entries` 缺省 256）。
`method_timeouts` 为 `tools.dispatch` 声明大上限（整批扇出可能超过进程级缺省）。

## 服务纪律

服务不读投影（目录所需绑定表 / MCP 清单 / 执行根由调用方随 bag 传入）、不取时间 / 随机、同输入同输出；
不落账、无写通道；跨插件只走反向帧 `port.call`。

## 待办 / 已知限制

- **`bag.verdicts` 接口**：接受 `[{call_id|index, verdict}]` 数组、`{decisions:[...]}` 或
  `{<call_id>: verdict}` 映射；与调用方（`loop-policy` 的 `tool.gate`）按 `call_id` 优先、`index` 兜底匹配。
  批级仍取最严（与「不部分放行」口径一致）。
- **工作区存在性**：本插件只判 `bag.workspace_root` 是否给出（空 / 缺 → 缺工作区）；
  「目录已删」由解析执行根的入口 term 与隔离执行侧判定。

## 运行

```sh
npm test                                  # 协议级 + 逻辑级测试（node --test）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（pack/seed → 投影 → 直连协议冒烟 → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` /
`execute/`）随源码入世。
