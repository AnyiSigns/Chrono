// 集成测试：黑盒经服务协议驱动真实二进制（hello / manifest / 四方法委派），
// 测试充当最小宿主，应答门面发往提供方的反向调用。`cargo test` 一并运行。
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
        let mut child = Command::new(env!("CARGO_BIN_EXE_evolve-metrics"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn evolve-metrics");
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

    /// 最小宿主：应答门面发往 `evolve-evidence` / `evolve-sweep` / `evolve-shadow` 的反向调用，
    /// 直到目标 `id` 的正向应答到达；返回（正向应答, 最后一次反向调用）。
    fn call(&mut self, id: &str, method: &str, args: Value) -> (Value, Option<Value>) {
        self.send(&json!({
            "v": "1", "id": id, "kind": "call",
            "port": "evolve-metrics", "method": method, "args": args,
            "env": {"run": "r1", "thread": null, "now": 42},
        }));
        let mut last_reverse = None;
        loop {
            let message = self.recv();
            match message.get("kind").and_then(Value::as_str) {
                Some("port.call") => {
                    let port = message.get("port").and_then(Value::as_str).unwrap_or("");
                    let value = match port {
                        "evolve-evidence" => json!({
                            "evidence": [], "unhealthy": {"fired": false},
                            "evidence_id": "ev-x", "$directives": []
                        }),
                        "evolve-sweep" => json!({
                            "swept": 0, "retained": 0, "$directives": []
                        }),
                        "evolve-shadow" => json!({
                            "status": "unverified", "metric": {}, "metric_id": "0",
                            "$directives": []
                        }),
                        other => panic!("unexpected provider port {other}"),
                    };
                    last_reverse = Some(message.clone());
                    self.send(&json!({
                        "v": "1", "id": message["id"], "kind": "port.result", "value": value
                    }));
                }
                _ => {
                    if message.get("id").and_then(Value::as_str) == Some(id) {
                        return (message, last_reverse);
                    }
                }
            }
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.wait();
    }
}

#[test]
fn protocol_handshake_and_method_delegation() {
    let mut service = Service::spawn();
    service.send(&json!({"v":"1","id":"h","kind":"hello","impl":"evolve-metrics"}));
    let manifest = service.recv();
    assert_eq!(manifest["kind"], "manifest");
    assert_eq!(manifest["identity"], "evolve-metrics");
    assert_eq!(
        manifest["methods"]["evolve-metrics"],
        json!(["aggregate", "sweep", "shadow", "record"])
    );

    let (aggregated, reverse) = service.call("a1", "aggregate", json!({"thresholds": {}}));
    assert_eq!(aggregated["kind"], "result", "{aggregated}");
    assert!(aggregated["value"]["evidence"].as_array().unwrap().is_empty());
    let reverse = reverse.expect("aggregate 应委派提供方");
    assert_eq!(reverse["port"], "evolve-evidence");
    assert_eq!(reverse["method"], "aggregate");
    // 调用帧 env 经 bag.__env 转交。
    assert_eq!(reverse["args"]["__env"]["run"], "r1");

    let (swept, reverse) = service.call("s1", "sweep", json!({}));
    assert_eq!(swept["value"]["swept"], 0);
    assert_eq!(reverse.unwrap()["port"], "evolve-sweep");

    let (shadowed, reverse) = service.call("sh1", "shadow", json!({"audit": []}));
    assert_eq!(shadowed["value"]["status"], "unverified");
    assert_eq!(reverse.unwrap()["port"], "evolve-shadow");

    let (recorded, reverse) = service.call(
        "r1",
        "record",
        json!({"user_message_def": {"def": "msg"}, "workspace_id": "w1"}),
    );
    assert_eq!(reverse.unwrap()["port"], "evolve-evidence");
    assert!(recorded["value"].get("evidence_id").is_some());
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
