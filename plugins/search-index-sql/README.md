# search-index-sql（本地全文检索索引后端）

`search-index-provider` 扩展槽的缺省后端：Node 内置 `node:sqlite` + **FTS5**，按调用帧 `env.emitter`
分命名空间，数据落宿主注入的 `CHRONO_PLUGIN_DATA`（`index.sqlite`）。

- 身份：`search-index-sql`
- 能力类：`search-index-provider`；方法：`search` / `put` / `stats`
- 状态档：`state: "durable"`（④ 不可重算）——数据跨代存活、进备份
- 引擎：Node 内置 `node:sqlite`（需 Node >= 24），无需原生构建，`plugin.json.build` 显式声明空数组

## 引擎与分词

FTS5 表 `docs`：`title` / `snippet` / `body` 入索引，`owner` / `url` / `source` / `fetched_at` 仅存储。
分词用 **`trigram`**：对英文与 CJK 都支持**子串**命中（中英混排检索可用）。

- 检索按 `bm25` 升序（越低越相关），`url` 升序作确定 tiebreak；MATCH 表达式由查询按非字母数字切词、
  逐词加引号（内部引号翻倍）后用 `OR` 连接——转义后不引入 FTS5 语法注入。
- 写入按 `(owner, url)` 覆盖：先删后插；`fetched_at` 由 SQLite 时钟（`datetime('now')`）盖戳，
  调用方无需取时间。整批单事务，全有或全无。

## 命名空间

命名空间只来自调用帧 `env.emitter`（宿主填写），调用方无从伪造；`args` 里出现
`namespace` / `owner` / `db` / `emitter` / `path` 等键即回 `bad_args`。检索 / 统计都按 owner 过滤，
一份库内多 owner 互不可见。

## 怎么起

`start: "node execute/main.ts"`；宿主 spawn 服务并注入 `CHRONO_PLUGIN_DATA`。
门面 `search-index` 经反向调用把它当作 `search-index-provider` 成员。

## `.worldignore`

排除 `test/` 与 `tools/`。
