// 集成测试：黑盒经服务协议驱动真实二进制（hello / manifest / 四方法），
// 并直接调用库面断言 shadow 三态与确定性。`cargo test` 一并运行。
// 用 `test/`（非 cargo 缺省 `tests/`），由 Cargo.toml 的 `[[test]] path` 显式声明。

use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

use evolve_metrics::frames::{read_frame, write_frame};

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

    fn call(&mut self, id: &str, method: &str, args: Value) -> Value {
        self.send(&json!({
            "v": "1", "id": id, "kind": "call",
            "port": "evolve-metrics", "method": method, "args": args,
            "env": {"run": "r1", "thread": null, "now": 42},
        }));
        loop {
            let message = self.recv();
            if message.get("id").and_then(Value::as_str) == Some(id) {
                return message;
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

fn evolution_body() -> Value {
    json!({
        "version": 1,
        "trace": {"tail": null, "count": 0},
        "evidence": {"tail": null, "count": 0},
        "proposals": {"tail": null, "count": 0},
        "verdicts": {"tail": null, "count": 0}
    })
}

#[test]
fn protocol_handshake_and_four_methods() {
    let mut service = Service::spawn();
    service.send(&json!({"v":"1","id":"h","kind":"hello","impl":"evolve-metrics"}));
    let manifest = service.recv();
    assert_eq!(manifest["kind"], "manifest");
    assert_eq!(manifest["identity"], "evolve-metrics");
    assert_eq!(
        manifest["methods"]["evolve-metrics"],
        json!(["aggregate", "sweep", "shadow", "record"])
    );

    // aggregate：空轨迹 → 空集、无写计划。
    let empty = service.call("a1", "aggregate", json!({}));
    assert_eq!(empty["kind"], "result", "{empty}");
    assert!(empty["value"]["evidence"].as_array().unwrap().is_empty());
    assert!(empty["value"]["$directives"].as_array().unwrap().is_empty());

    // aggregate：一条 graph 归因拒绝 → 一条 failure_cluster 证据 + 写计划。
    let bag = json!({
        "trace_entries": [{"kind":"trace","run":"r1","workspace_id":"w1","outcome":"refused",
            "refused_at":{"node_index":1,"code":"capability_mismatch","attributable_to":"graph"}}],
        "thresholds": {"failure_cluster_n": 1},
        "evolution": evolution_body()
    });
    let aggregated = service.call("a2", "aggregate", bag);
    assert_eq!(aggregated["value"]["evidence"][0]["class"], "failure_cluster");
    assert!(!aggregated["value"]["$directives"].as_array().unwrap().is_empty());

    // record：产 user_request 证据。
    let recorded = service.call(
        "r1",
        "record",
        json!({"user_message_def": {"def": "msg"}, "workspace_id": "w1", "evolution": evolution_body()}),
    );
    assert!(recorded["value"]["evidence_id"].as_str().unwrap().starts_with("ev-"));
    assert!(!recorded["value"]["$directives"].as_array().unwrap().is_empty());

    // sweep：不动被 verdict 引用的轨迹。
    let swept = service.call(
        "s1",
        "sweep",
        json!({
            "trace_entries": [
                {"kind":"trace","run":"old","workspace_id":"w1","outcome":"done"},
                {"kind":"trace","run":"new","workspace_id":"w1","outcome":"done"}
            ],
            "thresholds": {"trace_retention_rounds": 1},
            "evolution": evolution_body()
        }),
    );
    assert_eq!(swept["value"]["swept"], 1);
    assert_eq!(swept["value"]["retained"], 1);

    // shadow：无期望 eff → unverified（fail-closed）。audit 直接给空表，避免反向调用等待。
    let shadowed = service.call("sh1", "shadow", json!({"audit": []}));
    assert_eq!(shadowed["value"]["status"], "unverified");
}

#[test]
fn shadow_three_states() {
    use evolve_metrics::shadow::{evaluate, AuditRecord, EffKey, EffRecord};
    let key = EffKey {
        port: "model".to_string(),
        method: "chat".to_string(),
        args_hash: Some("a1".to_string()),
    };
    let ok = EffRecord {
        port: "model".to_string(),
        method: "chat".to_string(),
        args_hash: Some("a1".to_string()),
        result_hash: Some("r1".to_string()),
        outcome: "ok".to_string(),
    };
    assert_eq!(
        evaluate(std::slice::from_ref(&key), std::slice::from_ref(&ok), &[]).0,
        "pass"
    );
    let mut other = ok.clone();
    other.result_hash = Some("r2".to_string());
    assert_eq!(
        evaluate(std::slice::from_ref(&key), &[ok.clone(), other], &[]).0,
        "fail"
    );
    assert_eq!(evaluate(std::slice::from_ref(&key), &[], &[]).0, "unverified");
    // audit 补充：无 eff_log 时按 (port,method) 兜底。
    let audit = vec![AuditRecord {
        port: "model".to_string(),
        method: "chat".to_string(),
        outcome: "ok".to_string(),
    }];
    assert_eq!(
        evaluate(std::slice::from_ref(&key), &[], &audit).0,
        "pass"
    );
}

#[test]
fn aggregate_is_deterministic() {
    use evolve_metrics::aggregate::run as aggregate;
    use evolve_metrics::port::CapturingEventSink;
    use evolve_metrics::state::MemoryStateStore;
    let bag = json!({
        "trace_entries": [
            {"kind":"trace","run":"r1","workspace_id":"w1","outcome":"refused",
             "refused_at":{"node_index":1,"code":"capability_mismatch","attributable_to":"graph"}},
            {"kind":"trace","run":"r2","workspace_id":"w1","outcome":"refused",
             "refused_at":{"node_index":1,"code":"capability_mismatch","attributable_to":"graph"}}
        ],
        "thresholds": {"failure_cluster_n": 2, "unhealthy_refused_streak": 2},
        "evolution": evolution_body()
    });
    let events_a = CapturingEventSink::new();
    let events_b = CapturingEventSink::new();
    let state_a = MemoryStateStore::new();
    let state_b = MemoryStateStore::new();
    let first = aggregate(&bag, &json!({"now": 7}), &events_a, &state_a).unwrap();
    let second = aggregate(&bag, &json!({"now": 7}), &events_b, &state_b).unwrap();
    assert_eq!(first, second);
    // 最近连续 refused 达阈 → 发 orchestration.unhealthy。
    assert_eq!(events_a.events().len(), 1);
    assert_eq!(events_a.events()[0].0, "orchestration.unhealthy");
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
