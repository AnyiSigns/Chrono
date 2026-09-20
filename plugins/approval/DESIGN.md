# #32 `approval`（审批流程与回执）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 32 / `approval` |
| 职责 | 审批流程与回执：**待审批队列（进世界）**、裁决语义、把批准 / 拒绝回执给 #33 |
| 依赖 | pins 无（入队由 #33 eff、派发由 #33 的 dispatch 节点 eff #27，本插件不调 #27）；`+` 1（`approval.decide` 槽由调用方入口 term（#39）读 `ctx.ids.input.body.slots` 后经 args 传入，供本插件出 per-thread 清槽计划；本插件服务**不读投影**，D8）；`<-` 39（pins：命令入口）、33（pins：入队 / 裁决）；事件与 39 约定 |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["approval"]`，`methods: {approval:["enqueue","list","decide","decide_all","sweep"]}`（`enqueue` 由 #33 `approval.wait` Scope 调用；`sweep` 由宿主周期触发，见 D6；2026-09-19 补登记——原只声明 `list/decide/decide_all` 而 #33 已在调用，属声明缺失） |
| 命令 | 无（命令面在 39 `ui-approval`；本插件不能 eff 调自己的服务，故入口 term 必须住在别的身份） |
| schema | `schema/approval.json`（**超时时长（可配）** / 队列容量 / 裁决策略 / **周期 sweep 周期**（宿主周期触发，D6）；可热改） |
| 机制 | 见下「队列 / 入队 / 裁决 / 超时 / 事件」 |
| 边界 | 不做判定（语义门归 26）/ 不做渲染（卡片归 39）/ 不做工具派发（归 27）；不绕过 27 直接调 28–31；**不自动拒绝** |
| 验收 | 1) 待审批事件驱动 39 出卡片；2) 裁决后 33 能继续 / 终止；3) 拒绝不产生任何工具副作用；4) 无待审批时不发事件；5) 换渲染实现（如 39 换代）不改 32；6) 重启后待审批项仍在（队列进世界）；7) 超时只标 `expired`、不自动裁决；8) 裁决后宿主按队列项 resume 游标触发**新 run**（新 `run_id`）续跑，裁决槽必被清 |
| 状态 | 细节设计（2026-09-19）：**队列进世界**（可回放、重启保留）；**超时挂起 + 可配时长**（不自动拒绝）；多项队列 / 整批裁决沿用；**补跨 run 挂起/续跑口径 + 裁决清槽**（原设计 run 结束后无法续，本轮补齐） |

## 数据契约 `schema/approval.json`

```jsonc
// 世界 body（可回放；**链式 tail + count**，同 #11 / #21：入队 / 裁决各追加一条 item def，不整体重写）
{ "version": 1,
  "tail": { "def": "<最新 item def 哈希>" } | null,
  "count": 0 }

// item def（各自成 def、prev 成链；投影引用闭包进 ids.approval.refs）
{ "id": "ap-<run>-<seq>",          // 确定性 id（run + 队列序），非随机
  "kind": "tool_call" | "orchestration_change" | "plugin_write",   // 待审批种类（本轮新增）
  "port": "tool-fs" | "tool-shell" | "tool-http" | "tool-browser" | "mcp" | "orchestration-admin" | "plugin-admin", "method": "invoke", "args_ref": { "sha256": "…" } | { "summary": "…" },  // 调用描述：**port = 实际工具提供者能力类名**（§1.4：工具提供者类名 = 身份名；不设统一 `tool` 类——同名 pin 会撞 `unresolved_cap`）。`tool_call` 类按实际派发目标填（tool-fs / tool-shell / …）、`orchestration_change`→`orchestration-admin`、`plugin_write`→`plugin-admin`，均经 #27 `invoke`；**只存摘要 / 资产引用，不内联大 args**；明文密钥不在其中
  "tier": "severe",                 // 触发档（4 档）
  "workspace_id": "w1", "run": "…",
  "at": "…",
  "status": "pending" | "approved" | "denied" | "expired",
  "decided_at": "…" | null, "by": "user" | null,
  "resume": { "iter": 2, "cursor": "…", "slots": { … } } | null,  // #33 执行游标（跨 run 续跑依据）；字段与 #33 eval args 对齐（iter / cursor / slots 摘要；小产物内联、大产物按 def 引用）
  "shadow": { "def": "<影子回放指标 def>" } | null,   // 仅 orchestration_change：新旧图过程指标对比
  "prev": { "def": "<上一 item 哈希>" } | null }
```

- **队列进世界**：入队 / 出队 / 裁决都经写计划（可回放、重启保留，验收 6）。
- **verdict 词汇映射（写死）**：`#1` 槽 `verdict` 枚举 = **`accept` / `deny`**（用户在 #39 卡片上的选择）；本插件 item `status` = **`approved` / `denied`**（落账后的结果态）。映射 `accept→approved`、`deny→denied`；`#39` 提交槽时用 `accept`/`deny`，读 item 状态时用 `approved`/`denied`。`expired` 仅由超时产生，无对应槽值。
- `id` 确定性生成（`run` + 队列序），不用随机、不取时间（`at` 由 bag 传入）。
- `args` 里**不含明文密钥**（密钥经 `#24` 句柄，只在调用瞬间注入）。

## 入队

```
26 guard 判 severe/升级 -> 27 返回 needs_approval（不等待）
  -> 33 eff 32 enqueue（写计划：body 追加 item + resume 游标）-> 32 发事件 approval.pending
  -> 39 渲染卡片（计数）-> 本 run 正常结束
```

- 多项同时入队：按到达序入队；39 显计数，支持整批裁决（`decide_all`）。
- 队列满（容量住 schema）→ 结构化拒绝（不静默丢）。

## 挂起与续跑（写死：跨 run 的唯一口径）

- 审批等待**不能**用普通 `eff` 阻塞——单次 `call` 受宿主调用超时（缺省 30s）约束，人不可能总在 30s 内裁决。
- **纠一处易错表述**：内核的 `waiting` 是**效果未回灌**时的状态（`kernel.md` §十二），
  而 `enqueue` 本身**会正常返回**（入队成功）⇒ 那一轮**不是 `waiting`**。
  原文「本 run 以 `waiting` 收口」的说法**作废**，准确形状是：

```
1. 33 的 approval.wait 节点 eff 32 enqueue -> 正常返回「已入队」
2. 33 的解释器据此**不产下一个 eval directive**，只产：
     write(batch: 队列追加 item + **resume 游标**) + extern(回执)
   ⇒ 本 run **正常结束**（不是 waiting、不是失败）
3. 人在 39 裁决 -> 写 #1 槽 -> 39 入口 term eff 32 decide
4. 32 的裁决计划落账（item -> approved/denied + 清槽）
5. 宿主据 item 里的 **resume 游标**触发**新 run**，33 从游标恢复继续（派发工具）或终止
```

- **`resume 游标`（本轮补）**：`item` 里带 `#33` 的执行游标（`iter` / `cursor` / slots 摘要）。
  这是跨 run 续跑成立的**唯一依据**——`#33` 的游标平时住 eval `args`、而 eval **不落账**，
  所以要跨 run 就必须落世界，队列项正是它的载体。**队列进世界**的价值在此兑现。
- **不是内核的续跑契约**：内核 `waiting` 续跑要求同 `run_id` / 同 `directives` / 同 `now`；
  这里是**新 run**（新 `run_id`、新 `now`），靠游标重建执行位置。两者不要混——
  内核续跑用于"效果未回灌"，审批往返用于"人不在 30s 内"。
- **重启安全**：队列与游标都在世界里 ⇒ 宿主重启后仍可裁决并续跑（验收 6）。
- `expired` 只作状态标记，是否续由 `#33` 判定。
- 宿主待补能力：**按队列项游标触发新 run**（不自动重试、不自动裁决）。

## 裁决

```
用户裁决 -> 写 #1 槽 {kind:'approval.decide', id, verdict}
  -> 39 入口 term eff 32 decide / decide_all
  -> 32 写计划【batch：item -> approved / denied + 清 `approval.decide` 槽】+ 发事件 approval.decided
  -> 宿主按挂起锚续跑 -> 33 据此继续（approved）或终止（denied，且不产生任何工具副作用）
```

- **清槽**：裁决计划内同批清 `approval.decide` 槽（**per-thread 键控**：`put({slots:{…其余键, "<thread_id>":{kind:'idle'}}})` + `add_gen(input)`，只清本线程键、不擦其他线程，见 #1「清槽契约」），失败也清（否则残留槽令下回合 `#11` 判非法 kind）；故本插件 `+ 1`（当前 `input.body.slots` 由 #39 入口 term 读后经 args 传入，本插件服务**不读投影**，D8）。
- **拒绝不产生工具副作用**（验收 3）：`denied` 只是回执，调用从未发生。
- `decide_all`：对当前 `pending` 批量给同一 verdict。

## 超时（挂起 + 可配时长）

- 默认**不自动裁决**：超时只把 `pending` 标 `expired` 并保留在队列；**不自动拒绝**（人不在时静默拒绝会丢工具调用）。
- 时长住 schema（缺省如 10 分钟，可配 / 可关）。
- `expired` 后由 **#33** 决定终止该 run 或继续等待；32 只记状态、不回执「拒绝」。
- **队列增长治理**：`items` 链式追加（入队 / 裁决各一条 def，不整体重写）；`expired` / 终局项由**宿主周期触发（D6）的 `sweep` 或容量上限**触发**归档计划**（不删 `pending`）；周期住 `schema/approval.json`，宿主按 `host.md` §五 定时触发「调指定命令 / 方法」周期调本插件 `sweep`（本插件不驻留计时器）；所需 `#32` 队列投影片段由宿主按 `schema.periodic.reads` **机械注入 bag**（服务不读投影，D8）；归档可回放、可 `set_active` 回看，避免队列随历史无限膨胀。

## 三种待审批种类（`kind`，本轮新增）

| `kind` | 触发 | 摘要内容 | 特殊处置 |
| --- | --- | --- | --- |
| `tool_call` | #26 判工具调用升级 | 调用描述摘要 / 资产引用 | 原有路径；批准后凭一次性 `caps.grant` 放行（#25） |
| **`orchestration_change`** | #45 `orchestration.propose` 的采纳 | **图 diff 摘要 + 影子回放指标对比**（`shadow` 字段） | 批准后由 #33 落 `add_gen`（热生效）；回滚 = 一条 `set_active` |
| **`plugin_write`** | #42 `plugin.write` | 插件身份 + 变更文件清单 + `validate` 结果 | 批准后落写计划 ⇒ 代码换代；**失败即 fail-closed 隔离** |

- **本插件不认识这三类的语义**，只按 `kind` 分类存储与回执；语义由 #26 判、由 #39 渲染、由 #33 / 两个管理面消费。
- **`orchestration_change` 的 `shadow` 字段**：影子回放（历史输入 + 审计回灌，零 token）产出的确定性过程指标
  （token / 调用数 / 步数 / 工具失败率 / 审批触发率 / 拒绝码分布）新旧对比，作为 def 引用存入 item。
  **它只呈现、不否决**——用户明确要的变更不该由系统替他拒，但必须让他看见代价。
- **`plugin_write` 跑不了影子回放**（换的是进程），故无 `shadow` 字段。这处不对称是刻意的。

## 事件

`approval.pending`（新项入队）/ `approval.decided`（终局）；经宿主 `event` 透传（不进世界）；39 据此渲染与更新计数。
事件载荷带 `kind`，便于 39 选卡片模板、38 选通知文案。

## 跨插件登记

- **#26 guard**：只产 `needs_approval` / 升级标记，不等待；等待与续跑归 #33。**本轮新增**：
  #26 对 `orchestration.propose` / `plugin.write` 亦产 `escalate` ⇒ 本插件新增两个 `kind`。
- **#33 loop-policy**：编排 `26 -> 27 -> 32 -> 39 -> 33`；据回执继续或终止。
  **本轮修正**：入队后本 run **正常结束**（非 `waiting`），靠 `item.resume` 游标触发**新 run** 续跑。
- **#39 ui-approval**：命令入口（`approval.decide` / `approval.decide_all`）+ 卡片渲染（按 `kind` 分模板）；**UI 侧（2026-09-19 补）**：`pending` 项显示等待计时（>2min warning）、`expired` 项弱化但仍可裁决、[全部拒绝] 文案明确为「放弃并终止本回合」——UI 只呈现，不自动裁决。
- **#1 input**：裁决经槽 `{kind:'approval.decide', id, verdict}`（写类载荷先入世界）；本插件 `+ 1` 只读**入口 term 传入**的槽值（服务不读投影，D8）。
- **#38 ui-notify**：`approval.pending` 事件带 `kind`，编排变更 / 插件写可用不同通知文案。
- **#45 `orchestration-admin` / #42 `plugin-admin`**：两个管理面的高危写都经本插件队列（`kind` 分别为 `orchestration_change` / `plugin_write`）。
