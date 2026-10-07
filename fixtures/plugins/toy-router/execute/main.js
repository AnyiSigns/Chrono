"use strict";
const fs = require("node:fs");
const path = require("node:path");

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "service-config.json"), "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") process.stderr.write("[fixture] bad service-config.json\n");
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
function readCount(name) {
  try {
    return parseInt(fs.readFileSync(path.join(process.cwd(), name), "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}
function writeCount(name, n) {
  try {
    fs.writeFileSync(path.join(process.cwd(), name), String(n));
  } catch {}
}

if (typeof config.exitAfterMs === "number") {
  const n = readCount("crash-count.txt") + 1;
  writeCount("crash-count.txt", n);
  const limit = typeof config.crashLimit === "number" ? config.crashLimit : 1;
  if (n <= limit) setTimeout(() => process.exit(1), config.exitAfterMs);
}
function manifest() {
  const p = plugin();
  return Object.assign(
    {
      v: "1",
      identity: p.identity,
      implements: p.implements,
      methods: p.methods,
      protocol: p.protocol,
      state: p.state,
    },
    config.manifest || {},
  );
}
function onCall(msg) {
  if (config.callMode === "exit") {
    process.exit(1);
    return;
  }
  const reply = () => {
    if (config.callMode === "silent") return;
    if (config.callMode === "error") {
      frame({
        v: "1",
        id: msg.id,
        kind: "result",
        ok: true,
        value: { error: config.callErrorCode, message: config.callErrorMessage },
      });
      return;
    }
    if (config.callValue !== undefined) {
      frame({ v: "1", id: msg.id, kind: "result", ok: true, value: config.callValue });
      return;
    }
    const p = plugin();
    frame({
      v: "1",
      id: msg.id,
      kind: "result",
      ok: true,
      value: {
        impl: p.identity,
        port: msg.port,
        method: msg.method,
        args: msg.args === undefined ? null : msg.args,
        pid: process.pid,
      },
    });
  };
  if (typeof config.callDelayMs === "number" && config.callDelayMs > 0) setTimeout(reply, config.callDelayMs);
  else reply();
}
function onHello(msg) {
  if (config.helloFailTotal !== undefined) {
    const n = readCount("hello-count.txt") + 1;
    writeCount("hello-count.txt", n);
    if (n <= config.helloFailTotal) return;
  }
  switch (config.helloMode) {
    case "silent":
      return;
    case "garbage":
      process.stdout.write(Buffer.from("none", "utf8"));
      return;
    case "bad-json": {
      const b = Buffer.from("{", "utf8");
      const h = Buffer.allocUnsafe(4);
      h.writeUInt32BE(b.length, 0);
      process.stdout.write(Buffer.concat([h, b]));
      return;
    }
    case "stall": {
      const h = Buffer.allocUnsafe(4);
      h.writeUInt32BE(16, 0);
      process.stdout.write(Buffer.concat([h, Buffer.from([0])]));
      return;
    }
    case "wrong-kind":
      frame({ v: "1", id: msg.id, kind: "pong", ok: true });
      return;
  }
  frame(Object.assign({ id: msg.id, kind: "manifest" }, manifest()));
}
function onProbe(msg) {
  if (config.eventOnProbe) {
    frame({
      v: "1",
      id: "evt-" + msg.id,
      kind: "event",
      topic: config.eventTopic,
      payload: config.eventPayload === undefined ? null : config.eventPayload,
    });
  }
  if (config.probeMode === "silent") return;
  if (config.probeMode === "fail") {
    frame({ id: msg.id, kind: "pong", ok: false });
    return;
  }
  if (config.probeFailTotal !== undefined) {
    const n = readCount("probe-count.txt") + 1;
    writeCount("probe-count.txt", n);
    if (n <= config.probeFailTotal) return;
  }
  frame({ id: msg.id, kind: "pong", ok: true });
}
function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.kind) {
    case "hello":
      onHello(msg);
      return;
    case "probe":
      onProbe(msg);
      return;
    case "reload":
      if (config.reloadMode !== "silent") frame({ v: "1", id: msg.id, kind: "ack" });
      return;
    case "drain":
      if (config.drainMode !== "silent") frame({ v: "1", id: msg.id, kind: "bye" });
      return;
    case "call":
      onCall(msg);
      return;
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
      process.stderr.write("[fixture] bad frame: " + err.message + "\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
