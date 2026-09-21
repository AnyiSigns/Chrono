// `invoke` 的单元测试：假 fsop 后端记录转发的 bag，覆盖四工具映射 / 路径归类 / 错误与 grant 透传。
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::defaults;
use crate::error::ToolError;
use crate::invoke::invoke;
use crate::port::FsopBackend;

/// 假 fsop 后端的应答函数：按收到的 bag 回结果 / 错误。
type Responder = Box<dyn Fn(&Value) -> Result<Value, ToolError> + Send + Sync>;

/// 假 fsop 后端：记录收到的 bag，并按注入的应答函数回结果 / 错误。
struct FakeFsop {
    calls: Mutex<Vec<Value>>,
    responder: Responder,
}

impl FakeFsop {
    fn new<F>(responder: F) -> Self
    where
        F: Fn(&Value) -> Result<Value, ToolError> + Send + Sync + 'static,
    {
        Self {
            calls: Mutex::new(Vec::new()),
            responder: Box::new(responder),
        }
    }

    fn calls(&self) -> Vec<Value> {
        self.calls.lock().unwrap().clone()
    }
}

impl FsopBackend for FakeFsop {
    fn fsop(&self, bag: &Value) -> Result<Value, ToolError> {
        self.calls.lock().unwrap().push(bag.clone());
        (self.responder)(bag)
    }
}

fn run<F>(bag: Value, responder: F) -> (Value, Vec<Value>)
where
    F: Fn(&Value) -> Result<Value, ToolError> + Send + Sync + 'static,
{
    let backend = FakeFsop::new(responder);
    let result = invoke(&bag, &backend);
    (result, backend.calls())
}

fn ok(value: Value) -> Result<Value, ToolError> {
    Ok(value)
}

#[test]
fn read_maps_to_fsop_read_with_window_defaults() {
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt", "offset": 1},
        "workspace_root": "C:\\ws", "tier": "severe", "caps": {},
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({"text": "hi", "total_lines": 1, "truncated": false}))
    });
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["text"], "hi");
    assert_eq!(result["result"]["total_lines"], 1);
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call["op"], "read");
    assert_eq!(call["path"], "a.txt");
    assert_eq!(call["args"]["offset"], 1);
    assert_eq!(call["args"]["limit"], 2000);
    assert_eq!(call["caps"]["fs"]["read"], "workspace");
    assert_eq!(call["caps"]["fs"]["write"], "none");
    assert_eq!(call["caps"]["timeout_ms"], 30000);
    assert_eq!(call["tier"], "severe");
}

#[test]
fn absolute_outside_declares_full_scope() {
    let bag = json!({
        "tool": "read", "args": {"path": "C:\\other\\a.txt"},
        "workspace_root": "C:\\ws", "tier": "auto",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({"text": "x", "total_lines": 1, "truncated": false}))
    });
    assert_eq!(result["ok"], true);
    assert_eq!(calls[0]["caps"]["fs"]["read"], "full");
}

#[test]
fn bad_path_rejected_without_touching_backend() {
    let bag = json!({
        "tool": "read", "args": {"path": ""}, "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({})));
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"]["code"], "bad_path");
    assert!(calls.is_empty());
}

#[test]
fn relative_without_workspace_is_missing() {
    let bag = json!({"tool": "read", "args": {"path": "a.txt"}});
    let (result, calls) = run(bag, |_| ok(json!({})));
    assert_eq!(result["error"]["code"], "workspace_missing");
    assert!(calls.is_empty());
}

#[test]
fn edit_replace_passes_fsop_diff_through() {
    let bag = json!({
        "tool": "edit", "args": {"path": "a.txt", "old": "a", "new": "b"},
        "workspace_root": "C:\\ws", "tier": "severe",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({"replaced": 1, "added": 1, "removed": 1, "patch": "@@ -1,1 +1,1 @@\n-a\n+b\n"}))
    });
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["replaced"], 1);
    assert_eq!(result["result"]["added"], 1);
    assert_eq!(result["result"]["removed"], 1);
    assert!(result["result"]["patch"].as_str().unwrap().contains("+b"));
    // fsop.replace 不回 bytes_written：本插件按 new 的 UTF-8 字节数合成。
    assert_eq!(result["result"]["bytes_written"], 1);
    assert_eq!(calls[0]["op"], "replace");
    assert_eq!(calls[0]["args"]["old"], "a");
    assert_eq!(calls[0]["args"]["new"], "b");
    assert_eq!(calls[0]["caps"]["fs"]["write"], "workspace");
}

#[test]
fn edit_create_stats_then_writes() {
    let bag = json!({
        "tool": "edit", "args": {"path": "new.txt", "old": "", "new": "hello"},
        "workspace_root": "C:\\ws", "tier": "severe",
    });
    let (result, calls) = run(bag, |call| match call["op"].as_str() {
        Some("stat") => ok(json!({"exists": false, "is_dir": false})),
        _ => ok(json!({"bytes_written": 5, "created": true, "hash": "h"})),
    });
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["created"], true);
    assert_eq!(result["result"]["replaced"], 0);
    assert_eq!(result["result"]["added"], 1);
    assert_eq!(result["result"]["removed"], 0);
    assert_eq!(result["result"]["bytes_written"], 5);
    assert!(result["result"]["patch"]
        .as_str()
        .unwrap()
        .contains("+hello"));
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["op"], "stat");
    assert_eq!(calls[1]["op"], "write");
    assert_eq!(calls[1]["args"]["create"], true);
    assert_eq!(calls[1]["args"]["data"], "hello");
    // 以「当前应为空」的 expected_hash 收口 stat→write 竞态。
    assert_eq!(
        calls[1]["args"]["expected_hash"],
        crate::hash::sha256_hex(b"")
    );
}

#[test]
fn edit_create_passes_sandbox_created_through() {
    let bag = json!({
        "tool": "edit", "args": {"path": "new.txt", "old": "", "new": "hi"},
        "workspace_root": "C:\\ws",
    });
    let (result, _calls) = run(bag, |call| match call["op"].as_str() {
        Some("stat") => ok(json!({"exists": false, "is_dir": false})),
        // 竞态下 sandbox 可能回 created:false（文件已被并发创建）；原样透传。
        _ => ok(json!({"bytes_written": 2, "created": false, "hash": "h"})),
    });
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["created"], false);
    assert_eq!(result["result"]["bytes_written"], 2);
}

#[test]
fn edit_create_conflicts_when_file_exists() {
    let bag = json!({
        "tool": "edit", "args": {"path": "a.txt", "old": "", "new": "x"},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({"exists": true, "is_dir": false})));
    assert_eq!(result["error"]["code"], "edit_conflict");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "stat");
}

#[test]
fn edit_missing_new_is_bad_args() {
    let bag = json!({
        "tool": "edit", "args": {"path": "a.txt", "old": "a"},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({})));
    assert_eq!(result["error"]["code"], "bad_args");
    assert!(calls.is_empty());
}

#[test]
fn glob_maps_path_to_base_and_passes_ignore() {
    let bag = json!({
        "tool": "glob",
        "args": {"pattern": "**/*.rs", "path": "src", "ignore": ["x"]},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({"paths": ["a.rs"], "truncated": false})));
    assert_eq!(result["result"]["paths"], json!(["a.rs"]));
    assert_eq!(calls[0]["op"], "list");
    assert_eq!(calls[0]["args"]["pattern"], "**/*.rs");
    assert_eq!(calls[0]["args"]["base"], "src");
    assert_eq!(calls[0]["args"]["ignore"], json!(["x"]));
    assert_eq!(calls[0]["args"]["limit"], 200);
    assert!(calls[0].get("path").is_none());
}

#[test]
fn glob_uses_default_ignore_when_absent() {
    let bag = json!({
        "tool": "glob", "args": {"pattern": "*"},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"paths": [], "truncated": false})));
    assert_eq!(
        calls[0]["args"]["ignore"],
        json!(defaults::DEFAULT_IGNORE.to_vec())
    );
}

#[test]
fn grep_maps_to_fsop_grep() {
    let bag = json!({
        "tool": "grep",
        "args": {"pattern": "fn", "glob": "*.rs", "path": "src"},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({"matches": [{"path": "a.rs", "line": 1, "text": "fn main"}], "truncated": false}))
    });
    assert_eq!(result["result"]["matches"][0]["text"], "fn main");
    assert_eq!(calls[0]["op"], "grep");
    assert_eq!(calls[0]["args"]["pattern"], "fn");
    assert_eq!(calls[0]["args"]["glob"], "*.rs");
    assert_eq!(calls[0]["args"]["base"], "src");
    assert_eq!(calls[0]["args"]["limit"], 100);
}

#[test]
fn sandbox_error_is_passed_through() {
    let bag = json!({
        "tool": "read", "args": {"path": "C:\\other\\a.txt"},
        "workspace_root": "C:\\ws", "tier": "severe",
    });
    let (result, _calls) = run(bag, |_| {
        Err(ToolError::new(
            "fs_denied",
            "outside workspace denied by tier",
        ))
    });
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"]["code"], "fs_denied");
    assert_eq!(
        result["error"]["message"],
        "outside workspace denied by tier"
    );
}

#[test]
fn edit_conflict_codes_are_passed_through() {
    // 非唯一与 expected_hash 不符都由 sandbox 出 edit_conflict，原码原 message 透传。
    for message in ["old is not unique", "expected_hash mismatch"] {
        let bag = json!({
            "tool": "edit", "args": {"path": "a.txt", "old": "x", "new": "y"},
            "workspace_root": "C:\\ws", "tier": "severe",
        });
        let (result, calls) = run(bag, move |_| Err(ToolError::new("edit_conflict", message)));
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"]["code"], "edit_conflict");
        assert_eq!(result["error"]["message"], message);
        assert_eq!(calls[0]["op"], "replace");
    }
}

#[test]
fn glob_and_grep_outside_path_declare_full_scope() {
    for tool in ["glob", "grep"] {
        let bag = json!({
            "tool": tool,
            "args": {"pattern": "*", "path": "C:\\other"},
            "workspace_root": "C:\\ws", "tier": "auto",
        });
        let (_result, calls) = run(bag, |_| {
            ok(json!({"paths": [], "matches": [], "truncated": false}))
        });
        assert_eq!(calls[0]["caps"]["fs"]["read"], "full", "{tool}");
        assert_eq!(calls[0]["caps"]["fs"]["write"], "none", "{tool}");
    }
}

#[test]
fn read_truncated_is_passed_through() {
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt"},
        "workspace_root": "C:\\ws", "tier": "severe",
    });
    let (result, _calls) = run(bag, |_| {
        ok(json!({"text": "cut", "total_lines": 3, "truncated": true}))
    });
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["truncated"], true);
}

#[test]
fn grant_and_sandbox_tiers_are_forwarded() {
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt"},
        "workspace_root": "C:\\ws", "tier": "severe",
        "grant": {"call_id": "c1", "op": "read"},
        "sandbox_tiers": {"version": 1},
    });
    let (_result, calls) = run(bag, |_| {
        ok(json!({"text": "", "total_lines": 0, "truncated": false}))
    });
    assert_eq!(calls[0]["grant"]["call_id"], "c1");
    assert_eq!(calls[0]["sandbox_tiers"]["version"], 1);
}

#[test]
fn caller_caps_resources_are_kept() {
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt"},
        "workspace_root": "C:\\ws",
        "caps": {"fs": {"read": "full", "write": "full"}, "output_max": 10},
    });
    let (_result, calls) = run(bag, |_| {
        ok(json!({"text": "", "total_lines": 0, "truncated": false}))
    });
    assert_eq!(calls[0]["caps"]["output_max"], 10);
    assert_eq!(calls[0]["caps"]["fs"]["read"], "workspace");
    assert_eq!(calls[0]["caps"]["procs_max"], 1);
}

#[test]
fn unknown_tool_is_rejected() {
    let bag = json!({"tool": "write", "args": {}});
    let (result, calls) = run(bag, |_| ok(json!({})));
    assert_eq!(result["error"]["code"], "unknown_tool");
    assert!(calls.is_empty());
}
