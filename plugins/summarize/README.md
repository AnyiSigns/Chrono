# summarize（结构化摘要原语）

结构化摘要（L1 / L2 共用形状）与确定性派生原语（纯函数、同输入同输出、不取时间 / 随机）：
`derive`（结构化字段优先 / 切片派生）/ `parse` / `current`（解析 + 码点截断）/ `sentences`（切片派生句子）/
`merge`（按去重结果拼接）/ `to_l1` / `to_l2`。被上层压缩门面 `compress` 经反向 `port.call` 消费；
自身无反向调用、不读投影、不写世界。

- 身份：`summarize`
- 能力类 / 方法：`summarize` → `derive` / `parse` / `current` / `sentences` / `merge` / `to_l1` / `to_l2`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`summarize.json`）
- `pins`：无（`"pins": {}`；无宿主 / 跨身份依赖）
- 状态档：`recomputable`（无本地持久状态）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`summarize.derive`
- 运行时零 npm 依赖

## 方法

| 方法        | 入参                                    | 返回               | 行为                                                                                                      |
| ----------- | --------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `derive`    | `{args, target_length, extract_items}`  | `{summary}`        | 优先 `args.summary`（解析 + 截断）；否则结构化字段优先、缺失 `goal` / `facts` 由 `session_slice` 按句派生 |
| `parse`     | `{record}`                              | `{summary}`        | 从摘要记录解析（缺失 / 非字符串项忽略），不截断                                                           |
| `current`   | `{record, target_length}`               | `{summary}`        | 解析后按 **Unicode 码点**统一截断全字段（goal + 各列表项）                                                |
| `sentences` | `{session_slice, limit, target_length}` | `{sentences}`      | 逐条 `content` 按句切分、规范化去重、码点截断，取前 `limit` 条                                            |
| `merge`     | `{existing, incoming, outcomes}`        | `{summary, dedup}` | `goal` 新值优先；各列表 = 既有列表 + `outcomes[字段].accepted`；任一字段走向量即 `dedup:"vector"`         |
| `to_l1`     | `{summary}`                             | `{record}`         | L1 写出形状（六个字段）                                                                                   |
| `to_l2`     | `{summary}`                             | `{record}`         | L2 写出形状（无 `next_steps`）                                                                            |

- `outcomes` 由消费方 `compress` 经 `dedup` 提供方逐字段算得后传入：提供方自身**不**持去重后端（`pins: {}`、无 `needs`）。
- `target_length` 为 **Unicode 码点**上限：CJK 每字算 1，不劈代理对。
- 纯函数：不取时间 / 随机，同输入同输出。

## 入参（`args`）

```jsonc
// derive
{ "args": { "goal": "G", "facts": ["f1", "f2"], "session_slice": [{ "role": "user", "content": "…" }] },
  "target_length": 280, "extract_items": 3 }

// current
{ "record": { "goal": "G", "facts": ["f1"] }, "target_length": 280 }

// merge
{ "existing": { "goal": "old", "facts": ["a"] },
  "incoming": { "goal": "new", "facts": ["b"] },
  "outcomes": { "facts": { "accepted": ["b"], "dedup": "text" } } }
```

- 缺必填字段 / `target_length` 或 `extract_items` / `limit` 非正整数 → 结构化 `bad_args`（不跑方法）。

## 结果

- 成功：`{summary}` / `{record}` / `{summary, dedup}` / `{sentences}`。
- 失败：结构化 `bad_args`。

## 边界

- 不做：去重向量计算（归消费方经 `dedup` 提供方）/ 语义摘要（归 `semantic` 提供方）/ L1 / L2 读写（归 `short-memory`）。
- 不写世界、不读投影、无命令面。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test    # 协议级 + 纯函数级测试（node --test）
```

## `.worldignore`

声明 `test/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
