# 宿主计划：载体落地

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

- 实现严格按 `docs/host.md` §五 的设计口径；本计划的 A0–A11 是它的实现规格。
- v1 从 `EMPTY_WORLD` **全量重放**，无快照、无 `partial`。
- 只用 `fixtures/plugins/` 的 toy 服务验证，不引入真实插件。

---

## 关键算法（A0–A11，实现规格）

### A0 · 入世（文件树 → defs）

```
ingest(entry):                             # entry = state/plugins.json 的 {name, path?}；写动作（经 commit），非 assembly 的只读
  root = resolve_pkg(entry)                # 有 path 按路径解析（本地 / toy），无 path 走 Node 解析（node_modules）
  for f in walk(root) \ {node_modules, 构建产物}:   # 包内源码树：plugin.json / package.json / 锁 / README / execute/ terms/ schema/
      blob[f] = put({ body: read(f) })         # 文件 → blob
  tree   = put({ body: { entries: [...] } })   # 目录 → tree，递归
  commit = put({ body: { tree, meta } })       # 一个世代 = 一个 commit
  # 入世写批 = batch{ add_identity?, add_gen }   ← add_gen 同时激活（journal.apply.ts:180）
  #   （首次含 add_identity；换代只 add_gen）——不需 set_active
  #   上面的 put 都是**该批的子操作**（入世整体原子）；add_gen.payload / sig / add_identity.schema
  #   用 {'$n':k} 占位指批内更早的 put（journal.apply.ts substitute）
  # pins：作者写身份名 → 宿主解析成被依赖身份 active 世代 payload 哈希
  # schema 门禁：机械校验不过 → 整批拒绝，世界分文未动
```

- 入世是**写动作**（经 `commit`），不是 assembly 的只读；assembly 只读结果。
- **提交方**：v1 的 `seed`（离线、宿主未运行）**直写 `commit`**（与 A7 审计同属「宿主侧直写 commit」）；
  运行时入世由发起者经 directive 走 `run`。`add_gen` **同时激活**（`journal.apply.ts`），故入世批**不需** `set_active`；漏了 `add_gen` 才会 `active = null`、永不装配。
- 与 A5 物化互逆；源码住 ①（`kernel.md` §八）。
- 宿主**只解释 `plugin.json`**；`package.json` / 锁文件是源码 blob（供物化后 `npm install`），不参与契约解析。包源由 `state/plugins.json` 给出（**不分来源、同形**）。
- 身份 schema（`Identity.schema`）：`plugin.json.schema` 指向包内 `schema/` 文件 → 入世解析成 def 哈希 → 写进 `Identity.schema`；它是身份的**自述 / 数据契约**（数据、非特权），宿主对 `plugin.json` 形状的元校验另有一份宿主侧 schema。
- 作者不算哈希（不变量 9），`pins` 的哈希由宿主在入世时解析。

### A0b · term def 入世与 pin

```
# term def = put 的 Def{ body: <AST>, pins: <callee 依赖>, sig }
#   body 里 Call 的函数侧是 callee 的 def 哈希（机器按 env.defs[hash] 直查，machine.ts 不读 pins）
#   pins 镜像同一批 callee 哈希（供 stale() 判依附）——规矩 A：结构性依赖只走 pins
```

- **term-def pins 是哈希、不需宿主解析**（callee 是内容定址的 def、哈希稳定）；这与 `Gen.pins` 不同——
  `Gen.pins` 指身份、身份换代会变，故作者写**名**、宿主解析成「被依赖身份 active 世代 payload 哈希」（A0）。
  两者都是 `Record<string, Hash>`，但语义不同：term-def pin = 固定 callee def 哈希；Gen pin = 版本跟随的身份 payload。
- **自底向上写**：callee 先 put（哈希已知），caller 的 body/pins 直接写 callee 哈希；宿主 put 时不改 body（不扫 AST 推断依赖 = 不认识语义）。
- 漏写 term-def pins 不会被拒，只让 `stale()` 静默失效（`kernel.md` §九）——门禁以 schema 落在上层（机械校验 Call 函数侧哈希 ∈ pins，是 AST 结构检查非语义）。
- term 间引用成环 → 该分支隔离（A2 口径）。

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
  if h != gen.payload: lifecycle_log(drift, emitter, cap)   # 漂移证据，不阻塞
  return ep
```

- 发出者 = 当前 directive 入口 def 的属主（宿主构造 directive，故知道）；`eff_id` 的 `i` 给出是哪条。
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
for d in bad: lifecycle_log(cycle, d); mark(d, not_loaded)   # 只隔离坏分支
for d in roots \ bad: mark(d, stale(d, world, identity(d)))  # 其余照常起
order = rtopo \ bad                          # 启动序
```

- `pin` 绑定**被依赖身份**，边落到该身份的**当前 active 世代**；反查 def→identity 靠 ③ 反查索引
  `Map<defHash, identityId>`（装配期建、可从 `ids.gens` 重建、身份换代增量更新）——A1 / A2 共用它，O(1)。
- **Tarjan 单趟**即同时出 SCC（环）与逆拓扑序（启动序），无需再单跑一趟 topo_sort。
- 环**不再整体拒绝**：环成员及其依赖者标 `not_loaded` + 运维日志，其余照常起。
- `stale()` 判定口径见 `kernel.md` §九。

### A3 · `stale()` 处置

```
if phase == assemble and (A's pinned dep retired/missing or A itself stale):
    lifecycle_log(stale, A); not_loaded(branch)      # 坏分支隔离（含依赖者）；绝不拿旧实现顶上
if phase == runtime and A's own active gen changed:
    reassemble(A)                                     # 见 A6
if phase == runtime and A's pinned dep retired / set_active(null):  # 依赖没了（≠ 换代）
    isolate(reverse_reachable(A)); lifecycle_log(stale_dep, A)       # 运行期 fail-closed，与装配期同口径
# 依赖换代（新 active 已装载）不重装 A、不隔离：只由 A1 重解析路由
```

### A4 · 握手（声明 vs 实际能力的机械校验）

```
send(hello); m = recv(manifest)
ok = (m.protocol == decl.protocol)
 and (m.identity == decl.identity)
 and covers(m.implements, decl.implements)     # 不得少
 and covers(m.methods, decl.methods)
 and (m.state == decl.state)                   # v1 只允许 recomputable
if !ok: kill(proc); lifecycle_log(handshake_failed, proc); mark(not_loaded)
# 多出来的能力（m.implements \ decl.implements）不登记：端点表只按 decl.implements 建行；多余项丢弃 + lifecycle_log
```

**只查形态，不查语义**：不查实现对不对、不跑测试、不校验业务语义。

### A5 · 源码树 def + 物化

```
blob   = { body: <文件文本 / 字节> }
tree   = { body: { entries: [{ name, mode, hash }] } }
commit = { body: { tree, parent?, meta } }
# 一个插件世代 = 一个 commit def；Gen.payload = commit 键
# commit.tree = 包内源码树（plugin.json + package.json + 锁 + README + execute/ terms/ schema/，减 node_modules/构建产物）

materialize(id):
  c = world.defs[id.active_gen.payload]
  root = state/runtime/materialized/<c.hash>/   # ③ 可重算
  write_tree(root, walk(c.tree))               # commit → tree → 递归 blob
  run(decl.start, cwd = root)                  # 宿主不认识语言 / npm；依赖安装与构建由 decl.start 负责
```

### A6 · 世代跟随（链头推进 → 换代 → 原子切换 → drain）

```
affected = { id | id 自身 active 世代变化 }          # 只含自身换代，不含依赖者
on_commit_ok(head_advanced):
  for id in affected:
    if only_data_changed(id):                       # 见下：members 驱动，非目录名
        refresh_def_cache(id); send(reload); await_ack(id)        # 进程不动
    else:                                           # execute 成员的源码变了
        swap_service(id, new_gen)                   # = materialize+start+handshake+原子切换+drain（与 A11 共用）
  for retired in { id | 本次 commit 使某被依赖身份 retire / set_active(null) }:
    for d in reverse_reachable(retired): lifecycle_log(stale_dep, d); mark(d, not_loaded)   # 运行期 fail-closed（A3）

# only_data_changed(id)：按 members 的 kind 判——只 term/schema 成员变动 → data（reload）；
#   任一 execute 成员变动 → code（起新服务）。不按 terms//execute/ 目录名硬编码。
# swap_service(id, new_gen)：materialize → start → handshake → EndpointTable.add(new)+mark_old(draining) →
#   drain(old, decl.restart.drain_ms)；drain 期间暂停该服务 health 探针（B5，防误杀）；超时强杀 + lifecycle_log
# EndpointTable 键含 gen ⇒ 在途 run 锚定旧世代，换代只对下一个 run 生效
# 依赖换代不重装：宿主只重解析解析目标（A1），新 active 行已在表内
# assembly 只跟随、不改 active：set_active 是内核 op
```

### A7 · `EffectAudit` 落账顺序

```
execute(eff):
  try:
    result = call_endpoint(resolve(emitter_of(eff), eff.port, eff.method), eff.args)
  catch transport_error:                       # 连接 / 帧 / 进程死亡
    fail(transport_failed)                     # 传输级才 refused
  # endpoint error / 超时 → result = { ok:false, ... }（数据，回灌）
  audit_def = { request: eff, result, port, method }
  h_audit = H(audit_def)                       # 审计 **def 键**（= H(Def)；`ref` 指向世界里的 def，见 commit.ts checkRefs）
  commit(head, world, WriteRequest{ op:put, args:audit_def, by: initiator, ref: null }, now_round)
                    # 宿主侧直写 commit（不经 run directive）；进 ① defs、必须可寻址；失败也落；dup 幂等不产生新 entry
  # 后续业务写：WriteRequest.ref = h_audit（多条 eff 促成同一次写取该轮内最后一条）
  return result
```

- **审计 `put` 是宿主对 `commit` 的直接调用**（不经 `run` directive）——宿主侧唯一与 A0 `seed` 同类的直写；
  原因：审计 def 必须在业务写之前就可寻址，而续跑纪律禁止改 directives，故审计不能走 run directive。
  `at` = 该轮 `now`；`by` = 发起者；审计 entry 自身 `ref` 留空（它是**被指者**，不是指者）。
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

# directives_of(plan)：plan 是 term 的 eval 输出（Json，固定 schema = directive 规格数组）；
#   宿主只原样取用（kind/op/args 不改）+ 机械填字段，**不解释**（守宿主零业务）：
#   request.id = 新幂等键   request.by = 发起者   request.ref = 触发它的 eff 的 audit 哈希（A7）
#   target.expect_pos = **该轮轮首链头**（write 每条一轮 ⇒ 轮首头即该条执行时的头）
#   结构 op 的 pins 由宿主按「名 → 被依赖身份 active 世代 payload 哈希」解析（与 A0 同路）
# write directive 的 request.args = plan 里的内容（宿主不改内容，只机械校验）
# op ∈ 全部 op（含 add_gen/set_active/retire/fork/graft）；run 内 set_active 只对下一轮 / 下一 run 生效
# 真实位置只认 done 的 head / journal；refused / waiting 的 pos 一律作废
# **分相（D1）**：一轮内不混 eval 与 write，且 expect_pos 稳——
#   eval 段：连续 eval 可并一轮（eval 不推进 head；eff 的审计 put 推进 head 但不改 eval 观测）；
#   write 段：**每条 write 单独一轮**——位置 CAS 逐条前进（commit.ts:89 `expect_pos !== head.hash ⇒ pos_conflict`），
#             expect_pos 每条都得等于该条执行时的链头，故不能把多条预填成轮首头；要原子写多份 → 一条 `batch` write directive（kernel §十二 推荐）。
#   extern 中性可随邻段。混「发 eff 的 eval」与「write」同轮 ⇒ 从第二条起 expect_pos 失配 ⇒ pos_conflict。
# extern 观测（{kind:'extern', payload}）原样回给发起者，不解释、不落账、不推进（决策 4）。
```

- A9 是**单轮内**的续跑（同 `run_id` / `now` / `directives`，`results` 只增）；A10 是**轮间**驱动，每轮独立 `run_id` / `now`（非回退）。
- **分相 = 一轮内不混 eval 与 write；`write` 每条单独一轮**（多条原子写用一条 `batch`）。保序、不重排 plan 语义。
- 插件不产生 directive；发起者在入站面可直接提交 directive。

### A11 · 健康 / 重启 / 超限（坏分支隔离）

```
on_service_exit(proc, reason):
  lifecycle_log(service_exit, proc, reason)
  if now - last_stable(proc) > decl.restart.window: attempts[proc] = 0   # 稳定 window 后复位（D9）
  if attempts[proc] >= decl.restart.max:
      lifecycle_log(restart_exhausted, proc)
      mark(not_loaded, proc.id)
      for d in reverse_reachable(proc.id): mark(d, not_loaded)          # 依赖者随之下线（A2 反向可达）
  else:
      delay = backoff(decl.restart, attempts[proc])                     # 策略 / 退避
      swap_service(proc.id, proc.gen) on success → attempts[proc] = 0  # 起新服务+握手+原子切换+drain（与 A6 共用）

health_probe(proc):                            # protocol §2.3 probe/pong；drain 期间暂停（见 A6）
  if no pong within decl.health.timeout: on_service_exit(proc, 'health_timeout')
```

- 崩溃恢复由 `assembly` 按声明执行；`health` / `restart` 字段由此被消费。
- 超限后**不自动无限重启**；隔离范围同 A2「坏分支」。`window` 复位防长稳后偶发崩溃被当连续 flapping 耗尽 `max`。

### A12 · 停机序列（`boot stop`）

```
stop():
  for id in reverse(topo_order):           # 反拓扑序：依赖者先停
      drain(id, decl.restart.drain_ms)     # 在途结束 → bye；超时强杀 + lifecycle_log
  fsync(journal)                           # journal 本已 append-only，确保落盘
  release_lock()
  exit
# 停机不写链、不改 active；宿主崩溃由「服务断连自退出」（protocol §2.6）兜底
```

- 反拓扑序 = A2 启动序的逆；只 drain 已装载身份。
- `boot stop` 是**客户端命令**（连运行中的宿主下发）；宿主收到即执行本序列。

---

## 本阶段交付（分片，逐片单独会话与验收）

| 片 | 交付 | 出口检查 |
| --- | --- | --- |
| **S1 引导 + 账本最小面** | A0 入世；`packages/boot` 薄壳 + `packages/client` 库；宿主 + 入站 socket（`submit` / `command` / `commands` / `status`，`event` 透传）；`seed` / `verify` / `replay(full)`；A12 停机；单 append-only journal 文件；`EffectAudit` def + `ref` | `seed → start → run` 跑完一轮 kernel 调用并落账；同输入重放逐字节一致；`boot stop` 干净停机；`boot <命令>` 与 `boot help` 可用 |
| **S2 声明 + 闭包** | `plugin.json` schema；A2 闭包 + 拓扑 + 环检测；A3 `stale()` 处置 | 拓扑序正确；漏 `pins` 显式失效；成环只隔离该分支（其余照常起） |
| **S3 `assembly`** | A5 源码树 + 物化 + 跑 `start`；A4 握手；端点表；A11 健康重启 + 坏分支隔离 | 两个**从未见过**的 toy 插件包（一个独立、一个跨插件 `pins`）只加插件包即被连接生效；成环 / 握手失败只隔离该分支 |
| **S4 `effect`** | A1 路由；A10 判定 → 落账；`eff` → 执行 → A7 审计 → 回灌 → 续跑 → `done`（A9）；extern 透传 | 换 toy 服务实现，调用方与 term 不改；挂起→审计→回灌→续跑逐字节可重放；分相正确（eval/write 不共轮、write 每条一轮）；extern 观测原样回流 |
| **S5 世代跟随** | A6 换代 + 退役隔离；A8 单写者锁 | `add_gen` / `set_active` 生效；旧服务排空退出；依赖换代不改发出者进程（A1 重解析）；依赖退役 → 隔离发出者（不回落）；运维日志有对应条目；双写者被拒 |

## 出口验收

1. `boot seed` → `boot start` → `boot run` 提交一个 toy 任务（toy term + toy 服务），落账可校验。
2. 重放逐字节一致：`replay(full)` 得同一 `H(world)`。
3. **契约判据**：新增两个从未见过的 toy 插件包（一个独立、一个跨插件 `pins`）→ 只加插件包、不改载体 →
   均被正确连接并生效。
4. **换实现判据**：换 toy 服务实现不改调用方、不改 term。
5. **崩溃判据**：杀掉 toy 服务 → `assembly` 按声明重启 → 调用恢复。
6. **无内核依赖判据**：插件包内不出现内核 import；卸载全部插件，内核与其测试仍全绿（`kernel.md` §十一）。
7. **跟随判据**：被依赖身份换代 → 发出者进程 / term 不动，路由自动指到新 active；新 active 装载失败则隔离发出者，绝不回落旧世代。

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

按 S1 → S2 → S3 → S4 → S5 逐片提交，每片单独会话、单独验收。
S1 是账本向、S2/S3 是装载向、S4 是效果向、S5 是换代向；
任一片超尺度按 **声明解析 / `pins` 闭包 / 物化 / 连接** 再切。

## 后续插件计划的模板

每个插件计划只写：插件包（npm）+ `plugin.json` + 成员 + `pins` + 能力类 + 命令 + 该插件验收；
**不改** `packages/` 下任何文件。验收必含三条：

1. 只加插件包、不改载体 → 被正确连接并生效。
2. 换实现不改调用方、不改 term。
3. 插件包内不出现内核 import。
