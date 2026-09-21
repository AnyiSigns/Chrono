// `invoke`：把四个工具映射到 `sandbox.fsop`（反向调用），路径归类、结果结构化与 diff 合成在本插件。
// 工具 → fsop op：read→read、edit→replace（old 非空）/ write（old 空且文件不存在，先 stat）、
// glob→list、grep→grep；glob/grep 的 path 映射 fsop.base，ignore 原样传；sandbox 错误原样透传。

use serde_json::{json, Map, Value};

use crate::defaults;
use crate::diff;
use crate::error::ToolError;
use crate::hash;
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

fn limit(args: &Map<String, Value>, fallback: u64) -> u64 {
    args.get("limit")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 忽略表优先级：工具 args.ignore > bag.ignore（身份数据世代 body）> 内置兜底。
fn effective_ignore(bag: &Value, args: &Map<String, Value>) -> Vec<String> {
    let from_args = string_array(args.get("ignore"));
    if !from_args.is_empty() {
        return from_args;
    }
    let from_bag = string_array(bag.get("ignore"));
    if !from_bag.is_empty() {
        return from_bag;
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
    let target = path::classify(required_path(args)?, workspace_root(bag))?;
    let mut fsop_args = Map::new();
    if let Some(offset) = args.get("offset") {
        fsop_args.insert("offset".to_string(), offset.clone());
    }
    fsop_args.insert(
        "limit".to_string(),
        json!(limit(args, defaults::DEFAULT_READ_LIMIT)),
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
    Ok(json!({
        "text": field(&result, "text", json!("")),
        "total_lines": field(&result, "total_lines", json!(0)),
        "truncated": field(&result, "truncated", json!(false)),
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

/// `old` 为空：先 `stat` 判存在，不存在才新建（`old` 非空时走替换）。
/// 新建写带空内容的 `expected_hash`：`fsop.write` 的 `create:true` 对已存在文件会覆盖，
/// 以「当前应为空」为前提收口 `stat` 与 `write` 之间被并发写入非空内容的竞态（不符即 `edit_conflict`）。
fn create_file(
    bag: &Value,
    target: &path::Target,
    new: &str,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let stat = forward(
        bag,
        "stat",
        Some(&target.path),
        target.inside,
        false,
        json!({}),
    );
    let existing = backend.fsop(&stat)?;
    if existing
        .get("exists")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(ToolError::new(
            "edit_conflict",
            "old is empty but the file already exists",
        ));
    }
    let write = forward(
        bag,
        "write",
        Some(&target.path),
        target.inside,
        true,
        json!({
            "data": new,
            "create": true,
            "expected_hash": hash::sha256_hex(b""),
        }),
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

/// `old` 非空：透传 fsop.replace 的 `replaced` / `added` / `removed` / `patch`；
/// `fsop.replace` 不回 `bytes_written`，由本插件按 `new` 的 UTF-8 字节数合成。
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
        "bytes_written": new.len(),
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
        json!(limit(args, defaults::DEFAULT_LIST_LIMIT)),
    );
    let fsop = forward(bag, "list", None, inside, false, Value::Object(fsop_args));
    let result = backend.fsop(&fsop)?;
    Ok(json!({
        "paths": field(&result, "paths", json!([])),
        "truncated": field(&result, "truncated", json!(false)),
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
    fsop_args.insert("ignore".to_string(), json!(effective_ignore(bag, args)));
    fsop_args.insert(
        "limit".to_string(),
        json!(limit(args, defaults::DEFAULT_GREP_LIMIT)),
    );
    let fsop = forward(bag, "grep", None, inside, false, Value::Object(fsop_args));
    let result = backend.fsop(&fsop)?;
    Ok(json!({
        "matches": field(&result, "matches", json!([])),
        "truncated": field(&result, "truncated", json!(false)),
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
