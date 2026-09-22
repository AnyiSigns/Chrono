# ui-settings（引导页 + 设置模态）

Chrono 的**引导页与设置模态**：首次配置（厂商模板 / 自定义厂商同一流程）与设置七页
（通用 / 模型 / 插件 / 技能 / 记忆 / 编排 / 关于）。本插件是 `overlay` 槽子应用，独立包 /
独立进程 / 独立端口，自带浏览器静态资源、自己的入站客户端连接、自己的 `/events` SSE。
本插件另持**编排健康判定**（住本插件 execute 服务）与**回滚入口**，判定不住编排图身份内（图被改坏时回滚入口
不能也在图里）。

- 能力类：`ui-settings`（`ping` 健康占位 + `vendors` / `profile` / `discover` / `health` /
  `view` / `search` / `edit` 七个方法；UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：`{"model":"model-protocol","secrets":"secrets","retrieval":"memory-retrieval","memory-maintenance":"memory-consolidate"}` —— 服务入口 term 发 `eff`（密钥引用状态）
  与**服务侧反向调用**（`port.call`，模型发现 / 档案 / 厂商清单 / 记忆浏览 / 搜索 / 编辑）共用；服务进程本身不读投影（投影由入口
  term 随 args 传入）、不发 `eff`。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema** —— 省略 `plugin.json.schema`，
  宿主提供最小默认 def）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行时零 npm 依赖：HTTP / SSE / socket 全用 Node 内置，浏览器层源码 ESM 直接服务、不自打包。

## 提供哪些命令

只读命令 + 一条写类无参命令（写一律以客户端身份经入站面提交）：

| 命令 | 入口 term | 语义 |
| --- | --- | --- |
| `model.vendors` | `eff ui-settings vendors`（读 `ctx.ids`） | 服务装配厂商模板 body → 反向调 `model.vendors`，结果即命令结果 |
| `model.discover` | `eff ui-settings discover`（读 `ctx.ids.input.body`） | 服务读 `model.probe` 槽 → 反向调 `model.discover`，返回计划：清 `model.probe` 槽（无论成败）+ extern discover 结果 |
| `model.profile` | `eff ui-settings profile`（读 `ctx.ids`） | 服务从 config 身份 body + 厂商模板身份 body 装配 → 反向调 `model.profile`（返回其写计划） |
| `secrets.status` | `eff secrets.list` | 本地密钥引用名状态（只回 `{name,has}`，不回本体） |
| `settings.identities` | 投影读 `ctx.ids` | 身份名 / 状态 / 世代短哈希（插件页与关于页） |
| `settings.skills` | 投影读技能身份 body | 技能清单（技能页） |
| `orchestration.graph` | 投影读编排图身份 | 当前 active 图的节点 / 边（只读） |
| `orchestration.scopes` | 投影读智能体身份 | Scope 名录（只读） |
| `orchestration.health` | `eff ui-settings health`（读 `ctx.ids`） | 服务判定连续 `refused` / 阈值 / 拒绝码分布 / 回滚目标 + 进化台账三条 tail（只读，不发事件） |
| `memory.view` | `eff ui-settings view`（读 `ctx.ids`） | 服务从短记忆 body + 记忆库 body / refs 装配 → 反向调 `memory-maintenance.view`（L1 / L2 / L3 只读） |
| `memory.search` | `eff ui-settings search`（args，内含 UI 取回的 `ids`） | 服务装配检索真实 bag（`query` / `goal` / `workspace` / `retrieval` / `memory={body,refs}`）→ 反向调 `retrieval.search` |
| `memory.edit` | `eff ui-settings edit`（读 `ctx.ids`） | **写类无参**：载荷先写入站槽 kind `memory.edit`；服务读槽 + 短记忆 / 记忆库投影 → 反向调 `memory-maintenance.edit`，返回计划 = 维护写子操作 + 清槽（无论成败） |

- **投影读在入口 term**；服务不读投影（`ctx` 由宿主按 directive 注入 term，随 args 传入）。
- 模型与记忆命令的装配、健康判定住服务（`execute/methods.ts`）：内核 term 语言无对象构造 / 无算术
  （`docs/kernel.md` §十三），装配 bag 无法用 term 表达；服务经**宿主反向调用**（`port.call`）调 `model` /
  `retrieval` / `memory-maintenance` 端口。
- **通则（入口 term 不能装配多切片 bag ⇒ 装配下沉到服务）**：`eff` 的 args 是单一 Term，无法把多个投影切片
  （或 args 与投影）拼成一个值；凡需多切片 / 多来源的命令，入口 term 只传单一投影（最宽整份 `ctx.ids`），
  装配住服务。`memory.search` 的查询 args 与投影无法在 term 合流，改由 UI 侧 `settings.identities` 取回
  `ids` 随 args 传入（入口 term 传命令 args）。
- 未就位依赖（如编排图身份）令对应命令按 `missing_path` 收口为 `refused`；页面据此显示
  「依赖未就绪」降级视图，**不因缺身份崩溃**。
- 记忆页（S12）为**真实记忆 tab**：三档 L1 / L2 / L3 + 工作区筛选，浏览 / 搜索 / 编辑 / 删除 / 置顶经
  `memory.view` / `memory.search` / `memory.edit` 走记忆族；写一律经记忆维护（不直写短记忆 / 记忆库）。

### 入口 term 触发本插件服务

内核 term 语言只有八个原语（常量 / 取路径 / 取实参 / 比较 / 分支 / 折叠 / 效果 / 调用），
**没有对象或列表构造、没有算术**，故装配与判定下沉到本插件 execute 服务（见上）。

宿主 `eff` 的 `port` 解析（`packages/host/effect/route.ts`）在按发出者 `pins` 解析之外，
**允许解析到发出者自身声明的能力类**：本插件入口 term 发 `eff ui-settings <method>` 时，
宿主按本插件装配世代声明的能力类解析到本插件自己的端点行，无需自 pin。七条服务侧命令
（`model.vendors` / `model.profile` / `model.discover` / `orchestration.health` / `memory.view` /
`memory.search` / `memory.edit`）因此可用：
入口 term 读 `ctx` 投影随 args 传入，服务装配 / 判定后经反向调用调下游端口或直接回结构化结果。

## 写路径（不写世界本体）

- **config 直写**：整值 `put` + `add_gen` 原子 batch，经入站面 `submit`（客户端身份）。
  引导完成、模型增删改、参数、主题、通知开关、配置导入都走此路，写后即时生效且可回放。
- **技能直写**：技能页同样以 batch 直写技能身份 body（列表 + 新建 / 编辑 / 启停）。
- **密钥**：本体经宿主入站 `secrets.put` / `secrets.delete` 直写用户本地文件（不进世界、
  不进导出、不进审计）；世界数据只存引用 `auth_ref = {kind:'local'|'env', name}`。
- **编排回滚**：入站面直接提交 `set_active`（指回编排图身份的上一数据世代），走二次确认；
  回灌缺失时只显示「回滚未验证」，不显示成功。

## 引导与设置视图

- **进引导 / 开设置**：订阅壳的跨 slot 视图状态 `api.uiState`（`boot_mode` 进引导、
  `settings_open` 同步模态开合）；`Esc` 关闭模态并把焦点归还打开按钮，层级用 `--z-modal`。
- **通用页**：主题三卡片（日间 / 夜间 / 系统，config 用户语义 `day` / `night` / `system`），
  切换经壳的 `api.theme.set` 一次落 config（不再客户端二次直写），`boot_mode` 由壳读 config 重推；
  语言行置灰只读、通知分组、配置导入 / 导出。
- **模型页**：上区已保存厂商（编辑地址 / 每厂商密钥更新 / 删除），
  下区模板与自定义两条入口新建；厂商模板优先取 `model.vendors`（不可用时回落身份投影）；`model.profile` 无参调用
  （服务从投影装配）；`model.discover` 的 `model.probe` 清槽由服务返回的计划携带，客户端不再清。
  - **当前模型不在本页选**：由对话输入框选择模型时写 `config.vendor` / `config.model`；本页只维护厂商与模型目录。
  - **密钥**：新建时一个密钥输入框（内部固定 `local` + 自动引用名，不进界面），经入站 `secrets.put` 直写本地
    （不进世界 / 导出 / 审计）；每厂商另有掩码输入可更新密钥，保存后刷新 `secrets.status` 状态点。
  - **改（编辑）**：只改 `base_url`，密钥 / 模型 / 档案元数据原样保留。
- **编排页**：健康区直接渲染 `orchestration.health` 的结构化结果（状态 / 连续计数 / 阈值 / 拒绝码 / 回滚目标），
  不再在浏览器侧计数比阈值；**进化台账**由健康结果随带的 `ledger`（`verdicts` / `proposals` / `evidence`
  三条 tail，采纳与拒绝都在）渲染，判定行显 `proposal_id` + `evidence_id` 并可点击下钻到提案 / 证据 / trace；
  Scope 名录按智能体身份 `instances` 尾链读取（`contract_id` / 人格 / 作用域 / 自治 / 关联 / 成功率，空链显空态）；
  回滚后不可验证时只显「回滚未验证」，失败落行内 danger + [重试]。
- **记忆页（S12）**：三档 L1 / L2 / L3 + 工作区筛选；浏览（`memory.view`）显示 goal / decisions / facts /
  open_questions / files、来源、`at`、L1 剩余 TTL、tags；搜索（`memory.search`）命中高亮、空结果显示「无匹配」；
  编辑 / 删除 / 置顶（`memory.edit` 写类无参：先写 `memory.edit` 槽再调命令，随后重拉视图）；L1 过期行以
  `--c-text-3` 弱化；加载（呼吸条 + >8s）/ 空 / 错误三态 + 行内 danger + [重试]。
- **通知权限**：权限状态取通知前端发布的**同页全局**（`window.__chronoNotify` /
  `chrono-notify:state`），设置页不直接读 `Notification.permission`；`default` 显
  [请求授权]（用户手势触发浏览器授权），`denied` 给站点设置指引；未授权 / 已拒绝时开关置灰。
- **只读页**：加载呼吸条（>8s 追加「仍在读取…」）、空态、行内错误 + [重试]，无空白页。
- **事件**：页面订阅本插件自己的 `/events` SSE（unmount 时关闭），编排健康更新无需进入编排 tab 即可刷新
  tab 角标；模态打开时焦点移入对话框、背景 `aria-hidden`，`Esc` 关闭并归还焦点。

## 子应用入口契约

```
GET /entry.js   → ES module，导出 mount(root, api) -> {unmount()}；另导出 contract = "1"
GET /<name>.js  → 浏览器视图层模块（扁平白名单名，源码 ESM 直接服务）
GET /events     → 本插件自己的 SSE：宿主事件原样重播（impl 命名空间）+ 本插件连接态（页面订阅）
POST /api/command        → 入站 command（只读命令）
POST /api/submit         → 入站 submit（directive(s) + thread）
POST /api/secrets/put    → 入站 secrets.put（密钥本体直写本地文件）
POST /api/secrets/delete → 入站 secrets.delete
GET  /api/state          → 本插件入站连接态
```

视图层模块拆分为：入口编排 `entry.js`；纯模型 `config-model.js` / `onboarding.js` / `notify.js` /
`health.js` / `settings-model.js` / `memory-model.js` / `messages.js`；入站网络 `client.js`；动作
`provider-actions.js` / `memory-actions.js` / `theme-actions.js` / `notify-actions.js` / `config-io.js` /
`data-load.js` / `sse.js`；渲染 `view-*.js`（各 tab 一文件）+ 共用片段 `ui-parts.js` / `provider-form.js`；
`dom.js` / `styles.js` / `version.js`。

- 静态资源一律引用壳的唯一来源：`/assets/tokens.v1.css`（token）、`/assets/icons.v1.svg`
  （线性图标 sprite）、`/assets/messages.v1.json`（**文案单一来源**：本插件的界面标签 / 按钮 /
  空态 / 错误文案一律登记于此）；组件样式只引 token，零硬编码色值、无内嵌图标与 emoji。
- `execute/web/messages.js` 只保留**最小骨架兜底**（共享表拉取失败或键暂缺时保证界面不空白），
  不承载业务文案；新增文案一律进共享表。
- 端口默认 `8792`（`CHRONO_UI_PORT_UI_SETTINGS` 可覆盖），绑定 `127.0.0.1`；浏览器经壳
  反代 `/p/ui-settings/*` 访问，不直连本端口。
- 失败隔离：本 slot 加载失败只在本 slot 内渲染占位，不影响其它 slot。

## 运行

```sh
npm test                          # 纯函数视图层 + 服务协议测试（node --test）
node tools/e2e-smoke.mjs          # 宿主装配 + HTTP E2E（pack/seed → start → HTTP → stop → verify）
```

真实模型集成（`model.discover` / `model.profile`）读仓库根 `.env` 的 `base_url` 与 `model_id`；
缺失或调用失败时优雅跳过，绝不硬编码密钥。

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`execute/`（含 `execute/web/`）/ `terms/`）随源码入世。本插件无世界数据、零 schema，故无
`schema/` 目录。
