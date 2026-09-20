# #26 `guard`（工具调用语义门）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 26 / `guard` |
| 职责 | 工具调用语义门（纯函数）：产 `allow` / `escalate` / `deny` 三值——`escalate` = 「工作区外 / 危险操作」升级弹卡；`deny` = 未声明能力 / 被可见性过滤的身份 / 明确禁止的调用（4 档的 fs 强制归 #25 `sandbox`） |
| 依赖 | `+` 2（当前档 `permission` 由调用方入口 term（#27 `dispatch`）读 `ctx.ids.config.body.permission` 后经 bag 传入；本插件服务**不读投影**，D8）；`<-` 27（pins） |
| 成员 | execute, schema |
| 能力类·方法 | `implements: ["guard"]`，`methods: {guard:["judge"]}`（`judge` -> `allow` / `escalate` / `deny`） |
| 命令 | 无 |
| schema | `schema/guard.json`（「危险」启发式规则 / 工作区外判据；**策略数据、可热改**） |
| 机制 | `judge(bag)` 纯函数：入参 = 调用描述 + 当前档 + `bag.workspace_root` -> 出 `allow` / `escalate`（升级到 #32/#39 弹卡）/ `deny`（未声明能力 / 被可见性过滤的身份 / 明确禁止的调用）；**不发起 eff、不等待、不阻塞**（不取时间、不用随机，保可回放） |
| 边界 | 不做：fs 范围强制（归 25）/ 审批 UI（归 39）/ **等待审批（不等 32）** / 具体工具语义（归 28–31）/ 编排（归 33）/ 权限规则编辑（候选「权限规则」）；`deny` 只判、不执行，执行与副作用归 #27 / #25 |
| 验收 | 1) 升级判定确定可回放；2) 同输入同输出；3) `escalate` / `deny` 时调用方拿不到可执行结论（`escalate` 等 #33 编排、`deny` 直接拒）；4) `deny` 覆盖未声明能力 / 被可见性过滤的身份 / 明确禁止的调用；5) 换判定实现不改 27 |
| 状态 | 本轮定案：**4 档做进 #25 `sandbox`**（fs 强制），本插件收窄为**只判 `allow` / `escalate` / `deny`**（不执行、不等待）；审批闭环无 `26 <-> 32` 环——`26 -> 27 -> 32 -> 39 -> 33`（入队 / 等待 / 抉择后继续全部由 #33 编排） |

## 默认启发式（住 `schema/guard.json`，可热改）

- **工作区外**：写 / 删除 / 重命名落在 `bag.workspace_root` 之外 → `escalate`；**读也一并升级**（区外即超出 #25 `severe` 的默认范围，读写都依赖沙箱，见 `plugins/tool-fs/DESIGN.md`「区外读写」）。
- **危险操作模式**：递归删除、提权 / 改权限、管道下载后执行、改注册表 / 系统服务、格式化 / 分区、持久化改环境变量 → `escalate`。
- **外部 MCP 工具调用**（2026-09-19 新增）：调用 port = `mcp` 的工具（外部 MCP 服务器提供，不经 #25、以宿主权限运行）→ **默认 `escalate`**（外部 MCP 服务器可执行任意内容，是已知安全破口的补偿）；`auto` 档直落（同既有四档口径）。
- **网络出站**：到非白名单域按 schema 开关（默认不判网络，交 #25 `caps.net`）。
- 判定只读「调用描述 + 当前档 + `workspace_root`」，纯函数、不取时间 / 随机，保可回放。

> **与 #25 的分工**：`#25` 按档**强制**「实际能做什么」（auto 全过 / severe 工作区 RW / review 工作区只读 / deny 全拒），并消费批准后的**一次性 `caps.grant`**；`#26` 判「这次调用是否危险 / 越出工作区」→ 决定**要不要弹卡**（仅在 severe 档有意义）。**「危险 / 越界」定义由 #26 独占（`schema/guard.json`）**；#25 不读该定义、只按 caps 与 grant 强制（原「两者共用 guard.json」口径作废——#25 无法读他身份 schema）。

## 结构变更判为高危（本轮登记）

除工具调用外，本插件还判**两类结构写**为高危（产 `escalate`）：

| 类型 | 触发 | 为什么高危 |
| --- | --- | --- |
| **编排变更** | #45 `orchestration.propose` 的采纳（改 #33 的 `graph` / `contracts` / `nodes` / `links`） | 改的是编排本身，坏了影响**后续所有回合**；且 #33 的图层隔离靠 term 强制，写坏即自锁（回滚入口须在图外） |
| **插件源码写** | #42 `plugin.write`（改世界源码 → 代码换代） | 换代失败即该分支 **fail-closed 隔离、绝不回落旧世代**；且可削弱受保护 `pins` |

- 判据住 `schema/guard.json`（策略数据、可热改），按**调用描述里的 `(port, 工具名)`**机械判，
  本插件**不认识 #33 的图 schema**（那会越界）——只认"这次调用打到 `(plugin-admin, plugin.write)` /
  `(orchestration-admin, orchestration.propose)`"（**port = 实际提供者能力类名 = 身份名**，经 #27 `invoke` 派发；
  **实际派发键 = `port` + `method:"invoke"`，工具名在 `args.tool`**；机械键是 `(port, 工具名)`、**不是 `port/method`**；2026-09-19 与 #27/#32 口径对齐——早期写的 `orchestration.propose` / `plugin.write` 不是真实派发键）。
- 与工具调用同一出口：产 `escalate` 即由 `#33` 编排入队（`26 -> 27 -> 32 -> 39 -> 33`），本插件不等待。
- **`auto` 档直落**（与既有四档一致，不新造档位）；其余档位一律弹卡。
- **#33 侧另有一条机械闸**（「审批段不可绕过」）：声明了 `fs` 写 / `exec` / `plugin.write` /
  `orchestration.propose` 的 Scope，其可达路径上必须存在 `guard → approval` 段，否则**写期拒**。
  ⇒ 图不能靠删掉本插件节点来静默降档。两条是**互补**的：本插件判"这次要不要弹"，#33 机械闸保证"弹的机会不被删掉"。

## 跨插件登记

- **#25 sandbox**：分工见上（本插件独占「危险 / 越界」定义，#25 独占 fs 强制与 `caps.grant` 消费）。
- **#27 tools**：pin 本插件，派发前调 `judge`。
- **#32 approval / #39 ui-approval**：`escalate` 后的入队与裁决；新增待审批种类"编排变更"。
- **#33 loop-policy**：编排审批往返；本插件只产判定不等待。**新增**：本插件对 `(orchestration-admin, orchestration.propose)` /
  `(plugin-admin, plugin.write)` 产 `escalate`，与 #33 的「审批段不可绕过」不变量配套（#33 不变量 4 里的 `plugin.write` / `orchestration.propose` 为**意图层**写法，机械判据以本文件的实际 `(port, 工具名)` 为准）。
- **#45 `orchestration-admin` / #42 `plugin-admin`**：两个管理面的写都经本插件判高危。