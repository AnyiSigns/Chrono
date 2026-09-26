# 运行记录出世界 + 插件自有持久存储：实施计划

> 口径来源：`docs/kernel.md`（内核设计，唯一权威）、`docs/host.md`（载体设计）、`docs/plugins.md`（插件规范）、`docs/protocol.md`（协议）。
> 本文件属 `docs/plans/`，只写"怎么做"，不参与设计口径；冲突时以设计文档为准。
> 编码遵循 `docs/coding.md`：根因修复（禁补丁式）、测试落各子目录 `test/`、禁 PowerShell 写文件、提交信息无人称且无计划编号。

---

## 零、这次改什么

设计已定案（本次同批改入四份设计文档）：

0. **"唯一写口"作为全局概念作废**，换成**写入落点表**（`docs/host.md` §五「写入落点」）：什么东西该在哪写、那一处谁是写者。载体是**中转站**（转发调用、解析 `pins`、装配依赖、划地盘），不是总账房。"世界那一处写者唯一且必经内核四步校验"降格为**该落点的性质**（物理约束：`journal` 单链 + `expect_pos` CAS），行为不变。
1. **世界只装定义与判定**。判据两问——回滚该不该带上它、判定 / 门禁 / 重放要不要从世界读它；两问皆否即不进世界。
2. **运行记录出世界**：对话消息、输入槽、审批队列与结果、工具结果、待办、界面配置、记忆条目由 owner 插件写**自有持久存储**，不产 `write` directive、不占 `seq`、不改 `worldRev`。
3. **插件自选存储引擎**：`plugin.json.state` 增 `durable` 档，宿主给 `state/data/<id>/` 并注入 `CHRONO_PLUGIN_DATA`，只保证位置 / 跨代存活 / 备份归属 / 跨代独占，不解释内容。
4. **第一方存储服务**（关系型 + 文件型）作默认落点，普通插件、无特权、不强制。
5. **调用帧 `env` 增 `emitter`**（宿主填），存储服务据此按 owner 分库。
6. **`state/` 目录定位按落点重写**：每项标注写者与档位；补齐此前漏记的 `lifecycle.log` 与 `secrets.local.json`；三类分清（不可重算真源 / 可重算产物 / 旁路与本机件）。
7. **存量不迁，直接重来**：世界里已有的对话 / 审批 / 待办等运行记录**不搬**，新存储从空开始。旧数据留在链上（历史改不掉）但不再被读。省掉 20+ 个迁移脚本与逐字段对账，也消除"迁移期两个真源分叉"这一整类风险；**代价：现有会话历史在界面上消失**（已接受）。
8. **运行记录不自带完整性保证**：出世界后不再有链式哈希覆盖，坏数据没有链可对。**已接受**——"非法进不来"从此只对定义平面与效果审计成立。不做插件内哈希链、不做定期锚摘要进世界。
9. **跨 owner 原子性放弃，换边跑边追加**：今天收口一条 `batch` 全有或全无，正是"回合暂停时界面空白"的根因。改为**按 owner 各自原子（自己的事务）+ 边跑边追加**；每条记录盖回合 id，续跑 / 重试靠它幂等收敛、残留半份状态可辨。中途崩溃可能出现"消息落了、todo 没落"，属已知取舍。

内核**不改一行**：它只给被 `put` 的东西做版本，"什么配进世界"是载体判定。

**本计划取代** `docs/plans/world-lifecycle-residuals.md` 的 C1 / C2 与 B2 中与运行数据相关的部分：运行记录不再进世界后，补丁世代（`base` + `ops`）只服务于真正的定义数据，C1 的分批迁移对已出世界的身份作废，B2 的"投影闭包保留"只需覆盖定义数据世代。该文件其余项（A2 / A3 / A4 / B1 / B3 / C3 / D2 / D3 / E1–E4）不受影响，照原计划推进。

---

## 零之二、并行修的两个正确性 bug（与本重构独立）

排查那次"回合跑一半消失"查出两个 bug，**都不会被本重构自动修掉**，与 P0/P1 改动面不重叠（一个在 `loop-policy` 图数据与工具层，一个在 `packages/host` 之外），故**并行推进**。

### B-a `approval.wait` 返回 `pending` 无出边 ⇒ 回合静默收口、本轮消息未落账

**现象**：模型在下一轮读不到上一条用户消息；浏览器刷新后历史也没有——因为世界里确实没写。

**根因**：`plugins/loop-policy/execute/seed.ts:331-343` 的种子图里，节点 3（`approval.wait`）只有两条出边 `verdict_is(approved)` 与 `verdict_is(denied)`；而 `enqueue` 正常返回后被 `normalizeValue` 机械盖成 `decision:'pending'`（`plugins/loop-policy/execute/dispatch.ts:503-504`）。`pending` 两条边都不匹配 ⇒ 该轮无路可走、静默走 sink ⇒ `6 turn.commit` 的 `message` / `results` / `report` 入边全空 ⇒ **本轮用户消息与助手消息一条都没进 session**。

**修法（定案：回合级挂起，不用内核 `waiting`）**：

- 种子图为 `pending` 补出边，导向**显式挂起收口**（带挂起原因 + resume 游标），**不得**复用静默 sink 路径——静默收口让"等人"与"跑完了"在观测上不可区分。
- 收口前**先落账本轮已发生的事实**（用户消息、助手消息、已执行工具结果）：它们已经发生，存续不该取决于后续是否获批。与定案 9 的边跑边追加同向。
- 挂起态与 resume 游标持久化，跨宿主重启仍可裁决续跑；**既有「按队列项游标触发新 run」机制不变**，`enqueue` 仍正常返回——改的是收口形态与落账时机。
- **不改**内核：等人绝不挂在 `waiting` 上（无限期等待 vs 同 `now` 续跑、在途态停机即丢，见 `docs/host.md` §五「等人是回合级挂起」）。
- 补图数据完备性测试：每种非终结裁决都有出边；缺出边即测试红。

### B-b 门禁 `escalate` 未拦住 webfetch 的实际调用（根因待定位）

**现象**：审批项留在队列里未决，webfetch 调用已经发生并失败。审批闸门未生效。

**根因待定位，不得凭现象下结论**。已知事实：门禁前置在设计上**是有的**——`plugins/guard/execute/judge.ts:202-208` 按"工具声明 net vs 当前档 net 范围"判越档，`plugins/tool-browser/execute/net.ts:1-3` 声明 tool-browser **自身**也做 net 钳制（越档 → `net_denied`，fail-closed），并支持 `approvalGrant` 签发的一次性放宽。故这不是"完全没有闸门"，而是某一环衔接失效。三个候选，须先证伪再改：

1. **判定输入缺失**：`gateBag` 传入的 `tier_net` / 工具声明 `net` 缺失或形态不符 ⇒ 判成 `allow`（`judge.ts:228` 缺失按 `none` fail-closed，故更可能是工具声明侧 `net` 没带上）。
2. **B-a 的连带**：`pending` 无出边使该轮静默收口，而工具调用在更早的段已发出 ⇒ 现象是"没等审批就调了"，实为两个 bug 叠加。**此项最可疑，须先修 B-a 再复测**。
3. **钳制口径分裂**：`guard` 判越档与 tool-browser 自钳制两处口径不一致（如档位映射来源不同），一处放行一处拒。

**定位手段**：复现时取该 `run` 的 `EffectAudit` 与 `guard.judge` 的 `decisions`，比对"判定结论"与"是否存在对应效果审计"。**回归断言（无论根因为何都要立）**：门禁判 `escalate` 且审批未决时，同 `run` **不得**存在该调用的效果审计——这是"闸门生效"的机械证据。

**口径**（已入 `docs/host.md` §五 效果）：门禁必须前置于效果，工具实现侧不得在放行前触网 / 触盘；**载体不代为阻断**（它不认识哪次调用需要审批）。

### 与本重构的关系

- 边跑边追加（定案 9）只缓解 B-a 的症状（已发生的消息立刻可见），**不修** `pending` 无出边这个图缺陷。
- 两个 bug 修完即可用，不必等 P2/P3。**B-a 先做**：B-b 的候选根因之一就是 B-a 的连带，先修再复测可能省掉一次误诊。
- C2（同回合多写各自基于回合初 base）**只对已出世界的身份消失**，`loop-policy` / `evolve-metrics` 仍在世界，仍按 `docs/plans/world-lifecycle-residuals.md` 单独修。

## 一、阶段与依赖

| 阶段 | 内容 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| B | 两个正确性 bug（§零之二：B-a `pending` 无出边、B-b 审批闸门未生效） | B-b 须先修完 B-a 再复测 | 与 P0–P4 全程并行 |
| P0 | 宿主地基：`durable` 档 + `state/data/<id>/` + `CHRONO_PLUGIN_DATA` + `exclusive:["data"]` + 备份 / 回收口径 | — | 否（后续全依赖它） |
| P1 | 调用帧 `emitter` + 审计保留分档 | — | 与 P0 并行 |
| P2 | 第一方存储服务两个插件 | P0、P1 | 内部两插件可并行 |
| P3 | owner 插件迁移（按批） | P0；用存储服务的批另依赖 P2 | 批间可并行 |
| P4 | 清场：受保护 `pins` 扩表、补丁机器收敛、残留口径与文档核对 | P3 | 否 |

阶段口径：**每阶段独立可交付、可单独验收**；P3 各批之间不共享改动面，适合分派子代理并行。B 与重构各阶段改动面不重叠（B 在 `loop-policy` 图数据与工具层，P0/P1 在 `packages/host`），可同时开工；**B 优先落地**——它是现网可见的正确性问题，而重构是长期收益。

W1（`session` / `input`）迁移时会重写落账时机，与 B-a 的"收口前先落账已发生事实"同一处代码；**若 B-a 先完成，W1 按其结果继续改，不回退**。

---

## 二、P0 宿主地基

### 2.1 声明面：`state` 两档 + `exclusive:["data"]`

- `packages/host/assembly/decl.ts`：`state` 校验从"只认 `recomputable`"放宽为 `recomputable | durable`（其余值仍拒 `bad_plugin_decl`）；`exclusive` 资源类白名单增 `data`。
- **交叉校验**：声明 `exclusive` 含 `data` 但 `state !== 'durable'` → 拒 `bad_plugin_decl`（声明自相矛盾）。按**声明**判，不看运行期目录是否已建（入世期看不到目录）。
- 覆盖 `seed` / `pack` 入世与 `host.validate_package` dry-run（同一 `planPack` 路径，无需分别改）。

### 2.2 目录面：`state/data/<id>/`

- 新增落点 `packages/host/plugin-data.ts`：解析本身份持久目录路径、`mkdir`、身份名安全单段校验（复用既有校验器，勿复制一份）。
- `packages/host/assembly/service-launcher.ts`：**准备阶段**（不在 spawn 阶段）为声明 `durable` 的身份建目录，spawn env 注入 `CHRONO_PLUGIN_DATA`；③ 的 `CHRONO_PLUGIN_STATE` 保持不变，两个变量都注入、互不替代。
- 未声明 `durable` 的身份**不建目录、不注入变量**（不给隐式持久层）。

### 2.3 回收与备份

- `packages/host/host.ts` 启动 GC 段：`state/data/` 与 `state/plugins/` **分开处理**——都只删目录名 ∉ `world.ids` 的顶层项，但 `state/data/` **不参与**"active + 前 N 代"窗口回收，且删除失败只记运维日志、不阻锁释放。
- `retire` / `set_active(null)` 后 id 仍在 `world.ids` ⇒ 目录保留（与 ③ 同规）。
- 备份口径是文档事实（`docs/host.md` §三已改），无代码面；若仓库内有备份 / 打包脚本提及 `state/world` + `state/blobs`，同步补 `state/data`。

### 2.4 换人序

- `packages/host/assembly/` 换代路径：`exclusive` 判定从"只看 `port`"改为"命中任一资源类即走独占序"。**独占序逻辑本身不改**（先准备 → drain 旧 → 再 spawn → 切端点），只扩触发条件。
- 失败分流照旧（准备阶段失败保留旧服务；spawn / 握手失败转入"无服务但保留世代"）。

### 2.5 测试

- `packages/host/assembly/test/decl.test.ts`：`state:'durable'` 通过；`state:'weird'` 拒；`exclusive:['data']` + `recomputable` 拒；`exclusive:['data']` + `durable` 通过。
- `packages/host/test/plugin-data.test.ts`（新建）：目录按身份创建、env 注入、未声明 durable 不建不注入、不安全身份名 fail-closed。
- `packages/host/test/host-recycle.test.ts`：`state/data/<id>/` 在代码换代与 `set_active` 回滚后仍存在；id 从 `world.ids` 消失后被删；窗口回收不碰它。
- `packages/host/assembly/test/runtime.test.ts`：声明 `exclusive:['data']` 的身份换代走独占序（已有 `toy-w-state` 夹具可复用）。

**验收**：`packages/host` 下 `npm test`、`npm run typecheck` 全绿。

---

## 三、P1 调用帧 `emitter` 与审计分档

### 3.1 `env.emitter`

- `packages/host/effect/`：构造正向 `call` 帧的 `env` 增 `emitter`（取值与 `EffectAudit.emitter` 同源，勿另算一份）；宿主保留能力类调用记 `host`，取不到记 `null`。
- 反向 `port.call` 转发：`emitter` = 发起该反向调用的服务身份（与 `run` / `thread` 的回带口径同处，见 `packages/host` 反向转发落点）。
- **不得**进入 `canonicalJson(args)` 缓存键，也不改审计 `args`——只加帧字段。
- 端口审计对 `args.env` 值脱敏的既有逻辑不动（那是 `args` 顶层 `env`，与帧 `env` 不同层，勿混）。

### 3.2 审计保留分档

- `packages/host/audit-store.ts`：保留窗口从"全局条数 + 字节"改为**按端口分档**，每档各自预算（档位与预算住宿主常量）。高频数据端口占独立档，不与模型 / 工具 / `host` 端口争窗口。
- 淘汰仍是"档内最旧先走"；半写安全、单写者、回填标记等既有性质不变。
- **不改**"每次效果必留一条审计"。

### 3.3 测试

- `packages/host/test/host-capability.test.ts` 或就近：帧 `env.emitter` = 发出者身份；反向调用 `emitter` = 发起服务；`host` 调用记 `host`。
- `packages/host/test/audit-store.test.ts`：单端口刷满不挤掉其他端口的记录；档内淘汰仍按最旧。

**验收**：`packages/host` 下 `npm test`、`npm run typecheck`。

---

## 四、P2 第一方存储服务

两个独立插件包，各自 `plugin.json` / `README.md` / `.worldignore` / `test/` 齐备，遵循插件十条红线。

### 4.1 关系型

- 身份 `storage-sql`，`implements: ["storage-sql"]`，方法按"粗粒度数据操作"设计（建表 / 查询 / 写入 / 事务批），`state: "durable"`。
- 引擎选 SQLite（WAL）。**是否声明 `exclusive:["data"]` 由引擎事实决定**：WAL + 文件锁容多进程并存 ⇒ 缺省**不声明**，走零空窗换代；若实测新旧实例并存不安全再加。
- 需要原生构建则 `plugin.json.build` 显式声明，产物按 `docs/plugins.md` §三 红线 5 的两种合法形态之一落点，并写进 `.worldignore`（否则字节差异污染内容哈希、触发换代死循环）。

### 4.2 文件 / 文档型

- 身份 `storage-kv`，`implements: ["storage-kv"]`，追加日志 / 目录文件实现，零原生依赖，`state: "durable"`。
- 与 `storage-sql` 分包的理由：不让只要文件读写的场景背上原生构建。

### 4.3 两者共同口径

- **按 `env.emitter` 分库**：一个 owner 一份库 / 一个子目录；**拒绝**调用方自报的 namespace 参数（可伪造）。
- **必须提供"丢弃某命名空间"方法**：身份退役时宿主能机械删 `state/data/<id>/`，但**删不掉存储服务库里属于该 owner 的命名空间**（那是存储服务的 ④ 目录）。故存储服务须自带该方法并在 README 写明清理责任方；宿主不代劳、不认识命名空间语义。这是委托存储相对自写存储的**唯一生命周期缺口**，不补就会漏数据。
- **大字节不入帧**：二进制走 `host.asset.put` / `host.asset.get`（pin `host`），存储里只留引用。
- 密钥不进存储明文（与不进世界同规）。
- 自身迁移由自己在启动时做，宿主不代劳。

### 4.4 目标消费者（按真实成本分工，非风格）

自写存储零协议开销、零审计；委托 `storage-*` 每次读写付一次 `eff` 往返 + 一条审计。故：

| owner 类型 | 落点 | 理由 |
| --- | --- | --- |
| 热路径、每回合多写（`session` / `input` / `chat`） | **自写**（本地文件 / 追加日志） | 协议往返与审计写放大都吃不起 |
| 有真查询需求（检索、聚合、跨条件筛） | 自写 sqlite 或 `storage-sql` | 按查询复杂度定，不按"是不是数据" |
| 低频、不在意延迟（`todo` / 界面配置 / `mcp` 清单） | **`storage-*`** | 省掉各自手搓持久化 |
| 派生可重算（向量索引、检索缓存） | ③ `CHRONO_PLUGIN_STATE` | 删了能重建，不占 ④ |

**代价写明**：存储口径因此散成两种（自写 / 委托），备份归属仍统一（都在 `state/data/`），但"怎么存"不再只有一份实现。这是为避免热路径吃跨进程往返而**刻意**付的。

### 4.5 测试

- 各包 `test/`：包形状、声明合法性、方法级读写往返、按 `emitter` 隔离（A 写的 B 读不到）、并发写事务、启动迁移幂等。
- `tools/e2e-smoke.mjs`：`boot pack` / `seed` 该包及其 pins 闭包，核对声明 / 命令 / `.worldignore`。

**验收**：各插件目录 `npm test`。

---

## 五、P3 owner 插件迁移

### 5.1 迁移模式（每个 owner 一致）

1. 判定该身份的每个数据字段属"定义 / 判定"还是"运行记录"（判据两问），**逐字段列表写进该插件 `README.md`**。
2. 运行记录字段：删掉 `put` + `add_gen` 写计划构造，改为服务内部写自有存储（自建或经 `storage-*`）。
3. 读侧：原先经投影 `ctx.ids.<id>.body` + `refs` 还原的路径，改为服务直接读自己的存储并返回；入口 term 不再传该切片。
4. `plugin.json`：加 `state: "durable"`（自建存储）或 `pins` 指向 `storage-*`（委托）。
5. **存量不搬**（定案 7）：新存储从空开始，不写迁移脚本、不做逐字段对账。旧数据世代留在链上，读侧不再指向它。
6. 留在世界的定义 / 判定字段保持原路径不动。
7. **写入时机改为边跑边追加**（定案 9）：不再攒到回合收口一次性落，产生即写；每条记录盖回合 id，供续跑 / 重试幂等收敛。
8. **③ 与 ④ 分清**：能由 ④ 重算的派生物（向量索引、检索缓存、水位）落 `CHRONO_PLUGIN_STATE`，**不进** `CHRONO_PLUGIN_DATA`。判据是"删了能不能重建"，不是"大不大"。

### 5.1.1 读侧装配点不变（防误解）

interpret bag 仍在**同一处**装配（chat 服务），只是每个键的来源二分——不是"散成两个地方读"：

| 仍走投影（留世界） | 改走 `eff` 问 owner（运行记录） |
| --- | --- |
| `graph`、`guard_rules`、`sandbox_tiers`、`tools_bindings`、`evidence`、`tier` | `input`、`session`、`memories`、`todo`、`mcp_tools`、`workspace_root` |

这是既有通则（"服务不读投影，由调用方装 bag 传入"）的延续，来源多一类而已。**相内顺序仍由 loop-policy 图数据定**，不由存储位置定。

看似互相等待的依赖实为**时序两相**，不是环，迁移时不得据此引入 `pins` 环：`session-title` 的消息文本取自**输入槽**而非 session 存储（读槽 → 算标题 → 写 session，一条直线）；`memories` 开局读、收口写；compress 读历史、写摘要。身份级 `pins` 闭包**仍必须是 DAG**，成环即隔离该分支（口径未变）。

### 5.2 分批（批间无共享改动面，可并行分派）

落点按 §4.4 分工：W1 自写（热路径），W2 按字段判，W3–W5 低频者走 `storage-*`。

| 批 | owner 身份 | 主要写方落点 | 备注 |
| --- | --- | --- | --- |
| W1 | `session`、`input` | `plugins/session/execute/{plan.ts,methods.ts}`、`plugins/ui-chat/execute/web/slot-write.ts` | 最高 churn，收益最大；消息链 + 输入槽全出世界；`chat.history` 改为服务读自有存储（去掉 `refs` / hydrator 还原） |
| W2 | `approval`、`question` | `plugins/approval/execute/plan.ts`、`plugins/question/execute/plan.ts`、`plugins/ui-approval/execute/{plan.ts,web/store.ts}` | 队列与待答项出世界；**verdict / 证据若被采纳闸或回滚读，留世界**，逐字段判 |
| W3 | `todo`、`short-memory`、`memory-store` | `plugins/todo/execute/{plan.ts,todo.ts,methods.ts}`、`plugins/compress/execute/plan.ts`、`plugins/memory-store/execute/{plan.ts,methods.ts}`、`plugins/memory-consolidate/execute/{plan.ts,methods.ts}` | 记忆条目与压缩产物是运行记录；向量索引仍是 ③ 缓存、不混进 ④ |
| W4 | `config`、`skill`、`mcp`、`workspace` | `plugins/ui-settings/execute/{plan.ts,web/config-model.ts,web/components/Skills.tsx}`、`plugins/mcp/execute/{plan.ts,methods.ts}`、`plugins/workspace/execute/body.rs`、`plugins/model-protocol/execute/{plan.ts,profile.ts}` | 用户配置是运行记录；**被判定读的绑定 / 阈值留世界**，此批判字段最细，勿整份搬 |
| W5 | UI 侧内联写方 | `plugins/ui-sidebar/execute/{plan.js,methods.js,web/sidebar-model.ts}`、`plugins/ui-composer/execute/web/{model.ts,store.ts,client.ts}`、`plugins/ui-shell/execute/{http-server.ts,bridge.ts}`、`plugins/plugin-admin/execute/{methods.ts,visibility.ts}` | 界面偏好全是运行记录；多处内联构造，先抽公共写口再逐处替换 |

### 5.3 不迁移（写明理由）

- `plugins/loop-policy/execute/{plan.ts,proposals.ts}` 的 trace / verdict、`plugins/evolve-metrics/src/*.rs`、`plugins/evolution`、`plugins/orchestration-admin/execute/propose.ts` 的提案：**采纳闸与回滚要读**，属判定平面，留世界。
- `packages/host/assembly/ingest.ts` 的代码 `commit` 世代：定义本体。
- `plugins/*/tools/seed-default-body.mjs`：离线 seed 写的是该身份的**定义缺省值**；若其内容判为运行记录则随对应批一起改。

### 5.4 每批测试

- 该插件 `test/`：运行记录写入 / 读回往返；**世界不再新增世代**（断言该 run 的 journal 无该身份 `add_gen`）；定义字段仍走世界且组装结果不变。
- **边跑边追加**：回合中途（未收口）记录已可读；同回合 id 重复写幂等；模拟中途中断后残留半份状态可辨识。
- **③ / ④ 分界**：删掉 `CHRONO_PLUGIN_STATE` 整个目录后，服务仍能从 ④ 重建派生物并正常应答。
- 委托 `storage-*` 的 owner：另断言"丢弃命名空间"方法可清净本 owner 数据。
- 端到端：`plugins/*/tools/e2e-smoke.mjs` 照旧过。

**验收**：各插件目录 `npm test`；`packages/host` 下 `npm test` 不退步。

---

## 六、P4 清场

- **受保护 `pins` 扩表**：宿主侧受保护身份表增 `storage-sql` / `storage-kv`（`docs/protocol.md` 的 `protected_pin_removed` 描述已改），补入世拒绝测试。**覆盖范围与既有受保护身份同**：只覆盖入世（`seed` / `pack` / `validate_package`），裸运行期顶层 `add_gen` 不经入世门禁——这条已知不对称照旧，不在本计划内扩。
- **补丁机器收敛**：运行记录出世界后，`add_gen` 的 `base` + `ops` 只服务定义数据。核对 `packages/kernel/rebase.ts` 的 `flattenPatches` 与宿主 `assembleGenBody` 仍被真实使用；**内核公共面不删**（老日志要能重放），但 `docs/plans/world-lifecycle-residuals.md` 的 C1 分批表按本计划作废，C2 只对仍在世界的写方（loop-policy / evolve-metrics）保留。
- **B2 缩小**：`keepGens` / `keepRoots` 的投影闭包保留只需覆盖**定义数据世代**；运行记录已不在世界，跨轮续跑撞 compact 的那条路径随之消失，补回归断言固化。
- **口径核对**：全仓搜 `state: "recomputable"` 的注释与 README 描述，凡与新两档口径不符的改正。
- **"唯一写口"措辞清理**：该全局名词已废，改为「写入落点 + 该落点的写者」（`docs/host.md` §五「写入落点」）。全仓搜"唯一写口""唯一写者""真源"，凡未限定到具体落点的改正；`docs/plans/host-plan.md` 的 A8「单写者保证」与 `docs/plans/chrono-agent-graph-plan.md` GA0 的措辞同步收窄为"世界单写者"。**行为不改**：世界那一处仍是载体独占写 + 内核四步校验（物理约束：单链 + `expect_pos` CAS）。
- **`session` 并发妥协清理**：per-thread 键控 + last-write-wins 的补丁式并发处理（`plugins/session/execute/plan.ts` 的 `pushInputGen` / `clearSlotsBody` 一线）在单 owner 存储下不再需要，按根因删除而非保留。

---

## 七、验收与命令

- 内核：`packages/kernel` 下 `npm test`、`npm run typecheck`（本次**与 B 均不应改动内核**，用于证明内核未被牵动）。
- B 段：`plugins/loop-policy` 下 `npm test`（图完备性：每种非终结裁决有出边）、`plugins/approval` 下 `npm test`；端到端断言"门禁 `escalate` 时同 `run` 无对应效果审计"，以及"挂起收口后本轮消息已在历史里、跨重启可裁决续跑"。
- 宿主：`packages/host` 下 `npm test`、`npm run typecheck`（含 `assembly/test/`、`ledger/test/`、`projection/test/`）。
- 薄壳：`packages/boot` 下 `npm test`、`npm run typecheck`。
- 插件：各插件目录 `npm test`（`node --test`），至少覆盖 `session`、`approval`、`question`、`todo`、`memory-store`、`memory-consolidate`、`compress`、`mcp`、`model-protocol`、`ui-settings`、`ui-approval`、`storage-sql`、`storage-kv`。
- 端到端：`packages/host/test/` 的 `host-recycle` / `host-generation` / `host-def-read` / `host-audit` 全绿；各包 `tools/e2e-smoke.mjs` 全过。
- 每阶段单独提交，提交信息无人称、无计划编号。

---

## 八、风险与不做

- **P0 是唯一串行瓶颈**：`durable` 档与目录面没落地前，P2 / P3 全部无从开工；它本身改动小，优先做完。
- **P3 的字段判定是本次最大风险**：W2 / W4 里"看着像运行记录、实为判定输入"的字段若误搬，采纳闸与回滚会静默失去输入。故每批要求**逐字段列表进 README**，并由独立复核确认，不靠写方自判。
- **存量重来会丢现有会话历史**（定案 7，已接受）：旧数据世代仍在链上、可从 journal 取证，但界面不再展示。切换前如需保留，只能靠人工导出，本计划不提供工具。
- **运行记录失去防篡改**（定案 8，已接受）：改动坏数据不再被链校验发现。取证能力退回效果审计（`state/audit/`，有界保留）与运维日志。
- **跨 owner 半份状态**（定案 9，已接受）：回合中途崩可能只落一部分 owner 的记录。靠回合 id 幂等收敛与可辨识残留兜底，不靠跨库事务。
- **委托存储的命名空间清理是已知缺口**：owner 退役时宿主删不到 `storage-*` 库里那份数据，须存储服务自带丢弃方法（见 §4.3）。漏做就是静默漏数据。
- **备份口径变更要通知到位**：只备份 `state/world/` 从此会丢运行记录。这是 ④ 不可重算且**世界无法重算**的数据。
- **存储服务不是万能落点**：热路径（逐 token 写、向量全扫）留在 owner 进程内部，不走跨进程调用（理由见审计分档）。
- 不改：内核哈希口径、`argsHash` / 链格式、`worldRev` 摘要不吃履历、审计不进世界、`put` / `add_gen` 语义。
- 不做：世界内运行记录的自动迁移工具（一次性脚本按包落 `tools/`，不进宿主）、存储服务的跨身份共享库（单 owner 是纪律）、fs 级沙箱隔离（v1 无沙箱，路径约定而已）。
