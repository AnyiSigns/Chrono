// 反向调用通道（服务 → 宿主）与依赖抽象：embedding.embed / memory.search / memory.read / model.chat。
// 反向调用失败作数据、不抛错、不断通道；单测 / 集成测试用可注入的假实现替换真实通道。

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::ServiceError;
use crate::frames;
use crate::hash::hash64;

/// 协议出口：宿主 `call` 的应答、反向 `port.call`、上行 `event` 共用同一写端。
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// 反向调用等待上限；宿主自身另有调用超时，此处作通道兜底。
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

type PendingMap = BTreeMap<String, mpsc::Sender<Outcome>>;

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
            pending: Mutex::new(BTreeMap::new()),
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
            "memory-retrieval-{}",
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

/// 向量化面（embedding.embed）：文本 → 向量（已 L2 归一）。
pub trait EmbeddingPort: Send + Sync {
    fn embed(&self, texts: &[String], model: &str) -> Result<Vec<Vec<f64>>, ServiceError>;
}

/// 长期记忆面（memory.search / memory.read）：索引检索 + 按 hash 取条目正文。
pub trait MemoryPort: Send + Sync {
    fn search(&self, args: Value) -> Result<Value, ServiceError>;
    fn read(&self, args: Value) -> Result<Value, ServiceError>;
}

/// 模型面（model.chat）：多查询生成 / 语义重排（默认关）。
pub trait ModelPort: Send + Sync {
    fn chat(&self, args: Value) -> Result<Value, ServiceError>;
}

/// 检索流水线的依赖集合。
pub struct Ports<'a> {
    pub embedding: &'a dyn EmbeddingPort,
    pub memory: &'a dyn MemoryPort,
    pub model: &'a dyn ModelPort,
}

/// 经反向调用 `embedding.embed` 做向量化。
pub struct RemoteEmbedding {
    link: Arc<PortLink>,
}

impl RemoteEmbedding {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl EmbeddingPort for RemoteEmbedding {
    fn embed(&self, texts: &[String], model: &str) -> Result<Vec<Vec<f64>>, ServiceError> {
        let value = self.link.call(
            "embedding",
            "embed",
            json!({ "texts": texts, "model": model }),
        )?;
        parse_vectors(&value)
    }
}

/// 经反向调用 `memory.search` / `memory.read` 做索引检索与条目读取。
pub struct RemoteMemory {
    link: Arc<PortLink>,
}

impl RemoteMemory {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl MemoryPort for RemoteMemory {
    fn search(&self, args: Value) -> Result<Value, ServiceError> {
        self.link.call("memory", "search", args)
    }

    fn read(&self, args: Value) -> Result<Value, ServiceError> {
        self.link.call("memory", "read", args)
    }
}

/// 经反向调用 `model.chat` 做多查询生成 / 语义重排。
pub struct RemoteModel {
    link: Arc<PortLink>,
}

impl RemoteModel {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl ModelPort for RemoteModel {
    fn chat(&self, args: Value) -> Result<Value, ServiceError> {
        self.link.call("model", "chat", args)
    }
}

/// 解析 `embedding.embed` 结果 `{model, dim, vectors}`。
pub fn parse_vectors(value: &Value) -> Result<Vec<Vec<f64>>, ServiceError> {
    let vectors = value
        .get("vectors")
        .and_then(Value::as_array)
        .ok_or_else(|| ServiceError::new("bad_backend", "embedding.embed returned no vectors"))?;
    let mut out = Vec::with_capacity(vectors.len());
    for vector in vectors {
        let array = vector
            .as_array()
            .ok_or_else(|| ServiceError::new("bad_backend", "embedding vector is not an array"))?;
        let mut row = Vec::with_capacity(array.len());
        for item in array {
            let number = item.as_f64().ok_or_else(|| {
                ServiceError::new("bad_backend", "embedding vector has a non-number")
            })?;
            row.push(number);
        }
        out.push(row);
    }
    Ok(out)
}

/// 假向量化：测试用。按文本哈希产出确定向量；`overrides` 可固定特定文本的向量。
pub struct FakeEmbedding {
    pub dim: usize,
    pub overrides: BTreeMap<String, Vec<f64>>,
}

impl FakeEmbedding {
    pub fn new(dim: usize) -> Self {
        Self {
            dim,
            overrides: BTreeMap::new(),
        }
    }

    pub fn with_vectors(dim: usize, vectors: Vec<(String, Vec<f64>)>) -> Self {
        Self {
            dim,
            overrides: vectors.into_iter().collect(),
        }
    }
}

impl EmbeddingPort for FakeEmbedding {
    fn embed(&self, texts: &[String], _model: &str) -> Result<Vec<Vec<f64>>, ServiceError> {
        Ok(texts
            .iter()
            .map(|text| {
                self.overrides
                    .get(text)
                    .cloned()
                    .unwrap_or_else(|| deterministic_vector(text, self.dim))
            })
            .collect())
    }
}

/// 确定性伪向量：文本哈希填充 [−1, 1]，保证同文本同向量、跨运行可复现。
fn deterministic_vector(text: &str, dim: usize) -> Vec<f64> {
    let seed = hash64(text);
    let bytes = seed.as_bytes();
    (0..dim)
        .map(|index| {
            let byte = u32::from(bytes[index % bytes.len()]);
            let mixed = byte
                .wrapping_mul(31)
                .wrapping_add((index as u32).wrapping_mul(17));
            (f64::from(mixed % 2001) / 1000.0) - 1.0
        })
        .collect()
}

/// 假长期记忆：测试用。`search` 回固定 hits；`read` 从 `entries` 取。
pub struct FakeMemory {
    pub hits: Vec<Value>,
    pub entries: BTreeMap<String, Value>,
}

impl FakeMemory {
    pub fn new(hits: Vec<Value>, entries: BTreeMap<String, Value>) -> Self {
        Self { hits, entries }
    }
}

impl MemoryPort for FakeMemory {
    fn search(&self, _args: Value) -> Result<Value, ServiceError> {
        Ok(json!({
            "ok": true, "kind": "search", "status": "ready",
            "model": {"id": "fake", "dim": 4}, "hits": self.hits,
        }))
    }

    fn read(&self, args: Value) -> Result<Value, ServiceError> {
        if let Some(hash) = args.get("hash").and_then(Value::as_str) {
            let entry = self.entries.get(hash).cloned().unwrap_or(Value::Null);
            return Ok(json!({"ok": true, "kind": "read", "hash": hash, "entry": entry}));
        }
        let hashes = args
            .get("hashes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut entries = Vec::new();
        let mut missing = Vec::new();
        for hash in hashes {
            let Some(hash) = hash.as_str() else { continue };
            match self.entries.get(hash) {
                Some(entry) => entries.push(json!({"hash": hash, "entry": entry})),
                None => missing.push(json!(hash)),
            }
        }
        Ok(json!({"ok": true, "kind": "read", "entries": entries, "missing": missing}))
    }
}

/// 假长期记忆：`search` 回 `status:'index_building'`（#21 冷索引首查），`read` 回空。
pub struct FakeBuildingMemory;

impl MemoryPort for FakeBuildingMemory {
    fn search(&self, _args: Value) -> Result<Value, ServiceError> {
        Ok(json!({
            "ok": true, "kind": "search", "status": "index_building",
            "model": {"id": "fake", "dim": 4}, "hits": [],
        }))
    }

    fn read(&self, _args: Value) -> Result<Value, ServiceError> {
        Ok(json!({"ok": true, "kind": "read", "entries": [], "missing": []}))
    }
}

/// 假模型：测试用。`chat` 固定回 `text`。
pub struct FakeModel {
    pub text: String,
}

impl FakeModel {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
}

impl ModelPort for FakeModel {
    fn chat(&self, _args: Value) -> Result<Value, ServiceError> {
        Ok(json!({"text": self.text}))
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
        let handle = thread::spawn(move || caller.call("embedding", "embed", json!({"texts": []})));
        let deadline = Instant::now() + Duration::from_secs(5);
        let frame = loop {
            if !capture.0.lock().unwrap().is_empty() {
                break read_written(&capture.0);
            }
            assert!(Instant::now() < deadline, "port.call frame not written");
            thread::sleep(Duration::from_millis(1));
        };
        assert_eq!(frame["kind"], "port.call");
        assert_eq!(frame["port"], "embedding");
        assert_eq!(frame["method"], "embed");
        let id = frame["id"].clone();
        assert!(link.settle(&json!({
            "kind": "port.result", "id": id, "value": {"vectors": [[1.0, 0.0]]},
        })));
        let value = handle.join().unwrap().unwrap();
        assert_eq!(value["vectors"][0][0], 1.0);
    }

    #[test]
    fn port_call_echoes_current_call_id() {
        let (capture, writer) = capture();
        let link = PortLink::with_timeout(writer, Duration::from_millis(20));
        set_current_call_id(Some("call-42".to_string()));
        // 无宿主应答：超时返回结构化错误，但帧已写出。
        let _ = link.call("embedding", "embed", json!({"texts": []}));
        let frame = read_written(&capture.0);
        assert_eq!(frame["kind"], "port.call");
        assert_eq!(frame["call_id"], "call-42");
        set_current_call_id(None);
    }

    #[test]
    fn port_call_omits_call_id_when_unset() {
        let (capture, writer) = capture();
        let link = PortLink::with_timeout(writer, Duration::from_millis(20));
        set_current_call_id(None);
        let _ = link.call("embedding", "embed", json!({"texts": []}));
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
        let handle = thread::spawn(move || caller.call("memory", "search", json!({})));
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
    fn timeout_is_structured() {
        let (_capture, writer) = capture();
        let link = PortLink::with_timeout(writer, Duration::from_millis(20));
        let error = link.call("memory", "search", json!({})).unwrap_err();
        assert_eq!(error.code, "transport_failed");
    }

    #[test]
    fn fake_embedding_is_deterministic() {
        let fake = FakeEmbedding::new(4);
        let first = fake.embed(&["alpha".to_string()], "m").unwrap();
        let second = fake.embed(&["alpha".to_string()], "m").unwrap();
        assert_eq!(first, second);
        assert_eq!(first[0].len(), 4);
    }

    #[test]
    fn fake_memory_reads_by_hashes() {
        let mut entries = BTreeMap::new();
        entries.insert("h1".to_string(), json!({"text": "alpha"}));
        let fake = FakeMemory::new(Vec::new(), entries);
        let value = fake.read(json!({"hashes": ["h1", "h2"]})).unwrap();
        assert_eq!(value["entries"][0]["entry"]["text"], "alpha");
        assert_eq!(value["missing"][0], "h2");
    }

    #[test]
    fn parse_vectors_rejects_bad_shape() {
        assert!(parse_vectors(&json!({})).is_err());
        assert!(parse_vectors(&json!({"vectors": [["x"]]})).is_err());
        assert_eq!(
            parse_vectors(&json!({"vectors": [[1.0]]})).unwrap().len(),
            1
        );
    }
}
