# ui-sidebar（侧边栏）

左列子应用（slot = `sidebar`），承载工作区分组、会话列表与会话管理。界面结构为：

```
Chrono
[ + 添加工作目录 ]
▾ 工作区 A                    [新对话] [⋯]
     会话 A1
     会话 A2
▸ 工作区 B
[ 设置 ]  [展开|收缩]
```

## 提供什么

- **能力类**：`ui-sidebar`。方法以 `ping` 为健康占位；其余方法只做**投影装配 + 反向调用**：入口 term 把 `ctx.ids` 投影切片随 `args` 传入本插件服务，服务从投影取会话 / 工作区 body，**输入槽改经 `input` owner 服务反向调用 `input.read` 取**（输入槽已出世界，不再走投影切片），再经宿主反向调用（`port.call`，见协议文档 §2.4）转给 `session` / `workspace` 端口。服务不读投影、不写世界。
- **命令**：`session.new` / `session.select` / `session.rename` / `session.delete` / `session.restore` / `session.branch` / `workspace.list` / `workspace.pick` / `workspace.add` / `workspace.remove` / `workspace.reveal` / `ui-sidebar.client.read`。每个命令一个入口 term，`eff` 到本插件自己的能力类（自能力路由，无需自引用 pin），由服务完成装配后反向调用依赖身份。
- **客户端半边交付**：`ui-sidebar.client.read`（只读命令）读本插件包内客户端半边字节（`execute/web/` 下的相对 `.js` 路径，做路径穿越防护：拒绝对路径 / 盘符 / 反斜杠 / `..` / 空段），返回 `{path, text}`。壳以 `/assets/ui/ui-sidebar.js` 同源服务，不再有 HTTP 端口与反代。
- **写类命令载荷先入槽**：`session.*` 与 `workspace.add` / `workspace.remove` 的载荷由客户端经 **`input.write` 命令**写入输入槽（`input` owner 写自有持久存储），命令无参触发；本服务经 `input.read` 取本线程槽，与当前 body 一起交给依赖服务（清槽由依赖服务经 `input.clear` 完成）。`workspace.reveal` 是纯动作，走命令 `args`（不经槽）。
- **客户端半边**：`execute/web/entry.tsx` 导出 `contract = '2'` 与 `register(ctx)`，把 React 组件注册进 `sidebar` slot；业务状态住 React-free store（`execute/web/sidebar-store.ts`），叶子纯模块（`sidebar-model` / `badges` / `width` / `export` / `messages` / `confirm`）零 react import。功能：工作区分组 + 会话列表（会话读面 = `chat.history` 返回的会话 body）+ 按工作区新建 + 就地重命名 + 添加 / 移除工作目录 + `[⋯]` 菜单（打开 / 移除 / 重命名 / 导出 / 分支 / 删除）+ 目录缺失态 + 空态；会话项状态角标（运行中 / 待审批 / 失败 / 未读）随宿主事件更新；可终止非当前线程 run（`ctx.cancel(run)`，就地二次确认）；软删 + 撤销 toast；标题本地过滤搜索；导出 markdown / JSON（客户端生成，不写世界）；底部 [设置] 写 `ctx.uiState` 的 `settings_open`、[展开|收缩]；宽度可拉伸 220–420（松手防抖经 `config.write` 命令写回 `ui.sidebar_width`，运行记录出世界）；收缩态是独立轨道布局而非宽栏裁切：只渲染品牌、添加工作目录、一枚文件夹图标（悬浮开出全量分组 flyout——顶边略下移、限高且随视口收敛，超出走内部滚动但不显滚动条；状态点聚合所有工作区——任一目录缺失红点优先，否则取全量会话最高优先级角标）与展开按钮，搜索、设置、会话行与文案类状态均不渲染；窄屏强制收缩（不引入抽屉）。
- **当前工作区同步**：会话 / 工作区载入后把 `uiState.active_workspace` 置为当前会话的 `workspace_id`（无当前会话则取列表最后一项即最近添加；无工作区置 `null`），供 composer 判定能否发送与新会话归属。
- **空态口径**：整体空态**只在没有任何工作区时**出现（`sidebar-model.isEmptyView` 只看 `workspaces`）。有工作区即渲染工作区列表——删光会话后各组为空但仍可见 / 可进入工作区，不会把工作区列表一并藏掉；搜索无结果另走「无匹配」态。

## 运行记录判定（本批出世界）

判据两问：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。两问皆否 → 运行记录，出世界。

| 数据 | 判定 | 理由 / 写口 |
| --- | --- | --- |
| 会话 / 工作区命令载荷（`session.select` 等槽体） | **运行记录（出世界）** | 用户意图信箱；回滚不该带；判定经 owner 服务读。写口 = `input.write` 命令（`input` owner 自持久化） |
| `config.ui.sidebar_width`（侧栏宽度） | **运行记录（出世界）** | 界面偏好；回滚不该带；判定不读它。写口 = `config.write` 命令（补丁 `{ui:{sidebar_width}}`） |
| 会话列表 / 工作区列表（读面） | 运行记录（owner 读） | 来自 `session` / `workspace` owner；本插件不落账 |
| `plugin.json.pins` / 方法声明 | 定义（留世界） | 装配与路由要读 |

**写口单一**：本插件不再内联构造世界 `write` directive（`identityWriteDirective` 已删）；浏览器侧
槽 / 配置写各走一个命令构造器（`execute/web/sidebar-model.ts` 的 `slotWriteCommand` / `configWriteCommand`）。
本插件是**写方**不是 owner，故不声明 `state: durable`；`config.write` / `input.write` 由各自 owner 服务提供
（`config` 服务写自有存储并镜像判定阈值，`input` 服务写槽自有存储）。

## 怎么起

宿主按 `plugin.json.start`（`node execute/main.js`）拉起本插件服务；服务经 stdio 走服务协议，并连宿主入站面做反向调用。服务不再监听任何端口。客户端半边由 `plugin.json.build`（`npm ci` + `node execute/build.mjs`，脚本内调 esbuild）产出 `execute/web/dist/entry.js`（`.worldignore` 排除，随世代重算），壳经 `ui-sidebar.client.read` 取字节后同源服务。

## 状态档

`recomputable`：本插件无世界数据（零 schema），会话 / 工作区真源分别住 `session` / `workspace` 身份，输入槽真源住 `input` 身份；本插件只读投影 / 经 owner 服务读槽、只经宿主反向调用或 owner 命令写，本身不持久化。

## 测试

```
npm test
npm run typecheck
node tools/e2e-smoke.mjs
```
