# plugin-admin（agent 的插件管理面）

agent 改系统自身的**唯一**路径：列插件 / 读源码 / 校验 / 写新源码。**写只产计划、不直接写**，
审批闸在执行前拦（`plugin.write` 判高危）。本插件不认识业务语义——机械校验归宿主，它只转发与产计划。

- 能力类：`plugin`（`list` / `read` / `validate` / `write`）+ `plugin-admin`（`describe` / `invoke`）。
- `pins`：`{"host":"host"}` —— 指向**保留身份 `host`**（宿主自身能力类），不是插件间依赖。
- 数据源：`plugin.list` 走 `host.identities {}`；`plugin.read` 走 `host.source.read {identity,path}`；
  `plugin.validate` 走 `host.validate_package {files}`；`plugin.write` 的源码字节走 `host.blob.put {bytes}`。
  都是反向调用（`port.call`）。
- 状态档：`recomputable`（③ 可重算；validate 凭据住 ③，不进世界）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 可见性黑名单（钉在包内常量）

对 agent 隐藏 **`sandbox`** 与 **自身 `plugin-admin`**。黑名单是 `execute/visibility.ts` 的**包内常量**
（随代码入世）——改它 = 代码换代 = 走人闸；**不放进 `schema`（世界数据）**，否则别的写路径产出
`add_gen(plugin-admin, 新数据世代)` 就能绕过（世界数据等于没锁）。

- `plugin.list` 过滤后返回；`plugin.read` / `plugin.validate` / `plugin.write` 命中黑名单**先拒**
  （`hidden_identity`），**不调宿主**。
- 与「受保护 `pins` 身份表」是两回事：后者（`sandbox` / `guard` / `secrets` / `approval`）钉在**宿主侧**
  入世校验，删除引用即整批拒 `protected_pin_removed`，连代码换代也改不动。

## `plugin.validate` → `plugin.write` 强制顺序

`write` 必须携带上一次 `validate` 的凭据，否则拒 `validate_required`。凭据不依赖模型跨调用带回 64-hex：
`validate` 把宿主返回的 `result_hash` 写进 **宿主 ③ 目录**（`CHRONO_PLUGIN_STATE`），键 = 候选树规范化哈希；
`write` 用同一口径重算键去查。

### 候选树规范化哈希（缓存键口径）

```text
key = H({ "<包内相对路径>": "<解码后字节的规范 base64>", ... })   # 路径按 Unicode 码点升序
```

- `H` = `sha256(utf8(canonicalJson(v)))`，与内核 `H` 同口径（对象键升序、剔 `undefined`、`-0 → 0`）。
- 入参的三种形态（裸字符串 / `{text}` / `{base64}`）解码到同一字节即得同一键。
- 候选树一变键就变 ⇒ 旧凭据自然失效。`write` 另把**自己算出的 commit 哈希**与凭据里的 `result_hash`
  机械比对（防口径漂移），不符 → 清凭据并拒 `validate_required`。

## `plugin.write` 的写计划形状

批内 `{"$n":k}` 只指向更早的 `put`（内核批处理替换，规矩 A）。顺序与宿主入世（`planPack`）同构：

```text
put(blob) × n            # 文件，指针形态 {body:{kind:"blob",sha256,size}}（与宿主入世同口径）
put(tree)                # 自底向上，entries 按名字升序；目录 tree 在子项之后
put(commit)              # {body:{tree, meta:{name,version}}}
put(schema)              # plugin.json.schema 指向的文件；schema 省略时用宿主同源默认体 {"type":"object"}
add_identity?            # 身份不存在时才有，schema 用 {"$n":k} 指 put(schema)
add_gen                 # {id, payload:{"$n":commitIndex}, sig:同, pins}
```

- 候选 `plugin.json` 的 `schema` **可省略**（零 schema，无世界数据的 UI 插件用）：此时不读 schema 文件，
  机械用与宿主同源的默认体 `{"type":"object"}` 作 `put(schema)`，`result_hash` 仍与宿主 `validate_package` 一致。

- `pins` 由候选 `plugin.json.pins` 解析：`host` 保留字面量，其余解析到被依赖身份的 active 世代哈希
  （经 `host.identities`；缺失 / 未激活 → `unresolved_pin`）。
- 批内顺序与宿主入世（`planPack`）逐字同构：blob / tree 先，随后 commit、schema、`add_identity?`、`add_gen`。
  `add_identity` 必须在 `put(schema)` 之后（占位符只能指向更早的 `put`，规矩 A），故「先 `add_identity`」
  是概念次序、不是批内字面次序。
- **blob 指针 + 字节落 CAS**：写计划的 blob 是**指针 def**（① 只存 `{kind:"blob",sha256,size}`），
  字节本体经 `host.blob.put {bytes(base64)}` 先内容寻址落 ④ `state/blobs/`（幂等，按 sha256 去重）；
  落盘失败即拒，避免指针悬空导致物化 `blob_missing`。
- 若调用方把上次 `validate` 的 `result_hash` 随 bag 带回，则与 ③ 凭据机械比对，不符同样拒 `validate_required`。
- 产出 `{$directives:[{kind:"write",request:{op:"batch",args:{ops}}},{kind:"extern",payload}]}`；
  **本插件不落账、不入队、不等审批**。

## 运行记录判定（本批不迁移）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。

| 数据 | 判定 | 理由 |
| --- | --- | --- |
| `plugin.write` 的写计划（blob / tree / commit / schema / `add_identity` / `add_gen`） | **定义（留世界）** | 插件源码世代即定义本体；回滚要带上、装配 / 重放要从世界读它 |
| `plugin.validate` 的 `result_hash` 凭据 | **可重算缓存（留 ③）** | 已住 `CHRONO_PLUGIN_STATE`，不进世界；删了可重算 |
| 可见性黑名单（`sandbox` / `plugin-admin`） | **代码常量（留包内）** | 随代码入世；放世界数据等于可被其它写路径 `add_gen` 绕过 |

**结论**：本插件**无运行记录出世界**——它没有界面偏好，`plugin.write` 是定义平面写方（正确留世界），
黑名单是代码而非世界数据。故本批不改 `methods.ts` / `visibility.ts` 的写路径，只补本判定表。

## 工具面（`plugin-admin.describe`）

四个工具（全局唯一名）各带**描述四要素**（`intent` / `when_to_use` / `param_semantics` / `boundaries`）
与工具卡 `render` 描述符；`plugin-admin.invoke {tool, args}` 按工具名派发，业务失败回
`{ok:false,error:{code,message}}`。

| 工具 | `form` | `label` | `summary` | `tone` | `detail.kind` | `idempotent` |
| --- | --- | --- | --- | --- | --- | --- |
| `plugin.list` | `card` | `plugin` | `list` | `solid` | `list` | true |
| `plugin.read` | `card` | `plugin` | `read  {identity}` | `solid` | `code` | true |
| `plugin.validate` | `card` | `plugin` | `validate  {identity}` | `solid` | `json` | true |
| `plugin.write` | `card` | `plugin` | `write  {identity}` | `solid` | `diff` | false |

## 结构化错误码

`hidden_identity`（黑名单读 / 写 / 校验）、`validate_required`（缺凭据 / 哈希不符）、
`identity_mismatch`（身份名与候选 `plugin.json.identity` 不符）、`unresolved_pin`（引脚解析不到）、
`unknown_tool`（invoke 未知工具）、`bad_candidate`（候选包缺件 / 坏 JSON / 不安全路径）、
`source_too_large` / `too_many_files`（大小门禁）；宿主错误（`not_found` / `bad_directive` 等）原样透传。

## schema

`schema/plugin-admin.json` 只声明**非安全参数**（`max_source_bytes` / `max_files`）。可见性黑名单与
受保护 `pins` 身份表刻意不在此处（见上）。

## 已知限制

- **`plugin.write` 只产 execute 源码 def，不产 term def**：写计划覆盖 `execute/` / `schema/` / `plugin.json` /
  `package.json` 等源码，但**不含 `terms/` 的 term def**（入世时 term 需解析成带 `sig` 的 def 并替换 `$ref`，
  与源码 blob 不同路）。因此带 `terms/` 的插件经本工具写入后，其 term 入口命令不可用（源码在、def 不在）。
  这是**下一波硬前置**：`plugin.write` 补齐 term def 产出前，不要用它改带 `terms/` 的插件。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（pack/seed → start → loaded → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` /
`execute/`）随源码入世。
