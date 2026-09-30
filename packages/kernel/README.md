# Chronokernel

可复现的世界 + 谱系 + 机械校验。内核不装载、不审核、不执行外部动作，只保证世界**可追溯、可回滚、不可被非法改写**。

## 它做什么 / 不做什么

做四件事：

| 机制     | 一句话                                                                 |
| -------- | ---------------------------------------------------------------------- |
| 值层     | JSON 值 + 类型格 + 规范序列化 + 内容哈希——可比较、可锚定               |
| 归约机   | 14 原语的项求值 + gas / depth 预算——世界内容（含一切判定标准）可被执行 |
| 日志     | append-only 哈希链 + 可参数化重放——可归因、可退回任意版本              |
| 唯一写口 | 机械校验 + 恰好单次应用——非法内容进不来，谱系与依附不变量守得住        |

明确不做：装载代码、IO、持久化、调度、审核（该不该采纳）、效果执行、多世界合并、任何"删除"。
内核认识的概念只有四个词：**身份 · 世代 · 依附 · 判决**。判决 = 机械合法性（`ok` / `reasons`），不是正当性——后者永远在上层。

纯函数契约：同输入必得同输出。无内部时钟（`now` 从输入来）、无随机、非 `*.test.ts` 文件零第三方 import。

## 核心模型

- **世界 `World`** = `defs`（内容寻址的 def 表，键 = `H(Def)`）+ `ids`（身份表，`gens` 世代链只增不减，`active` 指向当前世代）。
- **日志 `Entry[]`**：每条 entry 带 `seq` / `prev` / `op` / `args` / `argsHash` / `by` / `ref` / `at`，`entryHash` 逐条接链，篡改任何字段都会在校验时暴露。`ref` 是可选的世界内 def 指针，内核不解释；效果审计**不住 def**，走宿主旁路侧存，故业务 entry 不携带 `ref`。
- **写请求 `WriteRequest`**：`expect_pos` 是位置门禁（对链头 CAS）；宿主串行落账时**机械重锚**到当时链头，故 `pos_conflict` 结构上不产生，不存在「检测冲突再自动重提」的路径。十种 op：`put` / `add_identity` / `add_gen` / `set_active` / `retire` / `fork` / `graft` / `batch` / `note` / `snapshot`。
- **两个身份**：位置 `pos`（链头哈希，O(1)，用于并发与链完整性）与内容 `worldRev`（快照锚点与跨世界比较，按需算）；两者的实现是独立叶子模块 `identity.ts`。批内原子写入 `batch` 支持自引用占位符 `{"$n": k}`，引用**本批更早**的 `put` 产物；要落 `{"$n": k}` 字面量本身须用 `{"$lit": v}` 转义（`$lit` 内的 `$n` 不再当占位符），其还原沿包裹链累加同一 `MAX_JSON_DEPTH` 深度护栏。`graft` 是独立 op——`add_gen` 的形态不接 `graft`（也不接 `from` / `gen`），二者共用同一应用路径。
- **回滚 = 追加**：`set_active` 指回旧世代，历史不折叠；幂等命中（同内容 `put` / 全幂等 `batch`）不产生 entry。

## 数据流：一次 `run` 输入 → 一条输出

```
KernelInput { world, head, run, directives, results, limits, caps, now }
   → run(input)
KernelOutput { world, journal, head, pending, observations, status, usage }
```

- `directives`：`eval`（在归约机里跑一条 def）/ `write`（进唯一写口）/ `extern`（只产观测）。一次调用至多推进到一个挂起点，不内嵌循环。
- 四态语义：
  - `idle`：无 directives，新输入未到。
  - `done`：全部处理完，`world` / `journal` / `head` 可直接落盘（落盘是宿主的事）。
  - `waiting`：eval 求值未命中 `results`——输出**回到入口**的世界与链头，交出 `pending`；宿主执行效果、把结果写进 `results` 后，以**同一 `run_id`、同一份完整 `directives`、同一 `now`** 重调（续跑契约）。
  - `refused`：机械校验失败或求值错误——整次调用作废（世界未动是字面事实），拒因在 `observations` 末尾 `{kind:'refused', reasons}`。
- 效果纪律：效果放叶子、长循环拆多个 directive；`waiting` 从不返回部分世界，宿主也不得凭 `waiting` / `refused` 的观测推进 checkpoint。
- 信任边界：内核给一致性、不给正确性——`by` 是不透明标签、`results` 由宿主照单回灌，效果侧审计由宿主留存于**旁路侧存**（不进世界、业务 write 不落 `ref`）。

## 文件与依赖

| 文件               | 职责（导出口径见 `index.ts`，加导出 = 改设计）                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`         | 全部共用类型 + `KernelError`（错误只携带 code，边界处收口为 refused）                                                                                         |
| `value.ts`         | 类型格 `t` / `canonicalJson` / `deepEq`                                                                                                                       |
| `hash.ts`          | FIPS 180-4 sha256（增量压缩）+ `H()` + UTF-8 编码（孤立代理即拒）                                                                                             |
| `defs.ts`          | def 表访问三件事（`defHas` / `defsKeys` / `cloneDefs`）；经全局符号 `LAZY_DEFS` 识别宿主惰性分片代理并廉价克隆（不读 body）                                   |
| `patch.ts`         | 补丁世代：`readPatchOps` 读取补丁 def、`assembleBody` 按序应用补丁                                                                                            |
| `identity.ts`      | 两个身份哈希（独立叶子，不依赖 journal 层）：`entryHash`（O(1)）与 `worldRev`（按需，摘要不吃履历）                                                           |
| `journal.ts`       | 空世界常量 / 链位置 / 锚点 / 重放 / 段校验；**转口** `applyEntry` 与两个身份（身份实现在 `identity.ts`）                                                      |
| `journal.apply.ts` | `applyEntry` 逐 op 语义 + `batch` 两段式（预哈希趟 → 应用趟，失败逆序回滚）+ `$n` / `$lit` 替换（只造新对象，不改入参）                                       |
| `recycle.ts`       | `recycleWorld`：compact 写 base 时的可达性回收 + 世代保留窗口（纯函数，不改链）                                                                               |
| `rebase.ts`        | `flattenPatches` 压扁线性补丁链；`remapGens` 世代重建后的 base / graft / active 重映射（回收共用）                                                            |
| `commit.ts`        | `validate`（含 op 形状表）/ `entryOf` / `commit`（唯一写口）/ `stale`（依附判定）                                                                             |
| `machine.eval.ts`  | 14 原语求值 + `Map` 分派表 + `walk` / `evalCall`；`cmp` 全序 / `pred` 谓词 / `get`·`getOr` 投影 / `arith`·`list`·`obj` 构造；`eff` 形态先于求值与序号自增校验 |
| `machine.ts`       | 归约机**类型**（`Term` / `Env` / `EvalResult`）；`TERM_TAGS` / `eval` / `cmp` 经 `machine.eval.ts` 转口，本文件不定义原语                                     |
| `run.ts`           | 编排：`run` / `observationsOf`；唯一调用 `commit` 之处，错误只在此收口                                                                                        |
| `index.ts`         | 只 re-export、无逻辑；公共面的全部形状                                                                                                                        |

依赖是单向（`←` 左为被依赖方）：

```
value ← types
hash ← types, value
defs ← types
patch ← types, value
identity ← types, defs, hash          （entryHash / worldRev：不依赖 journal 层）
journal.apply ← types, defs, hash, identity, patch, value
journal ← types, defs, journal.apply, identity   （转口 applyEntry 与两个身份）
rebase ← types, defs, hash, patch
recycle ← types, defs, rebase, value
commit ← types, defs, value, journal
machine.eval ← types, hash, value     （逐原语求值 / 分派表 / cmp）
machine ← types, machine.eval         （类型定义 + 转口 TERM_TAGS / eval / cmp；与 journal / commit 无任何边）
run ← commit, journal, machine, types
```

## 公共导出面

`index.ts` 只 re-export，公共面即下表（评审只从公共面导入，加导出 = 改规格）：

| 模块    | 导出                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| types   | 全部共用类型 + `KernelError`                                                                                               |
| value   | `TYPE_ORDER`、`TypeName`、`t`、`canonicalJson`、`deepEq`                                                                   |
| hash    | `utf8`、`sha256`、`H`                                                                                                      |
| defs    | `LAZY_DEFS`、`LazyDefsHandle`、`cloneDefs`、`defHas`、`defsKeys`                                                           |
| patch   | `PatchOp`、`PatchPath`、`assembleBody`、`readPatchOps`                                                                     |
| journal | `EMPTY_WORLD`、`EMPTY_HEAD`、`cloneWorld`、`pos`、`worldRev`、`entryHash`、`applyEntry`、`replay`、`verify`、`anchorAfter` |
| rebase  | `flattenPatches`、`remapGens`、`FlattenResult`                                                                             |
| recycle | `recycleWorld`、`RecycleSpec`、`RecycleStats`、`RecycleResult`                                                             |
| commit  | `commit`、`validate`、`entryOf`、`stale`                                                                                   |
| machine | `eval`、`cmp`、`TERM_TAGS`                                                                                                 |
| run     | `run`、`observationsOf`                                                                                                    |

## 长链与归档

历史永不删除，热路径靠"追加"瘦身：宿主择时追加一条 `snapshot` entry（`args = {world_rev}`，位置即边界凭证），之前的段可移出热存储。任何归档段仍可用 `verify(段, anchorAfter(边界 entry), expected?)` 独立校验，`replay(尾段, 快照世界)` 必须与全量重放逐字段相同——这是长链安全的硬判据（未启用有界化回收时；见 `recycle.ts`，回收后基础世界是子世界，冷段仍保历史供 full verify）。

## 用法（宿主最小闭环）

```ts
import { EMPTY_HEAD, EMPTY_WORLD, H, run } from './index.ts'

const now = 1_700_000_000_000 // 时钟归宿主；同一逻辑执行的每次续跑必须传同一值
const def = { body: ['c', true] as const }
const key = H(def)

const out = run({
  world: EMPTY_WORLD,
  head: EMPTY_HEAD,
  run: 'r-1',
  now,
  directives: [
    {
      kind: 'write',
      request: { id: 'req-1', op: 'put', target: { expect_pos: null }, args: def, by: 'app' },
    },
    { kind: 'eval', entry: key, args: null, ctx: {} },
  ],
  results: {},
  limits: { gas: 10_000, depth: 32 },
  caps: { net: false },
})
// out.status === 'done'；out.world.defs[key] 已生效，out.journal 两条，out.head 即新链位置。
```

## 维护纪律

- 2 空格、行宽 100、UTF-8、Prettier 统一排版；文件 ≤ 400 行（`*.test.ts` ≤ 500，超了按 `名.段.test.ts` 点分拆）、单函数 ≤ 50 行、单文件参数 ≤ 4，超限即拆。
- 命名含动词、布尔以 `is` / `has` / `can` 开头；注释只解释"为什么"；不留死代码、不留计划编号与外部文档指针——**代码描述自身，规格归规格文档，两者不互引**。
- 不变式速查（验证测试与实现同目录、`*.test.ts` 即其落点）：纯函数双跑逐字节一致；唯一写口（世界成员写只出现在日志层）；批量中途失败逐字节回滚；幂等命中不追加日志；`applyEntry` 绝不回写传入 entry；哈希计数桩锁性能上界（`put` 恰一次规范化、`entryHash` 不读 `args`）。
- 效果执行、结果回灌、审计留痕是**宿主的显式契约**：内核只保证回灌后世界确定演化，不校验回灌内容是否属实。

## 本地检查

```
npm ci            # 锁文件安装（首次：npm approve-scripts esbuild 以启用 vitest 依赖的 postinstall）
npm run typecheck # tsc --noEmit，零错误
npm run format:check
npm test          # vitest：值层/哈希/日志/写口/归约机/编排 + 跨模块行为不变量与源码静态扫描
```
