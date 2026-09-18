"use strict";
// toy stdio 服务（docs/protocol.md §二）：宿主 spawn 后接管 stdin/stdout。
// stdout 只发协议帧（4 字节大端长度 + JSON）；日志一律走 stderr；stdin EOF / 管道断开即自退出（§2.6）。
// 行为可用包根目录的 service-config.json 覆写（测试用；交付的 fixture 不含该文件）。
// manifest 默认从同目录 plugin.json 派生：服务自述与声明一致，任何包同形即得正确 manifest。

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_FILE = path.join(process.cwd(), "service-config.json");

let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") {
    process.stderr.write(
      "[toy] bad service-config.json: " + err.message + "\n",
    );
  }
}

function readPlugin() {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "plugin.json"), "utf8"),
  );
}

function manifest() {
  const plugin = readPlugin();
  const base = {
    v: "1",
    identity: plugin.identity,
    implements: plugin.implements,
    methods: plugin.methods,
    protocol: plugin.protocol,
    state: plugin.state,
  };
  const overrides = config.manifest || {};
  for (const key of Object.keys(overrides)) base[key] = overrides[key];
  return base;
}

function writeFrame(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  process.stdout.write(frame);
}

function log(line) {
  if (config.verbose) process.stderr.write("[toy] " + line + "\n");
}

// 跨重启持久计数器（写入物化目录）：crashLimit / probeFailTotal 用同一文件，
// 让「崩溃 N 次后恢复健康」的测试行为自终止，避免重启环在停机/清理后仍空转。
const COUNTER_FILE = path.join(process.cwd(), "toy-restart-counter.txt");

function counterValue() {
  try {
    const n = parseInt(fs.readFileSync(COUNTER_FILE, "utf8"), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function bumpCounter() {
  try {
    fs.writeFileSync(COUNTER_FILE, String(counterValue() + 1));
  } catch (err) {
    process.stderr.write("[toy] counter write failed: " + err.message + "\n");
  }
}

function emitEvent() {
  if (config.eventTopic === undefined || config.eventTopic === null) return;
  writeFrame({
    v: "1",
    id: "evt-" + Date.now(),
    kind: "event",
    topic: config.eventTopic,
    payload: config.eventPayload !== undefined ? config.eventPayload : null,
  });
}

function handleCall(msg) {
  // 行为可用 service-config.json 覆写（测试用）：silent=不答（超时）/ exit=进程退出 /
  // error=有响应错误 / callValue=固定回值；缺省回显 {impl, port, method, args}。
  if (config.callMode === "silent") return;
  if (config.callMode === "exit") return process.exit(1);
  if (config.callMode === "error") {
    writeFrame({
      v: "1",
      id: msg.id,
      kind: "error",
      ok: false,
      code: config.callErrorCode !== undefined ? config.callErrorCode : "toy.failed",
      message: config.callErrorMessage !== undefined ? config.callErrorMessage : "toy error",
    });
    return;
  }
  const value =
    config.callValue !== undefined
      ? config.callValue
      : {
          impl: readPlugin().identity,
          port: msg.port,
          method: msg.method,
          args: msg.args === undefined ? null : msg.args,
          // pid：换代测试断言「数据 reload 进程不动 / 代码 swap 进程更换」
          pid: process.pid,
        };
  writeFrame({ v: "1", id: msg.id, kind: "result", ok: true, value });
}

function handle(msg) {
  if (msg && typeof msg === "object") {
    switch (msg.kind) {
      case "hello": {
        if (config.helloMode === "silent") return;
        if (config.helloMode === "garbage") {
          // 首 4 字节即 ≈1.85GB > 单帧上限：协议损坏（frame_too_large）
          process.stdout.write("not-a-json-frame");
          return;
        }
        if (config.helloMode === "stall") {
          // 只写 4 字节小长度前缀、不发体：凑不满且未超上限 → 传输层失败 timeout
          const prefix = Buffer.allocUnsafe(4);
          prefix.writeUInt32BE(4096, 0);
          process.stdout.write(prefix);
          return;
        }
        if (config.helloMode === "bad-json") {
          // 合法长度前缀 + 非法 JSON 体：解码器抛错（传输层损坏）
          const body = Buffer.from("{", "utf8");
          const frame = Buffer.allocUnsafe(4 + body.length);
          frame.writeUInt32BE(body.length, 0);
          body.copy(frame, 4);
          process.stdout.write(frame);
          return;
        }
        if (config.helloMode === "wrong-kind") {
          // 帧合法但 kind ≠ 期望（协议形态错误；配对 id 仍正确）
          writeFrame({ v: "1", id: msg.id, kind: "pong", ok: true });
          return;
        }
        if (config.helloMode === "exit") return process.exit(0);
        emitEvent();
        const m = manifest();
        writeFrame(Object.assign({ id: msg.id, kind: "manifest" }, m));
        return;
      }
      case "probe": {
        if (config.probeMode === "silent") return;
        if (config.probeMode === "exit") return process.exit(0);
        if (typeof config.probeFailTotal === "number") {
          if (counterValue() < config.probeFailTotal) {
            bumpCounter();
            writeFrame({ id: msg.id, kind: "pong", ok: false });
            return;
          }
        }
        if (config.eventOnProbe) emitEvent();
        writeFrame({
          id: msg.id,
          kind: "pong",
          ok: config.probeMode !== "fail",
        });
        return;
      }
      case "reload": {
        // 数据换代热生效（docs/protocol.md §2.3）：服务回 ack，进程不动。
        if (config.reloadMode === "silent") return;
        if (config.reloadMode === "exit") return process.exit(1);
        log("reload gen=" + (msg.gen === undefined ? "?" : msg.gen));
        writeFrame({ v: "1", id: msg.id, kind: "ack" });
        return;
      }
      case "drain": {
        if (config.drainMode === "silent") return;
        writeFrame({ v: "1", id: msg.id, kind: "bye" });
        return;
      }
      case "call": {
        if (typeof config.callDelayMs === "number" && config.callDelayMs > 0) {
          setTimeout(() => handleCall(msg), config.callDelayMs);
          return;
        }
        handleCall(msg);
        return;
      }
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
    try {
      handle(JSON.parse(body));
    } catch (err) {
      log("bad frame: " + err.message);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));

if (typeof config.exitAfterMs === "number") {
  if (typeof config.crashLimit === "number") {
    if (counterValue() < config.crashLimit) {
      bumpCounter();
      setTimeout(() => process.exit(1), config.exitAfterMs);
    }
  } else {
    setTimeout(() => process.exit(1), config.exitAfterMs);
  }
}

log("service started (pid " + process.pid + ")");
