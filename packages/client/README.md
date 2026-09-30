# client：入站面客户端库

连宿主入站面的**唯一客户端实现**：CLI（`boot`）、UI、测试与「以客户端身份连接的插件」共用本库。
本库只做连接、收发、配对与收 event，**不实现任何判定**——世界的读写与语义全在宿主（见
[`docs/host.md`](../../docs/host.md) §五）。

- 传输：本地 socket（POSIX unix domain socket / Windows named pipe），**不开 TCP**。
- 帧：4 字节大端长度 + 规范序列化的 UTF-8 JSON，单帧上限 16 MiB；与服务端各自持有等价实现（`frame.ts` 与 `host/wire.ts`）。
- 地址：`resolveRoot`（显式 `root` → 环境变量 `CHRONO_ROOT` → 当前工作目录）→ `socketPath`
  （Windows 为 `\\.\pipe\chrono-host-<sha256(root) 前 16 位>`；POSIX 为 `<root>/state/sock/host.sock`）。

## 公共面

```ts
import { connect } from './index.ts'

const client = await connect({ root, timeoutMs: 30_000 })
```

| 成员                                              | 作用                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `connect(options)`                                | 连接运行中的宿主，返回 `Client`；失败 reject                                     |
| `client.submit(directives, opts?)`                | 提交 directives，等 `accepted` 与 run 结束，返回 `{run, status, observations}`   |
| `client.cancel(run)`                              | 真取消：中止在途 / 排队的 run；未知 / 已结束 → `unknown_run`                     |
| `client.command(name, args?, opts?)`              | 调插件命令（宿主解析声明、校验 `args`、走一次 run）                              |
| `client.forward(identity, command, args?, opts?)` | 插件入站转发：把帧交给该身份自己声明的入口；属主不符 → `unknown_command`         |
| `client.commands()`                               | 列出已声明命令（客户端没有世界，必须问宿主）                                     |
| `client.audit(filter?)`                           | 只读审计面：按 `run` / `emitter` / `outcome` 查询（seq 降序，缺省 100 条）       |
| `client.putAsset(mime, bytes)`                    | 资产入库：字节直写宿主资产区（不进世界），返回 `{kind:'asset',sha256,mime,size}` |
| `client.getAsset(sha256)`                         | 取资产字节；字节缺失 → `asset_missing`                                           |
| `client.putSecret(name, value)`                   | 直写宿主本地密钥文件（不进世界、不进审计）                                       |
| `client.deleteSecret(name)`                       | 删除本地密钥条目；不存在也回 `secrets.ok`（幂等）                                |
| `client.status()`                                 | `{world_head, world_rev, loaded}` 非阻塞快照（可能瞬态）                         |
| `client.stop()`                                   | 令宿主停机并关闭连接                                                             |
| `client.onEvent(handler)`                         | 订阅宿主广播的服务 `event`（`impl` 命名空间；无 ack、可丢）                      |
| `client.close()`                                  | 断开连接                                                                         |

- `opts.caps` / `opts.limits` 由发起者给，宿主**透传不扩权**；`now` 由宿主固定，不由客户端给。
- `connect` 的 `runTimeoutMs` 是**一次 run**（`submit` / `command` / `forward`）的整体等待上限，与普通请求
  超时分开；缺省回落 `timeoutMs`，`boot` 按宿主 `call-timeout` 口径透传（run 可跨多轮、多次服务调用，
  用单次调用口径判它会误判 `timeout`）。
- `putAsset` 在入口按 `MAX_ASSET_BYTES`（8 MiB）前置校验，超限抛 `asset_too_large`，不发超限帧。
- `opts.onAccepted(run)`：受理即回调，给 UI 留取消 / 展示用的 run 句柄；被取消的 run 以
  `status: 'cancelled'` 收口（与宿主 `stop` 停机是两回事）。
- `ClientError` 携带协议错误码（`writer_busy` / `unknown_command` / `bad_args` / `unknown_run` / `timeout` / `internal` / …），
  码表见 [`docs/protocol.md`](../../docs/protocol.md) §四；连接关闭时在途请求以 `connection_closed` 收口。
- 解码器与请求等待器都做了异常收口：坏帧 / 超上限帧只关闭连接，不让异常冒泡崩客户端进程。

## 协议形状

消息枚举在 `protocol.ts`（`v = '1'`）；`submit` / `cancel` / `command` / `forward` / `commands` / `audit` /
`asset.put` / `asset.get` / `secrets.put` / `secrets.delete` / `status` / `stop` 与 `accepted` / `result` /
`list` / `audits` / `asset.ref` / `asset.bytes` / `secrets.ok` / `state` / `error` 的完整定义见
[`docs/protocol.md`](../../docs/protocol.md) §三。
`run` 结果按 run id 配对；`event` 广播给所有已连接客户端，不落账、不推进。

## 边界

- 不 import `host`：客户端与服务端各自独立（只有内核类型与 `canonicalJson` 共享）。
- 不做判定、不读世界、不写链；命令**不是**改世界的旁路——判定仍是 term，写仍经宿主落账。
- 不做订阅过滤 / 背压 / 持久：`event` 无客户端即丢。

## 本地检查

```
cd packages/client
npm ci
npm run typecheck
npm run format:check
npm test             # test/client.test.ts、test/frame.test.ts、test/oversize.test.ts、test/secrets.test.ts、
                     # test/asset-limit.test.ts、test/run-timeout.test.ts 等
```

用法示例见 `test/client.test.ts`（起一个宿主后 `submit` / `command` / `status` / `stop`）。

client / host 两侧的入站线常量（命名管道前缀与根摘要长度、`PROTOCOL_VERSION`、`MAX_FRAME_BYTES`）各自实现、
不跨包共享，由仓库级门禁 `tests/static/host-client-wire-parity.test.mjs` 钉死。
