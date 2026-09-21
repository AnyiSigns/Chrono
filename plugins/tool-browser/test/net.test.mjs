// `caps.net` 声明级钳制测试：档位映射、数据世代覆盖、越档 net_denied、fail-closed、
// 与 sandbox 档位表 / caps 解析口径的一致性。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BUILTIN_TIER_NET,
  assertNetAllowed,
  declaredNetScope,
  netRank,
  sandboxNetEnforcement,
  tierNetScope,
} from '../execute/net.ts'
import { ToolError } from '../execute/types.ts'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX_BODY = join(PKG_ROOT, '..', 'sandbox', 'tools', 'default-body.json')

function denied(tier, caps, sandboxTiers) {
  try {
    assertNetAllowed(tier, caps, sandboxTiers)
    return false
  } catch (err) {
    assert.ok(err instanceof ToolError)
    assert.equal(err.code, 'net_denied')
    return true
  }
}

test('内建档位映射与 sandbox 内建兜底同形', () => {
  assert.equal(tierNetScope('auto', undefined), 'all')
  assert.equal(tierNetScope('severe', undefined), 'limited')
  assert.equal(tierNetScope('review', undefined), 'none')
  assert.equal(tierNetScope('deny', undefined), 'none')
})

test('内建档位表与 sandbox tools/default-body.json 逐档一致', () => {
  const body = JSON.parse(readFileSync(SANDBOX_BODY, 'utf8'))
  for (const [tier, policy] of Object.entries(body.tiers)) {
    assert.equal(BUILTIN_TIER_NET[tier], policy.net, `档位 ${tier} 的 net 与 sandbox 不一致`)
  }
  assert.deepEqual(Object.keys(BUILTIN_TIER_NET).sort(), Object.keys(body.tiers).sort())
})

test('未知 / 缺失档位 fail-closed 为 none', () => {
  assert.equal(tierNetScope('nope', undefined), 'none')
  assert.equal(tierNetScope(null, undefined), 'none')
  assert.equal(tierNetScope(undefined, undefined), 'none')
})

test('bag.sandbox_tiers 覆盖内建映射', () => {
  const sandboxTiers = { tiers: { severe: { net: 'none' }, review: { net: 'all' } } }
  assert.equal(tierNetScope('severe', sandboxTiers), 'none')
  assert.equal(tierNetScope('review', sandboxTiers), 'all')
  assert.equal(tierNetScope('auto', sandboxTiers), 'all')
})

test('声明 net 解析：只认字符串 none / limited / all，畸形按未声明（与 sandbox 口径一致）', () => {
  assert.equal(declaredNetScope({ net: 'all' }), 'all')
  assert.equal(declaredNetScope({ net: 'limited' }), 'limited')
  assert.equal(declaredNetScope({ net: 'none' }), 'none')
  // 布尔 / 未知字符串 / 缺失都视为未声明，与 sandbox `parse_caps` 对畸形 net 的回落一致。
  assert.equal(declaredNetScope({ net: true }), 'none')
  assert.equal(declaredNetScope({ net: false }), 'none')
  assert.equal(declaredNetScope({ net: 'bogus' }), 'none')
  assert.equal(declaredNetScope(undefined), 'none')
  assert.equal(netRank('none'), 0)
  assert.equal(netRank('limited'), 1)
  assert.equal(netRank('all'), 2)
})

test('越档 net_denied：all 需求下只有 auto 放行，severe / review / deny 拒绝', () => {
  assert.equal(denied('auto', { net: 'all' }, undefined), false)
  assert.equal(denied('severe', { net: 'all' }, undefined), true)
  assert.equal(denied('review', { net: 'all' }, undefined), true)
  assert.equal(denied('deny', { net: 'all' }, undefined), true)
  // severe 档位范围是 limited：limited 需求在档内，all 越档。
  assert.equal(denied('severe', { net: 'limited' }, undefined), false)
  assert.equal(denied('severe', { net: 'none' }, undefined), false)
})

test('不声明 net / 声明 none 不拦', () => {
  assert.equal(denied('review', undefined, undefined), false)
  assert.equal(denied('deny', { net: false }, undefined), false)
  assert.equal(denied('deny', { net: 'none' }, undefined), false)
})

test('数据世代覆盖改判定', () => {
  const sandboxTiers = { tiers: { severe: { net: 'none' } } }
  assert.equal(denied('severe', { net: 'all' }, sandboxTiers), true)
})

test('sandboxNetEnforcement 读 capabilities.enforcement.net；缺失 / 畸形回 null', () => {
  assert.equal(sandboxNetEnforcement({ enforcement: { net: 'declaration' } }), 'declaration')
  assert.equal(sandboxNetEnforcement({ enforcement: {} }), null)
  assert.equal(sandboxNetEnforcement({}), null)
  assert.equal(sandboxNetEnforcement(null), null)
  assert.equal(sandboxNetEnforcement(undefined), null)
})
