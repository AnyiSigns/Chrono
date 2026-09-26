// 反向调用通道（服务 → 宿主）与依赖抽象：embedding.embed / memory.search / memory.read / model.chat。
// 通道编解码 / 登记结算走 plugin-sdk 的 `PortLink`；本模块只留领域适配。
// 反向调用失败作数据、不抛错、不断通道；单测 / 集成测试用可注入的假实现替换真实通道。

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::PortLink;

use crate::error::ServiceError;
use crate::hash::hash64;

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

/// 反向调用错误码词表与领域错误同源：原样搬运，不吞、不改写。
fn service_error(error: plugin_sdk::ServiceError) -> ServiceError {
    ServiceError::new(&error.code, error.message)
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
        let value = self
            .link
            .call("embedding", "embed", json!({ "texts": texts, "model": model }))
            .map_err(service_error)?;
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
        self.link.call("memory", "search", args).map_err(service_error)
    }

    fn read(&self, args: Value) -> Result<Value, ServiceError> {
        self.link.call("memory", "read", args).map_err(service_error)
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
        self.link.call("model", "chat", args).map_err(service_error)
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
