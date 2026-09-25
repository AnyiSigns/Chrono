# storage-kv（第一方文件 / 文档型存储服务）

按调用帧 `env.emitter` 分目录的追加日志 KV：为低频、不在意延迟的 owner 提供键值读写。
本包是**普通插件**（无特权、可替换、可卸载），插件间只经能力调用（`eff` → 宿主路由 → stdio 帧）。

- 身份：`storage-kv`
- 能力类：`storage-kv`
- 状态档：`state: "durable"`（④ 不可重算）——数据落宿主注入的 `CHRONO_PLUGIN_DATA`，跨代存活、进备份
- 引擎：纯 Node 文件 IO（追加日志 + 目录），**零原生依赖**，与 `storage-sql` 分包，
  不让只要文件读写的场景背上原生构建

## 提供哪些方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `get` | `{ key }` | `{ found, value }` |
| `put` | `{ key, value }` | `{ ok, seq }` |
| `delete` | `{ key }` | `{ deleted }` |
| `list` | `{ prefix? }` | `{ entries: [{ key, value }] }`，按键升序 |
| `batch` | `{ ops: [{ op: 'put' | 'del', key, value? }] }` | `{ ok, count }`，单次追加 + fsync |
| `info` | `{}` | `{ schemaVersion, entries }` |
| `dropNamespace` | `{}` | `{ dropped }`，丢弃本 owner 命名空间 |

键为 1..512 字符的字符串；值为任意 JSON。单值上限 `256 KiB`。

## 命名空间（分目录）与清理

- **按 `env.emitter` 分目录**：一个 owner 一个子目录 `<CHRONO_PLUGIN_DATA>/<emitter>/`，坏一份不连坐。
  命名空间只来自宿主填写的调用帧字段，调用方无从伪造。
- **拒绝自报命名空间**：`args` 里出现 `namespace` / `ns` / `owner` / `emitter` / `database` / `db` / `path`
  任一键即回 `bad_args`，不静默忽略。
- **`dropNamespace` 是清理入口**：关闭本 owner 的日志句柄并删除其子目录。
  **清理责任方是被委托方（本服务）**：owner 退役时宿主只删得到 owner 自己的 ④ 目录，
  删不到本服务库里属于它的那份；须由调用方在 owner 退役流程中调用 `dropNamespace`，
  宿主不代劳、不认识命名空间语义。漏调用即静默漏数据。

## 存储布局、事务与迁移

- 布局：`<CHRONO_PLUGIN_DATA>/<emitter>/log.jsonl`（每行一条 `put` / `del` 记录）
  与 `<emitter>/meta.json`（格式版本）。
- **事务**：`batch` 把多条记录拼成一次追加写入并 `fsync`，随后一次性更新内存索引；失败即整批不生效。
- **崩溃安全**：启动重放时截掉文件末尾撕裂的半条记录（无换行结尾）；完整行解析失败则 `log_corrupt`
  fail-closed，不静默丢数据。
- **启动迁移由本服务自做**（宿主不代劳）：以 `meta.json` 的 `version` 记进度，迁移步骤幂等，
  新世代启动时自动补齐。

## 大字节与密钥

- **大字节不入帧**：单值上限 `256 KiB`，超过即 `payload_too_large`。
  二进制先由调用方经 `host.asset.put` 落 `state/assets/`，把 `{ kind: 'asset', sha256, mime, size }`
  引用存进本服务；读取时凭引用走 `host.asset.get`。
- **密钥不进明文**：只存引用（如 `{ kind: 'env' | 'local', name }`），本体走宿主密钥面。

## 怎么起

`start: "node execute/main.ts"`；宿主 spawn 服务并注入 `CHRONO_PLUGIN_DATA`。
调用方在 `pins` 里写 `storage-kv`，用 `eff` 调能力类 `storage-kv` 的方法。

## 状态档与换代

`state: "durable"`，并声明 `exclusive: ["data"]`——追加日志 + 内存索引要求**单写者**：
新旧实例并存会各自持一份索引并交错追加，导致读到陈旧值甚至记录撕裂。故换代走
「先准备 → drain 旧 → 再起新 → 切端点」的独占序（该身份短暂空窗）。

## `.worldignore`

排除 `test/` 与 `tools/`；本包无构建产物（零原生依赖）。
