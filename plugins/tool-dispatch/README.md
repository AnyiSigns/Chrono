# tool-dispatch（工具批派发）

整批工具派发提供方：解析执行上下文 → 批级语义门 → 有界并发扇出到具体工具提供者。
被上层 `tools` 门面经反向 `port.call` 消费；自身消费 `tool-registry`（目录）、`tool-schema`（args 校验）
与 `guard`（语义门），并把工具调用扇出到各工具提供者。

- 身份：`tool-dispatch`
- 能力类 / 方法：`tool-dispatch` → `dispatch`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`tool-dispatch.json`）
- `pins`：无声明（`"pins": {}`）；目录 / 校验 / 语义门 / 工具提供者走 `needs.one` 注入有效 pins
- 状态档：`recomputable`（进程内缓存可重算、不落盘）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖

## `dispatch(bag) -> 管道（整批 + 并发）`

`bag.calls = [{call_id, tool, args}]`；返回 `{results:[{call_id, ok, result|error}]}`，**按 `call_id` 保序**。

```
0 目录：bag.directory / bag.tools 已给则本地索引复用（不依赖目录服务存活）；否则交 tool-registry.list 现场装配
   批级：解析 bag.workspace_root（缺失只对相对路径调用拒 workspace_missing）
   guard 兜底：bag.verdicts 已给则跳过；否则批级一次 port.call guard.judge
   批级取最严：any deny → 整批 denied；否则 any escalate → 整批 needs_approval；否则 allow
1 allow：逐 call 进程内并发扇出（上限住 schema，缺省 4；超限排队不丢弃）
2 绑定项 method 缺省 → 投影读（不调服务）；其余 → port.call 提供者
```

- **只返回 `results`**：不落账、不冒泡 `$directives`；`escalate` 只回 `needs_approval` 标记、不入队、不等审批；
  `deny` 零副作用。
- 派发时发 `tool.start` / `tool.end` 事件（宿主只透传，不落账）；`tool.delta` 由提供者自行上行。
- 结果缓存：**只缓存 `idempotent:true` 的工具结果**（键 = `canonicalJson({tool, workspace_root, args})`，
  同键并发单飞）；写类 / 模型调用 / 有会话类永不缓存。

### 提供者调用形状

- describe/invoke 提供者：`port.call <类名> invoke {tool, args, workspace_root, tier, caps, grant, ...上下文}`，
  其中 `caps` **以工具声明为准**（调用级 `caps` 被覆盖）。
- 绑定项：`port.call <class> <method> {...上下文, ...args, caps}`；`grant` / `tier` / `workspace_root` 原样透传。

## 依赖与背压

- `tool-registry`（`one`）：目录解析。目录服务不可用按 **fail-closed** 抛结构化错误（不放行未知工具）。
- `tool-schema`（`one`）：args 机械校验。
- `guard`（`one`）：批级语义门兜底；不可用 fail-closed 全拒。
- describe/invoke / 绑定提供者类（`one`，逐个）：扇出目标。

## 错误码

本插件出：`unknown_tool` / `bad_tool_decl` / `bad_args` / `workspace_missing` / `needs_approval` / `denied`。
提供者错误（`tool_failed` / `timeout` / `fs_denied` / `sandbox_unsupported` 等）**原样透传、不改写**；
反向调用失败（未就绪 / 未 pin）同样透传（`unresolved_cap` / `not_loaded` / `transport_failed`）。

## 私有参数（`schema/tool-dispatch.json`）

`concurrency`（缺省 4，硬顶 64）与 `cache`（`enabled` 缺省 true、`max_entries` 缺省 256）。
`method_timeouts` 为 `tool-dispatch.dispatch` 声明大上限，且严格小于门面 `tools.dispatch`。

## 服务纪律

服务不读投影（目录 / 执行根由调用方随 bag 传入）、不取时间 / 随机、同输入同输出；
不落账、无写通道；跨插件只走反向帧 `port.call`。

## 运行

```sh
npm test    # 协议级 + 逻辑级测试（node --test）
```

## `.worldignore`

声明 `test/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
