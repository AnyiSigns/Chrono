// 门禁前置于效果（net 档）：兜底判定必须带上「工具声明 net + 当前档 net 范围」，
// 且消费侧必须按 gate 传出的裁决字符串（allow / approved / escalate / deny）理解——
// 否则越档调用 / 升级调用会被静默放行，工具实际效果已发出而审批闸门形同虚设。
// 真 guard 判定直接接入（与 loop-policy 的 gate 同源），保证「判 escalate ⇒ 提供者不被触达」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'
import { judge } from '../../guard/execute/judge.ts'

const NO_CAPS = { fs: { read: 'none', write: 'none' }, net: 'none' }

function decl(name, caps, overrides = {}) {
  return {
    name,
    provider: 'tool-http',
    kind: 'invoke',
    method: null,
    read: null,
    intent: 'i',
    when_to_use: 'w',
    param_semantics: { url: 'u' },
    boundaries: 'b',
    description: 'd',
    argsSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    caps,
    idempotent: true,
    ...overrides,
  }
}

const WEBFETCH = decl('webfetch', { fs: { read: 'none', write: 'none' }, net: 'all' })
const READ = decl(
  'read',
  { fs: { read: 'workspace', write: 'none' }, net: 'none' },
  {
    provider: 'tool-fs',
    param_semantics: { path: 'p' },
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    idempotent: false,
  },
)

function directory(tools) {
  return { tools, rejected: [] }
}

async function withService(providers, fn) {
  const service = startService({ providers })
  try {
    await service.hello()
    return await fn(service)
  } finally {
    service.close()
  }
}

test('兜底判定带上 net 输入：guard.judge 收到工具声明 net 与档位 net 范围', async () => {
  let seen = null
  await withService(
    {
      guard: { judge: (args) => { seen = args; return { decisions: [{ index: 0, verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } } } },
      'tool-http': { invoke: () => ({ ok: true, result: {} }) },
    },
    async (service) => {
      await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'webfetch', args: { url: 'https://example.com' } }],
        directory: directory([WEBFETCH]),
        tier: 'severe',
        sandbox_tiers: { tiers: { severe: { net: 'limited' } } },
      })
    },
  )
  assert.equal(seen.calls[0].net, 'all', '工具声明 net 必须随 call 传入 guard')
  assert.equal(seen.tier_net, 'limited', '当前档 net 范围必须随 bag 传入 guard')
})

test('兜底判定（真 guard）：severe 下 webfetch（net=all）越档 → needs_approval，不触提供者', async () => {
  let invoked = 0
  await withService(
    {
      guard: { judge: (args) => judge(args) },
      'tool-http': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
    },
    async (service) => {
      const response = await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'webfetch', args: { url: 'https://example.com' } }],
        directory: directory([WEBFETCH]),
        tier: 'severe',
        sandbox_tiers: { tiers: { severe: { net: 'limited' } } },
      })
      assert.equal(response.value.results[0].ok, false)
      assert.equal(response.value.results[0].error.code, 'needs_approval')
    },
  )
  assert.equal(invoked, 0, '升级调用不得触达工具提供者（效果未发出）')
})

test('兜底判定 fail-closed：缺 tier → tier_net=none，越档仍升级', async () => {
  let invoked = 0
  await withService(
    {
      guard: { judge: (args) => judge(args) },
      'tool-http': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
    },
    async (service) => {
      const response = await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'webfetch', args: { url: 'https://example.com' } }],
        directory: directory([WEBFETCH]),
      })
      assert.equal(response.value.results[0].error.code, 'needs_approval')
    },
  )
  assert.equal(invoked, 0)
})

test('兜底判定：档位数据世代放宽 severe.net=all → 同调用放行', async () => {
  let invoked = 0
  await withService(
    {
      guard: { judge: (args) => judge(args) },
      'tool-http': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
    },
    async (service) => {
      const response = await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'webfetch', args: { url: 'https://example.com' } }],
        directory: directory([WEBFETCH]),
        tier: 'severe',
        sandbox_tiers: { tiers: { severe: { net: 'all' } } },
      })
      assert.equal(response.value.results[0].ok, true)
    },
  )
  assert.equal(invoked, 1)
})

test('消费侧按 gate 裁决字符串理解：escalate / deny 不得静默放行', async () => {
  let invoked = 0
  await withService(
    { 'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } } },
    async (service) => {
      const call = (verdicts) =>
        service.call('dispatch', {
          calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
          directory: directory([READ]),
          workspace_root: '/ws',
          verdicts,
        })

      const escalated = await call('escalate')
      assert.equal(escalated.value.results[0].error.code, 'needs_approval', 'gate escalate 必须拦在效果之前')
      const denied = await call('deny')
      assert.equal(denied.value.results[0].error.code, 'denied')
      const unknown = await call('bogus')
      assert.equal(unknown.value.results[0].error.code, 'denied', '未知裁决码 fail-closed')

      const allowed = await call('allow')
      assert.equal(allowed.value.results[0].ok, true)
      const approved = await call('approved')
      assert.equal(approved.value.results[0].ok, true)
    },
  )
  assert.equal(invoked, 2, '只有 allow / approved 才触达提供者')
})

test('消费侧：畸形 verdicts（非字符串 / 非数组 / 非对象）fail-closed 为 denied', async () => {
  let invoked = 0
  await withService(
    { 'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } } },
    async (service) => {
      const response = await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
        directory: directory([READ]),
        workspace_root: '/ws',
        verdicts: true,
      })
      assert.equal(response.value.results[0].error.code, 'denied')
    },
  )
  assert.equal(invoked, 0)
})

test('消费侧：escalate 字符串时零效果（提供者未被触达）', async () => {
  let invoked = 0
  await withService(
    { 'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } } },
    async (service) => {
      const response = await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
        directory: directory([READ]),
        workspace_root: '/ws',
        verdicts: 'escalate',
      })
      assert.equal(response.value.results[0].error.code, 'needs_approval')
    },
  )
  assert.equal(invoked, 0)
})

test('消费侧：结构化 verdicts（数组 / decisions / call_id 映射）语义不变', async () => {
  let invoked = 0
  await withService(
    { 'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } } },
    async (service) => {
      const arr = await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
        directory: directory([READ]),
        workspace_root: '/ws',
        verdicts: ['escalate'],
      })
      assert.equal(arr.value.results[0].error.code, 'needs_approval')
      const map = await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'read', args: { path: 'y.ts' } }],
        directory: directory([READ]),
        workspace_root: '/ws',
        verdicts: { c1: 'allow' },
      })
      assert.equal(map.value.results[0].ok, true)
    },
  )
  assert.equal(invoked, 1)
})

test('net=none 的工具不受 net 档影响（兜底判定照常放行）', async () => {
  let invoked = 0
  await withService(
    {
      guard: { judge: (args) => judge(args) },
      'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
    },
    async (service) => {
      const response = await service.call('dispatch', {
        calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
        directory: directory([READ]),
        workspace_root: '/ws',
        tier: 'severe',
        sandbox_tiers: { tiers: { severe: { net: 'limited' } } },
      })
      assert.equal(response.value.results[0].ok, true)
    },
  )
  assert.equal(invoked, 1)
  assert.equal(NO_CAPS.net, 'none')
})
