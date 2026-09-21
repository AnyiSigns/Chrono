// `tool-fs` 服务进程协议面（docs/protocol.md §二）：握手 / manifest / call / 控制 / 反向调用应答 / EOF 自退出。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。
// `call` 在独立线程执行（可能等待反向调用），控制帧（probe / reload / drain）不被阻塞。

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::describe;
use crate::frames;
use crate::invoke;
use crate::port::{FsopBackend, PortLink, RemoteFsop, SharedWriter};

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "tool-fs";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：v1 只允许可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["describe", "invoke"];

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    json!({
        "v": PROTOCOL,
        "identity": IDENTITY,
        "implements": [IDENTITY],
        "methods": { IDENTITY: METHODS },
        "protocol": PROTOCOL,
        "state": STATE,
    })
}

fn error_frame(id: &Value, code: &str, message: &str) -> Value {
    json!({ "v": PROTOCOL, "id": id, "kind": "error", "ok": false, "code": code, "message": message })
}

/// 处理控制帧；`call` / `drain` / 未知种类由调用方处理。
pub fn handle_control(message: &Value) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    match message.get("kind").and_then(Value::as_str) {
        Some("hello") => {
            let mut response = manifest();
            response["id"] = id;
            response["kind"] = json!("manifest");
            Some(response)
        }
        Some("probe") => Some(json!({ "v": PROTOCOL, "id": id, "kind": "pong", "ok": true })),
        Some("reload") => {
            frames::log("reload");
            Some(json!({ "v": PROTOCOL, "id": id, "kind": "ack" }))
        }
        _ => None,
    }
}

/// 处理 `call`：能力类门禁 + 方法分派（describe / invoke）。
pub fn handle_call(
    method: &str,
    args: &Value,
    backend: &dyn FsopBackend,
) -> Result<Value, (String, String)> {
    match method {
        "describe" => Ok(describe::describe()),
        "invoke" => Ok(invoke::invoke(args, backend)),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

fn call_response(message: &Value, backend: &dyn FsopBackend) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let port = message.get("port").and_then(Value::as_str).unwrap_or("");
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let args = message.get("args").cloned().unwrap_or(Value::Null);
    if port != IDENTITY {
        return error_frame(&id, "unresolved_cap", &format!("unknown capability {port}"));
    }
    match handle_call(method, &args, backend) {
        Ok(value) => {
            json!({ "v": PROTOCOL, "id": id, "kind": "result", "ok": true, "value": value })
        }
        Err((code, message)) => error_frame(&id, &code, &message),
    }
}

fn write_shared(writer: &SharedWriter, message: &Value) {
    if let Ok(mut guard) = writer.lock() {
        let _ = frames::write_frame(&mut *guard, message);
    }
}

fn wait_for_inflight(inflight: &Arc<(Mutex<usize>, Condvar)>, deadline_ms: u64) {
    let (lock, cvar) = &**inflight;
    let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    while *count > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next, timeout) = match cvar.wait_timeout(count, remaining) {
            Ok(pair) => pair,
            Err(poisoned) => poisoned.into_inner(),
        };
        count = next;
        if timeout.timed_out() {
            break;
        }
    }
}

/// `call` 独立线程执行（可能等待反向调用），控制帧不被阻塞；在途计数用于 `drain`。
fn spawn_call(
    message: Value,
    shared: SharedWriter,
    inflight: Arc<(Mutex<usize>, Condvar)>,
    backend: Arc<dyn FsopBackend>,
) {
    {
        let (lock, _) = &*inflight;
        *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
    }
    thread::spawn(move || {
        let response = call_response(&message, &*backend);
        write_shared(&shared, &response);
        let (lock, cvar) = &*inflight;
        let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *count = count.saturating_sub(1);
        cvar.notify_all();
    });
}

/// `drain`：等在途结束（或到期限）再回 `bye`。
fn finish_drain(message: &Value, shared: &SharedWriter, inflight: &Arc<(Mutex<usize>, Condvar)>) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let deadline = message
        .get("deadline_ms")
        .and_then(Value::as_u64)
        .unwrap_or(5000);
    wait_for_inflight(inflight, deadline);
    write_shared(shared, &json!({ "v": PROTOCOL, "id": id, "kind": "bye" }));
}

/// 帧循环：反向调用应答先结算；`call` 独立线程执行；`drain` 等在途结束再 `bye`；EOF 即自退出。
pub fn run_loop<R: Read, W: Write + Send + 'static>(reader: R, writer: W) {
    let shared: SharedWriter = Arc::new(Mutex::new(Box::new(writer)));
    let link = Arc::new(PortLink::new(Arc::clone(&shared)));
    let backend: Arc<dyn FsopBackend> = Arc::new(RemoteFsop::new(Arc::clone(&link)));
    run_loop_with(reader, shared, link, backend);
}

/// 帧循环主体；后端可注入（生产为 `RemoteFsop`，测试注入阻塞后端验证 `drain` 等待在途）。
fn run_loop_with<R: Read>(
    mut reader: R,
    shared: SharedWriter,
    link: Arc<PortLink>,
    backend: Arc<dyn FsopBackend>,
) {
    let inflight: Arc<(Mutex<usize>, Condvar)> = Arc::new((Mutex::new(0), Condvar::new()));
    loop {
        let message = match frames::read_frame(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(err) => {
                frames::log(&format!("bad frame: {err}"));
                break;
            }
        };
        if link.settle(&message) {
            continue;
        }
        match message.get("kind").and_then(Value::as_str).unwrap_or("") {
            "call" => spawn_call(
                message,
                Arc::clone(&shared),
                Arc::clone(&inflight),
                Arc::clone(&backend),
            ),
            "drain" => {
                finish_drain(&message, &shared, &inflight);
                return;
            }
            _ => {
                if let Some(response) = handle_control(&message) {
                    write_shared(&shared, &response);
                }
            }
        }
    }
    link.fail_all("transport_failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ToolError;
    use crate::frames::encode_frame;

    struct FakeBackend;

    impl FsopBackend for FakeBackend {
        fn fsop(&self, _bag: &Value) -> Result<Value, ToolError> {
            Ok(json!({"text": "hello", "total_lines": 1, "truncated": false}))
        }
    }

    /// 测试用捕获写端：把 run_loop 的输出收进内存。
    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn capture() -> (Capture, Arc<Mutex<Vec<u8>>>) {
        let sink = Arc::new(Mutex::new(Vec::new()));
        (Capture(Arc::clone(&sink)), sink)
    }

    fn drain_frames(sink: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let bytes = sink.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(bytes);
        let mut frames = Vec::new();
        while let Some(message) = crate::frames::read_frame(&mut cursor).unwrap() {
            frames.push(message);
        }
        frames
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "tool-fs");
        assert_eq!(value["implements"], json!(["tool-fs"]));
        assert_eq!(value["methods"]["tool-fs"], json!(["describe", "invoke"]));
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn hello_returns_manifest() {
        let response = handle_control(&json!({"kind":"hello","id":"h1","impl":"tool-fs"})).unwrap();
        assert_eq!(response["kind"], "manifest");
        assert_eq!(response["id"], "h1");
        assert_eq!(response["identity"], "tool-fs");
    }

    #[test]
    fn probe_returns_pong_and_reload_acks() {
        let pong = handle_control(&json!({"kind":"probe","id":"p1"})).unwrap();
        assert_eq!(pong["kind"], "pong");
        assert_eq!(pong["ok"], true);
        let ack = handle_control(&json!({"kind":"reload","id":"r1","gen":"g"})).unwrap();
        assert_eq!(ack["kind"], "ack");
    }

    #[test]
    fn unknown_capability_is_unresolved() {
        let response = call_response(
            &json!({"kind":"call","id":"c1","port":"other","method":"describe","args":{}}),
            &FakeBackend,
        );
        assert_eq!(response["kind"], "error");
        assert_eq!(response["code"], "unresolved_cap");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &FakeBackend).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn describe_call_returns_four_tools() {
        let value = handle_call("describe", &json!({}), &FakeBackend).unwrap();
        assert_eq!(value["tools"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn invoke_call_returns_ok_result() {
        let bag = json!({
            "tool": "read", "args": {"path": "a.txt"}, "workspace_root": "C:\\ws",
        });
        let value = handle_call("invoke", &bag, &FakeBackend).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["text"], "hello");
    }

    #[test]
    fn loop_handshake_probe_then_eof_exits() {
        let mut bytes =
            encode_frame(&json!({"v":"1","id":"h","kind":"hello","impl":"tool-fs"})).unwrap();
        bytes.extend_from_slice(&encode_frame(&json!({"v":"1","id":"p","kind":"probe"})).unwrap());
        let (writer, sink) = capture();
        run_loop(std::io::Cursor::new(bytes), writer);
        let frames = drain_frames(&sink);
        assert_eq!(frames[0]["kind"], "manifest");
        assert_eq!(frames[1]["kind"], "pong");
        assert_eq!(frames.len(), 2);
    }

    #[test]
    fn loop_drain_returns_bye() {
        let bytes =
            encode_frame(&json!({"v":"1","id":"d","kind":"drain","deadline_ms":50})).unwrap();
        let (writer, sink) = capture();
        run_loop(std::io::Cursor::new(bytes), writer);
        let frames = drain_frames(&sink);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["kind"], "bye");
        assert_eq!(frames[0]["id"], "d");
    }

    /// 阻塞后端：进入后发信号，等测试释放才回结果。
    struct BlockingBackend {
        started: std::sync::mpsc::Sender<()>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl FsopBackend for BlockingBackend {
        fn fsop(&self, _bag: &Value) -> Result<Value, ToolError> {
            let _ = self.started.send(());
            let (lock, cvar) = &*self.release;
            let mut released = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            while !*released {
                released = match cvar.wait(released) {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
            }
            Ok(json!({"text": "done", "total_lines": 1, "truncated": false}))
        }
    }

    #[test]
    fn drain_waits_for_inflight_call_before_bye() {
        let mut input = encode_frame(&json!({
            "v":"1","id":"c1","kind":"call","port":"tool-fs","method":"invoke",
            "args":{"tool":"read","args":{"path":"a.txt"},"workspace_root":"C:\\ws"},
        }))
        .unwrap();
        input.extend_from_slice(
            &encode_frame(&json!({"v":"1","id":"d1","kind":"drain","deadline_ms":5000})).unwrap(),
        );

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let backend: Arc<dyn FsopBackend> = Arc::new(BlockingBackend {
            started: started_tx,
            release: Arc::clone(&release),
        });
        let (writer, sink) = capture();
        let shared: SharedWriter = Arc::new(Mutex::new(Box::new(writer)));
        let link = Arc::new(PortLink::new(Arc::clone(&shared)));
        let handle = thread::spawn(move || {
            run_loop_with(std::io::Cursor::new(input), shared, link, backend);
        });

        // 在途 call 已进入后端：此刻 `drain` 必须等它结算，不得先回 `bye`。
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("blocking backend not entered");
        {
            let (lock, cvar) = &*release;
            *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
            cvar.notify_all();
        }
        handle.join().unwrap();

        let frames = drain_frames(&sink);
        let result_index = frames
            .iter()
            .position(|frame| frame["kind"] == "result")
            .expect("call result frame missing");
        let bye_index = frames
            .iter()
            .position(|frame| frame["kind"] == "bye")
            .expect("drain bye frame missing");
        assert!(
            result_index < bye_index,
            "bye 必须先等在途 call 结算：{frames:?}"
        );
    }
}
