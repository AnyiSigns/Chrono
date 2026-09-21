# secrets（唯一密钥面）

密钥的**唯一解析面**：把世界数据里的引用 `auth_ref` 解析成**解析结果**（明文，仅存调用方进程内存），
并回本地存储清单。密钥本体住宿主侧用户本地文件或本服务进程环境，**不进世界、不进审计、不进 config 导出**。

- 能力类：`secrets`；方法：`resolve` / `list`。
- 命令：无（密钥写入走宿主入站面 `secrets.put` / `secrets.delete`，宿主直写本地文件，不经本服务）。
- `pins`：无；`+`（投影读）：无（`auth_ref` 由上游入口 term 从世界读出后随 args 传入）。
- 状态档：`recomputable`（无不可重算状态；服务不缓存、不落盘）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## 方法 args 契约

### `resolve`

| 字段 | 类型 / 可空性 | 说明 |
| --- | --- | --- |
| `auth_ref` | object，必填 | `{ kind, name }` |
| `auth_ref.kind` | `"local"` / `"env"`，可缺 | 缺省 `local`：读宿主侧用户本地文件；`env`：读本服务进程环境 |
| `auth_ref.name` | string，必填 | 引用名（如 `DEEPSEEK_API_KEY`）；非空、≤256、不含 NUL、非原型污染保留键 |

- 返回：**解析结果**（明文值，`result.value` 是字符串本身）。明文只进调用方进程内存；
  `EffectAudit` 的脱敏归宿主（对 `port=secrets` + `method=resolve` 替换为 `{name,kind,has}`）。
- 失败（协议 `error` 帧，结构化、不崩进程、不泄漏值 / 文件内容）：
  - `secret_missing`：引用名在取值面不存在。
  - `secret_unreadable`：本地文件不可读 / JSON 非法 / 非对象 / 无法解析出路径。
  - `bad_auth_ref`：`auth_ref` 非对象、`kind` 不在词表、`name` 缺失或越界。
- `env.now` 与本方法无关（无时间语义）。

### `list`

- 无参；返回 `[{ name, has }]`（**不回值**）：列出本地文件里已读到的引用名，`has` 恒为 `true`。
  名字按字典序排序（保确定性）。本地文件缺失 → `[]`；不可读 / 损坏 → `secret_unreadable`。
- **契约（写死）**：**缺名 = 未读到**——`list` 只列实际读到的名字，不存在的引用名不出现在清单里；
  故 `has:false` **不可达**（保留字段只为形状稳定，调用方不应据此判断存在性）。

## 本地存储路径口径

宿主起服务时只注入 `CHRONO_PLUGIN_STATE`（= `<root>/state/plugins/<id>`），**不注入 root**。
本服务由它**上溯两级**得到宿主 state 目录（`<root>/state`），再拼 `secrets.local.json`——
即宿主单点解析的 `state/secrets.local.json`（形状 `{ "<name>": "<value>" }`）。
路径归宿主权威，本插件不声明、不创建、不写该文件；未注入该环境变量时 `local` 解析按 `secret_unreadable` 收口。

## 义务（写死）

- 明文**不出现在日志 / stderr**；`list` 只回名字与状态，不回值。
- **不缓存落盘**；解析结果只经协议返回值给调用方。
- 服务不读投影、无写通道、不自取时钟。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 入世冒烟（pack → seed → start → 直连服务 resolve/list → stop）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `execute/`）随源码入世。
