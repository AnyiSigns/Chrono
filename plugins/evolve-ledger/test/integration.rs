// 集成测试：黑盒经服务协议驱动真实二进制（hello / manifest / 两组方法）。
// 单一身份同时覆盖台账原语（read-chain / patch-plan / thresholds / hash）与指标层
// （aggregate / sweep / shadow / record）：链原语就地调用，无跨身份反向调用。
// 用 `test/`（非 cargo 缺省 `tests/`），由 Cargo.toml 的 `[[test]] path` 显式声明。

use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

use plugin_sdk::{read_frame, write_frame};

struct Service {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Service {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_evolve-ledger"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn evolve-ledger");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
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

    /// 正向调用：返回（正向应答, 期间收到的反向调用帧）。
    /// 指标层已就地调用链原语，理论上不应再发往 `evolve-ledger`；若出现 `host.audit` 则回空记录。
    fn call(&mut self, id: &str, method: &str, args: Value) -> (Value, Vec<Value>) {
        self.send(&json!({
            "v": "1", "id": id, "kind": "call",
            "port": "evolve-ledger", "method": method, "args": args,
            "env": {"run": "r1", "thread": null, "now": 42},
        }));
        let mut reverses = Vec::new();
        loop {
            let message = self.recv();
            match message.get("kind").and_then(Value::as_str) {
                Some("port.call") => {
                    reverses.push(message.clone());
                    self.send(&json!({
                        "v": "1", "id": message["id"], "kind": "port.result",
                        "value": {"records": [], "truncated": false}
                    }));
                }
                _ => {
                    if message.get("id").and_then(Value::as_str) == Some(id) {
                        return (message, reverses);
                    }
                }
            }
        }
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
fn protocol_handshake_declares_both_capabilities() {
    let mut service = Service::spawn();
    service.send(&json!({"v":"1","id":"h","kind":"hello","impl":"evolve-ledger"}));
    let manifest = service.recv();
    assert_eq!(manifest["kind"], "manifest");
    assert_eq!(manifest["identity"], "evolve-ledger");
    assert_eq!(manifest["implements"], json!(["evolve-ledger", "evolve-metrics"]));
    assert_eq!(
        manifest["methods"]["evolve-ledger"],
        json!(["read-chain", "patch-plan", "thresholds", "hash"])
    );
    assert_eq!(
        manifest["methods"]["evolve-metrics"],
        json!(["aggregate", "sweep", "shadow", "record"])
    );
    assert_eq!(manifest["state"], "recomputable");
    assert_eq!(manifest["protocol"], "1");
}

#[test]
fn ledger_methods_work_over_protocol() {
    let mut service = Service::spawn();

    let body = json!({
        "version": 1,
        "trace": {"tail": null, "count": 0},
        "evidence": {"tail": null, "count": 0},
        "proposals": {"tail": null, "count": 0},
        "verdicts": {"tail": null, "count": 0}
    });

    let (chain, reverses) = service.call("c1", "read-chain", json!({
        "trace_entries": [{"kind": "trace", "run": "r1", "workspace_id": "w1", "outcome": "done"}],
        "evolution": body.clone()
    }));
    assert_eq!(chain["value"]["trace"][0]["body"]["run"], "r1");
    assert_eq!(chain["value"]["body"]["evidence"]["count"], 0);
    assert!(reverses.is_empty());

    let (thresholds, _) = service.call("t1", "thresholds", json!({"thresholds": {"fold_k": 4}}));
    assert_eq!(thresholds["value"]["values"]["fold_k"], 4.0);

    let (hashed, _) = service.call("h1", "hash", json!({"values": ["hello"], "mode": "fnv"}));
    assert_eq!(hashed["value"]["hashes"][0].as_str().unwrap().len(), 16);

    let (planned, _) = service.call("p1", "patch-plan", json!({
        "body": body,
        "append": {"section": "evidence", "entries": [{"kind": "evidence", "id": "ev-1"}]}
    }));
    assert!(!planned["value"]["$directives"].as_array().unwrap().is_empty());
}

#[test]
fn metrics_methods_dispatch_in_process() {
    let mut service = Service::spawn();

    let (aggregated, reverses) = service.call("a1", "aggregate", json!({"thresholds": {}}));
    assert_eq!(aggregated["kind"], "result", "{aggregated}");
    assert!(aggregated["value"]["evidence"].as_array().unwrap().is_empty());
    assert!(reverses.is_empty(), "指标层不得再反向调用 evolve-ledger：{reverses:?}");

    let (swept, reverses) = service.call("s1", "sweep", json!({}));
    assert_eq!(swept["value"]["swept"], 0);
    assert!(reverses.is_empty());

    let (shadowed, reverses) = service.call("sh1", "shadow", json!({"audit": []}));
    assert_eq!(shadowed["value"]["status"], "unverified");
    assert!(reverses.is_empty());

    let (recorded, reverses) = service.call(
        "r1",
        "record",
        json!({"user_message_def": {"def": "msg"}, "workspace_id": "w1"}),
    );
    assert!(reverses.is_empty());
    let evidence_id = recorded["value"]["evidence_id"].as_str().unwrap();
    assert!(evidence_id.starts_with("ev-"), "evidence_id = {evidence_id}");
    assert_eq!(evidence_id.len(), 3 + 16);
}

// ── 红线断言（测试不得 import 宿主 / 内核 / client） ──────────────────────────

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
