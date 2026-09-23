# 插件规范

> 口径来源：`docs/kernel.md`（内核设计）+ `docs/host.md`（载体设计）。
> 本文只规定**插件长什么样、怎么写、怎么接**；**不规定有哪些插件**。
> 旧版「插件清单与分离规则」已作废（旧装配层口径），可从 git 历史取回。

---

## 一、什么是插件

- 一个插件 = 一个**包**（`package.json` **信封**；**语言自由**——Rust 等非 JS 包同形，见 §三「实现语言自由」）= 一个身份 = 一批成员。**只有一种插件，不分内部 / 外部**。
- **数据身份的数据 = 同身份的数据世代**（同身份混合世代）：数据身份用 `put(data)` + `add_gen` 写数据，
  数据世代与代码世代（包 `commit`）共存于同一身份的 `gens`；宿主装配按**最近代码世代**解析声明 / `pins`，
  投影 `ctx.ids.<id>.body` 取**最近数据世代**（无数据世代回落代码世代）；数据世代变化不触发服务换代 / 隔离。
- 成员三种，**同路无特例**：**执行件**（自带服务进程）/ **term**（判定数据）/ **声明**（`plugin.json` + `schema`）。
- **npm 只是投递信封**：世界才是真源——插件入世（`put` / `batch`）后源码进 ① 才生效；包内第三方依赖（`node_modules`）是宿主侧 ③（可重算）。
- 插件包放在哪（仓库 `plugins/<name>/` 或 `node_modules/`）**只是位置、不是分类**；宿主按 `state/plugins.json` 的 `[{name, path?}]` 解析（有 `path` 走路径、无 `path` 走 Node 解析）。
- 「agent engine」不是某个插件，而是**宿主 + 全部插件 + 世界**的组合；**没有特权插件**。

## 二、长什么样

```
<plugin-package>/                 # 一个 npm 包（仓库 plugins/<name>/ 或 node_modules/<pkg>，同形）
├── package.json     npm 信封：name / version / 依赖 / scripts（宿主不解释，入 ① 作源码）
├── plugin.json      插件契约：14 字段（`schema` / `build` / `exclusive` 可省略；宿主解释、入世进 ①；与信封无关）
├── README.md        自述（人读）
├── .worldignore     入世排除表（可选；宿主读，自身不入 ①）
├── test/            测试文件（**不入 ①**）
├── execute/         执行件源码（0..n；含启动命令与语言运行时入口）
├── src/             整服务 Rust 源码（0..n；与 execute/ 同为 execute 成员）
├── terms/           term def（0..n）
└── schema/          声明 schema（0..n）
# 通用排除 node_modules / .git；.worldignore 声明项另排除；契约必需文件不可排除
```

- **`plugin.json`（契约）与 `package.json`（信封）职责分开**：契约与信封无关（换信封仍在），故**不并入** `package.json`；
  所有插件共用**同一 `plugin.json` 形状**——这就是「一个口径」。
- **入世 = 包内源码树**（`plugin.json` + `package.json` + 锁文件 + `README.md` + `execute/` / `terms/` / `schema/`）
  **减去通用排除（`node_modules` / `.git`）与 `.worldignore` 声明项**；契约必需文件不可被排除；宿主**只解释 `plugin.json`**，其余是源码 blob。
  入世有两条路径：`seed`（按 `state/plugins.json` 清单批量）与 `pack`（单目录手动 / 程序化，`boot pack <目录> --identity <身份名>`）；
  两者**同为入世路径、共用同一套打包规则**，故同一目录、同一身份产出相同的源码 tree 与 commit 哈希。
- **`.worldignore`（可选）**：包内文本文件，每行一个相对路径（**按路径段前缀匹配**，故 `test/` 不误伤 `test.js`；`#` 注释、空行忽略），命中即不入 ①；不能命中契约必需文件（`plugin.json` / `package.json` / 锁 / `README.md` / `schema` / `commands` / `members` 路径本身），否则整批拒绝 `bad_worldignore`（畸形 `.worldignore`，如含 `..` 段 / 读取失败，同样拒绝）。插件用它排除构建产物 / 测试 / 语言运行时缓存（`dist/`、`.venv/`、`__pycache__/` 等）——宿主不认识语言，故不内置这些名字。
- **整服务 Rust 插件的 `src/`**：整服务 Rust 插件把 `src/`（或 `execute/`）登记为 `execute` 成员（如 `{kind:'execute', path:'src/'}`）——机制合法且换代识别需要；包内只放源码 + `Cargo.toml`，构建在 `plugin.json.build` 里显式声明（如 `[{cmd:'cargo', args:['build','--release']}]`），`target/` 等编译产物走 `.worldignore` 排除、并按声明经 ③ 依赖缓存物化。
- **包内路径约束**：`schema` / `commands[].entry` / `commands[].argsSchema` / `members[].path` 必须是安全的**包内相对路径**（禁 `..` 段、绝对路径、盘符、反斜杠），否则入世拒 `bad_plugin_decl`。
- **测试不入 ①、也不依赖 ①**：`npm test`（或等价命令）在包目录（`plugins/<name>/` 或 `node_modules/`）里跑，不读世界副本；世界只保留**运行时所需**（契约文件 + `execute/` / `terms/` / `schema/`）。**注意（口径修正）**：宿主打包只自动排除 `node_modules` / `.git`——**`test/` 不在自动排除之列**，插件须在 `.worldignore` 里显式声明 `test/`（`example` / `toy-*` 夹具同此），否则测试文件会随源码树入世。
- **term 内 callee 引用必须无环**：`terms/` 里的 `$ref` 在入世时解析成 def 哈希；成环 → **整包入世被拒**（`term_cycle`），其他包照常。term 调用图本就是 defs DAG 的子图（`kernel.md` §十三），环 = 写错。
- **term 读世界只经 `ctx` 投影**（形状见 `host.md` §五 投影）：内核 `["g", path]` 是**静态字面路径**，故按**身份字面 id** 取（`ctx.ids.<id>.active` / `.body`）；哈希键（`defs.<hash>`）不可达——宿主不把 `defs` 表给 term。
- 插件包**不得依赖 `kernel` 或其他插件包**；插件间依赖只走 `pins`（npm 依赖只管自带库，见 §三）。
- **计划值口径**：服务**没有任何写通道**——运行时写计划只能由「拿到了 `ctx` 的服务」构造，作为顶层 `eval` 的值经 term 交回宿主，再由宿主按 directive 落账（`host.md` §五 落账）；服务不写链、不落账。
- **服务不读投影（通则）**：有 `execute` 的插件，其 `+`（投影读）一律由**调用方的入口 term 读 `ctx` 后随 `args` / `bag` 传入**（服务只收 bag、回结果 / 计划）；服务不读投影、不按名调命令。命令入口 term 可读投影。
- **保留身份 `host`**：`pins` 的值可写 `host`，入世解析到**宿主自身保留能力类**（见 `host.md` §五 路由 / 宿主扩展面）；不要求世界里有该身份。**限制**：host pin 仅在入世（`seed` / `pack` 的 `batch`）成立，裸运行期顶层 `add_gen` / `put` / `graft` 不接受（提前 `bad_directive`）；host 能力是 **v1 受信面、无方法级鉴权**。身份名不得为 `host`（会被遮蔽）。
- 密钥不进世界：世界数据里的引用形状为 `auth_ref = {kind:'local'|'env', name}`（`#2` / `#24` 冻结）；原则（只存引用不存本体；`plugin.json` 的 ④ 状态档仍后置）见 `host.md` §五 其它。

`plugin.json` 字段（冻结）：

| 字段 | 含义 |
| --- | --- |
| `identity` | 身份名 = 世界里的 `id`（**无 `kind`**——内核 `Identity` 无分类字段，身份性质由 `schema` 承载，`kernel.md` §四） |
| `schema` | 身份**自述 / 数据契约**：指向包内 `schema/` 里的文件（如 `schema/plugin.schema.json`）；入世解析成 `Identity.schema` 哈希。它是**数据、非特权**（`kernel.md` §四）；宿主对 `plugin.json` 形状的元校验另有一份宿主侧 schema。**可省略**：无世界数据的 UI 插件可**零 schema**（直接省略字段，不得以 `null` 占位）；省略时宿主机械提供最小默认 schema def `{"type":"object"}` 作 `Identity.schema` 哈希（内核要求身份必有 schema），不解释业务 |
| `implements` | 提供的能力类（能力类名） |
| `methods` | 能力类 → 方法名 |
| `pins` | 身份级依赖：名（逻辑端点名）→ **被依赖身份名**；入世时由宿主解析成「被依赖身份 active 世代 payload 哈希」（**身份依赖唯一记录处**，规矩 A）。term 内对同包 callee 的引用**不进此字段**：它在 `terms/` 源里写成占位符，入世时由宿主机械替换成 callee def 哈希，作 body 数据值 |
| `start` | 启动命令（宿主不认识语言、不做编译）。为空 ≡ 该插件无执行件（**数据身份**，宿主不起服务）；若 `members` 含 `execute` 而成 `start` 为空 → 装载期按坏声明拒（`service.start_failed` reason `missing_start_command`） |
| `build` | **构建声明**（宿主只执行、不解释语言，与 `start` 同性质）：`[{ cmd, args }]`，每步一条命令；物化后、`start` 前按序执行。**可省略**：字段缺失 = 回落宿主存量探测（`package.json` 依赖 / 锁 → npm、`Cargo.toml` → `cargo build --release`），供尚未迁移的插件兼容；**声明了（含空数组）就只跑声明的**——空数组 = 显式「无需构建」。`cmd` 与每个 `args` 令牌必须过 shell 安全白名单（`[A-Za-z0-9_./:@,+-]`）：命令经 `shell:true` 解析，令牌含空白 / 引号 / shell 元字符即入世拒 `bad_plugin_decl`。环境变量（`npm_config_cache` / `CARGO_TARGET_DIR` 等）由宿主注入，不写进声明；产物落点分共享型与随世代型两种合法形态（见 §三 红线 5） |
| `exclusive` | **独占资源声明**（描述占用事实，不指定宿主调度机制）：`["<资源类>"]`，v1 只认 `port`（绑定固定端口 / 地址的服务）。**可省略**（缺省 = 无独占资源）。非空 = 本插件的服务实例**独占该资源、新旧实例不能并存**；宿主据此在**代码换代**时改为「先 drain 旧服务 → 再起新服务」（接受该身份短暂空窗），缺省则保持零空窗的「先起新 → 切端点 → drain 旧」。**以新世代声明为准**（声明描述新实例的占用事实）。元素非字符串 / 空串 / 未知资源类即入世拒 `bad_plugin_decl`（宿主无法判定未知资源类的换人序是否安全，故 fail-closed）。与 `build` 同性质：插件声明事实，宿主决定调度——以后换调度策略不必改插件（见 `host.md` §五 装配） |
| `protocol` | 服务协议版本 |
| `restart` | 重启策略：`policy` = `on-exit`（缺省 / 未知按此）/ `never`（不重启，退出即隔离该分支）；`backoff` = `none` / `fixed` / `exponential`（缺省 `exponential`）、`backoff_ms` / `backoff_max_ms` 退避参数；`max` 重启上限；**稳定 `window_ms`**：本次运行 ≥ `window_ms` 才复位重启计数，否则算 flapping；`drain_ms` 排空期限。v1 默认 `backoff=exponential`、`backoff_ms=500`、`backoff_max_ms=30000`、`max=5`、`window_ms=60000`、`drain_ms=5000` |
| `health` | 健康判据：`interval_ms` / `timeout_ms` 由宿主消费（v1 默认 10000 / 2000）；宿主健康判定走**协议级 `probe` / `pong`**（`docs/protocol.md` §2.3）；`probe` = 服务侧自述的探针名（**宿主不消费**，服务可自解析） |
| `state` | 状态档：v1 只允许 `recomputable`（③ 可重算）；④ 不可重算的声明形态后置（随 `auth_ref`） |
| `members` | 成员清单，每项带 `kind`（`execute` / `term` / `schema`）——「数据热生效 vs 代码起新服务」由此驱动，不按目录名 |
| `commands` | 命令声明：`{ name, entry, argsSchema, readonly? }`——客户端按 `name` 调用，宿主解析到入口 def 并机械校验参数。`entry` / `argsSchema` 是**包内路径**，入世解析成 def 哈希（与 `schema` 同路：契约层写路径、宿主解析）；`argsSchema` 方言见下。`readonly` 可选布尔（缺省 `false`；显式非布尔入世拒）：`true` = **只读命令（纯查询）**，宿主不广播 run 生命周期事件、不落审计、不推进链头——只有确认命令不写链、不产 write / plan 时才标（产出即 `refused`、reason `readonly_violation`） |

### 命令 `argsSchema` 方言（v1 · JSON Schema 白名单子集）

`argsSchema` 指向的 def body 必须落在**白名单子集**内；宿主只做**形态门禁**，语义校验（业务规则）归插件：

- **白名单**（参与校验）：`type`（单值：`object` / `array` / `string` / `number` / `integer` / `boolean` / `null`）、
  `properties`、`required`、`additionalProperties`（仅布尔，缺省 `true`）、`items`（单 schema）、`enum`、`const`、
  `minimum` / `maximum`、`minItems` / `maxItems`、`minLength` / `maxLength`（按 **Unicode 码点**计）。
- **注记**（不参与校验）：`title` / `description` / `default` / `examples`。
- **其余关键词一律入世拒**（`bad_args_schema`，**不静默忽略**）——含 `$ref`（含远端）、`$schema`、`pattern`、`format`、
  `oneOf` / `anyOf` / `allOf` / `not`、`if` / `then` / `else`、`multipleOf`、`exclusive*`、`uniqueItems`、`contains` 等。
- **钉死的语义**：类型判定复用内核值标签 `t`（一种口径）；`enum` / `const` 用内核 `deepEq` 比较；
  `integer` = `Number.isInteger`；缺键与 `null` 不同；`required` 只查键存在；`additionalProperties` 缺省 `true`。
- **门禁在宿主、先于 run**：`argsSchema` 缺省 = 不设门；缺 `args` = `null`；不符 → `bad_args`，**不构造 directive、不落账**。
  校验器用显式栈（防深嵌套），**不执行正则、不触网、无副作用**。
- **`commands[].readonly`（只读命令）**：缺省 `false`；`true` 声明该命令是**纯查询**——宿主**不广播** `run.started` / `run.finished`、**不落 `EffectAudit`**、不推进链头；执行产出任何 write / plan 即 `refused`（reason `readonly_violation`）。**只读是声明方责任**：宿主不做语义判定，插件须在确认命令不写链、不产计划时才标（历史 / 清单读取类纯查询命令）；显式非布尔入世拒。`forward` 帧按目标命令声明同规。
- `Identity.schema` 用**同一方言**（身份数据契约），但宿主 v1 **不校验**身份数据——它仍是数据、非特权。
- **schema 顶层「宿主消费键」**（宿主机械读、不认识业务；其余键归插件自用）：
  `periodic: [{ command | method, every_ms, reads? }]`（定时触发，`host.md` §五 定时触发）；
  `method_timeouts: {"<能力类>.<方法>": ms}`（方法级调用超时覆盖，`host.md` §五 效果）；
  `assets_manifest: [{ path, sha256, size }]`（投递目录大资产直拷，`host.md` §五 宿主扩展面）。
  三键声明非法均只记运维日志、不阻断装载。

## 三、做法红线

每条都落在 `docs/host.md` §六 的不变量上（按插件侧归并），破了就是插件没写对：

1. **不 import 宿主与内核、不依赖其他插件包**：`packages/host` / `packages/kernel` 既不能 import（**含 `execute/` / `src/` / `terms/` / `test/` 全部包内文件，测试亦不得豁免**）、也不能作 npm 依赖（服务代码亦不得 import `packages/client`——它 import 内核）；不算哈希、不校验、不写链；键 / 哈希 / 校验 / 写链全在宿主。对宿主的依赖只经**线协议 + `pins`**（能力类名 / 方法名，含保留类 `host`）。npm 依赖**不得**用于插件间调用（插件间只走 `pins`）。
2. **只提交内容与效果请求**：`put` / `batch` 载荷 + `EffRequest`；另有 `event` 通知（宿主只透传，不落账、不推进），**不得**用它写链或索取其他插件的端点。
3. **不与其他插件直连**：效果一律经宿主（保 `EffectAudit`）。
4. **依赖只走 `pins`，可跨插件相互依赖（但闭包必须无环）**：A 的 `pins` 写 B 的身份（名 → 身份名，入世时解析成哈希，绑定的是**身份**不是版本）；A 的代码 / term 只写**能力类名 + 方法名**，宿主按 `pins` 路由。**不 import、不共享进程内对象、不直连**；`pins` 只记**身份级**（跨身份）依赖。term 内对同包 callee 的引用是**本身份内**的函数值：源里写占位符、入世替换成 def 哈希，不入 `pins`。漏写身份级 `pins` 会静默失效。**自能力路由不是 `pins` 项**：有 `execute` 的插件把入口 term 的 `eff` 路由进**自己的服务**（能力类 = 自身 `implements` 声明）**无需写自引用 pin**，它不构成身份级依赖、不进装配闭包、不参与受保护 `pins` 校验（见 `host.md` §五 路由）。
5. **自带启动命令 / 自带构建声明 / 实现语言自由**：宿主只跑 `plugin.json.start` 与 `plugin.json.build`，不认识语言；插件可用任意语言（默认 TS；非默认语言由插件自述（`README.md`）声明）。包内只放**源码 + 依赖清单**（`package.json` / `Cargo.toml`）；构建由 `build` 显式声明（可省略回落存量探测），宿主在**物化目录内**按序执行（`host.md` §五 宿主扩展面）。构建产物按**能否跨世代共享**分两种合法形态，二者都必须由 `.worldignore` 排除、不得入世：
   - **共享型产物**（Rust 二进制、原生扩展 `*.node` 等）：落宿主侧 ③ 共享缓存（如 `state/deps/cargo-target/`），多世代复用；服务按声明路径去找（缓存目录由宿主经环境变量注入，不写进声明）。
   - **随世代产物**（前端 bundle 等）：落**物化目录内**（如 `dist/` / `execute/web/dist/`），因为要被 `import.meta.url` 相对定位；不跨世代共享，每世代各一份，随该世代目录一起回收。
   `node_modules` 等依赖目录由宿主按通用排除处理（宿主侧 ③、不入世）；构建产物则必须由插件 `.worldignore` 显式排除——宿主不认识语言，故不内置 `dist/` 等名字。产物若随源码入世，字节差异会污染内容哈希并触发无意义的连续换代。
6. **物理端点不进世界**：服务端点 = 子进程 **stdio**（宿主接管）、入站面用 socket；只住宿主侧 ③。
7. **状态只允许可重算（③）**；④ 不可重算必须显式声明（v1 无 ④ 档）；密钥走世界数据 `auth_ref = {kind:'local'|'env', name}`（只存引用不存本体，见 `host.md` §五 其它），不进 `plugin.json` 明文、不进世界 body。
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

- 插件生命周期事件由宿主记入**运维日志**（`state/lifecycle.log`），两级 `{kind, event}`：`handshake.failed` / `handshake.extra_dropped` / `dep.cycle` / `dep.stale` / `dep.drift` / `dep.retired` / `service.start_failed` / `service.exit` / `service.restart_exhausted`；**不进世界、不进链、不可重放**；插件不得依赖其在世界里的存在（与 `EffectAudit` 分流，见 `host.md` §五 其它）。

## 五、换代（热更新）

| 改什么 | 机制 | 进程 |
| --- | --- | --- |
| 数据（term / 参数 / 配置） | 宿主重取 def、换缓存 | **不动** |
| 代码（缺省，无独占资源） | 起新服务 → 握手 → 端点表原子切换 → 旧服务 drain（零空窗） | 换 |
| 代码（`exclusive` 声明独占资源） | 先 drain 旧服务 → 再起新服务 → 端点切换（该身份短暂空窗） | 换 |

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
  `execute/`（执行件）、`terms/`（判定数据）、`schema/`（声明 schema）、`.worldignore`（可选：入世排除表）。
- `plugin.json` 的 14 个字段一个不少：`identity` / `schema` / `implements` / `methods` / `pins` / `start` / `build` /
  `exclusive` / `protocol` / `restart` / `health` / `state` / `members` / `commands`。
  **例外**：无世界数据的 UI 插件可省略 `schema`（零 schema；省略时宿主提供最小默认 def）；`build` 可省略（回落宿主存量探测）；
  `exclusive` 可省略（无独占资源，走零空窗换代）。其余 11 个字段一个不少。

**行为**（§三 十条红线）

- 不 import 宿主与内核 / 不依赖插件包 · 只提交内容与效果请求 · 不与其他插件直连 · 依赖只走 `pins` · 自带启动命令 ·
  物理端点不进世界 · 状态只允许 ③ · 执行件不承担校验 · 命令是具名入口 · 自带 `README.md`。

**接口**（`docs/protocol.md` §二）

- 服务协议：`hello` / `manifest` / `call` / `result` / `error` / `reload` / `drain` / `bye` / `probe` / `pong` / `event`。
- 三条禁止：不写链、不索取其他插件的端点、不扩权。
- 两条义务：**stdout 只许协议帧、日志一律走 stderr**；与宿主连接断开（**stdin EOF / 管道断开**）即**自退出**（避免孤儿进程占端点）。

**生命周期**（§四、§五）

- 数据生命周期归内核（唯一执行者）；进程生命周期归宿主 `assembly`（声明驱动）；
  换代两档：数据热生效（进程不动）/ 代码起新服务 + 旧服务 drain。
- 一次 run 锚定世代，换代只在 run 边界生效。
