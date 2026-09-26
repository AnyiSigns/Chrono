# 框架重构：稳定 / 鲁棒 / 插件通用 / 算法 / 简洁轻量

> 口径来源：`docs/kernel.md`（内核设计，唯一权威）、`docs/host.md`（载体设计）、`docs/plugins.md`（插件契约）、`docs/protocol.md`（协议）、`docs/term-toolchain.md`（工具链设计）。
> 本文件属 `docs/plans/`，只写「怎么做」，不参与设计口径；冲突时以设计文档为准。
> 编码遵循 `docs/coding.md`：根因修复（禁补丁式）、测试落各子目录 `test/`、禁 PowerShell 写文件、提交信息无人称且无计划编号。
> 范围：`packages/` 四包 + `toolchain/` + 新增顶层包 `plugin-sdk/`（R9）+ 插件与框架之间的契约面。**不含**任何插件的业务逻辑。

---

## 零、与在进计划的关系（开工前先核这张表）

`docs/plans/runtime-data-out-of-world.md` 正在推进，本计划整体挂在它的 P4 之后，只有 R0（内核正确性）、R2（声明面补全）与 R6（工具链接线）可提前并行。该计划仍在改，故本计划对它的每一条依赖都写成**可核对断言**，而非复述结论。

### 0.1 前置核对表

开工前逐条核实；任一条为「否」则该阶段不得开工，先回本节更新。

| # | 断言 | 核实方式 |
| --- | --- | --- |
| A1 | P0 已落地：`state` 两档 + `state/data/<id>/` + `CHRONO_PLUGIN_DATA` | `git log --oneline` 搜 durable；`rg CHRONO_PLUGIN_DATA packages/host` |
| A2 | P1 已落地：`env.emitter` + 审计按端口分档 | `rg emitter packages/host/effect/` |
| A3 | P2 已落地：`storage-sql` / `storage-kv` 两包齐备 | `plugins/storage-{sql,kv}/plugin.json` 存在 |
| A4 | W1 已落地：`session` / `input` 运行记录出世界 | 两包 `plugin.json` 的 `state` 为 `durable` |
| A5 | W2–W5 全部完成 | 各 owner `plugin.json` 已按 `runtime-data-out-of-world.md` §5.2 落档 |
| A6 | P4 清场完成，含「唯一写口」措辞清理 | 全仓搜「唯一写口」无未限定落点的用法 |
| A7 | 审计分档结构稳定，无在途改动 | `git status --short packages/host/audit-store.ts` 为空 |

### 0.2 本计划从在进计划继承的口径（不得违反）

以下六条是在进计划的定案，本计划的一切改动必须与之一致。若该计划后续修改了其中任何一条，本计划对应条目须同步作废或重写。

| 继承口径 | 对本计划的约束 |
| --- | --- |
| 「唯一写口」作为全局概念已作废，换成「写入落点表 + 该落点的写者」 | R3 抽写入原语时，命名与文档只许说「世界落点的写者」，禁用「唯一写口 / 唯一写者 / 真源」的无限定说法 |
| `state/data/` 与 `state/plugins/` 的回收刻意分开：④ 不参与「active + 前 N 代」窗口、删除失败不阻锁释放 | R1 合并 GC 循环时必须保留两者策略差异（参数化，不是统一行为） |
| 存量不迁、直接重来 | 本计划不得引入任何迁移脚本或存量对账 |
| 运行记录放弃链式完整性与跨 owner 原子性，换边跑边追加 | R0 修 batch 原子性只针对世界落点的 `batch`，与运行记录无关，不得混谈 |
| 内核不改一行（该计划范围内） | R0 改内核，故 R0 不属于那份计划；两者在验收命令上须分别声明，避免「内核未被牵动」这条证明被污染 |
| `keepGens` / `keepRoots` 的投影闭包保留收窄到定义数据世代 | R0-4 修 `recycle` 悬挂 base 必须先于 B2，否则 B2 的回归断言建在漏洞上 |

---

## 一、问题与目标

### 1.1 「插件框架通用」的准确含义

指**框架通用化**（内核 + 宿主），不是插件通用化——插件必须各自独立，若能被一个通用插件替代就不成为插件了。判据是：

> 加一个插件只需读**它自己的声明**（`plugin.json` / `terms/` / 服务回带的 manifest），**不改框架任何文件、不改其它任何插件**。

典型场景（测完即删）：加一个全局背景插件，浏览器自动化截图查看是否生效，框架读它的实现即可，不需要动其它插件代码。

### 1.2 三个结构缺口

1. **框架里有硬编码的插件知识** → 加插件不总是「只读它自己的声明」，有 7 处要改框架代码或框架侧清单（§六 逐条列全）。这是本目标的靶心。
2. **没有共享原语的家** → `isRecord` 在 `packages/` 有 20 处 `function` 定义，`ledger/atomic.ts` 被四个非 ledger 模块直接 import。
3. **没有通道抽象** → 进程模型写死 `ChildProcess`，同语言插件无法同进程加载。R5 扩展同进程通道：由插件自己的 `transport` 声明选择形态，原本的插件独立进程原样保留。约束照旧——插件间禁止互相 import，禁止 import 宿主或内核。

另有一条不属结构缺口但代价同样大：**插件侧各自抄了一遍框架协议**（每插件一份 `frames.ts`，现 34 份 TS + 6 份 Rust，且抄错了规范序列化口径）。它由**顶层独立 SDK 包**解决（R9）。

**两件事不可混谈**：框架通用化说的是「框架不认识具体插件」；SDK 说的是「插件不必重写协议」。SDK 只是消重复，不是「插件通用」的定义。且按口径（插件不得互相 import、不得 import 宿主），SDK 必须是**独立包**，不能塞进任何插件、也不能进 `packages/`。

### 1.3 目标与阶段对应

| 目标 | 主要阶段 |
| --- | --- |
| 稳定 | R0（内核正确性）、R4（拆 `host.ts`，顺带修锁泄漏与孤儿服务） |
| 鲁棒 | R0、R5（通道抽象的失败面收敛） |
| **插件通用（= 框架通用化）** | **R2（声明面补全，消 7 处硬编码）**、R5（传输形态声明化）、R6（工具链接线） |
| 算法优化 | R7（热点，贯穿各阶段） |
| 宏观结构简单 | R1（`common/`）、R4、R5 |
| 干净 | R1、R8（清理） |
| 轻量 | R9（SDK 消每插件一份帧实现）、R8 |

---

## 二、阶段与依赖

| 阶段 | 内容 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| R0 | 内核五个正确性缺陷 | 无（**不属于**在进计划，单独验收） | 与在进计划全程并行；R0-4 须早于该计划 B2 |
| R2 | **框架通用化：声明面补全**（消 7 处硬编码） | 无（只改框架，不改插件业务） | 与在进计划并行（§六 逐项标注冲突面） |
| R6 | 工具链接线（判定进 term） | R0-1（失败节点出内核） | 与在进计划并行 |
| R1 | 抽 `common/`：跨包共享原语归位 | A6（与 P4 口径核对同向，能合并则合并） | 否（R3–R5 全依赖它） |
| R3 | 世界落点写入原语 | R1 | 与 R4 并行 |
| R4 | 拆 `host.ts` | R1、R3 | 否 |
| R5 | `ServiceChannel` + 进程模型（含 `transport` 声明化） | R1、R4 | 否 |
| R7 | 算法热点 | 各阶段内就近做 | 随阶段 |
| R8 | 清理与瘦身 | R4 | 最后 |
| R9 | 插件 SDK（顶层独立包） | R2、A5 | 最后 |

**为什么 R2 可以最先做**：它只改框架侧的表与声明解析，**不改任何插件业务逻辑**。被保护插件（`sandbox`/`guard`/`secrets`/`approval`/`storage-sql`/`storage-kv`）只需各加一个声明字段，改动是一行。与 W2–W5 的改动面（`execute/plan.ts` 的写计划构造）不重叠。R2 所需的小模块（`FRAMEWORK_COMMAND_NAMES`、目录名安全校验）由 R2 先落在 `packages/host/`，R1 再统一收编进 `common/`，故 R2 不依赖 R1。

**为什么 R9 要等 A5**：W2–W5 改过 `plugins/` 下的一大批身份（`approval`/`question`/`todo`/`memory-*`/`compress`/`mcp`/`config`/`skill`/`workspace`/`ui-*`/`plugin-admin`）。SDK 会重写每个插件的 `execute/main.ts` 与 `frames.ts`，与 W2–W5 完全重叠。先做 SDK 会让每批 W 都撞一次合并冲突；先做 W2–W5，SDK 一次替换到位。

**为什么 R1 要贴着 A6 做**：P4 的「口径核对 + 措辞清理」本身就是一次全仓梳理，抽 `common/` 与它同向。若 A6 已完成，R1 自行完成全仓 import 收敛即可；若仍在途，两者合并做省一次扫描。

**阶段口径**：每阶段独立可交付、可单独验收；每阶段单独提交。

---

## 三、R0 内核五个正确性缺陷

**与在进计划的关系**：该计划 §七 用「`packages/kernel` 测试全绿」证明内核未被牵动。R0 改内核，故**必须单独提交、单独验收**，不得与该计划的任何阶段同批提交，否则那条证明失效。

### R0-1 失败节点身份在 run 边界丢失

**根因**：`packages/kernel/machine.ts:55` 的 `EvalResult` 携带 `at`/`def`/`callAt`，但 `run.ts:120` 对 `!r.ok` 只做 `refuse(st, [r.error])`；`refuse`（`run.ts:75-85`）只收 `reasons`，`observationsOf` 的 eval 分支（`run.ts:146-157`）只写 `kind`/`entry`/`ok`/`value`/`error`。`KernelOutput`（`types.ts:136-144`）也无承载字段。

**这与既定约束直接冲突**：运行期错误定位要由机器报出失败节点，才能映射回源行。且 `toolchain/sourcemap.ts` 的 `explainError` 依赖 `at`/`def`/`callAt`（`toolchain/README.md:117`）——R6 接线后这条链才真正被用上，现在断在内核出口。

**改法**：

| 文件 | 改动 |
| --- | --- |
| `packages/kernel/types.ts` | 观测的 eval 分支增可选 `at` / `def` / `callAt`；`KernelOutput` 不变（信息走观测，不改四态形状） |
| `packages/kernel/run.ts` | `refuse` 增可选定位参数；`handleEval` 的 `!r.ok` 分支透传 `r.at` / `r.def` / `r.callAt`；`observationsOf` 的 eval 分支写出这三个键（`undefined` 由 `canonicalJson` 剔除，形状兼容） |

**测试**（`packages/kernel/test/run.test.ts`）：eval 失败的观测带 `at`；被调 term 内失败带 `def` + `callAt`；成功路径不带这三键（逐字节对比，确认老日志观测不变）。

**退出判据**：`toolchain` 的 `explainError` 能吃 run 出口的观测（而非只能吃 `evaluate` 的直接返回）并定位到糖化源指针。

### R0-2 非 `KernelError` 逃逸四态收口

**根因**：`machine.ts:165-171` 只捕 `Suspend` / `KernelError`，`run.ts:203-205`、`journal.ts:104-107` 同。而以下递归**无深度上限**：`substitute`（`journal.apply.ts:309`）、`literal`（`:334`）、`deepCopy`（`patch.ts:53`）、`collectMarkers`（`recycle.ts:52`）、`cmp`（`machine.ts:106`）、`deepEq`（`value.ts:84`）。唯一有护栏的是 `canonicalJson`（`value.ts:43`，depth > 64）。

**最锋利的一条**：`batchDigest`（`journal.apply.ts:203-220`）在任何规范化之前对插件提供的 `args` 调 `substitute`。深嵌套 → `RangeError` → 经 `applyBatch` → `applyOp` → `applyEntry` → `commit.ts:128`（无 try）→ `run.ts:204` 直接穿出。

**改法**：统一深度护栏。抽一个 `walkJson(value, visitor, depth)` 作为包内单一递归原语（同时解决 §五 的「七份递归 JSON 遍历」），depth 上限与 `canonicalJson` 同源（常量单点）；超限抛 `KernelError('depth')`。`deepEq`（`value.ts:79` 注释自称「任何输入都返回布尔，不抛错」）改为深度超限返回 `false` 而非抛，使注释成立。

**测试**（`packages/kernel/test/invariants.gates.test.ts` 或就近）：10^5 层嵌套 args 走 `put` / `batch` / `replay` / `verify` 四条路径，全部收成 `refused` 且 reason 为 `depth`，无异常穿出。

### R0-3 batch 非原子

**根因**：`journal.apply.ts:257-265` 的 catch 只对 `KernelError` 执行 `rollback`（`:260-262`），非 `KernelError` 走 `:264` 的裸 `throw err`——**不回滚**，已应用的子操作留在半改世界。`:270` 的两段式分歧护栏抛**裸 `Error`**，既不回滚也逃出四态。

**改法**：catch 改为捕获全部异常并一律 `rollback`，非 `KernelError` 包装成 `KernelError('internal')` 后再抛（保留原因链）；`:270` 的裸 `Error` 改 `KernelError`。

**测试**：注入一个在段 2 中途抛非 `KernelError` 的子操作，断言世界与调用前逐字节一致。另补一条：单 op 路径任意错误点前世界无变更（把现在靠书写顺序维持的隐式不变量钉死）。

### R0-4 `recycle` 可产生悬挂 base

**根因**：`recycle.ts:173` 的 `if (genWindow <= 0) return keep` 位于 `keepGens` 并入（`:172`）之后、pins/graft/base 定点回填（`:174-197`）之前。故 `genWindow<=0` + `keepGens` 指向补丁世代时，`base` 世代不被并入保留集，`rebuildIds` 裁掉它，留下悬挂 `base`。

**宿主能命中**：`compact.ts:87-88` 在 `genWindow<=0 && flattening` 时仍调 `recycleWorld` 并传 `keepGens`（`:94`）。

**改法**：定点回填对 `genWindow<=0` 同样执行——该分支只应跳过「窗口扫描」，不应跳过「引用闭包回填」。把提前 return 下移到定点循环之后，或把窗口与闭包拆成两个函数。

**排序要求**：**必须早于**在进计划 §六 B2。B2 要把 `keepGens` 收窄到定义数据世代并补回归断言；若此 bug 未修，B2 的断言会建在漏洞上。

**测试**（`packages/kernel/test/recycle.test.ts`）：`genWindow:0` + `keepGens` 指向补丁世代 → base 世代保留、组装不悬挂（现有用例只覆盖 `genWindow:1`）。

### R0-5 `commit` 已改世界后才可能抛

**根因**：`commit.ts:128` 就地改世界，`commit.ts:141` 的 `entryHash` 仍可能抛（`now` 为 `NaN` → `canonicalJson` 报 `nonfinite`）。调用方看到「异常 + 已改世界」。`hasForm`（`commit.form.ts:37-49`）不校验 `now`。

**改法**：`hasForm` 增 `now` 有限数校验（前置到改世界之前），使 `entryHash` 在该路径不再有抛出可能。

**测试**：`now: NaN` / `Infinity` → `refused`，且世界逐字节不变。

**R0 验收**：`packages/kernel` 下 `npm test`、`npm run typecheck` 全绿；既有链 `replay` 逐字节不变（老日志兼容）。`packages/host` 下 `npm test` 不退步。

---

## 四、R6 工具链接线

### 4.1 现状：建完了，没接线

工具链**不是待建**：

- 内核 14 原语**已全部就位**（`machine.ts:59-74`：`c`/`g`/`get`/`getOr`/`v`/`cmp`/`pred`/`if`/`fold`/`eff`/`call`/`arith`/`list`/`obj`）。`docs/term-toolchain.md` §五 的「甲/乙待裁决」已按**方案甲**落地（`pred` 产 `Bool`，`PRED_OPS` 见 `machine.ts:77`），`get`/`getOr` 值投影在位，`arith`/`list`/`obj` 也在位。
- `toolchain/` 六个实现文件齐备：`lower.ts` / `builder.ts` / `validate.ts` / `sourcemap.ts` / `testkit.ts` / `build.ts`，另有 `spec.md` + `README.md` + 17 个测试文件。
- 依赖边界正确：`rg toolchain packages/` 只命中 `packages/README.md` 的文档声明，**无任何 import**。

缺的只有三样：

1. **零插件有 `terms.src/`**（`rg --files -g "terms.src/**"` 为空）。
2. **零 `plugin.json.build` 引用 `toolchain/build.ts`**（`rg toolchain plugins/` 为空）。
3. **全部 term 文件都是纯效果转发**，零判定。样本：`plugins/chat/terms/chat.send.json` = `["eff","chat","send",["g",["ids"]]]`；`plugins/ui-sidebar/terms/session.new.json` = `["eff","ui-sidebar","newConversation",["g",["ids"]]]`。

即：工具链的**能力**在，**消费**不在。判定仍全部写在插件 `execute/` 服务代码里——这正是 `docs/term-toolchain.md` §一 列的问题，而它给的两个原因（表达力缺口、作者面缺口）**都已解决**。

### 4.2 文档已过期，接线时一并对账

| 文件 | 过期内容 | 应改为 |
| --- | --- | --- |
| `docs/term-toolchain.md:107-118` | `pred` 写成「两个方案待裁决」 | 方案甲已落地，改为既成事实描述 |
| `docs/term-toolchain.md:100` | 「暂不提供算术 / 数据构造语法」 | `arith`（add/sub/mul，无 div）/ `list` / `obj` / `getOr` 已提供；仍不提供 lambda / 递归 / while |
| `docs/term-toolchain.md:113` | 「原语数由 8 变 10」 | 14 原语 |
| `docs/term-toolchain.md:170`、`toolchain/README.md:30` | 「测试器尚未建」 | `testkit.ts` 已建 |
| `docs/plans/judgment-as-data-plan.md` | 步骤 0–4 全部已完成 | 标注完成，只剩步骤 5（接入）/ 6（实验）/ 7（迁移）/ 8（门禁） |

### 4.3 接线步骤

按 `docs/plans/judgment-as-data-plan.md` 的步骤 5–8 推进，本节只补该计划未写的接线细节。

**第一步：选一个 toy 包验通路**（对应该计划步骤 5）

用 `fixtures/plugins/` 下的 toy 包，不动生产插件：

1. 加 `terms.src/<name>.json`（糖化源）。
2. `plugin.json.build` 增一步 `{ "cmd": "node", "args": ["../../toolchain/build.ts", "."] }`。
3. `.worldignore` 排除 `terms.src/`。
4. 验：源 → 构建 → 入世 → `eval` 跑通；`validate_package` 行为不回归。

**关键核实点**：`toolchain/build.ts:47-53` 写产物到 `terms/*.json`，而 `terms/` 是入世内容。构建产物路径**必须**在插件自身 `.worldignore` 之外（产物要入世），但 `terms.src/` 必须在内。这与既有约束「构建产物路径必须加入 `.worldignore`」**方向相反**——因为 term 产物是**定义本体**，不是可重算副产物。

**但这个「相反」有个硬前提：编译必须确定性**（`toolchain/spec.md:85`：同源两次 `lower` / `lowerProgram` 逐字节一致）。若同源重编译字节漂移，即使产物是定义本体，也会每次构建触发无意义换代乃至换代死循环——正是那条既有约束要防的病。故「term 产物可入世」与「编译必须确定性」是绑定的，须一起写进 `docs/plugins.md`，否则作者会踩反。

**第二步：单判定实验（Go / No-Go 门）**（对应步骤 6）

`docs/plans/judgment-as-data-plan.md` §八 已写死 kill criterion，照做。候选判定按「纯度」排序：

| 候选 | 纯度 | 备注 |
| --- | --- | --- |
| `router.select` | 最纯 | 候选选择，`t.argmin` / `t.find` 直接可表达 |
| `guard.judge` 的档位比较部分 | 较纯 | `t.pred` + `t.in`；但它与 B-b 的门禁修复同处，**须等 B-b 收口** |

**推荐 `router.select`**：与在进计划的改动面零重叠，且 `toolchain/README.md:84-90` 的 `argmin` / `find` 配方正对它。

**第三步：前置依赖核实**

`docs/plans/judgment-as-data-plan.md` §一 写「存储有界化必须先落，步骤六之前必须已绿」，指向 `docs/plans/storage-dedup.md`。开工前须核实该计划状态；未绿则实验不得启动（理由：判定进 term 会引入更多 def 与世代，base 无界时会加速膨胀）。

**第四步：把 eff 声明校验补进宿主入世**

`toolchain/validate.ts:196-211` 校验 `eff.port ∈ implements|pins|methods` 且 `method ∈ methods[port]`，**宿主入世不校验**（`docs/host.md:223-226` 只校验 term 引用与 `argsSchema`）。故绕过工具链的手写 term 只在运行期得 `unresolved_cap`。

这是「工具链比宿主严格」的倒挂，**补进宿主入世**。

理由：这是纯机械校验——读 `plugin.json` 的 `implements` / `pins` / `methods` 三个字段，扫 term AST 的 `eff` 头取 `port` / `method` 两个位置，比对集合成员关系。**不需要理解糖化层，不需要求值**，故不违反 `docs/term-toolchain.md:175` 的「dry-run 只做机械校验，不解释糖化语义」边界。且它把运行期的 `unresolved_cap` 提前到入世期，与 `docs/host.md:597` 自认的「坏声明发现过晚」同向修正。

**落点**：`packages/host/assembly/` 的入世校验链（与既有 term 引用校验、`$ref` 环检测同处），覆盖 `seed` / `pack` / `validate_package` 三条路径（同一 `planPack`，改一处即三处生效）。

**新增拒绝码**：`undeclared_port` / `undeclared_method`（与工具链同名，便于对账）。

#### 校验口径：自调用与跨身份必须分开

对全部含 `terms/` 的插件逐条比对声明后，结论是**只有 1 个跨身份 term**：`plugins/ui-settings/terms/secrets.status.json`。它不是插件的错，暴露的是工具链口径缺陷。

该 term 是 `["eff","secrets","list",["c",null]]`。`ui-settings` 的 `pins` 含 `secrets -> secrets`，端口合法；`list` 也确实是 `secrets` 的声明方法（`plugins/secrets/plugin.json` 的 `methods.secrets = ["resolve","list"]`）。**运行期完全正确**。

但 `toolchain/validate.ts:196-211` 要求 `method ∈ methods[port]`，而 `Program.methods`（`toolchain/README.md:110`）指**调用方自己的** `methods` 映射。`ui-settings.methods` 只有 `ui-settings` 一个键——跨身份调用时，被调方法名住在**被调身份**的声明里，调用方的 `methods` 本就不该有那个键。

即：**工具链的方法校验只对自调用（`port ∈ implements`）成立，对经 `pins` 的跨身份调用是误判**。`toolchain/README.md:111` 的「只声明 `methods` 即可」只覆盖了自调用场景。

由此，两侧校验口径**刻意不同**：

- **`port ∈ implements`（自调用）**：`method ∈ methods[port]` 可在**入世期**机械校验（声明自洽，单包内可判）。
- **`port ∈ pins`（跨身份）**：方法名属被调身份的声明，入世期**能**校验（宿主此时看得到被调身份的世界声明），但须按**被调方**的 `methods` 判，不是调用方的。注意被调身份可能尚未入世（同批入世的闭包内），故校验须在整批闭包解析后做，且被调身份缺失时按现有 `pins` 解析失败路径处理，不新增拒绝语义。
- **同时须修 `toolchain/validate.ts`**：跨身份分支改为「不校验方法名」（工具链只有单包源，看不到被调声明）。宿主版按被调方声明判、工具链版放弃跨身份方法校验，两侧口径因可见信息不同而刻意不同，须在 `docs/term-toolchain.md` 写明。

**R6 验收**：toy 包通路跑通；`router.select` 三条端到端验收（表达得出 / 热改不换进程验 pid 不变 / 重放决策一致）；`toolchain` 下 `npm test`、`npm run typecheck`；文档对账完成。

---

## 五、R1 抽 `common/`

### 5.1 问题

共享原语没有家，于是寄生在最近的包里：`ledger/atomic.ts` 的 `writeFileAtomic` 被 `audit-store.ts:24`、`audit-backfill.ts:15`、`blobs.ts:11`、`assets.ts:12`、`secrets.ts:6` 五个非 ledger 模块 import。同一判定被抄 N 份：

| 重复项 | 份数 | 代表位置 |
| --- | --- | --- |
| `isRecord` / `asRecord` | 21（`packages/` 内 `function` 定义处，不含测试） | `host.ts:116`、`audit.ts:127`、`ledger/base.ts:92`、`assembly/decl.ts:81`… |
| 64-hex 判定 | 5（host）+ 3（kernel） | `assets.ts:40`、`blobs.ts:17`、`projection/index.ts:13`；`machine.ts:86`、`commit.form.ts:12`、`recycle.ts:40` |
| 路径安全校验 | 5 | `assembly/ingest.ts:174`、`assets-manifest.ts:27`、`validate-package.ts:38`、`assembly/source.ts:49`、`term-refs.ts:7` |
| GC 循环（readdir → 过滤 → rm → failed） | 5 | `materialize.ts:228`、`blobs.ts:147`、`assets.ts:137`、`plugin-state.ts:14`、`plugin-data.ts:44` |
| JSON 读文件 | 7 | `ingest.ts:147`、`base.ts:105`、`journal.ts:77`、`secrets.ts:53`、`audit-backfill.ts:54`、`deps.ts:90`、`lock.ts:50` |
| 容错 JSONL 读 | 2 | `ledger/journal.ts:91`、`audit-store.ts:75` |
| 撕裂尾守卫 | 2 | `ledger/journal.ts:151`、`audit-store.ts:106` |
| 递归 JSON 遍历（kernel） | 7 | `canon`、`deepEq`、`cmp`、`substitute`、`literal`、`deepCopy`、`collectMarkers` |
| 原型键集 | 6 | `host.ts:168`、`method-timeouts.ts:24`、`periodic.ts:40`、`rounds.ts:474`、`secrets.ts:19`、`identity-name.ts:8` |
| `bodyBytes` | 3 | `audit.ts:119`、`audit-backfill.ts:42`、`def-store.ts:44` |

### 5.2 落点

`packages/host/common/`（宿主内共享，不跨包）：

| 新模块 | 收纳 |
| --- | --- |
| `common/json.ts` | `isRecord` / `asRecord` / `isStringArray` / `isStringMap` / 原型键集 |
| `common/cas.ts` | 64-hex 判定 / CAS 文件路径 / base64 往返校验 |
| `common/paths-safe.ts` | `isSafeRelativePath` / `isSafeIdentityName` / `pathSegments` / `normalizeRefPath` / Windows 保留名（`isSafeIdentityName` 现住 `assembly/identity-name.ts`，R2 先用，R1 归位） |
| `common/fs-atomic.ts` | `writeFileAtomic` / `writeFileStaged` / `fsyncDir`（从 `ledger/atomic.ts` 迁出） |
| `common/jsonl.ts` | 容错逐行读 + 撕裂尾守卫（`journal.ts` 与 `audit-store.ts` 共用） |
| `common/gc-dirs.ts` | `readdir → 过滤 → rm → failed` 骨架，**策略参数化** |
| `common/op-names.ts` | `OP_NAMES`，消除 `host.ts:129` 与 `rounds.ts:44` 双份 |
| `common/framework-commands.ts` | `FRAMEWORK_COMMAND_NAMES`（见 §6.4），入世与 CLI 共用（R2 先建，R1 归位） |

`packages/kernel/` 内（不新建目录，内核只 14 文件）：

- `walkJson` 作为单一递归原语（R0-2 已引入），`substitute` / `literal` / `deepCopy` / `collectMarkers` 改为它的 visitor。
- `isHash` 单点（合并 `machine.ts:86` / `commit.form.ts:12` / `recycle.ts:40`）。
- `isRecord` 单点（合并 `machine.ts:82` / `patch.ts:25` 与多处内联）。

### 5.3 必须保留的差异（继承 §0.2）

`common/gc-dirs.ts` **不得**把 `plugin-state.ts` 与 `plugin-data.ts` 统一成同一行为：在进计划 §2.3 明确要求两者分开——`state/data/` 不参与「active + 前 N 代」窗口回收，且删除失败只记运维日志、不阻锁释放。骨架共用，策略作参数。

### 5.4 与 P4 合并做

在进计划 §六 的清场包含「全仓搜 `state: "recomputable"` 的注释与 README」「全仓搜『唯一写口 / 唯一写者 / 真源』」两项全仓梳理。R1 也要全仓改 import。**能合并则同批做**，省一次扫描。

**R1 验收**：`packages/host`、`packages/kernel` 下 `npm test`、`npm run typecheck`、`npm run format:check` 全绿；`rg "^(export )?(const|function) (isRecord|asRecord)" packages/` 收敛到 2 处（host 的 `common/json.ts` 与 kernel 各一）。

**注意**：现有定义全部是 `function isRecord` 形式（`packages/` 内 21 处，无 `const` 形式），故断言不能写成 `rg "const isRecord"`——那会恒为 0，断言看似通过实则失效。

---

## 六、R2 框架通用化：声明面补全

### 6.1 盘查结论

判据：加一个插件是否只需读它自己的声明。全量盘查 `packages/`（排除 `**/test/**`）的结果：

**内核零插件知识**——身份名 / 能力类名 / `'host'` / `plugin` 全部零命中。装配、路由、投影、换代、GC 也已是机械读 `plugin.json` + `pins`。**框架的绝大部分已经通用**。

真正会逼「加插件改框架」的只有 7 处，全在宿主侧：

| # | 位置 | 新插件今天必须做什么 |
| --- | --- | --- |
| 1 | `assembly/ingest.ts:81-88` `PROTECTED_PIN_IDENTITIES` | 想要「新世代不得删我的 pin」这个保护，只能改框架源码把身份名加进集合。**改为运营配置**（§6.2 第 1 项）：加受保护插件 = 改 `chrono.config.json`，不改源码 |
| 2 | `audit.ts:83-109` `AUDIT_TIERS` | 想要独立审计保留预算，改框架表；或把能力类名起成 `tool*` / `model*` / `storage*` 前缀去**蹭**既有档 |
| 3 | `effect/execute.ts:60-67` `redactAuditResult` | 有敏感方法要审计脱敏，无法声明，只能改框架加特判 |
| 4 | `assembly/decl.ts:182` `EXCLUSIVE_RESOURCE_KINDS` | 新资源类（`gpu` / `lock` / `singleton`…）无法声明，入世直接拒 |
| 5 | `endpoint-table.ts:31-32` + `runtime.ts:740` `transport:'stdio'` | 同进程形态无声明入口（R5 覆盖） |
| 6 | `assembly/decl.ts:134` `MEMBER_KINDS` / `:216` `state` 两档 | 新成员种类 / 新状态档无法声明（**保持封闭**，见 §6.2 第 6 项） |
| 7 | `state/plugins.json` | 手工在清单里追加一项；`packages/` 内**零写入代码**，纯人工维护 |

**第 7 项是活的负担，不是假设**：清单是纯人工维护，漏登记即静默不被发现——例如 `plugins/example`（模板包）至今未登记，只能靠 `boot pack <目录>` 显式给路径入世；`boot seed`（无参）与源码 watcher 都看不到它。清单条数随插件增减，人工同步。

### 6.2 逐项改法

**1. `PROTECTED_PIN_IDENTITIES` → 运营配置**

现状：`ingest.ts:78` 注释自称「纯机械的比对，宿主不认识业务」——比对确实机械，**名单不机械**。

语义：其它身份的新世代不得删除对本身份的 `pins` 引用。**这条比对逻辑原样保留**（`removedProtectedPin`，`ingest.ts:93-116`），只换「名单从哪来」。

**为什么不交给插件自报**：这是**安全策略**，不该由被约束者自报。若让被保护方声明 `protected: true`，任何插件——含 agent 写入的——都能自我保护、不被解除 pin，且「哪些是强制插件」这一策略散进各插件；若让加 pin 方声明 `pins_required`，则把强语义「任何身份都不得删」弱化为「声明者不得删」。运营配置完整保留现状强语义，且「改配置」比「改源码」低一档。

**落点**：仓库根新增**提交入库**的配置文件 `chrono.config.json`：

```json
{ "protected_pins": ["sandbox", "guard", "secrets", "approval", "storage-sql", "storage-kv"] }
```

- 该文件**随仓库提交**，不是 `state/` 下的运行态（`state/` 是 gitignore 的，`packages/README.md:62`），故保护默认恒开。
- 环境变量 `CHRONO_PROTECTED_PINS`（逗号分隔）可覆盖，沿用既有优先级「显式 > 环境 > 文件」（`options.ts:2`）。
- 读取方：`packages/host/` 的 options 解析，与既有 `CHRONO_*` 同处。host 与离线（`seed` / `pack` / `validate_package`）共用同一读取——`removedProtectedPin` 在入世期跑，三条路径都经过。
- **这是框架侧第一个通用运营配置文件**（根下另有 `package.json` 与 Kilo 工具自身的 `kilo.json`，都不是框架运营配置），故不叫 `protected-pins.json`：后续运营项继续放这里。
- `.gitignore` 不忽略该文件名，可正常入库。

**缺失与非法分档**（沿用本仓既有口径，`options.ts:58`/`:94`/`:109`）：

| 情形 | 处置 |
| --- | --- |
| 文件缺失 / 键缺失 | 空集 + 写运维日志（沿用「空串视为未设置」） |
| 键存在但形态非法（非字符串数组 / 含原型键 / 空串项） | **fail-closed 拒启**，码 `bad_protected_pins`（沿用 `bad_watch` / `bad_compact_strict` 的 fail-closed 口径） |
| 环境变量覆盖为非法值 | 同上，fail-closed |

**「缺失 → 空集」是 fail-open，故必须配兜底断言**：新增测试断言**仓库随带的 `chrono.config.json` 恰含这六个身份**，删了即测试红。没有这条，删一个文件就静默关掉保护。

六个现有被保护插件**不动**（名单不在它们身上）。取值口径仍须与现状一致——读**最近代码世代**的声明（`ingest.ts:101-108`），否则「退役→重入世」可绕过。

**源码不再出现这六个身份名。**

**2. `AUDIT_TIERS` → 声明式预算**

现状 `AUDIT_TIERS`（`audit.ts:83-109`）是 `{ name, matches: (port) => isPortFamily(port, base), maxRecords, maxBytes }` 的框架表，靠 `isPortFamily`（`:72-77`）匹配端口名前缀（`port === base` / `base.` / `base-`）。这让「审计策略」隐式挂在命名约定上：新插件想归 tool 档必须把能力类起名 `tool*`。

改为能力类级声明 `schema.audit_tier: { "<cap>": { max_records, max_bytes } }`。无声明走 default 档。淘汰逻辑（档内最旧先走）不变。

**三处必须写进实现**：

1. **档表随世界变**。现状档表在 `AuditStore.open` 时一次性构造（`audit.ts:188-192`），而声明住在世界里、随世代变——二者阻抗不匹配。`tierOf` 改为每次插入时查当前声明（无需重建档表），实现更简单。
2. **声明值须有框架侧上限**。否则插件自报 `max_records: 10^9` 即绕过审计保留纪律——自报预算的通病。加框架侧上限即可约束（自报超上限截到上限），上限住宿主常量。
3. **档名不必入记录**。`AuditRecord` 不携带档名——`tierOf` 在插入时按 body 的 port 现算，档表纯内存态（`audit.ts:204-206`、`:264-270`）。故声明式档位不需要给记录加字段，也不影响落盘格式。

**冲突面**：`audit-store.ts` 刚按在进计划 P1 改过分档结构（§0.1 的 A7）。动前先核该文件近期提交，且本项**只改档位来源**（框架表 → 声明），不改分档机制本身。

**3. `secrets.resolve` 脱敏 → 声明式脱敏（`audit_redact` 白名单键）**

语义：审计 `result` 只落白名单键，外加派生 `has`（由 outcome 推导）。**不取** `sensitive: true` 布尔档——那会丢掉 `name` / `kind` 这两个取证用的非敏感字段，属行为变更；白名单键与现有 `redactAuditResult`（`effect/execute.ts:60-67`）逐字段等价，迁移零行为变化。

**落点不能在 `methods` 上**：`plugin.json.methods` 的形状是 `Record<能力类, string[]>`（如 `{"secrets": ["resolve","list"]}`），**没有可挂载每方法元数据的对象位**。故声明放 `schema`，键格式照既有 `method_timeouts` 的先例（`method-timeouts.ts:109-127`）：`<port>.<method>` 精确匹配优先，其次裸 `<method>`。

```
schema.audit_redact = { "secrets.resolve": ["name", "kind"] }
```

宿主按声明脱敏，`effect/execute.ts:61` 的 `eff.port === 'secrets'` 特判**删除**。

**不变式仍成立**：`effect/execute.ts:57-58` 的注释解释了为何判据用 port 名而非解析后身份（「同一能力类不可被两个身份声明，故 port 名等价于目标声明的类，别名绕过不成立」）。声明化后该不变式**更强**——声明住在被调身份自己的 `plugin.json` 里，调用方无从伪造。

**回归要求**：删特判后 `secrets.resolve` 的审计正文必须与改前逐字节相同。

**4. `EXCLUSIVE_RESOURCE_KINDS` → 开放资源类名**

宿主对 `exclusive` 做的事只有一件：`swap.ts:59-63` 判 `newDecl.exclusive.length > 0` 即走独占换人序。**它不需要理解资源类的语义**——`port` 和 `data` 在换人序上行为相同。白名单纯属多余约束。

改为开放任意资源类名（仍校验形态：非空字符串、无原型键、长度上限）。保留唯一的交叉校验：`data` 类要求 `state === 'durable'`（`decl.ts:237-239`，这条有实际语义）。

**5. `transport` → R5 覆盖**，见 §九。

**6. `MEMBER_KINDS` / `state` 两档 → 保持封闭**

这两个**不改**。理由：它们是框架内部语义而非插件可扩展点——`members[].kind` 的 `execute` vs `term`/`schema` 决定代码世代 / 数据世代二分（`generation.ts:51-75`、`runtime.ts:525-534`），`state` 两档决定回收策略。插件任意扩展会破坏换代判据与 GC 口径。

（保持封闭，非遗漏。）

**7. `state/plugins.json` → 目录发现 + 清单降为可选覆盖**

宿主扫 `plugins/*/plugin.json` 自动发现；清单**保留但降级为可选覆盖**，用于三件目录发现做不到的事：

1. **非标准路径**（插件不在 `plugins/` 下）。
2. **`node_modules` 内插件**：`ingest.ts:119-135` 支持无 `path` 的项走 Node 解析（`require.resolve`）——这是「插件可作为 npm 包分发」的唯一入口，**不能丢**。
3. **显式排除**：把某个 `plugins/` 下的目录标记为不加载。

模板包 `plugins/example` 是目录发现的唯一现实障碍（它有完整 `plugin.json`，会被当插件加载）。**把模板移出 `plugins/`，落 `templates/plugin/`**——作者从该目录拷贝起手，`plugins/` 下的目录都能被目录发现直接加载，且不依赖清单存在。排除项能力仍保留，供其它场景使用。

清单不存在或为空 → 纯目录发现。清单存在 → 清单项与发现项**并集**，同名以清单项优先（清单可覆盖路径），排除项从并集中移除。

真实身份仍取包内 `plugin.json.identity`（`ingest.ts:297-315`），不一致仍拒 `identity_mismatch`；清单的 `name` 仍只是解析回退标签。

**须新增的形态校验**：目录发现会把「目录名」变成加载依据，故须校验目录名安全（复用现有 `assembly/identity-name.ts:14` 的 `isSafeIdentityName`），且 `plugin.json` 读取失败的目录**跳过并记运维日志**，不 fail-stop（否则一个坏目录挡住整个启动）。

### 6.3 不改的部分

**`host` 保留能力类的 10 个方法**（`host-methods.ts:12-23`）全部访问世界、宿主侧 ④ 真源或 run 注册表：`audit` / `asset.put` / `asset.get` / `blob.put` / `def.read` / `identities` / `source.read` / `thread.resume` / `thread.terminate` / `validate_package`。插件按红线不得直接读世界、不得写链、不得调度 run，故**没有一个能由插件等价提供**。这是不可让渡的最小特权面，体积固定为 10，保持封闭正确。

**协议封闭集**同样不由插件扩展——入站 12 种 kind（`wire.ts:30-73`）、出站 10 种（`:76-87`）、服务协议 14 种帧、10 个结构 op 名、4 个审计 outcome。它们是框架与所有插件的共同契约；加插件本来就不需要动它们（插件经 `call` / `command` / `submit` / `forward` 走既有 kind）。

**已经是声明式的**（确认无缺口）：周期 tick（`schema.periodic`）、方法超时（`schema.method_timeouts`）、持久存储（`state: durable`）、构建步骤（`plugin.json.build`）、命令只读（`commands[].readonly`）、命令参数 schema（`commands[].argsSchema`）、重启与健康（`restart` / `health`）、大资产直拷（`schema.assets_manifest`）。

### 6.4 顺带修：保留命令名四处清单不一致（潜伏 bug）

**事实**：

| 清单 | 位置 | 数量 |
| --- | --- | --- |
| 入世保留集 | `assembly/decl.ts:98-112` `RESERVED_COMMAND_NAMES` | 13 |
| CLI 保留集 | `boot/main.ts:33-50` `RESERVED` | 16 |
| CLI 实际派发 | `boot/main.ts:229-306` 的 switch + `:223` 的 `help` | 15 + 1 = 16 |
| CLI 帮助文本 | `boot/main.ts:66-99` `helpText()` | 16（纯文本） |

CLI 的 `RESERVED`（16）与实际派发（16）**完全吻合**，故过期的是入世那份：缺 `unseeded` / `commands` / `help`。`decl.ts:96` 的注释称与 `boot/main.ts` 的 `RESERVED` 同口径，与实际不符。

**后果不是「不可达」，而是同一命令名在不同入口行为不同**：

- `decl.ts:121` 用 13 项集判，故插件声明名为 `commands` 的命令**通过入世**。
- 经 CLI：`main.ts:246` 的 `case 'commands'` 拦截 → 走框架命令，插件命令调不到。
- 经客户端 API：**host 运行期不查保留名**（`RESERVED_COMMAND_NAMES` 只在 `assembly/decl.ts` 入世期使用），`host.ts:1009` 的 `resolveCommand` 按插件命令解析 → **能**调到插件的命令。

即 CLI 与客户端两个入口行为分叉。且 CLI 自己的 `commands` 列表会**列出**插件的 `commands` 命令——用户看到它被列出，用 CLI 调却是另一回事。

**这是潜伏 bug**：45 个插件命令（12 个插件）零冲突，尚未被触发。

**改法**：

1. **单点定义，且由宿主拥有**。依赖方向是 `boot ──→ host` 单向（`packages/README.md:22-24`），host 不能 import boot，而入世是 host 的职责。故规范清单放 `packages/host/common/framework-commands.ts`（R2 建，R1 归位），名 `FRAMEWORK_COMMAND_NAMES`——不叫 `CLI_COMMAND_NAMES`，它是「框架保留的命令名」，CLI 与入世都是消费者。
2. **CLI 派生而非并列**：`boot/main.ts` 的派发表改为 `Record<name, handler>`，`RESERVED = new Set(Object.keys(handlers))`。这样 `RESERVED` 与 switch **由构造保证**不可能漂移，只剩 `helpText` 需单独对齐。
3. **测试锁死**：断言 CLI 派发表键 == `FRAMEWORK_COMMAND_NAMES`；断言 `helpText()` 覆盖全部。新增 CLI 命令忘了加进规范清单 → 测试红。
4. **诊断改进**：入世命中保留名时给专用码 `reserved_command_name`，不再混进 `bad_plugin_decl`——现在作者只看到「声明非法」，不知道是撞了保留字。

**不改**：不引入命令名命名空间（如强制 `chat.send`）。那能结构性消除冲突，但会改动插件命令面与既有 45 个命令，超出本次范围；单点清单已足够。

**验收**：四处清单同源；故意新增一个 CLI 命令而漏加规范清单时测试红；命中保留名的入世拒绝码为 `reserved_command_name`。

### 6.5 测试

- `packages/host/assembly/test/decl.test.ts`：`audit_tier` 声明通过；任意资源类名通过；`data` 类 + 非 `durable` 仍拒。
- `packages/host/test/protected-pins.test.ts`：**仓库随带的 `chrono.config.json` 恰含六个受保护身份**（删了即红，兜住「缺失→空集」的 fail-open）；`CHRONO_PROTECTED_PINS` 覆盖生效；非法值 fail-closed 拒 `bad_protected_pins`；文件缺失 → 空集 + 记运维日志。
- `packages/host/assembly/test/ingest.test.ts`：受保护身份被删 pin → 拒 `protected_pin_removed`；未受保护身份被删 pin → 放行；取值取**最近代码世代**（换代改不掉）。
- `packages/host/test/audit.test.ts`：声明 `audit_tier` 的端口走自己的预算；无声明走 default；单端口刷满不挤掉其他档；**自报超上限预算被截到上限**（防绕过）。
- `packages/host/test/host-audit.test.ts`：声明 `audit_redact` 的方法审计只落白名单键；未声明的方法审计落完整结果；删除 `secrets` 特判后行为不变（回归）。
- `packages/host/test/host-discovery.test.ts`（新建）：无 `plugins.json` 时目录发现可入世；清单项覆盖同名目录；`identity_mismatch` 仍拒；模板包已移至 `templates/plugin/`，`plugins/` 目录发现不加载模板。
- 保留命令名单点化（§6.4）：断言 `boot/main.ts` 的派发表键 == `FRAMEWORK_COMMAND_NAMES`；断言 `helpText()` 覆盖全部；声明名为 `commands` / `unseeded` / `help` 的命令入世拒 `reserved_command_name`。

**R2 验收**：`packages/host` 下 `npm test`、`npm run typecheck`；`rg "'sandbox'|'guard'|'secrets'|'approval'|'storage-sql'|'storage-kv'" packages/ --glob '!**/test/**'` 收敛到 0（框架源码不再出现这六个身份名）；受保护 pin 行为与现状等价；四处保留命令名清单同源。

---

## 七、R3 世界落点写入原语

### 7.1 问题

「clone → commit → appendJournal → 推进 head」在宿主侧被抄 4 份：

| 位置 | 备注 |
| --- | --- |
| `watch/reload.ts:84-102` | 手工 `cloneWorld`，`:82-83` 注释自承绕过装配比对 |
| `offline.ts:100-121` | seed |
| `offline.ts:176-202` | pack |
| `compact.ts:156-167` | 压缩（变体） |

`effect/run-loop.ts` 的落点写入走内核 `run` + `WorldWriter`，不在重复之列。

**单写者不是结构强制**：`run-loop.ts:108-111` 的 `resolveWriter` 在只给 `world + head` 时**新建一个 `WorldWriter`**；走这条 fallback 就有两个互不串行的写者，`expect_pos` 单链头 CAS 不再成立。

### 7.2 改法

抽 `commitToWorld(writer | lock, request, now)` 作为**世界落点**的唯一写入原语，reload / seed / pack / compact 四处共用，统一 fatal 处理与 `expect_pos` 锚定。`run-loop` 继续走 `WorldWriter` + 内核 `run`，只删 `resolveWriter` 的 `world+head` fallback 分支（生产总传 `writer`，该分支只服务测试；测试改为显式构造 writer），使 run 路径同样只有一个写者。

**命名与措辞**（继承 §0.2）：该原语是「世界这一处落点的写者」，**不叫**「唯一写口」。文档描述须限定到落点。

### 7.3 顺带修

- `ledger/atomic.ts:43-44` 的 if/else 两分支完全相同，删一支。
- `journal.ts:141-147` 的 `appendJournal` 只 fsync 文件不 fsync 父目录；首次创建 journal 时目录项未持久化，掉电可丢整个文件。补 `fsyncDir`（复用 R1 的 `common/fs-atomic.ts`）。
- 所有 `writeSync` 不检查返回值（`journal.ts:143`、`atomic.ts:43`、`audit-store.ts:201`、`lifecycle.ts:90`）。补短写检测。

**R3 验收**：`packages/host` 下 `npm test`、`npm run typecheck`；新增用例：两个 writer 并发提交同链头，第二个必须得 `stale`（证明 CAS 生效）。

---

## 八、R4 拆 `host.ts`

### 8.1 问题

`host.ts` **1760 行**不是「巨石」，是**闭包式 god object**：`startHost` 一个函数作用域持有 20+ 可变状态，全部 handler 都是对它的闭包。数得出 22 项独立职责。

**三段近乎逐行复制**：`handleSubmit`（`:904-968`）/ `handleCommand`（`:992-1087`）/ `handleForward`（`:1093-1190`），连 `catch` 与 `finally` 都一样。

**两个真缺陷**（拆分顺带修）：

- **启动失败泄漏锁**：`:259` 抢锁，直到 `:1630` 才进 `try`。中间任何抛出（`loadAnchor` 的 `bad_base`、`AuditStore.open`、`compactWorld`、三处 GC）都不释放锁，留下 stale 锁文件。
- **启动失败泄漏子进程**：`assembly/runtime.ts:939-943` 的 `startAssembly` 若在 `runtime.start()` 抛出，`host.ts:1646` 的 `runtime` 尚未赋值，catch 里 `runtime === undefined` 故不 stop，已 spawn 的服务成孤儿。

### 8.2 拆法

| 新模块 | 一行边界 |
| --- | --- |
| `inbound/validate.ts` | 入站消息与 directive 草稿的形状校验（`readMessage` / `asDirectives` / `OP_NAMES`），与 effect 共用一份 |
| `inbound/server.ts` | socket 监听、`clients`、`send` / `broadcast`、帧解码接入 |
| `inbound/dispatch.ts` | 入站 kind → handler 的薄路由（含协议校验与未知 kind fail-closed） |
| `inbound/handlers.ts` | submit / command / forward 三路统一为 `runDirectiveSet`：解析命令 → 校验 args → 跑 run → 回 result |
| `run-registry.ts` | `inflight` / `runs` / `detachedRuns` / `nextNow`，`run.started` / `run.finished` 严格成对收口 |
| `follow.ts` | `appliedSeq` / `appliedWorld` / `broadcastIdentityChanges` / `applyWorldSerial` |
| `bootstrap.ts` | 锁 → 锚 → 撕裂修复 → 启动压缩 → 审计回填 → GC → `startAssembly` → 停机逆序收口，**全程 try/finally** |
| `capability-wiring.ts` | `createHostCapability` 依赖组装 + `handlePortCall` 反向转发 |
| `periodic-runner.ts` | 周期条目的 run 构造（`firePeriodic` / `runPeriodicEntry` / `buildPeriodicBag` / `capOfMethod`） |

`host.ts` 余下为真正的组合根：读 options → 调 bootstrap → 组装 router / capability / periodic → 暴露 `HostHandle`。目标 ≤ 250 行。

### 8.3 顺带修分层违规

| 违规 | 改法 |
| --- | --- |
| `effect/route.ts:5` 绕过 `assembly/index.ts` 直取 `decl.ts` | 经 public face |
| `effect/route.ts:86-105` 自造 `ownerIndexOf`，与 `assembly/closure.ts:51-67` 同构 | 复用 `buildOwnerIndex` |
| `projection/index.ts:9` 同样绕过 assembly index | 经 public face |
| `audit.ts:7`、`compact.ts:16`、`audit-backfill.ts:14` 从 `effect/execute.ts` 取 `EFFECT_AUDIT_KIND` / `AUDIT_OUTCOMES` | 迁到 `audit.ts`（审计词表属审计域） |
| `host.ts:175-189` 与 `rounds.ts:477-491` 双份投影取值 | 迁入 `projection/` |
| `host.ts:701`、`:865` 用 `writer.snapshot().world` 解析超时，而路由用 `appliedWorld` | 统一为 `liveWorld` |

**R4 验收**：`packages/host` 下 `npm test`、`npm run typecheck`；新增用例：启动中途抛出后锁已释放、无孤儿子进程（用 fixture 注入失败点）。

---

## 九、R5 通道抽象（同进程插件形态）

### 9.1 目标口径

继承既定约束：**插件不应被强制以独立服务进程开端口形式运行；宿主应能支持同语言插件依赖（同语言 / 同进程加载插件形态）**。

### 9.2 现状：写死子进程五处

| 位置 | 写死内容 |
| --- | --- |
| `service-link.ts:104-141` | 构造函数签名吃 `ChildProcess`；绑定 `child.stdout` / `stdin`；`close()` 执行 `child.stdin.end()` |
| `supervision.ts:33-54` | `ServiceRuntime.proc: ChildProcess` 为**必需**字段 |
| `supervision.ts:163-211` | `terminateChild` 用 `child.pid` + Windows `taskkill /T /F`；`waitForExit` 依赖 `child.exitCode` 与 `'exit'` 事件 |
| `service-launcher.ts:137-166` | `spawn(..., {shell:true, stdio:['pipe','pipe','pipe'], detached})` + stderr 转发；`:150-152` 经 spawn env 注入 `CHRONO_PLUGIN_STATE` / `CHRONO_PLUGIN_DATA` |
| `endpoint-table.ts:26-35` + `runtime.ts:732-746` | `EndpointRow.pid` 必需；硬编码 `transport:'stdio'` |

### 9.3 已有的半个抽象

**调用层已经进程无关**：`endpoint-table.ts:11-24` 的 `EndpointLink` 是接口；宿主保留能力类 `host` 就是现成的同进程端点——`route.ts:60-74` 造 `EndpointRow{transport:'host', pid:0, link:{call}}`，`host-capability.ts:283-310` 是纯函数派发器，零进程零 stdio。

缺口在**通道层 + 监督层 + 启动层**，不在调用层。

### 9.4 改法

1. **`ServiceChannel` 接口**（新）：`write(frame)` / `onMessage(cb)` / `onClose(cb)` / `close()` / 可选 `pid`。`ServiceLink` 改吃 `ServiceChannel`。
2. **`ServiceHost` 进程模型**（新）：`start(decl, prepared) -> { channel, lifecycle }`。三个实现：
   - `stdioHost`：现逻辑原样搬。
   - `inprocHost`：宿主以动态 `import()` 把同语言入口载入**宿主进程同一线程**，直接调用；不开端口、不走 stdio。
   - `workerHost`：宿主以 `worker_threads` 载入同语言入口，独立堆、结构化克隆通信；仍不开端口、不走 stdio。
3. **形态由声明选择，框架不替选**：`plugin.json` 增可选 `transport`（`stdio` | `inproc` | `worker`）。未声明 = `stdio`（存量行为不变）；`inproc` 与 `worker` 之间**无缺省**，插件须显式声明其一。`inproc` / `worker` 仅对同语言（TS/JS）入口可用；非 JS 入口声明即入世拒 `bad_plugin_decl`。
   - **不引入「依附于某个主插件」这一层**：同进程插件的代码由宿主载入**宿主进程**（或其起的 worker），不载入另一个插件。让插件宿主子插件会要求父插件 import 子插件代码，直接违反「插件间禁止互相 import」的红线；将来若要做，须由宿主中介并另行设计声明面。
4. **`ServiceRuntime.proc` 改可选**；`supervision` 按 `transport` 分派 terminate / waitForExit / stopChild（in-proc / worker 走模型自身 teardown）。
5. **`EndpointRow.pid` 改可选**、`transport` 增 `'inproc'` / `'worker'`；`registerEndpoints` 从模型取 transport。
6. **env 注入改上下文传递**：`CHRONO_PLUGIN_STATE` / `CHRONO_PLUGIN_DATA` 对 in-proc / worker 是 loader 参数，不是环境变量（worker 经 `workerData` 传）。
7. **进程语义改写**：in-proc / worker 下 `reload` / `drain` / `health` 是直接调用（无进程超时竞态）；`restart` 是重新载入；`docs/protocol.md:109` 的「stdin EOF 自退出」义务是进程专属，不适用。
8. `startWrapper` / shell 白名单 / `composeStartCommand` 仅属 stdio 模型。

### 9.5 与 R9 的接口

SDK（R9）产出的服务应能**同时**跑三种形态：stdio 下由 SDK 起帧循环；in-proc / worker 下由 SDK 暴露同一派发器供宿主直调。这是 SDK 设计时就要留的口，不是后补。R5 先落地时 `inprocHost` / `workerHost` 可只支持 fixture 插件；R9 再把该口铺到全部插件。

**R5 验收**：`packages/host` 下 `npm test`、`npm run typecheck`；新增 fixture：同一 toy 插件在 stdio / inproc / worker 三种形态下行为一致（同一组调用产出逐字节相同的结果与审计）。失败面分别验：inproc 崩溃带走宿主（记为已知代价，文档写明）；worker 崩溃只收该分支。

---

## 十、R7 算法热点

按收益排序，各条就近在对应阶段做。

| # | 热点 | 位置 | 改法 | 阶段 |
| --- | --- | --- | --- | --- |
| 1 | 空 directives 仍全量 `cloneWorld` | `run.ts:176` 在 `:183` 的 idle 判断之前 clone，idle 路径立刻丢弃 | clone 下移到 idle 判断之后 | R0 |
| 2 | 每个效果一次 `cloneWorld` | `run-loop.ts:256-302` 对每个挂起效果调一次内核 `run`，每次 `run.ts:176` clone（普通表 O(#defs)） | 续跑路径复用同一克隆世界；或让 `cloneWorld` 对未改动的 defs 表走廉价覆盖层（惰性表已有此形态，`defs.ts:30-33`） | R0 / R3 |
| 3 | 每次 submit 重建命令索引 | `host.ts:917-920` 每次提交 `listCommands`；`decl.ts:456-481` 对每身份 `readPluginDecl` + 每命令 `resolveTermHash`（`:429-453` 递归且每次新建 memo） | 按链头缓存（与 `cachedProjection` 同机制） | R4 |
| 4 | `resolveCommand` 每次线性全扫 | `decl.ts:484-488`，被 `host.ts:1009` / `:1115` / `:848` / `:719` 反复调用 | 同 3，建 `name → command` 映射 | R4 |
| 5 | 每次读 def 都序列化 body | `def-store.ts:98-100` 的 `touch` → `defBytes` → `JSON.stringify(def.body)`，**每次访问**成本 | 字节数随 def 缓存，不每次重算 | R1 |
| 6 | 每个效果一次 fsync | `audit-store.ts:195-205` 每条审计 `canonicalJson` + `writeSync` + `fsyncSync`，另加 `ensureTrailingNewline` 的 `statSync`+`openSync`+`readSync` | 审计是旁路：批量 fsync 或降为 `fdatasync`；**注意 A7**，该文件刚按 P1 改过，动前先核 | R8 |
| 7 | `termTopoOrder` O(term²) | `term-refs.ts:88-99` 用 `ready.shift()` + `findIndex` / `splice` | 换队列指针 + 入度表 | R4 |
| 8 | `orderEntriesForSeed` O(条目²) | `ingest.ts:471-476` 循环内 `nodes.find` | 建索引 | R4 |
| 9 | `retainedGens` 定点 O(G²·pins) | `recycle.ts:176-197` `while(changed)` 每轮全扫 | 改工作表（只重扫新增项） | R0-4 同处 |
| 10 | 帧解码 O(字节²) | `wire.ts:102-117` 每次 push 都 `Buffer.concat([buffered, chunk])` | 累积 chunk 列表，够一帧再 concat | R9（与 SDK 帧实现同批，两侧同时改） |
| 11 | 三个永不淘汰的 Map | `route.ts:84` `implementsCache` 键含世代哈希只增；`base.ts:59` `verifiedBases` 按 (file,mtime,size) 累积；`host.ts:1656` `driftLogged` 只增 | 按世代淘汰或改弱键 | R4 |
| 12 | `cmp` / `deepEq` 每次比较排序键 | `machine.ts:139-142`、`value.ts:111-116` | 对象分支改单次遍历比较，不排序 | R0-2 同处 |
| 13 | 每节点分配 `at` 路径数组 | `machine.ts` 十余处 `[...at, i]`，成功路径也付 | 失败时才回溯构造路径（用父链指针） | R0-1 同处 |
| 14 | 线性名单查找 | `TERM_TAGS.includes`（`machine.ts:413`、`run.ts:127`）、`PRED_OPS.includes`（`:287`）、`ARITH_OPS.includes`（`:368`） | 换 `Set` | R0 |
| 15 | compact 全量重写 + 击穿惰性 | `base.ts:201-202` 的 filter 对惰性 defs 逐个触发分片读，把整个世界 body 物化；`recycle.ts:271-276` 的 `pruneDefs` 用普通对象重建**丢失惰性** | `pruneDefs` 保持惰性表形态；`writeBase` 改增量（只写变动分片） | R8（与 `storage-dedup` 对账后） |

---

## 十一、R8 清理与瘦身

### 11.1 死代码

| 项 | 位置 | 证据 |
| --- | --- | --- |
| `asLiteral` | `kernel/journal.apply.ts:346` | 全仓零引用 |
| `isLazyDefs` | `kernel/defs.ts:25` | 宿主直接用 `LAZY_DEFS` 符号（`def-store.ts:10`） |
| `executeEffect` | `host/effect/execute.ts:173-181` | 注释自承仅测试用，未从 `effect/index.ts` 导出 |
| `DefStore.getMany` | `host/ledger/def-store.ts:117-124` | 唯一调用在 `ledger/test/base-shard.test.ts:244` |
| base v1 兼容路径 | `ledger/base.ts:31`、`:116-141`、`journal.ts:254-265` | 存量不迁已定案（§零.7），若确认无 v1 世界可整体删 |

### 11.2 只被测试用的配置旋钮

`AuditStoreOptions.maxFileBytes`（`audit-store.ts:32`）、`AuditBackfillOptions.maxRecords/maxBytes`（`audit-backfill.ts:24-29`）、`DefStoreOptions.cacheLimit/cacheBytesLimit`（`def-store.ts:37-40`）、`ProjectionOptions.refCap`（`projection/index.ts:141-143`）、`SourceWatcherOptions.debounceMs`（`watcher.ts:26-27`）。

**例外**：`CompactRetention.keepGens` / `keepRoots` **不删**——在进计划 §六 B2 正在收窄它们的覆盖范围，是活的。

### 11.3 死字段：`health.probe`

每个 manifest 都写 `health.probe`（如 `plugins/session/plugin.json:35`），但 `supervision.ts` 的 `parseHealth`（`:132-141`）**完全不读**它；反过来它读的 `failure_threshold` / `grace_period_ms` 不在 `docs/plugins.md` 的 14 字段表里。**对账**：从 manifest 与文档删除 `health.probe`（健康判据是协议级 `probe` / `pong`，服务自述的探针名无消费者），并把 `failure_threshold` / `grace_period_ms` 补进 `docs/plugins.md` 的 `health` 行。

### 11.4 内核点分段回并

`packages/kernel/README.md:110` 的护栏是「运行时文件 ≤ 400 行」。三处点分段的拆分理由不成立（行数为 LF 计数）：

| 合并 | 结果行数 |
| --- | --- |
| `hash.utf8.ts`(39) → `hash.ts`(148) | 187 |
| `journal.id.ts`(53) → `journal.ts`(109) | 162 |
| `commit.form.ts`(115) → `commit.ts`(160) | 275 |

反向：`machine.ts` **452 行已越限**，按原语分派表拆（`switch` 改 `Map<TermTag, handler>`，顺带解决 R7-14）。

`journal.apply.ts`(348) 不能与 `journal.ts` 合并（会到 457）。`rebase.ts`(154) 与 `recycle.ts`(311) 合并会到 465，也不合并；但须抽出共享的 remap——`recycle.ts:228-249`（`remapGrafts` / `remapBases`）与 `rebase.ts:134-151` 是同一件事的两份实现（都按 `oldToNew` 重写 `gen.base` / `gen.graft.gen` / `identity.active`）。

**合并会牵动零 IO 扫描测试**：`kernel/test/invariants.scan.test.ts:11-25` 的 `RUNTIME_FILES` 逐个断言文件存在（`:58-61`），故合并后必须同步删去对应条目（`hash.utf8.ts` / `journal.id.ts` / `commit.form.ts`），否则测试因文件不存在而红。与 §11.5 是同一处改动。

### 11.5 测试覆盖缺口

- `kernel/test/invariants.scan.test.ts:11-25` 的 `RUNTIME_FILES` **漏列** `patch.ts` / `rebase.ts` / `recycle.ts`（该表只有 13 项），故零 IO 扫描不覆盖这三个文件。补齐——与 §11.4 的合并同处改（合并要删条目，补漏要加条目）。
- **无 `rebase.test.ts`**：`flattenPatches` 仅在 `patch.test.ts:239-296` 间接覆盖，remap 分支（`:134-151`）无独立测试。
- 失败节点身份（`at`/`def`/`callAt`）在 `run` 面零断言（R0-1 补）。

### 11.6 协议单一真源

`packages/client` 与宿主的四处平行实现须收敛或用一致性测试钉死：

| 概念 | 客户端 | 宿主 |
| --- | --- | --- |
| 帧编解码 | `client/frame.ts:10-34` | `host/wire.ts:90-119` |
| 协议版本常量 | `client/protocol.ts:5` | `wire.ts:8` |
| `Limits` 类型 | `client/protocol.ts:7-10` | `wire.ts:10-13` |
| socket 地址派生 | `client/socket.ts:6-17` | `paths.ts:36-39`、`:81-87` |

`packages/client/README.md:8` 明确承认双实现是刻意的（两侧边界独立）。**保留双实现，但补一致性测试**：同一帧两侧编码逐字节相同；`client/index.ts:19-30` 那份手工 kind 白名单与 `wire.ts:76-87` 的 `OutboundMessage` 联合必须对齐（任一侧新增 kind 忘同步会静默 `failAll` + `destroy`）。

错误帧属两个协议族，不强行同一信封：客户端协议按 `kind` 判别（`{kind:'error', code, message}`，`host.ts:1300-1306`，已符合）；插件服务协议按 `ok` 判别（`{ok:false, code, message}`，`session/execute/main.ts:76`）。真正的缺陷是反向 PortLink 用 `error` 而非 `code`（`service-link.ts:394-401`）。统一口径：错误码字段一律名 `code`，信封按族保留；PortLink 的 `error`→`code` 因两端分属宿主与插件服务，切换随 R9 SDK 落地，R8 只记录口径。

---

## 十二、R9 插件 SDK（顶层独立包）

### 12.1 定位（不要与 R2 混谈）

R2 是「框架不认识具体插件」；R9 是「插件不必重写框架协议」。R9 **不是**「插件通用化」——各插件仍各自独立，SDK 只提供协议壳。

### 12.2 证据

| 样板 | 份数 | 证据 |
| --- | --- | --- |
| `frames.ts`（`MAX_FRAME_BYTES` + `encodeFrame` + `createFrameDecoder`） | **34** | `plugins/secrets/execute/frames.ts` 与 `plugins/model-protocol/execute/frames.ts` 逐字节相同，仅日志前缀不同 |
| `frames.rs` | **6** | `plugins/sandbox/execute/frames.rs`、`plugins/workspace/execute/frames.rs` |
| `sendError` | **35** | `plugins/session/execute/main.ts`、`plugins/chat/execute/main.ts` |
| `readPlugin`（从 `plugin.json` 派生 manifest） | **31** | `plugins/session/execute/main.ts`、`plugins/secrets/execute/main.ts` |
| `parseEnv` | **28** | `plugins/session/execute/main.ts` 与 `plugins/chat/execute/main.ts` 完全相同 |
| `BadArgsError` | **32** | `plugins/session/execute/types.ts`、`plugins/secrets/execute/types.ts` |
| `isRecord` | **66** | 遍布（`function` 定义处） |
| 帧循环 `switch(kind)` | 每服务一份 | `plugins/session/execute/main.ts`、`plugins/secrets/execute/main.ts` |
| `PortLink` | **15** | `plugins/*/execute/port-link.ts`（有 `pins` 的服务） |
| `test/driver.mjs` | **15** | `plugins/chat/test/driver.mjs` 重新实现帧编解码 + spawn + id 配对 + port bridge |

（份数随插件增减；上表为盘查当时值。）

**最严重的后果是协议口径分裂**：`docs/protocol.md:12` 要求「按内核口径的规范序列化」，但宿主用 `canonicalJson`（`wire.ts:91`）、插件 TS 用 `JSON.stringify`（`frames.ts:11`）、Rust 用 `serde_json::to_vec`（`frames.rs:13`）。运行期该契约**不成立**。

### 12.3 位置与依赖边界（口径约束）

插件不得互相 import、不得 import 宿主与内核（`docs/plugins.md:103` 红线 1）。故：

- SDK 是**顶层独立包** `plugin-sdk/`（与 `toolchain/` 同级，同为第一方非载体包）。放根目录而非 `packages/` 的理由：`packages/` 是**载体**四包（kernel / host / client / boot，见 `packages/README.md:10-15`），SDK 是插件侧库、不是载体；且 `toolchain/` 已有「第一方非载体包住顶层」的先例，分界在目录上一眼可见。不进任何插件包。
- SDK **零内核零宿主依赖**：自带 `canonicalJson` 实现（参照 `toolchain/lower.ts` 的零依赖做法），不 re-export 内核。这是「插件可 devDependency 拉它而不传递内核」的前提。
- 依赖方向写死：SDK **不得** import `packages/*`；`packages/*` **不得** import SDK。
- Rust 侧同理：`plugin-sdk/rust/`，消 6 份 `frames.rs`。

### 12.4 SDK 吸收什么

| 吸收进 SDK | 留在插件 |
| --- | --- |
| 帧编解码 + 16 MiB 上限 + **规范序列化**（统一口径） | 方法实现与业务逻辑 |
| 服务帧循环：`hello→manifest` / `probe→pong` / `reload→ack` / `drain→bye` / stdin EOF 自退出 | 持久化引擎、格式、迁移（`docs/host.md:266`） |
| manifest 派生：读同包 `plugin.json` 取 `identity`/`implements`/`methods`/`protocol`/`state` | 投影 bag 装配（服务不读投影） |
| call 派发 + 能力/方法门禁 + 参数形态门禁 | 领域校验与领域错误码语义 |
| 错误映射：`BadArgsError→bad_args`、未知→`internal` | plan / term 构造 |
| `PortLink` 反向调用 + `env` 解析 + `env.now` 强制注入 | — |
| 计划值 helper：`externOnly` / `errorValue` / `isErrorValue` / `mergeDirectives` / `isRecord` / `asString` | — |
| 测试驱动：`startService` + `request` + port bridge | fixture 与断言 |

### 12.5 与 R5 的接口

SDK 产出的服务应能**同时**跑三种形态：stdio 下由 SDK 起帧循环；in-proc / worker 下由 SDK 暴露同一派发器供宿主直调。这是 SDK 设计时就要留的口，不是后补。

### 12.6 迁移方式

**不逐个手改全部插件**（`plugins/` 下 52 个目录，51 个已登记）。分两轮：

1. 先在 2 个插件上验通（一个 TS 纯服务如 `secrets`，一个有 `pins` 的如 `session`），确认 SDK 覆盖面够。
2. 其余按批替换，每批一次提交；每批跑该插件 `npm test` + `tools/e2e-smoke.mjs`。

**R9 验收**：`rg "MAX_FRAME_BYTES" plugins/` 收敛到 0（全走 SDK）；一致性测试断言 SDK 与宿主 `wire.ts` 对同一帧产出逐字节相同；各插件 `npm test` 全绿；`packages/host` 下 `npm test` 不退步。

---

## 十三、验收与命令

每阶段独立验收；提交信息无人称自述、无计划编号。

| 阶段 | 命令 |
| --- | --- |
| R0 | `packages/kernel` 下 `npm test`、`npm run typecheck`；`packages/host` 下 `npm test` 不退步；老日志 `replay` 逐字节不变 |
| R2 | `packages/host` 下 `npm test`、`npm run typecheck`；`rg "'sandbox'\|'guard'\|'secrets'\|'approval'\|'storage-sql'\|'storage-kv'" packages/ --glob '!**/test/**'` 为 0；四处保留命令名清单同源 |
| R6 | `toolchain` 下 `npm test`、`npm run typecheck`；toy 包源→构建→入世→`eval` 通路；`router.select` 三条端到端验收 |
| R1 | `packages/{kernel,host}` 下 `npm test`、`npm run typecheck`、`npm run format:check` |
| R3 | `packages/host` 下 `npm test`、`npm run typecheck`；并发写 CAS 用例 |
| R4 | `packages/host` 下 `npm test`（含 `assembly/test/`、`ledger/test/`、`projection/test/`）；启动失败不泄漏锁与子进程用例 |
| R5 | 同一 toy 插件 stdio / inproc / worker 三形态行为一致用例 |
| R7 | 不单独验收——15 条各并入其所归阶段（R0 / R1 / R4 / R8 / R9）的验收 |
| R8 | 全包 `npm test`；`packages/boot`、`packages/client` 下 `npm test`、`npm run typecheck` |
| R9 | 各插件目录 `npm test`；`rg MAX_FRAME_BYTES plugins/` 为 0；SDK 与 `wire.ts` 帧一致性测试 |
| 端到端 | `packages/host/test/` 的 `host-recycle` / `host-generation` / `host-def-read` / `host-audit` 全绿；各包 `tools/e2e-smoke.mjs` 全过 |

---

## 十四、风险与不做

**风险**

- **R9 与 W2–W5 的改动面重叠是最大排期风险**：SDK 重写每个插件的 `execute/main.ts`，W2–W5 也改这些文件。故 R9 **硬依赖 A5**。若要提前，只能选 W2–W5 不触及的插件先验通（如 `secrets`、`router`、`guard`）。
- **R2 的 `audit_tier` 声明化撞 P1 改动面**：`audit-store.ts` 刚按 P1 改过分档结构。动前核 A7，且只改档位来源不改分档机制。
- **R5 的同进程形态引入新的失败模式**：`inproc`（同线程）插件崩溃会带走宿主，故须在 `docs/plugins.md` 写明代价、默认不推荐；`worker` 有独立堆，崩溃只收该分支。形态由插件 `transport` 显式声明，`inproc` / `worker` 之间无缺省。
- **R4 拆分期间的合并冲突**：`host.ts` 是高频改动文件。拆分应一次做完、单批提交，不分多批拖长窗口。
- **R6 的 kill criterion 必须尊重**：`docs/plans/judgment-as-data-plan.md` §八 已写死三条验收任一不过即停走 B。不得因为「工具链已建好」而绕过该门。
- **R0 改内核会与在进计划的「内核不改一行」证明冲突**：必须分开提交、分开声明验收，否则那条证明被污染。
- **在进计划仍在改**：§0.2 的六条继承口径若被修改，本计划对应条目须同步作废。每次开工前核 §0.1 的表。

**不做**

- 不引入任何存量迁移脚本（继承 §零.7）。
- 不为运行记录补链式完整性或跨 owner 事务（继承 §零.8、§零.9）。
- 不把 `plugin-state` 与 `plugin-data` 的回收策略统一（继承 §2.3）。
- 不删 `kernel/rebase.ts` 的公共面（老日志要能重放）。
- **不把 SDK 放进 `packages/`，也不放进任何插件包**（插件不得互相 import；`packages/` 是运行时载体）。
- **不把受保护 pin 名单交给插件自报**：该名单是安全策略，进运营配置 `chrono.config.json`，不由被约束者声明。见 §6.2 第 1 项。
- **不引入「插件宿主子插件」这一层**：会要求父插件 import 子插件代码，违反插件间禁止互相 import 的红线；同进程插件一律载入宿主进程（或其起的 worker）。见 §9.4 第 3 点。
- **不开放 `host` 保留能力类给插件扩展**（10 个方法全为宿主特权，见 §6.3）。
- **不开放协议封闭集给插件扩展**（消息 kind / 服务帧 kind / op 名 / 审计 outcome 是共同契约）。
- **不开放 `MEMBER_KINDS` 与 `state` 档**（框架内部语义，扩展会破坏换代判据与 GC 口径，见 §6.2 第 6 项）。
- 不给 `toolchain` 加 lambda / 递归 / while（内核设计拒绝）。
- 不做可视化判定编辑器。
- 不在 `storage-dedup` 未绿前启动 R6 的单判定实验，也不启动 R7-15 的 compact 增量化。
