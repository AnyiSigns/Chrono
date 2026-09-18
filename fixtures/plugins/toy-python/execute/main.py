#!/usr/bin/env python3
"""toy stdio 服务（docs/protocol.md §二）：宿主 spawn 后接管 stdin/stdout。

- stdin 读帧、stdout 写帧：4 字节大端长度 + UTF-8 JSON；stdout 只许协议帧，日志一律走 stderr。
- 实现最小面：hello→manifest、call→result/error、probe→pong、drain→bye、reload→ack。
- stdin EOF / 管道断开即自退出（§2.6）；单帧长度超上限按协议拒绝。
- 行为可用包根目录的 service-config.json 覆写（测试用；交付的 fixture 不含该文件）。
- manifest 默认从同目录 plugin.json 派生：服务自述与声明一致，任何包同形即得正确 manifest。
"""

import json
import os
import struct
import sys

PROTOCOL_VERSION = "1"
MAX_FRAME_BYTES = 16 * 1024 * 1024
CONFIG_FILE = os.path.join(os.getcwd(), "service-config.json")
KNOWN_KEYS = {
    "callMode",
    "callErrorCode",
    "callErrorMessage",
    "callValue",
    "helloMode",
    "probeMode",
    "manifest",
    "verbose",
}
HELLO_MODES = {"silent", "exit"}
CALL_MODES = {"silent", "exit", "error"}
PROBE_MODES = {"silent", "fail"}


def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as err:
        log(f"bad service-config.json: {err}")
        return {}
    if not isinstance(config, dict):
        return {}
    # 与其 JS 孪生（toy-alpha/toy-beta main.js）断链的档位一律 fail-fast：
    # 未支持的键 / 取值必须显式失败，不得静默 no-op（防两份实现静默漂移）。
    unknown = sorted(set(config) - KNOWN_KEYS)
    if unknown:
        log(f"unsupported service-config keys: {', '.join(unknown)}")
        raise SystemExit(2)
    for key, allowed in (
        ("helloMode", HELLO_MODES),
        ("callMode", CALL_MODES),
        ("probeMode", PROBE_MODES),
    ):
        value = config.get(key)
        if value is not None and value not in allowed:
            log(f"unsupported service-config {key}: {value!r}")
            raise SystemExit(2)
    return config


def log(message):
    sys.stderr.write("[toy-python] " + message + "\n")
    sys.stderr.flush()


config = load_config()


def read_plugin():
    path = os.path.join(os.getcwd(), "plugin.json")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def manifest():
    plugin = read_plugin()
    base = {
        "v": PROTOCOL_VERSION,
        "identity": plugin["identity"],
        "implements": plugin["implements"],
        "methods": plugin["methods"],
        "protocol": plugin["protocol"],
        "state": plugin["state"],
    }
    overrides = config.get("manifest")
    if isinstance(overrides, dict):
        base.update(overrides)
    return base


def write_frame(message):
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    stream = sys.stdout.buffer
    stream.write(struct.pack(">I", len(body)))
    stream.write(body)
    stream.flush()


def emit(request_id, kind, **fields):
    write_frame(dict({"v": PROTOCOL_VERSION, "id": request_id, "kind": kind}, **fields))


def handle_hello(message):
    mode = config.get("helloMode")
    if mode == "silent":
        return
    if mode == "exit":
        sys.exit(0)
    write_frame(dict(manifest(), id=message.get("id"), kind="manifest"))


def handle_call(message):
    # 行为可用 service-config.json 覆写（测试用）：silent=不答（超时）/ exit=进程退出 /
    # error=有响应错误 / callValue=固定回值；缺省回显 {impl, port, method, args}。
    mode = config.get("callMode")
    if mode == "silent":
        return
    if mode == "exit":
        sys.exit(1)
    if mode == "error":
        emit(
            message.get("id"),
            "error",
            ok=False,
            code=config.get("callErrorCode", "toy.python.failed"),
            message=config.get("callErrorMessage", "toy-python error"),
        )
        return
    if "callValue" in config:
        value = config["callValue"]
    else:
        value = {
            "impl": read_plugin()["identity"],
            "port": message.get("port"),
            "method": message.get("method"),
            "args": message.get("args"),
        }
    emit(message.get("id"), "result", ok=True, value=value)


def handle_probe(message):
    if config.get("probeMode") == "silent":
        return
    emit(message.get("id"), "pong", ok=config.get("probeMode") != "fail")


def handle(message):
    if not isinstance(message, dict):
        return
    kind = message.get("kind")
    if kind == "hello":
        handle_hello(message)
    elif kind == "call":
        handle_call(message)
    elif kind == "probe":
        handle_probe(message)
    elif kind == "drain":
        emit(message.get("id"), "bye")
    elif kind == "reload":
        emit(message.get("id"), "ack")


def read_exact(stream, count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def main():
    stdin = sys.stdin.buffer
    while True:
        header = read_exact(stdin, 4)
        if header is None:
            return 0
        (length,) = struct.unpack(">I", header)
        if length > MAX_FRAME_BYTES:
            log(f"frame_too_large: {length}")
            return 1
        body = read_exact(stdin, length) if length > 0 else b""
        if body is None:
            return 0
        try:
            message = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as err:
            log(f"bad frame: {err}")
            continue
        handle(message)


if __name__ == "__main__":
    if config.get("verbose"):
        log(f"service started (pid {os.getpid()})")
    code = 0
    try:
        code = main()
    except OSError:
        # 管道硬断（非 EOF）同样按断连自退出处理（§2.6）
        code = 0
    sys.exit(code)
