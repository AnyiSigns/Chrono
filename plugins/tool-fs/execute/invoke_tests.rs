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

    fn asset_put(&self, mime: &str, bytes_base64: &str) -> Result<Value, ToolError> {
        self.calls.lock().unwrap().push(json!({
            "op": "host.asset.put", "mime": mime, "bytes": bytes_base64,
        }));
        Ok(json!({
            "kind": "asset", "sha256": "a".repeat(64), "mime": mime, "size": 0,
        }))
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
fn read_batch_lists_then_reads_each_file() {
    let bag = json!({
        "tool": "read",
        "args": {"path": "src", "pattern": "*.rs", "max_files": 5},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |call| match call["op"].as_str().unwrap_or("") {
        "list" => ok(json!({
            "paths": ["a.rs", "b.rs"], "truncated": false, "skipped_count": 1,
        })),
        "read" => ok(json!({
            "text": "x", "total_lines": 1, "start_line": 1, "end_line": 1,
            "lines_returned": 1, "has_more": false, "next_offset": null,
            "content_truncated": false, "truncated": false,
        })),
        other => panic!("unexpected op {other}"),
    });
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["files_returned"], 2, "{result}");
    assert_eq!(result["result"]["files_matched"], 3, "{result}");
    assert_eq!(result["result"]["truncated"], true, "{result}"); // 候选被 max_files 截掉 → 非全量
    assert_eq!(result["result"]["files"][0]["path"], "a.rs");
    assert_eq!(result["result"]["files"][1]["path"], "b.rs");
    assert_eq!(result["result"]["digest"]["pattern"], "*.rs");
    assert_eq!(result["result"]["digest"]["files"], 2);
    assert_eq!(result["result"]["digest"]["matched"], 3);
    // list 带 pattern / base / ignore / limit；read 逐个带拼接后的路径与缺省行窗。
    assert_eq!(calls[0]["op"], "list");
    assert_eq!(calls[0]["args"]["pattern"], "*.rs");
    assert_eq!(calls[0]["args"]["base"], "src");
    assert_eq!(calls[0]["args"]["limit"], 5);
    assert_eq!(calls[1]["op"], "read");
    assert_eq!(calls[1]["path"], "src/a.rs");
    assert_eq!(calls[1]["args"]["limit"], 2000);
    assert_eq!(calls[2]["path"], "src/b.rs");
}

#[test]
fn read_batch_skips_binary_and_warns() {
    let bag = json!({
        "tool": "read", "args": {"path": ".", "pattern": "**/*"},
        "workspace_root": "C:\\ws",
    });
    let (result, _calls) = run(bag, |call| {
        if call["op"] == "list" {
            return ok(json!({"paths": ["a.txt", "bin.dat"], "truncated": false, "skipped_count": 0}));
        }
        if call["path"] == "./bin.dat" {
            return Err(ToolError::new("binary_unsupported", "nul byte"));
        }
        ok(json!({
            "text": "ok", "total_lines": 1, "start_line": 1, "end_line": 1,
            "lines_returned": 1, "has_more": false, "next_offset": null,
            "content_truncated": false, "truncated": false,
        }))
    });
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["files_returned"], 1, "{result}");
    assert_eq!(result["result"]["files"][0]["path"], "a.txt");
    assert_eq!(result["result"]["skipped"]["binary"], 1, "{result}");
    assert_eq!(result["result"]["truncated"], false, "{result}");
    assert!(
        result["result"]["warning"].as_str().unwrap_or("").contains("binary"),
        "binary skip should warn: {result}"
    );
}

#[test]
fn read_preview_defaults_to_50_and_limit_overrides() {
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt", "preview": true},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"text": "x", "preview": true})));
    assert_eq!(calls[0]["args"]["preview"], true);
    assert_eq!(calls[0]["args"]["limit"], 50);
    // 显式 limit 覆盖预览缺省。
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt", "preview": true, "limit": 5},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"text": "x", "preview": true})));
    assert_eq!(calls[0]["args"]["limit"], 5);
    // 非预览仍用 read_limit 缺省。
    let bag = json!({"tool": "read", "args": {"path": "a.txt"}, "workspace_root": "C:\\ws"});
    let (_result, calls) = run(bag, |_| ok(json!({"text": "x", "preview": false})));
    assert!(calls[0]["args"].get("preview").is_none());
    assert_eq!(calls[0]["args"]["limit"], 2000);
}

#[test]
fn read_rejects_invalid_offset_and_limit() {
    for args in [
        json!({"path": "a.txt", "offset": -1}),
        json!({"path": "a.txt", "offset": "1"}),
        json!({"path": "a.txt", "offset": 1.5}),
        json!({"path": "a.txt", "limit": 0}),
        json!({"path": "a.txt", "limit": -2}),
        json!({"path": "src", "pattern": "*", "max_files": 0}),
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
            "matches": [], "truncated": false, "files_scanned": 7,
            "skipped": {"binary": 2, "too_large": 1, "unreadable": 0},
            "warning": "2 binary file(s) skipped (contents not searched)",
        }))
    });
    assert_eq!(result["result"]["skipped"]["binary"], 2);
    assert_eq!(result["result"]["skipped"]["too_large"], 1);
    assert_eq!(result["result"]["files_scanned"], 7);
    assert_eq!(
        result["result"]["warning"],
        "2 binary file(s) skipped (contents not searched)"
    );
}

#[test]
fn grep_forwards_echo_and_hint() {
    let bag = json!({
        "tool": "grep", "args": {"pattern": "TODO|FIXME"},
        "workspace_root": "C:\\ws",
    });
    let (result, _calls) = run(bag, |_| {
        ok(json!({
            "matches": [], "truncated": false,
            "mode": "literal", "base": "C:/ws", "glob": null,
            "ignore": ["node_modules"], "hint": "no matches; searched as literal text",
            "ignored_paths": ["node_modules", "target"], "ignored_paths_truncated": false,
        }))
    });
    assert_eq!(result["result"]["mode"], "literal");
    assert_eq!(result["result"]["base"], "C:/ws");
    assert_eq!(result["result"]["glob"], Value::Null);
    assert_eq!(result["result"]["ignore"], json!(["node_modules"]));
    assert_eq!(result["result"]["ignored_paths"], json!(["node_modules", "target"]));
    assert_eq!(result["result"]["ignored_paths_truncated"], false);
    assert_eq!(result["result"]["hint"], "no matches; searched as literal text");
}

#[test]
fn glob_forwards_tree_depth_and_returns_tree() {
    let bag = json!({
        "tool": "glob",
        "args": {"pattern": "**/*.rs", "tree": true, "depth": 2},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({
            "tree": [
                {
                    "name": "src", "path": "src", "type": "dir",
                    "children": [{ "name": "a.rs", "path": "src/a.rs", "type": "file" }],
                },
            ],
            "truncated": false, "skipped_count": 0,
            "warning": "results truncated: showing 1 of 3 matched paths",
        }))
    });
    assert_eq!(calls[0]["args"]["tree"], true);
    assert_eq!(calls[0]["args"]["depth"], 2);
    assert_eq!(result["result"]["tree"][0]["name"], "src");
    assert_eq!(result["result"]["tree"][0]["children"][0]["type"], "file");
    assert_eq!(result["result"]["paths"], json!([]));
    assert_eq!(result["result"]["warning"], "results truncated: showing 1 of 3 matched paths");
    assert_eq!(result["result"]["digest"]["hits"], 1);
    assert_eq!(result["result"]["digest"]["files"], 1);
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

#[test]
fn read_line_range_maps_to_offset_and_limit() {
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt", "start_line": 3, "end_line": 5},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"text": "x"})));
    assert_eq!(calls[0]["args"]["offset"], 2);
    assert_eq!(calls[0]["args"]["limit"], 3);
    // 只给起始行：offset 起、limit 用缺省。
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt", "start_line": 4},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"text": "x"})));
    assert_eq!(calls[0]["args"]["offset"], 3);
    assert_eq!(calls[0]["args"]["limit"], 2000);
    // 只给结束行：从首行读到该行。
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt", "end_line": 7},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"text": "x"})));
    assert_eq!(calls[0]["args"]["offset"], 0);
    assert_eq!(calls[0]["args"]["limit"], 7);
}

#[test]
fn read_byte_offset_maps_to_byte_window() {
    let bag = json!({
        "tool": "read", "args": {"path": "big.txt", "byte_offset": 4096},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({
            "text": "tail", "encoding": "utf8", "binary": false,
            "byte_offset": 4096, "bytes_returned": 4, "next_byte_offset": 8192,
            "eof": false, "file_bytes": 20000, "lines_returned": 1,
            "start_line": null, "end_line": null, "total_lines": null,
            "has_more": false, "next_offset": null,
            "content_truncated": true, "truncated": true,
        }))
    });
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(calls[0]["op"], "read");
    assert_eq!(calls[0]["args"]["byte_offset"], 4096);
    // 字节模式不注入行窗缺省。
    assert!(calls[0]["args"].get("limit").is_none(), "{calls:?}");
    assert_eq!(result["result"]["byte_offset"], 4096);
    assert_eq!(result["result"]["bytes_returned"], 4);
    assert_eq!(result["result"]["next_byte_offset"], 8192);
    assert_eq!(result["result"]["eof"], false);
    assert_eq!(result["result"]["file_bytes"], 20000);
    assert_eq!(result["result"]["digest"]["byte_offset"], 4096);
    assert_eq!(result["result"]["digest"]["bytes"], 4);
    // 非法 byte_offset → bad_args，不触盘。
    let bag = json!({
        "tool": "read", "args": {"path": "big.txt", "byte_offset": -1},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({})));
    assert_eq!(result["error"]["code"], "bad_args", "{result}");
    assert!(calls.is_empty(), "{result}");
}

#[test]
fn read_rejects_inverted_or_nonpositive_line_range() {
    for args in [
        json!({"path": "a.txt", "start_line": 5, "end_line": 2}),
        json!({"path": "a.txt", "start_line": 0}),
        json!({"path": "a.txt", "end_line": -1}),
    ] {
        let bag = json!({"tool": "read", "args": args, "workspace_root": "C:\\ws"});
        let (result, calls) = run(bag, |_| ok(json!({})));
        assert_eq!(result["error"]["code"], "bad_args", "{result}");
        assert!(calls.is_empty(), "{result}");
    }
}

#[test]
fn stat_lines_counts_when_requested() {
    let bag = json!({
        "tool": "stat", "args": {"path": "a.txt", "lines": true},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({"exists": true, "is_dir": false, "size": 10, "mtime": 1, "lines": 42}))
    });
    assert_eq!(calls[0]["args"]["lines"], true);
    assert_eq!(result["result"]["lines"], 42, "{result}");
}

#[test]
fn stat_batch_aggregates_total_lines() {
    let bag = json!({
        "tool": "stat", "args": {"path": "src", "pattern": "*.rs", "lines": true},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |call| match call["op"].as_str().unwrap_or("") {
        "list" => ok(json!({"paths": ["a.rs", "b.rs"], "truncated": false, "skipped_count": 0})),
        "stat" => {
            let lines = if call["path"] == "src/a.rs" { 10 } else { 5 };
            ok(json!({
                "exists": true, "is_dir": false, "size": 1, "mtime": 1, "lines": lines,
            }))
        }
        other => panic!("unexpected op {other}"),
    });
    assert_eq!(calls[1]["args"]["lines"], true);
    assert_eq!(result["result"]["aggregate"]["total_lines"], 15, "{result}");
    assert_eq!(result["result"]["files"][0]["lines"], 10, "{result}");
    assert_eq!(result["result"]["files"][1]["lines"], 5, "{result}");
}

#[test]
fn stat_batch_lists_then_stats_each_path() {
    let bag = json!({
        "tool": "stat", "args": {"path": "src", "pattern": "*.rs", "max_files": 5},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |call| match call["op"].as_str().unwrap_or("") {
        "list" => ok(json!({"paths": ["a.rs", "b.rs"], "truncated": false, "skipped_count": 1})),
        "stat" => ok(json!({"exists": true, "is_dir": false, "size": 10, "mtime": 100})),
        other => panic!("unexpected op {other}"),
    });
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["files_returned"], 2, "{result}");
    assert_eq!(result["result"]["files_matched"], 3, "{result}");
    assert_eq!(result["result"]["truncated"], true, "{result}");
    assert_eq!(result["result"]["aggregate"]["files"], 2, "{result}");
    assert_eq!(result["result"]["aggregate"]["total_size"], 20, "{result}");
    assert_eq!(result["result"]["aggregate"]["newest_mtime"], 100, "{result}");
    assert_eq!(result["result"]["files"][0]["path"], "a.rs", "{result}");
    assert_eq!(calls[0]["op"], "list");
    assert_eq!(calls[0]["args"]["pattern"], "*.rs");
    assert_eq!(calls[0]["args"]["base"], "src");
    assert_eq!(calls[0]["args"]["limit"], 5);
    assert_eq!(calls[1]["op"], "stat");
    assert_eq!(calls[1]["path"], "src/a.rs");
    assert_eq!(calls[2]["path"], "src/b.rs");
}

#[test]
fn stat_inline_glob_splits_base_and_pattern() {
    let bag = json!({
        "tool": "stat", "args": {"path": "src/**/*.py"},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| {
        ok(json!({"paths": [], "truncated": false, "skipped_count": 0}))
    });
    assert_eq!(calls[0]["op"], "list", "{calls:?}");
    assert_eq!(calls[0]["args"]["base"], "src");
    assert_eq!(calls[0]["args"]["pattern"], "**/*.py");
}

#[test]
fn stat_recursive_forwards_flag_and_returns_aggregate() {
    let bag = json!({
        "tool": "stat", "args": {"path": "src", "recursive": true},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({
            "exists": true, "is_dir": true, "size": 0, "mtime": 1,
            "aggregate": {"files": 2, "dirs": 1, "total_size": 30, "newest_mtime": 9, "oldest_mtime": 1},
        }))
    });
    assert_eq!(calls[0]["op"], "stat");
    assert_eq!(calls[0]["args"]["recursive"], true);
    assert_eq!(result["result"]["aggregate"]["total_size"], 30, "{result}");
}

#[test]
fn glob_exclude_appends_to_ignore() {
    let bag = json!({
        "tool": "glob",
        "args": {"pattern": "*", "ignore": [".git"], "exclude": [".next", "__pycache__"]},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"paths": [], "truncated": false})));
    assert_eq!(
        calls[0]["args"]["ignore"],
        json!([".git", ".next", "__pycache__"])
    );
}

#[test]
fn stat_batch_sorts_and_filters() {
    let bag = json!({
        "tool": "stat",
        "args": {
            "path": "src", "pattern": "*",
            "sort_by": "size", "order": "desc", "min_size": 5,
        },
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |call| match call["op"].as_str().unwrap_or("") {
        "list" => ok(json!({"paths": ["a.txt", "b.txt", "c.txt"], "truncated": false, "skipped_count": 0})),
        "stat" => {
            let size = match call["path"].as_str().unwrap() {
                "src/a.txt" => 3,
                "src/b.txt" => 30,
                _ => 10,
            };
            ok(json!({
                "exists": true, "is_dir": false, "size": size,
                "mtime": size, "ctime": size, "readonly": false,
            }))
        }
        other => panic!("unexpected op {other}"),
    });
    assert_eq!(result["ok"], true, "{result}");
    // min_size=5 过滤掉 a.txt（3B）。
    assert_eq!(result["result"]["files_filtered_out"], 1, "{result}");
    assert_eq!(result["result"]["files_returned"], 2, "{result}");
    assert_eq!(result["result"]["files_matched"], 3, "{result}");
    assert_eq!(result["result"]["sort_by"], "size", "{result}");
    assert_eq!(result["result"]["order"], "desc", "{result}");
    // size 降序：b.txt(30) 在 c.txt(10) 前。
    assert_eq!(result["result"]["files"][0]["path"], "b.txt", "{result}");
    assert_eq!(result["result"]["files"][1]["path"], "c.txt", "{result}");
    assert_eq!(result["result"]["aggregate"]["total_size"], 40, "{result}");
    assert_eq!(calls[0]["op"], "list");
}

#[test]
fn stat_batch_rejects_bad_sort_or_order() {
    for args in [
        json!({"path": "src", "pattern": "*", "sort_by": "ctime"}),
        json!({"path": "src", "pattern": "*", "order": "up"}),
        json!({"path": "src", "pattern": "*", "min_size": -1}),
    ] {
        let bag = json!({"tool": "stat", "args": args, "workspace_root": "C:\\ws"});
        let (result, calls) = run(bag, |_| ok(json!({"paths": [], "truncated": false, "skipped_count": 0})));
        assert_eq!(result["error"]["code"], "bad_args", "{result}");
        assert!(calls.is_empty(), "{result}");
    }
}

#[test]
fn read_format_maps_to_sandbox_encoding() {
    let bag = json!({
        "tool": "read", "args": {"path": "bin.dat", "format": "base64"},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({
            "text": "AAEC", "encoding": "base64", "binary": true,
            "bytes": 3, "content_truncated": false, "truncated": false,
        }))
    });
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(calls[0]["op"], "read");
    assert_eq!(calls[0]["args"]["encoding"], "base64");
    assert_eq!(result["result"]["encoding"], "base64");
    assert_eq!(result["result"]["bytes_read"], 3);
    assert_eq!(result["result"]["binary"], true);
    assert_eq!(result["result"]["digest"]["encoding"], "base64");
    // 批量 + 非 utf8 format → bad_args（不触盘）。
    let bag = json!({
        "tool": "read", "args": {"path": "src", "pattern": "*", "format": "hex"},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({})));
    assert_eq!(result["error"]["code"], "bad_args", "{result}");
    assert!(calls.is_empty(), "{result}");
    // 非法 format → bad_args。
    let bag = json!({
        "tool": "read", "args": {"path": "a.txt", "format": "md5"},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({})));
    assert_eq!(result["error"]["code"], "bad_args", "{result}");
    assert!(calls.is_empty(), "{result}");
}

#[test]
fn read_format_asset_stores_bytes_via_host() {
    let bag = json!({
        "tool": "read",
        "args": {"path": "bin.dat", "format": "asset", "mime": "image/png"},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |call| {
        assert_eq!(call["op"], "read");
        ok(json!({
            "text": "AAEC", "encoding": "base64", "binary": true,
            "bytes": 3, "content_truncated": false, "truncated": false,
        }))
    });
    assert_eq!(result["ok"], true, "{result}");
    // 先按 base64 读原始字节（跨 sandbox 帧），再交 host.asset.put。
    assert_eq!(calls[0]["op"], "read");
    assert_eq!(calls[0]["args"]["encoding"], "base64");
    assert_eq!(calls[1]["op"], "host.asset.put");
    assert_eq!(calls[1]["mime"], "image/png");
    assert_eq!(calls[1]["bytes"], "AAEC");
    assert_eq!(result["result"]["encoding"], "asset");
    assert_eq!(result["result"]["asset"]["kind"], "asset");
    assert_eq!(result["result"]["asset"]["mime"], "image/png");
    assert_eq!(result["result"]["asset"]["sha256"], "a".repeat(64));
    assert_eq!(result["result"]["bytes_read"], 3);
    assert_eq!(result["result"]["digest"]["sha256"], "a".repeat(64));
}

#[test]
fn read_format_asset_defaults_mime_and_rejects_batch() {
    let bag = json!({
        "tool": "read", "args": {"path": "bin.dat", "format": "asset"},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| {
        ok(json!({"text": "", "binary": true, "bytes": 0, "content_truncated": false}))
    });
    assert_eq!(calls[1]["mime"], "application/octet-stream");
    // 批量 + asset → bad_args（不触盘）。
    let bag = json!({
        "tool": "read", "args": {"path": "src", "pattern": "*", "format": "asset"},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| ok(json!({})));
    assert_eq!(result["error"]["code"], "bad_args", "{result}");
    assert!(calls.is_empty(), "{result}");
}

#[test]
fn grep_forwards_binary_flag_and_reports_it() {
    let bag = json!({
        "tool": "grep", "args": {"pattern": "secret", "binary": true},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({
            "matches": [{"path": "b.dat", "line": 1, "text": "secret", "binary": true}],
            "truncated": false, "binary": true,
        }))
    });
    assert_eq!(calls[0]["args"]["binary"], true);
    assert_eq!(result["result"]["binary"], true);
    assert_eq!(result["result"]["matches"][0]["binary"], true);
}

#[test]
fn grep_forwards_any_patterns() {
    let bag = json!({
        "tool": "grep", "args": {"pattern": "alpha", "any": ["beta", "gamma"]},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"matches": [], "truncated": false})));
    assert_eq!(calls[0]["args"]["any"], json!(["beta", "gamma"]));
}

#[test]
fn glob_forwards_min_depth() {
    let bag = json!({
        "tool": "glob", "args": {"pattern": "**/*.rs", "min_depth": 2},
        "workspace_root": "C:\\ws",
    });
    let (_result, calls) = run(bag, |_| ok(json!({"paths": [], "truncated": false})));
    assert_eq!(calls[0]["args"]["min_depth"], 2);
}

#[test]
fn grep_forwards_all_and_stats_and_reports_stats() {
    let bag = json!({
        "tool": "grep",
        "args": {"pattern": "error", "all": ["panic", "fatal"], "stats": true},
        "workspace_root": "C:\\ws",
    });
    let (result, calls) = run(bag, |_| {
        ok(json!({
            "matches": [], "truncated": false,
            "stats": {"files_with_matches": 3, "total_matches": 7},
        }))
    });
    assert_eq!(calls[0]["args"]["all"], json!(["panic", "fatal"]));
    assert_eq!(calls[0]["args"]["stats"], true);
    assert_eq!(result["result"]["stats"]["files_with_matches"], 3, "{result}");
    // digest 取聚合计数（matches 为空时不再为 0）。
    assert_eq!(result["result"]["digest"]["hits"], 7);
    assert_eq!(result["result"]["digest"]["files"], 3);
}
