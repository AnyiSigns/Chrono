# ui-settings（引导页 + 设置模态）

Chrono 的**引导页与设置模态**：首次配置（厂商模板 / 自定义厂商同一流程）与设置七页
（通用 / 模型 / 插件 / 技能 / 记忆 / 编排 / 关于）。本插件是 `overlay` 槽子应用，独立包 /
独立进程，客户端半边为壳的单一 React 运行时下的一个 slot 模块；事件经壳 `api.events` 订阅。
本插件另持**编排健康判定**（住本插件 execute 服务）与**回滚入口**，判定不住编排图身份内
（图被改坏时回滚入口不能也在图里）。

- 能力类：`ui-settings`（`ping` 健康占位 + `vendors` / `profile` / `discover` / `health` /
  `view` / `search` / `edit` 七个装配方法 + `client.read` 客户端半边交付 + `secret` 密钥本地写入代理）。
- `pins`：`{"model":"model-protocol","secrets":"secrets","retrieval":"memory-retrieval","memory-maintenance":"memory-consolidate"}`。
- 状态档：`recomputable`（无世界数据，零 schema）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 运行期零 npm 依赖；客户端半边源码为 `.ts` / `.tsx`，由 `plugin.json.build` 自打包。

## 提供哪些命令

只读命令 + 两条写类无参命令（世界写一律以客户端身份经入站面提交）：

| 命令 | 入口 term | 语义 |
| --- | --- | --- |
| `model.vendors` | `eff ui-settings vendors`（读 `ctx.ids`） | 服务装配厂商模板 body → 反向调 `model.vendors` |
| `model.discover` | `eff ui-settings discover`（读 `ctx.ids.input`） | 服务读 `model.probe` 槽 → 反向调 `model.discover`，返回计划：清槽（无论成败，有数据世代则写补丁）+ extern 结果 |
| `model.profile` | `eff ui-settings profile`（读 `ctx.ids`） | 服务从 config 身份 body + 厂商模板身份 body 装配 → 反向调 `model.profile`（返回其写计划） |
| `secrets.status` | `eff secrets.list` | 本地密钥引用名状态（只回 `{name,has}`，不回本体） |
| `settings.identities` | 投影读 `ctx.ids` | 身份名 / 状态 / 世代短哈希（插件页与关于页） |
| `settings.skills` | 投影读技能身份 body | 技能清单（技能页） |
| `orchestration.graph` | 投影读编排图身份 | 当前 active 图的节点 / 边（只读） |
| `orchestration.scopes` | `eff ui-settings scopes`（读 `ctx.ids.agents`） | eff 服务方法：按需解析投影 refs 后回 Scope 名录（只读查询，仍标 `readonly`） |
| `orchestration.health` | `eff ui-settings health`（读 `ctx.ids`） | 服务判定连续 `refused` / 阈值 / 拒绝码分布 / 回滚目标 + 进化台账三条 tail |
| `memory.view` | `eff ui-settings view`（读 `ctx.ids`） | 装配短记忆 body + 记忆库 body / refs → 反向调 `memory-maintenance.view` |
| `memory.search` | `eff ui-settings search`（args，内含 UI 取回的 `ids`） | 装配检索真实 bag → 反向调 `retrieval.search` |
| `memory.edit` | `eff ui-settings edit`（读 `ctx.ids`） | 写类无参：读 `memory.edit` 槽 → 反向调 `memory-maintenance.edit`，返回维护写子操作 + 清槽计划 |
| `ui-settings.client.read` | `eff ui-settings client.read`（args `{path}`） | 只读交付客户端半边产物字节；参数限包内相对 `.js`，路径穿越防护 |
| `ui-settings.secret` | `eff ui-settings secret`（args `{op,name,value?}`） | 密钥本地写入代理：经本进程入站连接直发 `secrets.put` / `secrets.delete`，不进世界 / 审计 |

- **投影读在入口 term**；服务不读投影（随 args 传入）。模型与记忆命令的装配、健康判定住服务
  （`execute/methods.ts`），经宿主反向调用（`port.call`）调下游端口。
- 未就位依赖（如编排图身份）令对应命令按 `missing_path` 收口为 `refused`；页面据此显示
  「依赖未就绪」降级视图，不因缺身份崩溃。

## 写路径

- **config 直写**：整值 `put` + `add_gen` 原子 batch，经入站面 `submit`（客户端身份）。
- **技能直写**：技能页同样以 batch 直写技能身份 body。
- **密钥**：浏览器半边经 `ui-settings.secret` 命令代理，服务进程经入站 `secrets.put` /
  `secrets.delete` 直写用户本地文件（不进世界、不进导出、不进审计）；世界数据只存引用
  `auth_ref = {kind:'local'|'env', name}`。
- **编排回滚**：入站面直接提交 `set_active`（指回编排图的上一数据世代），走二次确认。

## 客户端半边（契约 '2'）

`execute/web/entry.tsx` 导出 `contract = '2'` 与 `register(ctx)`，向壳的 `overlay` slot 注册
一个 React 组件；不再导出 `mount`。业务状态住 React-free store（`execute/web/store.ts`），
React 只渲染。壳对每个注册组件包一层错误边界。

- `overlay` 槽为 `fixed inset 0`：面板未打开时不拦截指针事件（本插件样式对
  `[data-slot-app="ui-settings"]` 覆盖 `pointer-events: none`），打开时自持遮罩、居中与焦点陷阱。
- 叶子纯模型（`config-model` / `onboarding` / `notify` / `health` / `settings-model` /
  `memory-model` / `messages` / `version`）为 `.ts`，零 react import，原样保留并由 `node --test` 覆盖。
- 原 `dom.js` / `ui-parts.js` / `view-*.js` / `provider-form.js` 的 DOM 构建层改由
  `execute/web/components/*.tsx` 的 React 组件承担；样式仍只引壳 token，零硬编码色值。
- 产物落 `execute/web/dist/entry.js`，被 `.worldignore` 排除；壳经 `ui-settings.client.read`
  取字节并以 `/assets/ui/ui-settings.js` 同源服务。

## 引导与设置视图

- **进引导 / 开设置**：订阅壳跨 slot 视图状态 `api.uiState`（`boot_mode` 进引导、
  `settings_open` 同步模态开合）；`Esc` 关闭模态并把焦点归还打开按钮。
- **定高框架 + 统一页头**：设置模态固定宽高，七页同一外框、内容区内部滚动，翻页不跳动；
  每页由统一页头（页标题 + 一行导语）开场，导语文案键为 `settings_desc_<tab>`。
- **行内开关**：通知项与技能启停用拨杆开关（`role="switch"`），不引原生 checkbox。
- **引导页**：整页铺满的居中单列向导，入口页为眉标 + 欢迎语 + 一句说明，表单页只留入口名。
- **通用页**：主题三卡片（`day` / `night` / `system`，经壳 `api.theme.set` 一次落 config）、
  语言置灰只读、通知分组（含浏览器权限状态）、配置导入 / 导出。
- **模型页**：无表单时 = 已保存厂商卡片（编辑地址 / 密钥更新按需展开 / 删除）+ 模板与自定义新建入口；
  有表单时 = 聚焦的表单视图，标题按入口区分（添加厂商 / 添加自定义厂商 / 编辑）；
  厂商模板优先取 `model.vendors`，不可用时回落身份投影。
- **技能页**：列表 + 新建 / 编辑 / 启停（启停走拨杆开关）。
- **记忆页**：三档 L1 / L2 / L3（分段控件）+ 工作区筛选；浏览 / 搜索 / 编辑 / 删除 / 置顶。
- **编排页**：图区显契约哈希与节点 / 边计数；健康区为状态卡（状态点 + 连续失败 / 阈值 / 来源 +
  失败分类 chips）；进化台账逐级下钻；回滚入口带后果提示行。
- **关于页**：版本 / 宿主地址 / 插件数。
- **只读页**：加载呼吸条（>8s 追加「仍在读取…」）、空态、行内错误 + [重试]，无空白页。

## 运行

```sh
npm test          # 纯模型 + 服务协议 + client.read 路径穿越 + entry 导出（node --test）
npm run typecheck # tsc --noEmit（类型门禁）
```

## `.worldignore`

声明 `test/`、`tools/` 与 `execute/web/dist/`（产物为世代内可重算产物，入世会污染内容哈希）。
