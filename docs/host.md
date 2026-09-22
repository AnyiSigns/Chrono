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
| `assembly` | 装配：声明解析、`pins` 闭包与拓扑、源码物化、起停服务、握手、端点表、世代跟随 | **只读世界**；不 import `effect` / `ledger` 写口 |
| `effect` | 效果：连接与调用、通用 run loop、效果执行、`EffectAudit`、唯一写口、`results` 回灌与续跑 | 不装载、不认识插件种类 |
| `ledger` | 账本：journal 文件、`verify`、`replay`、基础世界、单写者锁 | 只按内核口径落盘 |
| `projection` | 投影：`base_only` 只读投影 | 不写 |

不在载体里的两个包：`packages/boot`（CLI 薄壳，**genesis 常量**）与 `packages/client`（入站面客户端库）。

两条边界写死：

- `assembly` 只读世界——"不认识插件种类"由此成为 import 图上的事实，而不是文档形容词。
- **插件不 import 宿主与内核**（`packages/host` / `packages/kernel`）：键 / 哈希 / 校验 / 写链全在宿主（`kernel.md` §十一 / §十八）。
- **「不认识」双向且只在实现面**：宿主不认识插件种类（只读声明与 `pins`），插件不认识宿主实现（不 import）；**契约面双向都认识**——宿主认识 `plugin.json` 与协议，插件认识协议帧 / 能力类名 / 保留类 `host`。插件对宿主的唯一合法依赖通道 = **线协议 + `pins`**（含 `host`），不存在源码依赖通道。

**没有特权引擎**：「agent engine」不是某个插件，而是**宿主 + 全部插件 + 世界**的组合。
宿主驱动的是**通用 run loop**，不认识回合 / 图 / 编排语义；`engine` 若作为插件存在，只是一个普通服务，
宿主不给它任何特殊路径。

**自改安全**：引导器已并入宿主；自改的安全来自「**正在运行的旧实例监管下一代实例**」——
被改对象是下一代源码，执行体是当前运行实例，天然满足"不在被改对象里"。
首个 `boot` 二进制是 **genesis 常量**；最后一个实例整体崩溃时的恢复靠外部拉起（ops，不是设计角色）。

## 二、契约面

载体吃四类输入、开一个入站面、产出一个输出，全程不解释业务语义：

- **输入 1 · 世界**：宿主侧的日志真源 + 基础世界（宿主可持有，**可为空**）→ 读 active 世代与插件声明。
- **输入 2 · 声明**：`plugin.json`（住 ① `defs`）——字段清单见 `docs/plugins.md` §二。**npm 只是投递信封**；宿主只解释 `plugin.json`，`package.json` 等其余包内文件是源码 blob。
- **输入 3 · 插件包清单**：`state/plugins.json`（③，gitignore）——要加载的插件包列表 `[{name, path?}]`：有 `path` 按路径解析（本地 / toy），无 `path` 走 Node 解析（`node_modules`）。入世的包源由它给出。
- **输入 4 · 平台与运行态**：本机平台 + 宿主侧运行态表（物理端点 / pid）。
- **入站面**：本地 socket（**不开 TCP**，落在 `state/sock/`）。外部客户端（CLI / UI / 测试）与**以客户端身份连接的插件**
  在此提交 directive 与命令。宿主常驻 + 唯一写者 ⇒ 外部**只能**连宿主，没有离线提交的路。协议见 `docs/protocol.md`。
- **服务协议面**：宿主 spawn 服务时接管其 **stdin/stdout**（stdio）；协议帧走 stdout、**日志走 stderr**——**无地址要传**（`docs/protocol.md` §一 / §二）。
- **输出**：**端点表**「能力（能力类 / 方法）→ 服务进程 + 物理端点」，供 `effect` 调用。

端点两分（写死）：

- **逻辑端点**（能力类名 / 方法名）= `pins` 的一部分，**住世界**。
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
│       ├── assembly/        装配：声明解析 / `pins` 闭包 / 拓扑 / 物化 / 起停 / 端点表 / 世代跟随
│       │                    —— **只读世界**；不写链、不执行效果、不认识插件种类
│       ├── effect/          效果：连接 / 调用 / 通用 run loop / 效果执行 / `EffectAudit` / 写口
│       ├── ledger/          账本：journal 文件 / `verify` / `replay` / 基础世界 / 单写者锁
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
├── node_modules/            已安装的包：宿主解析插件包（③ 投递；入世后源码进 ①）；包由 `state/plugins.json` 的 `{name,path?}` 给出
├── fixtures/
│   └── plugins/             toy 插件（**仅测试 / 开发**）：与 `plugins/` 同形的 npm 包，
│                            seed 进临时世界，不进正式世界
├── experiment/              独立实验树（standalone，不接内核）
└── state/                   宿主侧落盘（ignore；**永不进世界**）
    ├── world/               journal 尾段 + 基础世界 + 冷段 —— **真源**：世界本体（源码字节不在此，见 `blobs/`）
    │   ├── journal.jsonl    快照起的尾段（append-only）
    │   ├── base.json        基础世界（快照位置 + 世界本体 + 审计索引；③ 可重算：丢了 / 与尾段不对齐即由冷段 + 尾段全链重放重建）
    │   └── cold/            冷段归档 `seg-<first>-<last>.jsonl`（快照前的前缀；移出 ≠ 删除）
    ├── blobs/               源码字节本体 `<sha256>`（④ 不可重算；内容寻址、**只增**、离线可达性回收）—— 与 `assets/` 机械同构、保留策略不同
    ├── assets/              资产字节本体 `<sha256>`（④ 不可重算）—— **备份世界 ≠ 备份字节**，须一起备份
    ├── runtime/             运行态表 / 工作副本 / 锁 —— **③ 可重算**：删了重建
    ├── deps/                依赖 / 构建缓存（由 `decl.start` 安装；npm 缓存 `state/deps/npm`、Rust `state/deps/cargo-target`）—— **③ 可重算**：删了重建
    ├── plugins.json         插件包清单 `[{name, path?}]`：有 path 走路径、无 path 走 Node 解析（宿主侧配置，不进世界）
    └── sock/                入站面 socket —— 平台相关、不可重放
```

规则：

- **一个插件 = 一个包**（`package.json` **信封**；**npm 只是信封、语言自由**——Rust 等非 JS 包同形，见 `plugins.md` §三 与「宿主扩展面 · 非 TS 插件物化」）（**不分内部 / 外部**；放哪只是位置）。各包自带依赖目录 / 锁文件（`node_modules` / `target/` / 二进制），**仓库无根 workspace**。
  加插件**不改** `packages/` 下任何文件；同一 `plugin.json` 契约；要加载哪些包由 `state/plugins.json` 列出。
- `boot` 是**唯一入口的薄壳**（genesis 常量），命令分三类：
  - `boot start`：起宿主（**唯一写者**）。
  - **客户端命令**（连运行中的宿主）：`boot run` / `boot status` / `boot stop` / `boot <命令>`。
  - **离线命令**（宿主未运行）：`boot seed` / `pack` / `verify` / `replay` / `compact` / `assets gc`。
- 连入站面的代码只有一处：`packages/client`；CLI 与"两身份"的前端插件共用它。
- 装配包（`assembly`）**只读世界**，不 import `effect` / `ledger` 的写口。
- `packages/kernel` / `packages/host` **不被任何插件 import**、也不是任何插件包的依赖；插件只由 `packages/host` 装载（服务经 stdio 协议、客户端经入站面协议认识宿主，**不经源码 import**）。
- 插件之间**可以相互依赖**（写在 `pins`），但**不相互 import**、**不互相作 npm 依赖**：调用只写能力类名，宿主按 `pins` 路由。
- `state/` 只放宿主侧落盘，**永不进世界**，且 gitignore：
  `state/world/` 是**真源**，`state/blobs/` 是**源码字节本体**（④ 不可重算、只增、离线回收）、
  `state/assets/` 是**资产字节本体**（④ 不可重算）——**备份 = `state/world/` + `state/blobs/`（+ `state/assets/`）**：
  仅备份 `state/world/` 不再等于备份世界（源码字节在 `state/blobs/`）；`state/runtime/` 与 `state/deps/` 是**可重算产物**（③），
  `state/sock/` 是**入站面 socket**。

## 四、数据形态

```
PluginDecl    = plugin.json 解析结果（字段见 docs/plugins.md §二）
Capability    = { cap: string, method: string }        // 调用点只写这两个
Pin           = 名 → Hash
              // 名 = 逻辑端点名；Hash = 被依赖身份的世代 payload 键（入世时由宿主解析，作者写身份名）
Sig           = 世代签名 = 该世代 `commit` def 键（入世时由宿主写入 `Gen.sig`）
Endpoint      = { impl: string, gen: Hash, cap, method } → { transport, proc }   // 物理端点：服务 = 子进程 stdio
EndpointTable = Map<impl+gen+cap+method, Endpoint>     // 运行态，住宿主侧 ③
RuntimeState  = { pid, transport, gen }                // 运行态，永不进世界
```

## 五、设计口径（硬约束）

**路由**

- 调用点只写**能力类名 + 方法名**；`eff` 的 `port` / `method` 在 body 里是**名字**（逻辑名、经发出者 `pins` 解析），**不是哈希**。（规矩 A：body 里的哈希只能是业务数据值——term 的 `Call` callee 哈希属此类：它是**本身份内**的函数值，不入 `pins`。）
- 解析基准是**发出者身份**：一个 `eff` 归属于「当前 directive 入口 def 的属主」——宿主自己构造 directive，
  所以知道属主；`eff_id` 里的 directive 下标 `i` 给出是哪一条。
- **`pin` 绑定的是被依赖身份，不是版本锁**。解析路径 = 发出者 `pins`（名 → 哈希）→ def → **属主身份**
  → 该身份**当前代码世代**（`active` 是数据世代时取最近代码世代，见「装配」）→ 端点表。被依赖身份换代时，宿主把发出者的解析目标重解析到新代码世代，
  **发出者进程 / term / body 全不动**；pin 世代 ≠ 依赖代码世代只记一条**漂移证据**，不阻塞。
- **绝不回落旧世代**：依赖的新 active 装载失败 → 该调用 `not_loaded`，并按「装配」隔离该分支（不拿旧实现顶上）。
- **端点表的键不含调用方**（`impl+gen+cap+method`，`gen` = 依赖当前代码世代）——换实现只改 `pins` 指向，
  调用方与 term 都不用改。
- `pin` 名 = 逻辑端点名 = 调用点写的 `port`；解析时按名查表，并要求该名 ∈ 目标身份声明的能力类（故别名必须是目标声明的能力类，见下）。
- **降级链（同一逻辑能力多实现）**：`pins` 是 `名 → 单哈希`（内核冻结、不可多值），故降级用**多条别名 pin**表达，**不**把一个 pin 改多值。每个别名是一个**独立 pin 名**，指向**另一个身份**，且该别名必须是目标身份**声明的能力类**（解析时要求该别名 ∈ 目标身份声明的能力类，即强制此条）。降级顺序由 term 判定——先试主名，**eff 返回的 `value` 含错误描述**时再试别名（term 据值分支，非内核/宿主判定）；宿主对每个 pin 名机械解析，**不自动重试**（自动选优 = 宿主业务）。换某别名指向的身份 = 改 `pins`（写新世代、显式记账）；换同一身份的实现 = `set_active`（换代，不碰 `pins`）。
- 端点表键 = `impl+gen+cap+method`，`cap` = **服务声明的能力类**（即解析所用的 pin 名）；别名是 pin 的**名**（字符串键），不是 pin 的哈希**值**。
- **纪律**：term 的 `Call` 只在本身份内的 def 之间；跨插件一律走 `eff`（否则发出者归属不明）。
- 工具名就是能力类名（`tool.<name>`），**不另设一套命名**。
- **保留身份 `host`**：`pins` 值为 `host` 的项解析到**宿主自身**保留能力类（见「宿主扩展面」），不要求世界里有该身份、不入装配闭包为普通节点。
- **自能力路由（无需自 pin）**：`eff` 的目标能力类若**不在发出者 `pins` 里**，但发出者**自身装配世代**的 `implements`
  声明含它，则解析到**发出者自己的端点行**（`impl+gen+cap+method`，`gen` = 自身装配世代）——插件把入口 term 的 `eff`
  路由进**自己的 `execute` 服务**不必写自引用 pin。**优先级**：显式 `pins[cap]`（含保留值 `host`）优先，自能力仅在无该 pin 时兜底；
  自身未声明该能力类 → `unresolved_cap`，声明了但端点行缺失 → `not_loaded`（与普通路径同码）。自能力**不是 `pins` 项、不构成跨身份依赖**：
  不进装配闭包、不是 DAG 边、不参与受保护 `pins` 校验；保留能力类 `host` 不走此路（仍须显式 pin 值 `host`）。
- **自能力回路有界**：plan 可逐层递归产 directive，自能力 `eff` 又允许服务回计划再次 `eff` 自己——单次提交的轮数上限
  `MAX_SUBMISSION_ROUNDS`（宿主常量 10000，宿主可按提交收紧）；超限以 `refused` 收口（reason `too_many_rounds`），不挂死宿主。
  单轮内的挂起次数另受 `run-loop` 的 `too_many_suspensions` 约束。
- 解析不到即**拒绝**（不猜、不兜底）。

**装配**

- 闭包沿 `pins` **只读**遍历（规矩 A）；`pins` 指向**被依赖身份**，闭包落到各身份的**当前代码世代**；
  拓扑序 = 服务启动顺序（被依赖者先起）。
- **世代二分（同身份混合世代）**：`gens` 里每个世代要么是**代码世代**（payload 指向 `commit` def，即
  `world.defs[payload].body.tree` 是字符串），要么是**数据世代**（payload 指向数据 def）。**装配解析声明 / `pins`
  一律按「当前代码世代」**：`active` 本身是代码世代则取 `active`（尊重 `set_active` 回滚），`active` 是数据世代
  则取**最近代码世代**；找不到可解析的代码世代 ⇒ 该身份不参与装配（fail-closed，不回落更旧世代）。
  数据世代只影响投影读侧（`.body`），不影响装载与路由。
- **坏分支只隔离，不整体拒绝**：`pins` 成环（Tarjan SCC）时，环成员**及其依赖者**（反向可达）
  标 `not_loaded` + 记 `dep.cycle`，其余照常启动。
- `stale()` 判定口径在 `kernel.md` §九（def ↔ 本身份 active 世代的一致性）；宿主 **fail-closed**：
  依赖身份 retired / 缺失、或新 active 装载失败 → 隔离该分支，**绝不回落旧世代**。
- 运行期**只跟随本插件自身 active 换代**（数据热生效 / 代码起新服务 + 旧服务 drain）；
  **依赖换代不重装本插件**，只由宿主重解析路由（见「路由」）。
- 握手**只查形态**（协议 / 身份 / 能力覆盖 / 状态档），不做语义校验；多出来的能力**不登记**（不扩权）；
  不过 → 杀进程 + `handshake_failed`，该插件**及其依赖者**标 `not_loaded`。
- 崩溃恢复按 `restart` 声明的策略执行（`on-exit` 退避重启；`never` 不重启、退出即隔离该分支）；超过上限 → 记 `service.restart_exhausted`（运维日志）+ `not_loaded` + 隔离依赖者；服务退出即摘除该世代端点行，重启成功后重挂（端点表只含可用服务）；
  健康判定走协议级 `probe` / `pong`，见 `docs/protocol.md` §2.3。

**源码**

- 一个插件世代 = 一个 `commit` def（`blob` / `tree` / `commit`），tree = **包内源码树减去通用排除（`node_modules` / `.git`）与插件 `.worldignore` 声明项**；宿主**不内置**语言 / 构建名字；契约必需文件（`plugin.json` / `package.json` / 锁 / `README.md` / `schema` / `commands` / `members` 路径本身）不可被排除（否则 `bad_worldignore`）。
- 包内 `terms/` 入世成 term def（`body` = AST、`sig` = 本世代 `commit` 键）；term 对同包 callee 的引用在入世时解析成 def 哈希；**引用成环 → 该包整批入世被拒**（`term_cycle`），其他包照常——term 内部引用不构成身份级依赖，装配闭包看不到它。
- **入世**：按 `state/plugins.json` 清单解析插件包 → 读其源码树 → `blob` / `tree` / `commit` defs → `put`，与物化互逆；源码住 ①（`kernel.md` §八）。宿主**只解释 `plugin.json`**，其余是源码 blob。
- 身份的 `schema`（`Identity.schema`）= `plugin.json.schema` 指向的包内文件——它是该身份的**自述 / 数据契约**（描述本身份声明的数据形态；数据、非特权，`kernel.md` §四 / §十一），入世解析成 def 哈希写进 `Identity.schema`。宿主对 `plugin.json` 形状的元校验是**宿主侧另一份 schema**，不占此字段。**`schema` 可省略 / 空串**（无世界数据的 UI 插件可零 schema，直接省略字段，不得以 `null` 占位）：省略时宿主机械 `put` 一份最小默认 def `{"type":"object"}` 并以其哈希作 `Identity.schema`（内核要求身份必有 schema），不解释业务；声明了非空路径但包内文件缺失才拒 `missing_schema`。`Identity.schema` 在身份诞生（`add_identity` / `fork`）时固定；换代（`add_gen`）不带 schema——**要改数据契约须 `fork` 新身份**（内核无 set_schema op）。
- 工作副本落 `state/runtime/`（③ 可重算），**永不进世界**；复用前校验宿主标记，标记缺失 / 不符即整目录重物化；服务写进物化目录的文件不是源码树的一部分、不保证跨代保留（**不得当持久层**）。依赖安装 / 构建 / 起服务全归插件的 `decl.start`，宿主**不认识语言、不执行 npm、不做编译**。
- **起服务**：宿主 spawn `decl.start` 并接管其 **stdin/stdout**（服务协议走 stdio，见 `docs/protocol.md` §一 / §二）；服务日志走 stderr，stdout 只许协议帧。

**入世路径（seed / pack）**

- 两条入世路径**共用同一套打包规则**（通用排除 `node_modules` / `.git` + 包内 `.worldignore`，契约必需文件不可排除），故同一目录、同一身份产出**相同的源码 tree 与 commit 哈希**：
  - `seed`：按 `state/plugins.json` 清单**批量**入世（缺省读清单；也可给若干包路径）。
  - `pack`：**单个目录**手动 / 程序化入世（`boot pack <目录> --identity <身份名>`）。
- 两者都把「一个包 = 一条原子 `batch`」直写 `commit`：身份不存在则 `add_identity` + `add_gen`；身份已存在则只 `add_gen`（追加代码世代，不覆盖既有数据世代；同内容重复入世为 `unchanged`）。坏包（坏声明 / 缺 `plugin.json` / 声明 `schema` 但包内文件缺失 / `.worldignore` 非法 / 引脚未解析 / **删除受保护 `pins`**）**整批拒绝、世界分文未动**，报结构化原因（后者 `protected_pin_removed`）。
  - `pack` 的 `--identity` 必须与包内 `plugin.json.identity` **一致**，不一致即拒（`identity_mismatch`）——命名即契约，身份名只有一个来源。
  - **身份名必须是安全单段名**：拒绝含 `/`、`\`、盘符前缀、`.` / `..`、控制字符、空段、Windows 非法字符（`<>:"|?*`）、尾随点 / 空格、Windows 保留设备名（`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`）、JS 原型键（`__proto__` / `constructor` / `prototype`，否则 `world.ids` 继承成员会误判为已存在并触发 `TypeError`），以及保留名 `host`（`host` 恒解析为宿主能力，真实身份会遮蔽它）→ `bad_plugin_decl`。理由：身份名会被用作 ③ 目录名（`state/plugins/<id>/`），不安全名字既会路径穿越、又会被 GC 误删。运行期写指令可造 id，故**起服务边界同样 fail-closed 校验**。
- **退出码**：`seed` / `pack` 有任一条目 `failed`（即报告 `ok:false`）时 CLI **退出码非 0**（结构化报告照常打印）；仅用法错误与其它异常退出 1。

**服务启动包装器**

- 宿主**不选沙箱后端**，只允许配置一个**包装器命令**把插件 `start` 包住（宿主仍不认识语言）：配置后实际 spawn 命令 = 包装器 + 原 `start`；未配置 = 现状（零行为变化）。
- 配置优先级与调用超时同规：**CLI（`--start-wrapper`）> 环境（`CHRONO_START_WRAPPER`）> 无**。
- 包装器**只影响 spawn 命令行**：不参与声明解析、不改 `plugin.json` 契约、不引入「特权插件」；非法值（空 / 纯空白 / 含 NUL 或换行）**fail-closed 拒启动**，并记一条 `host` `start_failed`（reason `bad_start_wrapper`）运维日志。

**效果**

- 效果一律经宿主；**审计先于业务写**（audit def → `request.ref`），**失败也落审计**（`execute` 必须
  try/catch，失败也 `put` 审计 def，记失败形态）。审计 def body =
  `{kind:'effect_audit', request, result, port, method, outcome, run, emitter}`；
  `outcome` 机械导出：`ok`（有响应成功）/ `error`（有响应为错误）/ `transport_failed`（没执行）/
  `cancelled`（被真取消中止）；`run` = 宿主对外回合 id（`accepted{run}`）、`emitter` = 发出者身份。
- **调用帧 `env` 注入（机械）**：宿主在**每次服务调用**（正向 `call` 与反向 `port.call` 转发）的协议帧上填 `env: { run, thread, now }`
  ——`run` = 本次回合 id（宿主分配）、`thread` = 发起者提交信封里的可选字段（原样回带、不校验；detached / 周期 run 恒 `null`）、
  `now` = 宿主固定时钟（与 `KernelInput.now` 同源）。**只填帧、不改 `args` / `bag` 语义**（`canonicalJson(args)` 缓存键与审计 args 不受影响）；
  服务发事件（载荷带 `run`/`thread`）、判 TTL（`now`）一律用它，**不得自取时间**。机械路由，宿主不认识业务。
  反向 `port.call` 的帧本身不带 `env`，宿主按**该服务连接上最近一条在途正向调用**的回合信息回带（目标与发起服务拿到同一 `run` / `thread` / `now`）；
  无在途调用时补宿主固定时钟、`run` / `thread` 记 `null`（v1 服务实现内部调用都在正向调用内发起，故正常路径恒有值）。
- `eff` 的 `port` 是**逻辑名**，运行时按发出者 `pins` 解析（见「路由」）；**不改内核的 `EffRequest`**。
- **调用超时**：常量缺省 30s（`DEFAULT_CALL_TIMEOUT_MS`）；进程级默认读 `CHRONO_CALL_TIMEOUT_MS`，
  `boot start --call-timeout-ms <ms>`（或宿主入口 `--call-timeout-ms`）显式覆盖——优先级 **CLI > env > 常量**；
  非法值启动即拒（`bad_call_timeout`），`boot start` 打印生效值。超时与连接 / 帧 / 进程死亡同归「没执行」。
- **方法级超时覆盖（`method_timeouts`）**：插件 `schema` 顶层可选 `method_timeouts: {"<能力类>.<方法>": ms}`
  （键也可省能力类前缀、按方法名全局匹配该插件声明），宿主按声明为**本插件被调方法**覆盖等待上限——
  优先级 **方法级 > 进程级 > 常量**；缺省不设。声明非法（非对象 / 键为空或 JS 原型键 / 值非正整数 / 值超计时器硬上限 `2**31-1`，超限会被 `setTimeout` 溢出成 1ms）→
  装载期记运维日志 `dep.method_timeout_invalid`、按无覆盖处理（不炸宿主）。用途：长回合方法、
  流式模型调用声明大上限，避免被 30s 缺省截断。**正向效果调用与反向调用（`port.call`）都按目标身份的方法级声明覆盖**，
  周期方法条目直接调用同规；解析落点 `packages/host/method-timeouts.ts`（`resolveMethodTimeoutMs` 按世界对象缓存声明，不重复读 schema）。
- **失败作数据回灌**：endpoint **有响应**（`result` 或 `error`）→ `EffResult{ok:true, value}` 回灌（`error` 时 `value` 是错误描述），
  term 可据此分支（降级链）；只有**没执行**（连接 / 帧 / 进程死亡 / 未解析 / 超时）→ `EffResult{ok:false}`（无值）→ 内核 `eff_error` → 该轮 `refused`（`transport_failed`）。
- **真取消（`cancel{run}`）**：中止在途 / 排队的 run——丢弃尚未执行的部分（含 plan 产出的 directives）、
  尽力停止等待在途服务调用（服务协议无取消消息：宿主摘除等待、晚到响应忽略、不杀服务进程）、
  在途效果审计记 `outcome: 'cancelled'`（result 记 `{ok:false,error:'cancelled'}`），该 run 以 `cancelled` 收口；
   **已落账内容不回溯**。与 `stop`（停宿主）互不相干：`cancel` 只影响该 run，宿主继续运行；
   停机时宿主亦取消全部在途 / 排队 run（不把停机耗在调用超时上）。**命令 run 与 `submit` run 同规登记在册**，故同样可被 `cancel{run}` 与停机 `abort` 覆盖（命令 `result` 不带 `run`，仅审计 / 运维可见其回合 id）。
- **只读审计面**：宿主按回合（`run`）/ 身份（`emitter`）/ 结局（`outcome`）查询 `EffectAudit`
  （入站 `audit`；seq 降序、缺省 100 条、上限 1000）；索引在启动时由**基础世界索引 + journal 尾段**重建、
  运行期随审计落链增量补齐；
  **只读**：不写链、不推进、不参与哈希（查询语义见 `protocol.md` §三）。
- 审计 def 进 ① `defs`——它要被 `ref` 指到，必须可寻址。
- **审计 `put` 是宿主对 `commit` 的直接调用**（`kernel.md` 导出 `commit`）——宿主侧唯一不经 `run` directive 的直写，
  为的是让 `ref` 指向的审计 def 在业务写之前就已可寻址。`kernel.md` §二「唯一调用 commit 的地方 = `run`」指内核**模块内部**依赖，不含宿主外部调用。
- **`extern` 是确定性透传锚点（非效果）**：`{kind:'extern', payload}` directive 经 `run` 只原样产观测 `{kind:'extern', payload}`
  （`kernel.md` §十二）——**不写世界、不推进 head、不耗 gas、不发 `eff`、不需审计**（无 `EffRequest`，故「效果一律经宿主」不适用）；
  宿主把它原样回给发起者，不解释、不落账、不推进。用途：命令「无写返回值」（run 末尾 `extern(结果)`）、外部事件锚位。
- `write` 的 `ref` = **触发它的那条 `eff` 的 audit 哈希**；分相后 write 轮内无 `eff`，故取**紧邻 eval 段内最后一条 `eff`** 的 audit 哈希；无前置 `eff`（如直接提交 write）时 `ref = null`。
- `run` 照抄 `kernel.md` §十二；**只有 `done` 才落账**；续跑同 `run_id` / `now` / `directives`，
  `results` **只增不改**；审计 `put` 会推进链头，续跑下一轮必须回灌**审计后的 `world` / `head`**。

**落账**

- **判定与落账分离**：写内容是**判定**的产物。一轮 `done` 的 `observations` 里带着 term 的求值结果
  （`{kind:'eval', entry, ok, value}`），宿主据此**原样**构造 `write` directive，由 `commit` 落账——
  内容不改，只做机械校验。
- **计划通道（term 产 directive）**：宿主只认**顶层 eval 观测** value 里的保留包装 `{"$directives":[...]}`——
  条目**原样取用**（不改 `kind` / `op` / `args`），宿主只机械填 `id` / `by` / `ref` / `expect_pos`，
  结构 op 的 `pins` 按名解析（与入世同路）；其余 value 一律作普通数据回发起者。
  plan 条目**插在本次提交剩余轮之前**（判定立即生效），可逐层递归；plan 里 eval 发 `eff` 时
  **继承产出它的 eval 的属主**（不按 entry 反查属主）。
  **eval 可按命令名解析**：plan 条目 eval 可写 `{kind:'eval', command:'<命令名>', args}` 代替 `entry` 哈希——
  宿主按命令声明解析入口 def（与命令面同路、机械），属主即命令声明方；term 拿不到他人 def 哈希时用它
  （如裁决 / 作答入口 term 产「按游标续跑」计划）。`entry` 形式保留；`entry` 与 `command`
  不可同条并存、也不可都缺（否则 `bad_directive`）；命令名解析不到 → `refused`（reason `unknown_command`，与命令面同码）。
- **分相（保序）**：一轮内不混 eval 与 write——连续 eval 合一轮（eval 不推进 head；审计 `put` 推进 head 但不回改该轮 `ctx`），
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
- 命令**不是旁路**：判定仍是 term、写仍经「落账」；宿主不认识命令语义，只按声明路由。
- 宿主命令名（`start` / `stop` / `run` / `status` / `seed` / `pack` / `verify` / `replay` / `compact` / `audit` / `assets`）是**保留字**，插件命令不得占用；CLI 另有 `commands` / `help` 两个自有命令（不转发宿主）。
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
      pins: { <逻辑端点名>: <被依赖身份名> } | null,
      refs: { <hash>: Json }, next_before: Hash|null } } }
  ```
  `gens` **不含履历**（`adopted` / `born`；与 `world_rev` 摘要口径一致）；`body` = **最近数据世代的 payload def
  body**（宿主解析；无数据世代则回落 active 世代 def body；都无则 `null`）；
  `pins` = **当前代码世代声明里的 `pins` 表**（逻辑端点名 → **被依赖身份名**字面值，宿主入世时已知；无代码世代则 `null`）——
  机械、来自声明，供调用方入口 term 装配 bag（如校验「端口 ⊆ pins」）；
  **不给 `defs` 表**（哈希键静态不可达）、**不含源码 tree/blob**。按引用构造，O(#身份)，不深拷贝。
- **投影引用闭包**：`body` 里的显式标记 `{"def":hash}`（单键、值须 64 位小写 hex）由宿主构造投影时跟随**传递闭包**，把可达 def body 放进 `ids.<id>.refs`（`{ <hash>: <body> }`）。**全量返回、不按窗口截断**：`next_before` 恒为 `null`，翻页窗口由调用方入口 term 在 `refs` 上按 `before` / `limit` 切片——展示完整性不受宿主上限约束。无标记的身份 `refs` 为空对象。`refCap`（`DEFAULT_REF_CAP`）只是防异常数据撑爆投影的**硬安全上限**，正常数据量远低于此。
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
- **锁粒度**：锁从「run 全程持有」**收窄为「commit 期间持有」**——run 可并发推进 eval / 等待效果，只在落账那一刻串行。**run 级并发**：多个 run 同时活动，并发只在 run 之间，每个 run 内部单 pending 不变。
- **提交队列 + 乐观校验**：各 run 的 `commit` 进**单一提交队列**，宿主按**到达序串行**出账（仲裁序 = journal `seq`，不新增字段）；提交时校验 base `worldRev`（`expect_pos` 单链头 CAS），冲突 ⇒ 按续跑纪律重提交（同 `run_id`/`now`、`results` 只增不改、重试占新 `seq`）。按 per-thread 键控的身份 body（`body.slots[<thread_id>]`；**v1 已知限制**：整值 `put` 下不同键并非真正可交换——同线程键写者唯一、服务侧清槽的整份 body 取自入口 term 的轮首 ctx（权威）；跨线程 / 跨客户端并发仍 last-write-wins）；用户级共享身份以读为主，写罕见且 last-write-wins。入站 `submit` **accept 仍 FIFO、不抢占**（§七）；被 accept 的多个 run 可并行推进 eval，只在 commit 排队。
  - **v1 落地口径**：落账段（内核 `run` + journal append）在单一串行链内**无 await**，write directive 的 `expect_pos` 在段内机械锚到当前链头——即「在新链头上重放同一条 directive」，故结构上不产生 `pos_conflict`，乐观重试路径暂不触发。语义等价于 append-only 写（`put` / `add_gen` 等内容寻址 op）可安全 rebase；**读-改-写共享身份 body 的并发写仍是 last-write-wins**（键控身份靠 per-thread 键控化解；共享 body 的真冲突检测 / 重提交后置）。审计 `put` 与业务写同段串行，追加序 = `seq` 链序；在途 run 的效果路由锚定**本 run 段内所见的世界**（不跟随其他 run 的后续落账）。
- **停机序列**（`boot stop`）：按**反拓扑序**逐个 `drain` 服务（依赖者先停）→ 落盘 `fsync`（journal 本已 append-only）→ 释放锁 → 退出。停机**不写链、不改 active**。
- **压缩**：宿主在**启动时**尾段达到阈值（`DEFAULT_COMPACT_TAIL_ENTRIES`）或离线 `boot compact` 时执行——
  ① 在链头追加快照 entry（`op:'snapshot'`，`args = { world_rev }`，应用时自校，锚不歪）；② 快照前的 entry 归档进
  `world/cold/`；③ 尾段 journal 重写为「快照 entry 起」；④ 写 `world/base.json`（世界本体 + 快照位置 + 审计索引）。
  这是宿主**第三处直写**（与审计、seed 同类），不走 run / directive；**世界不变**，链头推进到快照位置。
  启动取用 = 读 `base.json` + 尾段重放（不再全量重放）；`verify` / `replay` 仍读冷段 + 尾段全链校验。
  压缩幂等（离线 `compact` 只归档**当前 journal**，不重归档旧冷段）；`base.json` 缺失或与尾段不对齐
  （崩溃窗口）时**回落全链**（冷段 + 尾段按 seq 去重）重放——基础世界是派生缓存，丢了不砖化；仅其**形态损坏**才 fail-closed（`bad_base`）。

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

**宿主扩展面（2026-09-19 登记，进权威）**

> 以下为宿主动词，不改内核。投影闭包见「投影」；并发见「写者」。

- **投影引用闭包**：见「投影」。`{"def":hash}` 跟随传递闭包进 `ids.<id>.refs`；**全量返回**（`next_before` 恒 `null`，翻页由调用方在 `refs` 上切片），`refCap` 仅硬安全上限。
- **受保护 `pins` 不可删（入世校验）**：跨代比对 `pins`（按被依赖身份名，值即 `decl.pins` 的依赖名），若新世代删除了对**受保护身份**的引用则**整批拒** `protected_pin_removed`；受保护身份表住**宿主侧**（不进世界，故连代码换代也改不动）。比对基准 = 该身份的**最近代码世代**声明（**不依赖 `active`**：`set_active(null)` / retired 后重入世也要比对；有代码世代却读不出声明 → fail-closed 拒；身份不存在 / 无任何代码世代 → 放行）。理由：依赖关系是攻击面——新世代可借删 `pins` 让上层强制失效。机械校验（只比较"旧世代有、新世代没了"），宿主不认识业务。**覆盖范围**：`seed` / `pack` 入世与 `validate_package` dry-run 同路；**裸运行期 `add_gen` 不经过入世门禁**（v1 无 op 级鉴权，见 §七 末），这条守卫不覆盖它。
- **密钥本地存储面**：入站 `secrets.put {name, value}` / `secrets.delete {name}`——宿主直写用户本地文件（`state/secrets.local.json`，`0600`），**不经 run、不进世界、不进审计**；与 `asset.*` 并列。
- **效果审计脱敏 + 体积截断**：`EffectAudit.result` 对发出者 + `port=secrets` + `method=resolve` 按白名单替换为 `{name, kind, has}`（不含本体）；对 `host` 批量方法（`asset.get` / `source.read` / `audit`）结果超过 `MAX_AUDIT_RESULT_BYTES`（64 KiB）时只落 `{truncated:true, size}`——否则 8 MiB 资产 / 拷入既往审计记录的 `audit` 会把 defs / journal / 审计索引撑爆（调用方仍拿完整结果）。
- **反向调用 `env` 值脱敏（端口审计）**：反向 `port.call` 转发时，宿主侧端口审计对 args 顶层 `env` 字段的**值**一律替换为 `{redacted:true, keys:[…键名]}`（键名排序、确定性；目标服务照收原值）——密钥经执行请求的 `env` 通道下传时不落宿主侧记录。与 `secrets.resolve` 的世界审计脱敏同路、两处口径。**端口审计与 `EffectAudit` 分流**：不进世界、不写链、不参与重放。**落点**：`packages/host/port-audit.ts`——宿主侧有界内存环形缓冲 `PortAuditRing`（容量常量 `PORT_AUDIT_CAPACITY` = 256，满即覆盖最旧），宿主 options `portAuditSink` 可注入 sink 覆盖（库调用方 / 测试；注入时记录**同时**写入缺省环形缓冲，sink 抛错只隔离该旁路、不阻断转发）；`HostHandle.portAuditRecords()` 暴露该环形缓冲的**只读快照**（时间正序、有界，缺省读取面，无需注入 sink）；记录形状 `PortAuditRecord = { at, from, target, port, method, args, run, thread }`（`from` = 发起服务身份、`target` = 路由解析出的目标身份、`args` 已脱敏）。
- **插件源码读面**：`host.source.read { identity, path } -> { path, content(base64), size }`——把某身份的源码 `tree` / `blob` 按路径读给插件（世界 ① 有源码，投影不含 `tree` / `blob`）。可见性过滤由调用方负责，宿主不做。
- **插件 ③ 目录**（`state/plugins/<id>/`）：插件缓存 / 向量索引 / 水位等可重算产物落此，宿主统一 GC。**落地口径**：起服务前宿主为本身份 `mkdir` 该目录，并以环境变量 **`CHRONO_PLUGIN_STATE`** 注入 spawn env（**只注入本身份路径**；宿主不认识目录内容）。**这是路径约定、不是 fs 隔离**——v1 无沙箱，插件进程仍可直接读其它路径。**GC**：宿主启动时（抢锁后、装配前）机械删除目录名 **∉ `world.ids`** 的顶层项（`retire` 只置 `active=null`、id 仍在 `world.ids` ⇒ **目录保留**）；失败不致命、不阻锁释放。身份名必须是**安全单段名**（拒绝含 `/`、`\`、盘符、`.`/`..`、控制字符、Windows 非法字符 / 保留设备名（`CON` 等）、尾随点/空格、JS 原型键（`__proto__` / `constructor` / `prototype`）与保留名 `host`），否则既会路径穿越、又会被 GC 误删；**入世与起服务边界都校验**（运行期写指令也能造 id）。
- **非 TS 插件与原生子组件物化**：插件包入世只含**源码 + 依赖清单**（`package.json` / `Cargo.toml`）；编译产物 / 依赖目录 / 原生扩展（`node_modules` / `target/` / 二进制 / `*.node`）**走宿主侧 ③ 依赖缓存**，宿主物化时按清单恢复；宿主仍只按 `plugin.json.start` 起服务。**落地口径**：物化后、spawn 前按清单派发恢复——`package.json` 有依赖 / 锁文件 → `npm ci`（仅当 `package-lock.json` / `npm-shrinkwrap.json`）或 `npm install`（yarn / pnpm / bun 锁回落 install）；`Cargo.toml` → `cargo build --release`；`binding.gyp` → `npm rebuild`。缓存住 `state/deps/`（npm 下载缓存 `state/deps/npm`、Rust `CARGO_TARGET_DIR=state/deps/cargo-target`）；`node_modules` / `target` 落**物化目录**（③，内容寻址复用）。恢复完成后在物化目录写 `.chrono-deps-ok` 标记，标记在则跳过（**以标记而非 `node_modules` 存在性判完成**，半恢复可自愈）；恢复失败 → 服务启动失败 `service.start_failed` reason `deps_failed`。**恢复命令借 shell 解析**（win32 上 `npm` 是 `.cmd` 包装脚本，`shell:false` 会 `EINVAL`）并**前置同一 `startWrapper`**——依赖安装会跑插件声明的 lifecycle 脚本，不能成为绕过沙箱的口子。
- **投递目录大资产直拷（`assets_manifest`）**：插件 `schema` 顶层可选 `assets_manifest: [{ path, sha256, size }]`
  ——声明「被 `.worldignore` 排除、但构建 / 运行需要」的大资产（模型权重、tokenizer 等）。宿主物化时按清单
  **从投递包源目录**（`state/plugins.json` 解析到的包路径）把文件复制到物化目录对应路径，按 `sha256` 校验；
  源文件缺失 / 校验失败 → `service.start_failed` reason `deps_failed`（与依赖恢复同口径）。宿主不触网、不认识资产内容；
  ③ 可重算性 = 「源目录 + 世界源码」可重算（源目录本身丢失则不可重算，须重新投递——插件自述须如实登记）。
  构建期输入（如模型权重 / tokenizer）走此路（`include_bytes!` 等构建期输入由直拷满足）。
- **按队列项游标触发新 run**：`enqueue` 类方法**正常返回**（那轮不是 `waiting`）；正确形状是本 run 正常结束、`item` 带 resume 游标（`iter`/`cursor`/slots 引用），裁决 / 作答落账后**续跑（v1 = 裁决 / 作答命令的入口 term 产「按命令名续跑」计划，经 plan 通道按命令名解析起后续轮——见 §五 落账「plan eval 按命令名」）**。与内核 `waiting` 续跑（同 `run_id`/`directives`/`now`）**不是同一机制**。
- **定时触发**：宿主按插件 `schema` 的**顶层 `periodic` 数组**声明周期起一次 run。每条声明 `{ command | method, every_ms, reads? }`：
  - `command` 条目按该身份声明的入口 term 构造一次 `eval` run（与命令同路）；`method` 条目**直接调该服务方法**（能力类由声明里含该方法者定），方法返回的**计划值 `{"$directives":[...]}` 由宿主按该身份落账**（无计划值 = 本拍无写，按 `done` 收口）。
  - `reads` 是 `{ <bag 键>: <投影字面路径> }`；宿主按路径**机械取用**投影片段放进 `bag`（无 `reads` → `null`），**服务不读投影**。
  - 周期 run 记宿主 `run.started` / `run.finished`（`thread` 恒 `null`）；单条目上一拍未结束则跳过本拍；声明非法只记 `dep.periodic_invalid` 运维日志、不阻断其余；声明变更随 `applyWorld` 增量对齐（计时器不因每轮落账重置）。
  - 周期声明住各插件 schema（如后台同步 / sweep / aggregate 类方法）。
- **插件入站转发**：前端壳可经主端口同源反代（`/p/<id>/*`）把入站帧转发到目标插件服务（保「唯一主端口」，壳不自连插件服务）。入站帧 = `forward { identity, command, args? }`：宿主按 `command` 解析入口 term、**要求其属主 = `identity`**（否则 `unknown_command`），构造一次 run（`initiator = "forward"`）；即「入站帧按声明的入口 term 构造一次 run」（入站翻译产命令 + 写槽计划，服务无写通道）。命令名由壳侧 `/p/<id>/*` 映射提供；宿主不认识业务，只做机械路由与身份约束。
- **入世校验 dry-run 面**：`host.validate_package { files } -> { ok, errors: [{code, path, message}], result_hash }`——`files` 是 `{ <包内路径>: <text 字符串 | {text} | {base64}> }`（路径必须安全单段、禁逃逸；base64 只收规范编码）。宿主把候选树落临时目录（③，用后即删）后**复用 `seed` / `pack` 同一套 `planPack`** dry-run（`plugin.json` 字段形状（`schema` 可省略）/ 包内路径约束 / `argsSchema` 方言 / 受保护 `pins` 完整性 / term 环 / `.worldignore`），**不写世界**；`result_hash = H(规范化候选树)`（= 该候选树的 `commit` 哈希；`planPack` 未通过时为 `null`）。调用方写身份前必须携带该 `result_hash`（缺 → `validate_required`）。
- **服务侧资产存取面**：`host.asset.put { mime, bytes(base64) } -> { kind:'asset', sha256, mime, size }` / `host.asset.get { sha256 } -> { bytes(base64), mime, size }`（缺失 → `asset_missing`）——字节按内容寻址住 `state/assets/<sha256>`（④ 不可重算、**不进世界、不参与重放**）；服务经**反向调用**读写字节，返回的引用由调用方写进世界数据。规范 base64、原始字节上限 **8 MiB**（与入站 `asset.put` 同口径），更大走分块（后置）。供插件读写二进制字节（能力未实现时调用方可回 `binary_unsupported`）。
- **宿主保留能力类 `host`**：宿主暴露保留身份名 `host`（**不进世界**），`pins` 值为 `host` 的项在入世解析时绑定到**宿主自身**（受保护 `pins` 校验同样认它）。方法：
  - `thread.resume { entry, args?, thread? } -> { run }` / `thread.terminate { run } -> { ok }`（run 生命周期）。`terminate` 等价 `cancel{run}`（未知 → `unknown_run`）；`resume` 是**宿主通用原语**——起一次 detached run（无 socket、结果不回流、事件照广播），`initiator` = 调用方 emitter，宿主**不认识游标语义**（游标由调用方放进 `args`）；detached run `caps:{}`、`thread` 缺省 `null`，并发上限 `MAX_DETACHED_RUNS`（超限 `too_many_runs`）。
  - `audit { filter?, limit? } -> { records, truncated }`（只读审计面，供服务读 `EffectAudit`；`filter` 与入站 `audit` 同形，seq 降序、缺省 100、上限 1000）；
  - `identities {} -> { list: [{ id, active, implements, commands }] }`（只读**身份清单面**：宿主从世界 + 各身份当前代码世代声明机械读出。不含 `pins` 明细——pins 在投影 `ids.<id>.pins`）；
  - `source.read { identity, path } -> { path, content(base64), size }`（只读源码读面；投影不含 `tree`/`blob`，见「插件源码读面」）；
  - `validate_package { files } -> { ok, errors, result_hash }`（见上「入世校验 dry-run 面」）；
  - `asset.put` / `asset.get`（见上「服务侧资产存取面」）。
  保留能力类供上层插件共用；宿主不解释业务，只做机械路由与内容寻址。**v1 受信面**：无方法级鉴权——任何 pin `host` 的插件都可 `audit` / `source.read` / `asset.get` / `thread.terminate`（过滤责任在调用方，宿主不强制）。
  - **host pin 的运行期限制**：`host` 字面量只在**入世（`seed` / `pack`，走 `batch` 子操作）**成立；**裸运行期顶层 `add_gen` / `put` / `graft` 不接受 host pin**（内核 pin 形态要求 64-hex），宿主对顶层 host pin 提前 `bad_directive`（`batch` 子操作内仍保留字面量）。数据世代通常 `pins:{}`，故 v1 不受影响。
- **线程控制面**：`thread.resume` / `thread.terminate` → **宿主保留能力类 `host`**（run 生命周期）；线程数据面（发送 / 状态）由上层服务提供，宿主不直造其 body（保「载体不认识业务」）。
- **run 级并发 + 提交队列 + 乐观校验**：见「写者」；锁收窄为 commit 期间，多 run 同时活动，提交队列串行落账（仲裁序 = `seq`）。v1 在串行段内重锚 `expect_pos`，等价于 append-only 写的安全 rebase（详见「写者 · v1 落地口径」）；`worldRev`/`expect_pos` CAS 冲突重试路径保留为契约、暂不触发。
- **宿主事件面（2026-09-19 登记）**：宿主自身在 **run 生命周期**广播事件——`run.started`（受理并开始推进）/ `run.finished`（收口，`status ∈ done/refused/idle/cancelled`；**异常路径也必发**，status 记 `refused`）；`run.started` 与 `run.finished` **严格成对、恰好一次**。载荷**必带 `run` / `thread` / `status` / `reasons`**（`reasons` 取自该 run 收口 `observations` 末条 `kind:'refused'` 的 `reasons`，无则 `[]`；`status=refused` 时说明收口原因），与插件 `event` 同路经入站面广播给已连接客户端（`impl = "host"`），**不落账、不推进、不进世界、不进运维日志**。`thread` 来自发起者提交时的可选字段（原样回带、**不校验**，是展示标签非安全边界）；detached run 恒 `thread:null`。用途：UI 运行角标、发送 / 终止形态、回合完成通知。宿主**不解释业务**，只广播自身 run 的起止。
- **源码 CAS（源码字节内容寻址）**：源码字节从 `defs` 外迁到内容寻址存储 `state/blobs/<sha256>`（④ 不可重算；**只增**、离线可达性回收）；① 里留下源码的**声明与内容身份**——`commit` def、`tree` def、每文件的 blob **指针 def** `{kind:'blob', sha256, size}`、term def、schema def、`sig` / `pins`。指针 def 的 `kind` 是唯一判别位（旧读取器遇对象体安全失败 `bad_blob`，不会把哈希串当内容写出）；`sha256` 兼作 CAS 文件名与读取校验，`size` 防截断；def 键 = `H(pointer def)`，与 `sha256` 不同，tree 仍引用 def 键，故 **tree / commit 的哈希结构与结构共享不变**。二进制文件同样走指针形态，CAS 存原始字节（不再 base64）。读取侧（`materialize` / 声明解析 / `source.read`）**同时支持 inline 与 pointer**，旧世界可不迁移直接跑。
- **源码物化（指针经 CAS 解析 + 硬链接共享）**：物化对每个 pointer file entry 读 `state/blobs/<sha256>` 并校验 `size`，以**硬链接**接入物化树（同一 blob 在多个世代里指向同一 inode）；`EXDEV` / `EPERM` / `EMLINK` / 目标文件系统不支持时**回退普通复制**。共享前提是 CAS 不可变：物化时把源码文件置**只读**（POSIX `0444`、Windows 清写位），服务对物化目录的写只允许新增文件、不得覆盖源码文件。CAS 缺失 → `blob_missing`（与 `asset_missing` 同口径，属已知限制）。
- **回收分档（`materialized` 与 `blobs`）**：`state/runtime/materialized` 是 **③ 可重算**，按「active 代码世代 + 前 N 代」回收（只删 64-hex 命名的目录、跳过 staging；触发点在启动抢锁后或离线命令，**绝不在 run 中删**）。`state/blobs/` 是 **④ 不可重算**，只做**可达性**回收——沿每个身份每个世代的 `commit.body.tree` 递归遍历 `world.defs`，删不被引用的 64-hex 文件；**离线、持锁，不在启动时自动删**（与 `assets gc` 同规）。**回滚承诺不由 `materialized` 承担**：`set_active` 指回任意世代恒可由「① 的指针 def + CAS 字节」重建，保留前 N 代只是缓存命中优化，故 blobs 的可达集覆盖**全部世代**（不是 active + N）。

**其它**

- 插件服务只允许持有**可重算状态（③）**；④ 不可重算必须显式声明——v1 无 ④ 声明形态（`plugin.json.state` 仍只允许 `recomputable`；④ 档随需要它的首个不可重算服务后置，与下面的数据引用不是同一层）。
- 密钥不进世界：世界数据只存引用 `auth_ref = {kind:'local'|'env', name}`（引用形状由身份数据契约冻结；`local` 读宿主侧用户本地文件，`env` 读进程环境）。本体不进世界、不进审计、不进 config 导出；重放只复现引用、不复现密钥。这是**身份 body 字段**，不是 `plugin.json` 的 ④ 状态档。
- **服务断连自退出**：插件服务检测到与宿主连接断开（**stdin EOF / 管道断开**）即**自退出**（服务协议义务，见 `docs/protocol.md` §2.7）——避免宿主崩溃后孤儿进程占端点。
- 判定 / **决策路由** / 评分 / 门禁写成 term；**能力解析路由**不是判定，是宿主的机械解析（见「路由」）。
  取用 / 效果执行 / 装载在宿主（`kernel.md` §十）。
- 执行件永远不承担校验。
- 世代跟随走**宿主通知**；插件**不开世界读通道**（避免两份世界视图）。
- 插件的 `event` **只透传给入站面已连接的客户端**（按 `impl` 命名空间，见 `docs/protocol.md` §三），
  不投递给其他插件（投递需要宿主理解 `kind` = 认识业务）；宿主不执行、不落账、不推进。
  宿主自身的 run 生命周期事件（`run.started` / `run.finished`，见「宿主扩展面」）同路广播，`impl = "host"`。
- **两种「审计」分流**：`EffectAudit`（① def、在世、被 write 的 `ref` 指——强审计，内容可追溯，见「效果」）；
  载体生命周期事件只进**运维日志**——宿主侧持久 append-only 文件（`state/lifecycle.log`，JSONL，逐行原子写），**不进世界、不进链、不参与重放**、宿主崩溃不丢。
  运维日志不属于 ①②③④（那是世界内容分类）；它是宿主独有的操作取证。assembly 只读世界、不写链——生命周期事件落运维日志不破此界。
- **运维日志事件 = 两级 `{ kind, event }`**（`kind` 封闭、`event` 每 kind 有规范表）——**结构上不可能撞名**：

  | `kind` | `event` | 载荷 | 触发 |
  | --- | --- | --- | --- |
  | `host` | `start` / `stop` / `start_failed` | `reason?` | 宿主自起停 / 启动选项非法 |
  | `dep` | `cycle` / `stale` / `drift` / `retired` / `periodic_invalid` / `method_timeout_invalid` | `impl`, `cap?`, `reason?` | 装配解析 / 依赖退役 / 周期与方法级超时声明非法 |
  | `handshake` | `failed` / `extra_dropped` | `impl`, `gen`, `caps?` | 握手校验 |
  | `service` | `start_failed` / `exit` / `restart_exhausted` | `impl`, `gen`, `reason?` | 起服务 / 进程 |

  记录 = `{ at, kind, event, impl?, gen?, cap?, reason?, caps?, seq? }`（`at` 必有；`seq` 可选、仅换代类事件有）。
  **注**：`docs/protocol.md` §四 的**错误码**（`handshake_failed` / `cycle` / …）是给客户端的，**与运维日志事件是两套命名**（错误码保持扁平）。

## 六、载体不变量

1. **唯一写口**：插件服务永不写链；写一律经内核 `commit` 的四步校验——常规走 `run` 的 write directive，审计与离线 `seed` 由宿主 / `boot` 直写 `commit`。
2. **效果必审计**：每对 `EffRequest→EffResult` 必有 `EffectAudit` def 且被 `ref` 指到。
3. **插件间不直连**：效果一律经宿主。
4. **运行态不进世界**：物理端点 / pid 只住宿主侧 ③。
5. **不扩权**：`EffRequest.caps` 恒等于输入（内核保证；宿主不扩权）。
6. **落盘字节保真**：`Entry.args` 不重序列化。
7. **声明驱动**：`assembly` 不认识插件种类，只看声明与 `pins`。
8. **无特权**：toy 服务与任何插件同路，无任何插件享有特殊路径（`kernel.md` §十一「第一方无特权」的载体面）。
9. **插件不 import 宿主与内核**：插件不得 import `packages/host` / `packages/kernel`，也不得把它们作 npm 依赖；服务代码同样不得 import `packages/client`（它 import 内核）。对宿主的依赖只经**线协议 + `pins`**（能力类名 / 方法名，保留类 `host`）；插件只提交内容与效果请求，不算哈希、不校验、不写链。

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
- **不做结构 op（改 / 加插件）的审批闸门**——那属上层能力，不属载体。载体只保证：写口唯一（一切写经 `commit` 四步校验）、坏分支只隔离（fail-closed，绝不回落旧世代）。⇒ **人类审批必须落在上层**；否则世界里的数据可以命令宿主持久化并 spawn 新进程执行任意内容。
- **运行期写出的包不过入世门禁（已知不对称，已决：接受并记风险）**：`boot seed` 走 ingest 的全套门禁（声明形状 / 路径约束 / `argsSchema` 方言 / term 环 / `.worldignore`），而运行期 `add_gen` 写包只走 `commit` 的形态 / 引用 / 位置 / 不变量校验，宿主仅在命令路径补一次 `argsSchema` 方言元校验。兜底：坏声明由装配期 `parsePluginDecl` 拦下 → 该分支隔离，不炸宿主；但坏 schema / 坏 term 可能到运行时才暴露。
