# 协议：宿主 ↔ 插件服务 / 发起者 ↔ 宿主

> 口径来源：`docs/kernel.md`（内核设计）+ `docs/host.md`（载体设计）。
> 本文定义两份协议：**服务协议**（宿主 ↔ 插件服务）与**入站协议**（发起者 ↔ 宿主）。
> 本文只引用设计文档，不引用任何计划文档。

---

## 一、共同基础

- **传输**：**服务协议 = stdio**（宿主 spawn 服务时的 stdin/stdout 管道；协议帧走 stdout、**日志走 stderr**，LSP / MCP 同款约定）；**入站协议 = 本地 socket**（POSIX unix domain socket；Windows named pipe）。两者都**不开 TCP**；入站 socket 以 fs 权限即鉴权（服务协议由宿主 1:1 拉起，无需鉴权）。
- **帧**：4 字节大端长度 + UTF-8 JSON（按内核口径的规范序列化）。
- **信封**：`{ v, id, kind, ... }`；`v` = 协议版本，`kind` = 消息种类。
- 请求 / 响应按 `id` 配对；服务可主动发 `event`（无对应请求）。
- 版本不匹配 → `protocol_mismatch`。

## 二、服务协议（宿主 ↔ 插件服务）

本协议跑在**服务进程的 stdin/stdout**上（宿主 `start` 时接管）：宿主 → 服务写 **stdin**，服务 → 宿主写 **stdout**；**日志一律走 stderr**（stdout 只许协议帧）。

### 2.1 握手

```
宿主 → 服务   hello    { v, impl, gen }
服务 → 宿主   manifest { v, identity, implements, methods, protocol, state }
```

- `hello.impl` = 目标身份名（= `manifest.identity`）；`hello.gen` = 本次装载的世代 payload 键。
- 宿主按 `host.md` §五「装配」做**机械**校验（含信封 `v`）：不过 → 杀进程 + `handshake_failed`；服务协议侧不以 `protocol_mismatch` 收口（该码保留给入站面）。
- 帧内 JSON 非法 / 回错消息种类 / 长度前缀超单帧上限 → 按**协议损坏**收口 `handshake_failed`（不降级成通道断开）。
- **传输层失败**（非帧字节凑不满且未超上限 / 静默不答）→ `service.start_failed` reason `timeout`。
- 单帧上限 16 MiB；宿主与客户端两侧解码器一致。
- 校验只查形态：协议 / 身份 / 能力覆盖 / 状态档；不查实现对不对、不跑测试、不校验业务语义。

### 2.2 能力调用

```
宿主 → 服务   call   { v, id, port, method, args }
服务 → 宿主   result { id, ok: true, value }
服务 → 宿主   error  { id, ok: false, code, message }
```

`port` 是**逻辑名**（不是哈希）——宿主已在路由时按发出者 `pins` 解析到本服务；它必须是本服务**声明的能力类**。

- endpoint **有响应**（`result` 或 `error`）→ 宿主转成 `EffResult{ok:true, value}` **回灌**（`error` 时 `value` 是错误描述；数据，term 可据此降级）；
  只有**没执行**（管道 / 帧 / 进程死亡 / 未解析 / 超时）→ `EffResult{ok:false}`（无值）→ 内核 `eff_error` → 该轮 `refused`（`transport_failed`）。
- 单次 `call` 的等待上限 = 宿主调用超时（缺省 30s；`CHRONO_CALL_TIMEOUT_MS` / `boot start --call-timeout-ms` 可配，见 `host.md` §五 效果）。

### 2.3 控制

```
宿主 → 服务   reload { v, id, gen }          → 服务 ack { id }
宿主 → 服务   drain  { v, id, deadline_ms }  → 在途结束，服务发 bye { v, id }
宿主 → 服务   probe  { v, id }               → 服务 pong { id, ok }
```

- `reload` / `drain` / `probe` 均按 `id` 配对（§一）；`drain` 的 `deadline_ms` 取自 `decl.restart.drain_ms`（同一值，字段名按消息语义用 `deadline_ms`）。
- drain 期间宿主暂停该服务的 health 探针（防 drain 中忙等被误判 `health_timeout`）。

### 2.4 上行事件（服务 → 宿主，主动）

```
服务 → 宿主   event { v, id, topic, payload }
```

- **宿主不执行**：不解释 `topic`、不落账、不据此推进位置。
- **透传目标只到入站面已连接的客户端，不投递给其他插件**——投递给插件需要宿主理解 `topic`，那就是宿主认识业务。
- 用途：**流式 / 进度**（`call` 是请求-响应，推不出中间状态）、**诊断 / 告警**、给客户端做可观测。
- `event` **不是留痕通道**：留痕走 `note`（规矩 B），那是写链，只能由宿主构造 directive。
- `event` **不是第三条改世界的路**：不得用于写链、不得替代 `write`、不得索取其他插件的端点。
- 宿主把服务上行 `event` 原样转成入站协议的 `event`（`impl` = 上报服务的身份，作命名空间），
  广播给已连接客户端（见 §三）。

### 2.5 服务协议禁止

- **不得**发 `write` / `put` / `commit` 类消息——唯一写口在宿主。
- **不得**索取其他插件的物理端点——插件间不直连。
- `manifest` **不得**声明超出 `plugin.json` 的能力——多出来的不登记（不扩权）。

### 2.6 服务义务

- **断连自退出**：服务检测到与宿主连接断开（**stdin EOF / 管道断开**）即**自退出**——避免宿主崩溃后孤儿进程占端点；宿主重启无需清理旧进程。

## 三、入站协议（发起者 ↔ 宿主）

发起者 = CLI（`boot run` / `status` / `boot <命令>`）、UI、测试、以客户端身份连接的插件。

```
发起者 → 宿主   submit   { v, id, directives, caps, limits }  → accepted { id, run }
宿主 → 发起者   result   { run, status, observations }        # run 结束时推；status ∈ done/refused/idle/cancelled
发起者 → 宿主   cancel   { v, id, run }                       → accepted { id }   # 真取消该 run（≠ stop 停宿主）
发起者 → 宿主   command  { v, id, name, args, caps, limits }  → result { id, ... }
发起者 → 宿主   commands { v, id }                           → list { id, commands: [...] }
发起者 → 宿主   audit    { v, id, filter? }                  → audits { id, records, truncated }  # F8 只读审计面
发起者 → 宿主   asset.put { v, id, mime, bytes }             → asset.ref { id, ref }   # G4 字节直写资产区（不进世界）
发起者 → 宿主   asset.get { v, id, sha256 }                  → asset.bytes { id, sha256, size, bytes }
发起者 → 宿主   status   { v, id }                           → state { id, world_head, loaded: [...] }
发起者 → 宿主   stop     { v, id }                           → accepted { id }   # 令宿主按反拓扑序 drain 后停机
宿主 → 发起者   event    { v, impl, topic, payload }         # 插件 event 透传，广播给已连接客户端
```

- `run` 的语义（含 term 产 directive 的计划通道 / 分相）见 `host.md` §五「落账」与「效果」；续跑纪律见 `kernel.md` §十二。
- `cancel` 是**真取消**：宿主中止在途 / 排队的 run——丢弃尚未执行的部分（含 plan 产出的 directives）、
  停止等待在途服务调用（服务协议**无取消消息**，宿主侧摘除等待、不杀服务进程，故谓「尽力」）、
  对已在途的效果审计记 `outcome: 'cancelled'`，该 run 以 `result.status = 'cancelled'` 收口。
  已落账内容**不回溯**。`cancel` 只影响一个 run、宿主继续运行；与保留字 `stop`（停宿主）无关。
- 未知 / 已结束的 run → `error{code:'unknown_run'}`（fail-closed，不静默吞掉）。
- `asset.put` / `asset.get` 是 **G4 资产面**：字节按内容寻址住宿主侧 `state/assets/<sha256>`（④ 不可重算），
  **不进世界、不写链、不推进**；世界只存引用 `{kind:'asset', sha256, mime, size}`（内联在引用方数据里）。
  `put.bytes` 是**规范 base64**（往返一致才收），宿主解码后算 sha256 落盘（同字节幂等）；原始字节上限 8 MiB
  （base64 ≈10.67 MiB < 16 MiB 帧上限），更大走分块（后置）。坏 base64 / 空 mime / 非 64hex → `bad_asset`；
  超限 → `asset_too_large`；`get` 字节缺失 → `asset_missing`。回收走离线 `boot assets gc`（见 `host.md` §五 资产）。
- `audit` 是 **F8 只读审计面**：按 `run`（回合）/ `emitter`（发出者身份）/ `outcome` 过滤 `EffectAudit`，
  机械 AND、**seq 降序取最新 `limit` 条**（缺省 100、上限 1000）；`records` 形状
  `{seq, at, by, body}`，`body = {kind:'effect_audit', request, result, port, method, outcome, run, emitter}`。
  只读：不写链、不推进、不参与哈希（#37 审计视图 / #54 监控共用）。非法过滤（未知键 / 类型不符 /
  `outcome` 不在词表 / `limit` 越界）→ `error{code:'bad_directive'}`。
- **命令是具名入口的糖**：宿主按声明把 `name` 解析成入口 def，机械校验 `args`，构造
  `{kind:'eval', entry, args}` 走一次 run。命令**不是第三条改世界的路**——判定仍是 term、写仍经落账。
- `command` 的 `args` 由宿主按 `argsSchema`（**JSON Schema 白名单子集**，方言见 `plugins.md` §二）校验；
  不符 → `error{code:'bad_args'}`，**不跑 run、不落账**。缺省 `argsSchema` = 不设门；缺 `args` = `null`。
- directive 的 `eval.ctx` **字段缺省 ⇒ 宿主填入 `base_only` 投影**（形状见 `host.md` §五 投影）；显式给出（含 `null`）⇒ 原样透传；
  客户端 / 命令 / plan 三路同规。
- `commands` 只读声明，供 `boot help` 用（客户端没有世界，必须问宿主）。
- `caps` / `limits` 由发起者给，宿主**透传不扩权**（缺省：`caps` 空表、`limits` 宿主默认预算）；`now` 由宿主固定，不由客户端给。
- `event` 无 ack、不落账、不推进，**非留痕通道**；`impl` 是命名空间，防跨服务 `id` 相撞。
- `result.observations` 含 term 的 eval 观测与 `extern` 透传观测（`{kind:'extern', payload}`，原样回发起者，不解释、不落账、不推进——见 `host.md` §五 效果）。
- `status` 的 `loaded` = 已装载身份清单（`id` + active `gen`），非阻塞快照、可能瞬态。
- 载体生命周期事件（两级 `{kind, event}`：`handshake.failed` / `dep.cycle` / `service.exit` / `service.restart_exhausted` / …）记宿主侧**运维日志**（`state/lifecycle.log`），**非本协议消息**、不进世界；协议侧只见对应错误码（§四）。
- 本协议定义 `submit` / `command` / `commands` / `result` / `status` / `stop` / `event`；裁决、订阅、多客户端不在其内。

## 四、错误码

| code | 何时 | 出处 |
| --- | --- | --- |
| `protocol_mismatch` | `v` 与声明不一致 | §一 |
| `handshake_failed` | `manifest` 形态不符 | `host.md` §五 装配 |
| `unresolved_cap` | 发出者 `pins` 无此名 | `host.md` §五 路由 |
| `not_loaded` | 端点表无此项 | `host.md` §五 路由 |
| `stale` | 依赖失效 | `kernel.md` §九 / `host.md` §五 装配 |
| `cycle` | `pins` 成环 | `host.md` §五 装配 |
| `writer_busy` | 抢锁失败 | `host.md` §五 写者 |
| `unknown_command` | 声明里没有这个命令名 | `host.md` §五 命令 |
| `unknown_run` | `cancel` 指向未知 / 已结束的 run | §三 |
| `bad_asset` | 资产 base64 / mime / sha256 形态非法 | §三 |
| `asset_too_large` | 资产原始字节超过 8 MiB 上限 | §三 |
| `asset_missing` | 资产字节不在宿主资产区（可能已回收） | §三 |
| `bad_args` | 命令 `args` 不符合 `argsSchema` | `host.md` §五 命令 |
| `bad_args_schema` | `argsSchema` 含白名单外关键词 / 形态非法（入世整包拒） | `plugins.md` §二 方言 |
| `bad_directive` | directive 形态非法（`kind` / 字段不符） | `kernel.md` §十二 |
| `transport_failed` | 服务管道 / 帧 / 进程死亡（传输级） | §2.2 |
| `unresolved_pin` | 被依赖身份不存在 / 未激活（入世、或运行期结构 op / `batch` 子操作的 pins 解析） | `host.md` §五 源码 / 落账 |
| `bad_worldignore` | `.worldignore` 命中了契约必需文件 | `host.md` §五 源码 |
| `term_cycle` | 入世时同包 term `$ref` 成环（该包整批拒） | `host.md` §五 源码 |
| `bad_term_ref` | 入世时 `$ref` 指向包内不存在的成员 | `host.md` §五 源码 |
| `restart_exhausted` | 崩溃重启超过 `restart` 上限 | `host.md` §五 装配 |
| `internal` | 宿主内部错误 | — |

- **注**：`refused` 的 `reasons` 由内核给出（如 `eff_error` / `pos_conflict` / `bad_term` / `gas_exhausted` 等），本表只列宿主 / 协议层错误码；`transport_failed` 是宿主对"效果未执行"（管道 / 帧 / 进程死亡 / 未解析 / 超时）的归类。

