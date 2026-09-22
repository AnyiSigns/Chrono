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

- **能力类**：`ui-sidebar`。方法以 `ping` 为健康占位；其余方法只做**投影装配 + 反向调用**：入口 term 把 `ctx.ids` 投影切片随 `args` 传入本插件服务，服务从中取出输入槽（per-thread 键控，缺省 `_main`）与会话 / 工作区 body，再经宿主反向调用（`port.call`，见协议文档 §2.4）转给 `session` / `workspace` 端口。服务不读投影、不写世界。
- **命令**：`session.new` / `session.select` / `session.rename` / `session.delete` / `session.restore` / `session.branch` / `workspace.list` / `workspace.pick` / `workspace.add` / `workspace.remove` / `workspace.reveal`。每个命令一个入口 term，`eff` 到本插件自己的能力类（自能力路由，无需自引用 pin），由服务完成装配后反向调用依赖身份。
- **写类命令载荷先入槽**：`session.*` 与 `workspace.add` / `workspace.remove` 的载荷先写输入槽（per-thread 键控），命令无参触发；服务把槽体与当前 body 一起交给依赖服务，由其返回清槽写计划。`workspace.reveal` 是纯动作，走命令 `args`（不写世界、不经槽）。
- **前端子应用**：`GET /entry.js` 导出 `mount(root, api) -> {unmount()}`。工作区分组 + 会话列表（会话读面 = `chat.history` 返回的会话 body）+ 按工作区新建 + 就地重命名 + 添加 / 移除工作目录 + `[⋯]` 菜单（打开 / 移除 / 重命名 / 导出 / 分支 / 删除）+ 目录缺失态 + 空态；会话项状态角标（运行中 / 待审批 / 失败 / 未读）随宿主事件更新；可终止非当前线程 run（`api.cancel(run)`，就地二次确认）；软删 + 撤销 toast；标题本地过滤搜索；导出 markdown / JSON（客户端生成，不写世界）；底部 [设置] 写 `api.uiState` 的 `settings_open`、[展开|收缩]；宽度可拉伸 220–420（松手防抖写回用户配置的 `ui.sidebar_width`）；收缩态 hover flyout；窄屏强制收缩（不引入抽屉）。

## 怎么起

宿主按 `plugin.json.start`（`node execute/main.js`）拉起本插件服务；服务经 stdio 走服务协议，经本地 socket 连宿主入站面，另在 `127.0.0.1` 监听子应用端口（默认 `8791`，`CHRONO_UI_PORT_UI_SIDEBAR` 可覆盖）。浏览器不直连本端口，壳反代 `/p/ui-sidebar/*`。

## 状态档

`recomputable`：本插件无世界数据（零 schema），会话 / 工作区真源分别住 `session` / `workspace` 身份，本插件只读投影、只经宿主反向调用。

## 测试

```
npm test
node tools/e2e-smoke.mjs
```
