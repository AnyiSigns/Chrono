# 宿主：载体设计

> 口径来源：`docs/kernel.md`（内核设计，唯一权威）。
> 本文是**载体设计**：载体是什么、边界在哪、有哪些写死的口径；不含实现步骤与算法伪代码。
> 本文只引用设计文档，不引用任何计划文档；插件侧见 `docs/plugins.md`。
> 内核管**一致性**，载体管**动词**；载体不认识业务，判定 / 路由 / 评分 / 门禁一律是 term。

---

## 一、载体是什么

一个进程，四个包 + 一个入口：

| 包 | 职责 | 机械边界 |
| --- | --- | --- |
| `assembly` | 装配：声明解析、`pins` 闭包与拓扑、源码物化、起停服务、握手、端点表、世代跟随 | **只读世界**；不 import `effect` / `ledger` 写口 |
| `effect` | 效果：连接与调用、通用 run loop、效果执行、`EffectAudit`、唯一写口、`results` 回灌与续跑 | 不装载、不认识插件种类 |
| `ledger` | 账本：journal 文件、`verify`、`replay`、基础世界、单写者锁 | 只按内核口径落盘 |
| `projection` | 投影：`base_only` 只读投影 | 不写 |
| `bin` | 入口 `boot`（genesis 常量） | 无逻辑 |

两条边界写死：

- `assembly` 只读世界——"不认识插件种类"由此成为 import 图上的事实，而不是文档形容词。
- **插件不 import 内核**：键 / 哈希 / 校验 / 写链全在宿主（`kernel.md` §十一 / §十八）。

**没有特权引擎**：「agent engine」不是某个插件，而是**宿主 + 全部插件 + 世界**的组合。
宿主驱动的是**通用 run loop**，不认识回合 / 图 / 编排语义；`engine` 若作为插件存在，只是一个普通服务，
宿主不给它任何特殊路径。

**自改安全**：引导器已并入宿主；自改的安全来自「**正在运行的旧实例监管下一代实例**」——
被改对象是下一代源码，执行体是当前运行实例，天然满足"不在被改对象里"。
首个宿主二进制是 **genesis 常量**；最后一个实例整体崩溃时的恢复靠外部拉起（ops，不是设计角色）。

## 二、契约面

载体吃三类输入、开一个入站面、产出一个输出，全程不解释业务语义：

- **输入 1 · 世界**：宿主侧的日志真源 + 基础世界（宿主可持有，**可为空**）→ 读 active 世代与插件声明。
- **输入 2 · 声明**：`plugin.json`（住 ① `defs`）——字段清单见 `docs/plugins.md` §二。
- **输入 3 · 平台与运行态**：本机平台 + 宿主侧运行态表（物理端点 / pid）。
- **入站面**：本地 socket（**不开 TCP**）。外部客户端（CLI / UI / 测试）与需要发起的插件在此提交任务与指令。
  宿主常驻 + 唯一写者 ⇒ 外部**只能**连宿主，没有离线提交的路。协议见 `docs/protocol.md`。
- **输出**：**端点表**「能力（能力类 / 方法）→ 服务进程 + 物理端点」，供 `effect` 调用。

端点两分（写死）：

- **逻辑端点**（能力类名 / 方法名）= `pins` 的一部分，**住世界**。
- **物理端点**（socket / 管道 / pid）= 平台相关、不可重放，**只住宿主侧 ③，绝不进世界**。

## 三、目录布局

```
Agent/
├── docs/                    设计文档；`kernel.md` 是唯一权威
├── packages/
│   ├── kernel/              内核库（纯函数、无 IO、不装载）
│   └── host/                载体：宿主（一个进程）
│       ├── bin/             入口 `boot`（genesis 常量）：`boot start|seed|verify|replay|status`
│       ├── assembly/        装配：声明解析 / `pins` 闭包 / 拓扑 / 物化 / 起停 / 端点表 / 世代跟随
│       │                    —— **只读世界**；不写链、不执行效果、不认识插件种类
│       ├── effect/          效果：连接 / 调用 / 通用 run loop / 效果执行 / `EffectAudit` / 写口
│       ├── ledger/          账本：journal 文件 / `verify` / `replay` / 基础世界
│       └── projection/      投影：`base_only` 只读投影
├── plugins/                 插件源码根；一个插件 = 一个目录 = 一个身份
│   └── <name>/
│       ├── plugin.json      声明（入世后住 ① `defs`）
│       ├── execute/         执行件源码
│       ├── terms/           term def
│       └── schema/          声明 schema
├── fixtures/
│   └── plugins/             toy 插件源码根（**仅测试 / 开发**）：形状与 `plugins/` 完全一致，
│                            seed 进临时世界，不进正式世界
├── experiment/              独立实验树（standalone，不接内核）
└── state/                   宿主侧落盘（gitignore；**永不进世界**）
    ├── world/               journal 文件 + 基础世界 —— **真源**：备份它 = 备份世界
    └── runtime/             运行态表 / 工作副本 / 锁 —— **③ 可重算**：删了重建
```

规则：

- 加插件**只加** `plugins/<name>/`；**不改** `packages/` 下任何文件。
- `boot` 不是独立角色，就是**宿主二进制入口**，命令分三类：
  - `boot start`：起宿主（**唯一写者**）。
  - **客户端命令**（连运行中的宿主）：`boot run` / `boot status`。
  - **离线命令**（宿主未运行）：`boot seed` / `verify` / `replay`。
- 装配包（`assembly`）**只读世界**，不 import `effect` / `ledger` 的写口。
- `packages/kernel` **不被任何插件 import**；插件只由 `packages/host` 装载。
- 插件之间**可以相互依赖**（写在 `pins`），但**不相互 import**：调用只写能力类名，宿主按 `pins` 路由。
- `state/` 只放宿主侧落盘，**永不进世界**，且 gitignore：
  `state/world/` 是**真源**（备份它 = 备份世界），`state/runtime/` 是**可重算产物**（③）。

## 四、数据形态

```
PluginDecl    = plugin.json 解析结果（字段见 docs/plugins.md §二）
Capability    = { cap: string, method: string }        // 调用点只写这两个
Pin           = 名 → Hash                               // 名 = 逻辑端点名；Hash = 被依赖身份的世代 payload 键（入世时由宿主解析，作者写身份名）
Endpoint      = { impl: string, gen: Hash, cap, method } → { transport, addr }   // 物理端点
EndpointTable = Map<impl+gen+cap+method, Endpoint>     // 运行态，住宿主侧 ③
RuntimeState  = { pid, transport, addr, gen }          // 运行态，永不进世界
```

## 五、设计口径（硬约束）

**路由**

- 调用点只写**能力类名 + 方法名**；term body 里是**名字**，不是哈希（规矩 A：body 里的哈希只能是业务数据值）。
- 解析基准是**发出者身份**：一个 `eff` 归属于「当前 directive 入口 def 的属主」——宿主自己构造 directive，
  所以知道属主；`eff_id` 里的 directive 下标 `i` 给出是哪一条。
- 解析路径 = 发出者 `pins`（名 → 哈希）→ def → 身份 / 世代 → 端点表。
- **端点表的键不含调用方**（`impl+gen+cap+method`）——所以换实现只改 `pins` 指向，调用方与 term 都不用改。
- `pin` 名 = 逻辑端点名（约定 = 能力类名）；同一能力类要多实现（降级链）时用**别名**，别名仍住世界。
- **纪律**：term 的 `Call` 只在本身份内的 def 之间；跨插件一律走 `eff`（否则发出者归属不明）。
- 工具名就是能力类名（`tool.<name>`），**不另设一套命名**。
- 解析不到即**拒绝**（不猜、不兜底）。

**装配**

- 闭包沿 `pins` **只读**遍历（规矩 A）；拓扑序 = 服务启动顺序（被依赖者先起）；**环 = 整体拒绝**。
- `stale()` 判定口径在 `kernel.md` §九；宿主处置一律 **fail-closed**：装配期拒绝装载该分支，
  运行期重新装配，**绝不拿旧实现顶上**。
- 握手**只查形态**（协议 / 身份 / 能力覆盖 / 状态档），不做语义校验；多出来的能力**不登记**（不扩权）；
  不过 → `not_loaded`。

**源码**

- 一个插件世代 = 一个 `commit` def（`blob` / `tree` / `commit`），tree 含
  `plugin.json` / `execute/` / `terms/` / `schema/`。
- **入世**：文件树 → `blob` / `tree` / `commit` defs → `put`，与物化互逆；源码住 ①（`kernel.md` §八）。
- 工作副本落 `state/runtime/`（③ 可重算），**永不进世界**；宿主**不认识语言、不做编译**，构建归插件的 `start`。

**效果**

- 效果一律经宿主；**审计先于业务写**（audit def → `request.ref`），**失败也落审计**。
- `eff` 的 `port` 是**逻辑名**，运行时按发出者 `pins` 解析（见「路由」）；**不改内核的 `EffRequest`**。
- 审计 def 进 ① `defs`——它要被 `ref` 指到，必须可寻址。
- `write` 的 `ref` = **触发它的那条 `eff` 的 audit 哈希**；多条 `eff` 促成同一次写时取最近一条。
- `run` 照抄 `kernel.md` §十二；**只有 `done` 才落账**；续跑同 `run_id` / `now` / `directives`，
  `results` **只增不改**。

**落账**

- **判定与落账分离**：写内容是**判定**的产物。一轮 `done` 的 `observations` 里带着 term 的求值结果
  （`{kind:'eval', entry, ok, value}`），宿主据此**原样**构造 `write` directive，由 `commit` 落账——
  内容不改，只做机械校验。
- 真实位置只认 `done` 的 `head` / `journal`；`refused` / `waiting` 观测里的 `pos` 一律作废（`kernel.md` §十二）。
- 发起者（CLI / UI / 测试）可在**入站面**直接提交 directive；**插件没有这条通道**。

**投影**

- 投影 = 宿主对世界的**只读视图**，作为 directive 的 `args` / `ctx` 交给 term；插件与 term 都不直接读世界。
- `base_only` 投影依赖宿主持有的基础世界；无基础世界时不可用。

**世代**

- 触发 = 链头推进；改**数据** → 进程不动、热生效；改**代码** → 新服务 + 旧服务 drain。
- 端点表**原子切换**；在途 run 锚定旧世代，换代只对下一个 run 生效。
- `assembly` **只跟随、不改 active**；**不做**原地热补丁（`kernel.md` §八）。

**写者**

- **同一时刻只有一个写者**；`verify` / `replay` 也持锁（日志可能正被写，读到半条会误判）。

**其它**

- 插件服务只允许持有**可重算状态（③）**；④ 不可重算状态必须显式声明。
- 密钥不进世界，厂商声明只放 `auth_ref`。
- 判定 / 路由 / 评分 / 门禁写成 term；取用 / 效果执行 / 装载在宿主（`kernel.md` §十）。
- 执行件永远不承担校验。
- 世代跟随走**宿主通知**；插件**不开世界读通道**（避免两份世界视图）。

## 六、载体不变量

1. **唯一写口**：插件服务永不写链；写只经 `effect` 的 `commit`。
2. **效果必审计**：每对 `EffRequest→EffResult` 必有 `EffectAudit` def 且被 `ref` 指到。
3. **插件间不直连**：效果一律经宿主。
4. **运行态不进世界**：物理端点 / pid 只住宿主侧 ③。
5. **不扩权**：`EffRequest.caps` 恒等于输入（内核保证；宿主不扩权）。
6. **落盘字节保真**：`Entry.args` 不重序列化。
7. **声明驱动**：`assembly` 不认识插件种类，只看声明与 `pins`。
8. **第一方无特权**：toy 服务与第三方同路。
9. **插件不 import 内核**：插件只提交内容与效果请求，不算哈希、不校验、不写链。

## 七、本设计不做什么

- 不重述内核口径：`stale()` 判定、`run` 语义、`batch` 两段式、链格式一律以 `kernel.md` 为准。
- 协议实体在 `docs/protocol.md`（服务协议 / 入站协议 / 错误码）。
- 不做原地热补丁、不做多写者、不做多链合并、不做调度、不定义审批语义。
- 不定义判定标准：门禁 / 评分 / 路由策略都是 term。
- 不含 `partial` 取用 / `snapshot` / 冷归档 / 派生索引的设计。
