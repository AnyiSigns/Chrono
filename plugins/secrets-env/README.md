# secrets-env（进程环境密钥后端）

进程环境的**只读后端**：`secrets-backend` 扩展类的一个提供方，支持 `auth_ref.kind = env`。
读取本服务进程环境里同名的变量值作为明文。密钥本体只在本服务进程内存，**不进世界、不进审计、不进 config 导出**。

- 身份 / 能力类：`secrets-env`（身份）→ `secrets-backend`（提供方，`implements`）。
- 方法：`read` / `list` / `kinds`（`kinds` 自述支持的 `auth_ref.kind`，本后端恒为 `["env"]`）。
- 命令：无（环境变量由宿主进程环境注入，无写入面）。
- `pins` / `needs`：无；服务只读自身进程环境，不消费其它能力。
- 状态档：`recomputable`（无不可重算状态；服务不缓存、不落盘）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## 扩展点角色

`secrets-backend` 的拥有方是 `secrets`（声明 `slots`）。本插件经 `implements:["secrets-backend"]`
自注册为一个后端：新增 / 换后端只改世界成员表，`secrets` 与消费方零改动。本插件不感知其它后端。

## 方法 args 契约

### `read`

| 字段   | 类型 / 可空性 | 说明                                                            |
| ------ | ------------- | --------------------------------------------------------------- |
| `name` | string，必填  | 引用名（即环境变量名，如 `DEEPSEEK_API_KEY`）；非空、不含 NUL。 |

- 返回：该引用名对应的**明文**（字符串本身，仅存调用方进程内存）。
  审计脱敏按本插件 `schema` 的 `audit_redact` 声明；本服务不缓存、不落盘、不写日志。
- 失败（协议 `error` 帧，结构化、不崩进程、不泄漏值）：
  - `secret_missing`：引用名在本服务进程环境里不存在。
  - `bad_args`：`name` 缺失、非字符串或含 NUL。
- `env.now` 与本方法无关（无时间语义）。

### `list`

- 无参；恒回 `[]`。进程环境无稳定枚举接口，且列出变量名会泄漏宿主环境，
  故本后端不贡献清单项（`secrets.list` 的清单只来自可枚举后端）。

### `kinds`

- 无参；返回 `["env"]`（非空字符串数组）：本后端支持的 `auth_ref.kind` 集。
  `secrets` 按此在成员间定位 kind 的唯一后端。

## 义务（写死）

- 明文**不出现在日志 / stderr**；`list` 不回值。
- **不缓存落盘**；读取结果只经协议返回值给调用方。
- 服务不读投影、无写通道、不自取时钟。

## 运行

```sh
npm test                        # 协议级测试（node --test）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `execute/`）随源码入世。
