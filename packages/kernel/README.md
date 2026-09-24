# Chronokernel

可复现的世界 + 谱系 + 机械校验。内核不装载、不审核、不执行外部动作，只保证世界**可追溯、可回滚、不可被非法改写**。

## 它做什么 / 不做什么

做四件事：

| 机制     | 一句话                                                                |
| -------- | --------------------------------------------------------------------- |
| 值层     | JSON 值 + 类型格 + 规范序列化 + 内容哈希——可比较、可锚定              |
| 归约机   | 8 原语的项求值 + gas / depth 预算——世界内容（含一切判定标准）可被执行 |
| 日志     | append-only 哈希链 + 可参数化重放——可归因、可退回任意版本             |
| 唯一写口 | 机械校验 + 恰好单次应用——非法内容进不来，谱系与依附不变量守得住       |

明确不做：装载代码、IO、持久化、调度、审核（该不该采纳）、效果执行、多世界合并、任何"删除"。
内核认识的概念只有四个词：**身份 · 世代 · 依附 · 判决**。判决 = 机械合法性（`ok` / `reasons`），不是正当性——后者永远在上层。

纯函数契约：同输入必得同输出。无内部时钟（`now` 从输入来）、无随机、非 `*.test.ts` 文件零第三方 import。

## 核心模型

- **世界 `World`** = `defs`（内容寻址的 def 表，键 = `H(Def)`）+ `ids`（身份表，`gens` 世代链只增不减，`active` 指向当前世代）。
- **日志 `Entry[]`**：每条 entry 带 `seq` / `prev` / `op` / `args` / `argsHash` / `by` / `ref` / `at`，`entryHash` 逐条接链，篡改任何字段都会在校验时暴露。
- **写请求 `WriteRequest`**：`expect_pos` 乐观并发（一个赢，输家 `pos_conflict` 后重组请求再提，这是正常路径）。十种 op：`put` / `add_identity` / `add_gen` / `set_active` / `retire` / `fork` / `graft` / `batch` / `note` / `snapshot`。
- **两个身份**：位置 `pos`（链头哈希，O(1)，用于并发与链完整性）与内容 `worldRev`（快照锚点与跨世界比较，按需算）。批内原子写入 `batch` 支持自引用占位符 `{"$n": k}`，引用**本批更早**的 `put` 产物。
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
- 信任边界：内核给一致性、不给正确性——`by` 是不透明标签、`results` 由宿主照单回灌，效果侧审计记录由宿主留存并用 `ref` 指向。

## 文件与依赖

| 文件               | 职责（导出口径见 `index.ts`，加导出 = 改设计）                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `types.ts`         | 全部共用类型 + `KernelError`（错误只携带 code，边界处收口为 refused）                            |
| `value.ts`         | 类型格 `t` / `canonicalJson` / `deepEq`                                                          |
| `hash.ts`          | FIPS 180-4 sha256（增量压缩）+ `H()`                                                             |
| `hash.utf8.ts`     | UTF-8 编码（孤立代理即拒），`H` 的流式入口                                                       |
| `journal.id.ts`    | 两个身份：`entryHash`（O(1)）与 `worldRev`（按需）                                               |
| `journal.apply.ts` | `applyEntry` 逐 op 语义 + `batch` 两段式（预哈希趟 → 应用趟，失败逆序回滚）                      |
| `journal.ts`       | `EMPTY_WORLD` / `EMPTY_HEAD` / `cloneWorld` / `pos` / `anchorAfter` / `replay` / `verify` + 转口 |
| `recycle.ts`       | `recycleWorld`：compact 写 base 时的可达性回收 + 世代保留窗口（纯函数，不改链）                  |
| `commit.form.ts`   | `validate` 的形态检查（op 形状表）                                                               |
| `commit.ts`        | `validate` / `entryOf` / `commit`（唯一写口）/ `stale`（依附判定）                               |
| `machine.ts`       | `eval`（导出名）：8 原语分派 + `walk` / `evalCall`；`cmp` 全序                                   |
| `run.ts`           | 编排：`run` / `observationsOf`；唯一调用 `commit` 之处，错误只在此收口                           |
| `index.ts`         | 只 re-export、无逻辑；公共面的全部形状                                                           |

依赖是单向：

```
value ← types
hash ← types, value, hash.utf8
journal.id ← types, hash ·  journal.apply ← types, hash, journal.id
journal ← types, journal.apply, journal.id
commit.form ← types ·  commit ← types, hash, journal
machine ← types, value, hash        （与 journal / commit 之间无任何边）
run ← 全部
```

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
