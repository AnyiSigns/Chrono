# 内核落地阶段计划（阶段 × 做什么）

> 依据：`kernel.md` §15 的 P0/P1/P2 批次 + §5.4 的角色分工。
> 本文档由作者 agent 维护；判据分"实现方"与"评审方"两列，缺一不算过。
> **当前状态：S0–S4 实现全部完成（tsc / prettier / 行数与函数长预算 / 静态扫描 / 行为冒烟全绿），等待评审 agent 按 §5.4 写测试。**

## 总览

| 阶段 | 交付（作者 agent = 实现者） | 实现方判据（已自跑） | 评审方判据（评审 agent 跑，实现者不写测试） | 状态 |
|---|---|---|---|---|
| S0 脚手架 | `package.json` / `tsconfig.json` / `vitest.config.ts` / `.prettierrc` / `README.md` / `package-lock.json` | devDeps 装妥（npm 12 需 `npm approve-scripts esbuild`）；tsc / prettier / vitest 三命令可跑 | 工具链白名单（§5.2）：devDeps 仅 typescript + vitest + prettier | ✅ 完成 |
| S1 = P0 值层 + 日志层 | `types.ts` `value.ts` `hash.ts`(+`hash.utf8.ts`) `journal.ts`(+`journal.apply.ts`+`journal.id.ts`) `index.ts` | 行数 hash 137/150、value 125/150、journal 三件 93+297+45、index 11/40；sha256 §9.4 四向量、H 流式/两段式等价、put 幂等、batch 两段与回滚、snapshot、replay/verify/锚点、worldRev 不吃履历——本地冒烟全过 | `value/hash/journal.test.ts` 全绿；不变量 1/2/7/8/15 绿 | ✅ 实现完成，待评审 |
| S2 = P1 写口 + 机器 | `commit.ts`(+`commit.form.ts`) `machine.ts`，index 追加 | 行数 commit 152/250、form 112、machine 281/400；dup / pos_conflict / batch 子撞号兜底 / stale 分支 / 8 原语正反 / 函数即值 / fold-函数侧恰一次 / gas / 深而宽——冒烟全过 | `commit/machine.test.ts` 全绿；不变量 3/4/5/6/9/10/11/14 绿 | ✅ 实现完成，待评审 |
| S3 = P2 编排 | `run.ts`，index 追加 `run` / `observationsOf` | 行数 run 214/250；四态构造口径、waiting→回灌→done 与重跑确定一致、边界 catch、观测形状、链式 expect_pos——冒烟全过 | `run.test.ts` 全绿；**15 条不变量全绿** | ✅ 实现完成，待评审 |
| S4 交接与静态自检 | 本文件、README；作者侧验证脚本（**不入库**，暂存 `%TEMP%\kilo\smoke-p0.mjs`、`smoke-full.mjs`、`kernel-static-scan.mjs`） | 静态扫描零命中：运行时 import 全相对、无 Date/Math.random/fetch/process；`defs/ids` 写点仅 journal*（不变量 4）；禁词表零命中（不变量 10）；单函数 >50 零命中 | 评审从 `index.ts` 开写；触发不了的边界表条目 = 规格缺口回填 kernel.md | ✅ 完成 |

## 实际文件 ↔ kernel.md §5.1/§5.2 布局映射（点分段均 §5.1 预许可："超了拆 X.*.ts，仍平层"）

| §5.1 原名 | 实际落点 | 原因 |
|---|---|---|
| `hash.ts` | `hash.ts` + `hash.utf8.ts` | 150 行预算硬约束，utf8/增量编码器拆出 |
| `journal.ts` | `journal.ts` + `journal.apply.ts` + `journal.id.ts` | 原样单文件 ≈420 行；apply 与 id 为规格预许可的点分段；公共面全部由 `journal.ts` 转口，index 的 §10.1 清单不变 |
| `commit.ts` | `commit.ts` + `commit.form.ts` | validate ① 形态表拆出；公共面由 commit.ts 转口，index 的 §11.1 清单不变 |
| `machine.ts` | 不拆 | 281 ≤400（含分派小函数结构，未触 `machine.prims.ts` 预案） |

## 各阶段细化

### S0 脚手架
- ESM（`"type": "module"`），`moduleResolution: "bundler"` + `allowImportingTsExtensions`：TS + vitest + node 型擦除三方零构建直跑（§5.2）。
- tsconfig：`strict`，不开 `exactOptionalPropertyTypes`（§7 的 `ref?: Hash` 按"缺失或 undefined"宽松记账；canonicalJson/deepEq 对 undefined 键一律剔除，口径一致）。
- `.prettierrc`：`semi:false, singleQuote, printWidth:100`——与 §7 代码块样例逐行同风格。

### S1（P0）要点
- `KernelError` 放 `types.ts`（D4：全模块共同抛；依赖 DAG 唯一人人可达上游；纯数据形态零逻辑）。
- `H` 增量压缩：canonical 字符流按 code unit 喂入、512 位块就地压缩（§9.2）；`sha256(bytes)` 保留整段入口供 §9.4 向量直断。
- 别名契约（§10.1）：`applyEntry` 就地改独占副本、绝不改入参 Entry；`argsHash` 由 `commit` 唯一回填。
- batch 两段式（§10.3）：段 1 纯哈希（substitute + argsHashOf + 聚合 + outerPos）、段 2 应用 + 逆序 undo；**嵌套 batch 的外层回滚由 undo 记录沿嵌套链共享**（伪代码 undo 为批局部——嵌套下外层失败无法还原内层已提交的 `ids` 改写，按不变量 11 收紧收集范围；子操作失败一律经 `{ok:false,error}` 上浮，与 §11.4 "validate 不递归兜底路径" 一致，代码注释标注）。

### S2（P1）要点
- `validate` 四步顺序焊死（①→②→③→④），单元素 reasons；不递归 batch；幂等由 commit 判。
- `machine`：内部求值返回 `Json` 并抛 `KernelError`（D4 干净返回类型），私有 `Suspend` 信号承载挂起；公共面（index 名 `eval`，实现名 `evaluation`）收 §12.4 三态。`evalCall` 为 `call`/`fold` 共用路径；`args` 就地换 + finally 还原，计数器不快照。

### S3（P2)要点
- `run`：入口 `cloneWorld` 恰一次；`RunState` 承载 head/gas/obs 推进；四态构造口径表逐格；`mkEnv.defs` 取当前世界；非 `KernelError` 一律放行（不吞）。

## 已知偏差与待裁决（回填 kernel.md 的候选）

| # | 位置 | 事实 | 处理 |
|---|---|---|---|
| 1 | §5.1 types.ts 预算 ≤120 | §7 原文代码块即 132 行（自带注释），加 D4 必需的 `KernelError` ≈149。预算假设与规格自身体量矛盾（"超了说明混了逻辑"不成立：文件零逻辑） | 保持 §7 完整与可追溯；请维护者在"裁注释 / 抬预算"间裁决后回填 |
| 2 | §5.4 导出面 vs eval 测试可行性 | 评审从公共面构造 `Env` 只能用 `Parameters<typeof eval>[1]` 推导；`Term`/`Env`/`EvalResult` 名不在 index 清单（`evaluation` 以 `eval` 名导出）。`cmp` 的 undefined-键分支经真实路径不可触发（Json 值域不含 undefined），评审只能按 §12.6"注明不做"精神依赖不变量 1 口径 | 实现严格按 §5.4 不增导出。若评审判"写不出断言"，按 §5.4 第 3 条回填规格而非加面 |
| 3 | §11.2 ① batch 空 `ops` | 规格未写空批口径（非空形态检查会误拒；空批按"所有子操作幂等"落进 isNoop→dup） | 实现允许空批走 dup;判为规格空白，留裁决 |
| 4 | §10.4/§11.4 `note` 的 `args` | 形状表 `note: {}`；批内子 note 与顶层 note 同判形态 | 实现统一 `exact([], [])`；批子操作不递归检查故不受 validate 拦截——与"内核不解释内容"一致 |

## 提交前自检记录（2026-09-15，作者 agent）

按 `code-review.md` §4 清单逐项（作者不写测试，"测试"项改为**可测性**自检）：

| 项 | 结论 | 证据 / 处置 |
|---|---|---|
| 单 PR ≤ 400 行 | ⚠️ 超标，已给拆分方案 | 有效变更 = 包内 1701 行源码 + 4 配置 + phases.md。仓库为全新零提交仓库。建议按 §15 批次切 4 个 PR：`S0+docs基线`（配置+phase 文档，约 120 行）/ `P0`（types/value/hash*/journal* ≈919 行）/ `P1`（commit*/machine ≈562 行）/ `P2`（run ≈215 行）。P0/P1 单切片仍超 400 时按点分段文件再切（journal 三件、commit 两件各自内部无写口交叉）——行预算与 400 行 PR 预算在"内核是概念闭集"下无法同时满足，列为待维护裁决 |
| 本地格式化 | ✅ | `prettier --check` 全绿（package/README 含） |
| Lint / 类型检查无新增告警 | ✅ | `tsc --noEmit` 0 错误；项目 lint 面 = tsc + prettier（§5.2 白名单不含 ESLint，devDeps 仅此三件） |
| 代码可测（职责单一 / 可桩 / 无隐藏全局态） | ✅（本轮收紧后） | 行为全经 `KernelInput` 数据注入（results/caps/limits/now/head 都是输入面，无外部端口依赖可桩）；全导出为纯函数；`applyEntry` 就地契约有不变量 15 的深冻桩兜底。**本轮加固**：全部模块级常量运行时 `Object.freeze`（TYPE_ORDER / IV / K / TERM_TAGS / VALID_OPS / EMPTY_WORLD 深冻结 / EMPTY_HEAD），误写全局共享字面量会在唯一副本路径之外的调用点当场抛——把"无隐藏可变态"从纪律变成机制 |
| 无密钥 / 调试代码 / 计划编号 / 注释掉的死代码 | ✅（两轮修订） | grep 零 `console|debugger|TODO|FIXME`；零注释掉的代码；`data/temp/obj/info` 禁词零命中。**第一轮**只删了批次编号并自辩保留 `§n/Gx/Dx/Mx` 条款引用——被判不合规；**第二轮全量清洗**：代码注释（含行末内联，字符串感知）中的一切编号引用清零（扫描 `§`、`[GDMS]\d`、`P[0-2]`、`S[1-4]`、`不变量\d`、"第 n 部分"均 0 命中，106 行注释重写为自解释语句，"为什么"完整留在句内，如"收紧批局部回滚，否则整批原子性在嵌套下不成立"） |
| 变更说明已填写 | ✅ | 见本轮回复正文（§5 模板全文），随首个 PR 描述落位 |
| 与《编码规范》《计划文件》一致 | ✅（4 条已记录例外） | 例外均登记在"已知偏差与待裁决"表：types 预算矛盾、index 导出面 vs Env/Term、空批口径、§-条款引用注释（kernel.md 自带引用密度，保留为"为什么"类注释）。JSDoc：公共导出均含 功能/@param/@returns/@throws |

### 注释与规格的可追溯性（裁决后口径）
代码注释不带任何编号引用（批次号与规格条款号都算计划编号，一律禁）；注释自解释"为什么"。
条款级追溯只存在于本文档与 README（文档不受该禁例约束）。若评审需要从代码反查条款，
途径是：函数/错误码/常量的命名与本文档表格一一对应（如"唯一写口"=commit、"两个身份"=pos/worldRev、
"整批原子性"=batch undo 回滚），这是**行为名词**而非编号，可安全引用。

### 复核命令（实现方判据，评审方可复跑）
```
cd packages/kernel
npm run typecheck && npm run format:check && npm test   # vitest 现为 No test files（§5.4 分工，属预期红）
```

## off-scope（v1，明确不做）

- 测试文件（`*.test.ts`）一律由评审 agent 写（§5.4），实现者提交中不含——本轮交付内为零。
- `compact` / 归档回收（§10.7）：P2 之后再谈。
- 多世界合并、装载、审核、排程、宿主端口实现（§2 / §22）：不在内核。
