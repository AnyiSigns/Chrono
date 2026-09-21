// 调用帧 `env` 注入：宿主在正向 `call` 与反向 `port.call` 转发的帧上填 `env: {run, thread, now}`。
// 夹具服务把收到的 `env` 原样回给宿主（经审计 def 可读），从而断言 run / thread / now 与透传语义。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal } from '../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'
import type { Directive, Json } from '../../kernel/index.ts'

/**
 * 测试夹具服务：`call` 时回 `{env, args, pid}`；配了 `serviceConfig.reversePort` 时先发反向
 * `port.call` 到目标，再把 `{env, forwarded, argsEnv}` 回给宿主。宿主 / 服务帧编解码与 fixture 同形。
 */
const ENV_SERVICE_MAIN = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "service-config.json"), "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") process.stderr.write("[env-toy] bad service-config.json");
}
function readPlugin() {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "plugin.json"), "utf8"));
}
function manifest() {
  const p = readPlugin();
  return { v: "1", identity: p.identity, implements: p.implements, methods: p.methods, protocol: p.protocol, state: p.state };
}
function writeFrame(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  process.stdout.write(frame);
}
function argsEnvOf(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args.env === undefined ? null : args.env;
}
let portSeq = 0;
const pendingPorts = new Map();
function handleCall(msg) {
  const env = msg.env === undefined ? null : msg.env;
  if (config.errorCode) {
    writeFrame({ v: "1", id: msg.id, kind: "error", ok: false, code: config.errorCode, message: config.errorCode });
    return;
  }
  if (!config.reversePort) {
    writeFrame({ v: "1", id: msg.id, kind: "result", ok: true, value: { env: env, args: msg.args === undefined ? null : msg.args, pid: process.pid } });
    return;
  }
  const id = "pc-" + (++portSeq);
  const args = config.reverseArgs !== undefined ? config.reverseArgs : (msg.args === undefined ? null : msg.args);
  pendingPorts.set(id, { callId: msg.id, env: env, argsEnv: argsEnvOf(msg.args) });
  writeFrame({ v: "1", id: id, kind: "port.call", port: config.reversePort, method: config.reverseMethod || "echo", args: args });
}
function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.kind) {
    case "hello": writeFrame(Object.assign({ id: msg.id, kind: "manifest" }, manifest())); return;
    case "probe": writeFrame({ id: msg.id, kind: "pong", ok: true }); return;
    case "reload": writeFrame({ v: "1", id: msg.id, kind: "ack" }); return;
    case "drain": writeFrame({ v: "1", id: msg.id, kind: "bye" }); return;
    case "call": handleCall(msg); return;
    case "port.result": {
      const pending = pendingPorts.get(msg.id);
      if (pending === undefined) return;
      pendingPorts.delete(msg.id);
      if (pending.callId === null) {
        writeFrame({ v: "1", id: "evt-" + msg.id, kind: "event", topic: "port.probe", payload: msg.value === undefined ? null : msg.value });
        return;
      }
      writeFrame({ v: "1", id: pending.callId, kind: "result", ok: true, value: { env: pending.env, forwarded: msg.value === undefined ? null : msg.value, argsEnv: pending.argsEnv } });
      return;
    }
    case "port.error": {
      const pending = pendingPorts.get(msg.id);
      if (pending === undefined) return;
      pendingPorts.delete(msg.id);
      if (pending.callId === null) {
        writeFrame({ v: "1", id: "evt-" + msg.id, kind: "event", topic: "port.probe", payload: { error: msg.error === undefined ? null : msg.error } });
        return;
      }
      writeFrame({ v: "1", id: pending.callId, kind: "result", ok: true, value: { env: pending.env, forwarded: { error: msg.error === undefined ? null : msg.error }, argsEnv: pending.argsEnv } });
      return;
    }
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
    try { handle(JSON.parse(body)); } catch (err) { process.stderr.write("[env-toy] bad frame: " + err.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
if (config.spontaneous) {
  setTimeout(() => {
    const id = "pc-sp-" + (++portSeq);
    pendingPorts.set(id, { callId: null, env: null, argsEnv: null });
    writeFrame({ v: "1", id: id, kind: "port.call", port: config.reversePort, method: config.reverseMethod || "echo", args: config.reverseArgs === undefined ? null : config.reverseArgs });
  }, 80);
}
`

const ECHO_TERM: Json = ['eff', 'toy.echo', 'echo', ['c', { n: 1 }]]

interface AuditEnvRecord {
  at: number
  run: Json
  env: Json
}

describe('H16 调用帧 env 注入', () => {
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

  function journalFile(): string {
    return join(root, 'state', 'world', 'journal.jsonl')
  }

  /** 从审计 def 里抽出服务回传的 `env`（`body.result.value.env`）。 */
  function auditEnvs(): AuditEnvRecord[] {
    const out: AuditEnvRecord[] = []
    for (const entry of readJournal(journalFile())) {
      const args = entry.args as { body?: Json } | null
      const body = args?.body
      if (typeof body !== 'object' || body === null || Array.isArray(body)) continue
      const record = body as { [k: string]: Json }
      if (record['kind'] !== 'effect_audit') continue
      const result = record['result']
      if (typeof result !== 'object' || result === null || Array.isArray(result)) continue
      const value = (result as { [k: string]: Json })['value']
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      out.push({ at: entry.at, run: record['run'], env: (value as { [k: string]: Json })['env'] })
    }
    return out
  }

  /** 一个把收到的 `env` 回传的 echo 服务 + 调用方（`toy-client.env` 命令）。 */
  function seedEcho(): void {
    const echo = writeTempPackage(root, {
      identity: 'toy-echo',
      implements: ['toy.echo'],
      methods: { 'toy.echo': ['echo'] },
      start: 'node execute/main.js',
      files: { 'execute/main.js': ENV_SERVICE_MAIN },
    })
    const client = writeTempPackage(root, {
      identity: 'toy-client',
      pins: { 'toy.echo': 'toy-echo' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'env.json': JSON.stringify(ECHO_TERM) },
      commands: [{ name: 'toy-client.env', entry: 'terms/env.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'toy-echo', path: echo },
        { name: 'toy-client', path: client },
      ]).ok,
    ).toBe(true)
  }

  async function entryOf(
    client: { commands: () => Promise<{ name: string; entry: string }[]> },
    name: string,
  ): Promise<string> {
    const commands = await client.commands()
    const found = commands.find((command) => command.name === name)
    expect(found).toBeDefined()
    return (found as { entry: string }).entry
  }

  it('正向 call：帧含 env，run/thread/now 正确（now = 该轮审计时间戳）', async () => {
    seedEcho()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const entry = await entryOf(client, 'toy-client.env')
      const result = await client.submit(
        [{ kind: 'eval', entry, args: { n: 1 } } as unknown as Directive],
        {
          thread: 'thr-a',
        },
      )
      expect(result.status).toBe('done')
      const value = (result.observations[0] as { value: Json }).value as {
        env: { run: string; thread: string; now: number }
      }
      expect(value.env.run).toBe(result.run)
      expect(value.env.thread).toBe('thr-a')
      const audit = auditEnvs().find((record) => record.run === result.run)
      expect(audit).toBeDefined()
      expect(value.env.now).toBe(audit?.at)
    } finally {
      client.close()
    }
  })

  it('detached run：调用帧 env.thread 恒 null，env.run = detached run id', async () => {
    seedEcho()
    const host = writeTempPackage(root, {
      identity: 'toy-host',
      pins: { host: 'host', 'toy.echo': 'toy-echo' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'resume.json': JSON.stringify(['eff', 'host', 'thread.resume', ['v', 0]]) },
      commands: [{ name: 'toy-host.resume', entry: 'terms/resume.json' }],
    })
    expect(runSeed(root, [{ name: 'toy-host', path: host }]).ok).toBe(true)
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const entry = await entryOf(client, 'toy-client.env')
      const resumed = await client.command('toy-host.resume', { entry, thread: 'thr-d' })
      const value = (resumed.observations[0] as { value: Json }).value as { run: string }
      await waitFor(
        () => auditEnvs().some((record) => record.run === value.run),
        'detached run audit',
      )
      const env = auditEnvs().find((record) => record.run === value.run)?.env as {
        run: string
        thread: string | null
      }
      expect(env.run).toBe(value.run)
      expect(env.thread).toBeNull()
    } finally {
      client.close()
    }
  })

  it('周期 run：调用帧 env.thread 恒 null', async () => {
    const echo = writeTempPackage(root, {
      identity: 'toy-echo',
      implements: ['toy.echo'],
      methods: { 'toy.echo': ['echo'] },
      start: 'node execute/main.js',
      files: { 'execute/main.js': ENV_SERVICE_MAIN },
    })
    const periodic = writeTempPackage(root, {
      identity: 'toy-periodic',
      pins: { 'toy.echo': 'toy-echo' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'env.json': JSON.stringify(ECHO_TERM) },
      commands: [{ name: 'toy-periodic.env', entry: 'terms/env.json' }],
      schema: { type: 'object', periodic: [{ command: 'toy-periodic.env', every_ms: 60 }] },
    })
    expect(
      runSeed(root, [
        { name: 'toy-echo', path: echo },
        { name: 'toy-periodic', path: periodic },
      ]).ok,
    ).toBe(true)
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.impl === 'host' &&
              event.topic === 'run.finished' &&
              (event.payload as { status?: string }).status === 'done' &&
              (event.payload as { thread?: string | null }).thread === null,
          ),
        'periodic run.finished(done)',
      )
      const finished = events.find(
        (event) => event.impl === 'host' && event.topic === 'run.finished',
      )
      const run = (finished?.payload as { run?: string }).run as string
      await waitFor(() => auditEnvs().some((record) => record.run === run), 'periodic audit')
      const env = auditEnvs().find((record) => record.run === run)?.env as {
        run: string
        thread: string | null
      }
      expect(env.run).toBe(run)
      expect(env.thread).toBeNull()
    } finally {
      client.close()
    }
  })

  it('反向 port.call：目标帧填 env（与发起服务同 run/thread），args 顶层 env 原样透传', async () => {
    const target = writeTempPackage(root, {
      identity: 'toy-target',
      implements: ['toy.target'],
      methods: { 'toy.target': ['echo'] },
      start: 'node execute/main.js',
      files: { 'execute/main.js': ENV_SERVICE_MAIN },
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
        reverseArgs: { env: { secret: 's3cr3t' }, n: 7 },
      },
      files: { 'execute/main.js': ENV_SERVICE_MAIN },
    })
    const client = writeTempPackage(root, {
      identity: 'toy-client',
      pins: { 'toy.origin': 'toy-origin' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'env.json': JSON.stringify(['eff', 'toy.origin', 'echo', ['c', { n: 1 }]]) },
      commands: [{ name: 'toy-client.env', entry: 'terms/env.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'toy-target', path: target },
        { name: 'toy-origin', path: origin },
        { name: 'toy-client', path: client },
      ]).ok,
    ).toBe(true)
    const handle = await startHost({ root })
    handles.push(handle)
    const conn = await connect({ root, timeoutMs: 3000 })
    try {
      const entry = await entryOf(conn, 'toy-client.env')
      const result = await conn.submit(
        [{ kind: 'eval', entry, args: { n: 1 } } as unknown as Directive],
        { thread: 'thr-r' },
      )
      expect(result.status).toBe('done')
      const value = (result.observations[0] as { value: Json }).value as {
        env: { run: string; thread: string; now: number }
        forwarded: { env: { run: string; thread: string; now: number }; args: Json }
        argsEnv: Json
      }
      // 发起服务与目标服务拿到同一 run / thread / now
      expect(value.forwarded.env.run).toBe(value.env.run)
      expect(value.forwarded.env.thread).toBe('thr-r')
      expect(value.forwarded.env.now).toBe(value.env.now)
      expect(value.env.run).toBe(result.run)
      // args 顶层 env 字段原样透传给目标（宿主端口审计的值脱敏尚未实现，不做值替换）
      expect(value.forwarded.args).toEqual({ env: { secret: 's3cr3t' }, n: 7 })
      // 发起服务自身入站 args 无 env：证明目标收到的是反向调用 args，而非发起调用 args
      expect(value.argsEnv).toBeNull()
    } finally {
      conn.close()
    }
  })

  /** seed 一个 origin（带反向配置）+ target（可 errorCode）+ client，返回 client 命令入口。 */
  function seedReverse(
    reverseConfig: Record<string, unknown>,
    targetConfig?: Record<string, unknown>,
  ): { target: string; origin: string } {
    const target = writeTempPackage(root, {
      identity: 'toy-target',
      implements: ['toy.target'],
      methods: { 'toy.target': ['echo'] },
      start: 'node execute/main.js',
      ...(targetConfig === undefined ? {} : { serviceConfig: targetConfig }),
      files: { 'execute/main.js': ENV_SERVICE_MAIN },
    })
    const origin = writeTempPackage(root, {
      identity: 'toy-origin',
      implements: ['toy.origin'],
      methods: { 'toy.origin': ['echo'] },
      pins: { 'toy.target': 'toy-target' },
      start: 'node execute/main.js',
      serviceConfig: reverseConfig,
      files: { 'execute/main.js': ENV_SERVICE_MAIN },
    })
    const client = writeTempPackage(root, {
      identity: 'toy-client',
      pins: { 'toy.origin': 'toy-origin' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'env.json': JSON.stringify(['eff', 'toy.origin', 'echo', ['c', { n: 1 }]]) },
      commands: [{ name: 'toy-client.env', entry: 'terms/env.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'toy-target', path: target },
        { name: 'toy-origin', path: origin },
        { name: 'toy-client', path: client },
      ]).ok,
    ).toBe(true)
    return { target, origin }
  }

  it('反向 port.call 未知 port → port.error unresolved_cap（作数据回灌，不断通道）', async () => {
    seedReverse({ reversePort: 'nope', reverseMethod: 'echo' })
    const handle = await startHost({ root })
    handles.push(handle)
    const conn = await connect({ root, timeoutMs: 3000 })
    try {
      const entry = await entryOf(conn, 'toy-client.env')
      const result = await conn.submit(
        [{ kind: 'eval', entry, args: { n: 1 } } as unknown as Directive],
        { thread: 'thr-x' },
      )
      expect(result.status).toBe('done')
      const value = (result.observations[0] as { value: Json }).value as { forwarded: Json }
      expect(value.forwarded).toEqual({ error: 'unresolved_cap' })
    } finally {
      conn.close()
    }
  })

  it('反向 port.call 未知 method → port.error not_loaded', async () => {
    seedReverse({ reversePort: 'toy.target', reverseMethod: 'missing' })
    const handle = await startHost({ root })
    handles.push(handle)
    const conn = await connect({ root, timeoutMs: 3000 })
    try {
      const entry = await entryOf(conn, 'toy-client.env')
      const result = await conn.submit(
        [{ kind: 'eval', entry, args: { n: 1 } } as unknown as Directive],
        { thread: 'thr-x' },
      )
      const value = (result.observations[0] as { value: Json }).value as { forwarded: Json }
      expect(value.forwarded).toEqual({ error: 'not_loaded' })
    } finally {
      conn.close()
    }
  })

  it('反向 port.call 目标回 error → port.error 透传目标错误码', async () => {
    seedReverse(
      { reversePort: 'toy.target', reverseMethod: 'echo' },
      { errorCode: 'boom' },
    )
    const handle = await startHost({ root })
    handles.push(handle)
    const conn = await connect({ root, timeoutMs: 3000 })
    try {
      const entry = await entryOf(conn, 'toy-client.env')
      const result = await conn.submit(
        [{ kind: 'eval', entry, args: { n: 1 } } as unknown as Directive],
        { thread: 'thr-x' },
      )
      const value = (result.observations[0] as { value: Json }).value as { forwarded: Json }
      expect(value.forwarded).toEqual({ error: 'boom' })
    } finally {
      conn.close()
    }
  })

  it('反向 port.call 无在途调用 → 目标 env 兜底 {run:null, thread:null, now>0}', async () => {
    seedReverse({
      spontaneous: true,
      reversePort: 'toy.target',
      reverseMethod: 'echo',
      reverseArgs: { n: 1 },
    })
    const handle = await startHost({ root })
    handles.push(handle)
    const conn = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    conn.onEvent((event) => events.push(event))
    try {
      await waitFor(
        () => events.some((event) => event.impl === 'toy-origin' && event.topic === 'port.probe'),
        'spontaneous port.probe',
      )
      const probe = events.find(
        (event) => event.impl === 'toy-origin' && event.topic === 'port.probe',
      )
      const payload = probe?.payload as { env: { run: Json; thread: Json; now: number } }
      expect(payload.env.run).toBeNull()
      expect(payload.env.thread).toBeNull()
      expect(payload.env.now).toBeGreaterThan(0)
    } finally {
      conn.close()
    }
  })
})
