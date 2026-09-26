// 启动失败收口：锁在启动中途抛出后必须释放（不留 stale 锁文件）；
// startAssembly 在已 spawn 服务后抛出时必须收口这些服务，不留孤儿子进程。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import { startAssembly } from '../assembly/index.ts'
import { runSeed } from '../offline.ts'
import { loadAnchor } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import {
  isPidAlive,
  killProcessTree,
  waitFor,
  writeTempPackage,
} from './test-helpers-ext.ts'

/**
 * 探针服务：启动即把自己的 pid 写进物化目录，随后按服务协议应答握手 / 探针 / drain，
 * 供「startAssembly 中途抛出后进程是否被收口」断言。
 */
const PID_SERVICE = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "service.pid"), String(process.pid));
function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}
function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.kind) {
    case "hello": {
      const p = JSON.parse(fs.readFileSync(path.join(process.cwd(), "plugin.json"), "utf8"));
      frame({ v: "1", id: msg.id, kind: "manifest", identity: p.identity, implements: p.implements, methods: p.methods, protocol: p.protocol, state: p.state });
      return;
    }
    case "probe": frame({ id: msg.id, kind: "pong", ok: true }); return;
    case "reload": frame({ v: "1", id: msg.id, kind: "ack" }); return;
    case "drain": frame({ v: "1", id: msg.id, kind: "bye" }); return;
    case "call": frame({ v: "1", id: msg.id, kind: "result", ok: true, value: { pid: process.pid } }); return;
  }
}
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < 4 + length) break;
    const body = buffer.subarray(4, 4 + length).toString("utf8");
    buffer = buffer.subarray(4 + length);
    try { handle(JSON.parse(body)); } catch (e) {}
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
`

/** 在物化目录树里找探针服务写下的 pid 文件。 */
function findServicePid(dir: string): number | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findServicePid(full)
      if (found !== null) return found
      continue
    }
    if (entry.name !== 'service.pid') continue
    const pid = Number.parseInt(readFileSync(full, 'utf8'), 10)
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}

describe('启动失败收口', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  it('载锚抛 bad_base：锁已释放，不留 stale 锁文件', async () => {
    // 形态损坏的 base.json：readBase / verify 抛 bad_base，抛出点在抢锁之后、装配之前
    writeFileSync(join(root, 'state', 'world', 'base.json'), '{ not a base file')
    await expect(startHost({ root })).rejects.toThrow('bad_base')
    expect(existsSync(hostPaths(root).lockFile)).toBe(false)
  })

  it('startAssembly 已 spawn 服务后抛出：服务被收口，无孤儿进程', async () => {
    const alphaRoot = writeTempPackage(root, {
      identity: 'toy-a',
      start: 'node execute/main.js',
      implements: ['toy.a'],
      methods: { 'toy.a': ['echo'] },
      files: { 'execute/main.js': PID_SERVICE },
    })
    const betaRoot = writeTempPackage(root, {
      identity: 'toy-b',
      start: 'node execute/main.js',
      implements: ['toy.b'],
      methods: { 'toy.b': ['echo'] },
    })
    const seeded = runSeed(root, [
      { name: 'toy-a', path: alphaRoot },
      { name: 'toy-b', path: betaRoot },
    ])
    expect(seeded.ok).toBe(true)
    const world = loadAnchor(hostPaths(root).journalFile).world

    await expect(
      startAssembly({
        root,
        world,
        // 同层串行：toy-a 先起（spawn + 握手成功），toy-b 的准备阶段注入失败
        startConcurrency: 1,
        restore: async (_cwd, decl) => {
          if (decl.identity === 'toy-b') throw new Error('injected restore failure')
        },
        // 运维日志在 toy-b 的失败事件处抛出：令 start() 中途抛出，而 toy-a 已 spawn
        log: (record) => {
          if (record.kind === 'service' && record.event === 'start_failed' && record.impl === 'toy-b') {
            throw new Error('injected log failure')
          }
        },
      }),
    ).rejects.toThrow()

    const pid = findServicePid(join(root, 'state', 'runtime', 'materialized'))
    expect(pid).not.toBeNull()
    const target = pid as number
    try {
      await waitFor(() => !isPidAlive(target), '孤儿服务进程退出', 5000)
    } finally {
      if (isPidAlive(target)) await killProcessTree(target)
    }
  })
})
