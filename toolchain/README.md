# toolchain：term 作者工具链

第一方**作者侧构建期**工具：把作者写的判定源编译成 14 原语 term AST（数据），供插件包入世。
**非运行时**——不进宿主、不进内核、不进 ①，也不参与 `pins` / 路由 / 装配 / 生命周期。
设计口径见 [`docs/term-toolchain.md`](../docs/term-toolchain.md)；本目录只放实现。

## 分层

```
源（作者写，糖化 JSON 或 TS builder） → 编译（写期，本包） → term AST（数据，入世界）
```

## 文件

| 文件 | 职责 |
| --- | --- |
| `spec.md` | 糖化 JSON 规范（`k` 判别位的表达式对象 → 原语 AST 的逐条映射） |
| `lower.ts` | 降级器：糖化 JSON → 原语 AST（含 `let`/`bind` 写期宏、内联 step/ref 生成 term）；**零内核依赖**，不算内核哈希（callee 引用留 `{ $ref }`，交宿主 A0b 替换） |
| `builder.ts` | 类型化 builder `t.*`：作者用 TS 构造糖化表达式（IDE / 类型 / 单测） |
| `validate.ts` | 静态校验器：形态 / 引用存在 / 引用无环 / `eff` 的 port 与 method 声明 / `let` 复制含 `eff` 的绑定；错误带源指针 |
| `sourcemap.ts` | 源映射：把内核错误里的失败节点路径映射回糖化源指针（零内核依赖） |
| `testkit.ts` | 测试器入口（**可依赖内核**）：编译程序为 defs、驱动效果回灌、调用内核 `evaluate`；`explainError` 定位运行期错误到源 |
| `build.ts` | 打包接入 CLI：`terms.src/*.json` → 校验 → `terms/*.json` |
| `test/` | 降级 / 校验 / testkit 单测 + 内核层实验 |

## 依赖边界（写死，三条单向）

1. `packages/{kernel,host,boot,client}` 任何包**不得依赖**本包（运行时不得依赖工具链）。
2. 插件**仅不入世的构建 / 开发脚本**可 import 本包的编译器（`.worldignore` 排除该脚本）；插件运行期（`execute/` / `src/` / `terms/` / `schema/` / `plugin.json`）与入世内容**不得** import。
3. 本包**至多依赖内核**（仅测试器入口 `testkit.ts`），不进运行路径。

**编译器零内核依赖**是第 2 条成立的前提：插件 devDependency 拉本包时不传递内核。

## 怎么跑

```
cd toolchain
npm ci            # 本包自带 node_modules 与锁文件（仓库无根 workspace）
npm run typecheck
npm test
```

## 用法

判定源写进插件包的 `terms.src/*.json`（糖化），构建时编译到 `terms/*.json`（运行期产物）：

```
node toolchain/build.ts <packageDir>     # 读 terms.src/ → 校验 → 写 terms/；不过则非零退出
```

`.worldignore` 排除 `terms.src/`（源不入世）；`plugin.json.build` 声明该命令（宿主只执行、不解释）。

`spec.md` 另写明两条关键契约：`fold.step` 的实参顺序（`arg(0)=acc` / `arg(1)=item` / `arg(2)=index`）与 `eff` 回灌形状（返回值即效果值、`effects` 按发射顺序回灌），并附一段可运行的 min/max 例子。`testkit.runTermValidated` 先跑校验再求值。

## 组合子 `t.*` 一览

`builder.ts` 的 `t` 是类型化构造器（只产数据）。除逐键构造外，另提供常用判定组合子——它们都降级为现有原语，不新增内核原语。

| 组合子 | 语义 | 备注 |
| --- | --- | --- |
| `t.lit(v)` / `t.ctx(path)` / `t.get(of,path)` / `t.getOr(of,path,fallback)` / `t.arg(i)` | 常量 / 读 ctx / 对值投影 / 安全投影 / 位置实参 | `getOr` 缺失取默认，不抛 `missing_path` |
| `t.if(c,a,b)` / `t.pred(op,a,b)` | 条件（惰性）/ 比较产 `Bool` | `op ∈ lt/le/gt/ge/eq/ne` |
| `t.arith(op,a,b)` / `t.add` / `t.sub` / `t.mul` | 算术（有限数） | `op ∈ add/sub/mul`，不含 `div` |
| `t.list(items)` / `t.obj(fields)` | 构造新列表 / 新对象 | 逐项/逐字段求值，键序规范 |
| `t.let(bindings, body)` / `t.bind(name)` | 写期宏：顺序绑定、按引用复制 | 含 `eff` 且多次引用会重复发射（校验器 `effect_reemitted`） |
| `t.let1(name, value, body)` | **单次求值**绑定：`value` 求值一次作 `arg(0)` 传入 `body` | 复用含 `eff` 的中间结果用它；`body` 里以 `t.bind(name)` 引用 |
| `t.fold(coll, init, step)` / `t.call(ref, args)` | 折叠 / 调用 | `step`/`ref` 可为**路径或内联糖化** |
| `t.eff(port, method, args)` | 发射效果 | `args` 是单个 bag |
| `t.contains(list, value)` / `t.in(value, list)` | 成员判断 | `value` 可为动态表达式（求值一次后随累加器传递） |
| `t.argmin(coll, byPath)` / `t.argmax(coll, byPath)` | 按字段取极值（回元素；空集回 `null`） | |
| `t.find(coll, predicate, projection)` | 首匹配 + 投影（无命中回 `null`） | `predicate`/`projection` 内 `arg(1)` = 元素 |
| `t.findOr(coll, predicate, projection, fallback)` | 首匹配 + 兜底（无命中回 `fallback`） | `find` 结果单次求值 |
| `t.and(a,b)` / `t.or(a,b)` / `t.not(a)` | 布尔组合（惰性，产 `Bool`） | 降级为 `if` |
| `t.bag({k: 字面量})` | 常量对象 bag | 值须为字面 JSON（数据构造原语落地后放开） |

### 配方

```ts
// 成员判断：tool 是否在 allow 列表
t.contains(t.ctx(['allow']), t.ctx(['tool']))
// 或读作 tool ∈ allow
t.in(t.ctx(['tool']), t.ctx(['allow']))

// 极值：按 score 取最优候选（空集 null）
t.argmin(t.ctx(['cands']), ['score'])

// 首匹配 + 投影：第一个 rank>2 的候选的 id（无命中 null）
t.find(t.ctx(['xs']), t.pred('gt', t.get(t.arg(1), ['rank']), t.lit(2)), t.get(t.arg(1), ['id']))
// 首匹配 + 兜底：无命中回默认目标
t.findOr(t.ctx(['rules']), t.pred('eq', t.get(t.arg(1), ['when']), t.ctx(['input'])), t.get(t.arg(1), ['then']), t.ctx(['default']))

// 布尔组合：a && (b || !c)
t.and(t.ctx(['a']), t.or(t.ctx(['b']), t.not(t.ctx(['c']))))

// 双效果编排 + 单次求值：效果结果作 call 实参，callee 内 arg(0) 复用
t.call(
  t.if(t.pred('eq', t.arg(0), t.lit(true)), t.eff('data', 'fetch', t.bag({ id: 7 })), t.lit('denied')),
  [t.eff('auth', 'check', t.bag({ resource: 'document' }))],
)
// 等价、更直白的写法：let1 把效果结果求值一次后绑定给 body（bind('policy') 处复用）
t.let1('policy', t.eff('auth', 'check', t.bag({ resource: 'document' })),
  t.if(t.pred('eq', t.bind('policy'), t.lit(true)), t.eff('data', 'fetch', t.bag({ id: 7 })), t.lit('denied')))

// 内联 step：一条组合子写完整判定，不必拆文件
t.fold(t.ctx(['xs']), t.lit(0), t.if(t.pred('gt', t.arg(1), t.arg(0)), t.arg(1), t.arg(0)))
```

## 程序与测试入口

- `Program`：`{ terms: Record<路径, 糖化>, implements?: string[], pins?: Record<能力类, 身份>, methods?: Record<能力类, string[]> }`。
  `eff.port` 必须在 `implements`、`pins` 键或 `methods` 键里，否则报 `undeclared_port`。`method` 校验分两侧：自调用（`port ∈ implements`，或仅声明了 `methods` 的能力类）必须落在 `methods[port]`，否则报 `undeclared_method`；跨身份（`port` 只在 `pins` 里）方法名属被调身份声明，工具链单包看不到、**不校验**（宿主入世期按被调方声明补上，见 `docs/term-toolchain.md` §六.1）。只声明 `methods` 即可，无需重复填 `implements`。
- `runTerm(program, termPath, fixtures)`：**默认先静态校验**，不过回 `{ ok:false, error:'invalid', issues }`（issues 带源指针）；通过则求值，返回 `{ ok:true, value } | { ok:false, error, at?, def?, callAt? }`。`fixtures = { ctx?, args?, effects?, trace? }`。
- `trace: true` 时结果附 `trace: Array<{port, method, args}>`（按发射顺序），可断言「某效果恰好/未发射」。
- `runTermUnchecked(...)`：显式跳过校验，直接求值。
- `runTermValidated(...)`：`runTerm` 的旧名，等价。
- `isInvalid(r)`：结果是否为「校验不过」。
- `explainError(program, termPath, error)`：据 `at`/`def` 把运行期错误映射回糖化源指针；内联 step 的生成 term 也能映射（`term` 为 `terms/__gen/*`，`pointer` 指向内联糖化）。

最小测试骨架（可复制）：

```ts
import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const program: Program = {
  terms: { 'terms/x.json': t.lit(1) },
  implements: ['picker'],
}

describe('x', () => {
  it('runs', () => {
    expect(runTerm(program, 'terms/x.json')).toEqual({ ok: true, value: 1 })
  })
})
```

## 边界

- 不提供 lambda / 递归 / while（内核设计拒绝，见设计文档 §四 / §九）；算术（不含 `div`）与数据构造（`list`/`obj`/`getOr`）已提供。
- 编译器不进宿主 / 内核；源映射、构建脚本不入 ①。
- 运行期错误定位已实现：内核报告失败节点（`at`/`def`/`callAt`），`sourcemap.ts` + `explainError` 把错误映射回糖化源指针（见设计文档 §6.2）。
