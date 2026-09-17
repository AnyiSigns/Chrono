# 协议：宿主 ↔ 插件服务 / 发起者 ↔ 宿主

> 口径来源：`docs/kernel.md`（内核设计）+ `docs/host.md`（载体设计）。
> 本文定义两份协议：**服务协议**（宿主 ↔ 插件服务）与**入站协议**（发起者 ↔ 宿主）。
> 本文只引用设计文档，不引用任何计划文档。

---

## 一、共同基础

- **传输**：本地 socket（POSIX unix domain socket；Windows named pipe）。**不开 TCP**，fs 权限即鉴权。
- **帧**：4 字节大端长度 + UTF-8 JSON（按内核口径的规范序列化）。
- **信封**：`{ v, id, kind, ... }`；`v` = 协议版本。
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

`port` 是**逻辑名**（不是哈希）——宿主已在路由时按发出者 `pins` 解析到本服务。

### 2.3 控制

```
宿主 → 服务   reload { v, gen }          → 服务 ack { id }
宿主 → 服务   drain  { v, deadline_ms }  → 在途结束，服务发 bye { v }
```

### 2.4 服务协议禁止

- **不得**发 `write` / `put` / `commit` 类消息——唯一写口在宿主。
- **不得**索取其他插件的物理端点——插件间不直连。
- `manifest` **不得**声明声明之外的能力——多出来的不登记（不扩权）。

## 三、入站协议（发起者 ↔ 宿主）

发起者 = CLI（`boot run` / `status`）、UI、测试、需要发起的插件。

```
发起者 → 宿主   submit { v, id, task }   → accepted { id, run }
宿主 → 发起者   result { run, status, observations }     # run 结束时推
发起者 → 宿主   status { v, id }         → state { id, world_head, loaded: [...] }
```

- `run` 的语义与续跑纪律见 `host.md` §五「效果」与 `kernel.md` §十二。
- 本协议定义 `submit` / `result` / `status`；裁决、订阅、多客户端不在其内。

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


