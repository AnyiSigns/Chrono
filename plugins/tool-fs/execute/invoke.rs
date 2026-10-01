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

/// 读取可选正整数（行号）：缺省 None；给出但非正整数（0 / 负 / 非整型）→ `bad_args`。
fn optional_positive(args: &Map<String, Value>, key: &str) -> Result<Option<u64>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0)
            .map(Some)
            .ok_or_else(|| ToolError::new("bad_args", format!("{key} must be a positive integer"))),
    }
}

/// 把 `start_line` / `end_line`（1 基、闭区间）折成 sandbox 的 `offset` / `limit` 写入：
/// 给出时覆盖 `offset` / `limit`（行范围优先），都未给则不动。`end_line >= start_line`，否则 `bad_args`。
fn apply_line_range(
    args: &Map<String, Value>,
    default_limit: u64,
    fsop_args: &mut Map<String, Value>,
) -> Result<(), ToolError> {
    let start = optional_positive(args, "start_line")?;
    let end = optional_positive(args, "end_line")?;
    if start.is_none() && end.is_none() {
        return Ok(());
    }
    if let (Some(start), Some(end)) = (start, end) {
        if end < start {
            return Err(ToolError::new(
                "bad_args",
                "end_line must be greater than or equal to start_line",
            ));
        }
    }
    let offset = start.map(|value| value - 1).unwrap_or(0);
    let limit = match (start, end) {
        (Some(start), Some(end)) => end - start + 1,
        (Some(_), None) => default_limit,
        (None, Some(end)) => end,
        (None, None) => unreachable!("guarded above"),
    };
    fsop_args.insert("offset".to_string(), json!(offset));
    fsop_args.insert("limit".to_string(), json!(limit));
    Ok(())
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

/// 读取字符串数组参数（非数组 / 缺省 → 空）。
fn args_strings(args: &Map<String, Value>, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
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

/// 读取 `format`：`utf8`（缺省，文本）/ `base64` / `hex`（按原始字节编码，二进制可读）。
fn read_format(args: &Map<String, Value>) -> Result<&'static str, ToolError> {
    match args.get("format").and_then(Value::as_str) {
        None | Some("utf8") => Ok("utf8"),
        Some("base64") => Ok("base64"),
        Some("hex") => Ok("hex"),
        Some(other) => Err(ToolError::new(
            "bad_args",
            format!("format must be utf8|base64|hex, got `{other}`"),
        )),
    }
}

fn read(
    bag: &Value,
    args: &Map<String, Value>,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let path_arg = required_path(args)?;
    let format = read_format(args)?;
    // 给出 `pattern` 即批量模式：`path` 作为目录基准，匹配的文件逐个读取后汇总。
    if let Some(pattern) = args
        .get("pattern")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        if format != "utf8" {
            return Err(ToolError::new(
                "bad_args",
                "format is only supported for single-file read",
            ));
        }
        return read_batch(bag, args, path_arg, pattern, backend);
    }
    let target = path::classify(path_arg, workspace_root(bag))?;
    // 编码读取（base64 / hex）：按原始字节读，行窗 / 预览不适用。
    if format != "utf8" {
        return read_encoded(bag, path_arg, &target, format, backend);
    }
    // `preview:true` 只看开头：缺省行数取 preview_limit（50），显式 `limit` 仍优先。
    let preview = args.get("preview").and_then(Value::as_bool).unwrap_or(false);
    let default_limit = if preview {
        defaults::DEFAULT_PREVIEW_LIMIT
    } else {
        defaults::DEFAULT_READ_LIMIT
    };
    let mut fsop_args = Map::new();
    if let Some(offset) = offset_arg(args)? {
        fsop_args.insert("offset".to_string(), json!(offset));
    }
    if preview {
        fsop_args.insert("preview".to_string(), json!(true));
    }
    fsop_args.insert("limit".to_string(), json!(limit(args, default_limit)?));
    apply_line_range(args, default_limit, &mut fsop_args)?;
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
        "preview": field(&result, "preview", json!(preview)),
        "digest": digest::read_digest(path_arg, start_line, end_line, lines_returned, text),
    }))
}

/// 编码读取（`format:"base64"|"hex"`）：透传 sandbox `encoding`，返回编码文本与原始字节数。
/// 行窗 / `preview` / `offset` 对编码读取无意义，故忽略；整体按 `output_max` 截断。
fn read_encoded(
    bag: &Value,
    path_arg: &str,
    target: &path::Target,
    format: &str,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let mut fsop_args = Map::new();
    fsop_args.insert("encoding".to_string(), json!(format));
    let fsop = forward(
        bag,
        "read",
        Some(&target.path),
        target.inside,
        false,
        Value::Object(fsop_args),
    );
    let result = backend.fsop(&fsop)?;
    let text = result.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    let bytes = result.get("bytes").and_then(Value::as_u64).unwrap_or(0);
    Ok(json!({
        "text": text,
        "encoding": format,
        // 原文件是否二进制（含 NUL / 非合法 UTF-8）；文本文件用 format 编码时为 false。
        "binary": field(&result, "binary", json!(true)),
        "bytes_read": bytes,
        "content_truncated": field(&result, "content_truncated", json!(false)),
        "truncated": field(&result, "truncated", json!(false)),
        "digest": digest::encoded_read_digest(path_arg, format, bytes, &text),
    }))
}

/// 批量读：`path` 为目录基准、`pattern` 过滤，先 `list` 再逐个 `read` 汇总。
/// 单文件 `read` 语义不变（`offset` / `limit` / `preview` 作为**每个文件**的行窗）；
/// 路径按 `list` 的字典序返回（确定性），数量受 `max_files`、总量受 `output_max` 约束。
fn read_batch(
    bag: &Value,
    args: &Map<String, Value>,
    base: &str,
    pattern: &str,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let target = path::classify(base, workspace_root(bag))?;
    let max_files = max_files_limit(args, defaults::DEFAULT_READ_FILES_MAX)?;
    // 先列出候选：字典序、有界；`skipped_count` 是被该上限截掉的数量。
    let mut list_args = Map::new();
    list_args.insert("pattern".to_string(), json!(pattern));
    list_args.insert("base".to_string(), json!(base));
    list_args.insert("ignore".to_string(), json!(effective_ignore(bag, args)));
    list_args.insert("limit".to_string(), json!(max_files));
    let listed = backend.fsop(&forward(
        bag,
        "list",
        None,
        target.inside,
        false,
        Value::Object(list_args),
    ))?;
    let paths: Vec<String> = listed
        .get("paths")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let listed_extra = listed.get("skipped_count").and_then(Value::as_u64).unwrap_or(0) as usize;
    let matched = paths.len() + listed_extra;

    // 每个文件的读参数（行窗 / 预览），复用单文件口径。
    let preview = args.get("preview").and_then(Value::as_bool).unwrap_or(false);
    let mut per_file = Map::new();
    if let Some(offset) = offset_arg(args)? {
        per_file.insert("offset".to_string(), json!(offset));
    }
    if preview {
        per_file.insert("preview".to_string(), json!(true));
    }
    let default_limit = if preview {
        defaults::DEFAULT_PREVIEW_LIMIT
    } else {
        defaults::DEFAULT_READ_LIMIT
    };
    per_file.insert("limit".to_string(), json!(limit(args, default_limit)?));
    apply_line_range(args, default_limit, &mut per_file)?;

    let budget = defaults::DEFAULT_OUTPUT_MAX as usize;
    let mut files = Vec::new();
    let mut used = 0usize;
    // 候选被 `max_files` 截掉时，结果本就不完整。
    let mut truncated = listed_extra > 0;
    let mut skipped_binary = 0usize;
    let mut skipped_too_large = 0usize;
    let mut skipped_unreadable = 0usize;
    for relative in &paths {
        if used >= budget {
            truncated = true;
            break;
        }
        let full = join_path(base, relative);
        let read_bag = forward(
            bag,
            "read",
            Some(&full),
            target.inside,
            false,
            Value::Object(per_file.clone()),
        );
        match backend.fsop(&read_bag) {
            Ok(result) => {
                let text = result.get("text").and_then(Value::as_str).unwrap_or("");
                used += text.len() + relative.len();
                files.push(json!({
                    "path": relative,
                    "text": field(&result, "text", json!("")),
                    "total_lines": field(&result, "total_lines", json!(0)),
                    "start_line": field(&result, "start_line", json!(1)),
                    "end_line": field(&result, "end_line", Value::Null),
                    "lines_returned": field(&result, "lines_returned", json!(0)),
                    "has_more": field(&result, "has_more", json!(false)),
                    "next_offset": field(&result, "next_offset", Value::Null),
                    "content_truncated": field(&result, "content_truncated", json!(false)),
                    "truncated": field(&result, "truncated", json!(false)),
                }));
            }
            // 单个文件读不动（二进制 / 超限 / 不可读 / 拒权）不应中断整批：跳过并在 warning 里计数。
            Err(error) => match error.code.as_str() {
                "binary_unsupported" => skipped_binary += 1,
                "too_large" => skipped_too_large += 1,
                _ => skipped_unreadable += 1,
            },
        }
    }
    let returned = files.len();
    // 结果不完整时在主体给可读警告。
    let mut caveats: Vec<String> = Vec::new();
    if truncated {
        caveats.push(format!(
            "results truncated: returning {returned} of {matched} matched file(s); narrow `pattern` or raise `max_files`"
        ));
    }
    if skipped_binary > 0 {
        caveats.push(format!("{skipped_binary} binary file(s) skipped (contents not returned)"));
    }
    if skipped_too_large > 0 {
        caveats.push(format!("{skipped_too_large} file(s) over output_max skipped"));
    }
    if skipped_unreadable > 0 {
        caveats.push(format!("{skipped_unreadable} file(s) unreadable/denied skipped"));
    }
    let warning = if caveats.is_empty() {
        None
    } else {
        Some(caveats.join("; "))
    };
    Ok(json!({
        "files": files,
        "files_returned": returned,
        "files_matched": matched,
        "truncated": truncated,
        "skipped": {
            "binary": skipped_binary,
            "too_large": skipped_too_large,
            "unreadable": skipped_unreadable,
        },
        "warning": warning,
        "digest": digest::read_many_digest(pattern, returned, matched),
    }))
}

/// 批量基准 + `list` 返回的相对路径拼成 fsop 可解析的路径（统一 `/`，去基准尾部斜杠）。
fn join_path(base: &str, relative: &str) -> String {
    format!("{}/{}", base.trim_end_matches(['/', '\\']), relative)
}

/// 批量查询的文件数上限：缺省 `default`；给出但非正整数 → `bad_args`。
fn max_files_limit(args: &Map<String, Value>, default: u64) -> Result<u64, ToolError> {
    match args.get("max_files") {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0)
            .ok_or_else(|| ToolError::new("bad_args", "max_files must be a positive integer")),
    }
}

/// `path` 是否含 glob 元字符（用于把内联 glob 如 `src/**/*.py` 自动转批量）。
fn has_glob_meta(path: &str) -> bool {
    path.chars().any(|character| matches!(character, '*' | '?' | '[' | '{'))
}

/// 把 `path` 里的内联 glob 拆成（基准目录, 模式）：模式为自首个含元字符的段起的余下部分；
/// 无元字符返回 None。按 `/` 与 `\` 切段后以 `/` 重拼（`Path` 在 Windows 同样接受 `/`）。
fn split_inline_glob(path: &str) -> Option<(String, String)> {
    let segments: Vec<&str> = path.split(['/', '\\']).collect();
    let index = segments
        .iter()
        .position(|segment| has_glob_meta(segment))?;
    let base_segments = &segments[..index];
    // 相对路径且首段即模式（如 `**/*.py`）：以当前目录为基准。
    let base = if base_segments.is_empty() {
        ".".to_string()
    } else {
        base_segments.join("/")
    };
    let pattern = segments[index..].join("/");
    Some((base, pattern))
}

fn stat(
    bag: &Value,
    args: &Map<String, Value>,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let path_arg = required_path(args)?;
    // 批量触发：显式 `pattern`，或 `path` 内联 glob（如 `src/**/*.py`）。
    if let Some(pattern) = args
        .get("pattern")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return stat_batch(bag, args, path_arg, pattern, backend);
    }
    if let Some((base, pattern)) = split_inline_glob(path_arg) {
        return stat_batch(bag, args, &base, &pattern, backend);
    }
    let target = path::classify(path_arg, workspace_root(bag))?;
    let mut fsop_args = Map::new();
    if args.get("recursive").and_then(Value::as_bool) == Some(true) {
        fsop_args.insert("recursive".to_string(), json!(true));
    }
    let fsop = forward(
        bag,
        "stat",
        Some(&target.path),
        target.inside,
        false,
        Value::Object(fsop_args),
    );
    let result = backend.fsop(&fsop)?;
    Ok(json!({
        "exists": field(&result, "exists", json!(false)),
        "is_dir": field(&result, "is_dir", json!(false)),
        "size": field(&result, "size", Value::Null),
        "mtime": field(&result, "mtime", Value::Null),
        // 创建时间（文件系统不支持时为 null）。
        "ctime": field(&result, "ctime", Value::Null),
        // 只读位（跨平台口径，非完整权限审计）。
        "readonly": field(&result, "readonly", Value::Null),
        // `recursive:true` 且为目录时 sandbox 回子树聚合；单路径 / 非递归为 null。
        "aggregate": field(&result, "aggregate", Value::Null),
    }))
}

/// stat 批量的过滤 / 排序参数。
struct StatQuery {
    min_size: Option<u64>,
    max_size: Option<u64>,
    min_mtime: Option<u64>,
    max_mtime: Option<u64>,
    sort_by: String,
    descending: bool,
}

fn optional_u64(args: &Map<String, Value>, key: &str) -> Result<Option<u64>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| ToolError::new("bad_args", format!("{key} must be a non-negative integer"))),
    }
}

fn stat_query(args: &Map<String, Value>) -> Result<StatQuery, ToolError> {
    let sort_by = match args.get("sort_by").and_then(Value::as_str) {
        None => "name".to_string(),
        Some(value @ ("name" | "mtime" | "size")) => value.to_string(),
        Some(other) => {
            return Err(ToolError::new(
                "bad_args",
                format!("sort_by must be name|mtime|size, got `{other}`"),
            ))
        }
    };
    // 缺省：mtime / size 降序（最近 / 最大在前），name 升序（确定性）。
    let descending = match args.get("order").and_then(Value::as_str) {
        None => sort_by != "name",
        Some("desc") => true,
        Some("asc") => false,
        Some(other) => {
            return Err(ToolError::new(
                "bad_args",
                format!("order must be asc|desc, got `{other}`"),
            ))
        }
    };
    Ok(StatQuery {
        min_size: optional_u64(args, "min_size")?,
        max_size: optional_u64(args, "max_size")?,
        min_mtime: optional_u64(args, "min_mtime")?,
        max_mtime: optional_u64(args, "max_mtime")?,
        sort_by,
        descending,
    })
}

/// 批量 stat：`base` 为目录基准、`pattern` 过滤，先 `list` 再逐个 `stat` 汇总元信息。
/// 路径按 `list` 的字典序返回（确定性）；`max_files`（缺省 200）限制条数。
/// 结果含 `aggregate`（文件 / 目录数、总大小、最老最新 mtime），便于目录级审计。
fn stat_batch(
    bag: &Value,
    args: &Map<String, Value>,
    base: &str,
    pattern: &str,
    backend: &dyn FsopBackend,
) -> Result<Value, ToolError> {
    let target = path::classify(base, workspace_root(bag))?;
    // 先解析过滤 / 排序参数：非法即 bad_args，不触盘。
    let query = stat_query(args)?;
    let max_files = max_files_limit(args, defaults::DEFAULT_STAT_FILES_MAX)?;
    let mut list_args = Map::new();
    list_args.insert("pattern".to_string(), json!(pattern));
    list_args.insert("base".to_string(), json!(base));
    list_args.insert("ignore".to_string(), json!(effective_ignore(bag, args)));
    list_args.insert("limit".to_string(), json!(max_files));
    let listed = backend.fsop(&forward(
        bag,
        "list",
        None,
        target.inside,
        false,
        Value::Object(list_args),
    ))?;
    let paths: Vec<String> = listed
        .get("paths")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let listed_extra = listed.get("skipped_count").and_then(Value::as_u64).unwrap_or(0) as usize;
    let matched = paths.len() + listed_extra;

    let mut files = Vec::new();
    let mut skipped_unreadable = 0usize;
    for relative in &paths {
        let full = join_path(base, relative);
        let stat_bag = forward(bag, "stat", Some(&full), target.inside, false, json!({}));
        match backend.fsop(&stat_bag) {
            Ok(result) => {
                files.push(json!({
                    "path": relative,
                    "exists": field(&result, "exists", json!(false)),
                    "is_dir": field(&result, "is_dir", json!(false)),
                    "size": field(&result, "size", Value::Null),
                    "mtime": field(&result, "mtime", Value::Null),
                    "ctime": field(&result, "ctime", Value::Null),
                    "readonly": field(&result, "readonly", Value::Null),
                }));
            }
            // 单个路径查不动（拒权 / 环境）不应中断整批：跳过并计数。
            Err(_) => skipped_unreadable += 1,
        }
    }
    // 过滤：size / mtime 区间；带界条件遇到 null（无该值）即视为不满足。
    let before_filter = files.len();
    files.retain(|entry| {
        let size = entry.get("size").and_then(Value::as_u64);
        let mtime = entry.get("mtime").and_then(Value::as_u64);
        let size_ok = query
            .min_size
            .map(|min| size.map(|value| value >= min).unwrap_or(false))
            .unwrap_or(true)
            && query
                .max_size
                .map(|max| size.map(|value| value <= max).unwrap_or(false))
                .unwrap_or(true);
        let mtime_ok = query
            .min_mtime
            .map(|min| mtime.map(|value| value >= min).unwrap_or(false))
            .unwrap_or(true)
            && query
                .max_mtime
                .map(|max| mtime.map(|value| value <= max).unwrap_or(false))
                .unwrap_or(true);
        size_ok && mtime_ok
    });
    let filtered_out = before_filter - files.len();
    // 排序：name 为字典序（确定性）；mtime / size 取自文件系统，不参与确定性保证（同单路径 stat）。
    files.sort_by(|left, right| {
        let ordering = match query.sort_by.as_str() {
            "mtime" => left
                .get("mtime")
                .and_then(Value::as_u64)
                .cmp(&right.get("mtime").and_then(Value::as_u64)),
            "size" => left
                .get("size")
                .and_then(Value::as_u64)
                .cmp(&right.get("size").and_then(Value::as_u64)),
            _ => left
                .get("path")
                .and_then(Value::as_str)
                .cmp(&right.get("path").and_then(Value::as_str)),
        };
        if query.descending {
            ordering.reverse()
        } else {
            ordering
        }
    });
    // 聚合统计基于过滤后的返回集。
    let (mut file_count, mut dir_count, mut total_size) = (0u64, 0u64, 0u64);
    let (mut newest, mut oldest): (Option<u64>, Option<u64>) = (None, None);
    for entry in &files {
        if entry.get("exists").and_then(Value::as_bool).unwrap_or(false) {
            if entry.get("is_dir").and_then(Value::as_bool).unwrap_or(false) {
                dir_count += 1;
            } else {
                file_count += 1;
            }
        }
        if let Some(size) = entry.get("size").and_then(Value::as_u64) {
            total_size += size;
        }
        if let Some(mtime) = entry.get("mtime").and_then(Value::as_u64) {
            if newest.map(|value| mtime > value).unwrap_or(true) {
                newest = Some(mtime);
            }
            if oldest.map(|value| mtime < value).unwrap_or(true) {
                oldest = Some(mtime);
            }
        }
    }
    let returned = files.len();
    let truncated = listed_extra > 0;
    let mut caveats: Vec<String> = Vec::new();
    if truncated {
        caveats.push(format!(
            "results truncated: returning {returned} of {matched} matched path(s); narrow `pattern` or raise `max_files`"
        ));
    }
    if skipped_unreadable > 0 {
        caveats.push(format!("{skipped_unreadable} path(s) unreadable/denied skipped"));
    }
    let warning = if caveats.is_empty() {
        None
    } else {
        Some(caveats.join("; "))
    };
    Ok(json!({
        "files": files,
        "files_returned": returned,
        "files_matched": matched,
        // 被 size / mtime 过滤掉的条数（非截断，属调用方显式过滤）。
        "files_filtered_out": filtered_out,
        "truncated": truncated,
        "sort_by": query.sort_by,
        "order": if query.descending { "desc" } else { "asc" },
        "aggregate": {
            "files": file_count,
            "dirs": dir_count,
            "total_size": total_size,
            "newest_mtime": newest.map(|value| json!(value)).unwrap_or(Value::Null),
            "oldest_mtime": oldest.map(|value| json!(value)).unwrap_or(Value::Null),
        },
        "skipped": { "unreadable": skipped_unreadable },
        "warning": warning,
        "digest": digest::read_many_digest(pattern, returned, matched),
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
    // `exclude` 追加到忽略表：命中即过滤（目录命中整棵剪枝），与 `ignore` 同语义、可叠加。
    let mut ignore = effective_ignore(bag, args);
    ignore.extend(args_strings(args, "exclude"));
    fsop_args.insert("ignore".to_string(), json!(ignore));
    fsop_args.insert(
        "limit".to_string(),
        json!(limit(args, defaults::DEFAULT_LIST_LIMIT)?),
    );
    // 层级视图 / 深度上限：`depth` 只取相对 base 的路径段数 ≤ 值；`tree` 换层级输出。
    if let Some(depth) = args.get("depth").and_then(Value::as_u64).filter(|value| *value > 0) {
        fsop_args.insert("depth".to_string(), json!(depth));
    }
    // `min_depth` 与 `depth` 组成深度区间（都按相对 base 的路径段数）。
    if let Some(min_depth) = args.get("min_depth").and_then(Value::as_u64).filter(|value| *value > 0) {
        fsop_args.insert("min_depth".to_string(), json!(min_depth));
    }
    if args.get("tree").and_then(Value::as_bool) == Some(true) {
        fsop_args.insert("tree".to_string(), json!(true));
    }
    let fsop = forward(bag, "list", None, inside, false, Value::Object(fsop_args));
    let result = backend.fsop(&fsop)?;
    let hits = match result.get("paths").and_then(Value::as_array) {
        Some(paths) => paths.len(),
        None => count_tree_files(result.get("tree")),
    };
    Ok(json!({
        "paths": field(&result, "paths", json!([])),
        "tree": field(&result, "tree", Value::Null),
        "truncated": field(&result, "truncated", json!(false)),
        "skipped_count": field(&result, "skipped_count", json!(0)),
        "warning": field(&result, "warning", Value::Null),
        "digest": digest::search_digest(pattern, hits, hits),
    }))
}

/// 统计 `tree` 结果里的文件叶节点数（`paths` 缺省时用于摘要口径）。
fn count_tree_files(tree: Option<&Value>) -> usize {
    fn walk(nodes: &[Value]) -> usize {
        nodes
            .iter()
            .map(|node| {
                if node.get("type").and_then(Value::as_str) == Some("file") {
                    1
                } else {
                    node.get("children")
                        .and_then(Value::as_array)
                        .map(|children| walk(children))
                        .unwrap_or(0)
                }
            })
            .sum()
    }
    tree.and_then(Value::as_array).map(|nodes| walk(nodes)).unwrap_or(0)
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
    for key in ["ignore_case", "files_only", "stats", "binary"] {
        if let Some(value) = args.get(key).and_then(Value::as_bool) {
            fsop_args.insert(key.to_string(), json!(value));
        }
    }
    // `all`：附加模式数组，命中行须同时满足 `pattern` 与每个 `all` 模式（AND）。
    let all = args_strings(args, "all");
    if !all.is_empty() {
        fsop_args.insert("all".to_string(), json!(all));
    }
    // `any`：附加模式数组，命中行满足主模式或其中任一即可（OR）。
    let any = args_strings(args, "any");
    if !any.is_empty() {
        fsop_args.insert("any".to_string(), json!(any));
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
    // 命中数 = matches 条数；文件数 = 出现过的不同 path 数（files_only 下逐文件一条）；
    // `stats:true` 时 matches 为空，改取 sandbox 回的聚合计数。
    let (hits, files) = match result.get("stats") {
        Some(stats) if !stats.is_null() => (
            stats.get("total_matches").and_then(Value::as_u64).unwrap_or(0) as usize,
            stats.get("files_with_matches").and_then(Value::as_u64).unwrap_or(0) as usize,
        ),
        _ => match result.get("matches").and_then(Value::as_array) {
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
        },
    };
    Ok(json!({
        "matches": field(&result, "matches", json!([])),
        "truncated": field(&result, "truncated", json!(false)),
        // 审计统计：参与匹配的候选文件数（已过 glob / ignore 过滤）；与 skipped 一起核对扫描完整性。
        "files_scanned": field(&result, "files_scanned", json!(0)),
        "skipped": field(&result, "skipped", json!({})),
        // `stats:true` 时才非空：`{files_with_matches, total_matches}`（不逐条回行）。
        "stats": field(&result, "stats", Value::Null),
        // 生效参数回显 + 字面空返诊断（见 sandbox-fs `op_grep`）：默认缺省时原样透传。
        "mode": field(&result, "mode", json!("literal")),
        // 是否把二进制文件纳入搜索；二进制命中条目带 `binary:true`。
        "binary": field(&result, "binary", json!(false)),
        "base": field(&result, "base", Value::Null),
        "glob": field(&result, "glob", Value::Null),
        "ignore": field(&result, "ignore", json!([])),
        "ignored_paths": field(&result, "ignored_paths", json!([])),
        "ignored_paths_truncated": field(&result, "ignored_paths_truncated", json!(false)),
        "hint": field(&result, "hint", Value::Null),
        "warning": field(&result, "warning", Value::Null),
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
