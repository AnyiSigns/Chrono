# 内核：设计、架构与边界

---

## 一、内核是什么

内核是一个**内容寻址的世界**加一条**只追加的日志**，包在一个**纯函数**里。唯一入口、唯一出口：

```
run(input: KernelInput) → KernelOutput
```

它只兑现三个承诺：**改坏了能退**（日志只追加、回滚是一次追加而非抹除）、**非法进不来**（唯一写口前的四步机械校验任一不过则整次调用作废）、**历史改不掉**（链式哈希覆盖每条记录的位置与内容摘要，改任何一处其后全断）。它明确不兑现第四个：不判断"这次改动是不是更好"。判决回答的是"合不合法"，正当性（该不该）永远在上层。

内核只认识四个词：**身份 · 世代 · 依附 · 判决**。除这四个词与四条机制，内核不认识任何东西。

## 二、分层与三条单向

四层各司其职：

| 层 | 职责 | 不认识 |
|---|---|---|
| 内核 | 一致性：改了什么、能不能退、非法进不来 | 语义、性能策略、审核、存储、调度 |
| 宿主 | 存储、效果执行、装载执行件、审计策略、上下文投影 | 判定逻辑（那是数据） |
| 执行件（插件） | 干活，独立进程、按协议挂载 | 世界状态的所有权 |
| 上层 | 用内核给的一致性做自己的判定 | — |

三条单向：**判定单向**（判据只能以数据身份进世界，永不以代码身份进内核）；**依赖单向**（求值与写入之间没有任何边）；**信任单向**（把宿主能碰的东西全收敛为"输入数据 + 落盘字节"，其余自己重算）。

依赖图就是一条 DAG，不许含糊：

```
value   ← types
hash    ← types, value
journal ← types, hash            （world 的 apply/链/校验 + batch 的 substitute/argsHashOf）
commit  ← types, hash, journal   （不依赖 machine）
machine ← types, value, hash    （不依赖 journal / commit）
run     ← 以上全部               （唯一调用 commit 的地方）
index   ← run 与公共面            （只 re-export）
```

`machine.ts` 与 `journal.ts`/`commit.ts` 之间没有任何边——求值不认识写入，写入不认识求值，两边都只认识值模型。多宿主不是一个世界被多个宿主共享：每个宿主各一个内核实例、各一条链、零共享状态。

## 三、四条机制

缺一条承诺就漏一块：

| 机制 | 内容 | 缺了会怎样 |
|---|---|---|
| M1 值层 | 一种 JSON 值模型 + 唯一规范序列化 + 结构相等 | 哈希口径不唯一 ⇒ 同一内容有两个键 ⇒ 身份系统当场失效 |
| M2 归约机 | 8 原语、可执行的 def、显式效果挂起 | 判定逻辑只能编进宿主 ⇒ 改判据要重启、不可回滚、不留痕 |
| M3 日志 | 只追加、链式哈希、位置 CAS | 无法回滚、审计、重放 ⇒ 内核存在的唯一理由消失 |
| M4 唯一写口 | 所有改动穿过同一道门，四步机械校验 | "非法进不来"变成靠自觉 |

归约机与日志的关系常被低估：判据必须是数据，所以必须有一种"能被数据表达的执行方式"。把归约机冻成宿主代码，等于取消它的第一个用途——让判据可热改、可追溯、可回滚。归约机予以保留；被降级的是逻辑的"一等插件资格"，不是"机器解释逻辑的资格"——要被内核机械执行的逻辑必须写成可执行项（term），可派生的以宏住在数据里。

## 四、世界的形状

世界是两张表，类型骨架（与 `kernel.md` §7 对齐）：

```
Def      = { body: Json, pins?: Record<string, Hash>, sig?: Hash }  // put 的载荷本身；键 = H(Def)
Gen      = { seq, payload: Hash, pins: Record<string, Hash>, sig: Hash,
             adopted: { at, by, write: Hash }, graft?: { from: id, gen }, base?: int }
             // adopted.write = 完成采纳的那条 entry 的位置；批内 add_gen 指向外层 batch entry 的 entryHash
             // base 存在 = 补丁世代：payload 指补丁 def，body = base 世代 body 组装后按序应用补丁；
             // 缺省 = 整份世代：payload 指整份 body def。两种世代 active 同义（都指 payload）
Identity = { id, schema: Hash, gens: Gen[], active: Hash|null, born: { at, by, parent? } }
World    = { defs: Record<Hash, Def>, ids: Record<string, Identity> }
           // defs 表可由宿主实现为惰性代理（按需从分片加载 body）：内核经 defs.ts 的 LAZY_DEFS
           // 符号识别，克隆 / 列键 / 判存在不读 body，下标读写与普通 map 同形、语义一致
Head     = { seq, hash: Hash|null }     // EMPTY_HEAD = { seq: -1, hash: null }
Anchor   = { world, head }               // 校验起点；与 KernelInput.head 同形
```

关键口径：Def 的键覆盖 `body + pins + sig`（不只是 body），否则改 pin/sig 不动 `worldRev`。`pins` 是**名 → 哈希**的映射（`Record<string, Hash>`），名不透明——内核不解释 pin 名，只要求它存在、是个 Hash 值。`Identity` **没有分类字段、没有标签位**——想区分"插件/判据/数据"就写一份声明它自己的 `schema`，那是数据不是特权。`seq` 由内核分配（gens.length），写请求无从提交；`adopted.write` 指向完成采纳的那条 entry 的位置。

两份身份必须分开：

| 身份 | 定义 | 成本 | 用途 |
|---|---|---|---|
| 位置 `pos` | 链头哈希 = `entryHash(末条)` | O(1) | 乐观并发（`expect_pos`）、链完整性 |
| 内容 `worldRev` | `H({ defs 键集, ids 摘要 })` | O(def 数) | 快照锚点、跨世界比较、数据 pin —— **按需算，不挂每条 entry** |

内容摘要吃定义表的**键**而不吃序列化 body：键本身就是 `H(Def)`，键集等价于内容集，代价从"序列化整个世界"降到"排序键"。摘要**不吃履历**（`born`/`adopted`）：否则同内容、同 `active` 而采纳历史不同的两世界摘要不同，pin 它们的内容会无端漂移。`ids` 摘要只取 `{id, schema, active, gens:[{seq,payload,pins,sig,graft?}]}`。两者都不做可达闭包——闭包要求认识 body 里的引用标记 = 认识语义。

## 五、日志即真源

日志本身就是那条链。一条记录是一条 `Entry`：

```
Entry = { seq, prev: Hash|null, op: Op, args: Json, argsHash: Hash,
          by: string, ref?: Hash, at: number }
```

`op` 有十种：

```
put | add_identity | add_gen | set_active | retire | fork | graft | batch | note | snapshot
```

回滚是一条追加（`set_active` 指回旧世代），不是删节点。**删除在内核里根本不存在**——所以回滚可逆、可重放、可对照。`retire` 与 `set_active(null)` 世界效果相同却是两条不同 entry：历史绝不折叠；幂等（`dup`）只属于"同内容重复 `put`"这一种情形。

`add_gen` **入世即激活**：新世代写入 `gens` 的同时 `Identity.active` 指向其 `payload`（同时激活）；`set_active` 用于把 `active` 指向任意旧世代（回滚）或置 `null`（下线）——`retire` 与置 `null` 效果相同，但仍是两条不同 entry。

链是 Merkle 的：`entryHash` 只吃 `argsHash` 不吃 `args`。各 op 的 `argsHash` 口径：

| op | argsHash |
|---|---|
| `put` | `H(Def)` —— 与 def 键同一个值，零额外成本 |
| `batch` | `H({ ops: [[op_i, h_i]…] })`，子哈希聚合，O(子操作数) |
| 其它 | `H(args)`，一次规范化（`note` 可带留痕载荷，是唯一可能带大 args 的非 batch op） |

于是链头推进、位置、锚点、期望值比较全部 O(1) 不碰载荷字节；一份 args 只规范化一次。`entryHash = H({ at, seq, prev, op, argsHash, by, ref })`——`at`/`by`/`ref` 都进链哈希，所以改时间戳、提交者或审计指针也会被链校验发现；这也是续跑必须传同一 `now` 的原因。防篡改不降级反而更强：重放时把重算的 `argsHash` 与 entry 里存着的值比对，"改了 args 没改 argsHash" 也会被抓出（`args_hash_mismatch`）。

`batch` 是唯一的两段式。原因是一条先后依赖：批内 `add_gen` 的 `adopted.write` 语义是"完成采纳的那条 entry 的位置"，批内只可能是外层 batch entry；而外层 `entryHash` 依赖外层 `argsHash`，后者依赖全部子哈希——单趟式无解。段一不碰世界，只做占位符替换、子操作预哈希、聚合与外层定位；段二才逐子应用，失败逆序 `undo` 回滚、世界逐字节不动。占位符 `{"$n": k}` 只能指向**本批内更早的 `put`**（只有它有产物 = def 键）；日志永远存**替换前**的 args，重放必然算出同一个 `argsHash` 与同一个外层位置。顺带收益：哈希性失败在世界分文未动之前就定论。落地的 `dup` 短路也长在段一上：全 `put` 幂等批预哈希后即可定论，跳过段 2。

补丁世代（`add_gen` 携带可选 `base`）把「每回合写整份 body」换成「base + 补丁」。补丁 def 的 body 形如 `{ops:[{op,path,value}…]}`，`op ∈ append|replace|delete`，`path` 是 `(str|int)[]`：`append` 列表追加 / 字符串拼接（路径不存在按值建列表）；`replace` 路径整体替换（中间容器不存在按下一段类型新建）；`delete` 删除路径（缺失即幂等成功）。组装 `assembleBody(base, ops)` 是纯函数：不改 base / 补丁，产物不共享补丁 value 引用。`base` = 同身份内基础世代的 `seq`（严格小于本世代），必须已存在且其 payload def 是合法补丁体，否则 `missing_parent` / `bad_patch`（fail-closed，世界分文不动）。`active` 对补丁世代同义：仍指向 `payload`（补丁 def 键），故 `set_active` 回滚语义不变。组装结果由**取用侧**（宿主投影）按世代链回溯算出，内核不组装、不解释 body 语义；读侧契约不变（投影仍回 `body`，另回 `data_gen` = 组装来源世代，供写方把下一世代写成补丁）。

补丁口径：`argsHash` 仍是 `H(args)`（含 `base`），链哈希口径不变；`sig` 仍是世代签名 def 键（补丁 def 亦可作 sig）。`worldRev` 的 gen 摘要吃 `base`，换 base 即换内容身份。回收时补丁世代的 base 世代必须一并保留（`retainedGens` 沿 base 追加），否则组装悬挂；`flattenPatches`（压扁）只折叠**安全链**——链内非末代不被 `active` 指向、不被任何世代的 `pins` 指向、不被链外世代的 `base` / `graft`（含跨身份）指向，满足才把线性补丁链折叠成单个整份世代（payload = `H({body: 组装结果})`），缩短链并消除 base 依赖，compact 可按 `flattenChain` 阈值调用。

压缩是追加一个新基础（快照），不是丢旧段。`snapshot` 是一条普通 entry，`args = { world_rev }`，位置由自身 `seq`/`entryHash` 唯一确定；应用时自校算出的 `world_rev` 与存值不符即 `world_rev_mismatch`——快照想锚歪都锚不了。三层全是"追加"：① 追加快照 entry（世界本体宿主落盘）→ ② 宿主把快照前段移冷存储 → ③ 上层把保留内容重写进新世界。没有删除，内核也不欠 `compact` 这个 op。归档不欠内核算法，但保留集有协议：尾段引用集 ∪ 快照世界各 active 世代的闭包，沿 `pins`/`payload`/`sig`/`schema` 遍历即得（规矩 A 保证结构依赖都在 pins）；移出 ≠ 删除。

基础世界的真源在宿主不在内核。快照只记凭证与位置，不携带本体；run 收到的世界是不是"这条链当前结果"，验证它等于重放全部历史不可负担，所以内核只在可按需算的凭证层面给工具（`worldRev`、`snapshot.args.world_rev`、`verify` 的 `expected.worldRev`），义务在宿主。

有界化回收（`recycle.ts`）是**上层策略**而非内核新动词：compact 写 base 时按可达闭包裁掉未达 def 与窗口外世代，冷段仍留历史，`verify`/`replay` 从冷段全链照常校验。故"`replay(尾段, 快照世界)` 与全量重放逐字段相同"这一长链硬判据**仅在未回收时**成立；回收后基础世界是全量世界的子世界，宿主以 `snapshotRev`/`worldRev` 区分二者。`RecycleSpec` 的 `keepRoots`（根闭包）与 `keepGens`（`{id, seq}` 机械并集，内核不解释数据 / 代码语义）供上层把「投影闭包」等策略保留集下传；`keepGens` 在固定点回填前并入，故其 `pins` / `graft` / `base` 依赖一并拉入。被淘汰世代不可再被 `set_active` / `graft` / 补丁 `base` 引用（分别报 `not_a_generation` / `missing_parent`），fail-closed。

## 六、取用的三种模式

取用即组装，三种模式精确对上已有 API：

| 模式 | 怎么做 | 校验 | 能提 write |
|---|---|---|---|
| `full` | `replay(全部 entry)` | `verify(全部)`，起点 `EMPTY_WORLD` 无需校基础 | ✅ |
| `partial` | `replay(尾段, 快照世界)` | **必须三步**：① 校基础 ② 校接驳 ③ 才 replay | ✅ |
| `base_only` | 直接取宿主存的基础世界 | 即空段调用 `verify([], anchorAfter(基础,快照), {worldRev})`——唯一能校基础的入口 | ❌ 只读投影 |

相关导出面（`journal.ts`）：`EMPTY_WORLD`、`EMPTY_HEAD`、`cloneWorld`、`pos`、`worldRev`、`applyEntry`、`replay`、`verify`、`entryHash`、`anchorAfter`。
定义表访问抽象（`defs.ts`）：`LAZY_DEFS`、`LazyDefsHandle`、`isLazyDefs`、`cloneDefs`、`defHas`、`defsKeys`——内核只经它们读 / 判存在 / 列键 / 克隆 defs 表，普通 map 与惰性代理行为一致；`cloneWorld` 与 `flattenPatches` 的复制都走 `cloneDefs`，不展开 body。

成对使用是硬规则。`replay` 只重建、不校验链——它内部不查 `seq`/`prev` 衔接，只查 `applyEntry` 成功与 `argsHash` 一致。于是 `replay(尾段, 错的基础)` 不报错：尾段一条本该撞 `id_taken` 而被拒的记录，接在缺前缀基础上却成功，于是算出链上从未被授权的世界。防"接错位"的责任全在 `verify`。`base_only` 的禁则是结构性的：写要 `expect_pos`，而 `pos` 是链头哈希，基础里没有——它只能当只读投影，正当用途恰好是"上下文 = 对日志的投影"这一闭环。

`verify` 自身从不抛：所有失败（含链内 `snapshot` 自校的 `world_rev_mismatch`）都转返回码 `{ ok:false, error }`；`replay` 的契约就是抛，失败即 `apply_failed`/`args_hash_mismatch`/`world_rev_mismatch`。

## 七、事件流语义的映射

事件流四行语义逐一落到内核实体，其中"编辑重放"一行必须挪一格：

| 事件流语义 | 内核里的实体 |
|---|---|
| append-only 执行日志 | `journal`：一条 `Entry` 一个事件，`prev` 串起 |
| checkpoint = 快照 | `op:'snapshot'`（记 `world_rev`，本体在宿主） |
| 恢复/断线续流 = 快照 + 增量重放 | `verify(尾段, anchorAfter(快照))` + `replay(尾段, 快照世界)`；效果未回灌部分靠 `waiting` + `results` 台账 |
| 编辑重放 = 截断 + 新分支 | **截断不给；新分支在身份层，不是链上一段** |

一条"线"是一个身份（`add_identity`/`fork`），线的一次状态是一个世代（`add_gen`，payload 指全量内容、**入世即激活**），"哪条线为真"记在 `Identity.active`——`set_active` 可随时改指（含指回旧世代）。于是"截断加新分支"表达成：从被编辑的世代 `add_gen` 一个新 payload（入世即激活）——旧线仍在链上，只是不再被取用。真截断禁止：删尾部 = 改历史 = 放弃"历史改不掉"。挪一格反而更强：旧线可审计，且旧线上已真实执行的效果有据可查，重放不会把已花掉的钱、已发出的请求再干一遍。行级归属用 `Entry.ref`：它是 entry 字段、被 `entryHash` 覆盖、内核不解释内容，宿主可按它分组/过滤。

唯一实质税必须记账：世界只增不减，而编辑重放系统的历史增速远大于最终状态——`defs` 字节 ∝ **总尝试次数**而非会话数。所以四档分层在此用法下不是优化，是前置条件。

## 八、四档：什么住在哪

热路径成本几乎全来自一个混淆——把"只是发生过的事"当成"决定世界现在是什么的事"。按"是不是声明" × "能不能重算"分四档，大小只是结果不是判据：

| 档 | 判据 | 住在哪 | 内核付什么 | 丢了的后果 |
|---|---|---|---|---|
| ① 声明 | 影响世界现状、需被引用/pin：**含源码文本** | `defs` + `ids` | 哈希、克隆、进摘要、进依附判定 | 不可丢 |
| ② 留痕 | 只需"发生过、不可抵赖"、不需被引用 | `Entry.args`，被链覆盖 | 一次 `H(args)` 进链；不克隆/不摘要/不进闭包 | 可归档，不可删 |
| ③ 可重算本体 | 大但能由 ① 重算 | 宿主**缓存** | 零 | 丢了重建即可 |
| ④ 不可重算本体 | 大且算不回来 | 宿主**持久存储** | 零（世界只存"哈希+平台"声明） | 丢了就真没了 |

③④ 在协议上同形——世界里都是一条"哈希+平台"声明，区别只在宿主保留策略。

源码的**声明与内容身份**必须在 ① 不因大而外迁：**字节本体**可住 ④（宿主侧内容寻址存储，CAS），但源码字节按 ④ 保留——可达集 = 全部世代、不按 ③ 丢弃，且必须随世界一起备份。三条理由按此重述后仍成立：**回滚承诺**（回滚插件 = `set_active` 指回旧 payload，一个记账动作，前提是 ① 的指针 def 仍在、CAS 字节仍被保留）；**依附判定**（换源码必须判得出旧内容失效，`pins` 得指得到它；指针 def 的键含 `sha256`，内容一变键就变，检出能力比内联形态只强不弱）；**无特权**（CAS 是 ③④ 大字节的通用机制，用户资产已在用，不是给源码开的专属例外）。

## 九、两条规矩

**规矩 A：结构性依赖只走 `pins`，`pins` 是唯一记录处。** 判据一句话——"被引用的那份 def 不在世界里，这份 def 还成立吗？"不成立 ⇒ 是依赖 ⇒ 必是 `pins` 一项；body 里的哈希只能是业务数据值。这样闭包 = 宿主沿 `pins` 只读遍历（内核仍不提供算法、不解释 pin 名）。残留洞要写明：内核无法强制（它不读 body），漏写 pins 不会被拒，只会让 `stale()` 静默失效——不报错的错，所以门禁以数据落在上层。依附判定 `stale(def, world, id)` 的口径：`sig`/`pins` 双缺 → 恒 false（宽松，要失效必须显式声明 pins）；`sig` 单侧 null 跳过比较（乐观），`pins` def 声明而 gen 缺名即坏（保守）；身份不存在或 retired → true（未知即隔离）。

**规矩 B：留痕走链，声明走世界。** `note` 是第二档的实现，现已放行任意 JSON 对象作载荷，换到的唯一东西是"不进 `defs`"（不克隆、不摘要、不进闭包），**不省哈希时间**——大字节塞进 note 只是把 RAM 墙换成时间墙。同载荷 `note` 提交两次是两条 entry（故意不去重，"处理过没有"归上层 `WriteRequest.id`，不归内核）。所以 ② 放摘要级、③④ 放本体，载荷大小由**宿主门禁**限制（不是内核常量——内核定大小就是认识语义）。

## 十、准入规则：内核只有名词没有动词

判断某样东西该不该进内核，只问一句：它是名词（机制/数据形态）还是动词（过程/动作）？动词一律不进内核。动词与归属：

| 动词 | 住在哪 | 依赖内核的什么 |
|---|---|---|
| 初始化（造第一个世界） | 上层/产品/agent 工具 | `commit` 的 `batch` 写 |
| 审核（该不该采纳） | 上层 | 求值器 + 效果（读世界） |
| 试跑 | 上层 | 求值器 + 单独一次调用 |
| 装载/替换实现 | 载体 | 无（内核不装载） |
| 执行/训练 | 上层 + 载体 | 求值器、日志、依附判定 |

内核不做：不装载、不 IO、不持久化、不调度、不审核、不审批、不挂起等人；不认识图/作用域/通道/路由/算子/LLM/工具/模型/UI；不定义载荷 schema、不定义判定标准、不定义分级表。

"轻"的度量是**名词数不是行数**：放开 note 载荷是 1 行、0 新概念，合法；加 `truncate`/`compact`/`index` 才违反——那是加动词。四向路由判据：少了它坏数据能进世界 → 内核（无第二条路，外包让"非法进不来"变靠自觉）；少了它某宿主算错自己的账 → 宿主；要语言生态/进程隔离/可丢弃可重算且协议往返 ≪ 单次任务成本 → 执行件；是判定标准本身 → 写成数据进世界（归约机存在的唯一理由）。三条推论都是反直觉的：**执行件永远不能承担校验**——它是宿主可换、可不在、可崩的东西，"闭包遍历""投影压缩"可以是执行件，"引用存在性"永远不行；内核轻的是名词数不是行数；**推给执行件常常是把自己系统的不变量换成一次 RPC**——典型反例是把哈希做成执行件：纯 CPU 的活既没吃到原生收益（进程内原生实现早已存在），序列化搬运反倒更贵，还引入"两份实现两份口径"的谱系分裂风险。

## 十一、第一方无特权

特权只有两处：内核（判什么合法）与载体（执行效果/持久化）。此外自己的代码和别人的代码一样外来。第一方数据（term/schema/定义包）经 `batch` 写入世界，与第三方数据完全同路；第一方代码（端口实现/适配器）以端口实现身份声明并装载，与第三方代码完全同路。没有"内建插件"或"出厂插件"这一档，没有内建目录。

三条约束：第一方必须声明和第三方一样的字段（`schema`/`pins`/`sig`），走同一 `put`/`batch` 路径、同一道门禁——想给第一方开后门说明接口缺一样东西，补接口不要开洞；第一方必须可被卸载/降权/下架，走同一条门禁；任何"只有第一方能做到"的事判定为 bug 或缺失接口。可测判据：卸载全部第一方插件，内核与其测试仍全绿（降级但能跑）。

## 十二、求值与续跑契约

入口/出口骨架（`KernelInput`/`KernelOutput`）：

```
KernelInput  = { world, head, run, directives: Directive[],
                 results: Record<Hash, EffResult>,
                 limits:{gas,depth}, caps, now }
Directive    = { kind:'eval', entry, args, ctx }
             | { kind:'extern', payload }
             | { kind:'write', request: WriteRequest }
WriteRequest = { id, op, target:{expect_pos}, args, ref?, by }
EffRequest   = { id = H({run,i,n}), port, method, args, caps }
KernelOutput = { world, journal, head, pending, observations, status, usage }
```

四态（`status`）：

| status | world/head | journal | pending | observations | usage |
|---|---|---|---|---|---|
| `idle` | input 的 | `[]` | null | `[]` | 全 0 |
| `waiting` | input 的 | `[]` | 该效果 | 已处理部分（挂起那条为 null） | 当前/峰值 |
| `refused` | input 的 | `[]` | null | 已处理部分 **+ 末尾 `{kind:'refused',reasons}`** | 当前/峰值 |
| `done` | 克隆体（已就地改完） | 本次 entry 列表 | null | 全部 | 当前/峰值 |

三条设计语义：**整次调用原子**（拒绝/等待/空闲返回的是输入世界、日志为空，克隆体只服务于 done）；**等待从不返回部分世界**（不捕获续体，结果由输入回灌，从入口重跑，走到同一 `eff` 取 `results[id]`）；**推荐一条 write 一个调用**（要原子写多份用一条 `batch`，这是 batch 的主要用途）。

**run 级并发**：多个 run 可同时活动——并发**只在 run 之间**，每个 run 内部仍是单 pending（eval 内不并行）。这是**宿主侧**改动（提交队列 + 乐观校验，见 `host.md` §五 写者），**不动内核 `run` 的语义**：`run` 仍是纯函数、单 pending、`expect_pos` 单链头 CAS。宿主把各 run 的 `commit` 进单一提交队列串行落账，冲突（base `worldRev` 不符）时按续跑纪律重提交（同 `run_id`/`now`、`results` 只增不改，重试占新 `seq`、入账可辨）。仲裁序 = journal `seq`（链序），**无需在 `Entry`/`Op` 加新字段**。§十四边界 5「单链 CAS、不做多链合并」不变——并发 run 都写**同一条单链**。

效果身份 `eff_id = H({run, i, n})`：`i` 是 directive 序号，`n` 是该次求值内效果序号——序号要带，否则一次调用内多次求值碰撞。不捕获续体的代价：单 pending 是严格求值下界（同时挂起多个语义上不可能）；一个 directive 内 k 个效果 ⇒ 总成本 O(k²)（每次续跑重放前缀），由 `limits.gas` 封顶不会失控但按期付。纪律：效果放叶子、长循环拆多 directive（`i` 不同 ⇒ 各自前缀更短）。门外逃生舱（宿主侧，不破不捕获续体）：真正贵的是重复触碰真实端口而非重放纯计算，效果身份确定 ⇒ 宿主可按 `(port, method, canonicalJson(args))` 缓存幂等端口结果，把外效应摊平到 O(k)；但宿主不能"从第 k 个效果续跑内核"——那需捕获续体。

观测流是派生视图不是状态：不落盘、不入世界、一个 directive 至多一条、挂起时不产出。但拒绝/等待时照常返回——内核能在整次调用作废时仍诚实告诉你为什么作废，因为观测是拒因的唯一载体（`KernelOutput` 不另设 `reasons` 字段），不承载状态 ⇒ 同输入重跑得同一条流。

两条续跑纪律（写死）：**续跑契约**——`waiting` 之后必须以同一 `run_id`、同一份完整 `directives`（含已执行完的前缀）、同一 `now` 重调，`results` 只增不改；任一漂移都会让"续跑"与"一次跑完"不再逐字节一致（`i` 是 directive 下标、`now` 进 `entryHash`）。**观测只是诊断不是账**——`refused`/`waiting` 的 write 观测里的 `pos` 是"若本次成功它将落到的位置"，随整次调用作废；任何消费者不得据此推进或落 checkpoint，真实位置只认 `done` 输出里的 `head`/`journal`。

## 十三、表达力边界：为什么只有八个原语

机器侧两个"造不出"：运行期造不出新 def（`eval` 值域是 Json，写世界只经 directive 在机器外）；运行期连新哈希都算不出（`H` 不是求值原语）。由此**终止性是结构保证**：引用一律经哈希，两者都只能指向已存在的 defs；调用图恒为 defs DAG 的子图，`fold` 受集合长度限制，`gas` 管资源上界。

八个原语（term 语法，`kernel.md` §12.1）：

```
Const ["c", Json]          Get ["g", Path]         Var ["v", int]
Cmp   ["cmp", T, T]→-1|0|1 If  ["if", T, T, T]     Fold ["fold", coll, init, step]
Eff   ["eff", port, method, args]                  Call ["call", fTerm, [T...]]
```

无 lambda、无递归、无 while。`Call`/`Fold` 的函数侧为 Term（求值结果须是 64-hex Str），即函数作为一等值。三条裁决在写机器前定死，且完成了第一例不可派生性裁决：**let 可派生 ⇒ 永远是写期宏**（展开产物是数据，重放同路；用哈希引用使重复出现只付一份 def 且效果恰好一次）；**lambda 不可派生且证明后仍拒绝**（构造出的函数无身份、无世代、无 pins/sig，进不了依附与判决，是内核负资产，宁缺——真要生成性走多次续跑的写期生成）；**高阶需要且已给**（函数即值，可入列表/ctx/运行时选择，但永远只选中已存在 defs 里的函数）。高阶的代价写明：函数侧计算化后，字面引用不再是 body 里穷举可得的静态依赖图——"扫引用算影响面"从语法层沉到运行时；内核从不承诺静态可分析性，引用完整性的机械校验只吃**内核认识的字段**。顺带一条常被误当成缺失的能力：机器无环境捕获（每次调用的环境 = 显式 args），所以"闭包/部分应用"= 把已绑参数做成数据与函数哈希一起走，是同一件事的另一种写法。原语只增不改语义：老日志不含新原语仍可重放，新日志在旧实现上报 `bad_term` 拒绝执行而非算错——这是不必给世界加版本字段也能保住"历史可重放"的原因。

## 十四、信任与边界

输入边界写死不扩：世界是一份完整输入，内核不认识文件/数据库/网络；时钟与随机来自输入（`now` → `Entry.at`），内核不取；能力表来自输入且**恒等于输入**（`EffRequest.caps` 恒等于 `KernelInput.caps`），内核不扩权不改权；效果只被请求从不被执行；单链 CAS，`expect_pos` 只有一个链头，多世界合并不在射程——答案是"再开一段账"而非"加 merge"，因为合并语义要求认识冲突 = 认识语义。

**内核给一致性不给正确性。** 身份/来源：`id` 永不复用、`by` 进链、`ref` 可指向审计记录，但 `by`/`id` 的真实性内核不验（`by` 当不透明字符串，`id` 是标签不是认证）——归上层审核/宿主认证。内容合法性：`commit` 机械校验覆盖形态/引用/位置/不变量，但"改得对不对"内核不管。效果执行：`EffRequest`/`EffResult` 都是可审计数据纸，但结果内容可信度内核不校验，端口返回什么照单回灌——这是全系统最大信任面，落在宿主显式契约上：**宿主必须为每个 `EffRequest→EffResult` 留存配对审计记录并 `put` 成 def、经 `request.ref` 指向它**；否则"世界可追溯"只对写成立、对效果不成立。

宿主契约几条破了内核就白干：

- **落盘字节保真**：不得重新序列化 `Entry.args`。数字精度/键序/代理码元任何漂移都让 `argsHash` 对不上，损失不是某条记录而是整条链在那个位置断。判据只有一条——**能否逐字节还原**：编解码器（gzip/zstd 字典/块级差量）合法，语义往返（parse 后 stringify、按字段重建、丢未知字段）非法。前者是压缩，后者是改写。
- **基础一致性内核不校验也校验不了**：从任何非空基础起组装前必须先校基础（§6 三步成对的①）。
- 效果侧审计、装载、调度、保留策略、投影与压缩都是宿主动词。热装载按改动分两路：改**数据**（term/参数/配置）→ 宿主感知链头推进、按新哈希重取 def、换缓存即热生效、进程不动（内核本就每次 `eval` 读当前 `defs`，无重装载概念）；改**代码** → 按哈希查构建缓存 → 起进程 → 旧进程排空退出。内核只记"当前生效是哪一代"（`add_gen`/`set_active`），从不过问进程。

## 十五、五处设计决定（ADR）

| # | 决定 | 理由 / 代价 |
|---|---|---|
| D1 | 位置与内容两份身份分开；`worldRev` 按需算、摘要不吃履历 | 内容哈希须覆盖语义，但挂每次写入退化成 O(世界)/条。代价：跨实现键排序必须写死 |
| D2 | 不捕获续体：结果回灌后从入口重跑 | 确定性重跑即复现。代价：O(k²) |
| D3 | 效果身份 = `H({run, i, n})` | 只带 `n` 会在一次调用内多次求值时碰撞 |
| D4 | 错误一律抛 `KernelError{code}`，只在 `run` 边界 catch 转 `refused` | 内层返回类型保持干净（值就是值）。代价：错误码表成为契约 |
| D5 | 链哈希是 Merkle 的（`argsHash` 进 entry，链只吃它） | 见 §五。代价：`Entry` 多一字段，口径不可改 |

哈希取 sha256 全长不截断：`pos`/`worldRev`/一切 def 键/pin/sig 都压在这把哈希上，碰撞直接击穿"id 永不复用"与"内容寻址"两条地基。截短零收益，换窄换宽只动 `H` 一处，但那要作为整条链格式的变更走"换链"裁决。

## 十六、已知规模边界

来自仓库内实验，绝对值随机器而变，只引用比率与量级：内核纯 JS 哈希比宿主进程内原生哈希慢 40–58×（早期更高倍数是 JIT 预热差工件）；世界必须整份在内存（`defs` 只增不减）= RAM 墙；日志自带全量载荷，盘上体积 ≈ 语料 1×；重复提交同内容成本约为一次真写的 7–9 成（判决在完整应用之后，幂等短路省幅上限一半）；链哈希 O(1)、`worldRev` O(def 数)。

两堵墙：**时间墙**——大字节继续走 `put`，全量审计成本 ∝ 语料字节 ÷ 内核哈希速率；快照分界把日常重启变只付尾账（与全量重放逐字节等价），所以时间墙实际落在"完整审计"这一次。**RAM 墙**——① 档字节数无可调上限，约束形式是 `defs` 字节 ≪ 进程可用内存。宿主侧基础世界已按 def 分片落盘、启动按需加载（`DefStore` + 惰性 defs 代理），常驻只含清单与 LRU 命中集；但内核全量重放（从空世界重建）仍整份在内存，故这条约束对 `replay` / `verify` 全链路径依旧成立。四条对策都不破不变量：`dup` 短路（全 `put` 幂等批预哈希后即定论跳过段 2）；大字节不走 `put`（③④，链只承诺哈希值不承诺谁算的）；`note` 承载载荷切断"历史增长率 = 热路径增长率"；快照分界 + 归档协议把全量重放降为可选择的审计动作。字块化哈希只是止血非良止血（实测上限 1.4–1.6×）——纯 JS 实现层近乎无路，性能只能靠上面四条活路。源码留 ① 接受"每次全量审计重哈希一遍"的保险费，按真实尺度很低且被快照移出日常路径，大型仓库下真正约束是内存不是 CPU，搬出世界省的那点钱代价是放弃"代码回滚 = 一个记账动作"——不值。

## 十七、不变量守住什么

每条不变量是某条承诺的可执行形式（权威编号在 `kernel.md` §14，共 16 条）。分组：

- **重放一致**：`replay(journal)` 与 `run` 逐字段相同（含 `ids` 的 `at`/`by`/`write`）。
- **失败不留痕**：校验/应用失败后调用方世界与日志分文未动。
- **纯与无外部**：非测试代码 import 只允许相对路径；无 `node:`/第三方/`Date`/`Math.random`/`fetch`/`process`。
- **依赖形状**：`defs`/`ids` 赋值只在 `journal.ts`；`commit` 只调 `applyEntry`，自己不写。
- **不扩权**：任意 term（含嵌套 `eff`）产出的 `EffRequest.caps` 恒等于输入。
- **链格式**：`argsHash` 口径、唯一回填点（`commit` 回填、`applyEntry` 不改传入 entry）、`Entry` 不被就地改写（深 `Object.freeze` 冻结桩）。
- **留痕不进世界**（规矩 B 的可执行定义）：只含载荷 `note` 的链，`replay`/`run` 结果与 `EMPTY_WORLD` 逐字节相同、全程 `worldRev` 不变、`defs` 键数与 note 条数无关；同载荷 `note` 提交两次 → 两条 entry（`dup` 不适用）；改载荷不改 `argsHash` → `args_hash_mismatch`。

## 十八、明确不做什么

内核的价值大部分来自它拒绝成为的东西：

| 不做 | 为什么 |
|---|---|
| 可达闭包遍历 | 要求认识 body 里的引用标记 = 认识语义。规矩 A 收窄的是"上层不必解析 body"，不是"内核提供算法" |
| 内容回收/删除 | 内核没有删除；缩小世界由上层重建 |
| 效果执行/重试/超时 | 内核只发射，执行是宿主的事 |
| 审核判定/排程 | 都是动词，在上层 |
| 求值记忆化/捕获续体 | 撞 D2。记忆化只改常数不改 O(k²) 的阶，却引入可变缓存与失效面，含 `eff` 子树不可缓存 |
| 换哈希 | 口径是链格式的一部分（D5），换哈希 = 旧链不可重算，破坏自证向量与跨实现可复现 |
| `worldRev` 增量维护 | D1 已挪出热路径；增量维护要可变缓存 = 引入状态，破纯函数承诺 |
| 哈希做成注入/端口/执行件 | 内核 `H` 必须唯一不可协商；可注入会让不同宿主产生"同内容不同键"的谱系分裂，动摇身份地基 |
| 索引进内核 | "按内容查留痕"是宿主派生物，可从日志重建、丢了不损真源；加索引就是加动词 |
| 第二个写口 | M4 全部价值在于只有一个门 |
| 多链合并 | §十四边界 5 |
| 分类字段 | 没有 `class`、没有标签位、没有内建特权 |
| 判断合理性与正当性 | 内核只判机械合法性 |

---

### 附：公共导出面（`index.ts`，评审只从公共面导入，加导出 = 改规格）

| 模块 | 导出 |
|---|---|
| value | `TYPE_ORDER`、`t`、`canonicalJson`、`deepEq` |
| hash | `utf8`、`sha256`、`H` |
| defs | `LAZY_DEFS`、`LazyDefsHandle`、`isLazyDefs`、`cloneDefs`、`defHas`、`defsKeys` |
| patch | `PatchOp`、`PatchPath`、`assembleBody`、`readPatchOps` |
| rebase | `flattenPatches`、`FlattenResult` |
| recycle | `recycleWorld`、`RecycleSpec`、`RecycleStats`、`RecycleResult` |
| journal | `EMPTY_WORLD`、`EMPTY_HEAD`、`cloneWorld`、`pos`、`worldRev`、`applyEntry`、`replay`、`verify`、`entryHash`、`anchorAfter` |
| commit | `commit`、`validate`、`entryOf`、`stale` |
| machine | `eval`、`cmp` |
| run | `run`、`observationsOf` |
| types | 全部类型（`Json`/`Hash`/`Path`/`Def`/`Gen`/`Identity`/`World`/`Head`/`Anchor`/`Op`/`Entry`/`WriteRequest`/`EffRequest`/`EffResult`/`Directive`/`KernelInput`/`KernelOutput`/`CommitResult`/`CommitOutcome`） |
