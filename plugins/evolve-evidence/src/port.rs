// 上行事件（docs/protocol.md §2.5）：宿主只透传，不落账、不推进。
// 反向调用通道（`evolve-ledger.*`）走 SDK 的 `PortLink`（见 ledger 模块）。

use serde_json::{json, Value};

use plugin_sdk::{write_frame, SharedWriter};

/// 上行事件面。
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
    use std::sync::{Arc, Mutex};

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
