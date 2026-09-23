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
- **命令**：`session.new` / `session.select` / `session.rename` / `session.delete` / `session.restore` / `session.branch` / `workspace.list` / `workspace.pick` / `workspace.add` / `workspace.remove` / `workspace.reveal` / `ui-sidebar.client.read`。每个命令一个入口 term，`eff` 到本插件自己的能力类（自能力路由，无需自引用 pin），由服务完成装配后反向调用依赖身份。
- **客户端半边交付**：`ui-sidebar.client.read`（只读命令）读本插件包内客户端半边字节（`execute/web/` 下的相对 `.js` 路径，做路径穿越防护：拒绝对路径 / 盘符 / 反斜杠 / `..` / 空段），返回 `{path, text}`。壳以 `/assets/ui/ui-sidebar.js` 同源服务，不再有 HTTP 端口与反代。
- **写类命令载荷先入槽**：`session.*` 与 `workspace.add` / `workspace.remove` 的载荷先写输入槽（per-thread 键控），命令无参触发；服务把槽体与当前 body 一起交给依赖服务，由其返回清槽写计划。`workspace.reveal` 是纯动作，走命令 `args`（不写世界、不经槽）。
- **客户端半边**：`execute/web/entry.tsx` 导出 `contract = '2'` 与 `register(ctx)`，把 React 组件注册进 `sidebar` slot；业务状态住 React-free store（`execute/web/sidebar-store.ts`），叶子纯模块（`sidebar-model` / `badges` / `width` / `export` / `messages` / `confirm`）零 react import。功能：工作区分组 + 会话列表（会话读面 = `chat.history` 返回的会话 body）+ 按工作区新建 + 就地重命名 + 添加 / 移除工作目录 + `[⋯]` 菜单（打开 / 移除 / 重命名 / 导出 / 分支 / 删除）+ 目录缺失态 + 空态；会话项状态角标（运行中 / 待审批 / 失败 / 未读）随宿主事件更新；可终止非当前线程 run（`ctx.cancel(run)`，就地二次确认）；软删 + 撤销 toast；标题本地过滤搜索；导出 markdown / JSON（客户端生成，不写世界）；底部 [设置] 写 `ctx.uiState` 的 `settings_open`、[展开|收缩]；宽度可拉伸 220–420（松手防抖写回用户配置的 `ui.sidebar_width`）；收缩态 hover flyout；窄屏强制收缩（不引入抽屉）。

## 怎么起

宿主按 `plugin.json.start`（`node execute/main.js`）拉起本插件服务；服务经 stdio 走服务协议，并连宿主入站面做反向调用。服务不再监听任何端口。客户端半边由 `plugin.json.build`（`npm ci` + `node execute/build.mjs`，脚本内调 esbuild）产出 `execute/web/dist/entry.js`（`.worldignore` 排除，随世代重算），壳经 `ui-sidebar.client.read` 取字节后同源服务。

## 状态档

`recomputable`：本插件无世界数据（零 schema），会话 / 工作区真源分别住 `session` / `workspace` 身份，本插件只读投影、只经宿主反向调用。

## 测试

```
npm test
npm run typecheck
node tools/e2e-smoke.mjs
```
