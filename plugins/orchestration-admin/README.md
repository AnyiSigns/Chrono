# orchestration-admin（agent 面编排管理工具面）

agent 面编排管理的**工具面**：按工具名把 `orchestration.*` 派发到编排平面 `orchestration`。
本插件只做工具名派发，不实现编排逻辑、不产证据、不产写；列图 / 读条目 / 机械闸校验 / 产提案的
权威实现归 `orchestration`。人闸在采纳，不在本插件。

- 能力类：`orchestration-admin`（`describe` / `invoke`）。
- `pins`：`{}`；`needs`：`orchestration`（`mode:"one"`）—— invoke 经反向 `port.call orchestration.*` 消费编排平面提供方，本插件不本地复刻。
- 工具名（命名空间化，避免与其它工具撞名）：`orchestration.list` / `orchestration.read` / `orchestration.validate` / `orchestration.propose`。
- `describe` 不读投影、不发反向调用；`invoke` 只做派发，业务失败作 `{ok:false,error:{code,message}}` 值（不炸本轮）。
- 状态档：`recomputable`；启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 工具面（`orchestration-admin.describe`）

四个工具各带**描述四要素**（`intent` / `when_to_use` / `param_semantics` / `boundaries`）与工具卡
`render` 描述符；`orchestration-admin.invoke {tool, args}` 按工具名反向派发到 `orchestration.*`，
业务失败回 `{ok:false,error:{code,message}}`。

| 工具                     | `form` | `label`         | `summary`            | `tone`  | `detail.kind` | `idempotent` |
| ------------------------ | ------ | --------------- | -------------------- | ------- | ------------- | ------------ |
| `orchestration.list`     | `card` | `orchestration` | `list`               | `solid` | `list`        | true         |
| `orchestration.read`     | `card` | `orchestration` | `read  {target}`     | `solid` | `json`        | true         |
| `orchestration.validate` | `card` | `orchestration` | `validate  {target}` | `solid` | `json`        | true         |
| `orchestration.propose`  | `card` | `orchestration` | `propose  {target}`  | `solid` | `diff`        | false        |

- 高危写类用 `solid`：默认收缩显示 `op + target`，展开看图 diff 与影子回放指标对比。
- `caps` 含 `fs.read`，`net` 为字符串 scope（`"none"`）。

## 派发契约

- `invoke` 的 `tool` 必须命中四个工具名之一，未知拒 `unknown_tool`。
- `args` 原样作为 bag 反向传给 `orchestration.<method>`；远端结构化失败（`evidence_required` /
  `fork_required` / `validate_required` / `invalid_graph` / `quota_exceeded` / `bad_change_class` 等）
  按原码回带为 `{ok:false,error:{code,message}}`。
- 远端不可用（未装载 / 传输失败）→ `{ok:false, error:{code,message}}`（如 `transport_failed`）；不本地兜底。
- **方法面守恒**：`orchestration` 能力类的公开方法面（`list` / `read` / `validate` / `propose`）整体归
  `orchestration`；本插件保留 `orchestration-admin` 类名与 `describe` / `invoke`，消费方（工具目录装配、
  审批 `orchestration_change` 的 `port`）**零改动**。

## 结构化错误码

`unknown_tool`（invoke 未知工具）、`bad_args`（缺 `tool`）；编排域错误码由 `orchestration` 返回（见其自述）。

## schema

`schema/orchestration-admin.json` 只描述工具面身份，不声明私有参数；提案额度等归编排平面 schema。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（pack/seed → start → loaded → stop → verify → replay）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` /
`execute/`）随源码入世。
