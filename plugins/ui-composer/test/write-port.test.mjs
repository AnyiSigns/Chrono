// 运行记录写口测试（node --test）：槽 / 配置写走 owner 命令（`input.write` / `config.write`），
// 不再构造世界写 directive（`ctx.submit` 调用为 0、帧内无 `add_gen` / `$directives`）。
// 覆盖：命令名与 args 形状、写读往返、同回合重复写幂等（命令幂等由 owner 服务保证，此处断言同参重复调用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createClient } from '../execute/web/client.ts'

/** 记录型假壳 api：`command` 记名与参，`submit` 只记数（写口不该走它）。 */
function fakeCtx() {
  const commands = []
  let submits = 0
  return {
    commands,
    submits: () => submits,
    tokens: { messages: '' },
    uiState: { get: () => undefined, set: () => {}, subscribe: () => () => {} },
    events: { connected: () => true, onAny: () => () => {} },
    command: async (name, args, options) => {
      commands.push({ name, args, thread: options?.thread ?? null })
      return { ok: true, value: { ok: true, thread: 't1' } }
    },
    submit: async () => {
      submits += 1
      return { ok: true, run: 'r1' }
    },
    cancel: async () => ({ ok: true, code: '' }),
  }
}

test('writeSlot：走 input.write 命令，不产世界写 directive', async () => {
  const ctx = fakeCtx()
  const client = createClient(ctx)
  const slot = { kind: 'chat.message', text: 'hi', attachments: [] }
  const result = await client.writeSlot('t1', slot)
  assert.equal(result.ok, true)
  assert.deepEqual(ctx.commands, [
    { name: 'input.write', args: { thread: 't1', slot }, thread: 't1' },
  ])
  assert.equal(ctx.submits(), 0, '写口不得走 ctx.submit')
  assert.equal(JSON.stringify(ctx.commands).includes('add_gen'), false)
  assert.equal(JSON.stringify(ctx.commands).includes('$directives'), false)
})

test('writeSlot：同参重复写幂等（命令可重发，owner 服务按线程键覆盖）', async () => {
  const ctx = fakeCtx()
  const client = createClient(ctx)
  const slot = { kind: 'idle' }
  await client.writeSlot('t1', slot)
  await client.writeSlot('t1', slot)
  assert.equal(ctx.commands.length, 2)
  assert.deepEqual(ctx.commands[0].args, ctx.commands[1].args)
  assert.equal(ctx.submits(), 0)
})

test('writeConfig：走 config.write 命令且只带补丁，不产世界写 directive', async () => {
  const ctx = fakeCtx()
  const client = createClient(ctx)
  const result = await client.writeConfig({ vendor: 'v', model: 'm' })
  assert.equal(result.ok, true)
  assert.deepEqual(ctx.commands, [
    { name: 'config.write', args: { patch: { vendor: 'v', model: 'm' } }, thread: null },
  ])
  assert.equal(ctx.submits(), 0, '写口不得走 ctx.submit')
  assert.equal(JSON.stringify(ctx.commands).includes('add_gen'), false)
})

test('writeConfig：空补丁也走命令（不构造空 batch）', async () => {
  const ctx = fakeCtx()
  const client = createClient(ctx)
  await client.writeConfig({})
  assert.deepEqual(ctx.commands, [{ name: 'config.write', args: { patch: {} }, thread: null }])
  assert.equal(ctx.submits(), 0)
})
