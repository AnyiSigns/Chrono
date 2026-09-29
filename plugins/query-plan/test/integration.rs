// 集成测试：黑盒经服务协议驱动真实二进制（hello / manifest / plan），
// 并用线协议桥接注入 model 假实现（应答 port.call）。
// 覆盖：查询构造、多查询默认关不触模型、多查询展开、无连接降级、不产生写。
// 用 `test/`（非 cargo 缺省 `tests/`），由 Cargo.toml 的 `[[test]] path` 显式声明。

use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

use plugin_sdk::{read_frame, write_frame};

struct Service {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    chat_text: String,
    model_calls: u32,
}

impl Service {
    fn spawn(chat_text: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_query-plan"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn query-plan");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            chat_text: chat_text.to_string(),
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
            "port": "query-plan", "method": method, "args": args,
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

    /// 应答服务的反向调用：注入假 model。
    fn answer(&mut self, message: &Value) {
        let value = match (
            message.get("port").and_then(Value::as_str).unwrap_or(""),
            message.get("method").and_then(Value::as_str).unwrap_or(""),
        ) {
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

#[test]
fn protocol_handshake_and_plan_default() {
    let mut service = Service::spawn("[\"alpha\"]");
    service.send(&json!({"v":"1","id":"h","kind":"hello","impl":"query-plan"}));
    let manifest = service.recv();
    assert_eq!(manifest["kind"], "manifest");
    assert_eq!(manifest["identity"], "query-plan");
    assert_eq!(manifest["methods"]["query-plan"], json!(["plan"]));

    let value = service.call("p1", "plan", json!({"query": "note", "goal": "ship it"}));
    assert_eq!(value["kind"], "result", "{value}");
    assert_eq!(value["value"]["query"], "note\nship it");
    assert_eq!(value["value"]["queries"], json!(["note\nship it"]));
    // 默认关：不得触发 model.chat。
    assert_eq!(service.model_calls, 0);
    assert!(value["value"].get("$directives").is_none());
}

#[test]
fn plan_multi_query_expands_via_model() {
    let mut service = Service::spawn("[\"alpha\", \"beta\"]");
    let value = service.call(
        "p1",
        "plan",
        json!({"query": "note", "model_config": {}, "multi_query": true}),
    );
    assert_eq!(value["value"]["query"], "note");
    assert_eq!(value["value"]["queries"], json!(["note", "alpha", "beta"]));
    assert_eq!(service.model_calls, 1);
}

#[test]
fn plan_without_model_config_degrades_to_single_query() {
    let mut service = Service::spawn("[\"alpha\"]");
    let value = service.call("p1", "plan", json!({"query": "note", "multi_query": true}));
    assert_eq!(value["value"]["queries"], json!(["note"]));
    assert_eq!(service.model_calls, 0);
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
