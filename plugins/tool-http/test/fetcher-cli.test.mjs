// 内置 fetcher CLI 测试：跑真实脚本打本地 http（离线、不触外网），校验契约形状、
// 截断、重定向跟随与失败退出码。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'execute', 'fetcher-cli.mjs')

/** 起一次本地服务，回 `{base, close}`；handler 收 `(req, res)`。 */
function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/** 跑一次 fetcher，回 `{code, stdout, stderr}`。 */
function runFetcher(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    )
  })
}

function parseMeta(stdout) {
  const newline = stdout.indexOf('\n')
  const meta = JSON.parse(stdout.slice(0, newline))
  const body = Buffer.from(stdout.slice(newline + 1).trim(), 'base64')
  return { meta, body }
}

test('fetcher CLI：200 文本 → 首行元数据 + base64 体', async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('hello world')
  })
  try {
    const result = await runFetcher([
      '--url',
      `${srv.base}/a`,
      '--method',
      'GET',
      '--timeout',
      '3000',
      '--max-size',
      '1024',
      '--max-redirs',
      '3',
      '--meta',
    ])
    assert.equal(result.code, 0)
    const { meta, body } = parseMeta(result.stdout)
    assert.equal(meta.status, 200)
    assert.equal(meta.body_encoding, 'base64')
    assert.equal(meta.truncated, false)
    assert.ok(String(meta.content_type).startsWith('text/plain'))
    assert.equal(body.toString('utf8'), 'hello world')
  } finally {
    await srv.close()
  }
})

test('fetcher CLI：超过 --max-size 截断并标记 truncated', async () => {
  const srv = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('abcdefghijklmnop')
  })
  try {
    const result = await runFetcher([
      '--url',
      `${srv.base}/big`,
      '--method',
      'GET',
      '--timeout',
      '3000',
      '--max-size',
      '5',
      '--max-redirs',
      '3',
      '--meta',
    ])
    assert.equal(result.code, 0)
    const { meta, body } = parseMeta(result.stdout)
    assert.equal(meta.truncated, true)
    assert.equal(body.toString('utf8'), 'abcde')
  } finally {
    await srv.close()
  }
})

test('fetcher CLI：跟随重定向并在元数据回带最终 URL', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/final' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('landed')
  })
  try {
    const result = await runFetcher([
      '--url',
      `${srv.base}/start`,
      '--method',
      'GET',
      '--timeout',
      '3000',
      '--max-size',
      '1024',
      '--max-redirs',
      '3',
      '--meta',
    ])
    assert.equal(result.code, 0)
    const { meta, body } = parseMeta(result.stdout)
    assert.equal(meta.status, 200)
    assert.ok(String(meta.url).endsWith('/final'))
    assert.equal(body.toString('utf8'), 'landed')
  } finally {
    await srv.close()
  }
})

test('fetcher CLI：传输失败 → 非零退出码 + stderr', async () => {
  const result = await runFetcher([
    '--url',
    'http://127.0.0.1:1/nope',
    '--method',
    'GET',
    '--timeout',
    '1500',
    '--max-size',
    '64',
    '--max-redirs',
    '0',
    '--meta',
  ])
  assert.notEqual(result.code, 0)
  assert.ok(result.stderr.trim().length > 0)
})
