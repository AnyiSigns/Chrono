# ui-approval（审批停靠带）

Chrono 的**审批停靠带**：`dock` 槽子应用，展示待审批队列（计数 / 等待计时 / 整批裁决），
按条目种类选卡片模板并提交裁决。独立包 / 独立进程；客户端半边注册进壳的单一 React 运行时，
事件经壳事件总线（`api.events`）订阅。本插件不做判定、不做审批流程本体、不做对话视图。

- 能力类：`ui-approval`（`ping` 健康占位 + `list` / `decide` / `decide_all` 三个服务方法
  + `client.read` 客户端半边交付方法；UI 插件统一 `ui-<身份名>`、互不 pin）。
- `pins`：`{"approval":"approval","input":"input"}` —— 服务经**宿主反向调用**（`port.call`）调
  `approval`（队列 / 裁决，自有存储）与 `input`（读写本线程裁决槽）；服务进程本身不读投影。
- 状态档：`recomputable`（③ 可重算；无世界数据，**零 schema** —— 省略 `plugin.json.schema`，
  宿主提供最小默认 def）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 自带构建：`plugin.json.build` 声明 `npm ci` + `esbuild` 打包客户端半边，产物落
  `execute/web/dist/entry.js`（随世代产物，由 `.worldignore` 排除、不入世）。

## 提供哪些命令

| 命令 | 入口 term | 语义 |
| --- | --- | --- |
| `approval.list` | `eff ui-approval list`（读 `ctx.ids`） | 反向调 `approval.list`（队列读其自有存储），结果即命令结果；附影子指标 body（只读，不构造写） |
| `approval.decide` | `eff ui-approval decide`（无投影） | 经反向调用读本线程 `approval.decide` 槽 → 反向调 `approval.decide` → 拼续跑计划 → 清槽 |
| `approval.decide_all` | `eff ui-approval decide_all`（无投影） | 对全部 `pending` 项给同一 verdict，其余同单条 |
| `ui-approval.client.read` | `eff ui-approval client.read`（Var 0 = 命令 args） | 只读：按包内相对 `.js` 路径读 `execute/web/` 下产物，回 `{path, text}` |

- **队列已出世界**：`approval` 队列项与 resume 游标住其自有持久存储；本插件不再从投影读队列切片。
- **裁决槽属 `input` 服务**：`decide` 经反向调用 `input.read` 取本线程槽、`input.clear` 清槽（槽是运行记录，不进世界）。
- **裁决续跑计划**：服务反向调审批端口拿到其 `extern`（含各被裁决项的 `resume` 游标）后，拼顶层 `$directives` =
  `[…审批 extern, eval(command:'chat.resume', args:{cursor, thread, payload:{verdict}}, inject:{ids:['ids']})…]` ——
  **审批写在前**（裁决已即时落 owner 存储），续跑条目按被裁决项逐条产（每项各自游标 / 线程）接在其后。
  宿主遇任一非 done 轮即丢弃剩余指令，若续跑排在前，续跑一失败（如未配置模型）整批收口、用户裁决被静默吞掉。
- **续跑投影由宿主注入**：续跑 eval 带 `inject:{ids:['ids']}`，由宿主执行期把投影片段并入 args（续跑不再自带整份投影）。

## 客户端半边（契约 v2）

- 源码 `execute/web/entry.tsx`：导出 `contract = '2'` 与 `register(ctx)`；`register` 把组件注册进
  `dock` 槽（`ctx.slots.register({name:'dock'}, Component)`）。
- 业务状态住 React-free store（`execute/web/store.ts`）：`{getSnapshot, subscribe, …}`，网络 / 事件
  全经壳 `ctx`（`command` / `events`），React 只渲染。
- **槽写入走命令**：裁决前先 `ctx.command('input.write', {thread, slot})` 写本线程输入槽（`input` 服务自有存储），
  再调无参裁决命令；不再构造世界写 directive。
- 叶子纯模块 `execute/web/model.ts`（模板选择 / 摘要视图 / 影子指标 / 计时格式 / 二次确认状态机 /
  verdict 映射 / 最老待审批项）与 `execute/web/messages.ts`（文案兜底）：零 `react` import、可直测。
- 构建产物 `execute/web/dist/entry.js` 由 `.worldignore` 排除，`host.source.read` 读不到，
  故经只读命令 `ui-approval.client.read` 由插件自交付；壳按 `/assets/ui/ui-approval.js` 同源服务。
- **路径穿越防护**：`client.read` 只接受包内相对 `.js` 路径，拒绝绝对路径 / 盘符 / 反斜杠 / `..` /
  空段 / 非 `.js`。

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
- **槽写入**：裁决前先写输入槽（`{kind:'approval.decide', id?, verdict}`，缺 `id` = 整批），
  **per-thread 键控**——只覆盖 `item.thread` 对应的键（缺省 `_main`），其余线程键原样保留；
  提交后等服务侧确认写 run 收口，再调无参命令。
- **失败**：裁决失败在该条行内收口（danger 文字 + [重试]），条目仍留在停靠带。
- **层级 / 质感**：停靠带用 `--z-dock`、薄玻璃（全局唯一例外，`--c-glass` + `backdrop-filter`，
  不支持时降级实色）；出入 200ms，最大高 40vh、超出内滚；无待审批项时不占高度、不渲染。
- **堆叠卡片**：`execute/web/styles.ts` 由组件注入 `<style>`（只引壳 token、零硬编码色值）；
  队列渲染为卡片堆叠——非首卡 `margin-top` 负偏移、`nth-child` 递减 z-index 让前卡压在深卡之上，
  按 `kind` 左侧色条（tool_call 警示 / plugin_write 危险 / orchestration_change 信息）。
- **位置**：`.approval-root` 与 `.composer-root` 同盒（`max-width: --msg-max-w` 居中 + 两侧 `space-16`），
  故停靠带恒在对话输入框正上方、左右边缘对齐；`dock` 槽本就位于 main 与 composer 之间。
- **键盘可达 / aria**：`role="region"` + `aria-label`；展开按钮 `aria-expanded` / `aria-label`；
  危险动作补 `aria-label`；`aria-live="assertive"` 播报待审批计数。

## 运行

```sh
npm install                       # 安装构建依赖（esbuild）并生成 lockfile
npm test                          # 纯函数模型 + 服务装配 / 协议 + 客户端半边契约测试（node --test）
npx tsc --noEmit                  # 客户端半边类型门禁
node tools/e2e-smoke.mjs          # 宿主装配冒烟（pack → seed → start → 声明核对 → 交付 → stop → verify）
```

## `.worldignore`

声明 `test/`、`tools/` 与 `execute/web/dist/` 不入世界；其余（`plugin.json` / `package.json` /
`package-lock.json` / `README.md` / `execute/`（含 `execute/web/` 源码）/ `terms/`）随源码入世。
本插件无世界数据、零 schema，故无 `schema/` 目录。
