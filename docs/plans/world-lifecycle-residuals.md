# 世界生命周期遗留项：处置计划

> 口径来源：`docs/kernel.md`（内核设计，唯一权威）、`docs/host.md`（载体设计）。
> 本文件属 `docs/plans/`，只写"怎么做"，不参与设计口径；冲突时以设计文档为准。
> 承接 `c9a1a0b`（世界可回收化与载荷瘦身）的五个工作流遗留；编码遵循 `docs/coding.md`（根因修复、测试落各子目录 `test/`、禁 PowerShell 写文件、提交信息无人称）。

---

## 零、处置总表

| # | 遗留 | 性质 | 处置 | 阶段 |
| --- | --- | --- | --- | --- |
| A1 | 回收默认即生效（保守 + 窗口） | 已落地 | 无 | — |
| A2 | 孤儿 def 不回收，需 `strict` 且引用图完备 | 能力缺口 | 暴露 `strict` 开关 + 根集完备守卫，默认保守 | P3 |
| A3 | 回收后 `base+尾段 worldRev` ≠ 全量重放 `worldRev` | 刻意（`snapshotRev` 区分） | 固化测试 + 文档，不改口径 | P0 |
| A4 | 被淘汰世代不可再 `set_active` / 作 `graft` 来源 | 固有（`not_a_generation` / `missing_parent`） | 补拒绝测试 + 文档 | P0 |
| B1 | `hydrate` 取回整个可达闭包，未按遍历条目惰性取 | 性能 | 惰性 `RefView`（跨 4 插件大改，可选后置） | P3 |
| B2 | 跨轮续跑恰逢 compact/GC 回收旧 def → `denied`（闭包不完整） | 正确性 | 保留集覆盖投影闭包 + 最近数据世代；`missing` 不再静默 | P1 |
| B3 | `ui-settings.orchestration.scopes` 已是 eff 服务方法，README 仍写"投影读" | 文档 | 清元数据描述 | P0 |
| C1 | input/todo/approval/question/memory/compress/mcp/model-protocol/ui-*/workspace 等仍整份写 | 载荷瘦身 | 分批迁移到补丁世代 | P2 |
| C2 | 同回合多次 evolution 写各自基于回合初 base（后者不叠加前者槽位） | 正确性 | 回合内按身份合并为单世代 | P1 |
| C3 | 压扁仅折叠线性链，非末代被引用时不折叠 | 刻意 | 固化测试 | P0 |
| D1 | 审计记录去掉 `hash` 字段 | 已确认无消费方 | 无 | — |
| D2 | 老 base/journal 历史审计 def 不入侧存（升级后 `host.audit` 看不到） | 迁移缺口 | 首启/离线一次性回填（受窗口约束） | P1 |
| D3 | 审计 `seq` 在并发 run 间非确定 | 刻意（非状态链） | 文档 | P0 |
| E1 | `worldRev` 自校 O(#defs) 纯 JS sha256 主导 base 读 | 性能 | 懒校验 + 缓存（策略见 §4.1） | P3 |
| E2 | `DefStore` LRU 按条数不按字节 | 性能 | 加字节预算 | P3 |
| E3 | compact eager + 逐文件 fsync | 性能 | 批量目录 fsync；流式（可选） | P3 |
| E4 | 旧 v1 base 读到下次 compact 前不自动迁移 | 迁移缺口 | 读时/启动触发一次 v2 重写 | P3 |

阶段口径：**P0 口径固化（不改行为，补测试与文档）→ P1 正确性 → P2 载荷迁移 → P3 性能与迁移**。每阶段独立可交付、可单独验收。

---

## 一、P0：口径固化

### 1.1 A3 回收后摘要语义

不改口径。补测试与文档，确保"`base.worldRev` = 落盘子世界摘要、`snapshotRev` = 快照 entry 全量摘要"这条区分被机械断言。

- 测试：`packages/host/test/host-recycle.test.ts` 断言回收后 `base.snapshotRev !== base.worldRev`，且 `loadAnchor` 跳过快照 entry 自校、以子世界为起点重放尾段后 `head` 正确。
- 文档：`docs/host.md` §五「压缩 / 有界化回收」已有表述，仅核对与代码一致。

### 1.2 A4 淘汰世代的引用拒绝

`applySetActive`（`packages/kernel/journal.apply.ts:138-140`）对不在 `gens` 的 payload 报 `not_a_generation`；`applyAddGen` 的 `base` 越界（:175-176）与 `graft` 来源越界（:183-185）报 `missing_parent`。三处已是 fail-closed，补测试固化：

- `packages/kernel/test/recycle.test.ts`：回收后对已淘汰 payload 发 `set_active` → `not_a_generation`；对已淘汰 `base` 发 `add_gen` → `missing_parent`；`graft` 指向已淘汰 `src.gen` → `missing_parent`。
- `docs/host.md` §五「有界化回收」补一句：被淘汰世代不可再被 `set_active` / `graft` / 补丁 `base` 引用（保留集由窗口 + `pins`/`graft`/`base` + 投影闭包决定，见 §2.2）。

### 1.3 C3 压扁边界

`flattenPatches`（`packages/kernel/rebase.ts`）仅折叠线性链、非末代被引用时不折叠。补测试固化边界（被 `pins`/`graft` 引用的非末代补丁世代不折叠；线性链按阈值折叠为整份世代后 `worldRev` 与组装结果不变）。

- 测试：`packages/kernel/test/rebase.test.ts`（或 `patch.test.ts`）增两例。

### 1.4 D3 审计 seq 语义

`AuditRecord.seq`（`packages/host/audit.ts:10-16`）是侧存单调计数，非 journal `Entry.seq`，并发 run 间按效果完成序分配、不参与重放。

- 文档：`docs/host.md` §五「只读审计面」补一句"`seq` 是侧存到达序，跨并发 run 非确定，不属状态链"。

### 1.5 B3 ui-settings 元数据

`plugins/ui-settings/plugin.json:102-104` 与 `README.md:29` 仍描述 `orchestration.scopes` 为"投影读"；实际入口 term 已是 `["eff","ui-settings","scopes",…]`（`terms/orchestration.scopes.json`），处理器 `execute/methods.ts:534-539` 经 hydrator 解析投影 refs。

- 改：README 措辞改为"eff 服务方法：按需解析投影 refs"。
- `readonly` 字段是否保留取决于该命令是否仍声明为只读查询；先读 `plugin.json` 该命令声明与 `docs/host.md` §五「命令」的只读语义再定，**只改描述、不动派发行为**。

---

## 二、P1：正确性

### 2.1 C2 同回合多写合并为单世代

**问题**：`buildTraceTail`（`plugins/loop-policy/execute/tail.ts:63,79`）与 `verdictPlan`（`proposals.ts:185,195`）各自以回合初 `bag.evolution.data_gen.seq` 为 `base` 产一条独立 `batch`。宿主对每条 `write` 单独起一轮（`docs/host.md` §五「落账 · 分相」），故第二条补丁组装时仍以回合初 base 为准，**丢掉第一条补丁改动的槽位**。多提案同回合多条 verdict 同理；且 `makeVerdict`（`proposals.ts:200-212`）恒置 `prev: null`，verdict 链本身只保留末条。

**方案**：回合内按身份累积补丁，回合尾合并为**单个世代**。

- `plugins/loop-policy/execute/plan.ts` 增回合累积器 `RoundPatches`：
  - `stage(identity, entryBody)` 登记一条待落条目，串接 `prev` 到该身份上一登记条目（或回合初 tail），返回占位下标；
  - `patch(identity, ops)` 登记该身份的补丁 ops；
  - `finalize()` 每身份产 `put(entries…)` + `put({ops: merged})` + `addGenOp(id, patchIndex, pins, base)`，并修正 `$n` 下标与槽位 `count` / `tail`。
- `tail.ts` 的 trace 与 `proposals.ts` 的 verdict 改为向累积器 `stage` + `patch`，不再各自产 batch。
- `methods.ts`（:142-152）在 `planOf` 前调用 `finalize`，把同一身份的 trace/verdicts 合并为**一个** `evolution` 世代；空补丁仍回落整份世代（保留现有行为）。
- `proposals.ts` 的 `expandAdoption` / `expandRejection` 同路走累积器。
- evolve-metrics 三个方法（`src/record.rs`、`src/sweep.rs`、`src/aggregate.rs`）各自经 `bag::base_of`（`src/bag.rs:241-255`）取 base：若同回合可能被多次调用，按同法在 Rust 侧聚合后再产 `add_gen`；若实际不会同回合触发，补断言测试并在 README 写明约束。

**测试**：

- `plugins/loop-policy/test/interpret.test.mjs`：同回合产 trace + verdict，断言最终组装 body **同时**含新 trace 与新 verdicts，且该身份只新增一个世代、`base` 指向回合初。
- `plugins/loop-policy/test/proposals.test.mjs`：两提案同回合拒绝，断言两条 verdict 经 `prev` 链均可 `ledgerEntries` 到达。
- 组装结果用宿主投影 `assembleGenBody` 口径核对（补丁世代取 base 组装后按序应用）。

### 2.2 B2 回收保留集覆盖投影闭包

**问题**：`retainedGens`（`packages/kernel/recycle.ts:149-188`）保留窗口 + `active` + `pins`/`graft`/`base`。投影 `body` 取 `latestDataGen`（`packages/host/projection/index.ts:152,156`）的组装结果；若某身份最近数据世代落在窗口外（其后代码世代数 > `DEFAULT_GEN_RETENTION`），该世代被裁、其 payload 与 `{"def":hash}` 闭包 def 被回收。随后 `host.def.read`（`packages/host/host-capability.ts:165-223`）的 `reachableDefHashes`（`projection/index.ts:66-79`）跳过缺失 def，请求落 `denied`；插件 hydrator（`plugins/chat/execute/refs.ts:57-79` 等四份）对缺失静默 `continue`，**闭包不完整而不报错**。跨轮续跑恰逢 compact 即命中。

**方案**（三处）：

1. **保留最近数据世代**：`RecycleSpec` 增 `keepGens?: { id: string; seq: number }[]`（内核只做机械并集，不解释数据 / 代码）；`retainedGens` 先并入该集合。宿主在 `packages/host/compact.ts` 的 `compactWorld` 调 `recycleWorld` 前，按 `latestDataGen(world, id)` 计算每身份的 `keepGens`（数据世代下标）与 `keepRoots`（数据世代 payload + 其闭包哈希），传入并随 `CompactRetention` 下传。默认开启，保证投影 body 及其闭包恒在 base。
2. **`def.read` 的 `missing` 不再静默**：`defReadCall` 对"越权"回 `denied`、对"世界缺失"回 `missing`（现状）；四份 `refs.ts` 的 hydrator 对 `missing` 返回结构化错误 `{ ok:false, error:{ code:'def_unavailable', hashes } }`，调用方据此重解析或拒绝，不产生不完整闭包。
3. **续跑保留**：compact 时把各身份 `active` 世代纳入 `keepGens`（1 已覆盖数据世代）；续跑 directive 的 entry def 属代码 / term 世代，随 `pins`/`active` 闭包保留。补端到端断言。

**测试**：

- `packages/kernel/test/recycle.test.ts`：`keepGens` 用例——窗口外数据世代与其闭包保留、世代下标重映射正确。
- `packages/host/test/host-recycle.test.ts`：构造"数据世代后接 > 窗口代码世代"，compact 后断言数据世代 payload 与其 `{"def":hash}` 闭包仍在 base。
- `packages/host/test/host-def-read.test.ts` + `projection/test/projection.test.ts`：缺失 def 时 hydrator 报 `def_unavailable`，不再静默空。
- `packages/host/test/host-generation.test.ts` 或 `host-recycle.test.ts`：compact 后按同 `run_id`/`now`/`directives` 续跑成功。

### 2.3 D2 历史审计一次性回填

**问题**：`c9a1a0b` 起审计 def 不再进 base（`compact.ts:125` `stripAuditDefs`），旧 base/journal 里的历史审计 def 不导入侧存；升级后 `host.audit`（`AuditStore` 内存索引，`host.ts:283-284`）看不到旧记录，旧 def 下次 compact 被摘除。

**方案**：一次性回填，受保留窗口约束。

- 新增 `state/audit/meta.json`（`{ backfilled: true, throughEntrySeq: number }`；缺省视为未回填）。
- 启动路径 `packages/host/host.ts`：`loadAnchor` 与 `AuditStore.open` 之后，若未回填，扫 base world defs 与冷段 / 尾段 entry 的 `put` args，取 `body.kind === 'effect_audit'` 的 def，按 entry `seq` 升序重建 `{ seq, at, by, body }`，追加进侧存（`seq` 续 `nextSeq`），写 `meta.json`。
- 只回填窗口内记录（按 `AUDIT_MAX_RECORDS` / `AUDIT_MAX_BYTES` 从新到旧取），避免无界；超出部分不回填。
- `packages/host/offline.ts` 的 `runCompact` 同路（持锁时执行）。
- 幂等：`meta.json` 标记，重复启动不重复追加。

**测试**：

- `packages/host/test/audit-store.test.ts`：旧 base 含审计 def → 回填后侧存可见；窗口裁剪；二次启动不重复。
- `packages/host/test/host-audit.test.ts`：端到端 `host.audit` 查到回填记录。
- 文档：`docs/host.md` §五「审计旁路侧存」补一句"升级后首启一次性回填历史审计（受窗口约束）"。

---

## 三、P2：补丁写方迁移（C1）

### 3.1 迁移模式

照 `plugins/session/execute/plan.ts:55-67,133-147` 与 loop-policy 的参考实现：

- 入口切片已带 `data_gen`（`packages/host/projection/index.ts:156-157`），`base = data_gen.seq`；
- `addGenOp(id, index, pins, base)` 携带 `base`；payload 指向同批 `put({ ops:[…] })` 的补丁 def；
- 补丁 ops 用 `append|replace|delete` + 路径表达本次改动；空改动回落整份世代。

### 3.2 分批（按身份热度）

| 批 | 写方 | 身份 | 备注 |
| --- | --- | --- | --- |
| W1 | `plugins/session/execute/methods.ts`（input 槽）、`plugins/todo/execute/plan.ts`、`plugins/approval/execute/plan.ts`、`plugins/question/execute/plan.ts` | input / todo / approval / question | 高 churn；input 按 `body.slots[<thread>]` 路径 `replace` |
| W2 | `plugins/memory-store/execute/plan.ts`、`plugins/memory-consolidate/execute/plan.ts`、`plugins/compress/execute/plan.ts`、`plugins/mcp/execute/plan.ts` | memory-store / short-memory / mcp | |
| W3 | `plugins/model-protocol/execute/plan.ts`（`profile.ts:266`）、`plugins/ui-settings/execute/{plan.ts,web/config-model.ts}`、`plugins/ui-approval/execute/{plan.ts,web/store.ts}`、`plugins/ui-sidebar/execute/web/sidebar-store.ts`、`plugins/ui-composer/execute/web/model.ts`、`plugins/ui-chat/execute/web/entry.tsx`、`plugins/ui-shell/execute/http-server.ts`、`plugins/workspace/execute/body.rs`、`plugins/plugin-admin/execute/methods.ts` | config / input / skill / workspace / plugin-admin | UI 侧多处内联构造，先抽公共 `addGenOp` |

### 3.3 不迁移项（写明理由）

- `packages/host/assembly/ingest.ts:289-292`：代码 `commit` 世代，整树哈希随改动变化，补丁无收益；保持整份。
- `plugins/*/tools/seed-default-body.mjs`：离线 seed 一次性写入，不在热路径。

**测试**：每写方加"同内容旧 / 新形态组装结果逐字段一致"用例；`base` 指向 `data_gen.seq`；空改动回落整份。宿主侧复用 `assembleGenBody` 口径核对。

---

## 四、P3：性能与迁移

### 4.1 E1 `worldRev` 自校

**问题**：`readBase` 的 `selfCheck`（`packages/host/ledger/base.ts:138-144`）对全 def 键算 `worldRev`（`packages/kernel/journal.id.ts:34,52`，纯 JS sha256），小 def 多时主导 base 读耗时。

**方案甲（推荐，默认）**：懒校验 + 进程内缓存。

- `BaseFile` 增惰性 `verify()`：首次调用算 `worldRev` 并缓存结果，`readBase` 不再 eager `selfCheck`；`bad_base` 仍在首次需要摘要时 fail-closed。
- 校验点（`loadAnchor` 接驳校验、`status`、`compact`）按需调 `verify()`；缓存键 `(file, mtimeMs, size)`，同进程重复读不重算。
- 提供强制校验入口（离线 `verify` 或启动开关），供运维 / 测试。
- 权衡：损坏不再在 `readBase` 当场发现，而在首次用摘要时发现；正常路径本就需要摘要，行为等价。

**方案乙**：保持 eager，仅加 `(file, mtimeMs, size)` 缓存（不解决单次启动耗时）。若要求 `readBase` 即 fail-closed，取乙。

### 4.2 E2 `DefStore` 字节预算

`packages/host/ledger/def-store.ts:104-112` 的 LRU 仅按条数（`DEFAULT_DEF_CACHE = 4096`）。加字节预算：登记每 def 的近似字节（`JSON.stringify(def.body).length`），条数与字节任一超限即淘汰；另注意整片入缓存（:83-85）会一次挤掉大量条目，可按分片字节预检。

- 测试：`packages/host/ledger/test/base-shard.test.ts` 增字节淘汰与"大 def 不撑爆"用例。

### 4.3 E3 compact 批量 fsync

现状：`writeBase` 逐分片 `writeFileAtomic`（`base.ts:209-214`），每文件一次 `fsyncSync` + 一次目录 fsync（`packages/host/ledger/atomic.ts:23-40`），N 分片 ⇒ 2N 次 fsync。

- 增批量写入器：全部 staging 文件写完并逐文件 `fsync`（数据持久化不可省），rename 全部后**目录 fsync 一次**。
- 可选（后置）：compact 从既有 `DefStore` 流式读保留 def，不整体物化世界；`snapshotRev` 计算仍需全键。

### 4.4 E4 v1 base 自动迁移

`readBase` 的 v1 分支（`base.ts:62,68-93`）照读内联世界，仅下次 compact 才写 v2。加读时迁移：在可写上下文（启动 / 离线）读到 `v === LEGACY_BASE_VERSION` 时，以同一 `snapshot`/`world`/`worldRev` 调 `writeBase` 落 v2（不新增 journal entry、不改链头），随后清理旧内联体。

- 测试：构造 v1 base，启动后断言磁盘变 v2 且 `head`/`worldRev` 不变。

### 4.5 A2 严格回收开关

内核 `RecycleSpec.strict` 已实现（`recycle.ts:21-22,244-248`），宿主从不传（`compact.ts:53-58`）。

- 暴露 `boot compact --strict` 与 `CHRONO_COMPACT_STRICT`（优先级 CLI > env > 关），仅离线 / 显式时启用。
- 守卫：启用前要求引用图完备——宿主能枚举全部身份与世代，但 body 内非 `{"def":hash}` 标记的哈希不可见；文档写明"strict 仅在世界未使用标记外引用的前提下安全"。
- 测试：`packages/kernel/test/recycle.test.ts` 已覆盖 strict；补 `packages/host/test/host-recycle.test.ts` 的开关用例。

### 4.6 B1 惰性 hydrate（可选，后置）

现状 `createRefHydrator`（四份 `refs.ts`）BFS 逐跳取回整个可达闭包（`MAX_HOPS = 10000`、`MAX_CACHE = 4096`）。改惰性需返回异步 `RefView.get(hash)` 并改四个消费方（chat `history.ts` 的 `prev` 回溯、question、loop-policy、ui-settings）为按访问 `await`。

- 收益仅在"超大台账 + 局部遍历"时明显；多数消费方本就需要整闭包。建议先做 §2.2 的 `missing` 显式化，待 profiling 证明确有收益再做。

---

## 五、验收与命令

- 内核：`packages/kernel` 下 `npm test`、`npm run typecheck`。
- 宿主：`packages/host` 下 `npm test`、`npm run typecheck`（含 `ledger/test/`、`projection/test/`）。
- 薄壳：`packages/boot` 下 `npm test`、`npm run typecheck`。
- 插件：各插件目录下 `npm test`（`node --test`），至少覆盖 `session`、`loop-policy`、`question`、`chat`、`todo`、`approval`、`memory-store`、`memory-consolidate`、`compress`、`model-protocol`、`ui-settings`、`ui-approval`。
- 端到端：`packages/host/test/host-recycle.test.ts`、`host-generation.test.ts`、`host-def-read.test.ts`、`host-audit.test.ts` 全绿。
- 每个阶段单独提交，提交信息无人称、无计划编号。

---

## 六、风险与不做

- **P1.1 合并世代**会改变同回合写出的世代数（多条 → 一条），可能影响依赖"每写一世代"的测试与投影 `gens` 断言；须逐处核对并更新。
- **P1.2 `keepGens`** 是内核公共面新增字段（`RecycleSpec`），须同步 `docs/kernel.md` §五 / 附录导出面口径；仅机械并集，不解释语义。
- **P1.3 回填**会一次性增大侧存，受窗口约束；不回填超出窗口的历史，属已知取舍。
- **E1 方案甲**把 `bad_base` 的发现点从读盘推迟到首次用摘要；若坚持读盘即拒，取方案乙。
- 不改：内核哈希口径、`argsHash`/链格式、`worldRev` 摘要不吃履历、审计不进世界。
