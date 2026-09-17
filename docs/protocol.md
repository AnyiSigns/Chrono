# 协议：宿主 ↔ 插件服务 / 发起者 ↔ 宿主

> 口径来源：`docs/kernel.md`（内核设计）+ `docs/host.md`（载体设计）。
> 本文定义两份协议：**服务协议**（宿主 ↔ 插件服务）与**入站协议**（发起者 ↔ 宿主）。
> 本文只引用设计文档，不引用任何计划文档。

---

## 一、共同基础

- **传输**：本地 socket（POSIX unix domain socket；Windows named pipe）。**不开 TCP**，fs 权限即鉴权。
- **帧**：4 字节大端长度 + UTF-8 JSON（按内核口径的规范序列化）。
- **信封**：`{ v, id, kind, ... }`；`v` = 协议版本，`kind` = 消息种类。
- 请求 / 响应按 `id` 配对；服务可主动发 `event`（无对应请求）。
- 版本不匹配 → `protocol_mismatch`。

## 二、服务协议（宿主 ↔ 插件服务）

### 2.1 握手

```
宿主 → 服务   hello    { v, impl, gen }
服务 → 宿主   manifest { v, identity, implements, methods, protocol, state }
```

宿主按 `host.md` §五「装配」做**机械**校验；不过 → 杀进程 + `handshake_failed`。

### 2.2 能力调用

```
宿主 → 服务   call   { v, id, port, method, args }
服务 → 宿主   result { id, ok: true, value }
服务 → 宿主   error  { id, ok: false, code, message }
```

`port` 是**逻辑名**（不是哈希）——宿主已在路由时按发出者 `pins` 解析到本服务；它必须是本服务**声明的能力类**。

- `error` 与调用超时 → 宿主转成 `EffResult{ok:false}` **回灌**（数据，term 可据此降级）；
  只有连接 / 帧 / 进程死亡等**传输级故障**才让该轮 `refused`（`transport_failed`）。

### 2.3 控制

```
宿主 → 服务   reload { v, id, gen }          → 服务 ack { id }
宿主 → 服务   drain  { v, id, deadline_ms }  → 在途结束，服务发 bye { v, id }
宿主 → 服务   probe  { v, id }               → 服务 pong { id, ok }
```

- `reload` / `drain` / `probe` 均按 `id` 配对（§一）；`drain` 的 `deadline_ms` 取自 `decl.restart.drain_ms`（同一值，字段名按消息语义用 `deadline_ms`）。
- drain 期间宿主暂停该服务的 health 探针（防 drain 中忙等被误判 `health_timeout`，见 `host-plan.md` A6）。

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

- **断连自退出**：服务检测到与宿主连接断开（socket 关闭 / EPIPE）即**自退出**——避免宿主崩溃后孤儿进程占端点；宿主重启无需清理旧进程。

## 三、入站协议（发起者 ↔ 宿主）

发起者 = CLI（`boot run` / `status` / `boot <命令>`）、UI、测试、以客户端身份连接的插件。

```
发起者 → 宿主   submit   { v, id, directives, caps, limits }  → accepted { id, run }
宿主 → 发起者   result   { run, status, observations }        # run 结束时推
发起者 → 宿主   command  { v, id, name, args, caps, limits }  → result { id, ... }
发起者 → 宿主   commands { v, id }                           → list { id, commands: [...] }
发起者 → 宿主   status   { v, id }                           → state { id, world_head, loaded: [...] }
发起者 → 宿主   stop     { v, id }                           → accepted { id }   # 令宿主停机（`host-plan.md` A12 序列）
宿主 → 发起者   event    { v, impl, topic, payload }         # 插件 event 透传，广播给已连接客户端
```

- `run` 的语义与续跑纪律见 `host.md` §五「效果」与 `kernel.md` §十二。
- **命令是具名入口的糖**：宿主按声明把 `name` 解析成入口 def，机械校验 `args`，构造
  `{kind:'eval', entry, args}` 走一次 run。命令**不是第三条改世界的路**——判定仍是 term、写仍经落账。
- `commands` 只读声明，供 `boot help` 用（客户端没有世界，必须问宿主）。
- `caps` / `limits` 由发起者给，宿主**透传不扩权**；`now` 由宿主固定，不由客户端给。
- `event` 无 ack、不落账、不推进，**非留痕通道**；`impl` 是命名空间，防跨服务 `id` 相撞。
- `result.observations` 含 term 的 eval 观测与 `extern` 透传观测（`{kind:'extern', payload}`，原样回发起者，不解释、不落账、不推进——见 `host.md` §五 效果）。
- `status` 的 `loaded` = 已装载身份清单（`id` + active `gen`），非阻塞快照、可能瞬态。
- 载体生命周期事件（`handshake_failed` / `cycle` / `restart_exhausted` / `service_exit`）记宿主侧**运维日志**（`state/lifecycle.log`），**非本协议消息**、不进世界；协议侧只见对应错误码（§四）。
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
| `bad_args` | 命令 `args` 不符合 `argsSchema` | `host.md` §五 命令 |
| `bad_directive` | directive 形态非法（`kind` / 字段不符） | `kernel.md` §十二 |
| `transport_failed` | 服务连接 / 帧 / 进程死亡（传输级） | §2.2 |
| `restart_exhausted` | 崩溃重启超过 `restart` 上限 | `host.md` §五 装配 |
| `internal` | 宿主内部错误 | — |

