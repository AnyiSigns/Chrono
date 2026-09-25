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

内核**不改一行**：它只给被 `put` 的东西做版本，"什么配进世界"是载体判定。

**本计划取代** `docs/plans/world-lifecycle-residuals.md` 的 C1 / C2 与 B2 中与运行数据相关的部分：运行记录不再进世界后，补丁世代（`base` + `ops`）只服务于真正的定义数据，C1 的分批迁移对已出世界的身份作废，B2 的"投影闭包保留"只需覆盖定义数据世代。该文件其余项（A2 / A3 / A4 / B1 / B3 / C3 / D2 / D3 / E1–E4）不受影响，照原计划推进。

---

## 一、阶段与依赖

| 阶段 | 内容 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| P0 | 宿主地基：`durable` 档 + `state/data/<id>/` + `CHRONO_PLUGIN_DATA` + `exclusive:["data"]` + 备份 / 回收口径 | — | 否（后续全依赖它） |
| P1 | 调用帧 `emitter` + 审计保留分档 | — | 与 P0 并行 |
| P2 | 第一方存储服务两个插件 | P0、P1 | 内部两插件可并行 |
| P3 | owner 插件迁移（按批） | P0；用存储服务的批另依赖 P2 | 批间可并行 |
| P4 | 清场：受保护 `pins` 扩表、补丁机器收敛、残留口径与文档核对 | P3 | 否 |

阶段口径：**每阶段独立可交付、可单独验收**；P3 各批之间不共享改动面，适合分派子代理并行。

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
- **大字节不入帧**：二进制走 `host.asset.put` / `host.asset.get`（pin `host`），存储里只留引用。
- 密钥不进存储明文（与不进世界同规）。
- 自身迁移由自己在启动时做，宿主不代劳。

### 4.4 测试

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
5. **一次性数据搬迁**：现存世界数据世代里的运行记录读出、写进新存储；搬迁脚本落该包 `tools/`（不入世，`.worldignore` 已排除），幂等、可重跑。
6. 留在世界的定义 / 判定字段保持原路径不动。

### 5.2 分批（批间无共享改动面，可并行分派）

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
- 搬迁脚本：旧世界数据 → 新存储逐字段一致；重跑幂等。
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

- 内核：`packages/kernel` 下 `npm test`、`npm run typecheck`（本次不应有改动，用于证明内核未被牵动）。
- 宿主：`packages/host` 下 `npm test`、`npm run typecheck`（含 `assembly/test/`、`ledger/test/`、`projection/test/`）。
- 薄壳：`packages/boot` 下 `npm test`、`npm run typecheck`。
- 插件：各插件目录 `npm test`（`node --test`），至少覆盖 `session`、`approval`、`question`、`todo`、`memory-store`、`memory-consolidate`、`compress`、`mcp`、`model-protocol`、`ui-settings`、`ui-approval`、`storage-sql`、`storage-kv`。
- 端到端：`packages/host/test/` 的 `host-recycle` / `host-generation` / `host-def-read` / `host-audit` 全绿；各包 `tools/e2e-smoke.mjs` 全过。
- 每阶段单独提交，提交信息无人称、无计划编号。

---

## 八、风险与不做

- **P0 是唯一串行瓶颈**：`durable` 档与目录面没落地前，P2 / P3 全部无从开工；它本身改动小，优先做完。
- **P3 的字段判定是本次最大风险**：W2 / W4 里"看着像运行记录、实为判定输入"的字段若误搬，采纳闸与回滚会静默失去输入。故每批要求**逐字段列表进 README**，并由独立复核确认，不靠写方自判。
- **一次性搬迁不可逆**：旧世界数据世代仍在链上（历史改不掉），但新存储成为读侧真源后，两边会分叉。搬迁脚本须幂等且在切读侧之前跑完。
- **备份口径变更要通知到位**：只备份 `state/world/` 从此会丢运行记录。这是 ④ 不可重算且**世界无法重算**的数据。
- **存储服务不是万能落点**：热路径（逐 token 写、向量全扫）留在 owner 进程内部，不走跨进程调用（理由见审计分档）。
- 不改：内核哈希口径、`argsHash` / 链格式、`worldRev` 摘要不吃履历、审计不进世界、`put` / `add_gen` 语义。
- 不做：世界内运行记录的自动迁移工具（一次性脚本按包落 `tools/`，不进宿主）、存储服务的跨身份共享库（单 owner 是纪律）、fs 级沙箱隔离（v1 无沙箱，路径约定而已）。
