# vector-index（向量索引原语）

向量索引的**纯原语**：③ 二进制索引编解码 / 原子写 / stale GC、L2 归一、点积、最小堆 top-k 部分选择。
持有记录 `{key, chunk_index, vector}`（逻辑 key + 块号 + 向量），落本身份 ③
`CHRONO_PLUGIN_STATE/index.bin`，**可重算、删掉可重建**。本服务是**通用能力**：调用方经反向
`port.call vector-index.upsert` 灌入条目、经 `vector-index.search` 取回逻辑 key。本服务**只回逻辑 key**，
不解析条目哈希（key → 哈希由调用方完成）。自身无反向调用、无写通道、无投影读取、不自取时钟。

- 身份：`vector-index`
- 能力类 / 方法：`vector-index` → `upsert` / `remove` / `search` / `info` / `clear`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`vector-index.json`）
- `pins` / `needs`：无（`"pins": {}`；无宿主 / 跨身份依赖）
- 状态档：`recomputable`（③ 可重算；同输入同输出、不取时间 / 随机）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`vector-index.info`
- 运行时零 npm 依赖（只用 Node 内置模块）

## 方法

| 方法     | 入参                                                      | 返回                                                      | 行为                                                                                       |
| -------- | --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `upsert` | `{model, dim, count, records:[{key,chunk_index,vector}]}` | `{ok, present, model, dim, count, size}`                  | 按 key 覆盖（先删同 key 旧记录再追加，保持插入序）；向量写入时 L2 归一；锚变即重建         |
| `remove` | `{keys:[…]}`                                              | `{ok, removed, size}`                                     | 删除若干 key 的记录                                                                        |
| `search` | `{query_vector, top_k?}`                                  | `{ok, hits:[{key,chunk_index,score}]}`                    | 暴力余弦（L2 归一 ⇒ 点积），最小堆部分选择 O(N·log k)；score 降序、同分按 key / chunk 升序 |
| `info`   | `{}`                                                      | `{ok, present, model?, dim?, count?, size?, records:[…]}` | 当前索引描述（含全部记录）；空索引 `present:false`、`records:[]`                           |
| `clear`  | `{}`                                                      | `{ok}`                                                    | 清空索引（删 ③ 文件，回到空索引）                                                          |

- `count` 是**消费方版本计数**（如世界条目计数）：本服务只存不解释，`info` 原样回。
- `search` 的确定性 tie-break：score 降序 → `key` 升序 → `chunk_index` 升序。
- `key` 在 ③ 记录里为定长 32 字节（超长截断）；消费方键通常是短 id。

## ③ 索引（可重算）

- 位置：`CHRONO_PLUGIN_STATE/index.bin`（宿主起服务时注入本身份 ③ 目录；env 缺失则索引只驻内存）。
- 格式（小端二进制）：`magic "VECIDX01" / version / dim / count / modelId / recordCount / records`；
  每条记录 = `{key(32B) / chunk_index / dim×float32}`。向量已 L2 归一。
- 原子写：先写同目录临时文件再 `rename` 替换，避免读到半截文件；机会式回收同目录过期 `.tmp`。
- 删掉整个 ③ 后服务回到空索引；消费方按自身 ④ 重算并 `upsert` 重建。

## 入参（`args`）

```jsonc
// upsert
{ "model": "granite-97m", "dim": 384, "count": 3,
  "records": [ { "key": "m-1", "chunk_index": 0, "vector": [/* dim 个 float */] } ] }

// remove
{ "keys": ["m-1"] }

// search
{ "query_vector": [/* dim 个 float */], "top_k": 10 }

// info / clear
{}
```

- 形态非法 → 结构化 `bad_args`（含向量长度 ≠ dim）。

## 结果

- `upsert`：`{ok, present:true, model, dim, count, size}`。
- `remove`：`{ok, removed, size}`。
- `search`：`{ok, hits}`；空索引 `hits:[]`。
- `info`：`{ok, present, model, dim, count, size, records}`；空索引 `present:false`、`records:[]`。
- `clear`：`{ok:true}`。

## 边界

- 不做：条目正文 / 元数据 / 逻辑删除 / 条目 → 哈希映射（归调用方）；文本切块与向量化（归 `embedding`）。
- 不读投影、无写通道、不发 eff；不取时间 / 随机，同输入同输出。
- 服务不 import 宿主与内核，运行时零依赖；跨身份只走 `port.call`。

## 运行

```sh
npm test    # 协议级 + 纯函数级测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
