// client / host 入站面跨包对表门禁。两侧刻意各自实现、不跨包共享代码
// （`packages/client` 与 `packages/host` 边界独立），故用静态对表钉死不漂：
//   A. 地址派生：`packages/client/socket.ts` ↔ `packages/host/paths.ts`
//      —— `resolveRoot` / `socketPath` 逐字等价；Windows named pipe 前缀与根摘要长度钉死。
//   B. 协议版本：`packages/client/protocol.ts` ↔ `packages/host/wire.ts` 的 `PROTOCOL_VERSION`。
//   C. 帧上限：`packages/host/wire.ts` 导出的 `MAX_FRAME_BYTES` ↔ `packages/client/frame.ts`
//      内部常量（未导出，按源码扫描）。
// 失败信息指出漂移侧。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolveRoot as clientResolveRoot,
  socketPath as clientSocketPath,
} from '../../packages/client/socket.ts'
import {
  resolveRoot as hostResolveRoot,
  socketPath as hostSocketPath,
} from '../../packages/host/paths.ts'
import { PROTOCOL_VERSION as clientProtocol } from '../../packages/client/protocol.ts'
import { PROTOCOL_VERSION as hostProtocol, MAX_FRAME_BYTES } from '../../packages/host/wire.ts'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

// 与两侧实现绑定的字面量：改动即协议 / 地址派生破兼容，必须显式改本表。
const PIPE_PREFIX = '\\\\.\\pipe\\chrono-host-'
const DIGEST_HEX_LEN = 16
const PROTOCOL_VERSION_PINNED = '1'

test('地址派生：client.socket ↔ host.paths 逐字等价（管道前缀 / 摘要长度）', () => {
  const samples = ['C:\\repo\\alpha', 'C:\\repo\\beta', '/tmp/repo gamma', 'relative-root']
  for (const root of samples) {
    const expected =
      process.platform === 'win32'
        ? PIPE_PREFIX + createHash('sha256').update(root).digest('hex').slice(0, DIGEST_HEX_LEN)
        : resolve(root, 'state', 'sock', 'host.sock')
    const client = clientSocketPath(root)
    const host = hostSocketPath(root)
    assert.equal(client, host, `socketPath 两侧漂移（root=${root}）：client=${client} host=${host}`)
    assert.equal(
      client,
      expected,
      `socketPath 与钉死的派生规则不符（root=${root}）：实际=${client}`,
    )
    if (process.platform === 'win32') {
      assert.ok(client.startsWith(PIPE_PREFIX), `Windows 管道前缀漂移：${client}`)
      const digest = client.slice(PIPE_PREFIX.length)
      assert.match(
        digest,
        new RegExp(`^[0-9a-f]{${DIGEST_HEX_LEN}}$`),
        `根摘要长度 / 字符集漂移（应 ${DIGEST_HEX_LEN} 位小写十六进制）：${digest}`,
      )
    }
  }
  const explicit = 'C:\\repo\\explicit'
  assert.equal(
    clientResolveRoot(explicit),
    hostResolveRoot(explicit),
    'resolveRoot 显式参数两侧漂移',
  )
})

test('协议版本：client.protocol ↔ host.wire 一致且钉死', () => {
  assert.equal(
    clientProtocol,
    hostProtocol,
    `PROTOCOL_VERSION 两侧漂移：client=${clientProtocol} host=${hostProtocol}`,
  )
  assert.equal(
    clientProtocol,
    PROTOCOL_VERSION_PINNED,
    `PROTOCOL_VERSION 被改动（${clientProtocol}）：协议变更须同步 client / host 与本表`,
  )
})

test('帧上限：host.wire.MAX_FRAME_BYTES ↔ client/frame.ts 内部常量一致', () => {
  const src = readFileSync(join(ROOT, 'packages', 'client', 'frame.ts'), 'utf8')
  const match = src.match(/MAX_FRAME_BYTES\s*=\s*([0-9_*\s]+)/)
  assert.notEqual(match, null, 'client/frame.ts 中找不到 MAX_FRAME_BYTES 常量')
  const expr = match[1].trim()
  const clientFrameBytes = expr
    .split('*')
    .map((term) => Number(term.trim().replace(/_/g, '')))
    .reduce((left, right) => left * right, 1)
  assert.ok(Number.isFinite(clientFrameBytes), `无法解析 client 帧上限表达式：${expr}`)
  assert.equal(
    clientFrameBytes,
    MAX_FRAME_BYTES,
    `帧上限两侧漂移：client/frame.ts=${clientFrameBytes} host/wire.ts=${MAX_FRAME_BYTES}`,
  )
})
