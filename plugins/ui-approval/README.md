# ui-approval（审批停靠带）

Chrono 的**审批停靠带**：`dock` 槽子应用，展示待审批队列（计数 / 等待计时 / 整批裁决），
按条目种类选卡片模板并提交裁决。独立包 / 独立进程 / 独立端口，自带浏览器静态资源、
自己的入站客户端连接；事件经壳 `/events` 总线（`api.events`）订阅。本插件不做判定、不做审批流程本体、不做对话视图。

- 能力类：`ui-approval`（`ping` 健康占位 + `list` / `decide` / `decide_all` 三个服务方法；
  UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：`{"approval":"approval"}` —— 服务经**宿主反向调用**（`port.call`）调审批队列
  （`list` / `decide` / `decide_all`）；服务进程本身不读投影（投影由入口 term 随 args 传入）、不发 `eff`。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema** —— 省略 `plugin.json.schema`，
  宿主提供最小默认 def）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖：HTTP / socket 全用 Node 内置，浏览器层源码 ESM 直接服务、不自打包。

## 提供哪些命令

三条命令均**无参**，入口 term 把 `ctx.ids` 投影切片交给本插件服务，服务装配后反向调审批端口：

| 命令 | 入口 term | 语义 |
| --- | --- | --- |
| `approval.list` | `eff ui-approval list`（读 `ctx.ids`） | 服务从投影取队列 body + item 引用闭包 → 反向调 `approval.list`，结果即命令结果（只读，不构造写） |
| `approval.decide` | `eff ui-approval decide`（读 `ctx.ids`） | 读本线程 `approval.decide` 槽 → 反向调 `approval.decide` → 拼续跑计划 |
| `approval.decide_all` | `eff ui-approval decide_all`（读 `ctx.ids`） | 对全部 `pending` 项给同一 verdict，其余同单条 |

- **投影读在入口 term**；服务不读投影（`ctx` 由宿主按 directive 注入 term，随 args 传入）。
- **裁决续跑计划**：服务反向调审批端口拿到其写计划后，拼顶层 `$directives` =
  `[eval(command:'chat.resume', args:{cursor, thread, payload:{verdict}, ids}), …审批写计划]` ——
  续跑条目按被裁决项逐条产（每项各自游标 / 线程），审批写计划接在其后（记裁决 + 清槽 + extern）。
  `chat.resume` 命令名由对话插件声明，宿主按命令名解析入口。
- **续跑 args 为何自带 `ids`**：内核 term 不能同时传 args 与投影，续跑 eval 无法再以 `["g",["ids"]]`
  取投影，故由调用方把**本服务入口 term 收到的投影切片**原样放进 args，供对话服务装配 interpret bag
  （与工作区 `reveal` / 记忆 `search` 的「投影随 args 携带」写法一致）。

## 卡片与交互

- **模板**：按条目 `kind` 选三种模板 —— `tool_call`（工具名 + 参数摘要）、
  `orchestration_change`（编排变更：节点 / 边 diff + 影子回放指标对照）、
  `plugin_write`（插件写入：插件身份 + 变更文件清单 + `validate` 结果 + 隔离风险提示）。
  两类结构变更与 `severe` 档条目默认展开，其余单行摘要点击就地展开。
- **裁决**：单条 [批准] / [拒绝]；[全部批准] / [全部拒绝] 对整批给同一 verdict。
  [全部拒绝] 明确为**放弃并终止本回合**（与单条 [拒绝] 同语义），[全部批准] 与 [全部拒绝]
  均走**原地 3s 二次确认**（再点执行，超时、点他处或 `Esc` 回退）。
- **等待与超时**：头部「待审批 N」右侧显示「已等待 mm:ss」（自条目 `at` 起算、按秒更新），
  **>2min 转 warning 前景字**；`expired` 条目整条弱化并追加「已超时」标签，**仍可裁决**、
  不自动消失、不自动拒绝。
- **槽写入**：裁决前先读-改-写输入槽（`{kind:'approval.decide', id?, verdict}`，
  缺 `id` = 整批），**per-thread 键控**——只覆盖 `item.thread` 对应的键（缺省 `_main`），
  其余线程键原样保留；提交后等服务侧确认写 run 收口，再调无参命令。
- **失败**：裁决失败在该条行内收口（danger 文字 + [重试]），条目仍留在停靠带。
- **层级 / 质感**：停靠带用 `--z-dock`、薄玻璃（全局唯一例外，`--c-glass` + `backdrop-filter`，
  不支持时降级实色）；出入 200ms，最大高 40vh、超出内滚；无待审批项时不占高度、不渲染。

## 子应用入口契约

```
GET /entry.js   → ES module，导出 mount(root, api) -> {unmount()}；另导出 contract = "1"
GET /<name>.js  → 浏览器视图层模块（扁平白名单名，源码 ESM 直接服务）
POST /api/command → 入站 command（三条命令）
POST /api/submit  → 入站 submit（裁决前写槽的 batch）
```

- 事件不经本端口：浏览器侧经壳 `api.events` 订阅宿主事件与 `shell.state` 连接态。

- 视图层模块拆分：入口编排 `entry.js`；纯模型 `model.js`（模板选择 / 摘要视图 / 影子指标 /
  计时格式 / 二次确认状态机 / verdict 映射）；入站网络 `client.js`；事件 `sse.js`；
  渲染小件 `dom.js` / `styles.js`；文案 `messages.js`。
- 静态资源一律引用壳的唯一来源：`/assets/tokens.v1.css`（token）、`/assets/icons.v2.svg`
  （线性图标 sprite）、`/assets/messages.v1.json`（错误码人话）；组件样式只引 token，
  零硬编码色值、无内嵌图标与 emoji。
- 端口默认 `8789`（`CHRONO_UI_PORT_UI_APPROVAL` 可覆盖），绑定 `127.0.0.1`；浏览器经壳
  反代 `/p/ui-approval/*` 访问，不直连本端口。本插件不自开对外端口。
- 失败隔离：本 slot 加载失败只在本 slot 内渲染占位，不影响其它 slot。

## 运行

```sh
npm test                          # 纯函数模型 + 服务装配 / 协议测试（node --test）
node tools/e2e-smoke.mjs          # 宿主装配冒烟（pack → seed → start → 声明核对 → stop → verify）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`execute/`（含 `execute/web/`）/ `terms/`）随源码入世。本插件无世界数据、零 schema，
故无 `schema/` 目录。
