// `invoke`：把五个工具映射到 `sandbox.fsop`（反向调用），路径归类、结果结构化与 diff 合成在本插件。
// 工具 → fsop op：read→read、edit→replace（old 非空）/ write（old 空且文件不存在，先 stat）、
// glob→list、grep→grep；glob/grep 的 path 映射 fsop.base，ignore 原样传；sandbox 错误原样透传。

use serde_json::{json, Map, Value};

use crate::defaults;
use crate::diff;
use crate::digest;
use crate::error::ToolError;
use crate::path;
use crate::port::FsopBackend;

/// 结果面：成功 `{ok:true, result}`，失败 `{ok:false, error:{code, message}}`。
pub fn invoke(bag: &Value, backend: &dyn FsopBackend) -> Value {
    match dispatch(bag, backend) {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(error) => {
            json!({ "ok": false, "error": { "code": error.code, "message": error.message } })
        }
    }
}

fn dispatch(bag: &Value, backend: &dyn FsopBackend) -> Result<Value, ToolError> {
    let tool = bag.get("tool").and_then(Value::as_str).unwrap_or("");
    let args = match bag.get("args") {
        Some(Value::Object(map)) => map,
        _ => return Err(ToolError::new("bad_args", "invoke args must be an object")),
    };
    match tool {
        "read" => read(bag, args, backend),
        "edit" => edit(bag, args, backend),
        "glob" => glob(bag, args, backend),
        "grep" => grep(bag, args, backend),
        "stat" => stat(bag, args, backend),
        other => Err(ToolError::new(
            "unknown_tool",
            format!("unknown tool {other}"),
        )),
    }
}

// ── 入参提取 ───────────────────────────────────────────────────────────────

fn workspace_root(bag: &Value) -> Option<&str> {
    bag.get("workspace_root").and_then(Value::as_str)
}

fn required_path(args: &Map<String, Value>) -> Result<&str, ToolError> {
    let path = args.get("path").and_then(Value::as_str).unwrap_or("");
    if path.trim().is_empty() {
        return Err(ToolError::new("bad_path", "path required"));
    }
    Ok(path)
}

fn required_text<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("bad_args", format!("{key} must be a string")))
}

fn required_pattern(args: &Map<String, Value>) -> Result<&str, ToolError> {
    let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("");
    if pattern.is_empty() {
        return Err(ToolError::new("bad_args", "pattern required"));
    }
    Ok(pattern)
}

fn optional_base(args: &Map<String, Value>) -> Option<&str> {
    args.get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

/// 解析可选 `limit`：缺省用 fallback；给出但非正整数（0 / 负 / 非整型）→ `bad_args`。
fn limit(args: &Map<String, Value>, fallback: u64) -> Result<u64, ToolError> {
    match args.get("limit") {
        None | Some(Value::Null) => Ok(fallback),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0)
            .ok_or_else(|| ToolError::new("bad_args", "limit must be a positive integer")),
    }
}

/// 解析可选 `offset`：缺省 0；给出但非整型 / 负值 → `bad_args`（越界仍合法，由 sandbox 夹取）。
fn offset_arg(args: &Map<String, Value>) -> Result<Option<u64>, ToolError> {
    match args.get("offset") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| ToolError::new("bad_args", "offset must be a non-negative integer")),
    }
}

/// 忽略表优先级：工具 `args.ignore` > 调用方 `bag.ignore`（本身份数据世代 body）> 内置兜底。
/// **显式空数组**表示「不忽略」（不回落兜底）；键缺省 / 形态非法才回落下一层。
fn effective_ignore(bag: &Value, args: &Map<String, Value>) -> Vec<String> {
    if let Some(items) = args.get("ignore").and_then(Value::as_array) {
        return items.iter().filter_map(Value::as_str).map(str::to_string).collect();
    }
    if let Some(items) = bag.get("ignore").and_then(Value::as_array) {
        return items.iter().filter_map(Value::as_str).map(str::to_string).collect();
    }
    defaults::DEFAULT_IGNORE
        .iter()
        .map(|item| item.to_string())
        .collect()
}

// ── 转发给 sandbox.fsop ────────────────────────────────────────────────────

/// 组装 fsop bag：路径归类只用于声明 `caps.fs.*`（区内 `workspace` / 区外 `full`）。
fn forward(
    bag: &Value,
    op: &str,
    path: Option<&str>,
    inside: bool,
    write_op: bool,
    args: Value,
) -> Value {
    let mut object = Map::new();
    object.insert("op".to_string(), json!(op));
    if let Some(path) = path {
        object.insert("path".to_string(), json!(path));
    }
    object.insert("args".to_string(), args);
    for key in ["tier", "workspace_root"] {
        if let Some(value) = bag.get(key) {
            object.insert(key.to_string(), value.clone());
        }
    }
    for key in ["grant", "sandbox_tiers"] {
        if let Some(value) = bag.get(key) {
            object.insert(key.to_string(), value.clone());
        }
    }
    object.insert("caps".to_string(), caps_for(bag, inside, write_op));
    Value::Object(object)
}

/// 声明 caps：fs 范围按归类覆盖，资源上限沿用调用方 caps 或 schema 缺省。
fn caps_for(bag: &Value, inside: bool, write_op: bool) -> Value {
    let scope = path::scope_for(inside);
    let mut caps = bag
        .get("caps")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let write = if write_op { scope } else { "none" };
    caps.insert("fs".to_string(), json!({ "read": scope, "write": write }));
    caps.entry("net".to_string()).or_insert(json!("none"));
    for (key, value) in [
        ("timeout_ms", defaults::DEFAULT_TIMEOUT_MS),
        ("mem_mb", defaults::DEFAULT_MEM_MB),
        ("output_max", defaults::DEFAULT_OUTPUT_MAX),
        ("procs_max", defaults::DEFAULT_PROCS_MAX),
    ] {
        caps.entry(key.to_string()).or_insert(json!(value));
    }
    Value::Object(caps)
}

fn field(result: &Value, key: &str, fallback: Value) -> Value {
    result.get(key).cloned().unwrap_or(fallback)
}

// ── 四个工具 ───────────────────────────────────────────────────────────────

fn read(
    bag: &Value,
    args: &Map<String, Value>,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let path_arg = required_path(args)?;
    let target = path::classify(path_arg, workspace_root(bag))?;
    let mut fsop_args = Map::new();
    if let Some(offset) = offset_arg(args)? {
        fsop_args.insert("offset".to_string(), json!(offset));
    }
    fsop_args.insert(
        "limit".to_string(),
        json!(limit(args, defaults::DEFAULT_READ_LIMIT)?),
    );
    let fsop = forward(
        bag,
        "read",
        Some(&target.path),
        target.inside,
        false,
        Value::Object(fsop_args),
    );
    let result = backend.fsop(&fsop)?;
    // 摘要取自实际返回窗口：行窗、窗口文本哈希与规模；同输入恒同摘要。
    let start_line = result.get("start_line").and_then(Value::as_u64).unwrap_or(1);
    let end_line = result.get("end_line").and_then(Value::as_u64);
    let lines_returned = result
        .get("lines_returned")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let text = result.get("text").and_then(Value::as_str).unwrap_or("");
    Ok(json!({
        "text": field(&result, "text", json!("")),
        "total_lines": field(&result, "total_lines", json!(0)),
        "start_line": field(&result, "start_line", json!(1)),
        "end_line": field(&result, "end_line", Value::Null),
        "lines_returned": field(&result, "lines_returned", json!(0)),
        "has_more": field(&result, "has_more", json!(false)),
        "next_offset": field(&result, "next_offset", Value::Null),
        "content_truncated": field(&result, "content_truncated", json!(false)),
        "truncated": field(&result, "truncated", json!(false)),
        "digest": digest::read_digest(path_arg, start_line, end_line, lines_returned, text),
    }))
}

fn stat(
    bag: &Value,
    args: &Map<String, Value>,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let target = path::classify(required_path(args)?, workspace_root(bag))?;
    let fsop = forward(
        bag,
        "stat",
        Some(&target.path),
        target.inside,
        false,
        json!({}),
    );
    let result = backend.fsop(&fsop)?;
    Ok(json!({
        "exists": field(&result, "exists", json!(false)),
        "is_dir": field(&result, "is_dir", json!(false)),
        "size": field(&result, "size", Value::Null),
        "mtime": field(&result, "mtime", Value::Null),
    }))
}

fn edit(
    bag: &Value,
    args: &Map<String, Value>,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let target = path::classify(required_path(args)?, workspace_root(bag))?;
    let old = required_text(args, "old")?;
    let new = required_text(args, "new")?;
    if old.is_empty() {
        return create_file(bag, &target, new, backend);
    }
    replace_text(bag, &target, args, old, new, backend)
}

/// `old` 为空：只发一次 `write`，带 `exclusive:true`（目标已存在即 `edit_conflict`）。
/// 独占语义由 sandbox 在写锁内检查 + rename 前复核收口，故无需先 `stat`：新建是单 op，
/// 一次 `caps.grant`（op=write）即可覆盖，区外新建不再被读类 `stat` 拒。
fn create_file(
    bag: &Value,
    target: &path::Target,
    new: &str,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let write = forward(
        bag,
        "write",
        Some(&target.path),
        target.inside,
        true,
        json!({ "data": new, "create": true, "exclusive": true }),
    );
    let result = backend.fsop(&write)?;
    let summary = diff::added_file(new);
    Ok(json!({
        "created": field(&result, "created", json!(true)),
        "replaced": 0,
        "bytes_written": field(&result, "bytes_written", json!(new.len())),
        "added": summary.added,
        "removed": summary.removed,
        "patch": summary.patch,
    }))
}

/// `old` 非空：透传 fsop.replace 的 `replaced` / `bytes_written` / `added` / `removed` / `patch`。
fn replace_text(
    bag: &Value,
    target: &path::Target,
    args: &Map<String, Value>,
    old: &str,
    new: &str,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let mut fsop_args = Map::new();
    fsop_args.insert("old".to_string(), json!(old));
    fsop_args.insert("new".to_string(), json!(new));
    if let Some(replace_all) = args.get("replace_all") {
        fsop_args.insert("replace_all".to_string(), replace_all.clone());
    }
    let fsop = forward(
        bag,
        "replace",
        Some(&target.path),
        target.inside,
        true,
        Value::Object(fsop_args),
    );
    let result = backend.fsop(&fsop)?;
    Ok(json!({
        "replaced": field(&result, "replaced", json!(1)),
        "bytes_written": field(&result, "bytes_written", json!(0)),
        "added": field(&result, "added", json!(0)),
        "removed": field(&result, "removed", json!(0)),
        "patch": field(&result, "patch", json!("")),
    }))
}

fn glob(
    bag: &Value,
    args: &Map<String, Value>,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let pattern = required_pattern(args)?;
    let base = optional_base(args);
    let inside = classify_base(base, bag)?;
    let mut fsop_args = Map::new();
    fsop_args.insert("pattern".to_string(), json!(pattern));
    if let Some(base) = base {
        fsop_args.insert("base".to_string(), json!(base));
    }
    fsop_args.insert("ignore".to_string(), json!(effective_ignore(bag, args)));
    fsop_args.insert(
        "limit".to_string(),
        json!(limit(args, defaults::DEFAULT_LIST_LIMIT)?),
    );
    let fsop = forward(bag, "list", None, inside, false, Value::Object(fsop_args));
    let result = backend.fsop(&fsop)?;
    let hits = result
        .get("paths")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    Ok(json!({
        "paths": field(&result, "paths", json!([])),
        "truncated": field(&result, "truncated", json!(false)),
        "digest": digest::search_digest(pattern, hits, hits),
    }))
}

fn grep(
    bag: &Value,
    args: &Map<String, Value>,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let pattern = required_pattern(args)?;
    let base = optional_base(args);
    let inside = classify_base(base, bag)?;
    let mut fsop_args = Map::new();
    fsop_args.insert("pattern".to_string(), json!(pattern));
    if let Some(glob) = args
        .get("glob")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        fsop_args.insert("glob".to_string(), json!(glob));
    }
    if let Some(base) = base {
        fsop_args.insert("base".to_string(), json!(base));
    }
    // `mode:"literal"|"regex"` 决定匹配语义；不注入时由 sandbox 缺省按字面匹配（regex 结构不支持则回 bad_args）。
    if let Some(mode) = args
        .get("mode")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        fsop_args.insert("mode".to_string(), json!(mode));
    }
    for key in ["ignore_case", "files_only"] {
        if let Some(value) = args.get(key).and_then(Value::as_bool) {
            fsop_args.insert(key.to_string(), json!(value));
        }
    }
    // 上下文行数：sandbox 侧再夹上限（before/after ≤ 20）。
    for key in ["before", "after"] {
        if let Some(value) = args.get(key).and_then(Value::as_u64).filter(|v| *v > 0) {
            fsop_args.insert(key.to_string(), json!(value));
        }
    }
    fsop_args.insert("ignore".to_string(), json!(effective_ignore(bag, args)));
    fsop_args.insert(
        "limit".to_string(),
        json!(limit(args, defaults::DEFAULT_GREP_LIMIT)?),
    );
    let fsop = forward(bag, "grep", None, inside, false, Value::Object(fsop_args));
    let result = backend.fsop(&fsop)?;
    // 命中数 = matches 条数；文件数 = 出现过的不同 path 数（files_only 下逐文件一条）。
    let (hits, files) = match result.get("matches").and_then(Value::as_array) {
        Some(items) => {
            let mut paths = std::collections::BTreeSet::new();
            for item in items {
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    paths.insert(path);
                }
            }
            (items.len(), paths.len())
        }
        None => (0, 0),
    };
    Ok(json!({
        "matches": field(&result, "matches", json!([])),
        "truncated": field(&result, "truncated", json!(false)),
        "skipped": field(&result, "skipped", json!({})),
        "digest": digest::search_digest(pattern, hits, files),
    }))
}

/// glob / grep 的基准目录：给了 `path` 就归类它，缺省即 workspace_root（区外需显式绝对路径）。
fn classify_base(base: Option<&str>, bag: &Value) -> Result<bool, ToolError> {
    match base {
        Some(base) => Ok(path::classify(base, workspace_root(bag))?.inside),
        None => match workspace_root(bag).filter(|root| !root.trim().is_empty()) {
            Some(_) => Ok(true),
            None => Err(ToolError::new(
                "workspace_missing",
                "glob/grep without path requires workspace_root",
            )),
        },
    }
}
