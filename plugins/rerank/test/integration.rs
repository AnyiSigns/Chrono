// 集成测试：黑盒经服务协议驱动真实二进制（hello / manifest / order），
// 并用线协议桥接注入 embedding / model 假实现（应答 port.call）。
// 覆盖：纯相关度排序、MMR 向量化、语义重排与默认关、空集、不产生写。
// 用 `test/`（非 cargo 缺省 `tests/`），由 Cargo.toml 的 `[[test]] path` 显式声明。

use std::collections::BTreeMap;
use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

use plugin_sdk::{read_frame, write_frame};

struct Service {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    /// 文本 → 向量；未登记的文本回默认 `[1,0,0,0]`。
    embedding: BTreeMap<String, Vec<f64>>,
    chat_text: String,
    embedding_calls: u32,
    model_calls: u32,
}

impl Service {
    fn spawn(embedding: BTreeMap<String, Vec<f64>>, chat_text: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rerank"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn rerank");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            embedding,
            chat_text: chat_text.to_string(),
            embedding_calls: 0,
            model_calls: 0,
        }
    }

    fn send(&mut self, message: &Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        write_frame(stdin, message).expect("write frame");
        stdin.flush().expect("flush");
    }

    fn recv(&mut self) -> Value {
        read_frame(&mut self.stdout)
            .expect("read frame")
            .expect("service closed unexpectedly")
    }

    fn call(&mut self, id: &str, method: &str, args: Value) -> Value {
        self.send(&json!({
            "v": "1", "id": id, "kind": "call",
            "port": "rerank", "method": method, "args": args,
            "env": {"run": "r1", "thread": null, "now": 0.0},
        }));
        loop {
            let message = self.recv();
            if message.get("kind").and_then(Value::as_str) == Some("port.call") {
                self.answer(&message);
                continue;
            }
            if message.get("id").and_then(Value::as_str) == Some(id) {
                return message;
            }
        }
    }

    /// 应答服务的反向调用：注入假 embedding / model。
    fn answer(&mut self, message: &Value) {
        let value = match (
            message.get("port").and_then(Value::as_str).unwrap_or(""),
            message.get("method").and_then(Value::as_str).unwrap_or(""),
        ) {
            ("embedding", "embed") => {
                self.embedding_calls += 1;
                let args = message.get("args").cloned().unwrap_or(Value::Null);
                let texts = args
                    .get("texts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let vectors: Vec<Value> = texts
                    .iter()
                    .map(|text| {
                        let key = text.as_str().unwrap_or("");
                        let vector = self
                            .embedding
                            .get(key)
                            .cloned()
                            .unwrap_or_else(|| vec![1.0, 0.0, 0.0, 0.0]);
                        json!(vector)
                    })
                    .collect();
                json!({"model": "fake", "dim": 4, "vectors": vectors})
            }
            ("model", "chat") => {
                self.model_calls += 1;
                json!({"text": self.chat_text})
            }
            _ => json!({"ok": false, "error": {"code": "unexpected_port"}}),
        };
        self.send(&json!({
            "v": "1", "id": message.get("id").cloned().unwrap_or(Value::Null),
            "kind": "port.result", "value": value,
        }));
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        // 断开 stdin（EOF）→ 服务自退出，再回收子进程。
        self.stdin.take();
        let _ = self.child.wait();
    }
}

fn item(key: &str, score: f64, text: &str) -> Value {
    json!({ "key": key, "score": score, "text": text })
}

fn order(value: &Value) -> Vec<String> {
    value["value"]["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn protocol_handshake_and_pure_relevance_order() {
    let mut service = Service::spawn(BTreeMap::new(), "[]");
    service.send(&json!({"v":"1","id":"h","kind":"hello","impl":"rerank"}));
    let manifest = service.recv();
    assert_eq!(manifest["kind"], "manifest");
    assert_eq!(manifest["identity"], "rerank");
    assert_eq!(manifest["methods"]["rerank"], json!(["order"]));

    let value = service.call(
        "o1",
        "order",
        json!({
            "items": [item("a", 0.5, "x"), item("b", 0.9, "y")],
            "mmr_lambda": 1.0,
        }),
    );
    assert_eq!(value["kind"], "result", "{value}");
    assert_eq!(order(&value), vec!["b", "a"]);
    // λ = 1 纯相关度：不触向量化。
    assert_eq!(service.embedding_calls, 0);
    assert!(value["value"].get("$directives").is_none());
}

#[test]
fn mmr_order_uses_embedding() {
    let mut embedding = BTreeMap::new();
    embedding.insert("same".to_string(), vec![1.0, 0.0]);
    embedding.insert("other".to_string(), vec![0.0, 1.0]);
    let mut service = Service::spawn(embedding, "[]");
    let value = service.call(
        "o1",
        "order",
        json!({
            "items": [item("a", 0.9, "same"), item("b", 0.89, "same"), item("c", 0.8, "other")],
            "mmr_lambda": 0.0,
        }),
    );
    // 纯多样性：a 与 b 近重复，c 独立。
    assert_eq!(order(&value), vec!["a", "c", "b"]);
    assert_eq!(service.embedding_calls, 1);
}

#[test]
fn semantic_rerank_reorders_via_model() {
    let mut service = Service::spawn(BTreeMap::new(), "[1, 0]");
    let value = service.call(
        "o1",
        "order",
        json!({
            "items": [item("a", 0.9, "x"), item("b", 0.5, "y")],
            "mmr_lambda": 1.0,
            "rerank": true,
            "model_config": {},
        }),
    );
    assert_eq!(order(&value), vec!["b", "a"]);
    assert_eq!(service.model_calls, 1);
}

#[test]
fn semantic_rerank_defaults_off() {
    let mut service = Service::spawn(BTreeMap::new(), "[1, 0]");
    let value = service.call(
        "o1",
        "order",
        json!({
            "items": [item("a", 0.9, "x"), item("b", 0.5, "y")],
            "mmr_lambda": 1.0,
            "model_config": {},
        }),
    );
    assert_eq!(order(&value), vec!["a", "b"]);
    assert_eq!(service.model_calls, 0);
}

#[test]
fn empty_items_return_empty_order() {
    let mut service = Service::spawn(BTreeMap::new(), "[]");
    let value = service.call("o1", "order", json!({"items": []}));
    assert_eq!(value["kind"], "result");
    assert!(order(&value).is_empty());
}

// ── 红线断言（测试不得 import 宿主 / 内核 / client） ──────────────────────────

/// 递归收集目录下全部文件。
fn collect_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if !dir.exists() {
        return out;
    }
    for entry in std::fs::read_dir(dir).expect("read_dir") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            out.extend(collect_files(&path));
        } else {
            out.push(path);
        }
    }
    out
}

/// README 是否含 `#<数字>` 计划编号样式。
fn has_plan_number(text: &str) -> bool {
    text.as_bytes()
        .windows(2)
        .any(|window| window[0] == b'#' && window[1].is_ascii_digit())
}

#[test]
fn redline_no_host_kernel_client_refs_and_readme_has_no_plan_number() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let needles: Vec<String> = ["host", "kernel", "client"]
        .iter()
        .map(|part| format!("{}/{}", "packages", part))
        .collect();
    for dir in ["execute", "src", "terms", "test"] {
        for file in collect_files(&root.join(dir)) {
            let text = std::fs::read_to_string(&file).expect("read source");
            for needle in &needles {
                assert!(!text.contains(needle), "{} 出现 {}", file.display(), needle);
            }
        }
    }
    let readme = std::fs::read_to_string(root.join("README.md")).expect("read README");
    assert!(!has_plan_number(&readme), "README 含计划编号样式");
}
