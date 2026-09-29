# secrets（密钥解析面 / 扩展点拥有方）

密钥的**统一解析面**：把世界数据里的引用 `auth_ref` 解析成**解析结果**（明文，仅存调用方进程内存），
并汇总后端清单。密钥本体住宿主侧用户本地文件或各后端各自的取值面，**不进世界、不进审计、不进 config 导出**。

- 能力类：`secrets`；方法：`resolve` / `list`（公开面，消费方零改动）。
- 命令：无（密钥写入走宿主入站面 `secrets.put` / `secrets.delete`，宿主直写本地文件，不经本服务）。
- `pins`：无；`needs`：`secrets-backend`（`mode:"many"`）——后端成员表由宿主按世界能力索引注入。
- `slots`（拥有方）：`secrets-backend`，方法契约 `read` / `list` / `kinds`。
- `+`（投影读）：无（`auth_ref` 由上游入口 term 从世界读出后随 args 传入）。
- 状态档：`recomputable`（无不可重算状态；服务不缓存、不落盘）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## 扩展点：新增后端零改动消费者

`secrets` 是能力类 `secrets-backend` 的**拥有方**：冻结契约、开放扩展点。后端插件经
`implements:["secrets-backend"]` 自注册，并经 `kinds` 方法自述其支持的 `auth_ref.kind`。
`secrets` 按注入的世界成员表逐个 `kinds` 定位 kind 的唯一后端，再经反向
`port.call secrets-backend.read / list`（帧带 `provider` 成员身份）反调。

- **新增后端 = 新插件 + `implements`**：`secrets` 代码不变、消费方（`mcp` / `model-protocol` /
  `tool-shell` / `ui-settings`）代码与声明不变。
- **成员集变化** = 世界变更 → 宿主重解析并按成员表重注入（换代重启，热跟随）。
- **kind 定位规则**：成员按注入序（宿主的码元序）逐个查 `kinds`；**恰好一个**声明该 kind → 命中该成员；
  **无** → `secret_kind_unsupported`；**多个** → `secret_kind_ambiguous`（不静默选中）。
- 已内置后端：`secrets-local`（kind `local`，宿主本地文件）、`secrets-env`（kind `env`，本服务进程环境）。

## 安全边界

- `secrets` 是**唯一对外身份**且受保护（`chrono.config.json` 的 `protected_pins`）：消费方只认 `secrets`。
- 后端**仅供 `secrets` 经注入成员表发现**：消费方不直接依赖任何后端；后端也不出现在消费方 `pins` / `needs`。
- 明文**不落审计**：`EffectAudit` 脱敏归宿主（`port=secrets` + `method=resolve` 替换为 `{name,kind,has}`）；
  后端仅经协议返回值给 `secrets`，不缓存、不落盘、不写日志。
- `auth_ref` 形态校验（非对象 / kind 非非空字符串 / name 越界 / NUL / 原型键）**留 `secrets`**；
  kind 词表开放，不在本层硬编码。
- 槽把参数发给**所有**成员；安全关键取值面不用 `many`（`secrets-backend` 只回引用名 / 明文，不含敏感元数据）。

## 方法 args 契约

### `resolve`

| 字段            | 类型 / 可空性 | 说明                                                                    |
| --------------- | ------------- | ----------------------------------------------------------------------- |
| `auth_ref`      | object，必填  | `{ kind, name }`                                                        |
| `auth_ref.kind` | string，可缺  | 取值来源标识，缺省 `local`；词表开放，由各后端 `kinds` 自述             |
| `auth_ref.name` | string，必填  | 引用名（如 `DEEPSEEK_API_KEY`）；非空、≤256、不含 NUL、非原型污染保留键 |

- 返回：**解析结果**（明文值，`result.value` 是字符串本身）。明文只进调用方进程内存；
  `EffectAudit` 的脱敏归宿主（对 `port=secrets` + `method=resolve` 替换为 `{name,kind,has}`）。
- 失败（协议 `error` 帧，结构化、不崩进程、不泄漏值 / 文件内容）：
  - `secret_missing`：引用名在取值面不存在。
  - `secret_unreadable`：后端取值面不可读 / JSON 非法 / 非对象 / 无法解析出路径 / 通道失败。
  - `bad_auth_ref`：`auth_ref` 非对象、`kind` 非非空字符串、`name` 缺失或越界。
  - `secret_kind_unsupported`：没有任何成员后端声明该 kind。
  - `secret_kind_ambiguous`：多个成员后端声明同一 kind，无法唯一定位。
- `env.now` 与本方法无关（无时间语义）。

### `list`

- 无参；返回 `[{ name, has }]`（**不回值**）：汇总各可枚举后端已读到的引用名，按名去重、字典序排序。
  `has` 恒为 `true`；`env` 后端无枚举接口，不贡献清单项。
- 不可达后端按元素错误**跳过**（一个后端故障不阻塞清单，只隔离提供方）；可达后端的数据面错误
  （如本地文件不可读）仍按 `secret_unreadable` 整体失败。
- **契约（写死）**：**缺名 = 未读到**——`list` 只列实际读到的名字；故 `has:false` **不可达**
  （保留字段只为形状稳定，调用方不应据此判断存在性）。

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
