// 集成测试：黑盒经服务协议驱动真实二进制（hello / manifest / search），
// 并用线协议桥接注入 embedding / memory / model 假实现（应答 port.call）。
// 覆盖：命中集确定、空库、同条目多块不重复、过滤、预算、dedup_set 去重、不产生写。
// 用 `test/`（非 cargo 缺省 `tests/`），由 Cargo.toml 的 `[[test]] path` 显式声明。

use std::collections::BTreeMap;
use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

use memory_retrieval::frames::{read_frame, write_frame};

/// 线协议桥接的假后端数据。
struct Bridge {
    hits: Vec<Value>,
    entries: BTreeMap<String, Value>,
    chat_text: String,
    /// `memory.search` 回的 status（`ready` 或 #21 冷索引的 `index_building`）。
    search_status: String,
}

struct Service {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    bridge: Bridge,
}

impl Service {
    fn spawn(bridge: Bridge) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_memory-retrieval"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn memory-retrieval");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            bridge,
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
            "port": "retrieval", "method": method, "args": args,
            "env": {"run": "r1", "thread": null, "now": 1_704_067_200_000.0},
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

    /// 应答服务的反向调用：注入假 embedding / memory / model。
    fn answer(&mut self, message: &Value) {
        let port = message.get("port").and_then(Value::as_str).unwrap_or("");
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let args = message.get("args").cloned().unwrap_or(Value::Null);
        let value = match (port, method) {
            ("embedding", "embed") => {
                let texts = args
                    .get("texts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let vectors: Vec<Value> =
                    texts.iter().map(|_| json!([1.0, 0.0, 0.0, 0.0])).collect();
                json!({"model": "fake", "dim": 4, "vectors": vectors})
            }
            ("memory", "search") => json!({
                "ok": true, "kind": "search", "status": self.bridge.search_status,
                "model": {"id": "fake", "dim": 4},
                "hits": if self.bridge.search_status == "index_building" { Vec::new() } else { self.bridge.hits.clone() },
            }),
            ("memory", "read") => {
                let hashes = args
                    .get("hashes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut entries = Vec::new();
                let mut missing = Vec::new();
                for hash in hashes {
                    let Some(hash) = hash.as_str() else { continue };
                    match self.bridge.entries.get(hash) {
                        Some(entry) => entries.push(json!({"hash": hash, "entry": entry})),
                        None => missing.push(json!(hash)),
                    }
                }
                json!({"ok": true, "kind": "read", "entries": entries, "missing": missing})
            }
            ("model", "chat") => json!({"text": self.bridge.chat_text}),
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

fn entry(id: &str, text: &str, workspace: Option<&str>, source: &str, at: &str) -> Value {
    let mut meta = json!({"source": source, "at": at});
    if let Some(workspace) = workspace {
        meta["workspace"] = json!(workspace);
    }
    json!({"id": id, "text": text, "meta": meta, "chunks": []})
}

fn refs() -> BTreeMap<String, Value> {
    let mut entries = BTreeMap::new();
    entries.insert(
        "e1".to_string(),
        entry(
            "m-1",
            "alpha note",
            Some("w1"),
            "manual",
            "1970-01-01T00:00:00Z",
        ),
    );
    entries.insert(
        "e2".to_string(),
        entry(
            "m-2",
            "beta note",
            Some("w2"),
            "session",
            "2024-01-01T00:00:00Z",
        ),
    );
    entries
}

fn bridge(hits: Vec<Value>) -> Bridge {
    Bridge {
        hits,
        entries: refs(),
        chat_text: "[]".to_string(),
        search_status: "ready".to_string(),
    }
}

fn bridge_with_chat(hits: Vec<Value>, chat_text: &str) -> Bridge {
    Bridge {
        hits,
        entries: refs(),
        chat_text: chat_text.to_string(),
        search_status: "ready".to_string(),
    }
}

fn default_hits() -> Vec<Value> {
    vec![
        json!({"entry_hash": "e2", "chunk_index": 0, "score": 0.9}),
        json!({"entry_hash": "e2", "chunk_index": 1, "score": 0.8}),
        json!({"entry_hash": "e1", "chunk_index": 0, "score": 0.5}),
    ]
}

fn bag(extra: Value) -> Value {
    // L3 条目与索引由 `memory-store` owner 自持：bag 不再传 memory 切片。
    let mut bag = json!({
        "query": "note",
        "workspace": "w1",
        "retrieval": {"mmr_lambda": 1.0},
    });
    if let (Some(base), Some(extra)) = (bag.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    bag
}

fn recall_hashes(value: &Value) -> Vec<String> {
    value["value"]["recall"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["entry_hash"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn protocol_handshake_and_search_is_deterministic() {
    let mut service = Service::spawn(bridge(default_hits()));
    service.send(&json!({"v":"1","id":"h","kind":"hello","impl":"memory-retrieval"}));
    let manifest = service.recv();
    assert_eq!(manifest["kind"], "manifest");
    assert_eq!(manifest["identity"], "memory-retrieval");
    assert_eq!(manifest["methods"]["retrieval"], json!(["search"]));

    let first = service.call("s1", "search", bag(json!({})));
    let second = service.call("s2", "search", bag(json!({})));
    assert_eq!(first["kind"], "result", "{first}");
    assert_eq!(first["value"]["recall"], second["value"]["recall"]);
    // 工作区范围默认开：w2 的 e2 被过滤，只留 w1 的 e1。
    assert_eq!(recall_hashes(&first), vec!["e1"]);
    assert_eq!(first["value"]["queries"], json!(["note"]));
    // 不产生写。
    assert!(first["value"].get("$directives").is_none());
}

#[test]
fn same_entry_multiple_chunks_not_duplicated() {
    let mut service = Service::spawn(bridge(default_hits()));
    let value = service.call(
        "s1",
        "search",
        bag(json!({"retrieval": {"mmr_lambda": 1.0, "workspace_scope": false}})),
    );
    assert_eq!(recall_hashes(&value), vec!["e2", "e1"]);
    assert_eq!(value["value"]["recall"][0]["chunk_index"], 0);
    assert_eq!(value["value"]["count"], 2);
}

#[test]
fn empty_library_returns_empty_set_without_error() {
    let mut service = Service::spawn(bridge(Vec::new()));
    let value = service.call("s1", "search", bag(json!({})));
    assert_eq!(value["kind"], "result");
    assert_eq!(value["value"]["count"], 0);
    assert!(value["value"]["recall"].as_array().unwrap().is_empty());
}

#[test]
fn budget_caps_recall_count() {
    let mut service = Service::spawn(bridge(default_hits()));
    let value = service.call(
        "s1",
        "search",
        bag(json!({
            "recall_budget": 1,
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false},
        })),
    );
    assert_eq!(value["value"]["count"], 1);
    assert_eq!(recall_hashes(&value), vec!["e2"]);
    assert_eq!(value["value"]["budget"], 1);
}

#[test]
fn dedup_set_drops_in_context_duplicate() {
    let mut service = Service::spawn(bridge(default_hits()));
    let value = service.call("s1", "search", bag(json!({"dedup_set": ["alpha note"]})));
    assert_eq!(value["value"]["count"], 0);
    assert_eq!(value["value"]["stats"]["dedup"], 1);
}

#[test]
fn workspace_and_source_filters_apply() {
    let mut service = Service::spawn(bridge(default_hits()));
    let value = service.call(
        "s1",
        "search",
        bag(json!({
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false, "source": ["manual"]},
        })),
    );
    assert_eq!(recall_hashes(&value), vec!["e1"]);
}

#[test]
fn threshold_after_decay_drops_entries() {
    let mut service = Service::spawn(bridge(default_hits()));
    let value = service.call(
        "s1",
        "search",
        bag(json!({
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false, "min_score": 0.6},
        })),
    );
    assert_eq!(recall_hashes(&value), vec!["e2"]);
    assert_eq!(value["value"]["stats"]["threshold"], 1);
}

#[test]
fn multi_query_expands_queries_via_model() {
    let mut service = Service::spawn(bridge_with_chat(default_hits(), "[\"alpha\", \"beta\"]"));
    let value = service.call(
        "s1",
        "search",
        bag(json!({
            "model_config": {},
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false, "multi_query": true},
        })),
    );
    assert_eq!(value["value"]["queries"], json!(["note", "alpha", "beta"]));
    // 跨查询归并后仍是同条目取最高分、不重复。
    assert_eq!(recall_hashes(&value), vec!["e2", "e1"]);
}

#[test]
fn semantic_rerank_reorders_via_model() {
    let mut service = Service::spawn(bridge_with_chat(default_hits(), "[1, 0]"));
    let value = service.call(
        "s1",
        "search",
        bag(json!({
            "model_config": {},
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false, "rerank": true},
        })),
    );
    assert_eq!(recall_hashes(&value), vec!["e1", "e2"]);
}

#[test]
fn index_building_propagates_structured_status() {
    let mut bridge = bridge(Vec::new());
    bridge.search_status = "index_building".to_string();
    let mut service = Service::spawn(bridge);
    let value = service.call("s1", "search", bag(json!({})));
    assert_eq!(value["kind"], "result", "{value}");
    assert_eq!(value["value"]["status"], "index_building");
    assert_eq!(value["value"]["count"], 0);
    assert!(value["value"]["recall"].as_array().unwrap().is_empty());
    // 不是静默空集：显式状态供调用方重试。
    assert_ne!(value["value"]["status"], "ready");
}

#[test]
fn read_failure_degrades_to_empty() {
    let mut bridge = bridge(default_hits());
    bridge.entries = BTreeMap::new();
    let mut service = Service::spawn(bridge);
    let value = service.call("s1", "search", bag(json!({})));
    assert_eq!(value["kind"], "result");
    assert_eq!(value["value"]["count"], 0);
    assert_eq!(value["value"]["stats"]["missing"], 2);
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
