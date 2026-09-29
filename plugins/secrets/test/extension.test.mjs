// 扩展点零改动证明：新增一个密钥后端（夹具 `secrets-vault`，`implements:["secrets-backend"]`，
// kinds = ["vault"]）后，`secrets` 与消费方零改动：
//   1) 成员表换代（世界变更 → 重注入）后，`auth_ref.kind = vault` 经 `secrets` 路由到该后端；
//   2) `resolve` / `list` 契约与 manifest 不变（消费方代码零改动）；
//   3) 同一 kind 由多个成员声明 → 歧义报错（不静默选中）。
// 成员表由宿主按世界能力索引注入（测试以 `CHRONO_PLUGIN_MANY_NEEDS` 模拟一次世界变更）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startBridgedService } from './bridge.mjs'
import { startFacade } from './driver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = resolve(
  HERE,
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'plugins',
  'secrets-vault',
)
const FIXTURE_ENTRY = join(FIXTURE_ROOT, 'execute', 'main.mjs')

function makeRoot() {
  mkdirSync(join(tmpdir(), 'kilo'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'kilo', 'secrets-ext-'))
  const secretsFile = join(root, 'state', 'secrets.local.json')
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(secretsFile, JSON.stringify({ LOCAL_KEY: 'local-value' }))
  return { secretsFile }
}

test('零改动：成员表换代后 kind=vault 经 secrets 路由到新后端，消费方契约不变', async () => {
  const vault = startBridgedService({
    cwd: FIXTURE_ROOT,
    entry: FIXTURE_ENTRY,
    timeoutMs: 15000,
  })
  const { secretsFile } = makeRoot()
  const env = { ENV_KEY: 'env-value' }

  // 换代前：成员表只有内置 local / env，vault 未加入 → kind 未声明。
  const before = startFacade({
    members: ['secrets-env', 'secrets-local'],
    secretsFile,
    env,
  })
  try {
    assert.deepEqual((await before.hello()).methods.secrets, ['resolve', 'list'])
    const unsupported = await before.call('resolve', {
      auth_ref: { kind: 'vault', name: 'VAULT_TOKEN' },
    })
    assert.equal(unsupported.kind, 'error')
    assert.equal(unsupported.code, 'secret_kind_unsupported')
  } finally {
    before.close()
    await before.exit
  }

  // 换代后：世界成员表新增 `secrets-vault`（宿主重解析并重注入），门面代码零改动。
  const after = startFacade({
    members: ['secrets-env', 'secrets-local', 'secrets-vault'],
    secretsFile,
    env,
    vault,
  })
  try {
    assert.deepEqual((await after.hello()).methods.secrets, ['resolve', 'list'])

    const vaultResolved = await after.call('resolve', {
      auth_ref: { kind: 'vault', name: 'VAULT_TOKEN' },
    })
    assert.equal(vaultResolved.kind, 'result', JSON.stringify(vaultResolved))
    assert.equal(vaultResolved.value, 'vault-token-xyz')

    // 既有 kind 不受影响：local / env 仍经各自后端解析。
    const local = await after.call('resolve', { auth_ref: { kind: 'local', name: 'LOCAL_KEY' } })
    assert.equal(local.value, 'local-value')
    const envResolved = await after.call('resolve', { auth_ref: { kind: 'env', name: 'ENV_KEY' } })
    assert.equal(envResolved.value, 'env-value')

    // list 汇总可枚举后端（local + vault；env 恒空表）。
    const listed = await after.call('list', {})
    assert.deepEqual(listed.value, [
      { name: 'LOCAL_KEY', has: true },
      { name: 'VAULT_TOKEN', has: true },
    ])

    // 反向定位确实按成员身份发出（帧带 provider）——加成员只改世界，不改门面。
    assert.ok(
      after.portCalls.some(
        (call) => call.port === 'secrets-backend' && call.provider === 'secrets-vault',
      ),
      '未按成员身份反调 secrets-vault',
    )
  } finally {
    after.close()
    await after.exit
    vault.close()
    await vault.exit
  }
})

test('隔离：一个后端不可达不影响其它 kind 的解析（只隔离提供方）', async () => {
  const { secretsFile } = makeRoot()
  // 成员表含 vault，但未启 vault 进程 → 该成员不可达。
  const drv = startFacade({
    members: ['secrets-env', 'secrets-local', 'secrets-vault'],
    secretsFile,
    env: { ENV_KEY: 'env-value' },
  })
  try {
    await drv.hello()
    const local = await drv.call('resolve', { auth_ref: { kind: 'local', name: 'LOCAL_KEY' } })
    assert.equal(local.kind, 'result', JSON.stringify(local))
    assert.equal(local.value, 'local-value')
    const envResolved = await drv.call('resolve', { auth_ref: { kind: 'env', name: 'ENV_KEY' } })
    assert.equal(envResolved.value, 'env-value')
    // 唯一声明该 kind 的成员不可达 → 不可读，而非误报未声明。
    const vault = await drv.call('resolve', { auth_ref: { kind: 'vault', name: 'VAULT_TOKEN' } })
    assert.equal(vault.kind, 'error')
    assert.equal(vault.code, 'secret_unreadable')
    // list 跳过不可达成员，仍返回可达后端的清单。
    const listed = await drv.call('list', {})
    assert.deepEqual(listed.value, [{ name: 'LOCAL_KEY', has: true }])
  } finally {
    drv.close()
    await drv.exit
  }
})

test('歧义：两个成员声明同一 kind → secret_kind_ambiguous（不静默选中）', async () => {
  const vault = startBridgedService({ cwd: FIXTURE_ROOT, entry: FIXTURE_ENTRY, timeoutMs: 15000 })
  const { secretsFile } = makeRoot()
  // 两个 provider 名都路由到同一 vault 夹具 → 都自述 kind = vault。
  const drv = startFacade({
    members: ['secrets-vault', 'secrets-vault-b'],
    secretsFile,
    vault,
    vaultAliases: ['secrets-vault', 'secrets-vault-b'],
  })
  try {
    await drv.hello()
    const message = await drv.call('resolve', { auth_ref: { kind: 'vault', name: 'VAULT_TOKEN' } })
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'secret_kind_ambiguous')
  } finally {
    drv.close()
    await drv.exit
    vault.close()
    await vault.exit
  }
})
