# plugin-admin（agent 的插件管理工具面）

插件管理能力的**工具面**：向模型暴露四个全局唯一工具（`plugin.list` / `plugin.read` /
`plugin.validate` / `plugin.write`），`describe` 回工具清单与描述四要素，`invoke` 按工具名派发。
**重逻辑不在此**——数据源、可见性过滤、validate→write 凭据强制顺序等全住管理平面 `plugin`（见该插件自述）。

- 能力类：`plugin-admin`（`describe` / `invoke`）。
- `needs`：`{"plugin":{"mode":"one"}}` —— 单一管理平面提供方；`invoke` 经反向调用
  `port.call plugin.<method>` 委派，反向等待上限严格大于 `plugin` 声明的 `method_timeouts`（嵌套超时）。
  `pins` 为空：工具面自身不再直连宿主。
- 类名 `plugin-admin` 保留 ⇒ 消费方（`tools`）的 `describe` / `invoke` 调用面零改动。
- 工具面不读投影、无写通道、无可见性过滤（过滤住管理平面）。
- 状态档：`recomputable`。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖。

## 工具面（`plugin-admin.describe`）

四个工具（全局唯一名）各带**描述四要素**（`intent` / `when_to_use` / `param_semantics` / `boundaries`）
与工具卡 `render` 描述符；`plugin-admin.invoke {tool, args}` 按工具名派发到管理平面，业务失败回
`{ok:false,error:{code,message}}`。

| 工具              | `form` | `label`  | `summary`              | `tone`  | `detail.kind` | `idempotent` |
| ----------------- | ------ | -------- | ---------------------- | ------- | ------------- | ------------ |
| `plugin.list`     | `card` | `plugin` | `list`                 | `solid` | `list`        | true         |
| `plugin.read`     | `card` | `plugin` | `read  {identity}`     | `solid` | `code`        | true         |
| `plugin.validate` | `card` | `plugin` | `validate  {identity}` | `solid` | `json`        | true         |
| `plugin.write`    | `card` | `plugin` | `write  {identity}`    | `solid` | `diff`        | false        |

## 工具名 → 管理平面方法

| 工具              | `port.call plugin.<method>` |
| ----------------- | --------------------------- |
| `plugin.list`     | `plugin.list`               |
| `plugin.read`     | `plugin.read`               |
| `plugin.validate` | `plugin.validate`           |
| `plugin.write`    | `plugin.write`              |

未知工具名 → `unknown_tool`（不触达管理平面）；管理平面的结构化错误（`hidden_identity` /
`validate_required` / 宿主错误透传等）原样回 `{ok:false,error}` 值。

## `plugin-admin.invoke` 的错误形状

- `unknown_tool`：工具名不在派发表内。
- `bad_args`：`tool` 缺失 / args 非对象。
- 其余错误码由管理平面回带，工具面原样透传（不二次解释）。

## 可见性黑名单

黑名单（`sandbox` / `plugin` / `plugin-admin`）钉在**管理平面 `plugin`** 的 `execute/visibility.ts`
包内常量，不在此插件；工具面只转发，不做过滤。

## schema

`schema/plugin-admin.json` 只声明方法级超时（`method_timeouts`）与身份自述，无世界数据、无可配参数。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 宿主装配 E2E（seed → start → loaded → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` / `schema/` /
`execute/`）随源码入世。
