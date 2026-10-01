# search-index（本地检索索引门面）

本地检索索引的**门面**插件：对外提供能力类 `search-index`，对内拥有扩展槽 `search-index-provider`（`many`）。
门面自身不落盘、不取时间、不读投影；检索 / 写入 / 规模都委派给后端索引提供者成员并合并结果。
加 / 减一个索引后端 = 世界成员表变化，本插件代码零改动（不枚举后端）。

- 身份：`search-index`
- 能力类：`search-index`；方法：`search` / `put` / `stats`
- 扩展槽：`search-index-provider`（`methods: ["search", "put", "stats"]`，`mode: many`）
- 状态档：`state: "recomputable"`——门面不持有数据，数据由各后端成员各自持有

## 方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `search` | `{ query, limit? }`（`limit` 缺省 10、上限 100） | `{ results: [{url,title,snippet,source,rank}] }` |
| `put` | `{ documents: [{url,title?,snippet?,source?,body?}] }` | `{ stored }` |
| `stats` | `{}` | `{ providers: [{provider,docs}], docs }` |

- `search`：逐后端检索，按 URL 去重（同 URL 取名次更优者），按（名次升序、URL 升序）定序，确定可回放。
- `put`：逐后端写入；`stored` 取各后端回报的最大值。
- 后端失败按成员隔离跳过，不整体失败；全失败回空结果。

## 怎么接后端

后端插件 `implements: ["search-index-provider"]`，实现 `search` / `put` / `stats` 三个方法；
宿主按世界能力索引把它注入本插件的 `many` 成员表。缺省后端见 `plugins/search-index-sql`（SQLite + FTS5）。

## 消费者

能力消费者（如 `tool-http`）在 `needs` 里写 `"search-index": { "mode": "many" }`，
经反向调用 `search-index.search / put` 做本地索引的读取与写回；无成员时静默降级。

## `.worldignore`

排除 `test/` 与 `tools/`。
