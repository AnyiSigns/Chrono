## 职责（M1–M4）

| 机制               | 文件                                                          | 导出                                                                                                              |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| M1 值层            | `value.ts` / `hash.ts` / `hash.utf8.ts`                       | `t` `TYPE_ORDER` `canonicalJson` `deepEq` · `H` `sha256` `utf8`                                                   |
| M3 日志            | `journal.ts`（+ 点分段 `journal.apply.ts` / `journal.id.ts`） | `EMPTY_WORLD` `EMPTY_HEAD` `cloneWorld` `pos` `worldRev` `applyEntry` `entryHash` `anchorAfter` `replay` `verify` |
| M4 写口            | `commit.ts`（+ 点分段 `commit.form.ts`）                      | `commit`（唯一写口） `validate` `entryOf` `stale`                                                                 |
| M2 归约机          | `machine.ts`                                                  | `eval`（导出名，实现名 `evaluation`） `cmp`                                                                       |
| 编排               | `run.ts`                                                      | `run` `observationsOf`                                                                                            |
| 共用类型与错误形态 | `types.ts`                                                    | §7 全部类型 + `KernelError`（§5.3 D4）                                                                            |

依赖方向（§6 的 DAG，点分段是同一格内的拆分、不引入新边）：
`value ← types`；`hash.utf8 ← types`；`hash ← types, value, hash.utf8`；
`journal.id ← types, hash`；`journal.apply ← types, hash, journal.id`；
`journal ← types, journal.apply, journal.id`（转口 + 常量 / cloneWorld / pos / anchor / replay / verify）；
`commit.form ← types`；`commit ← types, journal, commit.form`；`machine ← types, value, hash`；
`run ← 全部`（唯一调 commit 之处）；`index ← run 与公共面`。

## 用法（宿主最小闭环）

```ts
import { EMPTY_HEAD, EMPTY_WORLD, run } from './index.ts'

const out = run({
  world: EMPTY_WORLD,
  head: EMPTY_HEAD,
  run: 'r-1',
  now: 1700000000000,
  directives: [{ kind: 'extern', payload: { hello: 'world' } }],
  results: {},
  limits: { gas: 10_000, depth: 32 },
  caps: {},
})
// 落盘是宿主的事；'waiting' 时执行 pending、把结果放进 results，用
// 同一 run_id、同一份完整 directives、同一 now 重调（§13.1 续跑契约）。
```

## 不变式速查（详见 kernel.md §14，验证由评审 agent 承担）

- 纯函数、零内部时间/随机/IO/第三方 import（运行时文件只 import 本包相对路径）。
- 唯一写口：世界改动只经 `commit → applyEntry`；`applyEntry` 绝不改传入的 `Entry`。
- `waiting` / `refused` 不返回部分世界：整次调用作废，落盘点只认 `done` 的 `head/journal`。
- 幂等命中不追加日志；batch 中途失败逐字节回滚；判决只是机械合法性，正当性在上层。

## 本地检查

```
npm ci            # 锁文件安装（首次：npm approve-scripts esbuild 以启用 vitest 依赖的 postinstall）
npm run typecheck # tsc --noEmit
npm run format:check
npm test          # vitest（测试文件由评审 agent 产出）
```
