# 宿主：载体设计

> 口径来源：`docs/kernel.md`（内核设计，唯一权威）。
> 本文是**载体设计**：载体是什么、边界在哪、有哪些写死的口径；不含实现步骤与算法伪代码。
> 本文只引用设计文档，不引用任何计划文档；插件侧见 `docs/plugins.md`。
> 内核管**一致性**，载体管**动词**；载体不认识业务，判定 / 路由 / 评分 / 门禁一律是 term。

---

## 一、载体是什么

载体 = 宿主，**一个进程、四个包**：

| 包 | 职责 | 机械边界 |
| --- | --- | --- |
| `assembly` | 装配：声明解析、`needs` 闭包与拓扑、源码物化、起停服务、握手、端点表、世代跟随 | **只读世界**；不 import `effect` / `ledger` 的世界写口 |
| `effect` | 效果：连接与调用、通用 run loop、效果执行、`EffectAudit`、**世界写口**、`results` 回灌与续跑 | 不装载、不认识插件种类 |
| `ledger` | 账本：journal 文件、`verify`、`replay`、基础世界、**世界单写者锁** | 只按内核口径落盘 |
| `projection` | 投影：`base_only` 只读投影 | 不写 |

**载体是中转站，不是总账房**：它转发调用、解析 `needs` 绑定、管依赖与装配、按声明划地盘，**不拥有系统里的全部写入**。系统只有**写入落点**（见 §五「写入落点」），没有"唯一写口"这个全局概念：世界那一处由载体独占写（`journal` 是单链 + `expect_pos` CAS，物理上只容一个写者，且写必经内核四步校验），运行数据那一处由 owner 插件自己写，旁路各有其处。**写者唯一是各落点各自的性质**，不等于载体垄断一切写入——后者会让载体去管本不该它管的数据。

不在载体里的两个包：`packages/boot`（CLI 薄壳，**genesis 常量**）与 `packages/client`（入站面客户端库）。

两条边界写死：

- `assembly` 只读世界——"不认识插件种类"由此成为 import 图上的事实，而不是文档形容词。
- **插件不 import 宿主与内核**（`packages/host` / `packages/kernel`）：键 / 哈希 / 校验 / 写链全在宿主（`kernel.md` §十一 / §十八）。
- **「不认识」双向且只在实现面**：宿主不认识插件种类（只读声明与 `needs`），插件不认识宿主实现（不 import）；**契约面双向都认识**——宿主认识 `plugin.json` 与协议，插件认识协议帧 / 能力类名 / 保留类 `host`。插件对宿主的唯一合法依赖通道 = **线协议 + `needs`**（含 `host`），不存在源码依赖通道。

**没有特权引擎**：「agent engine」不是某个插件，而是**宿主 + 全部插件 + 世界**的组合。
宿主驱动的是**通用 run loop**，不认识回合 / 图 / 编排语义；`engine` 若作为插件存在，只是一个普通服务，
宿主不给它任何特殊路径。

**自改安全**：引导器是宿主的一部分；自改的安全来自「**正在运行的旧实例监管下一代实例**」——
被改对象是下一代源码，执行体是当前运行实例，天然满足"不在被改对象里"。
首个 `boot` 二进制是 **genesis 常量**；最后一个实例整体崩溃时的恢复靠外部拉起（ops，不是设计角色）。

## 二、契约面

载体吃四类输入、开一个入站面、产出一个输出，全程不解释业务语义：

- **输入 1 · 世界**：宿主侧的日志真源 + 基础世界（宿主可持有，**可为空**）→ 读 active 世代与插件声明。
- **输入 2 · 声明**：`plugin.json`（住 ① `defs`）——字段清单见 `docs/plugins.md` §二。**npm 只是投递信封**；宿主只解释 `plugin.json`，`package.json` 等其余包内文件是源码 blob。
- **输入 3 · 插件包来源**：目录发现（扫 `plugins/*/plugin.json`）为主，`state/plugins.json`（③，gitignore）为**可选覆盖**——清单项 `[{name, path?, exclude?}]`：有 `path` 按路径解析（非标准路径 / toy），无 `path` 走 Node 解析（`node_modules`），`exclude: true` 从并集里移除同名目录。二者取并集，同名以清单项优先；清单缺失即纯目录发现。
- **输入 4 · 平台与运行态**：本机平台 + 宿主侧运行态表（物理端点 / pid）。
- **入站面**：本地 socket（**不开 TCP**，落在 `state/sock/`）。外部客户端（CLI / UI / 测试）与**以客户端身份连接的插件**
  在此提交 directive 与命令。宿主常驻 + **世界写者唯一** ⇒ 要改世界只能连宿主，没有离线提交的路。协议见 `docs/protocol.md`。
  **受理后错误收口**：`submit` / `command` / `forward` 先回 `accepted{id, run}`；若其后起 run 阶段失败，宿主按**原请求 `id`** 回 `error` 帧（该 run 以真实错误码收口，不再推 `result`）。客户端一次 run 的等待上限与单帧请求超时分开（`runTimeoutMs`），不按单次调用口径判。
  **入站畸形帧**：可配对（`id` 为字符串）但 `v` / `kind` 缺或类型错 → 回 `error{bad_directive}`，不静默丢弃；协议上无法配对（不可解码 / 无 `id`）→**断开该连接**并记 `host` `invalid_frame` 运维事件，不影响其它客户端。
- **服务协议面**：宿主 spawn 服务时接管其 **stdin/stdout**（stdio）；协议帧走 stdout、**日志走 stderr**——**无地址要传**（`docs/protocol.md` §一 / §二）。
  **握手前自发帧**：服务可在 `hello` 前自发帧（如 `inproc` 工厂同步 `emit`），宿主通道层在消息回调就绪前**有界缓冲**、就绪后按原序投递，超上限按协议损坏收口（`MAX_PENDING_FRAMES`）。
  **写端背压与在途上限**：stdio 以 `stdin.write` 返回 false 即停写、等 `drain` 续写（遵背压、帧序不乱），并以在途帧上限兜底；worker 的 `postMessage` 无原生背压，按「自上次收到服务帧以来投出的帧数」计在途、超 `MAX_OUTBOUND_FRAMES` fail-closed。
- **输出**：**端点表**「能力（能力类 / 方法）→ 服务进程 + 物理端点」，供 `effect` 调用。

端点两分（写死）：

- **逻辑端点**（能力类名 / 方法名）= `needs` 绑定的一部分，**住世界**。
- **物理端点**（socket / 管道 / pid）= 平台相关、不可重放，**只住宿主侧 ③，绝不进世界**。
- **服务物理端点 = 子进程的 stdio**（宿主 spawn 时接好 stdin/stdout 管道）——**无地址要传**；入站面另用本地 socket（见上）。

## 三、目录布局

```
Chrono/
├── docs/                    设计文档；`kernel.md` 是唯一权威
│   └── plans/               计划文档（不参与设计口径）
├── packages/
│   ├── kernel/              内核库（纯函数、无 IO、不装载）
│   ├── client/              入站面客户端库：connect / submit / command / 收 event
│   ├── boot/                CLI 薄壳（genesis 常量）：start 与离线命令 → host；run / status / 命令 → client
│   └── host/                载体：宿主（一个进程）
│       ├── assembly/        装配：声明解析 / `needs` 闭包 / 拓扑 / 物化 / 起停 / 端点表 / 世代跟随
│       │                    —— **只读世界**；不写链、不执行效果、不认识插件种类
│       ├── effect/          效果：连接 / 调用 / 通用 run loop / 效果执行 / `EffectAudit` / 写口
│       ├── ledger/          账本：journal 文件 / `verify` / `replay` / 基础世界（分片 + 按需加载） / 单写者锁
│       └── projection/      投影：`base_only` 只读投影
├── plugins/                 插件包的源码位置（一个插件 = 一个 npm 包；**仅位置、非分类**）
│   └── <name>/              npm 包
│       ├── package.json     npm 信封（宿主不解释；入 ① 作源码）
│       ├── plugin.json      插件契约（宿主解释；入世后住 ① `defs`）
│       ├── README.md        自述（人读）
│       ├── .worldignore     入世排除表（可选；宿主读，自身不入 ①）
│       ├── test/            测试（在包目录跑，不入 ①）
│       ├── execute/         执行件源码
│       ├── terms/           term def
│       └── schema/          声明 schema
├── templates/plugin/        模板插件（作者从该目录拷贝起手；在 `plugins/` 外，故不被目录发现加载）
├── node_modules/            已安装的包：宿主解析插件包（③ 投递；入世后源码进 ①）；无 `path` 的清单项经 Node 解析落到此处
├── fixtures/
│   └── plugins/             toy 插件（**仅测试 / 开发**）：与 `plugins/` 同形的 npm 包，
│                            seed 进临时世界，不进正式世界
├── experiment/              独立实验树（standalone，不接内核）
└── state/                   宿主侧落盘（ignore；**永不进世界**）
    ├── world/               **定义真源**：插件代码世代 / 声明 / 绑定 / 阈值 / 判定数据
    │   │                    源码的**声明与内容身份**在此（`commit` / `tree` / blob 指针 def），**字节本体**在 `blobs/`
    │   │                    ⇒ 回滚插件 = `set_active` 指回旧世代，兑现前提是此处指针 def 与 `blobs/` 字节都在
    │   │                    写者 = 载体独占（单链 + CAS）；写必经内核四步校验
    │   ├── journal.jsonl    快照起的尾段（append-only）
    │   ├── base.json        基础世界索引（快照位置 + 摘要 + ids + def 哈希清单 + 分片参数；③ 可重算）
    │   ├── defs/            基础世界 def body 分片 `defs/<gen>/<prefix>.jsonl`（按哈希前缀分片；读时按需加载）
    │   └── cold/            冷段归档 `seg-<first>-<last>.jsonl`（快照前的前缀；移出 ≠ 删除）
    ├── data/                **运行记录真源** `data/<id>/`（④ 不可重算）：对话 / 输入槽 / 审批 / 工具结果 / 待办 / 界面配置 / 记忆
    │                        写者 = owner 插件自己（引擎自选）；载体只建目录 + 注入路径，**不读不校验不迁移**
    ├── blobs/               源码字节本体 `<sha256>`（④ 不可重算；内容寻址、**只增**、离线可达性回收）—— 与 `assets/` 机械同构、保留策略不同
    │                        写者 = 载体（入世 / `host.blob.put`）
    ├── assets/              资产字节本体 `<sha256>`（④ 不可重算）—— **备份世界 ≠ 备份字节**，须一起备份
    │                        写者 = 载体（入站 / 服务侧 `asset.put`）
    ├── audit/               效果审计旁路侧存（不进世界、不进链、不参与重放）；写者 = 载体
    │   ├── audit.jsonl      审计记录（单文件追加 + 上限压实；有界保留窗口见「效果」）
    │   └── meta.json        历史审计回填标记（`{backfilled, throughEntrySeq}`；缺省视为未回填）
    ├── lifecycle.log        载体生命周期运维日志（JSONL、逐行原子写；不属 ①②③④，见「其它」）；写者 = 载体
    ├── secrets.local.json   密钥本体（`0600`；不进世界 / 不进审计 / 不进重放，见「宿主扩展面」）；写者 = 载体
    ├── plugins/             插件可重算缓存 `plugins/<id>/`（索引 / 水位）—— **③ 可重算**：删了重建；写者 = owner 插件
    ├── runtime/             运行态表 / 工作副本 / 锁 —— **③ 可重算**：删了重建；写者 = 载体
    ├── deps/                依赖 / 构建缓存（由 `decl.build` / `decl.start` 安装；npm 缓存 `state/deps/npm`、Rust `state/deps/cargo-target`）—— **③ 可重算**：删了重建
    ├── plugins.json         插件包清单（可选覆盖）`[{name, path?, exclude?}]`：有 path 走路径、无 path 走 Node 解析、exclude 从发现并集移除（宿主侧配置，不进世界）
    └── sock/                入站面 socket —— 平台相关、不可重放；写者 = 载体
```

规则：

- **一个插件 = 一个包**（`package.json` **信封**；**npm 只是信封、语言自由**——Rust 等非 JS 包同形，见 `plugins.md` §三 与「宿主扩展面 · 非 TS 插件物化」）（**不分内部 / 外部**；放哪只是位置）。各包自带依赖目录 / 锁文件（`node_modules` / `target/` / 二进制），**仓库无根 workspace**。
  加插件**不改** `packages/` 下任何文件；同一 `plugin.json` 契约；要加载哪些包由目录发现给出，`state/plugins.json` 只作可选覆盖（路径覆盖 / `node_modules` 解析 / 显式排除）。
- `boot` 是**唯一入口的薄壳**（genesis 常量），命令分三类：
  - `boot start`：起宿主（持**世界单写者锁**）。
  - **客户端命令**（连运行中的宿主）：`boot run` / `boot status` / `boot stop` / `boot <命令>`。
  - **离线命令**（宿主未运行）：`boot seed` / `pack` / `verify` / `replay` / `compact` / `unseeded` / `assets gc` / `blobs gc` / `materialized gc`。
- 连入站面的代码只有一处：`packages/client`；CLI 与"两身份"的前端插件共用它。
- 装配包（`assembly`）**只读世界**，不 import `effect` / `ledger` 的世界写口。
- `packages/kernel` / `packages/host` **不被任何插件 import**、也不是任何插件包的依赖；插件只由 `packages/host` 装载（服务经 stdio 协议、客户端经入站面协议认识宿主，**不经源码 import**）。
- 插件之间**可以相互依赖**（写在 `needs`），但**不相互 import**、**不互相作 npm 依赖**：调用只写能力类名，宿主按 `needs` 路由。
- `state/` 只放宿主侧落盘，**永不进世界**，且 gitignore。三类分清（每项的写者见上方目录树）：
  - **不可重算真源（必须备份）**：`world/`（定义）、`data/`（运行记录）、`blobs/`（源码字节）、`assets/`（资产字节）。
    **备份 = 这四项**：仅备份 `world/` 既不等于备份世界（源码字节在 `blobs/`），也不等于备份系统（运行记录在 `data/`）。
  - **可重算产物（删了重建）**：`plugins/`、`runtime/`、`deps/`。
  - **旁路与本机件**：`audit/`（有界保留）、`lifecycle.log`（运维取证）、`secrets.local.json`（密钥本体）、
    `plugins.json`（投递清单）、`sock/`（平台相关、不可重放）。旁路件丢失会损失取证与查询，不损坏世界与运行记录。
- **写者归属看落点，不看层级**：`data/` 与 `plugins/` 由 owner 插件写，其余由载体写。载体对插件的两个目录只做
  **建目录、注入路径、按身份回收、备份归属**四件机械事，不读内容、不校验格式、不做迁移。

## 四、数据形态

```
PluginDecl    = plugin.json 解析结果（字段见 docs/plugins.md §二）
Capability    = { cap: string, method: string }        // 调用点只写这两个
Pin           = 名 → Hash
              // 名 = 逻辑端点名；Hash = 被依赖身份的世代 payload 键（入世时由宿主解析，作者写身份名）
Sig           = 世代签名 = 该世代 `commit` def 键（入世时由宿主写入 `Gen.sig`）
Endpoint      = { impl: string, gen: Hash, cap, method } → { transport, proc }   // 物理端点：服务 = 子进程 stdio；`judgments` 命中 = term（无进程）
EndpointTable = Map<impl+gen+cap+method, Endpoint>     // 运行态，住宿主侧 ③（判定命中不登记，路由就地合成）
RuntimeState  = { pid, transport, gen }                // 运行态，永不进世界
```

## 五、设计口径（硬约束）

**路由**

- 调用点只写**能力类名 + 方法名**；`eff` 的 `port` / `method` 在 body 里是**名字**（逻辑名、经发出者 `needs` 绑定解析），**不是哈希**。（规矩 A：body 里的哈希只能是业务数据值——term 的 `Call` callee 哈希属此类：它是**本身份内**的函数值，不入 `needs`。）
- 解析基准是**发出者身份**：一个 `eff` 归属于「当前 directive 入口 def 的属主」——宿主自己构造 directive，
  所以知道属主；`eff_id` 里的 directive 下标 `i` 给出是哪一条。
- **`needs.one` 绑定的是被依赖身份，不是版本锁**。解析路径 = 发出者装配世代 `commit.body.meta.needs[cap]`（**身份名**）
  → 属主身份 → 该身份**当前代码世代**（`active` 是数据世代时取最近代码世代，见「装配」）→ 端点表。被依赖身份换代时，宿主把发出者的解析目标重解析到新代码世代，
  **发出者进程 / term / body 全不动**（按名绑定、非哈希，故无漂移证据）。
- **新世代不激活时保留在跑实现**：依赖身份的新 active 若**声明不可读 / stale**（装配期无法确定其形态）→ 该调用 `not_loaded`，并按「装配」隔离该分支；若其**构建 / 启动 / 握手失败** → 新世代不激活，其旧服务继续在跑（端点行换到新世代键，路由仍命中旧进程），失败只记运维日志——旧进程退出后按新世代重试。换代失败降级时**端点方法集按旧服务声明（旧代码）重挂**，不按已失败的新声明。
- **端点表的键不含调用方**（`impl+gen+cap+method`，`gen` = 依赖当前代码世代）——换提供方只改 `needs.one` 绑定，
  调用方与 term 都不用改。
- `needs.one` 的键 = 能力类名 = 调用点写的 `port`；解析时按名查绑定，并要求该能力类 ∈ 目标身份声明的能力类（故多重实现下每条绑定必须唯一命中，见下）。
- **降级链（同一逻辑能力多实现）**：`needs.one` 是**单值绑定**（能力类 → 单提供方身份），故降级用**多条别名 needs.one**表达，**不**把一个能力类改多值。每个别名是一个**独立能力类**，指向**另一个身份**，且该别名必须是目标身份**声明的能力类**（解析时要求该别名 ∈ 目标身份声明的能力类，即强制此条）。降级顺序由 term 判定——先试主名，**eff 返回的 `value` 含错误描述**时再试别名（term 据值分支，非内核/宿主判定）；宿主对每条绑定机械解析，**不自动重试**（自动选优 = 宿主业务）。换某别名指向的身份 = 改 `needs.one` 绑定（写新世代、显式记账）；换同一身份的实现 = `set_active`（换代，不碰绑定）。
- 端点表键 = `impl+gen+cap+method`，`cap` = **服务声明的能力类**；别名是 `needs` 的**键**（能力类名），不是其绑定值。
- **纪律**：term 的 `Call` 只在本身份内的 def 之间；跨插件一律走 `eff`（否则发出者归属不明）。
- 工具名就是能力类名（`tool.<name>`），**不另设一套命名**。
- **同一能力类多个拥有方**：方法契约仍取**码元序首个**拥有方（`capabilityContract` 不改绑），其余拥有方声明不影响解析；宿主逐身份记一条 `host` `capability_owner_conflict`（`cap`；`caps` = 拥有方身份集；`reason` = `multiple_owners` 或 `contract_mismatch`），**仅告警、不改行为**（重复应用不重记）。
- **保留身份 `host`**：`needs` 中保留键 `host` 的 `one` 绑定解析到**宿主自身**保留能力类（见「宿主扩展面」），不要求世界里有该身份、不入装配闭包为普通节点。
- **自能力路由（无需自引用 needs）**：`eff` 的目标能力类若**不在发出者 `needs.one` 绑定里**，但发出者**自身装配世代**的 `implements`
  声明含它，则解析到**发出者自己的端点行**（`impl+gen+cap+method`，`gen` = 自身装配世代）——插件把入口 term 的 `eff`
  路由进**自己的 `execute` 服务**不必写自引用 needs。**优先级**：`needs.one[cap]`（含保留哨兵 `host`）> 自能力（自能力仅在无绑定时兜底）；
  `many` 仍按世界索引解析。自身未声明该能力类 → `unresolved_cap`，声明了但端点行缺失 → `not_loaded`（与普通路径同码）。自能力**不是 `needs` 项、不构成跨身份依赖**：
  不进装配闭包、不是 DAG 边、不参与受保护身份校验；保留能力类 `host` 不走此路（须显式 `needs` 哨兵）。
- **判定承载的方法（`plugin.json.judgments`）**：提供方声明某能力方法由 term 承载时，路由解析到该方法**就地求值该 term**，不 spawn 服务、不查端点表——判定是数据，随世界换代热生效（改判定 = 一条数据世代，可回滚、可审计）。端点行 `transport = 'term'`（无进程），调用与普通 `eff` 同形（`args[0]` 入、返回值出；审计按本次 `eff` 记在调用方 run）。判定可发射 `eff`（取数 / 调自身服务方法）：由宿主 `effect/judgment-invoke` 解析执行并回灌续跑（方法级超时、审计旁路落账、按调用链限深 `MAX_JUDGMENT_DEPTH` 防互调成环）；判定不读投影、不扩权。一次判定调用受**总预算**约束：**跨多次重求值累计 gas**、总墙钟（= 方法级 `timeoutMs`）、效果迭代上限（`MAX_JUDGMENT_EFFECTS`）任一超限即 fail-closed 作数据返回（码 `gas` / `timeout`；互调限深为 `recursion_limited`）。**休眠身份的判定方法一并不可路由**（与休眠服务同收口 `not_loaded`，见下）。这类方法**不要求服务实现**（握手覆盖豁免）、不登记服务端点。判定路径与命令入口同路（`terms/` 成员入世解析成 def），无 owning `slots` 语义差异。
- **`needs.one` 路由**：发出者装配世代声明了 `needs.mode: "one"` 的能力类，解析读该世代 `commit.body.meta.needs[cap]`（**身份名**，含保留哨兵 `host`）——绑定在入世期写入（详见「装配」）。命中后按「属主 = 该身份名」走端点解析（`assemblyGen(owner)` → `implementsOf` 含 cap → 端点行），故 `one` 正向可用。绑定的提供方退役 / 声明丢 cap / 端点缺席 → `stale` / `not_loaded`（**作数据**）；退役同时按闭包**隔离消费方**（fail-closed）。入世期 `one` 的**选择跳过休眠提供方**：先取非休眠候选，非休眠为空才回落到休眠者绑定（消费方不因提供方休眠被拒入世，仅该 cap 调用得 `not_loaded`）；「恰好 1」对过滤后的候选集生效（非休眠 ≥2、或非休眠为空而休眠 ≥2 → `ambiguous_need`）。已写入的绑定不因休眠自动改绑。
- **`many` 槽与 `resolveSlot`**：成员 = 世界能力索引(cap)（提供方身份集，按身份名字典序），消费方自身不在其中。退役（`active === null`）与声明读不出的身份**静默缺席**（不作为成员、也不作元素错误）；**休眠 = 保留索引的运行期隔离**（世界 `active` 未变）故仍入索引、仍是成员，与退役（`set_active(null)`、不入索引）相对。运营显式休眠 = `host.identities.suspend` / `resume`（休眠态不持久、换代不自动恢复，仅显式 `resume` 按其当前代码世代重启）；休眠只隔离目标身份，**不连坐依赖者**。`many` **不建闭包 / 运行态单值边**（成员按世界索引解析）——**世界驱动、无运行期可变注册表**：索引按各 active 身份的 `assemblyGen` 声明确定性重算（贡献变更 = 世界变更 → 重解析），不轮询、不动态注册。
- **反向调用的 needs 可达面**：`one` 经 needs 绑定天然可反向调用（`port` ∈ `needs` 的 `one` 键 ∪ 自能力）；`many` 默认不经反向，但**支持「按成员定位」**：帧带 `provider`（成员身份）且该能力类在发出者 `needs` 且 `mode:"many"`、目标 ∈ 索引(cap) 时，`resolve` 解析该成员在 `cap` 上的端点行（`resolve` 的 `target` 支路）；否则 `unresolved_cap`。成员表由宿主按世界索引注入服务工厂上下文 `manyNeeds`（stdio 经 `CHRONO_PLUGIN_MANY_NEEDS`，inproc / worker 经 ctx），扩展点枢纽据此逐个反向调用成员（**零改动加减提供方**）。
- **自能力回路有界**：plan 可逐层递归产 directive，自能力 `eff` 又允许服务回计划再次 `eff` 自己——单次提交的轮数上限
  `MAX_SUBMISSION_ROUNDS`（宿主常量 10000，宿主可按提交收紧）；超限以 `refused` 收口（reason `too_many_rounds`），不挂死宿主。
  单轮内的挂起次数另受 `run-loop` 的 `too_many_suspensions` 约束。
- 解析不到即**拒绝**（不猜、不兜底）。

**装配**

- 闭包沿装配世代 `commit.body.meta.needs` 的 `one` 绑定**只读**遍历（规矩 A）；绑定指向**被依赖身份名**，闭包落到各身份的**当前代码世代**；
  拓扑序 = 服务启动顺序（被依赖者先起）。`many` 按世界索引解析成员，不构成单值闭包边。
- **`needs.one` 即身份级闭包边**：绑定由入世期写入（`one` 绑定写 `commit.body.meta.needs`）；提供方缺失 / 退役**连坐消费方**（隔离）；`many` 不建单值闭包边，只按世界索引解析，提供方失败 / 退役**不连坐消费方**。`one` 绑定同时参与入世**次序**（seed 排序：清单内声明该能力类的提供方先入世）。
- **按依赖层并发启动**：拓扑序切成依赖层（层号 = 依赖链最长深度），同层无依赖边 → 带上限并发
  （`DEFAULT_START_CONCURRENCY`，防同时跑满 npm / cargo 构建与进程树）；层间保持顺序，被依赖者先起。
  某身份失败时其反向可达的依赖者必在更晚的层、在本层结束前已标隔离，后续层读到的装载状态一致。
  停机按启动序**逆序摘除**各服务（状态变更同步有序），各服务的 `drain` / 终止则**并发等待**（见「写者 · 停机序列」）。
- **物化 / 构建先于 spawn**：依赖恢复与构建在 spawn 前完成，握手超时只计 spawn 之后的协议往返，
  不含构建耗时——构建慢不会表现为握手超时；构建失败按 `deps_failed` 收口。
  起服务据此拆成**准备**（物化 + 资产直拷 + 依赖恢复 / 构建）与 **spawn**（起进程 + 握手）两段：
  缺省序与装配期仍走一次性入口；独占序把准备提前到 drain 之前（见下「换人序」），空窗只剩 spawn + 握手。
- **世代二分（同身份混合世代）**：`gens` 里每个世代要么是**代码世代**（payload 指向 `commit` def，即
  `world.defs[payload].body.tree` 是字符串），要么是**数据世代**（payload 指向数据 def）。**装配解析声明 / `needs` 绑定
  一律按「当前代码世代」**：`active` 本身是代码世代则取 `active`（尊重 `set_active` 回滚），`active` 是数据世代
  则取**最近代码世代**；找不到可解析的代码世代 ⇒ 该身份不参与装配（fail-closed，不回落更旧世代）。
  数据世代只影响投影读侧（`.body`），不影响装载与路由。
- **坏分支只隔离，不整体拒绝**：`needs.one` 闭包成环（Tarjan SCC）时，环成员**及其依赖者**（反向可达）
  标 `not_loaded` + 记 `dep.cycle`，其余照常启动。
- `stale()` 判定口径在 `kernel.md` §九（def ↔ 本身份 active 世代的一致性）；宿主 **fail-closed**：
  依赖身份 retired / 缺失、或新 active **声明不可读 / stale** → 隔离该分支，**不拿更旧世代顶上**。
- 运行期**只跟随本插件自身 active 换代**（数据热生效 / 代码起新服务 + 旧服务 drain）；
  **依赖换代不重装本插件**，只由宿主重解析路由（见「路由」）。
- **换人序按 `exclusive` 声明选**（代码换代时新旧服务如何交接）：缺省「先起新 → 切端点 → drain 旧」（零空窗，新旧短暂并存）；
  新世代声明 `exclusive`（**资源类开放命名**，实际在用 `port` / `data`；宿主对列表**只认「非空即独占换人序」**，不校验已知类、不查资源是否真被占用）→ 「先准备 → drain 旧 → 再 spawn → 切端点」——新实例独占该资源、无法与旧实例并存
  （如固定端口），以该身份**短暂空窗**（旧进程退出到新进程握手完成之间端点缺席、调用得 `not_loaded`）换资源正确性。
  **准备阶段**（物化 + 资产直拷 + 依赖恢复 / 构建）不占独占资源，提前到 drain 之前、旧实例仍在服务时完成；
  空窗只剩 spawn + 握手，构建耗时不再计入停机时间。**以新世代声明为准**（声明描述新实例的占用事实）；
  插件只声明事实，调度归宿主，故换调度策略不必改插件。准备产物（物化目录）交给 spawn 复用，不重复物化。
- **独占序下失败按阶段分流**：**准备阶段失败**（`materialize_failed` / `deps_failed`）时旧实例尚未退场——
  新世代不激活、旧服务继续服务（端点行换到新世代键，**方法集按旧服务声明**），不隔离、不重试；
  **spawn / 握手失败**时旧服务已 drain 退场、**不复活**（复活会让运行服务停在旧代码世代，违反「不拿更旧世代顶上」）——
  该身份转入**「无服务但保留世代」**（仍在已装载集、`loaded` 报 `service:false`，端点缺席），按 `restart` 策略重试新世代，
  重试超限记 `service.restart_exhausted` 并隔离分支。
- **缺省序新世代构建 / 启动失败不激活**：起新服务失败（物化 / 构建 / spawn / 握手）只记
  `service.start_failed` / `handshake.failed` 运维日志，**旧服务继续服务**（端点行换到新世代键，
  在跑的仍是旧代码，故**方法集按旧服务声明**重挂），不隔离本插件、不牵连依赖者；旧进程退出后按新世代重试，成功即真正接管。
- 握手**只查形态**（协议 / 身份 / 能力覆盖 / 状态档），不做语义校验；多出来的能力**不登记**（不扩权）；
  装配期不过 → 杀进程 + `handshake_failed`，该插件**及其依赖者**标 `not_loaded`；自身换代期不过 → 按阶段分流（缺省序或独占序准备阶段失败保留旧服务，独占序 spawn 后失败转入无服务重试，见上）。
- 崩溃恢复按 `restart` 声明的策略执行（`on-exit` 退避重启；`never` 不重启、退出即隔离该分支）；超过上限 → 记 `service.restart_exhausted`（运维日志）+ `not_loaded` + 隔离依赖者；服务退出即摘除该世代端点行，重启成功后重挂（端点表只含可用服务）；
  健康判定走协议级 `probe` / `pong`，见 `docs/protocol.md` §2.3。

**源码**

- 一个插件世代 = 一个 `commit` def（`blob` / `tree` / `commit`），tree = **包内源码树减去生态 profile 的通用排除名（默认 `node_modules` / `.git`）与插件 `.worldignore` 声明项**；宿主**不内置**语言 / 构建名字（构建与启动一律由插件 `decl.build` / `decl.start` 声明）；契约必需文件（`plugin.json` / `package.json` / 生态 profile 的锁文件 / `README.md` / `schema` / `commands` / `members` 路径本身）不可被排除（否则 `bad_worldignore`）。
- **生态 profile（声明式默认）**：宿主对「语言 / 工具链」的默认假设——契约必需锁文件名、源码树通用排除名、npm 缓存环境变量（`npm_config_cache`）与远端开关、cargo 目标环境（`CARGO_TARGET_DIR`）、顶层 `plugin-sdk` 布局、`inproc` / `worker` 同语言入口扩展名——集中为 `assembly/ecosystem.ts` 的声明式默认 profile，未配置时全部走内建默认（零行为变化）。仓库根 `chrono.config.json` 的 `ecosystem` 键（或 `CHRONO_ECOSYSTEM` 环境变量，JSON 文本）可整体 / 部分覆盖；键名 / 取值形态非法即 fail-closed 拒 `bad_ecosystem`。这是宿主侧机械假设的覆盖点，不改变「宿主不认识语言、构建与启动由插件声明」的口径。
- 包内 `terms/` 入世成 term def（`body` = AST、`sig` = 本世代 `commit` 键）；term 对同包 callee 的引用在入世时解析成 def 哈希；**引用成环 → 该包整批入世被拒**（`term_cycle`），其他包照常——term 内部引用不构成身份级依赖，装配闭包看不到它。
- **入世**：按目录发现 ∪ `state/plugins.json` 覆盖解析插件包 → 读其源码树 → `blob` / `tree` / `commit` defs → `put`，与物化互逆；源码住 ①（`kernel.md` §八）。宿主**只解释 `plugin.json`**，其余是源码 blob。
- 身份的 `schema`（`Identity.schema`）= `plugin.json.schema` 指向的包内文件——它是该身份的**自述 / 数据契约**（描述本身份声明的数据形态；数据、非特权，`kernel.md` §四 / §十一），入世解析成 def 哈希写进 `Identity.schema`。宿主对 `plugin.json` 形状的元校验是**宿主侧另一份 schema**，不占此字段。**`schema` 可省略 / 空串**（无世界数据的 UI 插件可零 schema，直接省略字段，不得以 `null` 占位）：省略时宿主机械 `put` 一份最小默认 def `{"type":"object"}` 并以其哈希作 `Identity.schema`（内核要求身份必有 schema），不解释业务；声明了非空路径但包内文件缺失才拒 `missing_schema`。`Identity.schema` 在身份诞生（`add_identity` / `fork`）时固定；换代（`add_gen`）不带 schema——**要改数据契约须 `fork` 新身份**（内核无 set_schema op）。
- 工作副本落 `state/runtime/`（③ 可重算），**永不进世界**；复用前校验宿主标记，标记缺失 / 不符即整目录重物化；服务写进物化目录的文件不是源码树的一部分、不保证跨代保留（**不得当持久层**——要持久层请声明 `state: "durable"` 并写 `state/data/<id>/`，见「插件持久数据」）。依赖安装 / 构建 / 起服务全归插件的 `decl.build` / `decl.start`，宿主**不认识语言、不执行 npm、不做编译**。
- **起服务**：宿主 spawn `decl.start` 并接管其 **stdin/stdout**（服务协议走 stdio，见 `docs/protocol.md` §一 / §二）；服务日志走 stderr，stdout 只许协议帧。
- **SDK 供给**：插件运行期可裸导入 `plugin-sdk`（服务协议壳，零内核零宿主依赖，见 `plugin-sdk/README.md`）。宿主在**准备阶段**于物化树内建 `node_modules/plugin-sdk` 链接，指向框架安装的顶层 `plugin-sdk`——故插件服务在**任意宿主根**下都能解析它。用**链接而非复制**：SDK 以 TS 源码发布，Node 的类型剥离对 `node_modules` 下的文件不生效，链接经 realpath 指回框架安装目录（不在 `node_modules` 下）。**Rust 侧同理**：插件 `Cargo.toml` 以相对路径 `../../plugin-sdk/rust` 依赖 SDK crate，宿主在**依赖恢复 / 构建之前**于物化目录两级之上建 `plugin-sdk` 链接（任意宿主根下 = `<宿主根>/state/runtime/plugin-sdk`），使该相对路径在任意宿主根下解析到框架安装的 SDK crate。宿主只按数据 / 路径定位、**不 import** SDK；SDK 不随插件入世、不进世界、不进 `needs` / 路由 / 装配。

**写入落点**

系统里不存在"唯一写口"。载体是**中转站**：转发调用、解析 `needs` 绑定、装配依赖、按声明划地盘。设计的落点是**什么东西该在哪写**，以及**那一处谁是写者**：

| 落点 | 写什么 | 写者 | 门禁 |
| --- | --- | --- | --- |
| `state/world/` | 定义与判定（代码世代 / 声明 / 绑定 / 阈值 / 判定数据） | **载体独占** | 内核 `commit` 四步校验 |
| `state/data/<id>/` | 运行记录 | **owner 插件**（单 owner） | 无（插件自管事务；载体不校验） |
| `state/plugins/<id>/` | 可重算缓存 | owner 插件 | 无 |
| `state/blobs/` · `state/assets/` | 内容寻址字节 | 载体（入世 / `blob.put` / `asset.put`） | 内容寻址 + 大小校验 |
| `state/audit/` | 效果审计 | 载体 | 有界保留、脱敏 |
| `state/lifecycle.log` | 运维取证 | 载体 | 无（append-only） |
| `state/secrets.local.json` | 密钥本体 | 载体 | fail-closed（坏文件不覆写） |

两条**不可软化**的机械事实，它们是"世界那一处"的性质，不是载体的地位：

- **世界写者唯一是物理约束**：`journal` 是单链 + `expect_pos` 单链头 CAS，两个写者并发追加会当场打断链哈希。故世界那一处必须独占写，由载体持锁串行落账（锁只在 commit 期间持有，见「写者」）。
- **写世界必经内核校验**：绕开它，"非法进不来"就变成靠自觉。插件服务因此没有写链通道——它提交内容，载体落账。

推论：**载体不解释、也不定义插件**。它不认识插件种类、不认识业务语义，只按 `plugin.json` 声明与 `needs` 干活（`assembly` 只读世界即此事实的 import 图证据）；插件数据的形态、schema、迁移一律不入载体视野。运行记录这一侧更彻底：载体连那份数据长什么样都不需要知道。

**入世判定（什么配进世界）**

- 世界只装**定义与判定**：插件代码世代（`commit` / `tree` / blob 指针 / term / schema）、`plugin.json` 解析出的声明、`needs` 绑定、阈值，以及**采纳闸与回滚要读的**证据与判决。内核对此不设机制（它给一切 `put` 做版本），故这条判定住载体。
- 判据两问，两问皆否即**不构造 `write` directive**：**回滚该不该带上它**、**判定 / 门禁 / 重放要不要从世界读它**。
- 判为"否"的一类统称**运行记录**：对话消息、输入槽、审批队列与结果、工具结果、待办、界面配置、记忆条目。它们由 owner 插件写**自有持久存储**，不产 directive、不占 `seq`、不改 `worldRev`、不吃回收窗口，宿主不解释其内容。
- 判为"是"的走既有路径：`put` / `add_gen` / `batch` 落**世界那一处**（载体独占写 + 内核四步校验）。看着像运行记录却是判定输入的（进化轨迹、判决、证据、阈值）按判据留在世界，不因形态相似而挪出世界。
- **运行记录那一处的纪律是"单 owner"**：每份运行数据只有一个 owner 身份写，别人经能力调用问它。跨身份共享不借世界当共享内存——那会把"数据所有权"换成一次落账。
- **原子性按 owner，不跨 owner**：世界那一处是一条 `batch` 全有或全无；运行记录是**各 owner 自己的事务 + 边跑边追加**（产生即写，不攒到回合收口）。不做跨 owner 原子是刻意的——"什么都等收口一次性写"会让回合在审批 / 挂起处停住时，已发生的事实一条都不可见。补偿：每条记录盖**回合 id**，续跑 / 重试据此幂等收敛，中途崩留下的半份状态可辨识。载体不提供跨 owner 事务，也不认识这些记录的一致性语义。
- **完整性不由链承担**：运行记录不进链，故没有链式哈希覆盖，坏数据没有链可对——"非法进不来"只对定义平面成立。取证退回效果审计（`state/audit/`）与运维日志。这是运行记录不进世界这一侧的**已知代价**，不以插件内哈希链或定期锚摘要回补（那会把世界重新拖进高频写）。
- 理由：世界的机制（世代、补丁、`set_active`、内容寻址、回收窗口、单写者锁）服务的是**不可变声明**；把可变记录塞进来，每改一次就是新 def + 新世代 + 新 `worldRev` + 一份窗口占用，且跨轮取用要依赖回收保留集才不悬挂。与 `EffectAudit` 不进世界是同一条理由（见「效果」）：高频写进世界会让 `worldRev` 失去"同一版本可比"的意义，`snapshot` 与 pin 全部锚不住。

**插件持久数据（④ durable）**

- **声明驱动**：`plugin.json.state` 两档——`recomputable`（③，缺省）与 `durable`（④）。声明 `durable` 的身份才获得持久数据目录；未声明者行为不变。
- **地盘由宿主给**：起服务前宿主为本身份 `mkdir state/data/<id>/`，以环境变量 **`CHRONO_PLUGIN_DATA`** 注入 spawn env（**只注入本身份路径**）。③ 缓存目录另注入 `CHRONO_PLUGIN_STATE`（`state/plugins/<id>/`），两者**分开**：前者进备份、不自动回收，后者可随时删。与 ③ 目录同规，这是**路径约定、不是 fs 隔离**（v1 无沙箱）。
- **引擎与格式归插件**：SQLite、追加日志、裸文件、嵌入式 KV 一律合法；schema、迁移、索引、事务、并发全由插件自管。宿主**不读、不校验、不迁移、不解释**目录内容——这是"载体不认识业务"在存储面的落点。
- **④ 只放不可重算的**：能由 ④ 重算的派生物（向量索引、检索缓存、水位）属 ③，落 `CHRONO_PLUGIN_STATE`。判据是"删了能不能重建"，**不是"大不大"**（与 §八 四档同源）。把索引塞进 ④ 会让备份集无谓膨胀，且掩盖真正不可重算的那部分。
- **委托存储的清理责任在被委托方**：owner 把数据放进另一身份（存储服务）的 ④ 目录时，宿主按身份回收**只能删 owner 自己的目录**，删不到存储服务库里属于它的命名空间。故存储类服务须自带"丢弃某命名空间"方法；宿主不代劳、不认识命名空间语义。
- **跨代存活**：目录按身份而非世代命名，故代码换代不动它；`retire` 只置 `active=null`、id 仍在 `world.ids` ⇒ 目录保留。**回收只认身份消失**：宿主启动时（抢锁后、装配前）删目录名 ∉ `world.ids` 的顶层项，与 ③ 同路但**分开统计**；`durable` 目录不参与"active + 前 N 代"那类窗口回收。
- **跨代独占**：`plugin.json.exclusive` 增资源类 **`data`**——声明 `durable` 且新旧实例不能并存开同一份存储时写它，换代走「先准备 → drain 旧 → 再 spawn → 切端点」（该身份短暂空窗）。**不强制**：支持多进程并发的引擎（如 SQLite 的 WAL + 文件锁）可不声明，走零空窗的缺省序；由插件按自己引擎的事实声明，宿主只按声明选换人序。声明含 `data` 而 `state !== 'durable'` → 入世拒 `bad_plugin_decl`（声明自相矛盾；按**声明**判，不看运行期目录是否已建）。
- **备份归属**：`state/data/` 进备份集（见 §三）。它是 ④ 不可重算——丢了就真没了，且**不能由世界重算**（世界里连声明都没有）。
- **身份名约束照旧**：目录名 = 身份 id，故沿用安全单段名校验（入世与起服务两处 fail-closed），否则既路径穿越又会被回收误删。

**入世路径（seed / pack）**

- 两条入世路径**共用同一套打包规则**（通用排除 `node_modules` / `.git` + 包内 `.worldignore`，契约必需文件不可排除），故同一目录、同一身份产出**相同的源码 tree 与 commit 哈希**：
  - `seed`：按目录发现 ∪ `state/plugins.json` 覆盖**批量**入世（缺省按此；也可给若干包路径）。
  - `pack`：**单个目录**手动 / 程序化入世（`boot pack <目录> --identity <身份名>`）。
- 两者都把「一个包 = 一条原子 `batch`」直写 `commit`：身份不存在则 `add_identity` + `add_gen`；身份已存在则只 `add_gen`（追加代码世代，不覆盖既有数据世代；同内容重复入世为 `unchanged`）。坏包（坏声明 / 缺 `plugin.json` / 声明 `schema` 但包内文件缺失 / `.worldignore` 非法 / needs 未解析 / eff 声明越界（`undeclared_port` / `undeclared_method`）/ 内核原语未同步（`bad_term:<原语头>`）/ **删除受保护 needs 绑定**）**整批拒绝、世界分文未动**，报结构化原因（后者 `protected_pin_removed`）。
  - `pack` 的 `--identity` 必须与包内 `plugin.json.identity` **一致**，不一致即拒（`identity_mismatch`）——命名即契约，身份名只有一个来源。
  - **身份名必须是安全单段名**：拒绝含 `/`、`\`、盘符前缀、`.` / `..`、控制字符、空段、Windows 非法字符（`<>:"|?*`）、尾随点 / 空格、Windows 保留设备名（`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`）、JS 原型键（`__proto__` / `constructor` / `prototype`，否则 `world.ids` 继承成员会误判为已存在并触发 `TypeError`），以及保留名 `host`（`host` 恒解析为宿主能力，真实身份会遮蔽它）→ `bad_plugin_decl`。理由：身份名会被用作 ③ 目录名（`state/plugins/<id>/`），不安全名字既会路径穿越、又会被 GC 误删。运行期写指令可造 id，故**起服务边界同样 fail-closed 校验**。
- **退出码**：`seed` / `pack` 有任一条目 `failed`（即报告 `ok:false`）时 CLI **退出码非 0**（结构化报告照常打印）；`verify` 结果 `ok:false` 同样置非零退出码（与 `seed` / `pack` 一致）；仅用法错误与其它异常退出 1。

**宿主入口选项**

- 宿主入口（`packages/host/main.ts`）与 `boot start` 共用同一份入口解析：`--root` / `--call-timeout-ms` / `--start-wrapper` / `--watch`，支持 `--flag value` 与 `--flag=value` 两种形态。
- **所有启动选项按同一口径收口**：非法即 fail-closed 拒启动，并记一条 `host` `start_failed` 运维日志（reason 取错误的规范前缀，如 `bad_call_timeout` / `bad_start_wrapper` / `bad_watch` / `unknown_entry_arg`；不进世界、不进链）。
- **宿主入口拒绝未知位置参数 / 未知 flag**（`rest` 非空 → `unknown_entry_arg`）；`rest` 只供 `boot` 派发命令与命令专用 flag。

**服务启动包装器**

- 宿主**不选沙箱后端**，只允许配置一个**包装器命令**把插件 `start` 包住（宿主仍不认识语言）：配置后实际 spawn 命令 = 包装器 + 原 `start`；未配置 = 现状（零行为变化）。
- 配置优先级与调用超时同规：**CLI（`--start-wrapper`）> 环境（`CHRONO_START_WRAPPER`）> 无**。
- 包装器**只影响 spawn 命令行**：不参与声明解析、不改 `plugin.json` 契约、不引入「特权插件」；非法值（空 / 纯空白 / 含 NUL 或换行）**fail-closed 拒启动**，并记一条 `host` `start_failed`（reason `bad_start_wrapper`）运维日志。

**源码 watcher（热更）**

- **能力归属载体**：watcher 是宿主进程内的一个能力（`packages/host/watch/`），不是独立进程、不是离线命令。理由：宿主常驻时单写者锁恒被持有，离线 `seed` 必然 `writer_busy`；运行期写入只能经宿主自己的落账路径。
- **默认关**：生产常驻不该无条件监听文件系统；只有显式 `--watch`（宿主入口 / `boot start`）或 `CHRONO_WATCH=<真值>` 才打开，优先级 **CLI > env > 关**，无法识别的 env 值 fail-closed（`bad_watch`）。`node start.mjs watch` 是前台便捷入口。
- **监听对象 = 目录发现 ∪ `state/plugins.json` 覆盖的投递路径**：有 `path` 走路径、无 `path` 走 Node 解析；**不按第一方 / 第三方分类**（「只有一个插件种类」），指向 `plugins/`、`fixtures/plugins/` 还是别处一视同仁。解析不到包根的条目跳过（只读目录不产生事件）。
- **触发过滤**：与打包排除同口径——通用排除（`node_modules` / `.git`）与插件 `.worldignore` 声明项命中的路径**不触发**；`.worldignore` 自身变动触发（排除规则变了）。**这是防死循环的关键**：`dist/` 等构建产物若不过滤，一次构建写产物就会触发下一次换代、换代又重建产物，形成无限循环。
- **静默窗口**：窗口内多次事件合并为一次重建（尾沿触发），覆盖编辑器保存的多事件与「写临时文件再 rename」。
- **内容未变不换代**：重建先按 `planIngest` 纯规划比对内容哈希，与当前最近代码世代相同则**什么都不做**（不产生 journal entry）。
- **换代落链**：内容变化 → 源码字节先落 CAS → 在**宿主落账互斥段**内提交一条 `batch`（身份不存在则 `add_identity` + `add_gen`）→ 链头推进后交**装配跟随**（`applyWorld`）。故 watcher 触发的换代是**真 journal entry**，可回滚可审计，不引入开发态 / 生产态分叉。
- **代码 / 数据分流复用既有判据**：`execute` 成员变化 → 起新服务、旧服务 drain；`term` / `schema` 变化 → 热生效、进程不动（见「世代」）。新世代构建 / 启动失败**不替换在跑服务**，只记运维日志 + 在 stdout 按实况说明：旧实例仍在服务（缺省序失败、或独占序准备阶段失败）时说「旧版本继续服务」；独占序 spawn / 握手失败已无旧实例时说「当前无可用服务（按 restart 策略重试）」。
- **可观测**：每次触发记 `host` `watch_triggered`，接管记 `watch_applied`（构建 / 启动失败记 `watch_follow_failed`），入世 / 监听失败记 `watch_failed`；前台模式同时在宿主 stdout 打一行。
- **跨平台**：`fs.watch` 的 recursive 在 Windows / macOS 稳定、Linux 自 Node 20 起可用；事件文件名无法定位（含 null）时保守按整目录触发——重建前比对内容哈希，真无变化不换代，故不会因此死循环。监听句柄故障只记 `watch_failed`，不炸宿主；停机时先停 watcher 再 drain 服务。

**效果**

- 效果一律经宿主；**每次效果必留一条审计**（失败也留，`execute` 必须 try/catch，记失败形态）。
  审计记录写 **`state/audit/audit.jsonl` 旁路侧存**（不进世界 `defs`、不落链、不参与哈希 / 重放），记录体 =
  `{kind:'effect_audit', request, result, port, method, outcome, run, emitter}`；
  `outcome` 机械导出：`ok`（有响应成功）/ `error`（有响应为错误）/ `transport_failed`（没执行）/
  `cancelled`（被真取消中止）；`run` = 宿主对外回合 id（`accepted{run}`）、`emitter` = 发出者身份。
  审计不由业务写 `ref` 指向（`write` 不落 `ref`），故效果判定 / 落账不依赖「审计先于业务写」。
- **槽审计（聚合感知）**：一个 `EffRequest` 仍**一条**审计草稿；`many` 的 `result` 落**聚合元素表**（逐元素 `{provider, ok, …}`）。**脱敏逐元素**：每元素按其提供方 `schema.audit_redact` 的 `${cap}.${method}` 键收白名单（与单值口径同先例）。**截断逐元素 + 聚合预算**：单元素正文超 `MAX_AUDIT_RESULT_BYTES` → 该元素只落 `{provider, ok, value:{truncated:true, size}}`；聚合正文仍超全局预算 → 整槽落 `{truncated:true, size}` 并附 `{provider, ok}` 骨架表（防一个超限元素吞掉全槽取证、或 N 个大元素各自合规却共同撑爆侧存）。**结局（`outcome`）**：全元素 `ok` → `ok`；**任一元素失败 → `error`**；取消 → `cancelled`——此 `outcome` 是审计结局，与聚合 `EffResult` 恒 `{ok:true, value:[…]}` **分属两层**（元素失败只体现在元素表与该 `outcome`，不经外层 `ok:false`）。
- **调用帧 `env` 注入（机械）**：宿主在**每次服务调用**（正向 `call` 与反向 `port.call` 转发）的协议帧上填 `env: { run, thread, now, emitter }`
  ——`run` = 本次回合 id（宿主分配）、`thread` = 发起者提交信封里的可选字段（原样回带、不校验；detached / 周期 run 恒 `null`）、
  `now` = 宿主固定时钟（与 `KernelInput.now` 同源）、`emitter` = **发出者身份**（宿主解析所得，与 `EffectAudit.emitter` 同源）。
  `emitter` **由宿主填、不由调用方给**：被调服务据此按 owner 分命名空间（存储类服务的分库依据），调用方自报的 namespace 参数可伪造、不得作此用；
  宿主保留身份的调用记 `host`，取不到发出者（不应发生）记 `null`。**只填帧、不改 `args` / `bag` 语义**（`canonicalJson(args)` 缓存键与审计 args 不受影响）；
  服务发事件（载荷带 `run`/`thread`）、判 TTL（`now`）一律用它，**不得自取时间**。机械路由。
  反向 `port.call` 的帧本身不带 `env`，宿主按**该服务连接上最近一条在途正向调用**的回合信息回带（目标与发起服务拿到同一 `run` / `thread` / `now`）；
  无在途调用时补宿主固定时钟、`run` / `thread` 记 `null`（v1 服务实现内部调用都在正向调用内发起，故正常路径恒有值）。
- `eff` 的 `port` 是**逻辑名**，运行时按发出者 `needs` 绑定解析（见「路由」）；**不改内核的 `EffRequest`**。
- **调用超时**：常量缺省 30s（`DEFAULT_CALL_TIMEOUT_MS`）；进程级默认读 `CHRONO_CALL_TIMEOUT_MS`，
  `boot start --call-timeout-ms <ms>`（或宿主入口 `--call-timeout-ms`）显式覆盖——优先级 **CLI > env > 常量**；
  非法值启动即拒（`bad_call_timeout`），`boot start` 打印生效值。超时与连接 / 帧 / 进程死亡同归「没执行」。
- **方法级超时覆盖（`method_timeouts`）**：插件 `schema` 顶层可选 `method_timeouts: {"<能力类>.<方法>": ms}`
  （键也可省能力类前缀、按方法名全局匹配该插件声明），宿主按声明为**本插件被调方法**覆盖等待上限——
  优先级 **方法级 > 进程级 > 常量**；缺省不设。声明非法（非对象 / 键为空或 JS 原型键 / 值非正整数 / 值超计时器硬上限 `2**31-1`，超限会被 `setTimeout` 溢出成 1ms）→
  装载期记运维日志 `dep.method_timeout_invalid`、按无覆盖处理（不炸宿主）。用途：长回合方法、
  流式模型调用声明大上限，避免被 30s 缺省截断。**正向效果调用与反向调用（`port.call`）都按目标身份的方法级声明覆盖**，
  周期方法条目直接调用同规；解析落点 `packages/host/method-timeouts.ts`（`resolveMethodTimeoutMs` 按世界对象缓存声明，不重复读 schema）。
- **门禁必须前置于效果，不得与效果并发**（写死）：判定为"需升级 / 需审批"的调用，其**实际效果必须尚未发出**。门禁节点先判、判过才派发，是**图数据的段序义务**；同时**工具实现侧不得在门禁未放行前自行触网 / 触盘**——否则会出现"审批项还在队列里，请求已经发出去了"，审批闸门形同虚设（越档调用已经落地，事后裁决无法撤回已发生的外效应）。载体不代为阻断：它只按 `needs` 路由、按声明调用，不认识哪次调用需要审批（那是判定）。取证靠 `EffectAudit`——门禁判 `escalate` 却存在同 `run` 的对应效果审计，即该义务被违反的机械证据。
- **失败作数据回灌**：endpoint **有响应**（`result` 或 `error`）→ `EffResult{ok:true, value}` 回灌（`error` 时 `value` 是错误描述），
  term 可据此分支（降级链）；只有**没执行**（连接 / 帧 / 进程死亡 / 未解析 / 超时）→ `EffResult{ok:false}`（无值，`error` 记通道错误码 `timeout` / `closed` / `protocol_error` / `bad_manifest` / `cancelled`；非通道异常才归 `transport_failed`）→ 内核 `eff_error` → 该轮 `refused`（审计 `outcome` 仍 `transport_failed`）。
- **槽（`many`）执行与扇出**：`many` 的 `eff` 由宿主 `resolveSlot` 命中后**串行 fan-out**——成员按提供方身份名字典序逐个调用，逐元素超时按该提供方 `schema.method_timeouts`（缺省回落进程级 / 常量），**无槽级预算**（总延迟 = Σ 各元素超时）。**元素形状** `{provider, ok:true, value}` / `{provider, ok:false, error, message?}`——**判别键 `ok` 恒存在**（错误元素无 `value`，故消费方须**先判 `ok` 再取 `value`**）；`error` 取路由码（`not_loaded` / `stale`）/ 传输码（`ServiceChannelError.code`）/ 服务错误码。聚合为**一个** `EffResult{ok:true, value:[…]}`——**元素失败一律作值**（元素错误），**绝不**用外层 `ok:false`（否则内核 `eff_error` 整轮拒）；**仅整体取消**（abort）时折叠 `{ok:false, error:'cancelled'}`，未跑元素不再有语义。只读提交（`audit:false`）照常 fan-out、不落审计。内核不变：一个 `eff` 仍一个 `EffRequest`（`eff_id` 不变）→ 一个聚合 `EffResult`。
- **真取消（`cancel{run}`）**：中止在途 / 排队的 run——丢弃尚未执行的部分（含 plan 产出的 directives）、
  尽力停止等待在途服务调用（服务协议无取消消息：宿主摘除等待、晚到响应忽略、不杀服务进程）、
  在途效果审计记 `outcome: 'cancelled'`（result 记 `{ok:false,error:'cancelled'}`），该 run 以 `cancelled` 收口；
   **已落账内容不回溯**。与 `stop`（停宿主）互不相干：`cancel` 只影响该 run，宿主继续运行；
   停机时宿主亦取消全部在途 / 排队 run（不把停机耗在调用超时上）。**命令 run 与 `submit` run 同规登记在册**，故同样可被 `cancel{run}` 与停机 `abort` 覆盖（命令 `result` 不带 `run`，仅审计 / 运维可见其回合 id）。
- **只读审计面**：宿主按回合（`run`）/ 身份（`emitter`）/ 结局（`outcome`）查询 `EffectAudit`
  （入站 `audit`；seq 降序、缺省 100 条、上限 1000）；数据源为**旁路侧存的内存索引**，
  启动时由 `state/audit/audit.jsonl` 重建、运行期随每次效果追加增量补齐；
  **只读**：不写链、不推进、不参与哈希（查询语义见 `protocol.md` §三）。
  `AuditRecord.seq` 是**侧存到达序**（侧存单调计数，非 journal `Entry.seq`），按效果完成序分配、
  跨并发 run 非确定，不属状态链、不参与重放。
- **高频端口的审计保留分档**：审计窗口按条数与字节有界（见下），故**单一高频端口会把窗口冲干净**——存储类调用一旦成为热路径，几分钟内就挤掉模型调用与工具调用的审计，取证能力归零。口径：保留窗口按**端口分档**（每档各自的条数 / 字节预算），高频数据端口占独立档、不与模型 / 工具 / `host` 端口争同一窗口。此口径只定淘汰顺序，"每次效果必留一条审计"照旧成立。推论也写明：**真正的热路径不该走跨进程数据调用**（逐 token 写、向量全扫），那类读写留在 owner 插件进程内部；经能力调用的应是粗粒度数据操作。
- **审计旁路侧存（有界）**：单文件追加（每条一次写、按累计字节批量 `fsync`、换行收尾）+ 上限压实；保留窗口**按端口分档**，档内最旧先走。
  **声明式分档**：插件 `schema.audit_tier = { "<能力类>": { max_records, max_bytes } }` 的端口走自己的预算，逐项以**框架上限** `AUDIT_TIER_MAX_RECORDS` = 10000 / `AUDIT_TIER_MAX_BYTES` = 8 MiB 截顶（防绕过保留纪律）；**未声明的端口归 default 档**（1000 条 / 512 KiB）。写满**各档预算之和**（条数或字节，先到者）即整文件原子重写为保留集；档预算随声明世代变，每次插入按当前世界声明解析。
  **不分档时**（测试 / 兼容路径，非生产保留窗口）退化为**单档全局窗口** `AUDIT_MAX_RECORDS` = 10000 / `AUDIT_MAX_BYTES` = 8 MiB。淘汰只影响侧存与热索引，**不触及世界状态**。
  半写安全：启动 / 追加前容错读，末行撕裂截到有效前缀；带换行的坏行跳过（fail-open）。单写者：追加同步、
  宿主单进程串行调用，无并发交错。落点 `packages/host/audit-store.ts`。
  **历史回填**：世界内历史审计 def 不在侧存，故未回填时（宿主启动 / 离线 `compact`，持锁）一次性扫
  base world defs 与冷段 / 尾段 entry 的 `put` args 重建记录（受保留窗口约束，从新到旧取），
  写 `state/audit/meta.json` 标记幂等；追加前按 `(at, by, body)` 规范序列化**多重集去重**——崩溃窗口
  （已追加部分、meta 未写）重跑不重复、不丢尾部；超出窗口的历史不回填（已知取舍）。
- 审计 def **不进世界**：效果执行只产审计草稿（`packages/host/effect/execute.ts` 的 `buildAudit`），
  由宿主单写者在侧存追加；`compact` 落 base 前机械摘除世界内审计 def，冷段 journal 中的审计 entry 照留
  （full verify 从空世界重放照常可寻址），`host.audit` 读不到该 def 时返回侧存可得部分（fail-open）。
- **`extern` 是确定性透传锚点（非效果）**：`{kind:'extern', payload}` directive 经 `run` 只原样产观测 `{kind:'extern', payload}`
  （`kernel.md` §十二）——**不写世界、不推进 head、不耗 gas、不发 `eff`、不需审计**（无 `EffRequest`，故「效果一律经宿主」不适用）；
  宿主把它原样回给发起者，不解释、不落账、不推进。用途：命令「无写返回值」（run 末尾 `extern(结果)`）、外部事件锚位。
- `write` **不落 `ref`**（审计住旁路侧存，无可指向的世界 def）；`ref` 字段保留给未来的世界内引用语义。
- `run` 照抄 `kernel.md` §十二；**只有 `done` 才落账**；续跑同 `run_id` / `now` / `directives`，
  `results` **只增不改**；审计不进世界、不推进链头，故续跑下一轮只需回灌**业务写后的 `world` / `head`**。
- **效果等待（内核 `waiting`）不跨宿主重启**（写死）：回合在效果上挂起时，在途态（`run` / `results` / 在途效果）**只住宿主内存**，无持久 run 游标、无自动重发效果——宿主重启后该 run 不自行续跑，已发出的效果也不重发。**未完成的回合由发起方插件负责察觉并重新提交**：插件须从自有持久存储（运行记录）判定上一回合未收口，重建并再提一次 directive / 命令。`host.run.spawn`（见「宿主扩展面」）**不是** `waiting` 的续跑——它是调用方驱动的**新 detached run**（无 socket、结果不回流、游标语义归调用方），与内核 `waiting` 的同 `run_id` / `directives` / `now` 续跑纪律无关。

**落账**

- **判定与落账分离**：写内容是**判定**的产物。一轮 `done` 的 `observations` 里带着 term 的求值结果
  （`{kind:'eval', entry, ok, value}`），宿主据此**原样**构造 `write` directive，由 `commit` 落账——
  内容不改，只做机械校验。
- **计划通道（term 产 directive）**：宿主只认**顶层 eval 观测** value 里的保留包装 `{"$directives":[...]}`——
  条目**原样取用**（不改 `kind` / `op` / `args`），宿主只机械填 `id` / `by` / `ref` / `expect_pos`；
  其余 value 一律作普通数据回发起者。
  plan 条目**插在本次提交剩余轮之前**（判定立即生效），可逐层递归；plan 里 eval 发 `eff` 时
  **继承产出它的 eval 的属主**（不按 entry 反查属主）。
  **eval 可按命令名解析**：plan 条目 eval 可写 `{kind:'eval', command:'<命令名>', args}` 代替 `entry` 哈希——
  宿主按命令声明解析入口 def（与命令面同路、机械），属主即命令声明方；term 拿不到他人 def 哈希时用它
  （如裁决 / 作答入口 term 产「按游标续跑」计划）。`entry` 形式保留；`entry` 与 `command`
  不可同条并存、也不可都缺（否则 `bad_directive`）；命令名解析不到 → `refused`（reason `unknown_command`，与命令面同码）。
- **分相（保序）**：一轮内不混 eval 与 write——连续 eval 合一轮（eval 不推进 head；审计进侧存、不推进 head，也不回改该轮 `ctx`），
  **`write` 每条单独一轮**（其 `expect_pos` = 该轮轮首链头；要原子写多份用一条 `batch`），`extern` 中性可随邻段。
- **term 可产全部 op**（含 `add_gen` / `set_active` / `retire` / `fork` / `graft`）——自改世界是 term 的能力，
  宿主不做 op 级限制。**v1 无 op 级鉴权**：内核不验 `by` 真实性（`kernel.md` §十四），宿主不限制 term 改哪个身份；
  正当性靠「term 是判定」（可审计、可回滚），结构 op 的审批闸门是后续上层能力，不属载体。
- run 内 `set_active` 只对**下一轮 / 下一 run** 生效（本轮锚定起点世代）。
- 真实位置只认 `done` 的 `head` / `journal`；`refused` / `waiting` 观测里的 `pos` 一律作废（`kernel.md` §十二）。
- 发起者（CLI / UI / 测试）可在**入站面**直接提交 directive；插件作为**服务**没有写链通道——它只能应答，
  或用 `event` 通知；它要以发起者身份改世界，得用**客户端身份**连入站面（见「命令」）。

**命令**

- 命令 = 插件在 `plugin.json` 里声明的**具名入口**（`name` → 入口 def + 参数 schema）；客户端按名字调用，
  宿主解析 `name`、机械校验 `args`、构造 directive 走一次 run。
- `args` 按 `argsSchema` 的 **JSON Schema 白名单子集**（方言见 `plugins.md` §二）机械校验；不符 → `bad_args`，
  **不构造 directive、不跑 run、不落账**。缺省 `argsSchema` = 不设门；缺 `args` = `null`；**只查形态，不查语义**。
- **只读命令**（`commands[].readonly`，缺省 `false`，显式非布尔入世拒）：声明为**纯查询**——宿主
  **不广播** `run.started` / `run.finished`、**不落 `EffectAudit`**、不推进链头；若其执行产出任何 write / plan，
  以 `refused`、reason `readonly_violation` 收口（**不落账、不执行 plan**）。**只读是声明方责任**：宿主不做语义判定，
  插件须在确认命令不写链、不产 write / plan 时才标（`forward` 帧按目标命令声明同规）。
- 命令**不是旁路**：判定仍是 term、写仍经「落账」；宿主不认识命令语义，只按声明路由。
- **框架保留命令名**（单一真源 `common/framework-commands.ts`，CLI 派发与入世校验同源；它是「框架保留的命令名」，CLI 与入世都是它的消费者）：`start` / `stop` / `run` / `status` / `seed` / `pack` / `verify` / `replay` / `unseeded` / `compact` / `commands` / `audit` / `assets` / `blobs` / `materialized` / `help`——插件命令一律不得占用（占 → 入世拒 `reserved_command_name`）。其中 `commands` 仍**问宿主**（客户端没有世界，读声明清单），`help` 是 CLI 本地打印帮助文本；其余为宿主命令与离线命令。
- 命令清单由宿主从声明读出——客户端没有世界。
- 发起者提交 `directive` / 命令时携带 `caps` / `limits`，宿主**透传不扩权**（缺省由宿主补默认预算；
  内核保证 `EffRequest.caps` 恒等于输入）；`now` 由宿主固定，不由客户端给。

**投影**

- 投影 = 宿主对世界的**只读视图**，作为 directive 的 `ctx` 交给 term；插件与 term 都不直接读世界。投影只读：不写链、不推进 head、不参与哈希。
- **v1 `base_only` 口径**：**基础世界 = 宿主当前世界**（由基础世界文件 + 尾段重放得到，随链头推进演化）；投影反映**构造时**的世界。
- **形状**：内核 `["g", path]` 是**静态字面路径**（无变量、不可解引用哈希），故以**身份名**为键、宿主预解析：
  ```
  { head:{seq,hash}, world_rev,
    ids: { <身份id>: {
      active: Hash|null, gens:[{seq,payload}], body: Json|null,
      data_gen: {seq,payload}|null,
      pins: { <能力类名>: <被依赖身份名> } | null,
      refs: [hash...], next_before: Hash|null } } }
  ```
  `gens` **不含履历**（`adopted` / `born`；与 `world_rev` 摘要口径一致）；`body` = **最近数据世代的组装结果**
  （整份世代取 payload def body；补丁世代取 base 世代组装后按序应用补丁；宿主解析；无数据世代则回落 active 世代 def body；都无则 `null`）；
  `data_gen` = `body` 的**组装来源世代** `{seq, payload}`（无数据世代 / 组装失败为 `null`）——写方据此把下一世代写成补丁世代（`add_gen` 携带 `base = data_gen.seq`）；
  `pins` = **当前代码世代 `commit.body.meta.needs` 的 `one` 绑定**（能力类名 → **被依赖身份名**字面值，含宿主哨兵 `host`；`many` 无单值绑定、不并入；无代码世代则 `null`）——
  机械、来自入世解析，供调用方入口 term 装配 bag（如校验「端口 ⊆ pins」）与运行期读自身 `pins` 的插件（工具目录 / 图闸）。同一口径（宿主侧 `effectivePins`）在起服务时注入服务工厂上下文 `pins`（stdio 经 spawn env `CHRONO_PLUGIN_PINS`，inproc / worker 经工厂 ctx），故服务运行期读到的 `pins` 与投影同值。
  **不给 `defs` 表**（哈希键静态不可达）、**不含源码 tree/blob**。按引用构造，O(#身份)，不深拷贝。
- **投影引用集合**：`refs` = `body` 里显式标记 `{"def":hash}`（单键、值须 64 位小写 hex）**直接出现**的哈希，排序去重后的**数组**；**只回引用、不回 body**，也不做传递闭包——深层 def body 由消费方沿标记逐跳经只读解析能力 `host.def.read`（见「宿主扩展面」）取回，投影不随历史内联整份闭包。`DEFAULT_REF_CAP`（1000）是该集合的**硬安全上限**（防异常数据撑爆投影），正常数据量远低于此；`next_before` 恒为 `null`（v1 无宿主侧翻页，窗口切片归调用方入口 term）。无标记的身份 `refs` 为空数组。
- **注入规则（三路统一）**：eval 的 `ctx` **字段缺省 ⇒ 宿主投影；显式给出（含 `null`）⇒ 原样透传**
  （客户端提交 / 命令 / plan 同规）。投影**按需构造**：含 eval 的轮构造一次、该轮 eval 共享（轮内 eval 不推进世界），
  **以该轮开头的世界为准**；write 轮不构造。

**世代**

- 触发 = 链头推进且**本插件自身代码世代换代**（依赖换代不触发，见「路由」）；
  改**数据** → 进程不动、热生效；改**代码** → 新服务 + 旧服务 drain。
- **数据世代不触发跟随**：`active` 在代码 / 数据世代之间移动（写数据、`set_active` 指到数据世代）
  **不判 `dep.stale`、不隔离、不动服务**；只有**当前代码世代**变化才走上面的换代逻辑。
  `dep.stale` 判据 = 该身份**找不到可解析的代码世代** / 该代码世代 stale。
- **数据 / 代码判据（机械，按 `members` 声明）**：跨代比对声明成员路径及其解析内容（文件 / 子树哈希）——
  任一 `execute` 成员路径增删或内容变化 ⇒ **代码**；仅 `term` / `schema` 成员变化 ⇒ **数据**；
  两类都有 ⇒ 代码（保守起新服务）；同一路径被 `execute` 与 `term` / `schema` 同时声明时 `execute` 优先。
- **依赖退役 ≠ 依赖换代**：依赖 `retire` / `set_active(null)`（依赖没了）→ 运行期 **fail-closed 隔离**——
  对该身份反向可达的发出者及其依赖者标 `not_loaded` + 记 `dep.retired`（与装配期坏分支隔离同口径）；
  依赖**换代**（新 active 已装载）只由宿主重解析路由、**不隔离**发出者。
- 端点表**原子切换**；在途 run 锚定旧世代，换代只对下一个 run 生效。
- `assembly` **只跟随、不改 active**；**不做**原地热补丁（`kernel.md` §八）。**入世时 `add_gen` 同时激活**（`kernel.md` §五）——新身份入世后即 active，由**发起者**提交（v1 的 `seed` 离线直写 `commit`，或运行时 directive）；assembly 不发 `add_gen` / `set_active`，只读其结果——`active` 为 `null` 的身份不在装配闭包内、不启动。

**写者**

- **同一时刻只有一个写者**；`verify` / `replay` 也持锁（日志可能正被写，读到半条会误判）。
- **锁粒度**：锁**只在 commit 期间持有**——run 可并发推进 eval / 等待效果，只在落账那一刻串行。**run 级并发**：多个 run 同时活动，并发只在 run 之间，每个 run 内部单 pending 不变。
- **提交队列 + 串行落账**：各 run 的 `commit` 进**单一提交队列**，宿主按**到达序串行**出账（仲裁序 = journal `seq`，不新增字段）；落账在单一互斥段内完成，段内**机械把 `expect_pos` 重锚**到当时链头——故 `pos_conflict` 结构上不产生，**没有「检测 base 冲突再自动重提交」这条路径**（见下条「落账段口径」）。按 per-thread 键控的身份 body（`body.slots[<thread_id>]`；**v1 已知限制**：整值 `put` 下不同键并非真正可交换——同线程键写者唯一、服务侧清槽的整份 body 取自入口 term 的轮首 ctx（权威）；跨线程 / 跨客户端并发仍 last-write-wins）；用户级共享身份以读为主，写罕见且 last-write-wins。入站 `submit` **accept 仍 FIFO、不抢占**（§七）；被 accept 的多个 run 可并行推进 eval，只在 commit 排队。
  - **落账段口径**：落账段（内核 `run` + journal append）在单一串行链内**无 await**，write directive 的 `expect_pos` 在段内机械锚到当前链头——即「在新链头上重放同一条 directive」，故结构上不产生 `pos_conflict`，**乐观重试路径不存在**（宿主不检测冲突、不重提交；写者的语义前提由各自 `expect_*` 门禁守，见 `kernel.md` §十二「run 级并发」）。语义等价于 append-only 写（`put` / `add_gen` 等内容寻址 op）可安全 rebase；  **读-改-写共享身份 body 的并发写仍是 last-write-wins**（键控身份靠 per-thread 键控化解；共享 body 的语义冲突检测由写者自理，当前无内置门禁）。审计走**旁路侧存**（不进世界、不占 `seq`），故业务写追加序 = `seq` 链序；在途 run 的效果路由锚定**本 run 段内所见的世界**（不跟随其他 run 的后续落账）。
- **停机序列**（`boot stop`）：按**启动序逆序**同步摘除各服务（依赖者先摘），随后**并发** `drain` / 终止并各自有界等退出（非逐个串行）→ 落盘 `fsync`（journal 本已 append-only）→ 释放锁 → 退出。并发 drain 是为快速收口、且单个卡住的服务不拖垮整体停机；**推论**：drain 期间依赖者可能仍在跑而被依赖者已先行退场，故依赖者在途调用可能得 `not_loaded`——这是**正常停机行为，不是故障**。停机**不写链、不改 active**。
- **压缩**：宿主在**启动时**尾段达到阈值（条数 `DEFAULT_COMPACT_TAIL_ENTRIES` 或字节 `DEFAULT_COMPACT_JOURNAL_BYTES`，先到者；任一设 0 关闭该触发）或离线 `boot compact` 时执行——
  ① 在链头追加快照 entry（`op:'snapshot'`，`args = { world_rev }`，应用时自校，锚不歪）；② 快照前的 entry 归档进
  `world/cold/`；③ 尾段 journal 重写为「快照 entry 起」；④ 写基础世界——小索引 `world/base.json`
  （快照位置 + `worldRev` / `snapshotRev` + `ids` + def 哈希清单 + 分片参数）+ def body 分片
  `world/defs/<gen>/<prefix>.jsonl`。
  这是宿主**第三处直写**（与 seed 同类），不走 run / directive；链头推进到快照位置。
  启动取用 = 读索引 + 尾段重放；`verify` / `replay` 仍读冷段 + 尾段全链校验。
  压缩幂等（离线 `compact` 只归档**当前 journal**，不重归档旧冷段）；`base.json` 缺失或与尾段不对齐
  （崩溃窗口）时**回落全链**（冷段 + 尾段按 seq 去重）重放——基础世界是派生缓存，丢了不砖化；仅其**形态损坏**才 fail-closed（`bad_base`）。
  离线 `boot compact` 支持 `--strict`（严格回收，缺省读 `CHRONO_COMPACT_STRICT`，默认保守）；
  strict 仅在世界未使用 `{"def":hash}` 标记之外的哈希引用（引用图完备）时安全，故只离线 / 显式启用。
- **分片与按需加载（读基础世界）**：`base.json` 只含小索引，def body 按 def 键前 2 位十六进制字符分片
  （`defs/<gen>/<prefix>.jsonl`，每行 `{h,d}`；`<gen>` = 落盘世界 `worldRev` 前 16 位，内容寻址、同摘要复用）。
  宿主侧 `DefStore` 提供 `get` / `has` / `hashes`：清单常驻、body 走 LRU 缓存按需读分片，
  列键 / 判存在 / 克隆只吃清单不读 body。LRU 同时受**条数**与**近似字节**（`JSON.stringify(body).length`，
  缺省 64 MiB）预算约束，单 def 超字节上限不入缓存、整片字节超预算只缓存请求项（防大 body 撑爆 / 抖动）。
  `loadAnchor` 读 base 时 defs 表是惰性代理，启动不把整世界 body 读进内存；只有真正取 body 的操作
  （投影取 active / 数据世代、命令解析 schema、补丁组装等）才触发分片读。
  写入半写安全：先落 `defs/<gen>` 代目录再原子换索引，随后清理旧代目录；分片批量落盘时**逐文件 fsync 保留、
  目录 fsync 合并为 rename 后一次**（`writeBase`）。**增量落盘**：键集与上一份 base 相同的前缀直接复用旧分片
  （硬链接，不支持时回退复制），只重写新增 / 变化的前缀——无需为整世界读取 body。**读取按「清单与分片是否一致」
  分档**：分片文件整体缺失 = 缺 def（fail-open，清单与分片同时丢，回落全链可重建），分片目录整体缺失 = 无基础世界；
  文件在却缺该键、行不可解析、或 body 复算哈希不等于其键 → 抛 `bad_base`（fail-closed，损坏不得当缺 def 静默吞掉，
  否则截断后的世界貌似自洽）。body 内容自校**按需**：整片入缓存的条目先记待校，各自首次取用才复算，故每份 body
  至多哈希一次，分片惰性加载的意义不被抵消。重写 base 时取不到 body 的键同样抛 `bad_base`——清单由世界现列，
  缺 body 即世界与分片不一致，静默滤掉会按缩减集重算 `rev` 而无声缩世界。
  内容自校**惰性化**：`readBase` 不 eager 算 `worldRev`，`BaseFile.verify()` 首次调用才算并按 `(file, mtimeMs, size)`
  缓存；`loadAnchor` 接驳处按需调用，不符即 `bad_base`（fail-closed，正常路径本就需要摘要，行为等价）。
  base 只认分片形态：读到其它形态即 `bad_base`（旧 base 可直接删除，由冷段 + 尾段全链重建）。
- **有界化回收（写 base 时）**：写 `base.json` 前，内核 `recycleWorld` 按可达性回收 def + 裁世代窗口
  （缺省每身份保留最近 `DEFAULT_GEN_RETENTION` 代 + active + 被 `graft` 引用的世代；装配依赖世代由宿主经 `keepGens` 下传），
  并机械**摘除审计 def**（审计住旁路侧存，非世界内容 / 世界根，不从 `dropRoots` 摘除）。
  **投影保留**：宿主按各身份 `latestDataGen` 把**最近数据世代**连同其 `{"def":hash}` 闭包哈希并入 `keepGens` / `keepRoots`
  下传——投影 `body` 取数据世代组装结果，落在窗口外被裁会让跨轮续跑取到不完整闭包而落 `denied`，故默认恒保留。
  **未达 def 与审计 def 不写进新 base**；保守口径只回收「被窗口淘汰根独有」的
  def，从未被任何根引用的业务 def 不碰（引用图不完备）；`strict`（离线 / 显式开关）才回收保留闭包外的全部 def。
  被淘汰世代不可再被 `set_active` / `graft` / 补丁 `base` 引用（fail-closed）。冷段归档保留历史，`verify` / `replay` 从冷段全链仍过；
  此时基础世界是全量世界的**子世界**，`base.json` 记 `snapshotRev`（快照 entry 的全量 `world_rev`）与本体
  `worldRev` 区分，`loadAnchor` 跳过快照 entry 自校、直接以子世界为起点重放尾段。回收失败 fail-open（退回未回收世界）。

**资产**

- **字节住宿主侧、引用进世界**：大块二进制（超限附件 / 截图 / 音频 / 导出物）的字节本体按内容寻址住
  `state/assets/<sha256>`（④ 不可重算，**不进世界、不参与重放**）；世界只存引用
  `{kind:'asset', sha256, mime, size}`（内联在引用方数据里，**不设登记身份**——避免单值寄存器写整表导致世界 O(N²)）。
- **入站面**：`asset.put {mime, bytes(base64)}` → `asset.ref`（宿主解码后算 sha256 落盘；`put` 是宿主侧存储操作，
  **不写链、不推进**）；`asset.get {sha256}` → `asset.bytes`。单帧 base64，原始字节 ≤ 8 MiB（base64 ≈10.67 MiB
  < 16 MiB 帧上限）；更大走分块（后置）。坏 base64 / 空 mime / 非 64hex → `bad_asset`；超限 → `asset_too_large`。
- **回收归属**：离线命令 `boot assets gc`（持锁）机械扫描世界里的 `kind:'asset'` 引用，删「世界无引用」的字节
  （只动 64-hex 命名的资产文件）；**不在宿主启动时自动删**。
- **备份口径**：备份世界（`state/world/`）≠ 备份字节；须连同 `state/assets/` 一起备份。
- **回放语义**：重放只复现引用，不复现字节；字节缺失时 `asset.get` → `asset_missing`（**已知限制**，非框架缺陷）。

**宿主扩展面**

> 以下为宿主动词，不改内核。投影闭包见「投影」；并发见「写者」。

- **受保护 `needs` 绑定不可删（入世校验）**：跨代比对**解析后属主身份集合**——旧侧 = 最近代码世代 `commit.body.meta.needs` 的 `one` 绑定值（身份名）；新侧 = 新 `one` 绑定值（身份名）。任一旧侧受保护身份不出现在新侧则**整批拒** `protected_pin_removed`；旧侧世代 / 声明读不出 → 同样 fail-closed 拒。按**解析后的身份**而非声明值比对，堵「受保护身份退役后另一身份 `implements` 同名能力类即静默改绑」的冒充洞。`many` **不构成**对受保护身份的依赖（0 命中可运行），受保护身份必须由 `needs.one` 满足。受保护身份表住**宿主侧**（不进世界，故连代码换代也改不动）。**存储类身份进受保护表**：运行记录的 owner 一旦把持久化委托给存储服务，新世代悄悄删掉该 `needs.one` 绑定等于让数据写入静默失效——与删 `guard` / `approval` 同类攻击面。比对基准 = 该身份的**最近代码世代**声明（**不依赖 `active`**：`set_active(null)` / retired 后重入世也要比对；有代码世代却读不出声明 → fail-closed 拒；身份不存在 / 无任何代码世代 → 放行）。理由：依赖关系是攻击面——新世代可借删绑定让上层强制失效。机械校验（只比较"旧世代有、新世代没了"），宿主不认识业务。**覆盖范围**：`seed` / `pack` 入世与 `validate_package` dry-run 同路；**裸运行期 `add_gen` 不经过入世门禁**（v1 无 op 级鉴权，见 §七 末），这条守卫不覆盖它。
- **密钥本地存储面**：入站 `secrets.put {name, value}` / `secrets.delete {name}`——宿主直写用户本地文件（`state/secrets.local.json`，`0600`），**不经 run、不进世界、不进审计**；与 `asset.*` 并列。
- **效果审计脱敏 + 体积截断**：`EffectAudit.result` 按**被调身份 `schema.audit_redact` 声明**（`{"<能力类>.<方法>": [键...]}`；精确 `<port>.<method>` 优先、其次裸 `<method>`，与 `method_timeouts` 同先例）脱敏——命中方法的 result 只落白名单键 + 派生 `has`（不含本体），未声明落完整结果；声明住被调身份自己的 schema，调用方无从伪造（落点 `packages/host/audit-redact.ts`）。对 `host` 批量方法（`asset.get` / `source.read` / `audit`）结果超过 `MAX_AUDIT_RESULT_BYTES`（64 KiB）时只落 `{truncated:true, size}`——否则 8 MiB 资产 / 拷入既往审计记录的 `audit` 会把世界 / journal / 审计侧存撑爆（调用方仍拿完整结果）。**审计记录的 `request.args` 不再内嵌正文**：只落**形状摘要**（顶层键 + 各值体量 + 被 `audit_redact` 白名单放行的 `auth_ref` 字段），保留定位所需的 `id` / `port` / `method` / `caps`；形状摘要仍超 `MAX_AUDIT_ARGS_BYTES`（64 KiB，防键数异常多）时退化为 `{truncated:true, size}`（调用方仍拿完整 args）。
- **反向调用 `env` 值脱敏（端口审计）**：反向 `port.call` 转发时，宿主侧端口审计对 args 顶层 `env` 字段的**值**一律替换为 `{redacted:true, keys:[…键名]}`（键名排序、确定性；目标服务照收原值）——密钥经执行请求的 `env` 通道下传时不落宿主侧记录。它与世界审计脱敏（按 `schema.audit_redact` 声明）是**两处独立口径**：端口审计一律脱敏 `env` 值，世界审计按声明逐方法脱敏 `result`。**端口审计与 `EffectAudit` 分流**：不进世界、不写链、不参与重放。**落点**：`packages/host/port-audit.ts`——宿主侧有界内存环形缓冲 `PortAuditRing`（容量常量 `PORT_AUDIT_CAPACITY` = 256，满即覆盖最旧），宿主 options `portAuditSink` 可注入 sink 覆盖（库调用方 / 测试；注入时记录**同时**写入缺省环形缓冲，sink 抛错只隔离该旁路、不阻断转发）；`HostHandle.portAuditRecords()` 暴露该环形缓冲的**只读快照**（时间正序、有界，缺省读取面，无需注入 sink）；记录形状 `PortAuditRecord = { at, from, target, port, method, args, run, thread }`（`from` = 发起服务身份、`target` = 路由解析出的目标身份、`args` 已脱敏）。
- **插件源码读面**：`host.source.read { identity, path } -> { path, content(base64), size }`——把某身份的源码 `tree` / `blob` 按路径读给插件（世界 ① 有源码，投影不含 `tree` / `blob`）。可见性过滤由调用方负责，宿主不做。
- **插件 ③ 目录**（`state/plugins/<id>/`）：可重算产物（缓存 / 向量索引 / 水位）落此，起服务前为本身份 `mkdir` 并注入 **`CHRONO_PLUGIN_STATE`**（只本身份路径）；这是**路径约定、不是 fs 隔离**（v1 无沙箱）。宿主统一 GC：启动时（抢锁后、装配前）机械删目录名 **∉ `world.ids`** 的顶层项（`retire` 只置 `active=null`、id 仍在 ⇒ 保留），失败不阻锁释放。与 ④ `state/data/<id>/` 分开、保留策略不同；身份名安全校验见「插件持久数据」与「源码」。起服务时宿主另注入**有效 pins** = 该身份代码世代 `commit.body.meta.needs` 的 `one` 绑定（`many` 不并入；无代码世代不注入）：stdio 走 spawn env `CHRONO_PLUGIN_PINS`（JSON），inproc / worker 走服务工厂 ctx `pins`——运行期读自身 `pins` 的服务（工具目录 / 图闸 / 降级候选）据此与投影同值。另注入 **`manyNeeds`**：该身份 `needs` 中 `mode:"many"` 的能力类 → 世界能力索引成员身份名（码元序）——扩展点枢纽据此发现成员；成员集变更 = 世界变更 → `applyWorld` diff 成员集并重启消费方以重注入（stdio 经 spawn env `CHRONO_PLUGIN_MANY_NEEDS`，inproc / worker 经服务工厂 ctx）。**data 世代热生效不改绑定**（`one` 绑定住 `commit.body.meta.needs`，换提供方即新 `commitHash` → 新 pins 随新世代落账、随新服务起）；代码换代随新服务更新，重启亦按当刻世界重算。
- **非 TS 插件与原生子组件物化**：插件包入世只含**源码 + 依赖清单**（`package.json` / `Cargo.toml`）；编译产物 / 依赖目录 / 原生扩展（`node_modules` / `target/` / 二进制 / `*.node`）**走宿主侧 ③ 依赖缓存**，宿主物化时按声明恢复；宿主仍只按 `plugin.json.start` 起服务。**构建声明权归插件**：`plugin.json.build = [{cmd, args}]` 是**唯一来源**，宿主只执行、不解释语言（与 `start` 同性质）；字段必需，缺失即入世拒 `bad_plugin_decl`。**口径**：物化后、spawn 前按声明派发——只跑声明的（空数组 = 无需构建），宿主不再按包内文件探测语言（`package.json` / 锁文件 / `Cargo.toml` 皆不读）；`cmd` / `args` 令牌须过 shell 安全白名单（`[A-Za-z0-9_./:@,+-]`），否则入世拒 `bad_plugin_decl`。缓存住 `state/deps/`（npm 下载缓存 `state/deps/npm`、Rust `CARGO_TARGET_DIR=state/deps/cargo-target`）；`node_modules` / `target` 落**物化目录**（③，内容寻址复用）。恢复完成后在物化目录写 `.chrono-deps-ok` 标记，标记在则跳过（**以标记而非 `node_modules` 存在性判完成**，半恢复可自愈）；恢复失败 → 服务启动失败 `service.start_failed` reason `deps_failed`。**标记按物化目录隔离、物化目录名 = 内容定址的 commit 哈希**：源码一变换代即落新目录、天然无标记 → 依赖与构建自动重跑，故「只改源码不改依赖」的热更不会跳过重新构建。**恢复命令借 shell 解析**（win32 上 `npm` 是 `.cmd` 包装脚本，`shell:false` 会 `EINVAL`）并**前置同一 `startWrapper`**——依赖安装与构建会跑插件声明的 lifecycle 脚本，不能成为绕过沙箱的口子。
- **投递目录大资产直拷（`assets_manifest`）**：插件 `schema` 顶层可选 `assets_manifest: [{ path, sha256, size }]`
  ——声明「被 `.worldignore` 排除、但构建 / 运行需要」的大资产（模型权重、tokenizer 等）。宿主物化时按清单
  **从投递包源目录**（`state/plugins.json` 解析到的包路径）把文件复制到物化目录对应路径，按 `sha256` 校验；
  源文件缺失 / 校验失败 → `service.start_failed` reason `deps_failed`（与依赖恢复同口径）。宿主不触网、不认识资产内容；
  ③ 可重算性 = 「源目录 + 世界源码」可重算（源目录本身丢失则不可重算，须重新投递——插件自述须如实登记）。
  构建期输入（如模型权重 / tokenizer）走此路（`include_bytes!` 等构建期输入由直拷满足）。
- **按队列项游标触发新 run**：`enqueue` 类方法**正常返回**（那轮不是 `waiting`）；正确形状是本 run 正常结束、`item` 带 resume 游标（`iter`/`cursor`/slots 引用），裁决 / 作答落账后**续跑（v1 = 裁决 / 作答命令的入口 term 产「按命令名续跑」计划，经 plan 通道按命令名解析起后续轮——见 §五 落账「plan eval 按命令名」）**。与内核 `waiting` 续跑（同 `run_id`/`directives`/`now`）**不是同一机制**。
- **等人是回合级挂起，不是内核 `waiting`**（写死，否则等待语义会被误接到效果挂起上）：人类审批 / 提问是**无限期**等待，而内核 `waiting` 要求同 `run_id` / 同 `directives` / 同 `now` 续跑、在途态只在宿主内存、停机即丢、`now` 固定（`now` 进 `entryHash`，改了就不再逐字节一致）。故等人**绝不挂在内核 `waiting` 上**：
  - 该 run **正常收口**，但收口形态必须是**显式「已挂起」**（带挂起原因与 resume 游标），不得静默走 sink——静默收口会让"等人"与"跑完了"在观测上不可区分。
  - **收口前先把本轮已发生的事实落账**（用户消息、助手消息、已执行工具的结果）。判据：那些事实**已经发生**，其存续不该取决于后续是否获批。缺了这条，下一轮取用读不到它们，模型会丢失上下文（见「入世判定」与运行记录的边跑边追加口径）。
  - 挂起态与 resume 游标**必须持久**（运行记录落 owner 存储），故跨宿主重启仍可裁决续跑。
  - 图数据须为**每种非终结裁决备出边**（如 `pending`）；某返回值在当前图里无出边 ⇒ 该轮无路可走、静默收口 ⇒ 本轮写入丢失。这是**图数据的完备性义务**，宿主不代为兜底。
- **定时触发**：宿主按插件 `schema` 的**顶层 `periodic` 数组**声明周期起一次 run。每条声明 `{ command | method, every_ms, reads? }`：
  - `command` 条目按该身份声明的入口 term 构造一次 `eval` run（与命令同路）；`method` 条目**直接调该服务方法**（能力类由声明里含该方法者定），方法返回的**计划值 `{"$directives":[...]}` 由宿主按该身份落账**（无计划值 = 本拍无写，按 `done` 收口）。
  - `reads` 是 `{ <bag 键>: <投影字面路径> }`；宿主按路径**机械取用**投影片段放进 `bag`（无 `reads` → `null`），**服务不读投影**。
  - 周期 run 记宿主 `run.started` / `run.finished`（`thread` 恒 `null`，`origin = 'periodic'`）；单条目上一拍未结束则跳过本拍；声明非法只记 `dep.periodic_invalid` 运维日志、不阻断其余；声明变更随 `applyWorld` 增量对齐（计时器不因每轮落账重置）。
  - **`every_ms` 上界 = `MAX_CALL_TIMEOUT_MS`**（计时器硬上限 `2**31-1`）：超过会令 `setInterval` 溢出成立即触发（1ms）→ 周期风暴，故超限按 `bad_every_ms` 记 `dep.periodic_invalid`、不进入调度。
  - 周期声明住各插件 schema（如后台同步 / sweep / aggregate 类方法）。
- **插件入站转发**：前端壳可经主端口同源反代（`/p/<id>/*`）把入站帧转发到目标插件服务（保「唯一主端口」，壳不自连插件服务）。入站帧 = `forward { identity, command, args? }`：宿主按 `command` 解析入口 term、**要求其属主 = `identity`**（否则 `unknown_command`），构造一次 run（`initiator = "forward"`）；即「入站帧按声明的入口 term 构造一次 run」（入站翻译产命令 + 写槽计划，服务无写通道）。命令名由壳侧 `/p/<id>/*` 映射提供；宿主只做机械路由与身份约束。
- **入世校验 dry-run 面**：`host.validate_package { files } -> { ok, errors: [{code, path, message}], result_hash }`——`files` 是 `{ <包内路径>: <text 字符串 | {text} | {base64}> }`（路径必须安全单段、禁逃逸；base64 只收规范编码）。宿主把候选树落临时目录（③，用后即删）后**复用 `seed` / `pack` 同一套 `planPack`** dry-run（`plugin.json` 字段形状（`schema` 可省略）/ 包内路径约束 / `argsSchema` 方言 / 受保护 needs 绑定完整性 / term 环 / `.worldignore`），**不写世界**；`result_hash = H(规范化候选树)`（= 该候选树的 `commit` 哈希；`planPack` 未通过时为 `null`）。调用方写身份前必须携带该 `result_hash`（缺 → `validate_required`）。
- **服务侧资产存取面**：`host.asset.put { mime, bytes(base64) } -> { kind:'asset', sha256, mime, size }` / `host.asset.get { sha256 } -> { bytes(base64), mime, size }`（缺失 → `asset_missing`）——字节按内容寻址住 `state/assets/<sha256>`（④ 不可重算、**不进世界、不参与重放**）；服务经**反向调用**读写字节，返回的引用由调用方写进世界数据。规范 base64、原始字节上限 **8 MiB**（与入站 `asset.put` 同口径），更大走分块（后置）。供插件读写二进制字节（能力未实现时调用方可回 `binary_unsupported`）。
- **宿主保留能力类 `host`**：宿主暴露保留身份名 `host`（**不进世界**），`needs` 中保留键 `host` 的 `one` 绑定在入世解析时绑定到**宿主自身**（受保护 needs 绑定校验同样认它）。方法：
  - `run.spawn { entry, args?, thread? } -> { run }` / `run.cancel { run } -> { ok }`（run 生命周期；旧名 `thread.resume` / `thread.terminate` 作为**弃用别名**并发保留一个协议版本，命中即记 `host` `method_deprecated` 运维日志）。`run.cancel` 等价 `cancel{run}`（未知 → `unknown_run`）；`run.spawn` 是**宿主通用原语**——起一次 detached run（无 socket、结果不回流、事件照广播），`initiator` = 调用方 emitter，宿主**不认识游标语义**（游标由调用方放进 `args`）；detached run `caps:{}`、`thread` 缺省 `null`、事件 `origin = 'detached'`，并发上限 `MAX_DETACHED_RUNS`（超限 `too_many_runs`）。
  - `audit { filter?, limit? } -> { records, truncated }`（只读审计面，供服务读 `EffectAudit`；`filter` 与入站 `audit` 同形，seq 降序、缺省 100、上限 1000）；
  - `identities {} -> { list: [{ id, active, implements, commands }] }`（只读**身份清单面**：宿主从世界 + 各身份当前代码世代声明机械读出。不含有效 pins 明细——pins 在投影 `ids.<id>.pins`）；
  - `source.read { identity, path } -> { path, content(base64), size }`（只读源码读面；投影不含 `tree`/`blob`，见「插件源码读面」）；
  - `def.read { identity, hashes } -> { defs, missing, denied, truncated }`（只读 def 解析面：投影 `refs` 只回引用哈希，消费方沿标记逐跳取 body，见「投影」）。`identity` 是解析基准；**越权门禁** = 只放行从该身份**组装后 body** 可达的 def（`reachableDefHashes`，含补丁世代 base 上的引用），不可达进 `denied`、世界缺失进 `missing`。单次哈希数上限 256（超 → `def_read_too_many`）、返回体字节上限 4 MiB（超出部分进 `missing` 并置 `truncated`）；`identity` 省略 / `hashes` 非数组 / 非 64-hex → `bad_directive`，身份不存在或 body 组装失败 → `not_found`；
  - `validate_package { files } -> { ok, errors, result_hash }`（见上「入世校验 dry-run 面」）；
  - `blob.put { bytes(base64) } -> { kind:'blob', sha256, size }`（源码字节落 CAS，回 pointer def body；供上层写计划在 `put(pointer)` 前把字节本体交给宿主。规范 base64、原始字节上限 8 MiB）；
  - `asset.put` / `asset.get`（见上「服务侧资产存取面」）；
  - `identities.suspend { id } -> { ok }` / `identities.resume { id } -> { ok }`（**保留索引的运行期隔离**）：休眠 = 世界 `active` 不变、停服务、摘端点，并**一并摘除该身份的判定承载方法可路由性**（判定不住端点表，故须显式按休眠集摘除）——`one` / `many` / 判定递归一致收口 `not_loaded`；**仍入能力索引**（`many` 该成员元素错误 / `one` `not_loaded`）。休眠态**不持久**（重启即全恢复）、`applyWorld` 对休眠身份跳过换代启动（仅显式 `resume` 按其当前代码世代重启）。`id` 不存在 / 无代码世代 / 已退役（`active=null`）→ `not_found`；**已是坏分支隔离态** → `isolated`（隔离只由**新代码世代的复归判定**解除，显式 `resume` 不绕过）；重复 `suspend` / `resume` 幂等返回 `{ ok }`，`resume` 后未真正起来（仍被隔离）也报 `isolated`。
  保留能力类供上层插件共用；宿主只做机械路由与内容寻址。**v1 受信面**：无方法级鉴权——任何 pin `host` 的插件都可 `audit` / `source.read` / `asset.get` / `run.cancel`（过滤责任在调用方，宿主不强制）。
  - **host 哨兵的运行期限制**：`host` 仅作 `plugin.json.needs` 的保留键，入世期解析为宿主自身；内核 `add_gen` / `put` / `graft` 的 args 不含 pins 字段，运行期结构 op 无法表达宿主依赖。
- **线程控制面**：线程数据面（发送 / 状态）由上层服务提供，宿主不直造其 body；run 生命周期方法见上 `host` 能力。
- **宿主事件面**：宿主自身在 **run 生命周期**广播事件——`run.started`（受理并开始推进）/ `run.finished`（收口，`status ∈ done/refused/idle/cancelled`；**异常路径也必发**，status 记 `refused`）；`run.started` 与 `run.finished` **严格成对、恰好一次**（**只读命令除外**——纯查询不广播生命周期，见「命令」）。载荷带 `run` / `thread` / `origin`（`command` / `forward` 另带 `name` = 目标命令名；`run.finished` 另有 `status` / `reasons`）——`origin ∈ submit/command/forward/periodic/detached`，`origin` 只分 run 类别（`command` 同时覆盖对话回合与管理命令，区分具体命令看 `name`）；`reasons` 取自该 run 收口 `observations` 末条 `kind:'refused'` 的 `reasons`，无则 `[]`（`status=refused` 时说明收口原因）。与插件 `event` 同路经入站面广播给已连接客户端（`impl = "host"`），**不落账、不推进、不进世界、不进运维日志**。`thread` 来自发起者提交时的可选字段（原样回带、**不校验**，是展示标签非安全边界）；detached / 周期 run 恒 `thread:null`。用途：UI 运行角标、发送 / 终止形态、回合完成通知。宿主**不解释业务**，只广播自身 run 的起止。
- **通知面（身份世代语义化）**：链头推进、装配跟随完成后，宿主**逐身份** diff 上一份已应用世界与当前世界，广播 `identity.changed { identity, kind: 'code'|'data', active, prev }`（`impl = "host"`）：该身份**代码世代 `active`** 变（含新增 / 退役）→ `kind:'code'`（`active` / `prev` 为代码世代哈希）；仅**最近数据世代 payload** 变 → `kind:'data'`（`active` / `prev` 为数据世代 payload）；无变化不发。宿主**不解释身份语义**，缓存型读侧据此**只在 `code` 变更时失效重取**（如壳的 headless 入口字节），`data` 变更不失效。**跟随失败不升级**：`runtime.applyWorld` 失败或世界已应用后的尾段副作用（逐身份广播 / 审计分档世界切换 / 周期对齐 / 方法超时重报）失败都只记 `host` `follow_failed`、**不 reject、不升级致命停机**。`applyWorld` 失败不推进跟随基准（不自动重试同一链头，待后续更高链头再次跟随才从上一份已应用世界重 diff 重试）；尾段副作用失败时世界已应用，跟随基准照常前进，由下一次跟随收敛（失败窗口内运行态可能与世界短暂不一致）。
- **源码 CAS（源码字节内容寻址）**：源码字节住内容寻址存储 `state/blobs/<sha256>`（④ 不可重算；**只增**、离线可达性回收）；① 里留下源码的**声明与内容身份**——`commit` def、`tree` def、每文件的 blob **指针 def** `{kind:'blob', sha256, size}`、term def、schema def、`sig`。指针 def 的 `kind` 是唯一判别位（对象体安全失败 `bad_blob`，不会把哈希串当内容写出）；`sha256` 兼作 CAS 文件名与读取校验，`size` 防截断；def 键 = `H(pointer def)`，与 `sha256` 不同，tree 仍引用 def 键，故 **tree / commit 的哈希结构与结构共享不变**。二进制文件同样走指针形态，CAS 存原始字节（非 base64）。读取侧（`materialize` / 声明解析 / `source.read`）**同时支持 inline 与 pointer**。
- **源码物化（指针经 CAS 解析 + 硬链接共享）**：物化对每个 pointer file entry 读 `state/blobs/<sha256>` 并校验 `size`，以**硬链接**接入物化树（同一 blob 在多个世代里指向同一 inode）；`EXDEV` / `EPERM` / `EMLINK` / 目标文件系统不支持时**回退普通复制**。共享前提是 CAS 不可变：物化时把源码文件置**只读**（POSIX `0444`、Windows 清写位），服务对物化目录的写只允许新增文件、不得覆盖源码文件。CAS 缺失 → `blob_missing`（与 `asset_missing` 同口径，属已知限制）。
- **回收分档（`materialized` 与 `blobs`）**：`state/runtime/materialized` 是 **③ 可重算**，按「active 代码世代 + 前 N 代」回收（只删 64-hex 命名的目录、跳过 staging；触发点在启动抢锁后或离线命令，**绝不在 run 中删**）。`state/blobs/` 是 **④ 不可重算**，只做**可达性**回收——沿每个身份每个世代的 `commit.body.tree` 递归遍历 `world.defs`，删不被引用的 64-hex 文件；**离线、持锁，不在启动时自动删**（与 `assets gc` 同规）。**回滚承诺不由 `materialized` 承担**：`set_active` 指回任意世代恒可由「① 的指针 def + CAS 字节」重建，保留前 N 代只是缓存命中优化，故 blobs 的可达集覆盖**全部世代**（不是 active + N）。

**其它**

- 插件服务的状态档按声明两分：`recomputable`（③，缺省，落 `state/plugins/<id>/`，可随时删）与 `durable`（④，落 `state/data/<id>/`，进备份、只按身份消失回收）——口径见「插件持久数据」。**未声明 `durable` 的服务不得把数据写进物化目录当持久层**（物化目录仍是 ③，见「源码」）。
- 密钥不进世界：世界数据只存引用 `auth_ref = {kind:'local'|'env', name}`（引用形状由身份数据契约冻结；`local` 读宿主侧用户本地文件，`env` 读进程环境）。本体不进世界、不进审计、不进 config 导出；重放只复现引用、不复现密钥。这是**身份 body 字段**，不是 `plugin.json` 的 ④ 状态档。
- **服务断连自退出**：插件服务检测到与宿主连接断开（**stdin EOF / 管道断开**）即**自退出**（服务协议义务，见 `docs/protocol.md` §2.7）——避免宿主崩溃后孤儿进程占端点。
- 判定 / **决策路由** / 评分 / 门禁写成 term；**能力解析路由**不是判定，是宿主的机械解析（见「路由」）。
  取用 / 效果执行 / 装载在宿主（`kernel.md` §十）。
- 执行件永远不承担校验。
- 世代跟随走**宿主通知**；插件**不开世界读通道**（避免两份世界视图）。
- 插件的 `event` **只透传给入站面已连接的客户端**（按 `impl` 命名空间，见 `docs/protocol.md` §三），
  不投递给其他插件（投递需要宿主理解 `kind` = 认识业务）；宿主不执行、不落账、不推进。
  宿主自身的 run 生命周期事件（`run.started` / `run.finished`）与身份世代事件（`identity.changed`，见「宿主扩展面」）同路广播，`impl = "host"`。
- **两种「审计」分流**：`EffectAudit`（旁路侧存 `state/audit/`，有界保留、不进世界——内容可追溯，见「效果」）；
  载体生命周期事件只进**运维日志**——宿主侧持久 append-only 文件（`state/lifecycle.log`，JSONL，逐行原子写），**不进世界、不进链、不参与重放**、宿主崩溃不丢。
  运维日志不属于 ①②③④（那是世界内容分类）；它是宿主独有的操作取证。assembly 只读世界、不写链——生命周期事件落运维日志不破此界。
- **运维日志事件 = 两级 `{ kind, event }`**（`kind` 封闭、`event` 每 kind 有规范表）——**结构上不可能撞名**：

  | `kind` | `event` | 载荷 | 触发 |
  | --- | --- | --- | --- |
  | `host` | `start` / `stop` / `start_failed` | `reason?` | 宿主自起停 / 启动选项非法 |
  | `host` | `watch_start` / `watch_triggered` / `watch_applied` / `watch_follow_failed` / `watch_failed` | `impl?`, `gen?`, `reason?` | 源码 watcher：开监听 / 检测到改动 / 换代接管 / 新世代构建启动失败（旧版本继续）/ 入世或监听失败 |
  | `host` | `gc_failed` / `plugin_discovery_skipped` / `journal_tail_repaired` / `listen_error` / `persist_fatal_stop` / `run_failed` / `follow_failed` / `protected_pins_unset` | `reason?`, `run?` | 启动三处 GC 失败 / 目录发现跳过坏目录 / journal 撕裂尾修复 / 入站监听运行期错误 / 落账致命升级停机 / run 异常收口 / 世代跟随失败 / 受保护 needs 绑定未显式配置 |
  | `host` | `method_deprecated` | `cap?`, `reason?` | 命中宿主保留方法的弃用别名（`cap` = 保留能力类、`reason` = `旧名 → 中性名`） |
  | `host` | `invalid_frame` | `reason` | 入站畸形帧无法配对（记后断连，不影响其它客户端） |
  | `host` | `capability_owner_conflict` | `cap`, `caps`, `reason?` | 同一能力类多个拥有方（仅告警，契约仍取码元序首个） |
  | `dep` | `cycle` / `stale` / `drift` / `retired` / `periodic_invalid` / `method_timeout_invalid` / `assets_manifest_invalid` / `suspended` / `resumed` | `impl`, `cap?`, `reason?` | 装配解析 / 依赖退役 / 周期、方法级超时与资产清单声明非法 / 运行期休眠 · 恢复 |
  | `handshake` | `failed` / `extra_dropped` | `impl`, `gen`, `caps?` | 握手校验 |
  | `service` | `start_failed` / `exit` / `restart_exhausted` | `impl`, `gen`, `reason?` | 起服务 / 进程 |

  记录 = `{ at, kind, event, impl?, gen?, cap?, reason?, caps?, seq?, run? }`（`at` 必有；`seq` 可选、仅换代类事件有；`run` 可选、仅 `run_failed` 等 run 异常事件有）。
  **注**：`docs/protocol.md` §四 的**错误码**（`handshake_failed` / `cycle` / …）是给客户端的，**与运维日志事件是两套命名**（错误码保持扁平）。

## 六、载体不变量

1. **世界写者唯一且必经校验**：`journal` 单链 + `expect_pos` CAS ⇒ 世界那一处由载体独占写；插件服务永不写链，改世界一律经内核 `commit` 四步校验——常规走 `run` 的 write directive，离线 `seed` 由 `boot` / 宿主直写 `commit`；审计写旁路侧存，不写链。**写者唯一是各落点各自的性质**：其余落点各有其写者（见「写入落点」）。
2. **效果必审计**：每对 `EffRequest→EffResult` 必有 `EffectAudit` 记录（旁路侧存 `state/audit/`，有界保留、不进世界）。
3. **运行记录不进世界**：判据两问皆否者（回滚不该带、判定不从世界读）不构造 `write` directive，由 owner 插件写自有持久存储；每份运行数据**单 owner** 写，跨身份读写经能力调用（见「入世判定」）。载体对该落点只做建目录 / 注入路径 / 按身份回收 / 备份归属四件机械事。
4. **插件间不直连**：效果一律经宿主。
5. **运行态不进世界**：物理端点 / pid 只住宿主侧 ③。
6. **不扩权**：`EffRequest.caps` 恒等于输入（内核保证；宿主不扩权）。
7. **落盘字节保真**：`Entry.args` 不重序列化。
8. **声明驱动**：`assembly` 不认识插件种类，只看声明与 `needs`；持久数据档同样按声明（`state` / `exclusive`），宿主不解释存储内容。
9. **无特权**：toy 服务与任何插件同路，无任何插件享有特殊路径（`kernel.md` §十一「第一方无特权」的载体面）。第一方存储服务同此——它是普通插件，可被替换、可被卸载。
10. **插件不 import 宿主与内核**：插件不得 import `packages/host` / `packages/kernel`，也不得把它们作 npm 依赖；服务代码同样不得 import `packages/client`（它 import 内核）。对宿主的依赖只经**线协议 + `needs`**（能力类名 / 方法名，保留类 `host`）；插件只提交**定义内容**与效果请求，不算哈希、不校验、不写链。

## 七、本设计不做什么

- 不重述内核口径：`stale()` 判定、`run` 语义、`batch` 两段式、链格式一律以 `kernel.md` 为准。
- 协议实体在 `docs/protocol.md`（服务协议 / 入站协议 / 错误码）。
- 不做原地热补丁、不做多写者、不做多链合并、不做调度、不定义审批语义。
- 不定义判定标准：门禁 / 评分 / 路由策略都是 term。
- 不含 `partial` 取用 / 派生索引的设计。journal 压缩（快照 entry + `world/cold/` 归档）见「写者 · 压缩」——那是宿主启动 / `boot compact` 的账本维护，不是产品级归档 UI。
- 不做插件资源隔离（内存 / CPU / fd 上限）——插件是独立进程，OS 提供基础隔离；资源限额列为后续插件契约。
- 不做 `event` 背压 / 订阅过滤 / 持久——`event` 无 ack、无客户端即丢、无 topic 订阅（见 `docs/protocol.md` §三）。
- 不做命令发现的授权过滤——`caps` 闸执行不闸发现；v1 单机受信。
- 不做并发 `submit` 的抢占调度——入站 `submit` **accept FIFO**（先到先 accept，不插队、不抢占已 accept 的 run）；与「写者」节的 run 级并发不冲突：多个已被 accept 的 run 可并行推进 eval，只在 commit 排队。`status` 非阻塞快照、可能瞬态。
- **不做结构 op（改 / 加插件）的审批闸门**——那属上层能力，不属载体。载体只保证：世界那一处写者唯一且一切写经 `commit` 四步校验、坏分支只隔离（fail-closed；例外：自身代码换代时新世代构建 / 启动失败保留旧服务，见「装配」）。⇒ **人类审批必须落在上层**；否则世界里的数据可以命令宿主持久化并 spawn 新进程执行任意内容。
- **运行期写出的包不过入世门禁（已知不对称，属已知取舍）**：`boot seed` 走 ingest 的全套门禁（声明形状 / 路径约束 / `argsSchema` 方言 / term 环 / `.worldignore`），而运行期 `add_gen` 写包只走 `commit` 的形态 / 引用 / 位置 / 不变量校验，宿主仅在命令路径补一次 `argsSchema` 方言元校验。兜底：坏声明由装配期 `parsePluginDecl` 拦下 → 该分支隔离，不炸宿主；但坏 schema / 坏 term 可能到运行时才暴露。
