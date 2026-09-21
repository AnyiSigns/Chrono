// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）与 fsop 后端抽象。
// 本插件所有触盘经 `port.call` 到 `sandbox.fsop`；宿主按发出者 `pins` 路由后回
// `port.result` / `port.error`（按 id 配对）。失败作数据（ToolError），不抛错、不断通道。
// 单测用可注入的假后端替换真实通道。

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::ToolError;
use crate::frames;

/// 协议出口：宿主 `call` 的应答与反向 `port.call` 共用同一写端。
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。
pub const DEFAULT_CALL_TIMEOUT_MS: u64 = 30_000;

enum Outcome {
    Value(Value),
    Error(ToolError),
}

type PendingMap = HashMap<String, mpsc::Sender<Outcome>>;

/// 一条服务连接上的反向调用登记表；帧循环收到 `port.result` / `port.error` 时调 `settle`。
pub struct PortLink {
    writer: SharedWriter,
    pending: Mutex<PendingMap>,
    seq: AtomicU64,
    timeout: Duration,
}

impl PortLink {
    pub fn new(writer: SharedWriter) -> Self {
        Self::with_timeout(writer, Duration::from_millis(DEFAULT_CALL_TIMEOUT_MS))
    }

    pub fn with_timeout(writer: SharedWriter, timeout: Duration) -> Self {
        Self {
            writer,
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            timeout,
        }
    }

    /// 取登记表：锁中毒（持锁线程曾 panic）时恢复内部数据，不以 panic 杀进程。
    fn pending(&self) -> MutexGuard<'_, PendingMap> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 发一条 `port.call` 并等待应答；超时 / 写失败作结构化错误。
    pub fn call(&self, port: &str, method: &str, args: Value) -> Result<Value, ToolError> {
        let id = format!("tool-fs-{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = mpsc::channel();
        self.pending().insert(id.clone(), sender);
        let frame = json!({
            "v": "1", "id": id, "kind": "port.call",
            "port": port, "method": method, "args": args,
        });
        if let Err(err) = self.write(&frame) {
            self.pending().remove(&id);
            return Err(ToolError::new("transport_failed", err.to_string()));
        }
        match receiver.recv_timeout(self.timeout) {
            Ok(Outcome::Value(value)) => Ok(value),
            Ok(Outcome::Error(error)) => Err(error),
            Err(_) => {
                self.pending().remove(&id);
                Err(ToolError::new(
                    "tool_timeout",
                    format!("{port}.{method} did not answer in time"),
                ))
            }
        }
    }

    fn write(&self, message: &Value) -> std::io::Result<()> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| std::io::Error::other("writer poisoned"))?;
        frames::write_frame(&mut *guard, message)
    }

    /// 宿主侧应答入口：`port.result` / `port.error` 按 id 结算；返回是否已消费该帧。
    pub fn settle(&self, message: &Value) -> bool {
        let kind = message.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind != "port.result" && kind != "port.error" {
            return false;
        }
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return true;
        };
        let sender = self.pending().remove(id);
        let Some(sender) = sender else {
            return true;
        };
        let outcome = if kind == "port.result" {
            Outcome::Value(message.get("value").cloned().unwrap_or(Value::Null))
        } else {
            Outcome::Error(ToolError::new(
                message
                    .get("error")
                    .and_then(Value::as_str)
                    .or_else(|| message.get("code").and_then(Value::as_str))
                    .unwrap_or("tool_failed"),
                message.get("message").and_then(Value::as_str).unwrap_or(""),
            ))
        };
        let _ = sender.send(outcome);
        true
    }

    /// 断连 / 退出：未结算的调用全部作数据失败。
    pub fn fail_all(&self, code: &str) {
        let mut pending = self.pending();
        for sender in pending.values() {
            let _ = sender.send(Outcome::Error(ToolError::new(code, "link closed")));
        }
        pending.clear();
    }
}

/// 触盘后端抽象：生产环境是反向调用 `sandbox.fsop`，单测注入假后端。
pub trait FsopBackend: Send + Sync {
    fn fsop(&self, bag: &Value) -> Result<Value, ToolError>;
}

/// `sandbox.fsop` 的反向调用后端。
pub struct RemoteFsop {
    link: Arc<PortLink>,
}

impl RemoteFsop {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl FsopBackend for RemoteFsop {
    fn fsop(&self, bag: &Value) -> Result<Value, ToolError> {
        let value = self.link.call("sandbox", "fsop", bag.clone())?;
        parse_fsop_response(&value)
    }
}

/// fsop 方法值 `{ok:true, op, result}` / `{ok:false, code, message}` → 结果或结构化错误。
pub fn parse_fsop_response(value: &Value) -> Result<Value, ToolError> {
    if value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
    Err(ToolError::new(
        value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("tool_failed"),
        value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("fsop failed"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Instant;

    /// 测试用捕获写端：把协议出口收进内存供断言。
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

    fn capture() -> (Capture, SharedWriter) {
        let sink = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(Capture(Arc::clone(&sink)))));
        (Capture(sink), writer)
    }

    fn read_written(sink: &Arc<Mutex<Vec<u8>>>) -> Value {
        let bytes = sink.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(bytes);
        frames::read_frame(&mut cursor).unwrap().unwrap()
    }

    #[test]
    fn port_call_round_trip() {
        let (capture, writer) = capture();
        let link = Arc::new(PortLink::new(writer));
        let caller = Arc::clone(&link);
        let handle = thread::spawn(move || caller.call("sandbox", "fsop", json!({"op": "read"})));
        let deadline = Instant::now() + Duration::from_secs(5);
        let frame = loop {
            if !capture.0.lock().unwrap().is_empty() {
                break read_written(&capture.0);
            }
            assert!(Instant::now() < deadline, "port.call frame not written");
            thread::sleep(Duration::from_millis(1));
        };
        assert_eq!(frame["kind"], "port.call");
        assert_eq!(frame["port"], "sandbox");
        assert_eq!(frame["method"], "fsop");
        let id = frame["id"].clone();
        assert!(link.settle(&json!({
            "kind": "port.result", "id": id, "value": {"ok": true, "result": {"text": "hi"}},
        })));
        let value = handle.join().unwrap().unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["text"], "hi");
    }

    #[test]
    fn port_error_becomes_tool_error() {
        let (capture, writer) = capture();
        let link = Arc::new(PortLink::new(writer));
        let caller = Arc::clone(&link);
        let handle = thread::spawn(move || caller.call("sandbox", "fsop", json!({})));
        let deadline = Instant::now() + Duration::from_secs(5);
        while capture.0.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        let id = read_written(&capture.0)["id"].clone();
        link.settle(&json!({"kind": "port.error", "id": id, "error": "unresolved_cap"}));
        let error = handle.join().unwrap().unwrap_err();
        assert_eq!(error.code, "unresolved_cap");
    }

    #[test]
    fn settle_ignores_unknown_kinds_and_ids() {
        let (_capture, writer) = capture();
        let link = PortLink::new(writer);
        assert!(!link.settle(&json!({"kind": "result", "id": "x"})));
        assert!(link.settle(&json!({"kind": "port.result", "id": "missing"})));
    }

    /// 从捕获字节里解析出全部**完整**帧（尾部不完整的帧留给下一轮）。
    fn read_complete_frames(sink: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let bytes = sink.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(bytes);
        let mut frames = Vec::new();
        while let Ok(Some(message)) = frames::read_frame(&mut cursor) {
            frames.push(message);
        }
        frames
    }

    #[test]
    fn concurrent_inflight_calls_settle_independently() {
        let (capture, writer) = capture();
        let link = Arc::new(PortLink::new(writer));
        let mut handles = Vec::new();
        for index in 0..4u32 {
            let caller = Arc::clone(&link);
            handles.push(thread::spawn(move || {
                caller.call("sandbox", "fsop", json!({"i": index}))
            }));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut frames = Vec::new();
        while frames.len() < 4 {
            assert!(
                Instant::now() < deadline,
                "not all port.call frames written"
            );
            frames = read_complete_frames(&capture.0);
            thread::sleep(Duration::from_millis(1));
        }
        // 多条在途各自按 id 结算，互不串扰。
        for frame in &frames {
            let echoed = frame["args"]["i"].clone();
            assert!(link.settle(&json!({
                "kind": "port.result", "id": frame["id"], "value": {"echo": echoed},
            })));
        }
        for (index, handle) in handles.into_iter().enumerate() {
            let value = handle.join().unwrap().unwrap();
            assert_eq!(value["echo"], json!(index as u32));
        }
    }

    #[test]
    fn poisoned_pending_lock_degrades_without_panic() {
        let (_capture, writer) = capture();
        let link = Arc::new(PortLink::with_timeout(writer, Duration::from_millis(20)));
        let poisoner = Arc::clone(&link);
        let handle = thread::spawn(move || {
            let _guard = poisoner.pending.lock().unwrap();
            panic!("poison the pending registry");
        });
        assert!(handle.join().is_err());
        // 锁已中毒：call 仍返回结构化超时，而不是 panic 杀进程。
        let error = link.call("sandbox", "fsop", json!({})).unwrap_err();
        assert_eq!(error.code, "tool_timeout");
        // settle / fail_all 同样不 panic。
        assert!(link.settle(&json!({"kind": "port.result", "id": "none"})));
        link.fail_all("transport_failed");
    }

    #[test]
    fn timeout_is_structured() {
        let (_capture, writer) = capture();
        let link = PortLink::with_timeout(writer, Duration::from_millis(20));
        let error = link.call("sandbox", "fsop", json!({})).unwrap_err();
        assert_eq!(error.code, "tool_timeout");
    }

    #[test]
    fn parse_fsop_response_passthrough() {
        let ok = parse_fsop_response(&json!({"ok": true, "result": {"paths": []}})).unwrap();
        assert_eq!(ok["paths"], json!([]));
        let denied = parse_fsop_response(&json!({
            "ok": false, "code": "fs_denied", "message": "outside",
        }))
        .unwrap_err();
        assert_eq!(denied.code, "fs_denied");
        assert_eq!(denied.message, "outside");
    }
}
