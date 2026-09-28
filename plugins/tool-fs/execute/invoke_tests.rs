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
        ok(json!({
            "text": "hi", "total_lines": 3, "start_line": 2, "end_line": 2,
            "lines_returned": 1, "has_more": true, "next_offset": 2,
            "content_truncated": false, "truncated": true
        }))
    });
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["text"], "hi");
    assert_eq!(result["result"]["total_lines"], 3);
    assert_eq!(result["result"]["start_line"], 2);
    assert_eq!(result["result"]["end_line"], 2);
    assert_eq!(result["result"]["has_more"], true);
    assert_eq!(result["result"]["next_offset"], 2);
    assert_eq!(result["result"]["content_truncated"], false);
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
fn read_rejects_invalid_offset_and_limit() {
    for args in [
        json!({"path": "a.txt", "offset": -1}),
        json!({"path": "a.txt", "offset": "1"}),
        json!({"path": "a.txt", "offset": 1.5}),
        json!({"path": "a.txt", "limit": 0}),
        json!({"path": "a.txt", "limit": -2}),
    ] {
        let bag = json!({"tool": "read", "args": args, "workspace_root": "C:\\ws"});
        let (result, calls) = run(bag, |_| ok(json!({})));
        assert_eq!(result["error"]["code"], "bad_args", "{result}");
        assert!(calls.is_empty(), "{result}");
    }
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
        ok(json!({"replaced": 1, "bytes_written": 1, "added": 1, "removed": 1, "patch": "@@ -1,1 +1,1 @@\n-a\n+b\n"}))
    });
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["replaced"], 1);
    assert_eq!(result["result"]["added"], 1);
    assert_eq!(result["result"]["removed"], 1);
    assert!(result["result"]["patch"].as_str().unwrap().contains("+b"));
    // fsop.replace 回传真实 bytes_written，原样透传。
    assert_eq!(result["result"]["bytes_written"], 1);
    assert_eq!(calls[0]["op"], "replace");
    assert_eq!(calls[0]["args"]["old"], "a");
    assert_eq!(calls[0]["args"]["new"], "b");
    assert_eq!(calls[0]["caps"]["fs"]["write"], "workspace");
}

#[test]
fn edit_replace_all_passes_bytes_written_through() {
    let bag = json!({
        "tool": "edit",
        "args": {"path": "a.txt", "old": "a", "new": "bb", "replace_all": true},
        "workspace_root": "C:\\ws", "tier": "severe",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({"replaced": 3, "bytes_written": 15, "added": 1, "removed": 1, "patch": "@@\n"}))
    });
    assert_eq!(result["result"]["replaced"], 3);
    assert_eq!(result["result"]["bytes_written"], 15);
    assert_eq!(calls[0]["op"], "replace");
}

#[test]
fn glob_rejects_zero_limit() {
    let bag = json!({
        "tool": "glob", "args": {"pattern": "*", "limit": 0},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({"paths": []})));
    assert_eq!(result["error"]["code"], "bad_args");
    assert!(calls.is_empty());
}

#[test]
fn edit_create_writes_once_exclusive() {
    let bag = json!({
        "tool": "edit", "args": {"path": "new.txt", "old": "", "new": "hello"},
        "workspace_root": "C:\\ws", "tier": "severe",
    });
    let (result, calls) = run(bag, |call| match call["op"].as_str() {
        Some("write") => ok(json!({"bytes_written": 5, "created": true, "hash": "h"})),
        _ => ok(json!({})),
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
    // 新建只发一次 write，带 exclusive；不再先 stat。
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "write");
    assert_eq!(calls[0]["args"]["create"], true);
    assert_eq!(calls[0]["args"]["exclusive"], true);
    assert_eq!(calls[0]["args"]["data"], "hello");
}

#[test]
fn edit_create_passes_sandbox_created_through() {
    let bag = json!({
        "tool": "edit", "args": {"path": "new.txt", "old": "", "new": "hi"},
        "workspace_root": "C:\\ws",
    });
    let (result, _calls) = run(bag, |_| {
        // 竞态下 sandbox 可能回 created:false；原样透传。
        ok(json!({"bytes_written": 2, "created": false, "hash": "h"}))
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
    let (result, calls) = run(bag, |_| Err(ToolError::new("edit_conflict", "file already exists")));
    assert_eq!(result["error"]["code"], "edit_conflict");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "write");
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
    assert_eq!(calls[0]["args"]["limit"], 200);
    // 未显式给 mode 时不注入，sandbox 缺省按字面匹配。
    assert!(calls[0]["args"].get("mode").is_none());
}

#[test]
fn grep_forwards_filter_and_context_args() {
    let bag = json!({
        "tool": "grep",
        "args": {"pattern": "x", "ignore_case": true, "files_only": true, "before": 2, "after": 3},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"matches": [], "truncated": false})));
    let args = &calls[0]["args"];
    assert_eq!(args["ignore_case"], true);
    assert_eq!(args["files_only"], true);
    assert_eq!(args["before"], 2);
    assert_eq!(args["after"], 3);
}

#[test]
fn grep_forwards_explicit_mode() {
    let bag = json!({
        "tool": "grep",
        "args": {"pattern": "a|b", "mode": "literal"},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"matches": [], "truncated": false})));
    assert_eq!(calls[0]["args"]["mode"], "literal");
}

#[test]
fn grep_passes_skipped_through() {
    let bag = json!({
        "tool": "grep", "args": {"pattern": "x"},
        "workspace_root": "C:\\ws",
    });
    let (result, _calls) = run(bag, |_| {
        ok(json!({
            "matches": [], "truncated": false,
            "skipped": {"binary": 2, "too_large": 1, "unreadable": 0},
        }))
    });
    assert_eq!(result["result"]["skipped"]["binary"], 2);
    assert_eq!(result["result"]["skipped"]["too_large"], 1);
}

#[test]
fn glob_empty_ignore_means_no_ignore() {
    let bag = json!({
        "tool": "glob", "args": {"pattern": "*", "ignore": []},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"paths": [], "truncated": false})));
    assert_eq!(calls[0]["args"]["ignore"], json!([]));
}

#[test]
fn stat_maps_to_fsop_stat() {
    let bag = json!({
        "tool": "stat", "args": {"path": "a.txt"},
        "workspace_root": "C:\\ws", "tier": "severe",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({"exists": true, "is_dir": false, "size": 3, "mtime": 123}))
    });
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["exists"], true);
    assert_eq!(result["result"]["size"], 3);
    assert_eq!(calls[0]["op"], "stat");
    assert_eq!(calls[0]["path"], "a.txt");
    assert_eq!(calls[0]["caps"]["fs"]["read"], "workspace");
    assert_eq!(calls[0]["caps"]["fs"]["write"], "none");
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

// ── 提供方 digest ───────────────────────────────────────────────────────────

#[test]
fn read_result_carries_digest() {
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt"},
        "workspace_root": "C:\\ws", "tier": "severe",
    });
    let (result, _calls) = run(bag, |_| {
        ok(json!({
            "text": "hi", "total_lines": 2, "start_line": 2, "end_line": 2,
            "lines_returned": 1, "has_more": false, "next_offset": null,
            "content_truncated": false, "truncated": true
        }))
    });
    assert_eq!(result["result"]["digest"]["path"], "a.txt");
    assert_eq!(result["result"]["digest"]["lines"], "2-2");
    assert_eq!(result["result"]["digest"]["summary"], "1 行 / 2B");
    assert_eq!(
        result["result"]["digest"]["sha"],
        "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4"
    );
}

#[test]
fn glob_result_carries_search_digest() {
    let bag = json!({"tool": "glob", "args": {"pattern": "*.rs"}, "workspace_root": "C:\\ws"});
    let (result, _calls) = run(bag, |_| ok(json!({"paths": ["a.rs", "b.rs"], "truncated": false})));
    assert_eq!(result["result"]["digest"]["pattern"], "*.rs");
    assert_eq!(result["result"]["digest"]["hits"], 2);
    assert_eq!(result["result"]["digest"]["files"], 2);
}

#[test]
fn grep_result_digest_counts_hits_and_files() {
    let bag = json!({"tool": "grep", "args": {"pattern": "fn"}, "workspace_root": "C:\\ws"});
    let (result, _calls) = run(bag, |_| {
        ok(json!({"matches": [
            {"path": "a.rs", "line": 1, "text": "fn a"},
            {"path": "a.rs", "line": 4, "text": "fn b"},
            {"path": "b.rs", "line": 2, "text": "fn c"}
        ], "truncated": false}))
    });
    assert_eq!(result["result"]["digest"]["pattern"], "fn");
    assert_eq!(result["result"]["digest"]["hits"], 3);
    assert_eq!(result["result"]["digest"]["files"], 2);
}
