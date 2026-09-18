# 宿主计划：载体（Done）

> 口径来源：`docs/kernel.md`（内核设计）+ `docs/host.md`（载体设计）+ `docs/plugins.md`（插件设计）。
> **设计口径在 `docs/host.md`；本计划写"怎么做"，含算法伪代码。** 冲突时以 `host.md` 为准。
> 本计划只做**载体**；不含任何真实能力插件，只用 **toy 服务**验证机制。

---

## 目标

做出载体：宿主读世界 → 按声明起插件服务 → 连接 → 调用 → 执行效果 → 落账 → 重放。
此后所有能力（含编排逻辑——写成 term / 声明）都以「世界里的声明 + 自带服务进程」的形式加入，
**不改载体代码**。

## 前置

- `packages/kernel` 已存在且冻结。
- `docs/host.md` 的设计口径已定稿。

## 本阶段口径

- 实现严格按 `docs/host.md` §五 的设计口径；本计划的 A0–A14 是它的实现规格。
- v1 从 `EMPTY_WORLD` **全量重放**，无快照、无 `partial`。
- 只用 `fixtures/plugins/` 的 toy 服务验证，不引入真实插件。

---

## 关键算法（A0–A14，实现规格）

### A0 · 入世（文件树 → defs）

```
ingest(entry):                             # entry = state/plugins.json 的 {name, path?}；写动作（经 commit），非 assembly 的只读
  root = resolve_pkg(entry)                # 有 path 按路径解析（本地 / toy），无 path 走 Node 解析（node_modules）
  ign = read_worldignore(root)                # 可选：包内 .worldignore，每行一个相对路径（按路径段前缀匹配；# 注释 / 空行忽略）
  for f in walk(root) \ {node_modules, .git} \ ign:   # 通用排除 + 插件声明排除
      blob[f] = put({ body: read(f) })         # 文件 → blob
  # 契约必需文件（plugin.json / package.json / 锁 / README / plugin.json.schema 指向的文件 / commands entry·argsSchema / members 路径本身）不可被 ign 命中；命中 → 整批拒绝（bad_worldignore）
  tree   = put({ body: { entries: [...] } })   # 目录 → tree，递归
  commit = put({ body: { tree, meta } })       # 一个世代 = 一个 commit
  # 契约层引用的包内文件各自成 def（入世解析）：
  schema  = put({ body: <schema/ 解析> })      # plugin.json.schema 指向的文件 → Identity.schema
  for t in topo(terms/*.json):                 # 包内先拓扑序（A0b）
      put(termDefOf(<把 $ref 替换成 callee def 键后的 AST>, sig = commit))   # 每个 term 一条 def
  cmdArgs = put({ body: <argsSchema 解析> })   # commands[].argsSchema → def；还要过方言元校验（白名单子集），否则 bad_args_schema 拒包
  # 两类占位符不同：内核批占位符 {'$n':k}（指向批内更早的 put）；term 源占位符 {'$ref':path}（宿主解析成 callee def 键）
  # 入世写批 = batch{ add_identity?, add_gen }   ← add_gen 同时激活（journal.apply.ts:180）
  #   （首次含 add_identity；换代只 add_gen）——不需 set_active
  #   上面的 put 都是**该批的子操作**（入世整体原子）；add_gen.payload / sig / add_identity.schema
  #   用 {'$n':k} 占位指批内更早的 put（journal.apply.ts substitute）
  # pins：作者写身份名 → 宿主解析成被依赖身份 active 世代 payload 哈希
  # schema 门禁：机械校验不过 → 整批拒绝，世界分文未动
```

- 入世是**写动作**（经 `commit`），不是 assembly 的只读；assembly 只读结果。
- **提交方**：v1 的 `seed`（离线、宿主未运行）**直写 `commit`**（与 A7 审计同属「宿主侧直写 commit」）；
  运行时入世由发起者经 directive 走 `run`。`add_gen` **同时激活**（`journal.apply.ts`），故入世批**不需** `set_active`；漏了 `add_gen` 才会 `active = null`、永不装配。seed **逐包一条 batch**：某包被拒（`unresolved_pin` / `term_cycle` / `bad_worldignore` / `bad_term_ref`）**不阻断其他包**，最后汇总失败清单。另有本地声明 / 文件类失败码（`package_not_found` / `missing_plugin_json` / `bad_plugin_decl` / `missing_schema` / `missing_entry` / `missing_args_schema`），只进 seed 报告，不进协议错误码。
- 与 A5 物化互逆；源码住 ①（`kernel.md` §八）。
- 宿主**只解释 `plugin.json`**；`package.json` / 锁文件是源码 blob（供物化后由 `decl.start` 装依赖），不参与契约解析。包源由 `state/plugins.json` 给出（**不分来源、同形**）。
- 身份 schema（`Identity.schema`）：`plugin.json.schema` 指向包内 `schema/` 文件 → 入世解析成 def 哈希 → 写进 `Identity.schema`；它是身份的**自述 / 数据契约**（数据、非特权），宿主对 `plugin.json` 形状的元校验另有一份宿主侧 schema。
- **命令名保留字（S4 落实）**：`start` / `stop` / `run` / `status` / `seed` / `verify` / `replay` 是宿主命令名，`commands[].name` 命中即整包 `bad_plugin_decl`（`plugin.json` 形状门，入世与运行期读声明同口径）。
- **`sig` 口径**：`add_gen.sig` = 本世代 `commit` def 键（= `payload`）；term def 的 `sig` 同值。世代签名即"这一代源码 / 声明"的内容定址，重放可复现。
- **入世需按身份级依赖序**：`pins` 解析要求被依赖身份已在世界里（`world.ids[depId].active`），否则报 `unresolved_pin`。故 seed 按 `state/plugins.json` 顺序逐包入世，或先入被依赖者再入依赖者（同批内顺序即依赖序）。
- **排除机制**：通用排除（`node_modules` / `.git`，前者本就是宿主侧 ③）+ 插件 `.worldignore` 声明项；宿主**不内置** `dist` / `test` / `.venv` 等语言 / 构建名字（守「不认识语言」）。契约必需文件不可排除，否则 `bad_worldignore` 整批拒绝；畸形 `.worldignore`（含 `..` 段 / 读取失败）同样按 `bad_worldignore` 拒绝。测试在包目录跑、不入 ①。
- 作者不算哈希（不变量 9），`pins` 的哈希与 term 内 callee 引用的替换哈希由宿主在入世时解析（A0b）。

### A0b · term def 入世与 callee 引用（占位符机械替换）

```
# term 源（terms/*.json）里对同包 callee 的引用写成**占位符**（单一保留键，如 {"$ref":"terms/foo.json"}）；
# 入世时宿主**机械替换**成该 callee def 的哈希——与 batch 的 {"$n":k} 同构：只替换、不解释语义。
# term def = put 的 Def{ body: <替换后的 AST>, sig }
#   body 里 Call 的函数侧最终是 callee 的 def 哈希（机器按 env.defs[hash] 直查，machine.ts 不读 pins）
#   term def **不写 pins**：callee 哈希是 body 里的数据值（host.md §五 路由），不是身份级依赖
```

- **作者不算哈希（不变量 9）**：term 源只写包内相对路径；替换在入世时由宿主做。替换规则是**纯结构**的
  （枚举 `$ref` 保留键、不解释 Call 语义、不推断依赖），故宿主仍「不认识语义」。
- **包内先拓扑序，成环整包拒**：入世先对**声明的** `$ref` 图（枚举保留键，纯结构）跑环检测；
  无环 → 按拓扑序 callee 先 put（哈希已知）、caller 的 body 把 `$ref` 替换成 callee 哈希；
  有环 → `reasons:['term_cycle']`，**只拒该包 batch**（世界分文未动），`state/plugins.json` 里其他包照常入世；
  `$ref` 指向包内不存在的成员 → `bad_term_ref` 同拒。
  注：A2 的闭包只沿身份级 `Gen.pins` 走、**看不到 term 内部引用**，故 term 环必须在入世判，不是 A2 的运行期隔离。
- **term-def pins 与 `Gen.pins` 分属两域**：内核 `stale(def, world, id)` 比对的是 `def.pins` 与 `gen.pins`
  （身份级、值为被依赖身份 payload 哈希）。term-def pins 若放 callee def 哈希会与 `gen.pins` 不匹配而**立即 stale**，
  故 callee 引用只作 body 数据值、不进 pins。
- 规矩 A 的落点：**身份级**（跨身份）依赖走 `Gen.pins`；term 内 callee 是**本身份内**的函数值。
  漏写身份级 pins 不会被拒，只让 `stale()` 静默失效（`kernel.md` §九）——门禁以 schema 落在上层。

### A1 · 能力类名 → 端点解析（路由）

```
resolve(emitter, cap, method):          # emitter = 当前 directive 入口 def 的属主
  h = emitter.active_gen.pins[cap]
  if h == null: fail(unresolved_cap)          # 不猜、不兜底
  d = world.defs[h]
  if d == null: return handle_stale(emitter, cap)
  impl = owner_of(d)                          # pin 绑定的是身份，不是版本
  if impl == null or impl.retired or impl.active == null:
      return handle_stale(emitter, cap)
  gen = impl.active                           # 世代跟随：永远取依赖当前 active
  if cap ∉ impl.implements: fail(not_loaded)  # 别名必须是目标声明的能力类
  ep = EndpointTable[impl.id + gen + cap + method]
  if ep == null: fail(not_loaded)             # 绝不回落旧世代
  if h != gen.payload: lifecycle_log(dep.drift, emitter, cap)   # 漂移证据，不阻塞
  return ep
```

- 发出者 = 当前 directive 入口 def 的属主（宿主构造 directive，故知道）；`eff_id` 的 `i` 给出是哪条。
- **发出者解析实现口径（S4）**：宿主为每条 directive 随行携带 `owner`——命令入口取声明身份；plan 产出条目继承产出它的 eval 的 owner（term 的 `Call` 只在本身份内）；入站直提 eval 只认「已声明命令入口 → 身份」，其余 fail-closed（无 owner ⇒ 不路由，审计记 `unresolved_cap`）。跨身份 entry 不在纪律内，故不做运行期树的 term→identity 反查。
- **eff → directive 定位（S4）**：`eff.id = H({run,i,n})`；宿主取「观测数 = 已完成 directive 数 = 挂起所在的 `i`」，同 directive 内 `n` 恰为已回灌效果数，直接重算候选比对（O(1)）；不符才线性兜底扫描；定位失败 fail-closed（不路由）。
- **漂移证据去重**：按 `(emitter, cap, 依赖世代)` 只记一条 `dep.drift`，不随每次调用刷运维日志。
- **`pin` 绑定身份**：依赖换代 → 重解析到新 active，发出者进程 / term / body 不动。
- **端点表键不含调用方**（`impl+gen+cap+method`，`gen` = 依赖当前 active）——换实现只改 `pins` 指向。
- `pin` 名即调用点名（= `port` = 端点表查表用的 `cap`）；**降级链**用多条**别名 pin**（每个单值、指向另一身份、别名是目标声明的能力类），降级顺序由 term 判定、宿主不自动重试——见 `host.md` §五 路由。
- 纪律：term 的 `Call` 只在本身份内；跨插件一律走 `eff`。
- 只读世界与运行态，不执行效果。
- **A1 读 `impl.active` 自 run 锚定的世界**（`KernelInput.world`），不是宿主侧可变 identity 缓存——
  故一次 run 内 active 不变（`put` 审计只加 def、不改 `active`），换代只对下一 run 生效（A6 在 `done` 后切端点表）。

### A2 · `pins` 闭包 + 拓扑序 + 环检测（坏分支只隔离）

```
roots = { id | world.ids[id].active != null }
edges = { (A,B) | A ∈ roots, ∃ h ∈ A.active_gen.pins: owner_of(world.defs[h]) == B }
# owner_of 靠 ③ 反查索引 Map<defHash, identityId>（装配期建、身份换代增量更新），O(1)
sccs, rtopo = tarjan(roots, edges)          # 单趟出 SCC + 逆拓扑序（被依赖者先起）；无环身份即 size-1 无自环 SCC
cycles = ∪ { s ∈ sccs | |s|>1 or has_self_loop(s) }
bad = cycles ∪ reverse_reachable(cycles)    # 环成员 + 其依赖者
for d in bad: lifecycle_log(dep.cycle, d); mark(d, not_loaded)   # 只隔离坏分支
for d in roots \ bad:                         # 其余照常起；自身世代不完整 / 依附失效者隔离
    g = active_gen(d)
    if g == null or world.defs[g.payload] == null or world.defs[g.sig] == null
       or stale(world.defs[g.payload], world, d):
        lifecycle_log(dep.stale, d); mark(d, not_loaded)
    else: mark(d, loaded)
order = rtopo \ bad                          # 启动序
```

- `pin` 绑定**被依赖身份**，边落到该身份的**当前 active 世代**；反查 def→identity 靠按 `World` 对象缓存的索引
  `Map<defHash, identityId>`（从 `ids.gens` 重建；世界换代即随新世界对象重算，不依赖装配期可变缓存）——A1 / A2 共用它，O(1)。
- **Tarjan 单趟**即同时出 SCC（环）与逆拓扑序（启动序），无需再单跑一趟 topo_sort。
- 环**不再整体拒绝**：环成员及其依赖者标 `not_loaded` + 记 `dep.cycle`，其余照常起。
- `stale()` 判定口径见 `kernel.md` §九。

### A3 · `stale()` 处置

```
if phase == assemble and (A's pinned dep retired/missing or A itself stale):
    lifecycle_log(dep.stale, A); not_loaded(branch)      # 坏分支隔离（含依赖者）；绝不拿旧实现顶上
if phase == runtime and A's own active gen changed:
    reassemble(A)                                     # 见 A6
if phase == runtime and A's pinned dep retired / set_active(null):  # 依赖没了（≠ 换代）
    isolate(reverse_reachable(retired_dep))     # 种子 = 退役身份，含 A 自身及其依赖者
    lifecycle_log(dep.retired, A)               # 运行期 fail-closed，与装配期同口径
# 依赖换代（新 active 已装载）不重装 A、不隔离：只由 A1 重解析路由
```

### A4 · 握手（声明 vs 实际能力的机械校验）

```
send(hello); m = recv(manifest)                # 经服务 stdio：写 stdin 发 hello、读 stdout 收 manifest
ok = (m.v == <服务协议版本>)                     # 信封版本不符同样按握手失败收口（服务侧不产 protocol_mismatch）
 and (m.protocol == decl.protocol)
 and (m.identity == decl.identity)
 and covers(m.implements, decl.implements)     # 不得少
 and covers(m.methods, decl.methods)
 and (m.state == decl.state)                   # v1 只允许 recomputable
if !ok: kill(proc); lifecycle_log(handshake.failed, proc); mark(reverse_reachable(proc.id), not_loaded)   # 该插件及其依赖者
# manifest 不是 JSON / 回错消息种类（protocol_error）同归 handshake.failed；起服务 / 通道类失败记 service.start_failed
# 多出来的能力（m.implements \ decl.implements）不登记：端点表只按 decl.implements 建行；多余项丢弃 + lifecycle_log(handshake.extra_dropped, proc)
```

**只查形态，不查语义**：不查实现对不对、不跑测试、不校验业务语义。

### A5 · 源码树 def + 物化

```
blob   = { body: <UTF-8 文本> } | { body: <base64>, enc: 'base64' }   # 后者存非 UTF-8 可逆的字节资产
tree   = { body: { entries: [{ name, mode, hash }] } }
commit = { body: { tree, parent?, meta } }
# 一个插件世代 = 一个 commit def；Gen.payload = commit 键
# commit.tree = 包内源码树 − 通用排除（node_modules / .git）− 插件 .worldignore 声明项
#   契约必需文件（plugin.json / package.json / 锁 / README / schema / commands / members 路径本身）不可被排除

materialize(id):
  c = world.defs[id.active_gen.payload]
  root = state/runtime/materialized/<c.hash>/   # ③ 可重算；写暂存目录 + 宿主标记后原子改名
  if exists(root) and marker(root) == c.hash: reuse(root)          # 标记不符 → 整目录重物化（防半棵树）
  write_tree(root, walk(c.tree))               # commit → tree → 递归 blob（文本按 UTF-8、base64 按字节）
  spawn(decl.start, cwd = root, stdio = stdin/stdout 管道)   # 宿主接管 stdio；协议走管道、日志走 stderr；宿主不认识语言 / npm
  # 依赖安装 / 构建由 decl.start 自负（宿主不执行 npm install）；spawn 失败 / 立即退出 → lifecycle_log(service.start_failed, id, reason)
  # 服务写进物化目录的文件（缓存 / 计数器等）不是源码树的一部分，也不保证跨代保留
```

### A6 · 世代跟随（链头推进 → 换代 → 原子切换 → drain）

```
affected = { id | id 自身 active 世代变化 }          # 只含自身换代，不含依赖者
on_commit_ok(head_advanced):
  for id in affected:
    if only_data_changed(id):                       # 见下：members 驱动，非目录名
        refresh_def_cache(id); send(reload); await_ack(id)        # 进程不动
    else:                                           # execute 成员的源码变了
        swap_service(id, new_gen)                   # = materialize+start+handshake+原子切换+drain（换代路径；A11 重启用 restart_service）
  for retired in { id | 本次 commit 使某被依赖身份 retire / set_active(null) }:
    for d in reverse_reachable(retired): lifecycle_log(dep.retired, d); mark(d, not_loaded)   # 运行期 fail-closed（A3）

# only_data_changed(id)：按 members 声明跨代比对「路径 + 解析内容（文件 / 子树哈希）」——
#   任一 execute 成员路径增删 / 内容变化 → code（起新服务）；仅 term/schema 变化 → data（reload）；
#   两类都有 / 同路径两用 → code（execute 优先）。不按 terms//execute/ 目录名硬编码。
#   声明读不出（缺 def / 坏声明）→ code（保守）；未声明成员的变化看不见 → data。
# swap_service(id, new_gen)：换代——materialize → start → handshake → EndpointTable.add(new)+mark_old(draining) →
#   drain(old, decl.restart.drain_ms)；drain 期间暂停该服务 health 探针（见 A11）；超时强杀 + lifecycle_log(service.exit, old_proc)
#   排空收尾后旧 gen 端点行摘除；旧服务退出记 service.exit reason 'superseded'（可观测）
# restart_service(id, gen)：同 gen 重启（进程已死、无旧行并存）——materialize → start → handshake →
#   EndpointTable 覆盖旧行；无 drain（见 A11）
# EndpointTable 键含 gen ⇒ 在途 run 锚定旧世代，换代只对下一个 run 生效
# 依赖换代不重装：宿主只重解析解析目标（A1），新 active 行已在表内
# assembly 只跟随、不改 active：set_active 是内核 op
# 跟随时机：每轮 done 落账后、下一轮之前（rounds 的 onAdvanced 钩子，宿主注入 applyWorld）；
#   同一次提交内 plan 的后续轮与下一次提交都按新世界路由；审计 put 不改 active，不触发跟随。
# 已离开 active 的旧 gen：在途退避重启排程作废（active ≠ service.gen 即不重启），绝不复活旧世代。
# 新身份（active null → hash）/ 曾为数据身份者：按装配同路起服务（依赖未装载则隔离）。
# 退役隔离：对 reverse_reachable(退役身份) 的每个身份各记一条 dep.retired，再统一下线（停服务、摘端点）。
# reload 未被 ack / 超时 → 保守按 code 路径（起新服务 + 旧 drain），不把旧进程当已热更新。
```

### A7 · `EffectAudit` 落账顺序

```
execute(eff):
  ep = resolve(emitter_of(eff), eff.port, eff.method)
  if ep == null: result = { ok:false }                       # 未解析 → 没执行 → refused
  else:
    try:
      resp = call_endpoint(ep, eff.args, timeout)
      result = resp.ok ? { ok:true, value: resp.value }
                       : { ok:true, value: { error: resp.code, message: resp.message } }  # 有响应 → 值，term 可分支
    catch transport_error:                                   # 连接 / 帧 / 进程死亡 / 超时
      result = { ok:false }                                  # 没执行 → refused
  audit_def = { body: { request: eff, result, port, method } }   # put 载荷 = Def{body}
  h_audit = H(audit_def)                       # 审计 **def 键**（= H(Def)；`ref` 指向世界里的 def，见 commit.ts checkRefs）
  commit(head, world, WriteRequest{ op:put, args:audit_def, by: initiator, ref: null }, now_round)
                    # 宿主侧直写 commit（不经 run directive）；进 ① defs、必须可寻址；失败也落；dup 幂等不产生新 entry
  # 后续业务写：WriteRequest.ref = 紧邻 eval 段内最后一条 eff 的 audit 哈希（分相后 write 轮无 eff，见 A10）
  return result
```

- **审计 `put` 是宿主对 `commit` 的直接调用**（不经 `run` directive）——宿主侧唯一与 A0 `seed` 同类的直写；
  原因：审计 def 必须在业务写之前就可寻址，而续跑纪律禁止改 directives，故审计不能走 run directive。
  `at` = 该轮 `now`；`by` = 发起者；审计 entry 自身 `ref` 留空（它是**被指者**，不是指者）。
- **`timeout` 来源（S4）**：宿主常量 `DEFAULT_CALL_TIMEOUT_MS = 30s`，`HostOptions.callTimeoutMs` 可覆写（`plugin.json` 无此字段）；
  超时与连接 / 帧 / 进程死亡同归「没执行」→ `{ok:false}`，不自动重试。
- **审计 entry 幂等键（S4）**：`id = audit-<eff.id>`——续跑 / 重放重复执行同一 `eff` 不产生第二条审计 entry（def 已在世界，`ref` 仍可指到）。
- 审计与业务写 v1 **分两条 entry**；合成 `batch` 会让 `ref` 语义变复杂，后置。
- 审计 `put` 会推进链头：续跑下一轮必须用**审计后的 `world` / `head`**（A9）。

### A8 · 单写者保证

```
acquire():                                      # 跨平台单写者锁（本地 socket 即鉴权，单机）
  if exists(state/runtime/lock):
      if alive(read(state/runtime/lock).pid): fail(writer_busy)   # POSIX: kill -0；Windows: OpenProcess+GetExitCodeProcess
      else: clear(state/runtime/lock)           # 死锁清理
  atomic_create state/runtime/lock { pid, started_at }   # POSIX O_EXCL；Windows: named-mutex / 等价原子创建
  release on finally + signal
# verify / replay 启动即抢锁：抢不到（宿主在跑）→ writer_busy，绝不静默读半条日志
# status 只读锁信息、不持锁、非阻塞（可能读到 run 续跑中的瞬态 head）
# 不允许"两个进程都只追加就安全"：expect_pos 是单链 CAS
```

### A9 · run loop 机械骨架

```
run_id = new_id(); directives = initial(); now = fixed(); results = {}
loop:
  out = kernel.run({ world, head, run: run_id, directives, results, limits, caps, now })
  done    -> ledger.append(out.journal); return
  refused -> no_commit; report(observations.last.reasons); return
  idle    -> no_progress; return
  waiting -> eff = out.pending
             results[eff.id] = execute(eff)    # A7：含审计（会推进 world/head）
             world, head = post_audit(world, head)   # 回灌审计后的世界，作续跑起点
             continue                          # run_id / directives / now 一字不改
```

- 只有 `done` 才落账；`waiting` / `refused` 的 journal 为空。
- 同一 `run_id`、同一份**完整** `directives`（含已跑完前缀）、同一 `now`；`results` **只增不改**。
- 效果放叶子、长循环拆 directive（成本纪律）。
- 审计 `put`（A7）在 `waiting` 期间已由宿主直写 `commit` 落到链上、推进 head；`done` 的 `out.journal` 只是该轮的**业务写**（write directives），两者先后同链。
- A9 = **单轮**（含 waiting 续跑）；A10 = **轮间**驱动，每轮独立 `run_id` / `now`，并把 plan 切轮（见 A10）。
- **单轮返回 `lastAuditHash`**（本轮最后一条 eff 的审计 def 键；无 eff 为 null）供 A10 填 `ref`。
- **`refused` / `idle` 同样回灌审计后的 `world` / `head`（S4 钉死）**：审计在挂起期间已推进链头，若调用方拿轮前旧头，下一次提交会以旧 `expect_pos` 续链、分叉。宿主的 `world` / `head` 与账本必须同步前进。
- **入站提交缺省**：`caps` = `{}`；`limits` = `{ gas: 1_000_000, depth: 64 }`（`host.ts` `DEFAULT_LIMITS`）。

### A10 · 判定 → 落账（轮与轮之间）

```
round(directives, run_id, now) -> (out, phases):  # 每轮独立 run_id / now；run_once = A9（单轮含 waiting 续跑）
  out = run_once(directives)
  match out.status:
    done    -> ledger.append(out.journal);       # 业务写落账（审计已在 waiting 期间直写落链）
               plan = pick_eval_ok_plans(out.observations)   # 唯一跨轮通道（只 done 上取用）
               phases = plan_rounds(directives_of(plan))   # 切轮：eval 连续段可并、write 每条一轮、extern 随邻（保序）
               # 下一轮取 phases 的下一段——见下「分相」
    refused -> no_commit; report(last(out.observations).reasons); stop
    idle    -> no_progress; stop
  return out, phases                             # 仅 done 有 phases；refused / idle 为 []

# plan 通道：**顶层 eval 观测**的 value 带保留包装 {"$directives":[...]} 才当计划；
#   宿主只认这一种包装（其余 value 一律当普通数据 / 观测返回，不执行）——机械识别保留键，不猜业务。
# directives_of(plan)：宿主只原样取用（kind/op/args 不改）+ 机械填字段，**不解释**（守宿主零业务）：
#   request.id = 新幂等键   request.by = 发起者
#   request.ref = 紧邻 eval 段内最后一条 eff 的 audit 哈希（分相后 write 轮无 eff，见 A7）
#   target.expect_pos = **该轮轮首链头**（write 每条一轮 ⇒ 轮首头即该条执行时的头）
#   结构 op 的 pins 由宿主按「名 → 被依赖身份 active 世代 payload 哈希」解析（与 A0 同路）
# write directive 的 request.args = plan 里的内容（宿主不改内容，只机械校验）
# eval 条目的 ctx：**字段缺省** → A14 投影（构造时世界）；显式给出（含 null）→ 原样透传
# op ∈ 全部 op（含 add_gen/set_active/retire/fork/graft）；run 内 set_active 只对下一轮 / 下一 run 生效
# 真实位置只认 done 的 head / journal；refused / waiting 的 pos 一律作废
# **分相**：一轮内不混 eval 与 write，且 expect_pos 稳——
#   eval 段：连续 eval 可并一轮（eval 不推进 head；eff 的审计 put 推进 head 但不改 eval 观测）；
#   write 段：**每条 write 单独一轮**——位置 CAS 逐条前进（commit.ts:89 `expect_pos !== head.hash ⇒ pos_conflict`），
#             expect_pos 每条都得等于该条执行时的链头，故不能把多条预填成轮首头；要原子写多份 → 一条 `batch` write directive（kernel §十二 推荐）。
#   extern 中性可随邻段。混「发 eff 的 eval」与「write」同轮 ⇒ 从第二条起 expect_pos 失配 ⇒ pos_conflict。
# extern 观测（{kind:'extern', payload}）原样回给发起者，不解释、不落账、不推进（决策 4）。
```

- A9 是**单轮内**的续跑（同 `run_id` / `now` / `directives`，`results` 只增）；A10 是**轮间**驱动，每轮独立 `run_id` / `now`（非回退）。
- **分相 = 一轮内不混 eval 与 write；`write` 每条单独一轮**（多条原子写用一条 `batch`）。保序、不重排 plan 语义。
- **plan 通道**：term 用保留包装 `{"$directives":[...]}` 产 directive；宿主只对**顶层 eval 观测**（entry = 本次提交的顶层 directive 的 entry）识别该包装，其余 eval / `extern` / 嵌套观测只作数据回给发起者。
- **plan 条目插在剩余轮之前（S4）**：该 eval 的判定立即生效，随后才继续入站提交里余下的段；多 eval 同轮各产计划时按观测序拼接。
- **plan 条目属主继承产出者（S4）**：plan 里的 eval 发 eff 时用产出该 plan 的 eval 的 owner 路由（宿主不重新对 entry 反查属主）。
- **plan 的 eval 条目 ctx（S4.6）**：`ctx` 字段缺省 ⇒ 宿主投影（A14，取**该轮轮首**世界）；显式给出（含 `null`）⇒ 原样透传。判定用 `'ctx' in raw`，不能用 `?? null`。
- **plan 递归（S4）**：plan 产出的 eval 再产 plan，逐层执行到穷尽（每层独立 `run_id` / `now`）；非法条目 / `unresolved_pin` / 坏 `batch` 子操作 → `refused`（`bad_directive` / `unresolved_pin`），不跑后续轮。
- **`batch` 子操作同样解析 pins（S4）**：递归 `args.ops`；子操作缺 `args` 键 → `bad_directive`（宿主不替它补 `null`，交内核形态门会漏过）。
- 插件**服务**不产生 directive；directive 由 term 经 plan 通道产出，或由发起者在入站面直接提交。
- **设计口径见 `host.md` §五「落账」**（计划通道 / 分相 / 属主继承）；本节只写算法与字段填充。

### A11 · 健康 / 重启 / 超限（坏分支隔离）

```
on_service_exit(proc, reason):
  lifecycle_log(service.exit, proc, reason)
  remove_endpoints(proc.id, proc.gen)            # 进程已死：该 gen 端点先摘除（重启成功后重挂）
  if decl.restart.policy == 'never': isolate(reverse_reachable(proc.id)); return   # 策略 never：不重启，退出即隔离该分支
  # 稳定复位：按【本次运行时长】判——活过 window_ms 才算稳定、复位；否则算 flapping。
  # 【不】按握手成功复位：持续 flapping 每次握手都成功，按握手复位会永不耗尽 max。
  if now - proc.started_at >= decl.restart.window_ms: attempts[proc] = 0
  attempts[proc] += 1
  if attempts[proc] > decl.restart.max:
      lifecycle_log(service.restart_exhausted, proc)
      mark(not_loaded, proc.id)
      for d in reverse_reachable(proc.id): mark(d, not_loaded)          # 依赖者随之下线（A2 反向可达）
  else:
      delay = backoff(decl.restart, attempts[proc])                     # 策略 / 退避
      restart_service(proc.id, proc.gen); proc.started_at = now         # 同 gen 重启（无 drain）；只记启动时刻，不重置 attempts

health_probe(proc):                            # protocol §2.3 probe/pong；drain 期间暂停（见 A6）
  if no pong within decl.health.timeout: on_service_exit(proc, 'health_timeout')
```

- 崩溃恢复由 `assembly` 按声明执行；`health` / `restart` 字段由此被消费（`restart.policy` = `on-exit` / `never`，缺省 / 未知按 `on-exit`；`health.probe` 是服务侧自述、宿主不消费）。
- **声明默认值（实现常量，`supervision.ts` `parseRestart` / `parseHealth`）**：`backoff` ∈ `none` / `fixed` / `exponential`（未知 / 缺省按 `exponential`）、`backoff_ms` = 500、`backoff_max_ms` = 30000、`max` = 5、`window_ms` = 60000、`drain_ms` = 5000；`health.interval_ms` = 10000、`health.timeout_ms` = 2000。
- 超限后**不自动无限重启**；隔离范围同 A2「坏分支」。**复位按「本次运行时长 ≥ `window_ms`」**（`started_at` 在每次起 / 重启时记录），**握手成功不复位**——否则持续 flapping（每次握手都成功）永不耗尽 `max`。

### A12 · 停机序列（`boot stop`）

```
stop():
  lifecycle_log(host.stop)                 # 宿主自停（对称：起时 lifecycle_log(host.start)）
  for id in reverse(topo_order):           # 反拓扑序：依赖者先停
      drain(id, decl.restart.drain_ms)     # 在途结束 → bye；超时强杀 + lifecycle_log(service.exit, id)
  fsync(journal)                           # journal 本已 append-only，确保落盘
  release_lock()
  exit
# 停机不写链、不改 active；宿主崩溃由「服务断连自退出」（protocol §2.6）兜底
```

- 反拓扑序 = A2 启动序的逆；只 drain 已装载身份。起时对称落 `host.start`（`boot start` 进入主循环前），与 `host.stop` 成对。
- `boot stop` 是**客户端命令**（连运行中的宿主下发）；宿主收到即执行本序列。

### A13 · 命令 args 校验（命令是具名入口的糖）

```
validate_args(world, cmd, args):           # 命中 host.ts command 分支：resolveCommand 之后、构造 directive 之前
  if cmd.argsSchema == null: return ok     # 缺省 argsSchema = 不设门
  def = world.defs[cmd.argsSchema]
  if def == null: return fail(bad_args_schema)     # fail-closed（入世已保证 def 在；缺则拒）
  return subset_validate(def.body, args)           # JSON Schema 白名单子集，方言见 plugins.md §二
# 失败 → error{code:'bad_args'}：不构造 directive、不跑 run、不落账（无审计）
# 缺 args 按 null 校验；校验器用显式栈（防深嵌套），无正则 / 无网络 / 无副作用
```

- **方言元校验在入世**：`commands[].argsSchema` 的 def body 若含白名单外关键词 / 形态非法 → `bad_args_schema`，**整包拒**（与 `bad_worldignore` / `term_cycle` 同路）。
- **运行期补门（S4）**：命令侧对 `world.defs[argsSchema]` 先补一次方言元校验（防运行期 `add_gen` 注入未过入世门禁的 schema）→ 不过归 `bad_args_schema`，再走白名单子集校验（不过归 `bad_args`）。
- 类型判定复用内核值标签 `t`，`enum` / `const` 复用内核 `deepEq`（一种口径）；`integer` = `Number.isInteger`；`minLength` / `maxLength` 按 Unicode 码点。
- 门禁只查**形态**；业务语义校验归插件（term / 服务），宿主不认识命令语义。

### A14 · 投影（`base_only`，v1 = 当前世界）

```
project(world, head):                      # 宿主只读视图；按引用构造，O(#身份)，不深拷贝
  return { head: { seq: head.seq, hash: head.hash },
           world_rev: worldRev(world),
           ids: { for id in world.ids:
                    { active: ids[id].active,
                      gens: ids[id].gens.map(g => { seq: g.seq, payload: g.payload }),  # 不含 adopted/born
                      body: ids[id].active == null ? null : (world.defs[ids[id].active]?.body ?? null) } } }
# 形状口径：以身份名为键（字面 id 可达）；不给 defs 表（哈希键静态路径不可达）；不含源码 tree/blob
# 注入规则（三路统一）：eval 的 ctx **字段缺省** → project(world, head)；显式给出（含 null）→ 原样透传
# 含 eval 的轮按需构造一次、该轮 eval 共享（轮内 eval 不推进世界；eff 的审计推进发生在轮内但不回改 ctx）
# 三路同规：客户端提交 / 命令 / plan 条目均在每轮分组物化时取（用该轮轮首 world / head）
# effect 不 import projection：宿主把 ctxFor(world, head) provider 传进 rounds（分组物化点）；
# run-loop 只收已填好 ctx 的 directives；provider 缺席而 eval 缺省 ctx ⇒ 抛错（不静默退化成 null）
```

- v1 无快照 ⇒ **基础世界 = 宿主当前世界**（全量重放结果，随链头推进演化）；投影只读、不写链、不推进 head、**不参与哈希**（`ctx` 不进 entry），确定性来自"世界是输入"。
- `worldRev` 是 O(#defs)（`kernel.md` §十六）⇒ **含 eval 的轮按需构造一次**、该轮 eval 共享（该轮 eval 全带显式 ctx 则不构造）；不要逐 directive 重算。
- `["g", path]` 是**静态字面路径**（`machine.ts`），缺失抛 `missing_path`；故 `defs.<hash>` 类位置对 term 不可达，只暴露 `ids.<id>.*`。
- 触发三路（同一实现点）：客户端 `submit`、命令、plan 条目——均在**每轮分组物化时**取该轮轮首的 `world` / `head`（write 轮不需要 ctx）；plan 条目判定用 `'ctx' in raw`，不能用 `?? null`。

---

## 本阶段交付（分片，逐片单独会话与验收）

| 片                         | 交付                                                                                                                                                                                                                                                                                                        | 出口检查                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1 引导 + 账本最小面**   | A0/A0b 入世（含 term `$ref` 替换 + 成环整包拒）；`packages/boot` 薄壳 + `packages/client` 库；宿主 + 入站 socket（`submit` / `command` / `commands` / `status`，`event` 透传）；`seed` / `verify` / `replay(full)`；A12 停机；单 append-only journal 文件；`EffectAudit` def（**成功 eff 的 `ref` 归 S4**） | `submit [write]`（直接写，不经 term/eff）→ `done` → 落账；同输入重放逐字节一致；`submit [eval(toy-eff)]` → 未解析 → `refused:eff_error` + 审计 def 落（**这是预期**，无端点表）；`boot stop` 干净停机；`boot <命令>` / `boot help` 可用 |
| **S2 声明 + 闭包**         | `plugin.json` schema；A2 闭包 + 拓扑 + 环检测；A3 `stale()` 处置                                                                                                                                                                                                                                            | 拓扑序正确；漏 `pins` 显式失效；成环只隔离该分支（其余照常起）                                                                                                                                                                          |
| **S3 `assembly`**          | A5 源码树 + 物化 + 跑 `start`；A4 握手；端点表；A11 健康重启 + 坏分支隔离                                                                                                                                                                                                                                   | 两个**从未见过**的 toy 插件包（一个独立、一个跨插件 `pins`）只加插件包即被连接生效；成环 / 握手失败只隔离该分支                                                                                                                         |
| **S4 `effect`**            | A1 路由；A10 判定 → 落账；`eff` → 执行 → A7 审计 → 回灌 → 续跑 → `done`（A9）；extern 透传；**A13 命令 `args` 按 `argsSchema` 校验**（JSON Schema 白名单子集，坏参 → `bad_args`，S1 遗留）                                                                                                                  | 换 toy 服务实现，调用方与 term 不改；挂起→审计→回灌→续跑逐字节可重放；分相正确（eval/write 不共轮、write 每条一轮）；extern 观测原样回流；坏参在装配 / 执行前被拒；白名单外关键词入世 `bad_args_schema` 拒包                            |
| **S4.5 跨语言**            | 一个**非 JS**（如 Python）toy 插件包：`package.json` + `plugin.json` + `execute/main.py`（读写 **stdin/stdout**；服务协议最小面：4 字节长度帧 + `hello`/`manifest` + `call`/`result`/`error` + `probe`/`pong` + `drain`/`bye` + `reload`/`ack`）+ `schema/` + `README`                                      | 只加该插件包（`state/plugins.json` 加一行 + 包就位）、**不改载体一行** → 被连接 → 握手 → `call`/`result` → 回灌 → 落账；挂起→审计→回灌→续跑逐字节可重放。**这就是「宿主不认识语言 / npm 只是信封」的证明**                              |
| **S4.6 投影（base_only）** | A14：`projection` 包（宿主只读视图）；v1 基础世界 = **当前世界**（无快照 ⇒ 全量重放结果）；形状 = `{head, world_rev, ids:{<id>:{active, gens, body}}}`；eval 的 `ctx` **缺省即投影、显式透传**（三路统一） | term 经 `["g",["ids",<id>,"body"]]` 读当前世界投影；投影只读、不写链、不推进 head、不参与哈希 |
| **S5 世代跟随**            | A6 换代 + 退役隔离；A8 单写者锁                                                                                                                                                                                                                                                                             | `add_gen` / `set_active` 生效；旧服务排空退出；依赖换代不改发出者进程（A1 重解析）；依赖退役 → 隔离发出者（不回落）；运维日志有对应条目；双写者被拒                                                                                     |

- **S4.5 环境前提**：非 JS 运行时（如 Python）——服务协议走 **stdio**（读写 stdin/stdout），**无需 named pipe / socket**（「端点地址注入」问题随 stdio 消失）。
- 一个非 JS toy 即可，不必每个都跨语言。
- **S4.5 落地**：`fixtures/plugins/toy-python/` 用 Python 3.14 实现服务协议最小面——4 字节大端长度 + UTF-8 JSON 帧经 `sys.stdin.buffer` / `sys.stdout.buffer` 读写（`toy-alpha` 同款 service-config 覆写面；stdout 只写帧并逐帧 flush），manifest 由包内 `plugin.json` 现读派生；`start = py execute/main.py`（本机 `python` 是 Store 别名，宿主经 cmd 解析不到，`py` 才是实际可用命令）。`.worldignore` 按包内路径段前缀逐条声明 `__pycache__/` 与 `execute/__pycache__/`（不是按目录名递归匹配）。
- **S4.5 结论**：载体生产代码（`packages/host` 非测试文件、`packages/kernel`、`packages/boot`、`packages/client`）**零改动**——只加包 + `state/plugins.json` 一行即完成连接 / 握手 / `call`/`result` / 回灌 / 落账；E2E 与静默失败路径（超时 → `transport_failed` → `refused`，审计照落）见 `packages/host/test/host-python.test.ts`。
- **S4.6 落地**：`packages/host/projection/index.ts` 按 A14 形状实现（身份字面 id 为键；`gens` 只留 `seq` / `payload`；`body` = active payload def body，`active=null` 或 def 缺失 → `null`；按引用构造，不深拷贝）。
- **S4.6 注入点**：`effect/rounds.ts` 分组物化时按字段存在性（`ctx === undefined`）填 **该轮轮首** 投影；含 eval 的轮构造一次共享，write 轮不构造；显式 ctx（含 `null`）原样透传；`ctxFor` provider 由 `host.ts` 注入（命令 / 直提 eval 两条路径），plan 条目同规（`'ctx' in raw`）。
- **S4.6 测试**：投影单测（空世界不报错 / 机械映射 / 不含 defs 与履历 / 构造不改世界）、rounds 注入行为（缺省与显式、每轮一次与轮首 world/head、write 轮不构造、轮内审计不回改 ctx、provider 缺席抛错）、E2E（term 经 `["g",["ids",<id>,"body"]]` 等读投影；eval 轮 journal / head / worldRev 不变）见 `packages/host/test/host-projection.test.ts` 与 `effect/test/rounds.test.ts`。
- **S5 落地**：`packages/host/assembly/generation.ts`（纯判据：`classifyGenerationChange` 按 members 跨代比对路径 + 文件/子树哈希，execute 优先；声明读不出保守 code）；`assembly/runtime.ts` 的 `applyWorld` 每轮 done 后落地——自身 active 换代：数据 → `ServiceLink.reload`/`ack`（进程不动、端点行换新 gen 键，ack 超时保守走 code 路径），代码 → 新服务起 + 旧服务 drain（`service.exit` reason `superseded`）；`retire` / `set_active(null)` → `reverse_reachable` 逐身份 `dep.retired` + 下线；新身份按装配同路起。`service-link.ts` 加 `reload`；`effect/rounds.ts` 加 `onAdvanced` 钩子（宿主注入，保证下一轮 / 下一次提交按新世界路由）；`host.ts` 接线。已在途的旧 gen 退避重启排程作废（active ≠ service.gen 即不重启）。
- **S5 测试**：判据单测（term→data / execute→code / 双类→code / 路径增删 / 双用 execute 优先 / 声明不可读→code）见 `assembly/test/generation.test.ts`；`applyWorld` 运行相（数据 reload 进程不动、reload 超时保守换服务、代码换代旧服务 drain、退役反向隔离、新身份装载、幂等、旧 gen 重启排空、**新 active 装载失败隔离**——握手不符 / 进程起不来 → `handshake.failed` / `service.start_failed` + 发出者 `dep.stale`，旧服务停掉、不回落）见 `assembly/test/generation-runtime.test.ts`；E2E（客户端 `add_gen` / `set_active` / `retire` 全链落账 + `status.loaded` / 审计 result / `dep.drift` / `dep.retired` / 双写者 `writer_busy`）见 `test/host-generation.test.ts`。toy 服务加 `reload`→`ack`（`reloadMode` 可测超时）与默认回值带 `pid`（进程不动的判据）。

## 出口验收

1. `boot seed` → `boot start` → `boot run` 提交一个 toy 任务（toy term + toy 服务），落账可校验。
2. 重放逐字节一致：`replay(full)` 得同一 `H(world)`。
3. **契约判据**：新增两个从未见过的 toy 插件包（一个独立、一个跨插件 `pins`）→ 只加插件包、不改载体 →
   均被正确连接并生效。
4. **换实现判据**：换 toy 服务实现不改调用方、不改 term。
5. **崩溃判据**：杀掉 toy 服务 → `assembly` 按声明重启 → 调用恢复。
6. **无内核依赖判据**：插件包内不出现内核 import；卸载全部插件，内核与其测试仍全绿（`kernel.md` §十一）。
7. **跟随判据**：被依赖身份换代 → 发出者进程 / term 不动，路由自动指到新 active；新 active 装载失败则隔离发出者，绝不回落旧世代。
8. **跨语言判据**：一个**非 JS**（如 Python）插件包，只加包、**不改载体** → 被连接 / 握手 / 调用 / 回灌 / 落账，逐字节可重放（证「宿主不认识语言 / npm 只是信封」）。
9. **投影判据**：eval 的 `ctx` 缺省 ⇒ `base_only` 投影、显式 ⇒ 原样透传（三路同规）；term 可经 `["g",["ids",<id>,"body"]]` 读到 active payload；投影不写链、不推进 head、不参与哈希。

## 本阶段不做

- 真实能力插件：model / UI / context / session / memory / skill / tool / sandbox / bench /
  scorer / evolve / panel / MCP（**engine 不是插件**）。
- 分段 journal + manifest + `partial` 取用；`snapshot` 与快照本体、冷归档；SQLite 派生索引。
- 流式、多模态、向量检索、多设备 / 多用户同步、存储迁移。

## 范围红线

- 不改内核；不把任何判定写进宿主。
- 不给任何插件开特例（`plugin.json` / `pins` / `schema` 同路）。
- 物理端点不进世界。
- 不把 `assembly` 与 `effect` 的边界抹掉。
- 入站面与两份协议里**不得**出现"插件写链"的消息。

## 单次会话可完成

按 S1 → S2 → S3 → S4 → S4.5 → S4.6 → S5 逐片提交，每片单独会话、单独验收。
S1 是账本向、S2/S3 是装载向、S4 是效果向、S4.5 是跨语言向、S4.6 是投影向、S5 是换代向；
任一片超尺度按 **声明解析 / `pins` 闭包 / 物化 / 连接** 再切。

## 后续插件计划的模板

每个插件计划只写：插件包（npm）+ `plugin.json` + 成员 + `pins` + 能力类 + 命令 + 该插件验收；
**不改** `packages/` 下任何文件。验收必含三条：

1. 只加插件包、不改载体 → 被正确连接并生效。
2. 换实现不改调用方、不改 term。
3. 插件包内不出现内核 import。
