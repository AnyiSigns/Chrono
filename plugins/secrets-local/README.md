# secrets-local（本地密钥文件后端）

本地密钥文件的**只读后端**：`secrets-backend` 扩展类的一个提供方，支持 `auth_ref.kind = local`。
由宿主注入的 state 目录解析 `state/secrets.local.json` 的绝对路径，读取引用名与明文值。
密钥本体住宿主侧用户本地文件，**不进世界、不进审计、不进 config 导出**。

- 身份 / 能力类：`secrets-local`（身份）→ `secrets-backend`（提供方，`implements`）。
- 方法：`read` / `list` / `kinds`（`kinds` 自述支持的 `auth_ref.kind`，本后端恒为 `["local"]`）。
- 命令：无（密钥写入走宿主入站面 `secrets.put` / `secrets.delete`，宿主直写本地文件，不经本服务）。
- `pins` / `needs`：无；服务只读宿主本地文件，不消费其它能力。
- 状态档：`recomputable`（无不可重算状态；服务不缓存、不落盘）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## 扩展点角色

`secrets-backend` 的拥有方是 `secrets`（声明 `slots`）。本插件经 `implements:["secrets-backend"]`
自注册为一个后端：新增 / 换后端只改世界成员表，`secrets` 与消费方零改动。本插件不感知其它后端。

## 方法 args 契约

### `read`

| 字段   | 类型 / 可空性 | 说明                                              |
| ------ | ------------- | ------------------------------------------------- |
| `name` | string，必填  | 引用名（如 `DEEPSEEK_API_KEY`）；非空、不含 NUL。 |

- 返回：该引用名对应的**明文**（字符串本身，仅存调用方进程内存）。
  审计脱敏按本插件 `schema` 的 `audit_redact` 声明；本服务不缓存、不落盘、不写日志。
- 失败（协议 `error` 帧，结构化、不崩进程、不泄漏值 / 文件内容）：
  - `secret_missing`：引用名在本地文件里不存在。
  - `secret_unreadable`：本地文件不可读 / JSON 非法 / 非对象 / 无法解析出路径。
  - `bad_args`：`name` 缺失、非字符串或含 NUL。
- `env.now` 与本方法无关（无时间语义）。

### `list`

- 无参；返回 `[{ name, has }]`（**不回值**）：列出本地文件里已读到的引用名，`has` 恒为 `true`。
  名字按字典序排序（保确定性）。本地文件缺失 → `[]`；不可读 / 损坏 → `secret_unreadable`。
- **契约（写死）**：**缺名 = 未读到**——`list` 只列实际读到的名字，不存在的引用名不出现在清单里；
  故 `has:false` **不可达**（保留字段只为形状稳定，调用方不应据此判断存在性）。

### `kinds`

- 无参；返回 `["local"]`（非空字符串数组）：本后端支持的 `auth_ref.kind` 集。
  `secrets` 按此在成员间定位 kind 的唯一后端。

## 本地存储路径口径

宿主起服务时只注入 `CHRONO_PLUGIN_STATE`（= `<root>/state/plugins/<id>`），**不注入 root**。
本服务由它**上溯两级**得到宿主 state 目录（`<root>/state`），再拼 `secrets.local.json`——
即宿主单点解析的 `state/secrets.local.json`（形状 `{ "<name>": "<value>" }`）。
路径归宿主权威，本插件不声明、不创建、不写该文件；未注入该环境变量时按 `secret_unreadable` 收口。

## 义务（写死）

- 明文**不出现在日志 / stderr**；`list` 只回名字与状态，不回值。
- **不缓存落盘**；读取结果只经协议返回值给调用方。
- 服务不读投影、无写通道、不自取时钟。

## 运行

```sh
npm test                        # 协议级测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `execute/`）随源码入世。
