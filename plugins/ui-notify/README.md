# ui-notify（系统通知 · headless 前端）

把宿主事件转成本机系统通知的**浏览器侧 headless 前端**：不占 slot、不占端口、无服务进程，
由壳按独立 headless 清单加载一个前端 bundle，在浏览器里调 `Notification` API。

- 身份：`ui-notify`
- 能力类：`ui-notify`（`ping` 占位；UI 插件统一 `ui-<身份名>`，互不 pin）
- 成员：**仅 terms**（`start` 为空、无 execute 成员 ⇒ 宿主不起进程）
- schema：**省略**（零 schema；无世界数据）
- pins：无
- 状态档：`recomputable`

## 提供哪些命令

- `notify.state`（只读，纯 term，无参）：入口 term 直出投影里的整份 `config` body
  （`ctx.ids.config.body`），**不按字段裁剪**。
  - **返回口径（写死）**：返回值 = `config` 数据身份的整份 body。调用方自行取
    `value.ui.notify`；`ui.notify` 缺键 = 全部开关按默认 `true` 处理。
  - 读投影在**入口 term**；服务不读投影（本插件也没有服务）。
  - 浏览器权限状态**不在本命令返回值里**（入口 term 读不到浏览器 API），走下面的同页全局。

## 浏览器权限状态（同页共享契约）

`Notification.permission`（`default` / `granted` / `denied`）只能在浏览器侧读。本插件的
headless bundle 自初始化时把它**发布到同页全局**，供同页的设置页（`ui-settings`）读取：

- `window.__chronoNotify` = `{ permission, switches, guidance, updatedAt }`
  - `permission`：`default` / `granted` / `denied` / `unsupported`（无 `Notification` API）。
  - `switches`：解析后的开关键当前值（缺键已补默认 `true`）。
  - `guidance`：已拒绝时为 `{ code: 'notify_permission_denied', text }`，其余为 `null`。
- 同页还可监听 `window` 上的 `CustomEvent('chrono-notify:state')`，`event.detail` 同形状。
- 设置页展示「开关 + 权限状态」= `notify.state` 返回值取开关，本全局取权限；两者都满足才弹。
- **未授权（`default`）不报错、不弹 toast**；**已拒绝（`denied`）给指引文案**——文案码
  `notify_permission_denied` 登记进壳的文案表，本插件按码取用、表内缺失时用内置兜底。
- 请求授权必须由用户手势触发，故 [请求授权] 按钮住设置页，不在本插件。

## 订阅的事件与规则

经壳 `/events` SSE 收宿主事件（记录形状 `{ impl, topic, payload }`），按下表分流：

| 事件 | 规则 |
| --- | --- |
| `approval.pending`（`kind=tool_call`） | 仅窗口无焦点时通知（前台由审批卡片呈现） |
| `approval.pending`（`kind=orchestration_change`） | **始终**通知，标题「待审批：编排变更」 |
| `approval.pending`（`kind=plugin_write`） | **始终**通知，标题「待审批：插件写入」 |
| `run.finished`（`status=done`） | 仅窗口无焦点时通知，标题「回合完成」 |
| `run.finished`（`status=refused` / `failed`） | **始终**通知，标题「回合失败」 |
| `run.finished` 且 `reasons` 含 `model_*` 前缀 / `transport_failed` | **始终**通知，标题「模型错误」 |
| `shell.disconnected` / `shell.reconnected`（壳合成） | **始终**通知，标题「断线」/「已重连」 |
| `orchestration.unhealthy` | **始终**通知，标题「编排连续失败」 |
| `question.pending` | **始终**通知，标题「提问待作答」 |

- `approval.pending` 载荷兼容 `payload.item.{kind,thread}` 与扁平 `payload.{kind,thread}`。
- **模型错误分流依赖 `run.finished` 载荷里的 `reasons`**；当前宿主事件载荷为
  `{ run, thread, status }`，无 `reasons` 时该分支不可达，退化为「回合失败」（已知限制）。
- `orchestration.unhealthy` 的 `thread` 为 `null`，去重键退化为 `kind`。
- **通知只是提示、不挂操作按钮**：裁决必须回审批卡片，作答必须回消息流内的问题卡。

## 开关（住 config.ui.notify）

全局、可热改；**缺键默认 `true`**。开关与浏览器权限**都满足才弹**。

```
approval_pending · run_finished · run_failed · model_error · disconnected
orchestration_change · plugin_write · orchestration_unhealthy · question_pending
only_when_unfocused
```

`only_when_unfocused` 只约束 `tool_call` 待审批与回合完成；结构变更 / 失败 / 断线 /
编排健康 / 提问类始终通知。配置写入入口是设置页的「通知」分组。

## 通知形态

- OS 原生模板：`new Notification(title, { body })`，不自绘、不挂按钮。
- 标题 = 事件类型；正文 = 会话标签（事件带的 `thread`）+ 首行摘要，整体按 **80 码点**截断。
- 点击通知聚焦 shell。

## 去重与节流

- 同一 `(thread, kind)` 在 **5s 窗口**内只弹一条，后续到达**合并计数**（计数附在正文）。
- **同屏最多 3 条**，超出按到达顺序排队，关闭一条后弹出下一条。
- `question.pending` / `orchestration.unhealthy` 属**结构性事件，不受节流**（即时弹、不合并、不占同屏配额）。
- `orchestration.unhealthy` 的 `thread:null` ⇒ 去重键退化为 `kind`。
- 勿扰 / 免打扰交系统策略，本插件不做。

## 前端 bundle 形态与加载

- 入口：`web/entry.js`（ESM、零依赖、自初始化、**不导出 `mount`**）。
- 加载：壳按 headless 清单 `state/ui-headless.json` 的 `{id, entry}` 经插件源码读面取字节，
  以壳同源静态路径服务（不占 slot、不进挂载表、不经反代）。本插件对应
  `{ "id": "ui-notify", "entry": "web/entry.js" }`。
- **单文件原因**：壳按 headless 清单的单个 `{id, entry}` 只服务一个静态路径，兄弟模块的
  相对 import 无处可取，故 bundle 不拆文件；纯逻辑以命名导出暴露，便于在 Node 里直接单测。
- 自初始化流程：发布权限状态 → 取 `notify.state` 开关与文案表 → 连 `/events` →
  按规则弹通知 → 事件到达时刷新权限 / 焦点状态。
- 通知失败 / 取开关失败都只静默降级，不影响对话与其它前端。

## 运行

```
npm test                     # 单元测试（node --test，零依赖）
node tools/e2e-smoke.mjs     # 入世 + 宿主装配 E2E（pack → seed → start → notify.state → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`terms/` / `web/`）随源码入世。
