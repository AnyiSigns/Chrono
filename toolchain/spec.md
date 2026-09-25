# 糖化 JSON：最小切片

作者写的判定表面形式。一个糖化表达式是一个带 `k` 判别位的 JSON 对象，`lower` 把它机械降级为 14 原语 AST。

| `k` | 形状 | 降级为 |
| --- | --- | --- |
| `lit` | `{ k:'lit', v:Json }` | `["c", v]` |
| `ctx` | `{ k:'ctx', path:(string\|number)[] }` | `["g", path]` |
| `get` | `{ k:'get', of:Sugar, path:(string\|number)[] }` | `["get", of, path]`（对任意值投影） |
| `getOr` | `{ k:'getOr', of:Sugar, path:(string\|number)[], fallback:Sugar }` | `["getOr", of, path, fallback]`（缺失取 fallback） |
| `arg` | `{ k:'arg', i:int≥0 }` | `["v", i]` |
| `bind` | `{ k:'bind', name:string }` | 写期替换为 `let` 绑定的值（未绑定 → `bad_sugar`） |
| `let` | `{ k:'let', bindings:[[name,Sugar],…], in:Sugar }` | 写期宏：顺序绑定（后者可见前者），展开为 `in` 的降级产物，不产生原语 |
| `if` | `{ k:'if', cond, then, else }` | `["if", cond, then, else]` |
| `pred` | `{ k:'pred', op:'lt'\|'le'\|'gt'\|'ge'\|'eq'\|'ne', a, b }` | `["pred", op, a, b]` |
| `arith` | `{ k:'arith', op:'add'\|'sub'\|'mul', a, b }` | `["arith", op, a, b]`（有限数；非有限结果报 `bad_arith`） |
| `list` | `{ k:'list', items:Sugar[] }` | `["list", [items…]]` |
| `obj` | `{ k:'obj', fields:{k:Sugar} }` | `["obj", {k: terms…}]`（键序规范） |
| `fold` | `{ k:'fold', coll, init, step:string\|Sugar }` | `["fold", coll, init, ["c", { $ref: step }]]` |
| `call` | `{ k:'call', ref:string\|Sugar, args:Sugar[] }` | `["call", ["c", { $ref: ref }], [args…]]` |
| `eff` | `{ k:'eff', port:string, method:string, args }` | `["eff", port, method, args]` |

## fold step 与效果回灌

- `fold` 的 `step` 是一个**同包 term 路径**；运行时 step 收到三个实参，**位置固定**：`arg(0)` = 累加器 `acc`，`arg(1)` = 当前元素 `item`，`arg(2)` = 下标 `index`。累加器初值 = `init`。
- `eff` 的**返回值就是效果值本身**（不是 `{impl,port,method,args,pid}` 包装）。`testkit.runTerm` 的 `effects` 是数组，按 `eff` 发射顺序逐个回灌；不足报 `missing_effect`。
- `eff.args` 是**单个** `Sugar`（一个 bag），`call.args` 是 `Sugar[]`（位置实参表）——两者形状不同。

## 写期宏与偏值语义（易踩）

- **`let` / `bind` 是写期宏**：绑定被引用 N 次，就把降级产物**复制 N 份**。若绑定里含 `eff` 且被引用 >1 次，效果会**重复发射**（校验器报 `effect_reemitted`）。要让带效果的中间结果只发一次：用 `call` 把效果结果作实参传给 callee（callee 内用 `arg(0)` 复用），或 `let` 只绑定纯值。
- **偏值语义**：`get` 在缺失路径 / 穿过标量 / 越界下标时**抛 `missing_path`，不返回 `null`**；`if` 惰性、只求一支，故 `if acc==null then <取 item> else get(acc,...)` 是安全的。

## 例子：从效果结果里选 score 最小 / 最大的候选

```ts
// step：acc 为 null 取 item；否则按 op 取更优者（let/bind 复用取 score）
const step = (op: 'lt' | 'gt') =>
  t.let(
    [
      ['s1', t.get(t.arg(1), ['score'])],
      ['s0', t.get(t.arg(0), ['score'])],
    ],
    t.if(
      t.pred('eq', t.arg(0), t.lit(null)),
      t.arg(1),
      t.if(t.pred(op, t.bind('s1'), t.bind('s0')), t.arg(1), t.arg(0)),
    ),
  )

// 入口：对 picker.candidates 的效果结果 fold；空列表返回 init = null
const entry = t.fold(t.eff('picker', 'candidates', t.lit([])), t.lit(null), 'terms/pick.step.json')
```

`runTerm(program, 'terms/pick.json', { effects: [[{ id: 'a', score: 5 }, { id: 'b', score: 2 }]] })` → 选 `{ id: 'b', score: 2 }`。

## 引用与 `$ref`

`fold.step` / `call.ref` 是**包内相对路径**（如 `terms/pick.step.json`），降级时包成 `["c", { "$ref": path }]`。
宿主入世（A0b）把 `{ "$ref": path }` 机械替换成 callee def 哈希，得 `["c", <hash>]`——机器按 `env.defs[hash]` 直查。

## 内联 step / ref（生成 term）

`fold.step` 与 `call.ref` 也可写**内联糖化表达式**，不必先拆成独立 term 文件：

```ts
// 一条组合子写完整判定：无需 terms/step.json
t.fold(t.ctx(['xs']), t.lit(0), t.if(t.pred('gt', t.arg(1), t.arg(0)), t.arg(1), t.arg(0)))

// 内联 callee：按位置收 args
t.call(t.if(t.pred('gt', t.arg(0), t.lit(10)), t.lit('big'), t.lit('small')), [t.ctx(['n'])])
```

- `lowerProgram(source)` 把内联 step/ref 收进「生成 term 表」，函数侧仍写 `{ $ref: 生成路径 }`；`build.ts` 落成 `terms/__gen/*.json`，`testkit.compileProgram` 一并注册。
- 生成路径由**降级后 AST 内容**稳定派生（`terms/__gen/<内容哈希>.json`），同源两次编译逐字节一致；同内容的内联 step 复用同一生成 term。
- `terms/__gen/` 是保留命名空间，源 term 不得占用（校验器报 `reserved_path`）。
- 内联糖化在**定义点的写期绑定环境**里降级，故可引用外层 `let`/`bind`；这也意味着 `arg(i)` 指生成 term 自己的位置实参（`fold` step 内 `arg(0)=acc` / `arg(1)=item` / `arg(2)=index`）。
- `lower(s)` 单表达式入口不含内联落点，遇内联 step/ref 报 `bad_sugar`；需要内联时用 `lowerProgram`（或给 `lower` 传 `LowerCtx`）。

## 边界

- **编译器零内核依赖**：不算内核哈希、不 import 内核；`$ref` 留给宿主替换。生成路径名用内容派生的稳定短哈希（非内核哈希），只为取名与去重。
- **算术与数据构造已提供**：`arith`（add/sub/mul；不含 div）、`list`、`obj`、`getOr`。仍**不提供** lambda / 递归 / while（内核设计拒绝，见 `docs/term-toolchain.md`）。
- 非法糖化 fail-closed：未知 `k` / 形态不合 / 越界算子抛 `Error('bad_sugar')`。
- 确定性：同源两次 `lower` / `lowerProgram` 逐字节一致。
