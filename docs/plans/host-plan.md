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

- 实现严格按 `docs/host.md` §五 的设计口径；本计划的 A0–A10 是它的实现规格。
- v1 从 `EMPTY_WORLD` **全量重放**，无快照、无 `partial`。
- 只用 `fixtures/plugins/` 的 toy 服务验证，不引入真实插件。

---

## 关键算法（A0–A10，实现规格）

### A0 · 入世（文件树 → defs）

```
ingest(name):
  for f in walk(plugins/<name>/):              # plugin.json / execute/ / terms/ / schema/
      blob[f] = put({ body: read(f) })         # 文件 → blob
  tree   = put({ body: { entries: [...] } })   # 目录 → tree，递归
  commit = put({ body: { tree, meta } })       # 一个世代 = 一个 commit
  # add_identity（首次）/ add_gen（换代），payload = commit 键
  # pins：作者写身份名 → 宿主解析成被依赖身份的生效世代 payload 哈希
  # schema 门禁：机械校验不过 → 整批拒绝，世界分文未动
```

- 与 A5 物化互逆；源码住 ①（`kernel.md` §八）。
- 作者不算哈希（不变量 9），`pins` 的哈希由宿主在入世时解析。

### A1 · 能力类名 → 端点解析（路由）

```
resolve(emitter, cap, method):          # emitter = 当前 directive 入口 def 的属主
  h = emitter.active_gen.pins[cap]
  if h == null: fail(unresolved_cap)          # 不猜、不兜底
  d = world.defs[h]
  if d == null or identity(d).retired: return handle_stale(emitter, cap)
  impl = identity(d); gen = impl.active
  ep = EndpointTable[impl.id + gen + cap + method]
  if ep == null: fail(not_loaded)
  return ep
```

- 发出者 = 当前 directive 入口 def 的属主（宿主构造 directive，故知道）；`eff_id` 的 `i` 给出是哪条。
- **端点表键不含调用方**（`impl+gen+cap+method`）——换实现只改 `pins` 指向。
- `pin` 名即调用点名；多实现用别名（`model.primary` / `model.fallback`）。
- 纪律：term 的 `Call` 只在本身份内；跨插件一律走 `eff`。
- 只读世界与运行态，不执行效果。

### A2 · `pins` 闭包 + 拓扑序 + 环检测

```
roots = { id | world.ids[id].active != null }
edges = { (A,B) | A ∈ roots, ∃ h ∈ A.active_gen.pins: h == B.active_gen.payload }
order = topo_sort(roots, edges)        # Kahn / DFS 后序：被依赖者先起
if has_cycle(edges): fail(cycle)       # 整个闭包拒绝启动，不是部分启动
for d in closure: mark(d, stale(d, world, identity(d)))
```

- `pin` 只指向被依赖身份的**生效世代 payload**；反查 def→identity 靠派生物索引（③，可从 `ids.gens` 重建）。
- `stale()` 判定口径见 `kernel.md` §九。

### A3 · `stale()` 处置

```
if phase == assemble and A has stale dep:
    audit(stale); refuse_load(branch)     # fail-closed：绝不拿旧实现顶上
if phase == runtime and A.pins no longer match B.active:
    reassemble(A)                         # 见 A6
```

### A4 · 握手（声明 vs 实际能力的机械校验）

```
send(hello); m = recv(manifest)
ok = (m.protocol == decl.protocol)
 and (m.identity == decl.identity)
 and covers(m.implements, decl.implements)     # 不得少
 and covers(m.methods, decl.methods)
 and (m.state == decl.state)                   # v1 只允许 recomputable
if !ok: kill(proc); audit(handshake_failed); mark(not_loaded)
# 多出来的能力不登记（不扩权）
```

**只查形态，不查语义**：不查实现对不对、不跑测试、不校验业务语义。

### A5 · 源码树 def + 物化

```
blob   = { body: <文件文本 / 字节> }
tree   = { body: { entries: [{ name, mode, hash }] } }
commit = { body: { tree, parent?, meta } }
# 一个插件世代 = 一个 commit def；Gen.payload = commit 键
# commit.tree 下含 plugin.json / execute/ / terms/ / schema/

materialize(id):
  c = world.defs[id.active_gen.payload]
  root = state/runtime/materialized/<c.hash>/   # ③ 可重算
  write_tree(root, walk(c.tree))               # commit → tree → 递归 blob
  run(decl.start, cwd = root)                  # 宿主不认识语言、不做编译
```

### A6 · 世代跟随（链头推进 → 换代 → 原子切换 → drain）

```
on_commit_ok(head_advanced):
  for id in affected:
    if only_data_changed(id):                  # term / 参数 / 配置 / schema
        refresh_def_cache(id); send(reload); await_ack(id)     # 进程不动
    else:                                      # 工作副本 commit 变了
        materialize(id); start(); handshake()  # 新服务
        EndpointTable.add(new_rows); EndpointTable.mark_old(draining)   # 原子切换
        drain(old_proc, timeout = decl.restart.drain_ms)               # 超时强杀 + 审计
# EndpointTable 键含 gen ⇒ 在途 run 锚定旧世代，换代只对下一个 run 生效
# assembly 只跟随、不改 active：set_active 是内核 op
```

### A7 · `EffectAudit` 落账顺序

```
execute(eff):
  result = call_endpoint(resolve(emitter_of(eff), eff.port, eff.method), eff.args)
  audit_def = { request: eff, result, port, method, at, by }
  h_audit = put(audit_def)                     # 进 ① defs，必须可寻址
  # 后续写请求：WriteRequest.ref = h_audit
  return result                                # 失败也落审计（result 记失败形态）
```

- 审计与业务写 v1 **分两条 entry**；合成 `batch` 会让 `ref` 语义变复杂，后置。

### A8 · 单写者保证

```
acquire():
  if exists(state/runtime/lock):
      if alive(read(state/runtime/lock).pid): fail(writer_busy)
      else: clear(state/runtime/lock)           # 死锁清理
  O_EXCL create state/runtime/lock { pid, host, started_at }
  release on finally + signal
# verify / replay 也必须持锁（或要求宿主已停）；status 只读锁信息
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
             results[eff.id] = execute(eff)    # A7：含审计
             continue                          # run_id / directives / now 一字不改
```

- 只有 `done` 才落账；`waiting` / `refused` 的 journal 为空。
- 同一 `run_id`、同一份**完整** `directives`（含已跑完前缀）、同一 `now`；`results` **只增不改**。
- 效果放叶子、长循环拆 directive（成本纪律）。

### A10 · 判定 → 落账（轮与轮之间）

```
run_once(directives) -> out                    # 一轮 = 一组 directive
# 轮与轮之间唯一通道 = out.observations（只在 done 上取用）
for o in out.observations where o.kind == 'eval' and o.ok:
    plan = o.value                             # 判定 term 的输出（Json）
    next = directives_of(plan)                 # 原样变成 directive：eval / write / extern
# write directive 的 request.args = plan 里的内容（宿主不改内容，只机械校验）
# request.ref = 触发它的 eff 的 audit 哈希（A7）
# 真实位置只认 done 的 head / journal；refused / waiting 的 pos 一律作废
```

- A9 是**单轮内**的续跑；A10 是**轮与轮之间**的推进。
- 插件不产生 directive；发起者在入站面可直接提交 directive。

---

## 本阶段交付（分片，逐片单独会话与验收）

| 片 | 交付 | 出口检查 |
| --- | --- | --- |
| **S1 引导 + 账本最小面** | A0 入世；`boot start`（宿主 + 入站 socket）/ `seed` / `verify` / `replay(full)` / 客户端 `boot run`；单 append-only journal 文件；`EffectAudit` def + `ref` | `seed → start → run` 跑完一轮 kernel 调用并落账；同输入重放逐字节一致 |
| **S2 声明 + 闭包** | `plugin.json` schema；A2 闭包 + 拓扑 + 环检测；A3 `stale()` 处置 | 拓扑序正确；漏 `pins` 显式失效；环被拒 |
| **S3 `assembly`** | A5 源码树 + 物化 + 跑 `start`；A4 握手；端点表；健康重启 | 两个**从未见过**的 toy 服务（一个独立、一个跨插件 `pins`）只写插件即被连接生效 |
| **S4 `effect`** | A1 路由；A10 判定 → 落账；`eff` → 执行 → A7 审计 → 回灌 → 续跑 → `done`（A9） | 换 toy 服务实现，调用方与 term 不改；挂起→审计→回灌→续跑逐字节可重放 |
| **S5 世代跟随** | A6 换代；A8 单写者锁 | `add_gen` / `set_active` 生效；旧服务排空退出；双写者被拒 |

## 出口验收

1. `boot seed` → `boot start` → `boot run` 提交一个 toy 任务（toy term + toy 服务），落账可校验。
2. 重放逐字节一致：`replay(full)` 得同一 `H(world)`。
3. **契约判据**：新增两个从未见过的 toy 服务（一个独立、一个跨插件 `pins`）→ 只写插件、不改载体 →
   均被正确连接并生效。
4. **换实现判据**：换 toy 服务实现不改调用方、不改 term。
5. **崩溃判据**：杀掉 toy 服务 → `assembly` 按声明重启 → 调用恢复。
6. **无内核依赖判据**：插件包内不出现内核 import；卸载全部第一方插件，内核与其测试仍全绿（`kernel.md` §十一）。

## 本阶段不做

- 真实能力插件：model / UI / context / session / memory / skill / tool / sandbox / bench /
  scorer / evolve / panel / MCP（**engine 不是插件**）。
- 分段 journal + manifest + `partial` 取用；`snapshot` 与快照本体、冷归档；SQLite 派生索引。
- 流式、多模态、向量检索、多设备 / 多用户同步、存储迁移。

## 范围红线

- 不改内核；不把任何判定写进宿主。
- 不给第一方插件开特例（`plugin.json` / `pins` / `schema` 与第三方同路）。
- 物理端点不进世界。
- 不把 `assembly` 与 `effect` 的边界抹掉。
- 入站面与两份协议里**不得**出现"插件写链"的消息。

## 单次会话可完成

按 S1 → S2 → S3 → S4 → S5 逐片提交，每片单独会话、单独验收。
S1 是账本向、S2/S3 是装载向、S4 是效果向、S5 是换代向；
任一片超尺度按 **声明解析 / `pins` 闭包 / 物化 / 连接** 再切。

## 后续插件计划的模板

每个插件计划只写：插件目录 + `plugin.json` + 成员 + `pins` + 能力类 + 命令 + 该插件验收；
**不改** `packages/` 下任何文件。验收必含三条：

1. 只写插件、不改载体 → 被正确连接并生效。
2. 换实现不改调用方、不改 term。
3. 插件包内不出现内核 import。
