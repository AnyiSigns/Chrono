// 配置读取状态测试（node --test）：区分「空配置」与「读失败 / 不可达」，
// 并验证 store 在 config.read 失败时置显式错误态而非静默退化成空配置。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { configNoticeCode, configStatusOf, LOADING_NOTE_MS } from '../execute/web/model.ts'
import { createComposerStore } from '../execute/web/store.ts'
import { lookupMessage, UI_TEXT } from '../execute/web/messages.ts'

function fakeCtx(result, connected = true) {
  return {
    tokens: { messages: '/assets/messages.v1.json', css: '', icons: '' },
    events: { connected: () => connected, onAny: () => () => {} },
    uiState: { get: () => undefined, subscribe: () => () => {} },
    command: async () => result,
  }
}

test('配置状态判定：loading / offline / failed / empty / ready 互不混淆', () => {
  const base = { loading: false, connected: true, error: null, hasConfig: false }
  assert.equal(configStatusOf({ ...base, loading: true }), 'loading')
  assert.equal(configStatusOf({ ...base, connected: false }), 'offline')
  assert.equal(configStatusOf({ ...base, error: 'boom' }), 'failed')
  assert.equal(configStatusOf({ ...base, error: 'ui_unreachable' }), 'offline')
  assert.equal(configStatusOf({ ...base, error: 'transport_failed' }), 'offline')
  assert.equal(configStatusOf(base), 'empty')
  assert.equal(configStatusOf({ ...base, hasConfig: true }), 'ready')
  // 已读到配置时刷新失败也显式化（配置仍可用，下拉不禁用），不把失败吞掉。
  assert.equal(configStatusOf({ ...base, hasConfig: true, error: 'boom' }), 'failed')
  assert.equal(LOADING_NOTE_MS, 8000)
})

test('配置提示码：各态取不同文案码，ready / empty 无提示', () => {
  assert.equal(configNoticeCode('loading'), 'composer_config_loading')
  assert.equal(configNoticeCode('offline'), 'composer_config_offline')
  assert.equal(configNoticeCode('failed'), 'composer_config_failed')
  assert.equal(configNoticeCode('ready'), null)
  assert.equal(configNoticeCode('empty'), null)
  assert.equal(UI_TEXT.composer_config_loading_more, '仍在读取…')
  assert.equal(lookupMessage(null, 'composer_config_failed').body, UI_TEXT.composer_config_failed)
  assert.equal(lookupMessage(null, 'composer_config_offline').body, UI_TEXT.composer_config_offline)
})

test('store：config.read 失败置 failed，不静默退化成空配置', async () => {
  const store = createComposerStore(fakeCtx({ ok: false, code: 'boom' }))
  try {
    await store.refreshConfig()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.configStatus, 'failed')
    assert.equal(snapshot.configError, 'boom')
    assert.equal(snapshot.config, null)
  } finally {
    store.dispose()
  }
})

test('store：读成功但空配置归 empty / ready，与失败互不混淆', async () => {
  const empty = createComposerStore(fakeCtx({ ok: true, value: { active: null, body: null } }))
  try {
    await empty.refreshConfig()
    assert.equal(empty.getSnapshot().configStatus, 'empty')
  } finally {
    empty.dispose()
  }

  const object = createComposerStore(fakeCtx({ ok: true, value: { active: null, body: {} } }))
  try {
    await object.refreshConfig()
    assert.equal(object.getSnapshot().configStatus, 'ready')
  } finally {
    object.dispose()
  }
})

test('store：断连且读失败归 offline', async () => {
  const store = createComposerStore(fakeCtx({ ok: false, code: 'boom' }, false))
  try {
    await store.refreshConfig()
    assert.equal(store.getSnapshot().configStatus, 'offline')
  } finally {
    store.dispose()
  }
})
