// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）、上行事件（§2.5）与依赖抽象。
// 通道编解码 / 登记结算走 plugin-sdk 的 `PortLink`；本模块只留领域适配：
// 本插件唯一 pin = 保留身份 `host`；`shadow` 经 `host.audit` 读历史 `EffectAudit` 作补充对照源。
// 反向调用失败作数据、不抛错、不断通道；单测 / 集成测试用可注入的假实现替换真实通道。

use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::{write_frame, PortLink, SharedWriter};

use crate::error::ServiceError;

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
        self.link
            .call("host", "audit", args)
            .map_err(|error| ServiceError::new(&error.code, error.message))
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
            let _ = write_frame(&mut *guard, &frame);
        }
    }
}

/// 捕获事件：测试用（断言发了什么 topic / payload）。
#[derive(Default)]
pub struct CapturingEventSink {
    events: std::sync::Mutex<Vec<(String, Value)>>,
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
    use std::io::Write;
    use std::sync::Mutex;

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
        plugin_sdk::read_frame(&mut cursor).unwrap().unwrap()
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
