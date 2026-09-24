// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）、上行事件（§2.5）与依赖抽象。
// 本插件唯一 pin = 保留身份 `host`；`shadow` 经 `host.audit` 读历史 `EffectAudit` 作补充对照源。
// 反向调用失败作数据、不抛错、不断通道；单测 / 集成测试用可注入的假实现替换真实通道。

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::ServiceError;
use crate::frames;

/// 协议出口：宿主 `call` 的应答、反向 `port.call`、上行 `event` 共用同一写端。
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。
pub const DEFAULT_CALL_TIMEOUT_MS: u64 = 30_000;

thread_local! {
    /// 当前线程正在处理的正向 `call` 帧 id；反向 `port.call` 据此回带可选 `call_id`。
    static CURRENT_CALL_ID: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// 记录当前线程正在处理的正向 `call` 帧 id（无 id / 非字符串时传 `None`）。
pub fn set_current_call_id(id: Option<String>) {
    CURRENT_CALL_ID.with(|slot| *slot.borrow_mut() = id);
}

/// 读当前线程正在处理的 `call` 帧 id（发送点与测试使用）。
pub fn current_call_id() -> Option<String> {
    CURRENT_CALL_ID.with(|slot| slot.borrow().clone())
}

/// 当前调用 id 的作用域守卫：构造时记录、`Drop` 时清空。
/// 正向帧处理提前返回或 panic 时也不会把 id 残留到线程后续复用（防止反向调用串台）。
pub struct CurrentCallIdGuard;

impl CurrentCallIdGuard {
    /// 记录本线程正在处理的正向帧 id，并在守卫 Drop 时清空。
    pub fn set(id: Option<String>) -> Self {
        set_current_call_id(id);
        Self
    }
}

impl Drop for CurrentCallIdGuard {
    fn drop(&mut self) {
        set_current_call_id(None);
    }
}

enum Outcome {
    Value(Value),
    Error(ServiceError),
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
    pub fn call(&self, port: &str, method: &str, args: Value) -> Result<Value, ServiceError> {
        let id = format!(
            "evolve-metrics-{}",
            self.seq.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::channel();
        self.pending().insert(id.clone(), sender);
        let mut frame = json!({
            "v": "1", "id": id, "kind": "port.call",
            "port": port, "method": method, "args": args,
        });
        // 回带发起本次处理的正向 `call` 帧 id（可选）：宿主按此把反向调用关联到逻辑调用。
        if let Some(call_id) = current_call_id() {
            frame["call_id"] = json!(call_id);
        }
        if let Err(err) = self.write(&frame) {
            self.pending().remove(&id);
            return Err(ServiceError::new("transport_failed", err.to_string()));
        }
        match receiver.recv_timeout(self.timeout) {
            Ok(Outcome::Value(value)) => Ok(value),
            Ok(Outcome::Error(error)) => Err(error),
            Err(_) => {
                self.pending().remove(&id);
                Err(ServiceError::new(
                    "transport_failed",
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
            Outcome::Error(ServiceError::new(
                message
                    .get("error")
                    .and_then(Value::as_str)
                    .or_else(|| message.get("code").and_then(Value::as_str))
                    .unwrap_or("host_call_failed"),
                message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ))
        };
        let _ = sender.send(outcome);
        true
    }

    /// 断连 / 退出：未结算的调用全部作数据失败。
    pub fn fail_all(&self, code: &str) {
        let mut pending = self.pending();
        for sender in pending.values() {
            let _ = sender.send(Outcome::Error(ServiceError::new(code, "link closed")));
        }
        pending.clear();
    }
}

/// 历史审计读面（`host.audit`）；`shadow` 作补充对照源，缺省可从 bag 直接给记录。
pub trait AuditSource: Send + Sync {
    fn audit(&self, filter: &Value, limit: Option<u64>) -> Result<Value, ServiceError>;
}

/// 经反向调用 `host.audit {filter?,limit?}` 读历史 `EffectAudit`。
pub struct RemoteAudit {
    link: Arc<PortLink>,
}

impl RemoteAudit {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl AuditSource for RemoteAudit {
    fn audit(&self, filter: &Value, limit: Option<u64>) -> Result<Value, ServiceError> {
        let mut args = json!({});
        if !filter.is_null() {
            args["filter"] = filter.clone();
        }
        if let Some(limit) = limit {
            args["limit"] = json!(limit);
        }
        self.link.call("host", "audit", args)
    }
}

/// 静态审计源：集成测试 / 无 host 通道时注入固定记录。
pub struct StaticAudit {
    pub records: Value,
}

impl StaticAudit {
    pub fn new(records: Vec<Value>) -> Self {
        Self {
            records: Value::Array(records),
        }
    }
}

impl AuditSource for StaticAudit {
    fn audit(&self, _filter: &Value, _limit: Option<u64>) -> Result<Value, ServiceError> {
        Ok(json!({ "records": self.records, "truncated": false }))
    }
}

/// 上行事件面（docs/protocol.md §2.5）：宿主只透传，不落账、不推进。
pub trait EventSink: Send + Sync {
    fn emit(&self, topic: &str, payload: Value);
}

/// 经协议出口发 `event` 帧（`{kind:'event', topic, payload}`）。
pub struct WriterEventSink {
    writer: SharedWriter,
}

impl WriterEventSink {
    pub fn new(writer: SharedWriter) -> Self {
        Self { writer }
    }
}

impl EventSink for WriterEventSink {
    fn emit(&self, topic: &str, payload: Value) {
        let frame = json!({ "v": "1", "kind": "event", "topic": topic, "payload": payload });
        if let Ok(mut guard) = self.writer.lock() {
            let _ = frames::write_frame(&mut *guard, &frame);
        }
    }
}

/// 捕获事件：测试用（断言发了什么 topic / payload）。
#[derive(Default)]
pub struct CapturingEventSink {
    events: Mutex<Vec<(String, Value)>>,
}

impl CapturingEventSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn events(&self) -> Vec<(String, Value)> {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl EventSink for CapturingEventSink {
    fn emit(&self, topic: &str, payload: Value) {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((topic.to_string(), payload));
    }
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
        let handle = thread::spawn(move || caller.call("host", "audit", json!({})));
        let deadline = Instant::now() + Duration::from_secs(5);
        let frame = loop {
            if !capture.0.lock().unwrap().is_empty() {
                break read_written(&capture.0);
            }
            assert!(Instant::now() < deadline, "port.call frame not written");
            thread::sleep(Duration::from_millis(1));
        };
        assert_eq!(frame["kind"], "port.call");
        assert_eq!(frame["port"], "host");
        assert_eq!(frame["method"], "audit");
        let id = frame["id"].clone();
        assert!(link.settle(&json!({
            "kind": "port.result", "id": id, "value": {"records": [], "truncated": false},
        })));
        let value = handle.join().unwrap().unwrap();
        assert_eq!(value["truncated"], false);
    }

    #[test]
    fn port_call_echoes_current_call_id() {
        let (capture, writer) = capture();
        let link = PortLink::with_timeout(writer, Duration::from_millis(20));
        set_current_call_id(Some("call-7".to_string()));
        // 无宿主应答：超时返回结构化错误，但帧已写出。
        let _ = link.call("host", "audit", json!({}));
        let frame = read_written(&capture.0);
        assert_eq!(frame["kind"], "port.call");
        assert_eq!(frame["call_id"], "call-7");
        set_current_call_id(None);
    }

    #[test]
    fn port_call_omits_call_id_when_unset() {
        let (capture, writer) = capture();
        let link = PortLink::with_timeout(writer, Duration::from_millis(20));
        set_current_call_id(None);
        let _ = link.call("host", "audit", json!({}));
        let frame = read_written(&capture.0);
        assert!(frame.get("call_id").is_none());
    }

    #[test]
    fn current_call_id_guard_sets_and_clears() {
        assert_eq!(current_call_id(), None);
        {
            let _guard = CurrentCallIdGuard::set(Some("call-1".to_string()));
            assert_eq!(current_call_id().as_deref(), Some("call-1"));
        }
        assert_eq!(current_call_id(), None);
    }

    #[test]
    fn port_error_becomes_service_error() {
        let (capture, writer) = capture();
        let link = Arc::new(PortLink::new(writer));
        let caller = Arc::clone(&link);
        let handle = thread::spawn(move || caller.call("host", "audit", json!({})));
        let deadline = Instant::now() + Duration::from_secs(5);
        while capture.0.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        let id = read_written(&capture.0)["id"].clone();
        link.settle(&json!({"kind": "port.error", "id": id, "error": "bad_directive"}));
        let error = handle.join().unwrap().unwrap_err();
        assert_eq!(error.code, "bad_directive");
    }

    #[test]
    fn timeout_is_structured() {
        let (_capture, writer) = capture();
        let link = PortLink::with_timeout(writer, Duration::from_millis(20));
        let error = link.call("host", "audit", json!({})).unwrap_err();
        assert_eq!(error.code, "transport_failed");
    }

    #[test]
    fn settle_ignores_unknown_kinds_and_ids() {
        let (_capture, writer) = capture();
        let link = PortLink::new(writer);
        assert!(!link.settle(&json!({"kind": "result", "id": "x"})));
        assert!(link.settle(&json!({"kind": "port.result", "id": "missing"})));
    }

    #[test]
    fn event_sink_writes_event_frame() {
        let (capture, writer) = capture();
        let sink = WriterEventSink::new(writer);
        sink.emit("orchestration.unhealthy", json!({"streak": 3}));
        let frame = read_written(&capture.0);
        assert_eq!(frame["kind"], "event");
        assert_eq!(frame["topic"], "orchestration.unhealthy");
        assert_eq!(frame["payload"]["streak"], 3);
    }

    #[test]
    fn capturing_event_sink_records() {
        let sink = CapturingEventSink::new();
        sink.emit("a", json!(1));
        sink.emit("b", json!(2));
        assert_eq!(sink.events().len(), 2);
        assert_eq!(sink.events()[0].0, "a");
    }
}
