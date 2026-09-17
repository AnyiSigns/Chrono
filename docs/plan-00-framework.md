# 计划 00 · 端到端框架（装配层 + 契约）

> 口径来源：`docs/agent.md`（设计、架构与边界，唯一权威）+ `docs/plugins.md`（插件分离）。
> 本计划的中心：把**装配层**做成固定机制——按声明搭插件树，任何插件只要满足契约就能被装载运行，
> **装配层与框架代码永不因新增插件而改**。
> 本计划**不含任何插件**：引擎（`plugin/engine.core`）与所有能力插件（model、UI、context、session、
> memory、skill、evolve、panel、tool、sandbox、bench、scorer、MCP）都在框架之后，逐插件加入。

---

## 目标

搭起端到端骨架并**冻结装配层契约**。此后所有能力——**包括回合循环引擎本身**——都以插件形式加入；
插件之间可以互相依赖，装配层按声明搭树，框架不动。

## 前置

- `packages/kernel` 已存在且冻结（值层 / 归约机 / 日志 / 写口）。
- 无其他前置。

## 框架的契约面（本计划要冻结的东西）

装配层只吃三类输入、只产一个输出，全程不解释业务语义：

- **输入 1 · 声明**：世界里 `host` 的 active 世代 + 被装载插件的 `plugin.json`（声明 def）。
- **输入 2 · 依赖**：`pins`（结构性依赖的唯一记录处，规矩 A）。
- **输入 3 · 平台与缓存**：本机平台 + 构建缓存 `build/<tree-hash>/`。
- **输出**：「功能（能力类 / 工具名）→ 进程 + 方法」注册表，交宿主。

固定算法（顺序写死，不随插件变化）：

1. **解析**：读声明 → 得"要跑哪些进程、各要哪些端口、cap 表是什么"。
2. **闭包**：沿 `pins` 只读遍历 → 依赖闭包 + 拓扑序；`stale()` 判失效。
3. **构建**：源码 def 树物化 → 查构建缓存 → 未命中则编译（TS 用 esbuild、Rust 用 cargo）。
4. **装载**：spawn → `handshake` → 注入端口实现 → 产出注册表。
5. **换代**：改**数据**（term/参数/配置）换缓存即热生效、进程不动；改**代码**起新进程、旧进程 drain 退出。

不变量（破了就是框架没搭对）：

- 装配层**不认识具体插件种类**，只看声明与 `pins`；引擎 / 模型 / UI / 沙箱 / memory 一律同路。
- **新插件 = 新目录 + `plugin.json` + 成员（执行件 / term / 声明）**，不改装配层任何代码。
- 插件之间、插件内成员，依赖形式**完全一样**（都走 `pins`）。
- 调用方只写**能力类名**；具体实现由生效世代的 `pins` 决定。

## 本阶段交付

分四步 F1–F4，每步有独立出口检查；四步全绿才算框架完成。**F3 是中心**。任一步超尺度即再切，不合并。
全部验证只用 **toy 插件**（toy 端口 / toy term / toy 声明），不引入任何真实能力插件。

### F1 引导 + 宿主 + 世界

- 包：`boot`（最小 `seed` / `run` / `export` 入口）、`host`（取用 + 落盘 + 端口宿主侧 + 效果审计）。
- 身份：`host` 一个身份。
- 账本：单个 append-only journal 文件；`verify` + `replay(full)`。
- 记录：每对 `EffRequest→EffResult` 一条 `EffectAudit` def，写请求 `ref` 指向它（agent.md §3.4）。
- 出口检查：`boot seed` 后能跑完一轮 kernel 调用并落账；同输入重放逐字节一致。

### F2 账本增厚

- 分段 journal + manifest；取用三模式 `full` / `partial` / `base_only`（`partial` 三步成对）。
- `snapshot` entry + 快照本体落盘 + 旧段冷归档 + `verify(段, anchorAfter(边界))`。
- SQLite 派生索引（`storage.view` 默认实现）+ 增量重扫；启动五步。
- `plugin/storage.truth`（宿主同进程成员，对 agent 恒 `deny`）/ `plugin/storage.view`（独立进程，可换后端）。
- `config/user` 入世界（settings def）；最后已知良好检查点。
- 命令：`boot boot`（深检）。
- 出口检查：`boot boot` 全绿；`partial ≡ full`；删 `index.db` 重扫后世界逐字节复原。

### F3 装配层（中心）

- 仓库三件套 def：`blob` / `tree` / `commit`。
- 把上节"契约面"逐条落地：`plugin.json` 解析、`pins` 闭包与拓扑序、构建缓存、spawn / `handshake`、
  端口注入、「功能 → 进程 + 方法」注册表。
- 身份 `kind/name`；`add_gen` / `set_active` / `retire` 的生效路径。
- 出口检查（框架判据）：
  1. 加一个 toy 插件（纯 term 或纯声明）**不改框架即生效**。
  2. 加一个**依赖已有插件**的 toy 插件（跨插件 `pins`）也能装配，且拓扑序正确。
  3. 改 toy 插件的**数据**（term / 参数）热生效、进程不动；改**代码**走新进程 + drain。
  4. `host` 身份装配跑 `--version`。

### F4 端口机制（宿主侧）

- `eff` → 宿主执行 → 审计 def → 回灌 `results` → 同 `run_id`/`now`/`directives` 续跑 → `done`。
- 用一个 **toy 端口插件**（toy 能力类）验证注入与调用；只做机制，不引入真实端口实现。
- 出口检查：
  1. toy 端口插件被注入并调用成功；换另一个 toy 端口实现，**调用方与 term 不改**。
  2. 挂起 → 审计 → 回灌 → 续跑 → `done`，逐字节可重放。
  3. 每回落账可校验（`EffectAudit` def + `ref`）。

## 本阶段口径（硬约束）

- 判定 / 路由 / 评分 / 门禁写成 term；回合推进 / 取用 / 效果执行在宿主（agent.md §2 A3）。
- 执行件永远不承担校验（agent.md §4.2）。
- `Entry.args` 落盘字节保真，禁止 parse→stringify、按字段重建、丢未知字段（agent.md §3.4 / §4.4）。
- 密钥不进世界，厂商声明只放 `auth_ref`（agent.md §4.1 / §4.3）。
- 跨插件依赖只走 `pins`（规矩 A）；闭包 = 宿主沿 `pins` 只读遍历。

## 出口验收

1. `boot seed` 后能跑通一个 toy 任务（toy term + toy 端口），落账可校验。
2. 重放逐字节一致：`replay(full)` 得同一 `H(world)`；`partial ≡ full`。
3. 删 `index.db` 重扫后世界与索引视图逐字节复原。
4. **契约判据**：新增两个**从未见过**的 toy 插件（一个独立、一个跨插件 `pins` 依赖）→ 只写插件、
   不改框架 → 均被正确装配并生效。
5. **端口判据**：换 toy 端口实现不改调用方、不改 term。

## 范围红线

- 不实现**引擎**（`plugin/engine.core`，含回合循环与编排）。
- 不实现任何能力插件：model / UI / context / session / memory / skill / evolve / panel / tool / sandbox /
  bench / scorer / MCP。
- 不做：流式、多模态、向量检索、多设备 / 多用户同步、存储迁移。
- 不把任何判定写进宿主或装配层代码。
- 不给第一方插件开特例（`plugin.json` / `pins` / `schema` 与第三方同路）。

## 框架之后：逐插件

框架验收全绿后，后续工作**逐插件**推进，每个计划 = 一个插件（或一组），只依赖本计划冻结的契约；
插件之间靠 `pins` 依赖，装配层按声明搭树，调用方只写能力类名。插件清单见 `docs/plugins.md`。

| 计划 | 加什么插件 | 前置 |
| --- | --- | --- |
| `plan-01` | model 三层链（protocol / adapter / vendor）+ `config` / `credential` + 降级链 | 00 |
| `plan-02` | ui 通道（`ui.terminal` / `ui.plain`） | 00 |
| `plan-03` | `engine.core`（回合循环 + `agent/executor` 角色） | 01、02 |
| `plan-04` | `tool/*` + `sandbox/rust`（`exec` / `fs`） | 03 |
| `plan-05` | `session.store` | 03 |
| `plan-06` | `context.budget` | 03、05 |
| `plan-07` | `memory.fts` | 03、05 |
| `plan-08` | `skill.crystallize`（结晶） | 07 |
| `plan-09` | `bench/*` + `scorer/*` | 04 |
| `plan-10` | `evolve.proposer`（含 `approval` 分级） | 09 |
| `plan-11` | `panel.agent`（面板内容） | 02、10 |
| `plan-12` | `mcp.client` | 03 |
| `plan-13` | 自改宿主（非插件：host 源码入世 + 回退） | 03–12 |

每个插件计划只写：插件目录 + `plugin.json` + 成员（执行件 / term / 声明）+ `pins` + 该插件验收；
**不改** `boot` / `host` / `assembly` 的框架代码。引擎后续世代按 `pins` 逐个接入新插件，
接入即 `engine.core` 的一次 `add_gen`，不改装配层。

## 单次会话可完成

按 F1 → F2 → F3 → F4 逐片提交，每片单独会话、单独验收。F1/F2 是账本向，F3/F4 是装配向；
F3 若超尺度，按 **声明解析 / `pins` 闭包 / 构建缓存 / spawn 与注入** 再切。
