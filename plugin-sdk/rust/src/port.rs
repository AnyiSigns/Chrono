// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）：发 `port.call`、按 id 结算 `port.result` / `port.error`。
// 失败作数据（`ServiceError`），不抛错、不断通道；未结算的调用在通道关闭时统一 `fail_all`。
// 发起点回带本线程正在处理的正向 `call` 帧 id（可选 `call_id`），宿主据此把反向调用关联到逻辑调用。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use crate::service::{current_call_id, ServiceError, SharedWriter};
use crate::wire::write_frame;

/// 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。
pub const DEFAULT_CALL_TIMEOUT_MS: u64 = 30_000;

enum Outcome {
    Value(Value),
    Error(ServiceError),
}

type PendingMap = HashMap<String, mpsc::Sender<Outcome>>;

/// 一条服务连接上的反向调用登记表；帧循环收到 `port.result` / `port.error` 时调 `settle`。
pub struct PortLink {
    writer: SharedWriter,
    id_prefix: String,
    pending: Mutex<PendingMap>,
    seq: AtomicU64,
    timeout: Duration,
    timeout_code: String,
}

impl PortLink {
    pub fn new(writer: SharedWriter, id_prefix: impl Into<String>) -> Self {
        Self::with_timeout(writer, id_prefix, Duration::from_millis(DEFAULT_CALL_TIMEOUT_MS))
    }

    pub fn with_timeout(writer: SharedWriter, id_prefix: impl Into<String>, timeout: Duration) -> Self {
        Self {
            writer,
            id_prefix: id_prefix.into(),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            timeout,
            timeout_code: String::from("transport_failed"),
        }
    }

    /// 覆盖超时错误码（缺省 `transport_failed`）。
    pub fn with_timeout_code(mut self, code: impl Into<String>) -> Self {
        self.timeout_code = code.into();
        self
    }

    /// 取登记表：锁中毒（持锁线程曾 panic）时恢复内部数据，不以 panic 杀进程。
    fn pending(&self) -> MutexGuard<'_, PendingMap> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 发一条 `port.call` 并等待应答；超时 / 写失败作结构化错误。
    pub fn call(&self, port: &str, method: &str, args: Value) -> Result<Value, ServiceError> {
        self.call_impl(port, method, args, None)
    }

    /// 发一条带 `provider` 的 `port.call`（按成员定位的 `many`）：`port` 是扩展类名、`provider`
    /// 是目标提供方身份名，宿主校验「该类在发出者 `needs` 且 `mode:"many"`」且「目标 ∈ 索引(类)」
    /// 后按该成员端点调用；其余语义与 `call` 相同。
    pub fn call_with_provider(
        &self,
        port: &str,
        method: &str,
        args: Value,
        provider: &str,
    ) -> Result<Value, ServiceError> {
        self.call_impl(port, method, args, Some(provider))
    }

    fn call_impl(
        &self,
        port: &str,
        method: &str,
        args: Value,
        provider: Option<&str>,
    ) -> Result<Value, ServiceError> {
        let id = format!("{}-{}", self.id_prefix, self.seq.fetch_add(1, Ordering::Relaxed));
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
        // 按成员定位的 `many`：帧带目标提供方身份名，宿主按扩展类 + 成员解析。
        if let Some(target) = provider {
            frame["provider"] = json!(target);
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
                    self.timeout_code.clone(),
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
        write_frame(&mut *guard, message)
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
            let _ = sender.send(Outcome::Error(ServiceError::new(code, "link closed")));
        }
        pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Arc;
    use std::thread;
    use std::time::Instant;

    use crate::service::set_current_call_id;

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
        crate::wire::read_frame(&mut cursor).unwrap().unwrap()
    }

    fn read_complete_frames(sink: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let bytes = sink.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(bytes);
        let mut frames = Vec::new();
        while let Ok(Some(message)) = crate::wire::read_frame(&mut cursor) {
            frames.push(message);
        }
        frames
    }

    #[test]
    fn port_call_round_trip() {
        let (capture, writer) = capture();
        let link = Arc::new(PortLink::new(writer, "toy"));
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
    fn port_call_echoes_current_call_id() {
        let (capture, writer) = capture();
        let link = PortLink::with_timeout(writer, "toy", Duration::from_millis(20));
        set_current_call_id(Some("call-5".to_string()));
        // 无宿主应答：超时返回结构化错误，但帧已写出。
        let _ = link.call("sandbox", "fsop", json!({"op": "read"}));
        let frame = read_written(&capture.0);
        assert_eq!(frame["kind"], "port.call");
        assert_eq!(frame["call_id"], "call-5");
        set_current_call_id(None);
    }

    #[test]
    fn port_call_omits_call_id_when_unset() {
        let (capture, writer) = capture();
        let link = PortLink::with_timeout(writer, "toy", Duration::from_millis(20));
        set_current_call_id(None);
        let _ = link.call("sandbox", "fsop", json!({}));
        let frame = read_written(&capture.0);
        assert!(frame.get("call_id").is_none());
    }

    #[test]
    fn call_with_provider_sets_provider_field() {
        let (capture, writer) = capture();
        let link = PortLink::with_timeout(writer, "toy", Duration::from_millis(20));
        // 无宿主应答：超时返回结构化错误，但帧已写出并带 provider。
        let _ = link.call_with_provider("embedding-provider", "embed", json!({}), "embedding-local");
        let frame = read_written(&capture.0);
        assert_eq!(frame["port"], "embedding-provider");
        assert_eq!(frame["provider"], "embedding-local");
    }

    #[test]
    fn plain_call_omits_provider_field() {
        let (capture, writer) = capture();
        let link = PortLink::with_timeout(writer, "toy", Duration::from_millis(20));
        let _ = link.call("sandbox", "fsop", json!({}));
        let frame = read_written(&capture.0);
        assert!(frame.get("provider").is_none());
    }

    #[test]
    fn current_call_id_guard_sets_and_clears() {
        assert_eq!(current_call_id(), None);
        {
            let _guard = crate::service::CurrentCallIdGuard::set(Some("call-1".to_string()));
            assert_eq!(current_call_id().as_deref(), Some("call-1"));
        }
        assert_eq!(current_call_id(), None);
    }

    #[test]
    fn port_error_becomes_service_error() {
        let (capture, writer) = capture();
        let link = Arc::new(PortLink::new(writer, "toy"));
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
        let link = PortLink::new(writer, "toy");
        assert!(!link.settle(&json!({"kind": "result", "id": "x"})));
        assert!(link.settle(&json!({"kind": "port.result", "id": "missing"})));
    }

    #[test]
    fn concurrent_inflight_calls_settle_independently() {
        let (capture, writer) = capture();
        let link = Arc::new(PortLink::new(writer, "toy"));
        let mut handles = Vec::new();
        for index in 0..4u32 {
            let caller = Arc::clone(&link);
            handles.push(thread::spawn(move || caller.call("sandbox", "fsop", json!({"i": index}))));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut frames = Vec::new();
        while frames.len() < 4 {
            assert!(Instant::now() < deadline, "not all port.call frames written");
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
        let link = Arc::new(PortLink::with_timeout(writer, "toy", Duration::from_millis(20)));
        let poisoner = Arc::clone(&link);
        let handle = thread::spawn(move || {
            let _guard = poisoner.pending.lock().unwrap();
            panic!("poison the pending registry");
        });
        assert!(handle.join().is_err());
        // 锁已中毒：call 仍返回结构化超时，而不是 panic 杀进程。
        let error = link.call("sandbox", "fsop", json!({})).unwrap_err();
        assert_eq!(error.code, "transport_failed");
        // settle / fail_all 同样不 panic。
        assert!(link.settle(&json!({"kind": "port.result", "id": "none"})));
        link.fail_all("transport_failed");
    }

    #[test]
    fn timeout_is_structured_and_configurable() {
        let (_capture, writer) = capture();
        let link = PortLink::with_timeout(writer, "toy", Duration::from_millis(20));
        let error = link.call("sandbox", "fsop", json!({})).unwrap_err();
        assert_eq!(error.code, "transport_failed");

        let (_capture, writer) = capture();
        let link = PortLink::with_timeout(writer, "toy", Duration::from_millis(20))
            .with_timeout_code("tool_timeout");
        let error = link.call("sandbox", "fsop", json!({})).unwrap_err();
        assert_eq!(error.code, "tool_timeout");
    }
}
