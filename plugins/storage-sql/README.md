# storage-sql（第一方关系型存储服务）

按调用帧 `env.emitter` 分库的 SQLite 存储服务：为低频、有查询需求的 owner 提供粗粒度数据操作。
本包是**普通插件**（无特权、可替换、可卸载），插件间只经能力调用（`eff` → 宿主路由 → stdio 帧），
故定位是**粗粒度数据操作**的默认家，不是逐 token 写的热路径。

- 身份：`storage-sql`
- 能力类：`storage-sql`
- 状态档：`state: "durable"`（④ 不可重算）——数据落宿主注入的 `CHRONO_PLUGIN_DATA`，跨代存活、进备份
- 引擎：Node 内置 `node:sqlite`（需 Node >= 24），无需原生构建，`plugin.json.build` 显式声明空数组

## 提供哪些方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `createTable` | `{ name, columns: [{ name, type, primaryKey?, notNull?, unique?, default? }] }` | `{ table }`，`IF NOT EXISTS` 幂等 |
| `query` | `{ sql, params? }`，`sql` 限 `SELECT` / `WITH` | `{ rows }` |
| `write` | `{ sql, params? }` | `{ changes, lastInsertRowid }` |
| `batch` | `{ statements: [{ sql, params? }] }` | `{ count, results }`，单事务全有或全无 |
| `listTables` | `{}` | `{ tables }`（不含内部表） |
| `info` | `{}` | `{ schemaVersion, tables }` |
| `dropNamespace` | `{}` | `{ dropped }`，丢弃本 owner 命名空间 |

`type` 限 `TEXT` / `INTEGER` / `REAL` / `BLOB` / `NUMERIC` / `BOOLEAN` / `DATETIME`；
表名 / 列名必须是安全标识符（`^[A-Za-z_][A-Za-z0-9_]*$`），不接受拼接注入。

## 命名空间（分库）与清理

- **按 `env.emitter` 分库**：一个 owner 一份库 `<CHRONO_PLUGIN_DATA>/<emitter>.sqlite`，坏一份不连坐。
  命名空间只来自宿主填写的调用帧字段，调用方无从伪造。
- **拒绝自报命名空间**：`args` 里出现 `namespace` / `ns` / `owner` / `emitter` / `database` / `db` / `path`
  任一键即回 `bad_args`，不静默忽略。
- **`dropNamespace` 是清理入口**：删光本 owner 的全部表并 `VACUUM`。
  **清理责任方是被委托方（本服务）**：owner 退役时宿主只删得到 owner 自己的 ④ 目录，
  删不到本服务库里属于它的那份；须由调用方在 owner 退役流程中调用 `dropNamespace`，
  宿主不代劳、不认识命名空间语义。漏调用即静默漏数据。

## 存储布局与迁移

- 库文件：`<CHRONO_PLUGIN_DATA>/<emitter>.sqlite`，另附 SQLite 自身的 `-wal` / `-shm`。
- **启动迁移由本服务自做**（宿主不代劳）：以 `PRAGMA user_version` 记进度，迁移步骤幂等；
  新世代启动时自动补齐，不覆盖既有数据。
- 内部表 `_chrono_meta` 仅供引擎自用，不出现在 `listTables` 结果里。

## 大字节与密钥

- **大字节不入帧**：单次调用载荷上限 `256 KiB`，超过即 `payload_too_large`。
  二进制先由调用方经 `host.asset.put` 落 `state/assets/`，把 `{ kind: 'asset', sha256, mime, size }`
  引用存进本服务；读取时凭引用走 `host.asset.get`。
- BLOB 列不支持（`blob_not_allowed`），同理改存资产引用。
- **密钥不进明文**：只存引用（如 `{ kind: 'env' | 'local', name }`），本体走宿主密钥面。

## 怎么起

`start: "node execute/main.ts"`；宿主 spawn 服务并注入 `CHRONO_PLUGIN_DATA`。
调用方在 `pins` 里写 `storage-sql`，用 `eff` 调能力类 `storage-sql` 的方法。

## 状态档与换代

`state: "durable"`。`exclusive` 为空数组——SQLite 的 WAL + `busy_timeout` 允许新旧实例并存打开同一份库，
故走零空窗的缺省换代序（先起新 → 切端点 → drain 旧），不声明 `data` 独占。

## `.worldignore`

排除 `test/` 与 `tools/`；本包无构建产物（`node:sqlite` 为 Node 内置）。
