// 反向调用 `call_id` 精确配对（宿主端到端）：服务在 `port.call` 回带发起正向帧 id 时，
// 宿主必须用该帧的回合信息（run / thread）；未命中或非字符串不得回落队首，交宿主补时钟。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { PortAuditRecord } from '../port-audit.ts'
import type { Json } from '../../kernel/index.ts'

const ORIGIN_TERM: Json = ['eff', 'toy.origin', 'echo', ['c', { n: 1 }]]

/**
 * 反向调用夹具：按 `callIdMode` 决定 `port.call` 是否回带 `call_id`——
 * `match` 回带正向帧 id、`unknown` 回带不存在的 id、`omit` 不带该字段；帧编解码与宿主同形。
 */
const REVERSE_CALL_ID_MAIN = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "service-config.json"), "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") process.stderr.write("[call-id-toy] bad service-config.json");
}
function plugin() {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "plugin.json"), "utf8"));
}
function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}
let seq = 0;
const pending = new Map();
function onCall(msg) {
  const env = msg.env === undefined ? null : msg.env;
  if (!config.reversePort) {
    frame({ v: "1", id: msg.id, kind: "result", ok: true, value: { env: env, args: msg.args === undefined ? null : msg.args } });
    return;
  }
  const id = "pc-" + (++seq);
  const args = config.reverseArgs === undefined ? (msg.args === undefined ? null : msg.args) : config.reverseArgs;
  pending.set(id, { callId: msg.id });
  const call = { v: "1", id: id, kind: "port.call", port: config.reversePort, method: config.reverseMethod || "echo", args: args };
  if (config.callIdMode === "match") call.call_id = msg.id;
  else if (config.callIdMode === "unknown") call.call_id = "frame-does-not-exist";
  frame(call);
}
function onPort(id, value) {
  const waiting = pending.get(id);
  if (waiting === undefined) return;
  pending.delete(id);
  frame({ v: "1", id: waiting.callId, kind: "result", ok: true, value: { forwarded: value } });
}
function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.kind) {
    case "hello": {
      const p = plugin();
      frame(Object.assign({ id: msg.id, kind: "manifest" }, { v: "1", identity: p.identity, implements: p.implements, methods: p.methods, protocol: p.protocol, state: p.state }));
      return;
    }
    case "probe": frame({ id: msg.id, kind: "pong", ok: true }); return;
    case "reload": frame({ v: "1", id: msg.id, kind: "ack" }); return;
    case "drain": frame({ v: "1", id: msg.id, kind: "bye" }); return;
    case "call": onCall(msg); return;
    case "port.result": onPort(msg.id, msg.value === undefined ? null : msg.value); return;
    case "port.error": onPort(msg.id, { error: msg.error === undefined ? null : msg.error }); return;
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
    try { handle(JSON.parse(body)); } catch (err) { process.stderr.write("[call-id-toy] bad frame: " + err.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
`

describe('反向调用 call_id 精确配对（宿主端到端）', () => {
  let root: string
  const handles: HostHandle[] = []

  beforeEach(() => {
    root = createTempRoot()
    handles.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 兜底停机
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  function seedReverse(callIdMode: 'match' | 'unknown' | 'omit'): void {
    const target = writeTempPackage(root, {
      identity: 'toy-target',
      implements: ['toy.target'],
      methods: { 'toy.target': ['echo'] },
      start: 'node execute/main.js',
    })
    const origin = writeTempPackage(root, {
      identity: 'toy-origin',
      implements: ['toy.origin'],
      methods: { 'toy.origin': ['echo'] },
      pins: { 'toy.target': 'toy-target' },
      start: 'node execute/main.js',
      serviceConfig: {
        reversePort: 'toy.target',
        reverseMethod: 'echo',
        reverseArgs: { n: 7 },
        callIdMode,
      },
      files: { 'execute/main.js': REVERSE_CALL_ID_MAIN },
    })
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.origin': 'toy-origin' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'run.json': JSON.stringify(ORIGIN_TERM) },
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'toy-target', path: target },
        { name: 'toy-origin', path: origin },
        { name: 'toy-caller', path: caller },
      ]).ok,
    ).toBe(true)
  }

  it('call_id 命中在途帧：端口审计用该正向调用的 run / thread', async () => {
    seedReverse('match')
    const captured: PortAuditRecord[] = []
    const handle = await startHost({
      root,
      portAuditSink: { record: (record) => captured.push(record) },
    })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.run', null, { thread: 'thr-cid' })
      expect(result.status).toBe('done')
      await waitFor(() => captured.length > 0, 'port audit record')
      expect(captured[0].thread).toBe('thr-cid')
      expect(captured[0].run).not.toBeNull()
    } finally {
      client.close()
    }
  }, 20000)

  it('未知 call_id 不回落队首：宿主补时钟（run / thread 记 null）', async () => {
    seedReverse('unknown')
    const captured: PortAuditRecord[] = []
    const handle = await startHost({
      root,
      portAuditSink: { record: (record) => captured.push(record) },
    })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.run', null, { thread: 'thr-cid' })
      expect(result.status).toBe('done')
      await waitFor(() => captured.length > 0, 'port audit record')
      // 精确配对未命中 → env undefined → 宿主补 null；若回落队首会串成 thr-cid
      expect(captured[0].thread).toBeNull()
      expect(captured[0].run).toBeNull()
    } finally {
      client.close()
    }
  }, 20000)
})
