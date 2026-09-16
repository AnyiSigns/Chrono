# 内核设计与落地规格

---

# 第零部分 · 上下文（内核在哪一层）

## 0.1 三件事别混

| | 是什么 | 产物 | 与内核的关系 |
|---|---|---|---|
| 上层（宿主 / 产品 / 审核 / 研究） | 用内核给的一致性做自己的判定 | 判据、阈值、策略、装载、投影 | 下游：只能以**数据**身份进世界，永不以代码身份进内核 |
| **内核** | 可复现的世界 + 谱系 + 机械校验 | 世界版本、世代链、判决、观测流 | 本文件 |
| 产品 | 给人用的面 | 用户体验 | 下游：全部是世界的投影 |

一句话：**"该不该"全在上层（判据、评分、取舍——怎么定、定成什么样，内核一概不知）；内核只管"改了什么、能不能退、非法能不能进"。**

## 0.2 三条单向

1. **依赖单向**：产品 → 载体 → 内核；内核**零依赖**，研究不在链上。
2. **真源单向**：内核的（世界 + 日志）是**唯一真源**；上层的配置、UI 布局、命令面、宿主清单全部是**投影**——不落盘、不生成、不需要门禁守漂移。
3. **判定单向**：上层怎么判——判据、阈值、评分规则，爱怎么叫怎么叫——只能以**数据**身份进世界，永不以代码身份进内核。

## 0.3 内核之外有什么

图 · 作用域 · 通道 · 路由策略 · 提示词 · 参数 · 工具绑定 · UI 描述 · 可见性规则 · 判定标准 —— 全部是**世界内容**。内核不知道里面有什么，只要求它们有身份、有世代、能标注依附。二进制本体不住在世界里：权重、模型、构建产物只以"声明 + 哈希 + 平台"的形式进 `defs`，本体归宿主存储或包注册表。

一份内容怎么分类（可训 / 冻结 / 检索绑定 / 可搜索，或上层想用的任何别的名字），是上层的事。**内核不要求任何分类字段**：`Identity` 只有 `id` / `schema` / `gens` / `active` / `born`（§7），没有 class，也没有标签位。上层要分组，用它已有的手段——`schema` 指向一份 def、`pins` 挂一个引用、或写在自己的 body 里——那都是世界内容，不是内核结构。但分组归分组，**结构性依赖的唯一记录处是 `pins`**（规矩 A，§0.4）：body 里的哈希只是业务数据值。

## 0.4 四档：什么住在哪

热路径的成本几乎全部来自一个混淆：**把"只是发生过的事"当成"决定世界现在是什么的事"**。按**是不是声明** × **能不能重算**两个轴分四档——"声明"就是"是事实就得进世界、被记账"；大小只是结果，不是判据。

| 档 | 判据 | 住在哪 | 内核为它付什么 | 丢了的后果 |
|---|---|---|---|---|
| **① 声明** | 影响"世界现在是什么"，需要被引用 / pin：**含源码文本** | `defs` + `ids` | 哈希它（写一次、全量审计重放一次）、克隆、进摘要、进依附判定 | **不可丢** |
| **② 留痕** | 只需"发生过、不可抵赖"，不需被引用 | `Entry.args`（载荷 note，§11.2），被链覆盖 | 一次 `H(args)` 进链；**不**克隆、**不**摘要、**不**进闭包 | 可归档，**不可删** |
| **③ 可重算的本体** | 大，但能由 ① 重新算出来 | 宿主**缓存** | **零** | 丢了重建即可：构建产物、索引、解析结果 |
| **④ 不可重算的本体** | 大，且算不回来 | 宿主**持久存储** | **零**（世界只存"哈希 + 平台"声明） | 丢了就真没了：训练权重、外部抓取的数据、用户上传原始件 |

③ 与 ④ 在**协议上同形**（世界里都是一条"哈希 + 平台"声明），区别只在宿主的保留策略。

**源码为什么必须在 ①**（不因大而外迁）：① **回滚承诺**——回滚一个插件 = `set_active` 指回旧 payload，一个记账动作，前提是旧世代源码必然还在；住进"可丢弃缓存"，承诺即为假。② **依附判定**——换源码必须判得出旧内容失效，`pins` 得指得到它。③ **无特权**——给"代码"开"其实住在外面"的例外就是内建特权（§2）。

**会话类产品的税（写死，别让它意外发生）**：分支编辑重放的 `defs` 字节 ∝ **总尝试次数**而非会话数（每次重做的声明都追加、不折叠）——四档在此用法下不是优化，是**前置条件**：会话正文与工具结果属 ②③，只有"线 / 世代 / 依赖声明"属 ①。

**一条内核永远给不出的保证**：内核不认识"引用"，所以一份 def 引用的内容没了，它照样合法。**"声明完整"永远是宿主算出来的**（闭包是宿主动词）。

**规矩 A：结构性依赖只走 `pins`，`pins` 是唯一记录处。** 判据一句话——"**被引用的那份 def 不在世界里，这份 def 还成立吗？**"不成立 ⇒ 它是依赖 ⇒ 必须是 `pins` 的一项；body 里的哈希只能是业务数据值。这样闭包 = 宿主沿 `pins` 做一次**只读遍历**（内核仍不提供该算法、仍不解释 pin 名——§22），归档裁剪、跨世界搬运、`stale()` 依附判定全部随之可执行。**内核无法强制这点**（它不读 body）：漏写 pins 不会被拒，只会让 `stale()` 静默失效（§11.3"双缺 → false"）——不报错的错，所以门禁以数据落在上层（宿主在采纳前求值判据 term，M2 的本分）。

**规矩 B：留痕走链，声明走世界。** 带内容的记录不该为了"能被记住"而挤进热世界；`note` 载荷就是 ② 的实现（§11.2 形状表）。**② 换到的是 RAM / 克隆 / 摘要，不省哈希时间**——把大字节塞进 `note` 只是把 RAM 墙换成时间墙，所以 ② 放摘要级、③④ 放本体；载荷大小由**宿主门禁**限制（不是内核常量，§2）。

---

# 第一部分 · 设计

## 1. 内核是什么

> **内核 = 可复现的世界 + 谱系 + 机械校验。它不装载、不审核、不执行外部动作，只保证世界可追溯、可回滚、不可被非法改写。**

内核只做四件事，缺一件"受控自进化"就断一条腿：

| # | 机制 | 缺了会怎样 |
|---|---|---|
| M1 | `value` 值层：JSON 值 + 规范序列化 + 内容哈希 | 无法比较、无法回滚、无法判定失效 |
| M2 | `machine` 归约机：项求值 + gas | 世界内容（含一切判定标准）无法被执行 |
| M3 | `journal` 日志：append-only + replay | 无法归因、无法退回任意版本 |
| M4 | `commit` 机械校验 + 唯一写口 | 非法内容能进世界，谱系与依附不变量失守 |

## 2. 准入规则：内核只有名词，没有动词

> **判断某样东西该不该进内核，只问一句：它是名词（机制 / 数据形态），还是动词（过程 / 动作）？动词一律不进内核；动词住在外面，并且依赖内核。**

| 动词 | 住在哪 | 依赖内核的什么 |
|---|---|---|
| 初始化（造出第一个世界） | 上层 / 产品 / agent 工具 | `commit` 的 `batch` 写 |
| 审核（该不该采纳） | 上层 | 求值器 + 效果（读世界） |
| 试跑 | 上层 | 求值器 + 单独一次调用（自带能力表） |
| 装载 / 替换实现 | 载体 | 无（内核不装载） |
| 执行 / 训练 | 上层 + 载体 | 求值器、日志、依附判定 |

内核不做：不装载、不 IO、不持久化、不调度、**不审核、不审批、不挂起等人**；不认识图 / 作用域 / 通道 / 路由 / 算子 / LLM / 工具 / 模型 / UI；不定义载荷 schema，不定义判定标准，不定义分级表。

### 为什么"插件框架"不需要搭

插件 = 数据。于是框架在别的体系里承担的事，在这里**要么已由内核给出，要么根本不存在**：

| 框架通常要做的 | 在这里 |
|---|---|
| 插件注册表 | **就是 `ids` 身份表** |
| 依赖注入 | **就是 hash 引用与 `pins`** |
| 生命周期 | **就是世代链 `gens`** |
| manifest 校验 | **就是 `commit` 的机械校验 + schema** |
| 按类型分类 | **就是 `schema` 指向的那个 blob** |

剩下的只有**装载代码**——那是载体的活（只有端口实现才是代码）。

三条推论：

1. **"定义插件类型" = 往世界写一份 schema**。它是数据写请求，不需要先有框架。
2. **"调用一个插件" = `eval` 它的 payload**，不需要装载（数据不装载）。
3. **顺序是反的**：先写第一个插件，从它身上长出类型；不是先定类型再造插件。

> 框架是"对多个实例的抽象"。只有一个实例时就抽象，必然抽象错。

### 第一方内容无特权：一律当"外来"做

**特权只有两处：内核（判什么合法）与载体（执行效果 / 持久化）。除此之外，我们的代码和别人的代码一样外来。**

落到实处：

| 我们的东西是什么 | 走哪条路 | 与第三方的关系 |
|---|---|---|
| 数据（term / schema / 定义包） | 经 `batch` 写入世界 | 与第三方数据**完全同路** |
| 代码（端口实现、适配器） | 以端口实现身份声明 + 装载 | 与第三方代码**完全同路** |

所以**没有"内建插件"或"出厂插件"这一档**，也没有 `builtin/` / `official/` / `core-plugins/` 这类目录。不存在只有第一方能做的事。

对自己的三条约束：

1. 第一方插件必须声明**和第三方一样的字段**：`schema` / `pins` / `sig`，走同一条 `put` / `batch` 路径、同一道门禁。**想给第一方开后门时，说明接口缺了一样东西——补接口，不要开洞。**（能力不在声明里：`caps` 恒等于输入的能力表，§14-6；判据与验收标准是上层数据，内核不为它们预留字段。）
2. 第一方插件必须**可被卸载、降权、下架**，走同一条门禁。
3. 任何"只有第一方能做到"的事，判定为一个 bug 或一个缺失的接口。

可测判据：

> **把全部第一方插件卸载，内核与其测试仍然全绿**（降级但能跑）。跑不起来 = 存在内建特权。

### "统一"的准确边界

统一的是**门禁与记账**（同一道机械校验、同一套身份 / 世代 / 依附 / 判决）。**不统一的是物理形态**：


- **代码插件**：需要装载、隔离、能力授予（`eff` 的 caps）——这是载体的活。

这是形态差异，不是特权差异。只要记账同一套，**卸载一个代码插件和卸载一个数据插件在历史里长得一样**。

## 3. 内核只认识四个词

> **身份 · 世代 · 依附 · 判决**

| 词 | 含义 |
|---|---|
| 身份 | 一条稳定的谱系：`id` 永不变、永不复用 |
| 世代 | 谱系上只增的实现序列：`seq` 严格 +1，永不删除 |
| 依附 | 任何一份内容都可以声明它依附于哪一组版本（`pins` + `sig`） |
| 判决 | **机械合法性**判定结果：`ok` / `reasons`。不是"该不该"，是"合不合法" |

**内核判决 = 机械合法性；审核（正当性）在上层。** 两件事不要混。

## 4. 五条硬约束

1. **纯函数**：同输入必得同输出。**无内部时间、无随机、无 IO、无第三方 import**。时间只能作为**输入**出现（`KernelInput.now` → `Entry.at`），读时钟是宿主的活。
2. **不持久化**：返回新世界与日志，落盘是宿主的事。
3. **一次调用只推进到下一个挂起点或终止**，不内嵌循环。
4. **等待只用于等外部结果，不用于等人**——人要参与时他就是某个端口的一种实现，内核不知道对面是谁。
5. **单链串行（v1 并发边界，写死）**：一个世界一条链，内核里没有"分叉合并"这个名词。同链并发全由 `expect_pos` 乐观重试解决——一个赢，输家按新链头重组请求再提（`pos_conflict` 是正常路径，不是故障）。**多世界合并明确 off-scope（v1）**，理由是 §2 的名词门：合并要求裁决"两边各改了什么、谁赢"——那是语义级动词，属于审核，不属于记账。真要会拢内容，由上层对对方历史做**过滤视图、挑出内容、经 `batch` 以数据身份写入本链**——各世界各自的链都原样保留、各自可审计。多代理协作撞到这堵墙时，答案是"再开一段账"，不是"改内核加 merge"。

### 4.5 信任模型与责任边界（一句话：内核给一致性，不给正确性）

身份、依附、判决——内核只保证这三件事**自洽、可追溯、不可被非法改写**。它不保证被记账的内容"对"。以下三处是最容易被误解成"内核会管"、其实**内核不管、也不该管**的，写死归属：

| 面 | 内核给的 | 内核**不给**的 | 谁负责 |
|---|---|---|---|
| 身份/来源 | `id` 永不复用、`by` 进链、`ref` 可指向审计记录 | `by`/`id` 的**真实性**——内核把 `by` 当不透明字符串记账，**无法验证提交者是谁**。`id` 是**标签不是认证** | 上层审核 / 宿主认证 |
| 内容合法性 | `commit` 机械校验（形态/引用/位置/不变量） | "**改得对不对、该不该采纳**"——判决只是 `ok/reasons`，是"合不合法"不是"好不好" | 上层审核（正当性判定，§3） |
| 效果执行 | `eff.id = H({run,i,n})` 确定性身份、`EffRequest`/`EffResult` 都是可审计的数据纸 | `EffResult` 的**内容可信度**：端口返回什么，内核**照单回灌**；它不校验 value 是否属实、端口是否越权 | **宿主**——见下"最大信任面" |

**全系统最大的信任面 = 宿主的"效果执行 + `results` 回灌"**。`pending` 交出去、`results` 收回来，中间内核一无所知：宿主可以让某个 `eff.id` 回灌任意 `value`，内核只保证"回灌后世界如何确定地演化"。因此把这条写成**宿主的显式契约**（不是内核职责，但内核的"可复现"承诺依赖它）：

> **宿主必须为每个 `EffRequest → EffResult` 留存配对的审计记录**（谁执行、何时、实际入参、返回/错误），并把该记录 `put` 成 def、经 `request.ref` 指向它（§7）。没有这一步，"世界可追溯"只对**写**成立、对**效果**不成立——而真实世界的副作用恰恰发生在效果侧。内核把 `ref` 原样进 `entryHash`，篡改会被链校验发现；但**留没留、内容真不真，是宿主的责任**。

> **宿主落盘字节保真（与审计契约并列的硬契约）**：`Entry.args` 按存取的字节原样落盘、原样恢复。判据只有一条——**能否逐字节还原**。编解码器（gzip / zstd 字典 / 块级差量；解压后字节相同）**合法**；语义往返（`parse` 后再 `stringify`、按字段重建对象、丢未知字段、键序漂移）**非法**——`argsHash` 对不上时损失的不是某条记录，是**整条链在那个位置断**。差量与压缩因此归存储层，不碰世界语义（§6.1、规模实验 C/G 段）。

一句话给产品：**能机械校验"合法"，不等于能保证"合理"。** 判决与机械校验守护的是"改坏了能退、非法进不来、历史改不掉"，不是"这个进化方向是对的"。后者永远是上层（研究 + 审核）的事。

---

# 第二部分 · 可编码规格

## 5. 交付形态与约定

### 5.1 目录布局（不用 `src/`）

```
packages/kernel/
  package.json          name: "kernel"（占位，private: true）
  tsconfig.json
  vitest.config.ts
  .prettierrc
  README.md             包说明：职责 / 依赖 / 用法
  index.ts              导出面（只 export，无逻辑）
  types.ts              共用类型（纯类型，避免互相 import 成环）
  value.ts              JSON 值 / 类型格 / canonicalJson / deepEq
  value.test.ts
  hash.ts               utf8 + sha256 + H()
  hash.test.ts          含 4 条已知 sha256 向量（就地，不另建共享夹具）
  journal.ts            EMPTY_WORLD / EMPTY_HEAD / cloneWorld / pos / worldRev / applyEntry
                        entryHash / anchorAfter / replay / verify
  journal.test.ts
  commit.ts             commit / validate / entryOf / stale（唯一写口）
  commit.test.ts
  machine.ts            eval / cmp + 8 个原语小函数
  machine.test.ts
  run.ts                编排：输入 → 输出（含 observationsOf）
  run.test.ts
  invariants.test.ts    第 14 节的 16 条不变量（跨模块）
```

**测试与被测文件同目录**（`coding-standard.md` §7.2），不建 `test/` 子目录，也不镜像路径。`*.test.ts` 由评审写（§5.4），实现者的提交里不含它们。`index.ts` **从 P0 起就存在**，每批追加本批的导出（口径见 §5.4）。

#### 为什么是**平层**（有意不建子目录）

内核的文件集合是**概念的闭集**：4 个机制（M1–M4）+ 8 个原语，到此为止（§12.1）。于是：

1. **"宽"有上界 = 概念数**，不随业务增长。加文件 = 加概念，必须先过 §2 的名词门与 §12.1 的不可派生门——这个摩擦是**要的**。
2. **平层让 §6 的依赖 DAG 一眼可见**；嵌套会把依赖藏进路径。判据：**分类若能用数据表达，就不要用目录表达**——类型是世界里的一份 def，不是目录名。
3. **行数上限与目录深度无关**：400 行是**每文件**上限。平层的真实含义是"拆文件必须发生在同一层"，即把"该不该拆"变成一次显式选择，而不是把东西塞进子目录藏起来。

每文件预算（防止"某个文件注定超 400"）：

| 文件 | 预算 | 超了怎么办 |
|---|---|---|
| `types.ts` | ≤ 120 | 只放类型，超了说明类型里混了逻辑 |
| `value.ts` / `hash.ts` | ≤ 150 | `hash.ts` 的常量与 utf8 已占大半，超了拆 `hash.*.ts` |
| `journal.ts` | ≤ 300 | 拆 `journal.apply.ts` / `journal.verify.ts`（仍平层，点分段命名） |
| `commit.ts` | ≤ 250 | 同上 |
| `machine.ts` | ≤ 400 | **大概率需要**：拆 `machine.prims.ts`（8 个原语各一函数 + 分派表） |
| `run.ts` | ≤ 250 | 同上 |
| `index.ts` | ≤ 40 | 只 re-export，超了说明有逻辑漏进来 |
| `*.test.ts` | ≤ 500 | 拆 `*.a.test.ts`（`invariants.test.ts` 最可能超） |

**结论：平层合适，且"广"是它的代价也是它的护栏。** 变宽发生在你**主动命名一个新概念**的时候；变深则会让你在没命名概念的情况下藏住耦合。若哪天真的需要 `machine/` 这样的子目录，那说明原语数量已经变了——那是内核概念的变更，先改本文件，再改目录。

### 5.2 工具链白名单（最保证能用的一套）

| 位置 | 允许 |
|---|---|
| 运行时（`*.ts`，非 `*.test.ts`） | **零 import**——只允许指向本包内文件的相对路径 |
| 测试期（`*.test.ts`） | `vitest` 的 `describe` / `it` / `expect` |
| devDeps | **仅 `typescript` + `vitest` + `prettier`**（不进运行时，与零第三方口径不冲突） |

选 vitest：TS + ESM 零构建直接跑，是对 TS 项目最不需要额外配置的工具链。内核是纯函数，测试不需要快照、mock、环境模拟。

**编码纪律**（对齐 `coding-standard.md`）：

| 项 | 取值 |
|---|---|
| 缩进 / 换行 / 编码 | 2 空格、文件末尾一个换行、UTF-8、禁 Tab |
| 行宽 | 100 |
| 格式化 | **Prettier 统一，禁止人工对齐**；`npx prettier --check .` 进验收 |
| 单函数 | ≤ 50 行 → `eval` 必须按原语拆成小函数（见 §12.3） |
| 单文件 | ≤ 400 行（`*.test.ts` ≤ 500；逐文件预算见 §5.1） |
| 参数 | ≤ 4 个（超出封装为对象） |
| 导出 | 公共 API 必须有 JSDoc（功能 / 参数 / 返回 / 错误） |
| 命名 | 函数含动词；布尔以 `is` / `has` / `can` 开头；禁 `data` / `info` / `temp` / `obj` 这类无意义词 |
| 不可变 | `const` 优先、只读字段优先 |
| 注释 | 只写"为什么"；禁留被注释掉的代码 |

### 5.3 五处设计决定

| # | 决定 | 理由 |
|---|---|---|
| D1 | **两把身份分开**：位置 `pos`（链头哈希，O(1)）用于并发与链完整性；内容 `wrev = H({defs 的键集, ids 内容摘要})`（O(defs)）用于快照锚点与跨世界比较，**按需算**。摘要只吃 `schema` / `active` / 各 gen 的内容哈希，**不吃 `born` / `adopted` 履历**（定义见 §10.1"两个身份的分工"） | 内容哈希必须覆盖语义，但把它挂在每次写入上会退化成 O(世界)/条。拆开后写入只碰 O(1) 的 `pos`。`wrev` 用键集而非序列化 body：键本身就是 `H(Def)`，语义等价、成本降一个量级。摘除履历字段：否则同内容同 `active` 而采纳历史不同的世界锚点不同，pin 无端漂移。都不做可达闭包——闭包要求内核认识 body 里的引用标记 = 认识语义（§0.4 规矩 A 使"上层沿 pins 算闭包、不解析 body"成为可能，内核仍不提供该算法） |
| D2 | **不捕获续体**：效果结果由输入回灌，从入口重跑 | 确定性重跑本身就是复现；捕获续体要序列化求值栈，复杂且易错 |
| D3 | **`eff_id = H({run, i, n})`**：`i` = directive 序号，`n` = 该次求值内的效果序号 | 需要一个确定性的效果身份才能把结果对上号。只带 `n` 会在同一次调用内多次求值时碰撞，所以必须带上 `i` |
| D4 | **错误一律抛 `KernelError{ code }`**，只在 `run` 的边界 catch 并转成 `refused(reasons)` | 内层（`canonicalJson` / `H` / `t` / `walk` / `eval`）返回类型保持干净（`string` / `Hash` / `Json`），不必层层解包 `Result`；错误码表就是 §12.5 与各节边界表，测试用 `toThrow` 断言 `code` |
| D5 | **链哈希是 Merkle 的**：`Entry` 带 `argsHash`，`entryHash` 只吃它（O(1)）；`put` 的 `argsHash` = def 键，`batch` 的 = 子哈希聚合 | 优化前同一条 entry 会把载荷规范化 2–4 次（def 键、覆盖 `args` 的 entryHash、`adopted.write`、run 的 head + obs），`batch` 的 entry 哈希还是 O(总字节)。拆开后写入只规范化一次、`batch` 降成 O(子操作数)；代价是 `Entry` 多一个字段，且 `verify` 要补一查 `argsHash`（冷路径付）——**防篡改不降级，反而多抓一种篡改**（§10.1） |

### 5.4 分工：实现者不写测试，测试由评审写

| 角色 | 交付物 | 不做什么 |
|---|---|---|
| **实现者** | 非 `*.test.ts` 的实现文件；`npx tsc --noEmit` 零错误、`npx prettier --check .` 零差异、文件与函数行数达标 | **不写测试**；不改测试；不为测试加导出或开关 |
| **评审者** | `*.test.ts`（§8.6 / §9.6 / §10.5 / §11.4 / §12.6 / §13.3 的清单 + §14 的 16 条不变量） | 不改实现；不迁就实现放宽断言 |

测试是**评审的产物与证据**，不是实现者的自证。三条硬后果：

1. **测试只能打公共面**：评审只从 `index.ts` 导入，而 `index.ts` 的导出面 = §5.1 清单里各文件职责列出的导出（§7 全部类型、§8.1、§9.1、§10.1、§11.1、§12 的 `eval` / `cmp`、§13 的 `run` / `observationsOf`）。**加导出 = 改本文件**；多一个（为测试开后门）或少一个（评审写不出断言）都是缺口。
   - 推论：内部函数（`walk` / `substitute` / `argsHashOf` / `evalCall` / 8 个原语小函数）**只能经公共面间接验收**——`walk` 走 `eval` 的 `'g'`、`substitute` 与 `argsHashOf` 走 `batch` / `verify`、`evalCall` 走 `call` / `fold`。所以 §17 / §18 / §12.3 的边界表必须都能被公共面触发；触发不了的条目就是规格缺口。
2. **实现者不得改测试**：测试失败时，改实现或改本规格，不改断言。规格若被判为"写不出断言"，那是规格缺口，回填本文件。
3. **规格必须写到可判对错**：本文件各节的边界表 / 错误码 / 伪代码就是评审的取材面。凡"影响可观察契约的实现选择"的地方，一律先在本文写死（例如 §8.2 的判定顺序、§12.3 的 `if` 真值、§10.2 的 `isNoop`）。

对 §15 的后果：每批判据分两列——**实现方判据**（编译 / 格式化 / 行数 / 静态扫描）与**评审方判据**（测试与不变量全绿）。"绿"由评审跑出，实现者不能自评。

---

## 6. 依赖顺序与文件职责

```
依赖表就是 DAG，不再画会歧义的箭头图：

  value   ← types
  hash    ← types, value
  journal ← types, hash          （world 的 apply / 链 / 校验 + batch 的 substitute / argsHashOf）
  commit  ← types, hash, journal （不依赖 machine）
  machine ← types, value, hash   （不依赖 journal / commit）
  run     ← 以上全部             （唯一调用 commit 的地方）
  index   ← run 与公共面
```

`machine.ts` 与 `journal.ts` / `commit.ts` 之间**没有任何边**——旧图的 `┘` 曾把依赖画反，§14-4 / 计数桩断言依赖本 DAG，不许再含糊。

| 文件 | 只依赖 | 职责 |
|---|---|---|
| `types.ts` | 无 | 全部类型定义 |
| `value.ts` | types | 值模型 + 类型格 + 规范序列化 + 结构相等 |
| `hash.ts` | types, value | utf8 + sha256 + `H()` |
| `journal.ts` | types, hash | `EMPTY_WORLD` / `EMPTY_HEAD` / `cloneWorld` / `pos` / `worldRev` / `applyEntry`（第三参 `adoptedBy?`；batch 内部含 `substitute` / `argsHashOf`）/ `anchorAfter` / `replay` / `verify` / `entryHash` |
| `commit.ts` | types, hash, journal | `commit`（唯一写口）/ `validate` / `entryOf` / `stale` |
| `machine.ts` | types, value, hash | `eval`（含 `walk`）/ `cmp` |
| `run.ts` | 全部 | 编排一次输入 → 一条输出（含 `observationsOf`）；唯一调用 `commit` 的地方 |
| `index.ts` | 全部 | 只 re-export；导出面见 §5.4 第 1 条，按批追加 |

---

## 7. `types.ts`

```ts
// ── 值 ────────────────────────────────────────────────
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Hash = string            // 64 个十六进制字符（sha256 全长 256 bit，不截断，见 §9.5）
export type Path = (string | number)[]

// ── 世界 ──────────────────────────────────────────────
export interface Def {
  body: Json
  pins?: Record<string, Hash>        // 结构性依赖唯一记录处（§0.4 规矩 A）；名不透明：内核不解释（§11.2②）
  sig?: Hash
}
// Def 就是 put 的载荷本身：`put.args: Def`，`defs[H(Def)] = Def`。
// 键覆盖 body + pins + sig（不是 H(body)），否则改 pin / sig 不动 worldRev（§10.1、§14-9）。

export interface Gen {
  seq: number                        // 从 0 起，严格 +1；由内核分配，不由写请求提交
  payload: Hash
  pins: Record<string, Hash>
  sig: Hash
  adopted: { at: number; by: string; write: string }
                                     // at = 该 Entry.at，by = 该 Entry.by
                                     // write = 完成本次采纳的那条 entry 的位置：普通 add_gen = 自身的
                                     // entryHash；batch 内 = 外层 batch entry 的 entryHash（两段式，§10.3）
  graft?: { from: string; gen: number }
                                     // from = 来源**身份 id**（不是 Hash）；gen = 该身份 gens 下标
}

export interface Identity {
  id: string
  schema: Hash
  gens: Gen[]
  active: Hash | null                // null = retired
  born: { at: number; by: string; parent?: string }
                                     // at/by 同上；parent = 父**身份 id**（fork 专用）
}

export interface World {
  defs: Record<Hash, Def>
  ids: Record<string, Identity>
}

// ── 链位置 ────────────────────────────────────────────
export interface Head {
  seq: number                        // 最后一条 entry 的 seq；空世界 = -1（见 EMPTY_HEAD）
  hash: Hash | null                  // 最后一条 entry 的 entryHash；空世界 = null
}

export interface Anchor {
  world: World
  head: Head                         // 校验起点；与 KernelInput.head 同形（见 §20）
}

// ── 日志 ──────────────────────────────────────────────
export type Op =
  | 'put' | 'add_identity' | 'add_gen' | 'set_active'
  | 'retire' | 'fork' | 'graft' | 'batch' | 'note' | 'snapshot'

export interface Entry {
  seq: number
  prev: Hash | null
  op: Op
  args: Json                         // 该 op 的全部参数（batch 里保留占位符，替换是确定性的）
  argsHash: Hash                     // 本条 args 的内容哈希（按 op 口径，§10.1）。**输出位**：
                                     // entryOf 构造时留空，由 commit 从 applyEntry 的返回值回填（全库唯一回填点）；
                                     // applyEntry / entryHash / verify / replay 一律不改传入的 Entry，
                                     // 故 entryHash(e) 只对 argsHash 已定的 e 有意义（回填后，或读已落盘 entry）
  by: string                         // 谁提的（溯源，内核不据此判定）
  ref?: Hash                         // 指向世界里的审计记录（上层写的，内核不解释）
  at: number                         // 时间戳，来自 KernelInput.now；entryHash 覆盖它 ⇒ 可重放
}

// ── 写请求 ────────────────────────────────────────────
export interface WriteRequest {
  id: string
  op: Op
  target: { expect_pos: Hash | null } // 位置身份（O(1) 校验）；空世界的 head.hash = null，故可空
  args: Json                         // 形状逐 op 见 §11.2；put.args 就是 Def 本身
  ref?: Hash                         // 审计记录（世界里的一条 def），进 entryHash
  by: string                         // 仅供溯源，内核不据此判定
}
// `id` 是上层给这条请求的身份（去重 / 审计用）；内核不据此判定，也不进 `entryHash`。

// ── 效果 ──────────────────────────────────────────────
export interface EffRequest {
  id: Hash                           // = H({run, i, n})
  port: string
  method: string
  args: Json
  caps: Record<string, boolean>      // 恒等于输入的能力表
}
export interface EffResult { ok: boolean; value?: Json; error?: string }

// ── 入口 / 出口 ───────────────────────────────────────
export type Directive =
  | { kind: 'eval';   entry: Hash; args: Json; ctx: Json }
  | { kind: 'extern'; payload: Json }
  | { kind: 'write';  request: WriteRequest }

export interface KernelInput {
  world: World
  head: Head                         // 日志链头；内核据此续链（seq 与 prev）。空世界 = EMPTY_HEAD
  run: string                        // run_id，同一逻辑执行内不变
  directives: Directive[]
  results: Record<Hash, EffResult>   // 已解析的效果结果（不回灌 = 不存在）
  limits: { gas: number; depth: number }
  caps: Record<string, boolean>
  now: number                        // 写入 Entry.at；同一逻辑执行的每次续跑必须传同一值（§13）
}

export interface CommitResult {
  ok: boolean
  reasons: string[]                  // 空 = 无异常；'dup' = 幂等命中，本次不产生 entry（§11.2 G4）；
                                     // ok=false 时携带失败码（单 op 的 §11.2 检查，或 batch 段 2 子操作上浮，§11.1）
  pos: Hash | null                   // 写入后的链位置；无写入时 = 当前 head.hash
  written: Hash[]                    // 本次写入的 def 键
}

export interface CommitOutcome {
  verdict: CommitResult
  entry: Entry | null                // null = 本次不产生日志（幂等命中）
  hash: Hash | null                  // = entryHash(entry)；run 直接复用，不重算（null 时无 entry）
}

export interface KernelOutput {
  world: World
  journal: Entry[]
  head: Head                         // 本次输出对应的链头；refused / waiting / idle 时 === input.head
  pending: EffRequest | null         // 串行求值：最多一个待解效果
  observations: Json[]
  status: 'idle' | 'waiting' | 'done' | 'refused'
  usage: { gas: number; depth: number }
}
```

---

## 8. `value.ts`

### 8.1 导出

```ts
export const TYPE_ORDER = ['Int','Str','Bool','List','Json','None'] as const
export type TypeName = typeof TYPE_ORDER[number]
export function t(v: Json | undefined): TypeName
export function canonicalJson(v: Json | undefined): string
export function deepEq(a: Json | undefined, b: Json | undefined): boolean
```

`t()` 与 `canonicalJson()` 会抛 `KernelError`（§5.3 D4），`deepEq()` 不会——它按同口径比较，任何输入都返回布尔。

### 8.2 `t()` 判定顺序（焊死，不允许实现自行决定）

```
typeof v === 'boolean'      → 'Bool'     ← 必须最先
typeof v === 'number'       → Number.isFinite(v) ? 'Int' : Err('nonfinite')
typeof v === 'string'       → 'Str'
Array.isArray(v)            → 'List'
v === null || undefined     → 'None'
否则                        → 'Json'
```

判定顺序必须焊死的原因：只要有任何实现把布尔当整数子类，顺序不确定就会得出两个结果。**判定必须全序且跨实现一致。**

`'Int'` 只是名字：值域是**全体有限 `number`**（含浮点），不要求整数。非有限数（`NaN` / `±Infinity`）在进入值域前就被拒（`Err('nonfinite')`），与 §8.4 一致——因此 `cmp` / `if` 拿到的 `Int` 一定是有限数。

### 8.3 `canonicalJson()` 伪代码

```
fun canon(v, depth):
  if depth > 64: Err('depth')
  match v:
    undefined → Err('undefined')
    null      → "null"
    boolean   → v ? "true" : "false"
    number    → if !Number.isFinite(v): Err('nonfinite')
                n = (v === 0) ? 0 : v          // 归一 -0 → 0
                str(n)                          // JS 的 number→string 即最短往返表示
    string    → JSON.stringify(v)               // 标准转义
    array     → "[" + v.map(canon, depth+1).join(",") + "]"
    object    → keys = Object.keys(v).filter(k => v[k] !== undefined).sort()   // code-unit 升序
                "{" + keys.map(k => JSON.stringify(k)+":"+canon(v[k],depth+1)).join(",") + "}"
```

### 8.4 边界表

| 输入 | 期望 |
|---|---|
| `undefined`（顶层） | `Err('undefined')` |
| `{a:undefined, b:1}` | `{"b":1}`（键被剔除，不是保留为 null） |
| `-0` | `0`（否则 `H(-0) ≠ H(0)`） |
| `NaN` / `Infinity` | `Err('nonfinite')` |
| `{}` / `[]` | `{}` / `[]` |
| `{b:1,a:2}` | `{"a":2,"b":1}`（与插入顺序无关） |
| 深度 65 的嵌套 | `Err('depth')` |

### 8.5 `deepEq()`

与 canonical 同口径：Json 只比较非 `undefined` 的键，键集与值都按排序逐对比较；类型不同直接 `false`，不做隐式转换（`true` 与 `1` 不等）。

### 8.6 验收清单（`value.test.ts`，评审写，§5.4）

`t()` 六型各一例 + 顺序敏感例（`true` → Bool，不可为 Int）+ 浮点例（`1.5` → Int）+ `t(NaN)` / `t(Infinity)` → `Err('nonfinite')`；边界表 7 行；键序无关性（洗牌 10 次同值）；`deepEq` 正反例（含 `{a:undefined,b:1}` vs `{b:1}` → true）。

---

## 9. `hash.ts`

### 9.1 导出

```ts
export function utf8(s: string): Uint8Array
export function sha256(bytes: Uint8Array): Uint8Array    // 32 字节
export function H(v: Json | undefined): Hash
// H = hex(sha256(canonicalJson 的 utf8 字节流))，全 64 个十六进制字符，**不截断**（理由见 §9.5）
```

### 9.2 `utf8()` 伪代码

```
逐 code unit：
  c < 0x80            → 1 字节
  c < 0x800           → 2 字节
  0xD800<=c<=0xDBFF   → 下一个 code unit 必须在 0xDC00..0xDFFF，否则 Err('lone_surrogate')；
                        合成码点 → 4 字节
  0xDC00<=c<=0xDFFF   → Err('lone_surrogate')
  否则                → 3 字节
```

`utf8()` 保留为独立导出（孤立代理这条边界要能被直接测），但 **`H` 不走"先物化整条字节数组"的路径**：canonical 字符流按 code unit 增量喂给 sha256，凑满 512 位块就地压缩，最后统一 pad。省掉一次 O(n) 物化与整段拷贝——大载荷（数据包、genome）上这是主要的内存开销。

### 9.3 `sha256()` 伪代码（FIPS 180-4 逐字可溯；32 位运算全部 `>>> 0` 归一；ROT = 循环右移、SHR = 逻辑右移）

```
h0..h7 = 6a09e667 bb67ae85 3c6ef372 a54ff53a 510e527f 9b05688c 1f83d9ab 5be0cd19
         （= 前 8 个素数平方根小数部分的前 32 位，与 K 表同法可自证）
K[0..63]（= 前 64 个素数立方根小数部分的前 32 位，测试里可现推自证）：
  428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5
  d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174
  e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da
  983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967
  27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85
  a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070
  19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3
  748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2
pad: 追加 0x80，补 0 至 len ≡ 56 (mod 64)，追加 64 位大端 bit 长度
每 512 位块：
  W[0..15] = 块内 16 个大端 32 位字
  W[i] = (ROT17(W[i-2]) ^ ROT19(W[i-2]) ^ SHR10(W[i-2])) + W[i-7]
       + (ROT7(W[i-15])  ^ ROT18(W[i-15])  ^ SHR3(W[i-15]))  + W[i-16]   // i = 16..63
  a..h = h0..h7
  for i in 0..63:
    S1  = ROT6(e) ^ ROT11(e) ^ ROT25(e)
    ch  = (e & f) ^ (~e & g)
    t1  = (h + S1 + ch + K[i] + W[i]) >>> 0
    S0  = ROT2(a) ^ ROT13(a) ^ ROT22(a)
    maj = (a & b) ^ (a & c) ^ (b & c)
    t2  = (S0 + maj) >>> 0
    h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0
  h0..h7 = (h + 对应字) >>> 0
输出 h0..h7 大端拼接 32 字节
```

实现按**增量压缩**写：每凑满 512 位块立刻喂进压缩函数，只在收尾做一次 pad。`sha256(bytes)` 仍接受完整缓冲（§9.4 的四个自证向量用它直接断言），`H` 走增量入口。

### 9.4 测试向量（就地写在 `hash.test.ts`，自证，不需外部依赖）

| 输入 | sha256 hex（64 字符，取全串） |
|---|---|
| `""` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `"abc"` | `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` |
| `"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"`（56 字节） | `248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1` |
| 1,000,000 个 `"a"` | `cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0` |

> 第 3 向量正好跨过一个 512 位块（56 字节 + pad 进第二块），是增量/整段两口径的边界自证。

### 9.5 边界

孤立代理 `"\uD800"` → `Err('lone_surrogate')`。`H` 取 sha256 **全 32 字节（256 bit / 64 个十六进制字符），不截断**：`pos` 与 `worldRev`、一切内容 def 的键、pin、sig 都压在这把哈希上——碰撞直接击穿"id 永不复用"与"内容寻址"两条地基不变量。sha1 已被实用碰撞攻击攻破，生日界对长期 append-only 的世界太窄；截短又零收益（都是定长串），故不留截断。**换窄换宽都只动 `H` 一处——但那要作为整条链格式的变更走 §22 的"换哈希"裁决**。

### 9.6 验收清单（`hash.test.ts`，评审写，§5.4）

四个向量断言全串（各 64 字符）+ utf8 的 1/2/3/4 字节各一例 + 孤立代理报错 + `H({})` 两次同值；**流式路径与两段式等价**：`H(v)` === `hex(sha256(utf8(canonicalJson(v))))`（大载荷、跨 512 位块边界各一例）。

---

## 10. `journal.ts`

### 10.1 导出

```ts
export const EMPTY_WORLD: World
export const EMPTY_HEAD: Head                           // { seq: -1, hash: null }
export function cloneWorld(w: World): World             // 独占副本（供别名契约）
export function pos(entries: Entry[]): Hash | null      // 链位置 = 末条 entryHash
export function worldRev(world: World): Hash            // H({ keys, ids 内容摘要 })，keys = defs 的键按 code-unit 升序；
                                                        // 摘要定义见"两个身份的分工"；按需算
export function applyEntry(w: World, e: Entry, adoptedBy?: Hash):
  { ok: true; world: World; isNoop: boolean; argsHash: Hash; written: Hash[] }
  | { ok: false; error: string }    // 只改 w（独占副本，就地）；**绝不修改 e**；adoptedBy 仅 batch 内
                                     // add_gen/graft 的 adopted.write 用（§10.3）
export function replay(entries: Entry[], from?: World): World          // 只重建，不校验链；from 缺省 = EMPTY_WORLD
export function verify(entries: Entry[], anchor?: Anchor,
                       expected?: { hashes?: Hash[]; worldRev?: Hash }): { ok: boolean; error?: string }
                                                        // **不抛**：一切失败转返回码——含链内 snapshot 自校
                                                        // 失败的 world_rev_mismatch（§10.4；replay 保持抛，契约不同）
export function entryHash(e: Entry): Hash               // H({at, seq, prev, op, argsHash, by, ref}) —— O(1)；
                                                        // 前提：e.argsHash 已定（commit 回填后，或已落盘 entry）
export function anchorAfter(world: World, e: Entry): Anchor   // { world, head: { seq: e.seq, hash: entryHash(e) } }
```

**`replay` 与 `verify` 的起点不同形**：`replay` 只要世界（它不校验链），`verify` 要**链锚点** `{ world, head }`——把两者混成一个 `from: World` 正是 `prev` 初值被写死成 `null` 的根源。锚点 `head` 与 `KernelInput.head` 同形（`seq` = 该 entry 自身，即"已应用末条的 seq"，`hash` = 其 `entryHash`），任何一条 entry 之后的位置都能给出：`anchorAfter(e) = { world: <应用 e 之后的世界>, head: { seq: e.seq, hash: entryHash(e) } }`——于是 `verify` 从 `anchor.head.seq + 1` / `anchor.head.hash` 起接链（§20），空世界用 `EMPTY_HEAD = {seq:-1, hash:null}` 兜底。

### `argsHash`：链是 Merkle 的（写入不重复规范化）

`entryHash` **不读 `args`**，只吃 `argsHash`。而 `argsHash` 按 op 口径算，**顺手就能拿到**：

| op | `argsHash` | 额外成本 |
|---|---|---|
| `put` | `H(Def)` —— 与 `defs` 的键**是同一个值** | 零（键本来就要算） |
| `batch` | `H({ops: [[op_i, h_i], …]})`，`h_i` = 各子操作的 `argsHash`（`argsHashOf` 纯哈希预计算，两段式段 1，§10.3） | O(子操作数)，不吃总字节 |
| 其它 | `H(args)`（`payload` / `sig` / `pins` / `world_rev` 全是小哈希；`note` 可带留痕载荷，见 §11.2 形状表） | 一次，且只有这一次 |

四条性质：

1. **`entryHash` 恒 O(1)**：于是 head 推进、`pos`、`anchorAfter`、`expected.hashes` 的比较都不再碰载荷字节。
2. **一份 args 只规范化一次**（优化前是 2–4 次：def 键 1 次、`entryHash` 覆盖 `args` 1 次、`adopted.write` 1 次、`run` 的 head 与 obs 各 1 次）。`batch` 的 entry 哈希也从 O(总字节) 降成 O(子操作数)；唯一付 2× 的点是 batch 的子载荷（段 1 预哈希 + 段 2 步①，为 `outerPos` 买的账，见 §10.3 与不变量 14）。
3. **防篡改不降级，反而更强**：`verify` / `replay` 把 `applyEntry` **重算**的 `argsHash` 与 `e.argsHash` 里**存着的**值比对（`e` 不会被 `applyEntry` 覆写——第 4 条），所以"改了 `args` 但不改 `argsHash`"也会被抓（`args_hash_mismatch`）——这是**加出来**的一查（冷路径付），不是省掉的一查。
4. **代价**：`Entry` 多一个字段（内容寻址式冗余，与 `at` 同性质）；`argsHash` 的**口径是链格式的一部分**，改口径 = 改链。`applyEntry` **不改传入的 `e`**——它把 `argsHash` 放进返回值，由 `commit` 回填到自己刚构造的独占 entry（全库唯一回填点）；`add_gen` 内部用 `{...e, argsHash}`（展开覆盖，不改 `e`）计算需要 `argsHash` 的派生值（`adopted.write`）。此边界可冻结断言（不变量 15）。

### 别名契约（性能必需）

`applyEntry` **可以就地修改入参 `w` 并返回同一个对象**（仅限世界；传入的 `Entry` 永不修改，§10.1-4 与不变量 15）；调用方必须保证 `w` 是自己独占的副本。

**`cloneWorld` 只复制"会被就地改写的层"**（不是深拷贝整个世界）：

```ts
cloneWorld(w) = { defs: { ...w.defs },                       // 记录浅拷贝：applyEntry 只新增键，不改写已有 Def
                  ids: mapValues(w.ids, id => ({ ...id,       // Identity 会被改写（active / born）
                                                 gens: [...id.gens] })) }  // gens 数组会被 push
```

- **`Def` 与 `Gen` 元素按不可变共享**：`applyEntry` 从不改写已存在的 `Def` / `Gen` 对象（`put` 只新增键，`add_gen` 只 push 新对象）。这条是上面这份浅拷贝成立的前提，也是"每次调用只付 O(#ids + Σgens)、不付 O(世界字节)"的原因。
- **写入世界的对象从此刻起视为不可变**：`put` 把 `req.args` 原样存进 `defs`（不复制——复制就破 O(1)），所以调用方此后不得再改它。
- 于是 `run` / `replay` 的整体成本是 **`cloneWorld` 一次 + 每条 entry O(1)**，而不是每条 entry 复制一遍世界——`{...defs, [k]:v}` 是 O(def 数)，那才是真正的瓶颈（比哈希计算更贵）。

- `replay` / `verify` 内部自己 `cloneWorld`，对调用方仍然是纯的；
- `run` 在入口 `cloneWorld` 一次，之后就地应用；`commit` 拿到的也是调用方独占的副本，遵守同一契约；
- **`applyEntry` 只认同一个调用者：每条**在链的** entry 恰好被应用一次**（`run` 经 `commit`）——`entryOf` 只构造 entry，**不**应用；batch 内部对**合成子 entry** 的递归应用不算"在链的 entry"，不违此约（§10.3）；合成子 entry 同样不落链、不可被任何位置身份引用；
- 失败时（`ok:false`）必须保证世界可丢弃（调用方用副本，不留半成品）。

`applyEntry` 需要的信息全部可从 `Entry` 自身推出：`at` / `by` 直读，`write` 由 `Entry`（`seq` / `prev` / `op` / `argsHash`…）与批内 `adoptedBy` 确定性派生（§10.2），因此 `replay` 与 `run` 得到逐字段相同的世界（§14-1）。

### 两个身份的分工

| 身份 | 定义 | 成本 | 用途 |
|---|---|---|---|
| `pos` | 链头哈希 = `entryHash(末条)` | **O(1)** | 乐观并发（`expect_pos`）、链完整性 |
| `worldRev` | `H({ keys, ids 摘要 })`，`keys` = `Object.keys(defs)` 按 **code-unit 升序**（与 §8.3 的键排序同口径）；`ids 摘要` 定义见下引 | O(def 数) | 快照锚点、跨世界内容比较、数据 pin —— **按需算，不挂在每条 entry 上** |

> `keys` 是**数组**，而 `canonicalJson` 只对对象的键排序、**保持数组元素序**不变——所以这个升序必须由 `worldRev` 自己定死（跨实现的唯一可比器）。`ids` 是对象，它的键序由 `canonicalJson` 负责。

> `worldRev` 只吃 `defs` 的**键**、不吃 body：键本身就是 `H(Def)`（内容寻址的地基），所以键集 ⟺ 内容集，但代价从"序列化整个世界"降到"排序键"。
>
> `ids` 进摘要时**不是裸对象**：每个身份取 `{ id, schema, active, gens: [{seq, payload, pins, sig, graft?}, …] }`——**不吃 `born` / `adopted`**。"何时、谁、哪条 entry 采纳"是履历，归链管（§10.6）；吃进锚点会让**同内容同 active 而历史不同**的两个世界 `worldRev` 不同，pin 它们的内容会无端漂移。`active` 要吃：换 active 就是换世界状态。此摘要是**函数内构造的派生对象**，绝不回写世界。
>
> `Entry` **不再携带世界版本**：链校验由 `entryHash` 链 + `applyEntry` 成功 + 段末 `worldRev` 锚点三查完成，不必每条 entry 都算一次内容哈希。

### 10.2 `applyEntry` 逐 op

所有 op 的**语义**是纯的（改完得到新世界）；实现上遵守 §10.1 的别名契约——可以就地修改**独占副本**。约束只有一条：失败时不得留下半成品。单 op 的检查都发生在改动之前，因此天然满足；`batch` 多子操作，用局部 `undo` 回滚（§10.3），所以**失败后调用方的世界逐字节不变**（不变量 11）。

`applyEntry` 的固定三步：**① 先算 `argsHash`（按 op 口径，§10.1；batch 为"段 1 预哈希"，§10.3）——只计算，不回写、不触碰传入的 `e`；② 做该 op 的改动；③ 返回 `{ ok, world, isNoop, argsHash, written }`**（`written` = 本次写入的 def 键：`put` 是它自己，`batch` 是各 `put` 子操作）。`add_gen` 的 `adopted.write = adoptedBy ?? entryHash({...e, argsHash})`，所以第 ① 步必须早于 `add_gen`；batch 内 `adoptedBy` = 外层批次的位置（§10.3 段 1 算出）。

```
put:          h = H(args) ; args 本身就是 Def（见 §7）
              argsHash = h                          // 键与 argsHash 是同一个值
              if defs[h] 存在 → 幂等命中：无操作，isNoop = true
              else defs[h] = args
add_identity: if ids[id] 存在 → Err('id_taken')
              if !defs[args.schema] → Err('missing_ref')
              born = { at: e.at, by: e.by, parent: args.parent? }
              ids[id] = { id, schema, gens: [], active: null, born }
add_gen:      if !ids[id] → Err('no_identity')
              if !defs[payload] || !defs[sig] → Err('missing_ref')
              seq = ids[id].gens.length            // 内核分配：严格 +1，从 0 起（batch 内同一条款，逐子操作即算）
              adopted = { at: e.at, by: e.by,
                          write: adoptedBy ?? entryHash({...e, argsHash}) }
              gens.push({ seq, payload, pins, sig, adopted, graft? })
              active = payload                      // add_gen 同时激活
set_active:   if !ids[id] → Err('no_identity')
              if args.active !== null 且不在 gens 的 payload 里 → Err('not_a_generation')
              active = args.active                  // null = 退役
retire:       等价 set_active(null)——但两者 op / args / argsHash / entryHash 各不相同，
              是**两条不同的 entry**：世界效果相同，历史绝不折叠（dup 只属于同内容 put）
fork:         add_identity 且 born.parent = args.parent
graft:        add_gen 且带 graft:{from,gen}（from 是身份 id，且该身份的 gen 必须存在）
batch:        见 10.3（段 1 重算子哈希并聚合 argsHash；段 2 逐子应用，adoptedBy = 外层位置；
              所有子操作都 isNoop → isNoop = true）
note:         世界不变，仅留痕（isNoop 恒 false——**故意不去重**：同载荷提交两次是两条 entry；
              "处理过没有"归上层 WriteRequest.id，不归内核）。args 为任意 JSON 对象 = 留痕载荷（② 档，§0.4 规矩 B）
snapshot:     args = { world_rev }；先自校 worldRev(world) === args.world_rev，不符 → Err('world_rev_mismatch')
              世界不变（worldRev 因此不变），但 isNoop 恒 false；快照的位置由该 entry 的 seq / entryHash 唯一确定（见 10.7）
```

非 `put` / `batch` 的 op：`argsHash = H(args)`（一次规范化；`payload` / `sig` / `pins` / `world_rev` 全是小哈希——例外只有 `note` 的留痕载荷：唯一可能带大 args 的非 batch op，换到的是**不进 `defs`**（不克隆、不摘要），**不省哈希时间**——规矩 B，§0.4）。

`at` / `by` 直读 `Entry` 自身，`write` 由 `Entry` + `adoptedBy` 确定性地派生（§10.2 步①），所以 `replay` 与 `run` 得到逐字段相同的世界。

**`isNoop`：这次 entry 有没有构成一次有效写入。** 它把"幂等"从"逐 op 特例"收敛成一条规则，`commit` 只认这一个字段：

| op | `isNoop === true` 的条件 |
|---|---|
| `put` | 内容已存在（幂等命中） |
| `batch` | **所有**子操作都 `isNoop` |
| 其它 | 永不——`note` / `snapshot` 虽不改世界，仍是有效审计写入（照常产生 entry） |

### 10.3 `batch`：原子性与自引用占位符

```
batch(w, args, e, adoptedBy):                    // w = 调用方独占副本（别名契约）；e = 外层 entry，只读；
                                                 //   adoptedBy = 本批嵌套时父层传入的真实位置（顶层批为空）
  // 段 1：纯哈希（不碰世界）。acc0 = 各 put 子操作的 def 键
  acc0 = [] ; hashes = []
  for k, sub of args.ops:
     a2 = substitute(sub.args, acc0, k)      // 返回**新对象**，不回写 args（日志存的永远是替换前 args，§18）
     h = argsHashOf(sub.op, a2)              // 与 §10.1 表同口径：put → H(Def)；嵌套 batch → 递归本函数段 1；
                                             // 其余 → H(args)。坏占位符 → Err('bad_selfref')（世界分文未动）
     hashes.push([sub.op, h])
     acc0.push(sub.op === 'put' ? h : null)  // 只有 put 有产物（= def 键）
  argsHash = H({ ops: hashes })              // 聚合：O(子操作数)，不吃总字节
  outerPos = entryHash({ ...e, argsHash })   // e.seq / e.prev 已在手 ⇒ 外层位置此刻完全确定

  // 段 2：真实应用。失败逆序回滚，世界逐字节不动（不变量 11）
  acc = [] ; undo = [] ; written = [] ; allNoop = true
  for k, sub of args.ops:                    // substitute / argsHashOf 与段 1 逐字同规则，必得同结果
     a2 = substitute(sub.args, acc, k)
     把 sub 将改动的键（defs 键 / ids 键）的旧值记入 undo（新增的键记 `absent`）
     r = applyEntry(w, { seq: e.seq, prev: e.prev, argsHash: 'placeholder', op: sub.op, args: a2,
                         by: e.by, ref: e.ref, at: e.at }, adoptedBy ?? outerPos)   // 合成子 entry：只为复用 op 语义，
                                              // 不落链。adoptedBy 非空 = 本批嵌套在真实外层里，继续沿用它的位置；
                                              // 自己的 outerPos 只在本批就是外层时使用。
                                              // argsHash 占位安全：applyEntry 从不**读**入参的 argsHash（步①只算），
                                              // 批内 add_gen 用 adoptedBy 计算 write，不用它
     if !r.ok → 逆序还原 undo ; return { ok:false, error: r.error }
     if r.argsHash ≠ 段 1 的 h[k] → 实现 bug，当场抛（两段一致性由确定性保证，这行只是护栏）
     allNoop &&= r.isNoop ; written.pushAll(r.written)
     acc.push(sub.op === 'put' ? r.argsHash : null)
  isNoop = allNoop                           // 全幂等 → 整批不算写入
  return { w, argsHash, isNoop, written }    // written = 各 put 子操作的 def 键
```

**为什么要两段**：`Gen.adopted.write` 的语义是"完成采纳的那条 entry 的位置"——batch 内只可能是外层 entry 本身，而外层 `entryHash` 依赖外层 `argsHash`，后者依赖全部子哈希：单趟式里这个先后无解（旧版把批内 `write` 记在**无 `seq`/`prev` 的合成对象**上，指向链上不存在的幻影）。段 1 不碰世界，只做"替换 + 哈希 + 聚合 + 外层定位"；段 2 才应用，并把 `outerPos` 作为 `adoptedBy` 传进子 op 的 `applyEntry`。顺带的收益：哈希性失败（坏形态 / 坏占位符）在**世界分文未动之前**就抛出。

**占位符先替换、再算哈希**（`h_i` 是对**替换后** args 取的），所以 `argsHash` 覆盖真正落地的内容；而 `substitute` 返回新对象、日志里永远存**替换前**的 `args`——替换确定 ⇒ `replay` / `verify` 重算出同一个 `argsHash` 与同一个 `outerPos`（批内 `adopted.write` 随之逐字段复现）。嵌套 batch 的 `adoptedBy` 沿调用链继续传**最外层的真实位置**，杜绝幻影递归。

占位符 `{"$n": k}` 的 `k` 必须是**本批内更早**的子操作，且该子操作必须是 `put`（只有它有产物 = def 键）；越界、前向引用、或指向无产物的子操作 → `Err('bad_selfref')`（段 1 即抛）。子操作共享外层 `Entry` 的 `at` / `by` / `ref`；合成子 entry 连 `seq` / `prev` 都继承外层，但它**不落链、不可被任何位置身份引用**。

**与 `applyEntry` 的接线**：`applyEntry` 遇 `op === 'batch'`，转 `batch(w, e.args, e, adoptedBy)`——步① = 段 1（得 `argsHash`，且当 `adoptedBy` 为空时由它算出本批的 `outerPos`），步② = 段 2（就地改 `w`、失败回滚），然后原样上报 `{ argsHash, isNoop, written }`——没有第二套语义。`argsHash` 的回填只发生在 `commit`（§11.1）；`batch` 与 `applyEntry` 都不改传给它的那个 `e`。因为每批都从日志里**替换前**的 `args` 重新替换，`replay` / `verify` 必然算出与存值一致的 `argsHash`——这也是"改 `args` 不改 `argsHash`"能被抓出来的前提。`argsHashOf` / `substitute` 是内部函数，经 `batch` / `verify` 间接验收（§5.4）。

**dup 短路（全 `put` 批）**：段 1 预哈希后，若**全部**子操作都是 `put` 且全部键已在 `defs`——直接定论 `isNoop = true`、`written = []`，跳过段 2（重试不重付 apply 账；崩溃恢复的常态路径）。边界写死：含任何非 `put`（或嵌套 batch）的批仍走段 2——非 `put` 的 `isNoop` 不由键存在性决定。短路不改任何形态：判决字段与走段 2 的定论逐字段一致、`entry === null`、链哈希无差；段 1 的哈希账不可免（那是 `argsHash`，链格式）。

### 10.4 边界表

| 场景 | 期望 |
|---|---|
| `put` 同内容两次 | 第二次幂等命中：**不产生 entry**，世界与日志都不动（§11.2 G4） |
| `add_identity` 用已存在 id | `Err('id_taken')`（retired 后 id 仍占位） |
| `add_gen` 的 payload 不在 defs | `Err('missing_ref')` |
| `add_gen` 连续两次 | `seq` = 0 然后 1（由内核分配；`args` 里出现 `seq` → `bad_form`） |
| `set_active` 指向非本身份的世代 | `Err('not_a_generation')` |
| `batch` 第 3 个子操作失败 | 整体失败，前 2 个改动不可见 |
| `batch` 索引 0 出现 `{"$n": 1}` | `Err('bad_selfref')`（越界 / 前向引用） |
| `batch` 的子操作全是已存在的 `put` | 整批 `isNoop` → 不产生 entry（同 G4） |
| `batch` 用 `$n` 指向 `add_gen` 子操作 | `Err('bad_selfref')`（**段 1** 即抛，非 `put` 没有产物） |
| `batch` 内 `add_gen` / `graft` | `adopted.write` === **外层 batch entry 的 `entryHash`**（真实链上位置，非幻影；§10.3 两段式） |
| `batch` 内第二个 `add_identity` 撞同一批次第一个新开的 id | 段 2 失败 → 整批逆序回滚，`commit` 转 `id_taken` 拒绝（`validate` 不递归 batch，§11.2） |
| `snapshot` entry | 世界不变（`worldRev` 因此不变）；仅追加一条审计 |
| `snapshot` 的 `world_rev` 与实算不符 | `applyEntry` 抛 `KernelError('world_rev_mismatch')`；`verify`（含 `run` 路径**之外**的一切调用方）由它 **catch 转返回码** → `{ok:false, error:'world_rev_mismatch'}`——verify 自己从不抛；`replay` 保持抛（它的契约就是抛，§10.1 / §19 / §20） |
| 改一条 entry 的 `args` 但不改 `argsHash` | `verify` → `{ok:false, error:'args_hash_mismatch'}`（§10.1 第 3 条） |
| `verify` 遇到 `seq` / `prev` 不接，或传入了 `expected` 但对不上 | `{ok:false, error:'chain_broken'}` |
| `verify` / `replay` 的 `applyEntry` 失败 | `{ok:false, error:'apply_failed'}` / `Err('apply_failed')`（同一个码） |
| `verify(tail, anchorAfter(snapshot))` | 通过——起点来自锚点，不是硬编码的 `null`（§20） |
| `replay(tailEntries, snapshotWorld)` 与 `replay(allEntries)` | 世界逐字段相同、`worldRev` 相同 |

### 10.5 验收清单（`journal.test.ts`，评审写，§5.4）

边界表逐条；`replay(entries)` 与逐步 `applyEntry` 一致且**逐字段**复现（含 `ids` 的 `at` / `by` / `write`）；**`replay(tailEntries, snapshotWorld)` 的 `worldRev` === `replay(allEntries)` 的 `worldRev`**（这条是长链安全的核心断言）；`verify(allEntries)` 正例、`verify(tailEntries, anchorAfter(snap))` 正例、篡改一条 entry 后 `chain_broken`；改 `args` 不改 `argsHash` → `args_hash_mismatch`（前提：`applyEntry` 不覆写存值——**冻结入参断言**，不变量 15）；`entryHash` 的 `prev` 链可校验；`worldRev(EMPTY_WORLD)` 稳定；`batch` 的 `argsHash` 由子哈希聚合（计数桩：聚合只碰子操作数）；**批内 `add_gen` 的 `adopted.write` === 外层 batch entry 的 `entryHash`、普通 `add_gen` 的 === 自身**；`worldRev` 摘要不吃 `born`/`adopted`（同内容同 active、履历不同的两世界摘要相等的构造例）。

本轮新增（T3 / T5 口径，§10.4 / §10.3）：

1. 篡改链中 `snapshot` 的 `world_rev` → `verify` **返回** `{ok:false, error:'world_rev_mismatch'}`（不是抛；`applyEntry` 直测仍抛，两口径各一例）。
2. **`replay(尾段, 错的基础)` 不报错**——把"不保证"写死成断言：例 = 尾段一条 `add_identity` 在真实历史上本该撞 `id_taken` 而被拒，接在一个缺前缀的基础上却成功 ⇒ 产出链上从未被授权的世界；随后 `verify(尾段, anchor)` 用 `chain_broken` 抓出同一构造。
3. 完整三步 `verify([], anchorAfter(基础,快照), {worldRev: 快照.args.world_rev})` → `verify(段, anchorAfter(基础,快照))` → `replay(段, 基础)`，结果与 `full` 逐字段等价（§0.4 规矩 A 的宿主义务）。
4. **全 `put` 幂等批短路**（T5）：计数桩断言同批 `H` 次数从 `2N → N`；短路前后 `verdict`（`ok`/`reasons`/`pos`/`written`）与走段 2 的现实现逐字段一致且 `entry === null`；含非 `put` 的混合批不短路。

### 10.6 日志就是那条链（内核没有"补丁链"这个概念）

| 上层概念 | 内核里的形态 |
|---|---|
| 补丁链 | **就是 `journal`**：append-only + `prev` 哈希链 |
| 一个补丁 | 一条 `Entry`（由 `WriteRequest` 产生） |
| 审批态（pending / approved / rejected） | 不在内核，在上层 |
| 回滚补丁 | **追加一条 `Entry`**（`set_active` 指回旧世代），不是删节点 |
| 分支（"一条线"） | **身份**，不是链上的一段：一条线 = `add_identity` / `fork`；线的一次状态 = `add_gen`（payload 指向那一刻的全量内容）；"哪条线为真" = `set_active` |
| 编辑重放（"截断 + 新分支"） | 表达为：从被编辑的世代 `add_gen` 新 payload + `set_active` 指过去——**旧线仍在链上，只是不再被取用**。**真截断禁止**（删尾部 = 改历史 = 弃三承诺之一，不能既要又要）。行级归属用 `Entry.ref` 约定：宿主让它指向"这条线"的 def（§7），**分组过滤在宿主，内核不解释**——挪到这格反而更强：旧线可审计，且旧线上已真实执行的效果有据可查，重放不会把已花掉的钱、已发出的请求再花一遍（§12.4 幂等端口缓存） |
| 补丁的 kind 枚举 | 不存在——业务种类是上层对日志的**过滤视图** |

**删除在内核里根本不存在**，所以回滚可逆、可重放、可对照。审计闭环靠三个字段：`Entry.at`（何时）+ `Entry.by`（谁提的）+ `Entry.ref`（指向世界里上层写的审计记录，内核不解释其内容）——三者都进 `entryHash`，所以改任何一个都会被链校验发现。

**内核没有 `compact` 这个 op，也不欠一个**：所谓压缩就是 §10.7 的 ①（追加 `snapshot`）+ ②（宿主归档），回收就是 §10.7 的 ③（上层重建新世界）——三层全用已定稿的 op 表达，没有"之后再做"的第四种动作。

### 10.7 长链怎么办：追加新 base，永不删除

**压缩 = 追加一个新 base（快照），不是丢旧段。** 三层，全是"追加"：

| 层 | 动作 | 谁来做 | 删东西吗 |
|---|---|---|---|
| ① 快照 | 追加一条 `op:'snapshot'` entry（`args = {world_rev}`，位置由该 entry 的 `seq` / `entryHash` 唯一确定）；世界本体由宿主保存 | 宿主决定时机；内核只提供 op | 不删 |
| ② 归档 | 宿主把快照 entry 之前的段（`[0..snap.seq]`）移到冷存储 | 宿主 | 不删（只是移出热路径） |
| ③ 重建（很晚才需要） | 上层把要保留的内容重新写入一个**新世界**；旧世界原样保留 | 上层 | **不删**——内核没有删除 |

四条支撑性质（内核提供，可测）：

1. **`replay(entries, from?)` 起点可参数化**：日常从最近快照起（快），审计从空世界起（慢但完整）。**历史没丢，所以完整重放永远可行**——这就是"不能删除"的兑现方式。
2. **段可独立校验**：`verify(entries, anchor, expected)` 查 `seq` 连续、`prev` 接得上、`entryHash` 与清单一致、`applyEntry` 成功，并在段末用可选的 `worldRev` 锚点核对——不必重放全链。归档段因此可以离开热路径还不失可审计。
3. **写入不碰内容哈希**：`Entry` 不带世界版本，`entryOf` 只做 O(1) 的接链；`worldRev` 只在快照 / 跨世界比较时算一次。这是把 O(世界)/条 从热路径上摘掉的关键。
4. **内核没有删除**：`defs` 只增，重复内容靠内容寻址自动去重；体积压力靠 ① ② 控制**热路径**，不靠删。真要缩小世界，做法是**上层重建一个新世界**（把要保留的内容经正常写入搬过去），旧世界与旧日志原样保留。

**内核不排程**：何时快照、每多少条一次、热稳多久——都是宿主的策略。内核只提供 `snapshot` 这个 op 和可参数化的 `replay` / `verify`。`worldRev` 是 O(def 数)——这恰恰要求快照是**宿主显式发起的一次写入**（走唯一写口 `commit`，与普通写同路），而不是内核里若隐若现的背景计算；"按需"的含义就是：不算的时候零成本，算的时候只在快照点。

### 归档协议（写死在任何验收开工之前；节拍参数留给宿主）

1. **边界 = 一条 `snapshot` entry**：`args = {world_rev}`，取值 = 该批全部前序 entry 应用完之后世界的 `worldRev`（`applyEntry` 步②自校，不符即 `world_rev_mismatch`——快照想锚歪都锚不了）。世界本体由宿主随这条 entry 一起落盘。
2. **锚点即协议里的"边界凭证"**：`anchorAfter(snap) = { world: snapWorld, head: { seq: snap.seq, hash: entryHash(snap) } }`（与 `KernelInput.head` 同形，§10.1）。热段启动 = `verify(hotEntries, 锚点)`；`expected.hashes` 可整体取 `entries.map(entryHash)` 另附。
3. **段的独立性**：归档段 `[a..b]` 失热后仍要审计 = `verify(段, anchorAfter(seq a-1 的 entry), expected?)`——每段自带起点与终点哈希，"没删东西"的承诺由锚点兑现，不靠热路径全量在场。
4. **冷启动顺序**：取最近快照的世界与 entry 位置 → 用 (2) 校验热段 → `replay(hotEntries, snapWorld)` 得当前世界；任一步红 = 宿主存储被改或节拍有 bug，拒绝挂载（内核不猜）。
5. 快照频率、保留份数、冷存储分层 = **宿主 manifest 的参数，不是内核常量**；本文件只锁协议，不锁节拍。
6. **归档时的保留集** = 尾段引用集（热段各 op 的 `args` 里内核认识的 Hash 字段之并：`payload` / `sig` / `pins.*` / `schema` / `ref`）**∪ 快照世界各 active 世代的闭包**——沿 `pins` / `payload` / `sig` / `schema` 遍历即得（规矩 A 保证结构依赖都在 pins，不在 body）。移出 ≠ 删除：冷存照常持有，按第 3 条随时可取回核算。

---

## 11. `commit.ts`

### 11.1 导出

```ts
export function validate(head: Head, world: World, req: WriteRequest): CommitResult
export function entryOf(head: Head, req: WriteRequest, now: number): Entry
export function commit(head: Head, world: World, req: WriteRequest, now: number): CommitOutcome
export function stale(def: Def, world: World, identityId: string): boolean
```

**`commit` 是唯一写口**，也是唯一会改世界的入口：内部依次 `validate` → `entryOf` → `applyEntry`（**恰好一次**，遵守 §10.1 的别名契约；`applyEntry` 不修改传入的 `e`），随后 **`commit` 把返回的 `argsHash` 回填进自己独占的 `e`**——全库唯一对 Entry 的回填点——再 `hash = entryHash(e)`（O(1)）返回给 `run` 复用。`entryOf` 只构造 entry、不碰世界。`applyEntry` 返回 `ok:false` **只在 batch 内部子操作失败时可达**（`validate` 对单 op 先做了全部对应检查，且不递归 batch——§11.2）：此时 `commit` 不得断言，而是转 `verdict = { ok:false, reasons:[error] }`、`entry = null`、`hash = null`——批内失败已被 undo 回滚，世界分文未动（不变量 11、§16）。`validate` 单独导出，供上层做不需要写入的预检。

### 11.2 `validate` 四步

```
① 形态    op ∈ Op；expect_pos 是 **64** 位 hex **或 null**（空世界）；args 符合该 op 形状  → 'bad_form'
② 引用    【内核认识的字段】里的每个 Hash 必须已在 defs：
          add_identity.schema · add_gen.payload · add_gen.sig · add_gen.pins.* 的值 ·
          put.args.sig · put.args.pins.* 的值 · request.ref
           （body 内部的引用内核认不出来，由上层负责——注意这是内核的**能力边界**，不是上层的**许可**：
            规矩 A（§0.4）把结构性依赖唯一记录处定死在 pins，漏写内核不拒、stale 静默失效，门禁归上层数据；
            身份引用 graft.from / born.parent 不是 Hash，走 G3 查 ids，不查 defs）→ 'missing_ref'
③ 位置    expect_pos === head.hash                                       → 'pos_conflict'
④ 不变量  G1–G3                                                          → 见下表
→ 全过：返回 verdict（`written` = 本次写入的 def 键，**不算 `worldRev`**）；
  defs / ids 的更新由 `commit` 调 `applyEntry` 完成，`validate` 自己不改世界。
  **batch 不递归查子操作**：批内子 op 的引用 / id 类失败在段 2 apply 时由 applyEntry 报出，
  整批回滚、`commit` 转拒绝（§10.3、§11.1、§16）——所以 validate 通过 ≠ applyEntry 必成功，
  仅对非 batch 的 op 两者等价。
```

**幂等不在 `validate` 里判**（`validate` 看不到 apply 的结果，也就无从知道内容是否已存在）：`commit` 在 `applyEntry` 之后按 `isNoop` 定论——`isNoop === true` → `ok:true, reasons:['dup']`，**不产生 entry**（世界与日志都不动）。`put` 命中已存在键、`batch` 全部子操作都是幂等命中，都落进这一条（§10.2）。

**`args` 形状表**（日志只存 `args`，所以 op 的全部参数都在 `args`，`WriteRequest.target` 只承载 `expect_pos`）：

| op | `args` |
|---|---|
| `put` | `Def` = `{ body, pins?, sig? }`（载荷**就是**记录本身，见 §7） |
| `add_identity` | `{ id, schema, parent? }` |
| `add_gen` | `{ id, payload, pins, sig, graft? }`（`seq` 由内核分配，不得出现） |
| `set_active` | `{ id, active: Hash \| null }` |
| `retire` | `{ id }` |
| `fork` | `{ id, schema, parent }` |
| `graft` | `{ id, payload, pins, sig, from, gen }`（`from` = 身份 id） |
| `batch` | `{ ops: Array<{ op: Op; args: Json }> }` |
| `note` | 任意 JSON 对象 = 留痕载荷（② 档，§0.4 规矩 B；建议摘要级，本体走宿主 blob；**载荷大小是宿主门禁，不是内核常量**；内核不解释内容，审计记录照旧走 `ref`） |
| `snapshot` | `{ world_rev }` |

| # | G 判定 | 错误码 |
|---|---|---|
| G1 | `add_identity` 的 id 不得已在 `ids`（retired 也占位） | `id_taken` |
| G2 | `seq` 由**内核分配**（`gens.length`，取值发生在 `push` **之前**）；`args` 里出现 `seq` → `bad_form`。写请求无从提交 `seq`，所以这里没有可失败的判定，只有形状检查 | `bad_form` |
| G3 | `fork` 必须带 `born.parent` 且父身份存在；`graft` 必须带 `graft.from/gen` 且该身份的 `gen` 存在 | `missing_parent` |
| G4 | **幂等与批内失败都不由 `validate` 判**（见上）：`commit` 按 `applyEntry` 返回定论——`isNoop` → `ok:true, reasons:['dup']` 且不产生 entry；`applyEntry` 报 `ok:false`（batch 段 2：`id_taken` / `missing_ref` / …）→ `ok:false, reasons:[error]`，无 entry、世界分文未动。`note` / `snapshot` 世界不变但 `isNoop` 恒 `false` | `dup`（非错误）/ 内层错误码上浮 |

### 11.3 `stale` 伪代码

```
stale(def, world, id):
  if !world.ids[id] → true
  gen = world.ids[id].gens.find(g => g.payload === world.ids[id].active)
  if !gen → true
  if def.sig != null 且 gen.sig != null 且 def.sig !== gen.sig → true
  for (name, h) of entries(def.pins ?? {}):
     if (gen.pins[name] ?? null) !== h → true
  return false
```

不兼容即隔离，**不删除**：隔离可逆、删除不可逆；而"不兼容"的判定本身可能出错，出错时要能查。

两条口径（写死，避免实现自行放宽）：

- `sig` 与 `pins` **双缺** → 恒 `false`：没有任何绑定的 def 不会随世代更替而失效。这是**宽松**口径——要让一份内容随依赖更替被判失效，`pins` 必须显式声明；不声明就等于"谁变了我都不在乎"。
- **`sig` 与 `pins` 对"单侧缺失"不对称，这是口径不是疏漏**：`sig` 只在**两侧都非 null** 时比较（单侧 null = 无从比较，跳过——签名兼容取乐观）；`pins` 是精确断言，def 声明了而 gen 缺该名（`?? null`）即坏（版本钉住取保守）。实现者不得把任一分支的口径复制到另一分支。
- 身份不存在、或 `active` 为 `null`（retired）→ `true`：**未知即隔离**。

### 11.4 验收清单（`commit.test.ts`，评审写，§5.4）

每个错误码一正一反；`expect_pos` 过期 → `pos_conflict`；重复 `put` → `ok:true, reasons:['dup']`、`entry === null` 且世界不变；只含幂等 `put` 的 `batch` 同样 `entry === null`；`note` / `snapshot` 世界不变但 `entry !== null`；`args` 带 `seq` 的 `add_gen` → `bad_form`；`commit` 对每条 in-chain entry 只调 `applyEntry` 一次（计数桩；batch 合成子不计，§10.3）；**`put` 的 `argsHash` === `H(Def)` === 该 def 的键**、`batch` 的 `argsHash` 由子哈希聚合（§10.1）；`commit` 返回的 `hash` === `entryHash(entry)` 且不重算；`commit` 后 Entry 的 `argsHash` 已回填 === `applyEntry` 返回值（冻结断言见不变量 15）；**batch 内子 `add_identity` 撞已在 `ids` 的 id → `entry===null`、`reasons=['id_taken']`、世界与 `head` 分文未动**（validate 不递归的兜底路径）；`stale` 各分支一例（sig 变、pin 变、身份 retired、身份不存在、双缺 → `false`、**sig 单侧 null → 不因 sig 判 stale**）。

本轮新增（T2 口径，§11.2 形状表 `note` 行 / §0.4 规矩 B / 不变量 16）：

1. 载荷 `note` 正例（任意 JSON 对象，如 `{kind:'obs', step:3, blob:<hash>}` → `ok:true`）；空 `{}` 仍过（向后兼容）；`args` 顶层为数组 / 字符串 → `bad_form`（hasForm 前置只收非 null 非数组对象）。
2. **同载荷 `note` 提交两次 → 两条 entry**（`isNoop` 恒 false，故意不去重；"处理过没有"归上层 `WriteRequest.id`）。
3. 改载荷不改 `argsHash` → `args_hash_mismatch`——留痕不可抵赖的正向证明（不变量 16）。
4. batch 内 `note` 载荷含 `{"$n":k}` 且**经 `commit` 的完整形态路径**（现有 `journal.b` 只测 `applyEntry` 直路）。
5. 载荷 `note` 双跑逐字节一致。

---

## 12. `machine.ts`

### 12.1 Term 语法（8 原语）

```
Const  ["c", Json]
Get    ["g", Path]
Var    ["v", int]                          // 位置参数，0 起
Cmp    ["cmp", Term, Term]                  // → -1 | 0 | 1
If     ["if", Term, Term, Term]
Fold   ["fold", Term, Term, Term]           // coll, init, step——函数侧求值为 def hash（函数即值）
Eff    ["eff", string, string, Term]        // port, method, args
Call   ["call", Term, [Term, ...]]          // 函数侧求值为 def hash
```

**无 lambda、无递归、无 while。** 函数 = 具名定义，`let` 用宏在写期展开（§12.1a 定案）。

**终止性是结构保证**：引用被引用定义**一律经 hash**——字面量或计算所得（从 ctx/args 取出的 64-hex 串），两者都只能指向**已存在**的 defs；机器在运行期**构造不出新 def**（无求值→写世界通路）⇒ 调用图恒为 defs DAG 的子图，**定义图必然是 DAG 的论证不受计算式函数侧削弱**。`fold` 受集合长度限制，gas 只管资源上界。

**8 个原语，到此为止。** 任何新增原语必须先证明它**不可由现有原语派生**，否则它以宏的形式住在世界内容里。let / lambda / 高阶的裁决**在写机器之前定死**（形式论证见 §12.1a）：`let` = 永久的写期宏；`lambda`（运行期构造函数）= 永不提供；"高阶" = 函数作为值传入/存储/选择，即上面 `Call` / `Fold` 函数侧的定案语法。

原语只增、不改语义：老日志不含新原语，因此在任何实现上仍可重放；新日志在尚未支持该原语的旧实现上报 `bad_term`（**拒绝执行，而不是算错**）。这就是不必给世界加版本字段也能保住"历史可重放"的原因。**定案窗口说明**：本条只约束落库之后；P0 之前的本段语法修订（Hash 字面量 → 计算式函数侧）不是"改语义"而是"定格式"——还没有一条历史，此后再动才触发本条与 §22。

### 12.1a let / lambda / 高阶：不可派生性论证（语法定案附录）

记号：`E[·]` = 把"带宏的构造"翻译成 (新增 def 清单, 纯 8 原语 Term) 的写期编译；`≈` = 对任意 env 与输入，观测（返回值 / 效果发射串 / gas 用量）一致，模 canonicalJson。

**引理 0（机器侧两个"造不出"）**：
(a) 运行期造不出新 def——`eval` 的值域是 `Json`，写世界只经 directive（机器外）；
(b) 运行期连**新哈希**都算不出——`H` 住在 hash.ts，不是求值原语。所以"构造一个函数再叫它的名字"在机器内没有任何通路。∎

**论题 1：`let x = e1 in e2` 可派生 ⇒ 依 §12.1 自规则，它永远是宏，不是第 9 原语。**
宏方案 `E[let]`：把 `e2` 中每个 `x` 出现改写为 `Var k`，生成辅助 def `D` = `{ body: e2' }`，整体替换为 `["call", ["c", H(D)], [e1]]`；`D` 与父项一同由同一次 `batch` 写入（validate ② 保证 call 目标先存在）。
- **语义等价**：对 `e2` 结构归纳。基例 `x → Var0` 取值 = e1 之值（call 实参先求值）；归纳步各原语下 `E` 与 eval 交换。`e1` 含 `eff` 时**恰好发射一次**（实参位单一），与朴素代入方案（每个出现副本一次）相比才是 let 语义——朴素代入被否：既复制 eff 又尺寸爆炸；哈希引用使重复出现只付一份 def。嵌套 let 逐层外提，尺寸线性。
- **确定性**：展开发生在写期，产物是数据——重放走同一条路。∎

**论题 2：lambda（运行期构造函数）不可派生——且**证明不可派生后仍**拒绝升级**，这是与"要不要加 while"同一级的裁决。**
- 不可派生：引理 0 (a)(b)。
- 加"内存态匿名 def"原语能否补救：能求值，但**构造出的函数没有身份**——不在 `defs`、无 `seq`、无 `pins`、无 `sig`、进不了依附与判决。一个演化系统会出现"改动了却看不见、坏不了也退不回"的函数，直接违反 §3 四个词与 M3/M4 的立身目的。**不可审计的能力 = 内核的负资产，宁缺。**
- 需求侧拆解："闭包"在现语义下本就是空概念——机器无环境捕获（每次调用的环境 = 显式 `args`，`ctx` 是 directive 级注入，非词法作用域），所以所谓"部分应用"= 把已绑参数做成数据随 hash 一起走（`["c",hFun]` + 参数进列表），§12.1a 论题 3 覆盖。
- 真要**生成性**（按输入产出新函数的族群）：正确出口不是机器内 lambda，而是**多次续跑的写期生成**——宿主/上层依据 obs 构造新 def，`batch` 写入，每个产物拿到身份·世代·依附（§2 表"初始化 = 上层动词"的同一扇门）。演化要的是被记账的生成，不是黑盒里的生成。∎

**论题 3：高阶的最终口径 = 函数作为一等**值**（本附录的语法修订）。**
`Call` / `Fold` 的函数侧从 `Hash` 字面量放宽为 Term（求值结果必须为 64-hex 的 `Str`）：函数可入列表、可入 ctx、可运行时选择（策略注入、插件表、dispatch），但**永远只能选中已存在 defs 里的函数**。
- 终止性：调用图仍是 defs DAG 子图（论题 2 之 (a)）；
- 发射序确定性：函数侧求值严格先于实参表（`fold` 的函数侧**每次 fold 只求值一次**，含其中 `eff` 至多一次发射）；
- 错误口径：函数侧结果非 Str / 非 64-hex → `Err('bad_fun')`；格式合而不在 `defs` → `Err('missing_ref')`（§12.5）；
- **代价（写明）**：字面引用不再是 body 里穷举可得的静态依赖图——"扫引用算影响面"从语法层沉到运行时。这不是内核的账：引用完整性机械校验本就只吃**内核认识字段**（§11.2 ②），body 内部引用归上层，自 §11.2 起如此。上层的静态分析工具要改为"数据可达 + 调用可达"双图，是它的义务清单，别指望内核回填。∎

三论题合成的就是本节问题："语言要不要长出 let/lambda"——**let 不需要（宏），lambda 不允许（身份论证），高阶需要且已给（函数即值）**。§12.1 的"新增原语先证不可派生"门由此对自己完成了第一例裁决。

### 12.2 环境与 `cmp` 全序

```ts
interface Env {
  ctx: Json
  args: Json[]
  defs: Record<Hash, Def>            // call 的目标；**必须是当前世界的 defs**（同一次调用里前面的写要可见）
  results: Record<Hash, EffResult>   // 已解析的效果结果（eff 回灌）
  caps: Record<string, boolean>      // 恒等于 KernelInput.caps（§14-6）
  limits: { gas: number; depth: number }
  run: string
  i: number                          // 当前 directive 下标（eff 身份的一半）
  n: number                          // 本 directive 内已发射的效果序号（可变）
  gas: number                        // 剩余 gas（可变）
  depth: number                      // 当前嵌套深度（可变）
  peakDepth: number                  // 本 directive 内 depth 的历史峰值（可变；usage.depth 取它）
}
```

```
cmp(a,b):
  1) ta=t(a), tb=t(b)；不同 → 按 TYPE_ORDER 下标比较
  2) 同型：
     Bool → (a?1:0)-(b?1:0)
     Int  → a<b ? -1 : a>b ? 1 : 0
     Str  → 逐 code unit，短者在前
     None → 0
     List → 逐元素 cmp，首个非 0 即返回；否则按长度
     Json → 键集先**滤去值为 undefined 的键**（与 canonicalJson / deepEq 同口径，§8.3 / §8.5——否则会出现
              "哈希相等而 cmp ≠ 0"，与不变量 1 互相矛盾），再排序逐对比较：先比键名（code unit），
              再 cmp(v)；键名全等则按键数
   返回 -1|0|1（**在值域内**永不抛错：非有限 `number` 由 `t()` 先报 `nonfinite`，见 §8.2 / §12.5）
```

### 12.3 `eval` 伪代码

```
fun eval(term, env):
  env.gas -= 1 ; if env.gas < 0 → Err('gas')
  env.depth += 1 ; env.peakDepth = max(env.peakDepth, env.depth)
  if env.depth > env.limits.depth → Err('depth')
  try:
     match term[0]:
       'c'    → term[1]
       'g'    → walk(env.ctx, term[1])                // 缺键/越界 → Err('missing_path')
       'v'    → k = term[1] ; 非整数 / k < 0 / k >= env.args.length → Err('bad_var')
                env.args[k]                            // 不用 ?? 判缺失：args[k] 本身可以是 null
       'cmp'  → cmp(eval(term[1]), eval(term[2]))     // 严格左→右
       'if'   → c = eval(term[1]) ; t(c) !== 'Bool' → Err('bad_cond')
                c === true 只求 term[2]，否则只求 term[3]（不预求另一支）
       'fold' → c = eval(term[1]) ; 非数组 → Err('not_a_list')
                f = eval(term[3])                      // 函数侧每次 fold 求值**恰一次**（其内 eff 至多一次发射）
                acc = eval(term[2])
                for i, item of c:
                  env.gas -= 1                         // 每轮迭代再扣 1
                  acc = evalCall(f, [acc, item, i])    // 目标循环内恒定；挂起则冒泡
        'eff'  → args = eval(term[3])
                 id = H({ run: env.run, i: env.i, n: env.n }) ; env.n += 1
                 if (r = env.results[id]) → r.ok ? r.value : Err('eff_error')
                 else → suspend({ id, port: term[1], method: term[2], args, caps: env.caps })
        'call' → evalCall(eval(term[1]), 逐个求值(term[2]))
  finally:
     env.depth -= 1                                 // **每条返回路径都减**（含 suspend / Err）
```

`eval` 的 `try / finally` 是**规范的一部分**：`env.depth` 必须成对增减，否则"深但宽"的求值（`fold` 多轮、`call` 兄弟节点）会在第一个深支之后误触 `depth` 超限。`env.peakDepth` 在自增处更新，所以 `usage.depth` 记的是**峰值**而不是收尾值。

`evalCall(f, args)` 是 `'call'` 分支与 `fold` 的 step **共用的同一条路径**：`f` 必须为 `Str` 且恰 64 个十六进制字符（否则 `Err('bad_fun')`）→ 查 `env.defs[f]` → 不在则 `Err('missing_ref')` → `body` 必须是 Term（否则 `Err('bad_term')`）→ 以 `withArgs(env, args)` 走**同一个 `eval`**（所以 gas 与 depth 都记在账上）。两条路径共用同一个函数，否则 `fold` 会长出第二套调用语义。函数侧计算化不新增递归通路：被调对象只能来自**已存在**的 defs（§12.1a 引理 0）。

**顺序纪律**：恒为深度优先、从左到右、串行。因此 `n`（效果序号）完全确定；不允许任何 `Map` / `Object` 迭代顺序影响求值顺序。

**`env` 是共享的可变上下文**：`gas` / `depth` / `n` 必须靠**同一对象**累加；`evalCall` 传给子环境时禁止展开复制（`{ ...env }` 会把计数器拍成快照，gas 与深度就失去上界作用）。

**实现约束**：`eval` 主函数只做分派（约 20 行），8 个原语各一个小函数——`evalConst` / `evalGet` / `evalVar` / `evalCmp` / `evalIf` / `evalFold` / `evalEff` / `evalCall`，每个 ≤ 50 行（`coding-standard.md` §5.1）。

**gas 与深度的记账作用域**：

- `limits.gas` 是**一次调用（一个 `KernelInput`）的总预算**，跨该次调用内的所有 `eval` directive 共享；每个 Term 节点扣 1，`fold` 每轮迭代再扣 1。当前剩余量就是 `env.gas`，随 `evalCall` / `fold` 一路传下去。
- `limits.depth` 是**单次求值**的最大嵌套深度；每进入一个 Term 自增、**每条返回路径自减**（`try / finally`，见上）。`fold` 的每轮迭代是**顺序**子调用，不计入并发深度。
- `usage.gas` / `usage.depth` 记的是**本次调用消耗 / 达到的峰值**，不是剩余量：`usage.gas = limits.gas - 剩余`，`usage.depth = max(各 directive 的 env.peakDepth)`（由 `run` 汇总，见 §13.1）。耗尽时返回 `refused(['gas'])` / `refused(['depth'])`，**不产生任何写入**（整次调用作废，见 §13.1）。

### 12.4 结果三态

```ts
type EvalResult =
  | { ok: true; value: Json }
  | { ok: false; error: string }
  | { suspend: EffRequest }
```

不捕获续体：遇到 `suspend` 即返回待解效果；结果回灌后从入口重跑，走到同一 `eff` 时直接取 `results[id]`。

**D2 的代价（写清楚，别让它变成意外）**：

- **单 pending 是严格求值下的下界**：效果值只在被需要时才遇到（`if` 不预求另一支、`cmp` 严格左→右），所以"同时挂起多个效果"语义上不可能——推测性发射只会浪费宿主副作用。
- **总成本 O(k²)**：一个 directive 内 k 个效果 ⇒ 每次续跑都要重放此前的前缀，总计 ≈ k 次重跑 × O(已走过节点) = O(k²)。每次调用由 `limits.gas` 封顶，所以不会失控，但**这笔账要按期付**。
- **纪律**：效果放**叶子**——不要让一整轮长 `fold` 每一步都 `eff`；长循环拆成多个 directive（`i` 不同 ⇒ 各自前缀更短）。
- **门外的逃生舱（宿主侧，不违反 D2、不改内核输入契约）**：O(k²) 里真正贵的是**重复触碰真实端口**，不是重放纯计算。`eff.id = H({run,i,n})` 确定 ⇒ 宿主可以：① 缓存 `(port, method, canonicalJson(args)) → EffResult`（仅幂等端口；缓存的错误必须原样 `ok:false`，不得顺手重试/改写）；② 按 §4.5 的审计对查账复用。**做不了的事也写死**：宿主不能"从第 k 个效果续跑内核"——`waiting` 从不返回部分世界（§13.1 四态表的字面），跳过前缀重放需要捕获续体，撞回 D2。重放的 CPU 是纯函数侧的确定成本，由 ①② 把它的外效应摊平到 O(k)。
- 量级直觉：k = 100、每效果 ~10³ 节点 ⇒ 10⁷ 步，可接受；k 到 10⁴ 就该拆了（gas 本来也会先拦）。

### 12.5 错误码表

| 码 | 触发 |
|---|---|
| `gas` | gas 耗尽 |
| `depth` | 深度超限 |
| `nonfinite` | 值不是有限 `number`（`t()` / `canonicalJson` 都拒） |
| `missing_path` | `get` 路径不存在 |
| `bad_var` | `v` 下标越界 |
| `bad_cond` | `if` 的条件不是 `Bool` |
| `not_a_list` | `fold` 的 coll 不是数组 |
| `bad_fun` | `call` / `fold` 的函数侧求值为非 `Str` 或非 64-hex（格式门槛，先于存在性；§12.3 `evalCall`） |
| `missing_ref` | `call` / `fold` 的函数侧格式合但不在此世界 defs |
| `bad_term` | term 头不是 8 原语之一 |
| `eff_error` | 回灌的 `results[id].ok === false` |

`nonfinite` 的触发点是 `t()` 与 `canonicalJson()`（§8.2 / §8.4）：`run` **不做事前扫描**，`ctx` / `args` 里的非有限数在第一次被比较或哈希时暴露。因为触发点确定，错误也是确定的（不变量 1 不受影响）。

### 12.6 验收清单（`machine.test.ts`，评审写，§5.4）

8 原语各一正一反；`cmp` 跨型 15 例（6 型两两）+ 全序性属性测试（**固定种子的**随机 200 组，断言反对称与传递）；`cmp` Json 分支的 undefined 键过滤（`cmp({a:1,b:undefined},{a:1}) === 0`，且两组 `H` 相等——口径一致性）；`if` 条件非 `Bool` → `bad_cond`；`v` 指向值为 `null` 的参数 → 返回 `null`（不是 `bad_var`）；`fold` 空数组 / 单元素 / 挂起冒泡 / 每轮扣 gas；**函数侧计算化（§12.1a 论题 3）三例**：hash 从 `ctx` 取出可正常 `call`（函数即值 + 同一次调用内新写入的 def 可见，§12.2 `defs` 口径）；非 Str / 非 64-hex → `bad_fun`；合格式而 defs 无 → `missing_ref`；**`fold` 函数侧恰求值一次**（其含 `eff` 时整场 fold 只发射一次、只占一个 `n`）；`eff` 序号确定性（同输入两次得同一串 id）；gas 耗尽；depth 超限。**注明不做**："let 展开等价"不在内核测试面（`bad_term` 会拒掉任何字面 `["let",…]` 头）——它是上层写期宏工具的验收义务（§12.1a 论题 1），评审别在此找它。

---

## 13. `run.ts`

### 13.1 伪代码

```
fun run(input):
  world = cloneWorld(input.world) ; head = input.head ; journal = [] ; obs = []
  gasLeft = input.limits.gas ; peakDepth = 0
  usage = () => ({ gas: input.limits.gas - gasLeft, depth: peakDepth })
  // 之后对 world 就地应用（别名契约）；整体成本 = 一次复制 + 每条 entry O(1)

  if input.directives 为空 → return idle({ world: input.world, journal: [], head: input.head,
                                          pending: null, observations: [], usage: usage() })

  for i, d of input.directives:
     'write' → o = commit(head, world, d.request, input.now)   // 唯一写口：校验 + entryOf + applyEntry(一次)
               if !o.verdict.ok → return refuse(o.verdict.reasons)
               pos = head.hash                                  // isNoop 时位置不变
               if o.entry !== null → journal.push(o.entry)
                                     head = { seq: o.entry.seq, hash: o.hash }   // commit 已算好，O(1)
                                     pos = o.hash
               obs.push(observationsOf(d, { kind:'write', o, pos }))
     'eval'  → d.entry 不在 defs → return refuse(['missing_ref'])
               defs[d.entry].body 不是 8 原语之一 → return refuse(['bad_term'])
               env = mkEnv({ input, world, i, d, gasLeft })
               r = eval(defs[d.entry].body, env)
               gasLeft = env.gas ; peakDepth = max(peakDepth, env.peakDepth)   // 预算跨 directive 共享
               if r.suspend → return waiting({ world: input.world, journal: [], head: input.head,
                                               pending: r.suspend, observations: obs, usage: usage() })
               if r.error   → return refuse([r.error])
               obs.push(observationsOf(d, { kind:'eval', r }))
     'extern'→ obs.push(observationsOf(d, { kind:'extern' }))

  return done({ world, journal, head, pending: null, observations: obs, usage: usage() })

fun refuse(reasons):                          // run 级拒绝：世界/日志回到入口；观测保留并补末尾一条
  return refused({ world: input.world, journal: [], head: input.head, pending: null,
                   observations: [...obs, observationsOf(null, { kind:'refused', reasons })],
                   usage: usage() })
```

四态的构造口径（写死，避免"半成品世界"漏出去）：

| status | `world` / `head` | `journal` | `pending` | `observations` | `usage` |
|---|---|---|---|---|---|
| `idle` | `input.world` / `input.head` | `[]` | `null` | `[]` | 全 0 |
| `waiting` | `input.world` / `input.head` | `[]` | 该效果 | 已处理部分的观测（挂起那条为 `null`） | 当前消耗 / 峰值 |
| `refused` | `input.world` / `input.head` | `[]` | `null` | 已处理部分的观测 **+ 末尾 `{kind:'refused', reasons}`** | 当前消耗 / 峰值 |
| `done` | 克隆体（已就地改完） | 本次 entry 列表 | `null` | 全部 | 当前消耗 / 峰值 |

八条落地纪律（否则上面这段会各自长出不同实现）：

- **整次调用原子**：`world` 是入口的独占副本；`refused` / `waiting` 时**宿主丢弃本次输出**（`journal` 整体作废），世界回到 `input.head`。这是 D2"不捕获续体、从入口重跑"的必然结果，也是 §13.2 里"世界未动"的准确含义。
- **`waiting` / `refused` 的 `observations` 只是诊断，不是账**：其中 `write` 观测的 `pos` 是"若本次调用成功，它将落到的位置"——随整次调用作废；**任何消费者不得据此推进或落 checkpoint**，真实位置只认 `done` 输出里的 `head` / `journal`。
- **续跑契约**：`waiting` 之后必须以**同一 `run_id` + 同一份完整 `directives`（含已执行完的前缀）+ 同一 `now`** 重调，`results` 只增不改。`i` 是 directive 下标，`now` 进 `entryHash`——任一漂移都会让续跑与"一次跑完"不再逐字节一致。
- **`refused` 的 reasons 走 `observations`**（`KernelOutput` 不另设字段，见 §21）：观测统一由 `observationsOf` 产出，`refuse()` 只负责把拒因那条**追加到末尾**——所以 `refused` 观测在公共面上必然可见、可断言。
- **`usage` 由 `run` 汇总**：`gas = input.limits.gas - gasLeft`、`depth = max(各 directive 的 env.peakDepth)`；**四态都带 `usage`**（`idle` 为全 0）。
- **`refused` / `waiting` / `idle` 返回的是 `input.world` / `input.head`**（不是克隆体），`journal` 为空——克隆体只服务于"整次成功"的 `done` 路径。这条是"整次调用原子"的落地形式，也是不变量 11 / 13 的前提。
- **推荐一条 `write` 一个调用**：同一次调用内若有多条 `write`，第二条起的 `expect_pos` 必须逐条对上（= 前一条的 `entryHash`），上层得先把整条链算出来。要么一次只提一条，要么把多次写入装进**一条 `batch` entry**（原子、只占一条 entry）——后者是 `batch` 的主要用途。
- **`mkEnv` 是 `Env` 的唯一构造点**（§12.2），且 **`defs` 取当前世界**（不是 `input.world`）——否则同一次调用里前面写进去的内容，后面的 `eval` 看不见：

  ```
  fun mkEnv({ input, world, i, d, gasLeft }):     // 5 项，按 §5.2 封装为对象
    return { ctx: d.ctx, args: [d.args], defs: world.defs, results: input.results,
             caps: input.caps, limits: input.limits, run: input.run, i, n: 0,
             gas: gasLeft, depth: 0, peakDepth: 0 }
  ```

  `args` 一律是 `[d.args]`（`Var 0` 拿到它）；`n` / `depth` / `peakDepth` 每个 directive 重置；**`gas` 用本次调用的剩余量**（`limits.gas` 减去此前 directive 已耗），所以 `gas` 跨 directive 共享，而 `n` / `depth` / `peakDepth` 不共享。

### 13.2 状态机

| status | 何时 | 宿主下一步 |
|---|---|---|
| `waiting` | 求值遇到未解析的效果 | 执行 `pending` → 写入 `results` → 用**同一 `run_id`、同一份完整 `directives`、同一 `now`** 再调一次 |
| `done` | 给定的 `directives` 全部处理完 | 落盘 `world` + `journal` + `head`，换 `run_id` |
| `idle` | `directives` 为空 | 等新输入（不是 `done`：没有可落盘的新内容） |
| `refused` | 任一机械校验失败或求值错误 | 读 `observations` 末尾的 `{kind:'refused', reasons}`；修正后重提（**本次调用整体作废，世界未动**） |

### 13.3 验收清单（`run.test.ts`，评审写，§5.4）

四态各一例（含 `directives` 为空 → `idle`）；`waiting → 回灌 → done` 全链，且与"一次跑完"逐字节一致（含 `head`）；同 `run_id` 重跑幂等（`world` / `journal` / `head` 逐字节一致）；写请求失败时世界未动（对照前后 `head` 与世界）；幂等 `put` 不出现在 `journal` 里；`journal` 的 `prev` 链可校验。

三态构造口径（§13.1 的表）逐格断言：`refused` / `waiting` / `idle` 返回的 `world` / `head` **=== `input.world` / `input.head`**、`journal` 为空；`refused` 时 `observations` 末尾必有 `{kind:'refused', reasons}`（评审从公共面即可验证）；`usage.gas === limits.gas - 剩余`、`usage.depth >= 单条 eval 的峰值`、无 `eval` 时 `usage` 全 0；`observations` 由 `observationsOf` 产出（模块 mock 断言"run 不自己拼形状"）；**深但宽**的求值（`fold` 多轮 + `call` 兄弟节点）不误触 `depth` 超限。

---

## 14. 不变量（`invariants.test.ts`，评审写，§5.4）

| # | 不变量 | 断言写法 |
|---|---|---|
| 1 | 纯函数 | 同输入跑两次 → 输出哈希相同（含 `world` / `journal` / `head` / `pending` / `observations` / `usage`）；另断言 `replay(journal)` **逐字段**复现 `world`（含 `ids` 的 `at` / `by` / `write`） |
| 2 | 零 IO | 扫非 `*.test.ts`：import 只允许相对路径；无 `node:`、无第三方、无 `Date` / `Math.random` / `fetch` / `process` |
| 3 | 终止性 | 随机 Term 1000 个（**固定种子**，种子写在测试里），全部在 gas 内返回（无栈溢出、无死循环） |
| 4 | 唯一写口 | 静态：`defs` / `ids` 的赋值只出现在 `journal.ts`（`commit` 只调 `applyEntry`，自己不写） |
| 5 | 引用完整性 | **内核认识字段**里的引用不存在 → `missing_ref`，且世界不变（`add_identity.schema` / `add_gen.payload`+`sig`+`pins.*` / `put.args.sig`+`put.args.pins.*` / `request.ref`；body 内部引用不在内核职责内） |
| 6 | 能力来自输入 | 任意 Term（含嵌套 `eff`）产出的 `EffRequest.caps` 恒等于输入 |
| 7 | 可回滚 | `set_active` 指回任一历史世代后，`gens` 长度不变、旧世代可再激活 |
| 8 | 幂等 | 同内容 `put` / `batch` 二次提交 → 世界不变、**日志不追加**（`entry === null`） |
| 9 | `worldRev` 覆盖语义 | 改任一被引用的 `body`（一字之差）→ `worldRev` 必变；且它**按需计算**，不在每条 entry 上算；`ids` 摘要只吃 `schema`/`active`/gen 内容哈希（§10.1）——内容同、`active` 同而 `born`/`adopted` 履历不同的世界，`worldRev` 必相等 |
| 10 | 不含审核概念 | 非 `*.test.ts` 词表扫描：禁 `criteria` / `approve` / `level` / `review` / `policy` |
| 11 | 批量原子性 | `batch` 中途失败 → `world` 与 `worldRev` 与失败前逐字节相同（局部 `undo` 逆序还原，§10.3） |
| 12 | 链连续 | `run` 返回的 `journal` 首条的 `prev` === `input.head.hash`、`seq` === `input.head.seq + 1`（空世界 `head = EMPTY_HEAD = {seq:-1, hash:null}`），其余逐条 +1；`entryHash` 逐条接得上；`head` === 末条 entry 的位置 |
| 13 | 单次复制 | 单次 `run` 只 `cloneWorld` 一次；**in-chain** `applyEntry` 调用次数 = 本次实际产生的 entry 数（幂等命中不计；batch 内对合成子 entry 的递归应用不计——识别特征：其参数 `e` 与本次 journal 的任何 entry 都不同一，计数桩按引用去重；可测） |
| 14 | 哈希不重复（性能） | 计数桩（按载荷字节计，entryHash 类小定长 map 各记常数 1）：`put` 恰 1、其它单 op 写入 ≤ 2（§10.1）；**batch 是唯一双趟点**：≤ `2·#子操作 + 2`（段 1 预哈希与段 2 子操作步①各一次——两段式为 `outerPos` 付的账；实现拿"已算哈希"缓存可压到 `#子操作 + 2`，规格只锁上界不锁做法）；`entryHash` **不读 `args`**（改 `e.args` 而保持 `e.argsHash` → `entryHash(e)` 不变，可测）；`verify` 每条 entry 只算一次 `entryHash` |
| 15 | 入参不动（冻结桩） | 把 `Entry` **连同** `args` 深 `Object.freeze` 后传 `applyEntry`（含 batch / 嵌套 batch / verify / replay 全路径）：调用返回后 `e` 各字段（尤其 `argsHash`）与调用前逐字节一致——严格模式下任何就地改写会当场抛，测试即红。本条是 `args_hash_mismatch` 检测与"纯函数"承诺的机制底座（§10.1-3/4，替代旧口径"applyEntry 回填 e.argsHash"） |
| 16 | 留痕不进世界（§0.4 规矩 B 的可执行定义） | 只含载荷 `note` 的链（单条或嵌 `batch`，任意混合）：`run` / `replay` 所得 `world` 与 `EMPTY_WORLD` 逐字节相同、全程 `worldRev` 不变；`defs` 键数与 note 条数无关（键数桩）；同载荷 `note` 提交两次 → **两条 entry**（`dup` 不适用）；载荷 `note` 的 `args` 被改而 `argsHash` 未改 → `args_hash_mismatch`（链对留痕内容同样不可抵赖） |

**计数桩怎么来**：§14-13 / §14-14 的计数用 vitest 的模块 mock 完成（拦截 `applyEntry` / `canonicalJson` 的调用），§14-15 用 `Object.freeze` 深冻结入参（无需额外机制），§14-16 的 `defs` 键数桩只需 `Object.keys(world.defs).length`（在只含载荷 note 的链上前后比对），**都不需要实现导出内部函数、也不加测试开关**（§5.4 第 1 条）。因此 §6 的依赖方向（谁从哪个文件 import 什么）是这些断言的隐含契约，不许改。

---

## 15. 批次与验收

| 批 | 实现者交付（非 `*.test.ts`） | 评审交付（测试）与判据 |
|---|---|---|
| **P0** | `types` `value` `hash` `journal` **+ `index`**（导出这四者的并集） | `value.test.ts` / `hash.test.ts` / `journal.test.ts` 全绿；不变量 1/2/7/8/15 绿 |
| **P1** | `commit` `machine`（`index` 追加其导出） | `commit.test.ts` / `machine.test.ts` 全绿；不变量 3/4/5/6/9/10/11/14 绿 |
| **P2** | `run`（`index` 追加 `run` / `observationsOf`） | 16 条全绿（16 由本轮加入，见 §14）；`run` 四态 + 回灌闭环绿 |

`index.ts` 必须在 P0 就位：评审只能从它导入（§5.4），否则 P0 的三个测试文件无从写起。

两列判据分开算，缺一不算过：

- **实现方判据**（每批都跑）：`npx tsc --noEmit` 零错误、`npx prettier --check .` 零差异（§5.2）、§5.1 的文件与函数行数预算达标、`index.ts` 导出面符合 §5.4 第 1 条。
- **评审方判据**（每批都跑）：上表右列的测试与不变量全绿——**由评审跑，实现者不自评**（§5.4）。

归档与回收不欠内核算法：§10.7 的三层全部由已交付的 op 承担（`snapshot` + 宿主存储 + 上层重建）。宿主侧要做的只有节拍与冷存储策略（§10.7 归档协议第 5 条）——那是 manifest 参数，不是内核常量。

---

# 第三部分 · 算法补全

第二部分给出了各模块的导出与主要伪代码；下面补齐只提及未展开的算法。全部是纯函数。

## 16. `entryOf(链头, 请求, now) → Entry`

把一条写请求转成一条日志 entry。**它不是校验**——调用前必须先过 `validate`（§11）；**它也不改世界**——应用的活由 `commit` 在 `entryOf` 之后做，且**恰好一次**。链头来自 `KernelInput.head`，`now` 来自 `KernelInput.now`。

```
fun entryOf(head, req, now):               // 只构造，不应用；`argsHash` 是输出位（§7），此处留空
  seq  = head.seq + 1                       // 首条 entry 的 seq = 0（head = EMPTY_HEAD）
  prev = head.hash                          // 首条为 null
  return { seq, prev, op: req.op, args: req.args, by: req.by, ref: req.ref, at: now }
```

**不计算世界内容哈希**：位置由 `entryHash(e)` 接链即可，`worldRev` 只在快照 / 跨世界比较时才算。`entryHash(e)` 覆盖 `at` / `by` / `ref`（以及 `argsHash`），所以**改这几个字段会被链校验发现**——这也是续跑必须传同一 `now` 的原因（§13.1）。

**`commit(head, world, req, now)` 的顺序**（唯一写口，§11.1）：

```
fun commit(head, world, req, now):
  v = validate(head, world, req)                 // 只读，不改世界；batch 不递归（§11.2）
  if !v.ok → return { verdict: v, entry: null, hash: null }
  e = entryOf(head, req, now)                    // argsHash 留空（输出位，§7）
  r = applyEntry(world, e)                       // 就地改调用方独占的副本；**不修改 e**（不变量 15）
  if !r.ok → return { verdict: { ok: false, reasons: [r.error], pos: head.hash, written: [] },
                      entry: null, hash: null }  // 只有 batch 段 2 可达；undo 已回滚，世界分文未动
  e.argsHash = r.argsHash                        // —— 全库唯一回填点（e 为 commit 独占）——
  if r.isNoop → return { verdict: { ...v, reasons: ['dup'], pos: head.hash },
                          entry: null, hash: null }
  h = entryHash(e)                               // O(1)：只吃已回填的 argsHash，不读 args
  return { verdict: { ...v, pos: h, written: r.written }, entry: e, hash: h }
```

`run` 直接用返回的 `hash`（head 推进、observations 的 `pos`），**不再自己算** `entryHash`。由 `entryHash(e) = H({...e 除 argsHash 外的字段})` 的构造，`batch` 段 1 的 `outerPos` 与这里回填后算出的 `h` **是同一个值**——批内 `add_gen` 记下的 `write` 恒等于链上真实存在的这条 entry 的位置（可断言：见 §11.4）。

## 17. `walk(ctx, path) → Json | Err('missing_path')`

`["g", path]` 的实现；`path` 是 `(string | number)[]`。

```
fun walk(v, path):
  for step of path:
     if typeof step === 'number':
        if !Array.isArray(v) → Err('missing_path')
        if !Number.isInteger(step) 或 step < 0 或 step >= v.length → Err('missing_path')
        v = v[step]
     else:
        if t(v) !== 'Json' → Err('missing_path')
        if !Object.hasOwn(v, step) → Err('missing_path')
        v = v[step]
  return v
```

规则：不做隐式转换、不用 `null` 代缺失、不允许负索引；空 `path` 返回 `ctx` 本身。

## 18. `substitute(args, acc, k) → Json | Err('bad_selfref')`

`batch` 的占位符替换（§10.3），递归遍历整棵 JSON 树。

```
fun subst(v, acc, k):                      // k = 当前子操作索引
  if v 是对象且键恰好为 ["$n"]:
     j = v["$n"]
     if !Number.isInteger(j) 或 j < 0 或 j >= k → Err('bad_selfref')
     if acc[j] === null                          → Err('bad_selfref')   // 指向无产物的操作
     return acc[j]
  if Array.isArray(v) → v.map(x => subst(x, acc, k))
  if t(v) === 'Json'  → 逐值 subst，键不变
  return v
```

占位符必须**恰好只有 `$n` 一个键**；含其它键的 `{"$n":…, …}` 视为普通数据，不替换。

`$n` 只能指向本批内更早的 `put`（只有它有产物 = def 键）：指向 `add_identity` / `add_gen` / 嵌套 `batch` 等无产物子操作 → `Err('bad_selfref')`。这也意味着**嵌套 `batch` 不产生可被引用的哈希**，替掉了原先 `H({ops: acc})` 的含糊定义。

## 19. `replay(entries, from?) → World`

```
fun replay(entries, from = EMPTY_WORLD):
  w = cloneWorld(from)                     // 独占副本；之后就地应用（别名契约）
  for e of entries:
     r = applyEntry(w, e)                  // 不改 e ⇒ 下面的比对吃的是**存着的** argsHash
     if !r.ok → Err('apply_failed')                             // 与 §20 同一个码
     if r.argsHash !== e.argsHash → Err('args_hash_mismatch')   // 与 verify 同一查，不额外付成本
  return w
```

`replay` 的契约就是**抛**：除上面两个码，`applyEntry` 自身的 `KernelError` 也原样穿出——目前只有链内 `snapshot` 自校失败可达（`Err('world_rev_mismatch')`，§10.2）。与 `verify` 的区别是分工（§10.1）：`replay` 只重建、出状态，失败即抛；`verify` 只报告、返回码。**`replay(尾段, 错的基础)` 不会报错**——它不校验链，seq / prev 检查只在 `verify`（§10.4）；"接错基础算出链上从未被授权的世界"由调用方按 §10.7 归档协议第 4 条的三步成对避免（① 校基础 → ② 校接驳 → ③ 才 replay）。

核心断言：**`replay(tail, snapshotWorld) === replay(allEntries)`**（就世界内容而言）。这是长链安全的唯一依据（测试清单见 §10.5）。

内容一致性由 `worldRev` 单独核对：`worldRev(replay(tail, snap)) === worldRev(replay(all))`。**它不在每条 entry 上算，只在需要比对时算一次。**

## 20. `verify(entries, anchor?, expected?) → { ok, error? }`

只校验，不返回世界；用途是让**任意段可独立校验**（归档段的完整性）。起点是**链锚点** `{ world, head }`，不是单个世界——`replay` 只要世界（它不校验链），`verify` 还要链头，这就是两者参数不同形的原因。

```
fun verify(entries, anchor = { world: EMPTY_WORLD, head: EMPTY_HEAD }, expected?):
  try:
    w = cloneWorld(anchor.world)
    prev = anchor.head.hash                  // 不再是硬编码的 null
    expectSeq = anchor.head.seq + 1          // 不再是 entries[0].seq 反推
    for i, e of entries:
       if e.seq  !== expectSeq  → { ok:false, error:'chain_broken' }
       if e.prev !== prev       → { ok:false, error:'chain_broken' }
       r = applyEntry(w, e)
       if !r.ok                 → { ok:false, error:'apply_failed' }
       if r.argsHash !== e.argsHash → { ok:false, error:'args_hash_mismatch' }  // 冷路径加强查：e 不被覆写，
                                                                                 // 吃到的是**存着的**值（不变量 15）
       h = entryHash(e)                        // O(1)，整个循环里每条只算一次
       if expected?.hashes 且 expected.hashes[i] !== h → { ok:false, error:'chain_broken' }
       prev = h ; expectSeq += 1
    if expected?.worldRev 且 worldRev(w) !== expected.worldRev → { ok:false, error:'world_rev_mismatch' }
    return { ok: true }
  catch KernelError e:                         // **verify 自身从不抛**（§10.1 旁注）：applyEntry 的 KernelError
    return { ok: false, error: e.code }        // 全部转返回码；目前只有链内 snapshot 自校可达（world_rev_mismatch，§10.4）
```

五查：`seq` 连续、`prev` 接得上、`applyEntry` 成功、`argsHash` 与实算一致、`entryHash` 与清单一致；段末再用**可选的 `worldRev` 锚点**核对内容。锚点与 `expected.hashes` 的偏移由调用方对齐（段首 entry 对应 `hashes[0]`）。`args_hash_mismatch` 这一查是**热路径优化换来的**（§10.1 第 3 条）：`run` 省掉重复规范化，`verify` 把账算回来。

**归档段怎么校验**：快照本身就是一条 entry，它的位置就是边界，不需要额外记 `at_hash`：

```
verify(hotEntries, { world: snapshotWorld, head: { seq: snap.seq, hash: entryHash(snap) } })
```

`expected.hashes` 也可直接取 `entries.map(entryHash)`——那就退化成"校验段自洽"。

## 21. `observationsOf(d, outcome) → Json | null`

观测流是**派生视图**，不是新状态，不落盘、不入世界。`run` 只用这一个函数产出观测，不自己拼形状；**一个 directive 至多一条观测**。

```ts
type ObsOutcome =
  | { kind: 'write'; o: CommitOutcome; pos: Hash | null }   // pos = 写入后的位置（幂等时 = 未变的 head）
  | { kind: 'eval'; r: EvalResult }          // eval directive
  | { kind: 'extern' }                       // extern directive（内容全在 d 里）
  | { kind: 'refused'; reasons: string[] }   // run 级拒绝（此时 d = null）

export function observationsOf(d: Directive | null, outcome: ObsOutcome): Json | null
```

| `outcome.kind` | 产出 |
|---|---|
| `write` | `{kind:'write', op, pos}`；`o.entry === null`（isNoop）时附 `dup: true`。`pos` 由 `run` 传入：非幂等 = `o.hash`（本次 entry 的位置），幂等 = 未变的 `head`（`observationsOf` 不自己读状态） |
| `eval` | `r` 是 `suspend` → **`null`**（挂起不产出观测，§12.4）；否则 `{kind:'eval', entry: d.entry, ok, value? \| error?}` |
| `extern` | `{kind:'extern', payload: d.payload}` |
| `refused` | `{kind:'refused', reasons}` —— 由 `run` 在返回 `refused` 前补一条（`d = null`） |

顺序 = 处理顺序，`refused` 那条在末尾。`refused` / `waiting` 时 **`world` / `journal` / `head` 回到 `input`**（整次调用原子，§13.1），但 **`observations` 照常返回**——它是拒因与诊断的唯一载体，且不承载状态（同输入重跑得到同一条流）。`KernelOutput` 不另设 `reasons` 字段。

## 22. 明确不提供的算法

| 不做 | 为什么 |
|---|---|
| 可达闭包遍历 | 要求内核认识 body 里的引用标记 = 认识语义。§0.4 规矩 A 收窄了后果：依赖只走 pins 时，**上层沿 `pins` / `payload` / `sig` / `schema` 只读遍历即得闭包，不必解析任何 body**——此行禁的是"闭包算法进内核"和"内核解释 pin 名"，不是"闭包算不了" |
| 内容回收 / 删除 | 内核没有删除；缩小世界由上层重建 |
| 效果执行 / 重试 / 超时 | 内核只发射，执行是宿主的事 |
| 审核判定 / 排程 | 都是动词，在上层 |
| 求值记忆化 / 捕获续体 | 与 D2 冲突。记忆化**只改常数、改不了 O(k²) 的阶**（阶来自重放前缀，靠 §12.4 的纪律解决），却要引入一份可变缓存与它的失效面——含 `eff` 的子树不可缓存（值来自 `results`），所以缓存还得先判定"是否含 eff" |
| 换哈希 | 破坏 §9.4 的自证向量与跨实现可复现；`H` 的口径是**链格式的一部分**（D5），换哈希 = 旧链不可重算。真要换只有 `H` 一处要动（§9.5）。**注意：P0 开工前把 sha1 截 128 换成 sha256 全长（§9.5 的碰撞预算论证）不是"换哈希"而是链格式定稿前的最后修正**——一份以内容哈希为身份与依附的系统不能建在已被实用碰撞攻破的哈希上，截短又零收益；P0 之后任何再换（blake3 / xxhash…）都按本行的"换链"裁决走 |
| `worldRev` 增量维护 | D1 已把它挪出热路径；增量维护要可变缓存 = 引入状态，破 §4 的纯函数 / 不持久化，并新增"缓存与世界不一致"这个失效面 |

> 本节存在的意义：以上都是最容易被"顺手加"的东西。想加之前，先证伪它右侧的理由，而不是先写代码。
