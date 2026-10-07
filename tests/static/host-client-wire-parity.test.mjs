// 仓库级静态门禁：client / host 两侧入站线常量各自实现、不跨包共享，必须逐项对表。
// 钉死 `PROTOCOL_VERSION`、单帧上限（16 MiB）与命名管道派生规则（`chrono-host-` + 16 hex + `host.sock`）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function read(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

function protocolVersion(text, label) {
  const match = text.match(/PROTOCOL_VERSION\s*=\s*'([^']+)'/)
  assert.ok(match, `${label} 未找到 PROTOCOL_VERSION`)
  return match[1]
}

test('PROTOCOL_VERSION 两侧一致', () => {
  const host = protocolVersion(read('../../packages/host/wire.ts'), 'host/wire.ts')
  const client = protocolVersion(read('../../packages/client/protocol.ts'), 'client/protocol.ts')
  assert.equal(client, host)
})

test('单帧上限两侧一致（16 * 1024 * 1024）', () => {
  for (const [rel, label] of [
    ['../../packages/host/wire.ts', 'host/wire.ts'],
    ['../../packages/client/frame.ts', 'client/frame.ts'],
  ]) {
    const text = read(rel)
    assert.match(
      text,
      /MAX_FRAME_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024/,
      `${label} 单帧上限口径不符`,
    )
  }
})

test('命名管道派生规则两侧一致', () => {
  for (const [rel, label] of [
    ['../../packages/host/common/platform/socket.ts', 'host socket.ts'],
    ['../../packages/client/socket.ts', 'client socket.ts'],
  ]) {
    const text = read(rel)
    assert.match(text, /chrono-host-/, `${label} 缺管道前缀`)
    assert.match(text, /slice\(0,\s*16\)/, `${label} 根摘要长度不符`)
    assert.match(text, /host\.sock/, `${label} 缺 POSIX socket 文件名`)
  }
})
