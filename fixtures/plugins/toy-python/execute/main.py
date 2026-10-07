# toy-python 服务：stdio 帧协议（4 字节大端长度 + UTF-8 JSON），进程内不依赖三方库。
# 与 JS 夹具同协议；宿主不解释语言，只按 plugin.json.build / start 起进程。
import json
import os
import struct
import sys

MAX_FRAME_BYTES = 16 * 1024 * 1024


def read_json(name, default):
    try:
        with open(os.path.join(os.getcwd(), name), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
    except (ValueError, OSError):
        return default


PLUGIN = read_json("plugin.json", {})
CONFIG = read_json("service-config.json", {})


def frame(message):
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack(">I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def manifest():
    result = {
        "v": "1",
        "identity": PLUGIN.get("identity"),
        "implements": PLUGIN.get("implements"),
        "methods": PLUGIN.get("methods"),
        "protocol": PLUGIN.get("protocol"),
        "state": PLUGIN.get("state"),
    }
    result.update(CONFIG.get("manifest") or {})
    return result


def on_call(message):
    if CONFIG.get("callMode") == "silent":
        return
    frame(
        {
            "v": "1",
            "id": message.get("id"),
            "kind": "result",
            "ok": True,
            "value": {
                "impl": PLUGIN.get("identity"),
                "port": message.get("port"),
                "method": message.get("method"),
                "args": message.get("args"),
            },
        }
    )


def handle(message):
    if not isinstance(message, dict):
        return
    kind = message.get("kind")
    if kind == "hello":
        frame(dict({"id": message.get("id"), "kind": "manifest"}, **manifest()))
    elif kind == "probe":
        frame({"id": message.get("id"), "kind": "pong", "ok": True})
    elif kind == "reload":
        frame({"v": "1", "id": message.get("id"), "kind": "ack"})
    elif kind == "drain":
        frame({"v": "1", "id": message.get("id"), "kind": "bye"})
    elif kind == "call":
        on_call(message)


def main():
    stream = sys.stdin.buffer
    while True:
        head = stream.read(4)
        if len(head) < 4:
            return
        length = struct.unpack(">I", head)[0]
        if length > MAX_FRAME_BYTES:
            return
        body = stream.read(length)
        if len(body) < length:
            return
        try:
            handle(json.loads(body.decode("utf-8")))
        except ValueError:
            sys.stderr.write("[toy-python] bad frame\n")


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.exit(0)
