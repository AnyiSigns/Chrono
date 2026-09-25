# 工具链易用性：实施计划

> **状态：已完成**（worktree，未合并）。内联 step/ref、命名模式、布尔糖、`let1`、效果轨迹、`t.*` 一览与配方均落地；工具链 91 用例全绿；第三方作者复测 picker/guard/routing/fallback/orchestrate/scoring 六场景均 ≥8。

> 口径来源：`docs/term-toolchain.md`（工具链设计）、`docs/kernel.md`（内核）。
> 本文件属 `docs/plans/`，只写「怎么做」；冲突以设计文档为准。
> 来源：多轮「无记忆子代理当第三方作者」实测（picker / guard / routing / fallback / orchestrate 五个场景）汇总。

---

## 一、实测共性问题（按频次）

| 问题 | 出现场景 | 现状 |
| --- | --- | --- |
| 缺组合子：成员判断 / 首匹配 / 极值 | fallback、routing、guard | 每个作者手搓 `fold`+`pred`+`null` 哨兵，各自发明编码 |
| 缺布尔组合 `and`/`or`/`not` | 全部 | 只能嵌套 `if` |
| `fold.step` 只能具名路径，无内联/闭包 | 全部 | 一条一次性 fold 也被迫拆成多个 term 文件；step 目标写死 |
| `let`/`bind` 是写期复制宏 | fallback、guard | 复用效果值会重复发射；须改 `call` 蹦床，认知负担高 |
| 运行期错误不可定位 | 全部 | 只有错误码，无 AST/源指针 |
| `eff.args` 是单值、无类型 bag | orchestrate、picker | 手搓裸 JSON / `t.lit([])` 占位 |
| `runTerm` 不校验 | routing、guard | 写错 port/method 不在测试里报 |
| 缺配方/示例 | 全部 | 文档讲清了原语，没讲常用组合怎么写 |

## 二、目标（本项目）

让「选择 / 投影 / 成员 / 首匹配 / 极值 / 条件编排」类判定，作者能像写普通代码一样直接表达，不再各自发明哨兵编码。

## 三、做法

### 3.1 内联 step（前置，解锁其余）
- 允许 `fold`/`call` 的 step/ref 写**内联糖化表达式**（lambda 风味）。
- `lower` 零内核依赖：把内联 step 收集进「生成 term 表」，函数侧写 `{ $ref: "<生成路径>" }`；`build.ts` 落成 `terms/*.json`；`testkit.compileProgram` 注册进 `terms`。
- 确定性：生成路径由内容/序号稳定派生，同源同产物。
- 契约写进 `spec.md`。

### 3.2 命名模式（基于内联 step）
- `t.contains(list, value)` / `t.in(value, list)`：成员判断。
- `t.argmin(coll, byPath)` / `t.argmax(coll, byPath)`：按字段取极值。
- `t.find(coll, predicateInline, projectionInline)`：首匹配（短路语义）。
- 每个都降级为现有 10 原语，不新增内核原语。

### 3.3 布尔糖
- `t.and(a,b)` → `if a then b else false`；`t.or(a,b)` → `if a then true else b`；`t.not(a)` → `if a then false else true`。惰性、产 `Bool`。

### 3.4 真单次求值绑定
- 提供 `t.let1`（或 `t.bind1`）：绑定**求值一次**、按位置实参传进 callee（`call` 蹦床），避免写期复制宏对含 `eff` 的绑定重复发射。
- 保留现有 `let`/`bind`（写期宏）并保留校验器 `effect_reemitted` 告警。

### 3.5 类型化 bag
- `t.bag({ key: <字面量或纯糖> })` → 常量对象；值非纯时报错（无数据构造前）。

### 3.6 测试入口默认校验
- `runTerm` 默认先 `validateProgram`，不过回 `{ ok:false, error:'invalid', issues }`；保留 `runTermUnchecked` 供显式跳过。
- 新增效果 trace：`runTerm` 结果附「已消费效果数/顺序」，便于断言「某效果未发射」。

### 3.7 文档
- `spec.md` 补内联 step 契约；`README.md` 补配方（成员判断、首匹配、极值、双效果编排）与完整 `t.*` 一览。

## 四、依赖与边界

- 不新增内核原语；一切用现有 10 原语表达。
- 运行期错误定位依赖内核项目（见 `docs/plans/kernel-expression-and-errors.md`）；本项目先做静态校验定位。
- 既有工具链测试必须保持全绿；每步 `vitest run` + `tsc --noEmit`。

## 五、验收

- 五类场景（成员/首匹配/极值/条件编排/布尔组合）各自能用一行组合子表达，不再手搓哨兵。
- 同源两次编译逐字节一致。
- 第三方作者复测：路由表 / 降级链场景的体验分不低于 8。
