# 插件规范

> 口径来源：`docs/kernel.md`（内核设计）+ `docs/host.md`（载体设计）。
> 本文只规定**插件长什么样、怎么写、怎么接**；**不规定有哪些插件**。
> 旧版「插件清单与分离规则」已作废（旧装配层口径），可从 git 历史取回。

---

## 一、什么是插件

- 一个插件 = 一个 **npm 包** = 一个身份 = 一批成员。**只有一种插件，不分内部 / 外部**。
- 成员三种，**同路无特例**：**执行件**（自带服务进程）/ **term**（判定数据）/ **声明**（`plugin.json` + `schema`）。
- **npm 只是投递信封**：世界才是真源——插件入世（`put` / `batch`）后源码进 ① 才生效；包内第三方依赖（`node_modules`）是宿主侧 ③（可重算）。
- 插件包放在哪（仓库 `plugins/<name>/` 或 `node_modules/`）**只是位置、不是分类**；宿主按 `state/plugins.json` 的 `[{name, path?}]` 解析（有 `path` 走路径、无 `path` 走 Node 解析）。
- 「agent engine」不是某个插件，而是**宿主 + 全部插件 + 世界**的组合；**没有特权插件**。

## 二、长什么样

```
<plugin-package>/                 # 一个 npm 包（仓库 plugins/<name>/ 或 node_modules/<pkg>，同形）
├── package.json     npm 信封：name / version / 依赖 / scripts（宿主不解释，入 ① 作源码）
├── plugin.json      插件契约：12 字段（宿主解释、入世进 ①；与信封无关）
├── README.md        自述（人读）
├── execute/         执行件源码（0..n）
├── terms/           term def（0..n）
└── schema/          声明 schema（0..n）
# node_modules / 构建产物 不入 ①（宿主侧 ③）
```

- **`plugin.json`（契约）与 `package.json`（信封）职责分开**：契约与信封无关（换信封仍在），故**不并入** `package.json`；
  所有插件共用**同一 `plugin.json` 形状**——这就是「一个口径」。
- **入世 = 包内源码树**（`plugin.json` + `package.json` + 锁文件 + `README.md` + `execute/` / `terms/` / `schema/`）
  **减去 `node_modules` / 构建产物**；宿主**只解释 `plugin.json`**，其余是源码 blob。
- 插件包**不得依赖 `kernel` 或其他插件包**；插件间依赖只走 `pins`（npm 依赖只管自带库，见 §三）。
- 密钥不进世界：`auth_ref` 的**字段 / 形态后置**（随首个 vendor 插件计划定）；原则（密钥走 ④ 声明、只存引用不存本体）见 `host.md` §五 其它。

`plugin.json` 字段（冻结）：

| 字段 | 含义 |
| --- | --- |
| `identity` | 身份名 = 世界里的 `id`（**无 `kind`**——内核 `Identity` 无分类字段，身份性质由 `schema` 承载，`kernel.md` §四） |
| `schema` | 身份**自述 / 数据契约**：指向包内 `schema/` 里的文件（如 `schema/plugin.schema.json`）；入世解析成 `Identity.schema` 哈希。它是**数据、非特权**（`kernel.md` §四）；宿主对 `plugin.json` 形状的元校验另有一份宿主侧 schema |
| `implements` | 提供的能力类（能力类名） |
| `methods` | 能力类 → 方法名 |
| `pins` | 身份级依赖：名（逻辑端点名）→ **被依赖身份名**；入世时由宿主解析成「被依赖身份 active 世代 payload 哈希」（**身份依赖唯一记录处**，规矩 A）。term-def 的 callee 依赖另见 `host-plan.md` A0b（已是哈希、不在此字段） |
| `start` | 启动命令（宿主不认识语言、不做编译） |
| `protocol` | 服务协议版本 |
| `restart` | 重启策略（策略 / 退避 / 上限 / window / drain_ms） |
| `health` | 健康判据（探针 / 间隔 / 超时） |
| `state` | 状态档：只允许 `recomputable`（③ 可重算） |
| `members` | 成员清单，每项带 `kind`（`execute` / `term` / `schema`）——A6 的「数据热生效 vs 代码起新服务」由此驱动，不按目录名 |
| `commands` | 命令声明：`{ name, entry, argsSchema }`——客户端按 `name` 调用，宿主解析到入口 def 并机械校验参数。`entry` / `argsSchema` 是**包内路径**，入世解析成 def 哈希（与 `schema` 同路：契约层写路径、宿主解析） |

## 三、做法红线

每条都落在 `docs/host.md` §六 的不变量上（按插件侧归并），破了就是插件没写对：

1. **不 import 内核、不依赖其他插件包**：不算哈希、不校验、不写链；键 / 哈希 / 校验 / 写链全在宿主。npm 依赖**不得**用于插件间调用（插件间只走 `pins`）。
2. **只提交内容与效果请求**：`put` / `batch` 载荷 + `EffRequest`；另有 `event` 通知（宿主只透传，不落账、不推进），**不得**用它写链或索取其他插件的端点。
3. **不与其他插件直连**：效果一律经宿主（保 `EffectAudit`）。
4. **依赖只走 `pins`，可跨插件相互依赖（但闭包必须无环）**：A 的 `pins` 写 B 的身份（名 → 身份名，入世时解析成哈希，绑定的是**身份**不是版本）；A 的代码 / term 只写**能力类名 + 方法名**，宿主按 `pins` 路由。**不 import、不共享进程内对象、不直连**；body 里出现的结构性引用（如 `Call` 的 callee 哈希）必须**同时**记入 `pins`（规矩 A）。漏写 `pins` 会静默失效。
5. **自带启动命令**：宿主只跑 `start`，不认识语言。
6. **物理端点不进世界**：由宿主分配并住宿主侧 ③。
7. **状态只允许可重算（③）**；④ 不可重算必须显式声明；密钥走 `auth_ref`（④ 声明、只存引用不存本体，见 `host.md` §五 其它），不进 `plugin.json` 明文、不进世界 body。
8. **执行件不承担校验**：校验是 term / schema，宿主机械检查。
9. **命令是具名入口**：宿主按声明路由走一次 run，不得拿命令当写链旁路；命令名不得占用宿主保留字。
10. **自带 `README.md`**：人读自述——这是什么、提供哪些能力与命令、怎么起、状态档是什么；与 `plugin.json`（机器契约）一并随包入世，缺一不可。

## 四、四条生命周期与归属

| 生命周期 | 管什么 | 归谁 |
| --- | --- | --- |
| **插件数据生命周期** | `add_identity` / `add_gen` / `set_active` / `retire` / `fork` / `graft` | 内核（唯一执行者，op 落账） |
| **插件进程生命周期** | 起 / 停 / 常驻 / 重载 / drain / 崩溃恢复 | 宿主 `assembly`（声明驱动） |
| **运行（世界）生命周期** | 世界本体 / 链头 / 取用 / 快照分界 | 内核（链 / 位置 / 摘要）+ 宿主（真源 / 本体） |
| **回合 / 会话生命周期** | `open` / `append` / `close` / `resume` | 上层（数据）+ 宿主（推进） |

插件服务「自管」只限运行中的重载 / drain；崩溃恢复由 `assembly` 按声明重启。

- 插件生命周期事件（`handshake_failed` / `cycle` / `restart_exhausted` / `service_exit` / `stale_dep`）由宿主记入**运维日志**（`state/lifecycle.log`），**不进世界、不进链、不可重放**；插件不得依赖其在世界里的存在（与 `EffectAudit` 分流，见 `host.md` §五 其它）。

## 五、换代（热更新）

| 改什么 | 机制 | 进程 |
| --- | --- | --- |
| 数据（term / 参数 / 配置） | 宿主重取 def、换缓存 | **不动** |
| 代码 | 起新服务 → 握手 → 端点表原子切换 → 旧服务 drain | 换 |

- 一次 run **锚定世代**，换代只在 **run 边界**生效。
- **不做**原地热补丁（破坏"旧世代源码还在、回滚 = 一个记账动作"，`kernel.md` §八）。
- **依赖联动（跟随 active，不锁版本）**：`pin` 绑定被依赖**身份**；B 换代 → 宿主把 A 的解析目标
  重解析到 B 的**新 active 世代**，**A 进程 / term / body 全不动**（只记一条漂移证据）。
  若 B 的新 active 装载失败 → A 被隔离（fail-closed，**绝不回落旧世代**）。
  **B 退役**（`retire` / `set_active(null)`）≠ 换代：A 及其依赖者**运行期隔离**（与装配期坏分支同口径）；只有换代才只重解析不隔离。
  要换到**另一个身份**的实现才改 `pins`（写新 A 世代，显式记账）；**降级链**用多条别名 pin（每个单值、指向另一身份、别名是目标声明的能力类），降级顺序由 term 判定、宿主不自动重试（见 `host.md` §五 路由）。
- **`pins` 闭包必须是 DAG**；成环 = 拓扑序无解，**该分支被隔离**（环成员及其依赖者 `not_loaded`，其余照常起，见 `host.md` §五 装配）。

## 六、本文不列插件清单

插件清单不属设计范畴，本文不列。回合循环由宿主**通用 run loop** + term 承担，**不设特权 engine 插件**。

## 七、插件契约（一处看全）

写一个插件 = 接受下面全部义务。每条只指权威处，不在此重述。

**交付物**（§二）

- 一个 npm 包：`package.json`（npm 信封）+ `plugin.json`（机器契约）、`README.md`（人读自述）、
  `execute/`（执行件）、`terms/`（判定数据）、`schema/`（声明 schema）。
- `plugin.json` 的 12 个字段一个不少：`identity` / `schema` / `implements` / `methods` / `pins` / `start` /
  `protocol` / `restart` / `health` / `state` / `members` / `commands`。

**行为**（§三 十条红线）

- 不 import 内核 / 不依赖插件包 · 只提交内容与效果请求 · 不与其他插件直连 · 依赖只走 `pins` · 自带启动命令 ·
  物理端点不进世界 · 状态只允许 ③ · 执行件不承担校验 · 命令是具名入口 · 自带 `README.md`。

**接口**（`docs/protocol.md` §二）

- 服务协议：`hello` / `manifest` / `call` / `result` / `error` / `reload` / `drain` / `bye` / `probe` / `pong` / `event`。
- 三条禁止：不写链、不索取其他插件的端点、不扩权。
- 一条义务：与宿主连接断开（socket 关闭 / EPIPE）即**自退出**（避免孤儿进程占端点）。

**生命周期**（§四、§五）

- 数据生命周期归内核（唯一执行者）；进程生命周期归宿主 `assembly`（声明驱动）；
  换代两档：数据热生效（进程不动）/ 代码起新服务 + 旧服务 drain。
- 一次 run 锚定世代，换代只在 run 边界生效。
