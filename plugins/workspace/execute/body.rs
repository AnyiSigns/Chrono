// workspace 能力类的纯逻辑面：workspaces body 解析 / list 标注 / add 校验与写计划 / remove 写计划。
// 服务不读投影、无写通道：当前 workspaces body、输入槽体与 thread_id 全由调用方随 args 传入，
// 本模块只产出结果值与写计划（`{"$directives":[…]}`），不落账、不读 ctx、不取时间。

use std::io;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// 缺省线程键（per-thread 键控：清槽只清本键）。
pub const MAIN_THREAD: &str = "_main";

/// 文件系统抽象：把 realpath / 目录判定 / 可读性分层，便于测试注入权限错误等边界。
pub trait Fs {
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf>;
    fn is_dir(&self, path: &Path) -> io::Result<bool>;
    fn is_readable_dir(&self, path: &Path) -> io::Result<()>;
}

/// 真实文件系统实现。
pub struct RealFs;

impl Fs for RealFs {
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        std::fs::canonicalize(path)
    }

    fn is_dir(&self, path: &Path) -> io::Result<bool> {
        Ok(std::fs::metadata(path)?.is_dir())
    }

    fn is_readable_dir(&self, path: &Path) -> io::Result<()> {
        std::fs::read_dir(path).map(|_| ())
    }
}

/// add 校验失败的结构化原因（extern 回 UI）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AddError {
    PathNotFound,
    NotADirectory,
    PermissionDenied,
    /// realpath 已在列表：带上既有 workspace id，UI 可直接定位。
    WorkspaceExists(String),
}

impl AddError {
    pub fn code(&self) -> &'static str {
        match self {
            AddError::PathNotFound => "path_not_found",
            AddError::NotADirectory => "not_a_directory",
            AddError::PermissionDenied => "permission_denied",
            AddError::WorkspaceExists(_) => "workspace_exists",
        }
    }

    /// extern 载荷：`{ok:false,error[,workspace]}`。
    pub fn payload(&self) -> Value {
        match self {
            AddError::WorkspaceExists(id) => {
                json!({ "ok": false, "error": self.code(), "workspace": id })
            }
            _ => json!({ "ok": false, "error": self.code() }),
        }
    }
}

/// io 错误 → 校验错误：NotFound / PermissionDenied 直映，其余按「无法确认存在」收口。
pub fn map_io_error(err: &io::Error) -> AddError {
    match err.kind() {
        io::ErrorKind::NotFound => AddError::PathNotFound,
        io::ErrorKind::PermissionDenied => AddError::PermissionDenied,
        _ => AddError::PathNotFound,
    }
}

/// 写类命令的当前 workspaces body：必须显式传入（`args.body.workspaces` 或 `args.workspaces`）。
/// 缺失即 `bad_args`——缺省空对象会产出清空既有工作区的计划，是破坏性写。
fn require_body(args: &Value) -> Result<Value, (String, String)> {
    if args.get("body").and_then(|body| body.get("workspaces")).is_some() {
        return Ok(args["body"].clone());
    }
    if args.get("workspaces").is_some() {
        return Ok(args.clone());
    }
    Err(bad_args("missing workspaces body"))
}

/// 输入 body（整份 slots）：必须显式传入 `args.slots.slots`；缺失即 `bad_args`。
fn require_slots(args: &Value) -> Result<Value, (String, String)> {
    match args.get("slots") {
        Some(body) if body.get("slots").is_some() => Ok(body.clone()),
        _ => Err(bad_args("missing slots body")),
    }
}

/// workspaces 数组：`args.workspaces` 或 `args.body.workspaces`；缺失返回空切片。
pub fn workspaces_of(args: &Value) -> &[Value] {
    if let Some(Value::Array(list)) = args.get("workspaces") {
        return list.as_slice();
    }
    if let Some(Value::Array(list)) = args.get("body").and_then(|body| body.get("workspaces")) {
        return list.as_slice();
    }
    &[]
}

/// 线程键：`args.thread_id` 非空字符串，否则 `_main`。
pub fn thread_key(args: &Value) -> String {
    args.get("thread_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(MAIN_THREAD)
        .to_string()
}

/// 本线程槽体：`args.slot` 优先；否则 `args.kind` 本身即槽体；否则从 `args.slots.slots[thread]` 取。
pub fn slot_of(args: &Value) -> Option<&Value> {
    if let Some(slot) = args.get("slot") {
        if !slot.is_null() {
            return Some(slot);
        }
    }
    if matches!(
        args.get("kind").and_then(Value::as_str),
        Some("workspace.add") | Some("workspace.remove")
    ) {
        return Some(args);
    }
    let thread = thread_key(args);
    args.get("slots")?.get("slots")?.get(thread)
}

/// 清槽：per-thread 键控——只把本线程键置 `{kind:'idle'}`，其余键原样保留。
pub fn clear_slots(slots_body: &Value, thread: &str) -> Value {
    let mut root = slots_body.as_object().cloned().unwrap_or_default();
    let mut slots = root
        .get("slots")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    slots.insert(thread.to_string(), json!({ "kind": "idle" }));
    root.insert("slots".to_string(), Value::Object(slots));
    Value::Object(root)
}

/// 路径末段（name 缺省）；无末段（如盘根）回落整串。
pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string())
}

/// 归一 `\\?\` / `\\?\UNC\` 前缀（canonicalize 在 win32 上带 verbatim 前缀）。
pub fn normalize_canonical(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text
    }
}

/// 同一路径判定：win32 大小写不敏感、分隔符归一、忽略尾分隔符。
pub fn same_path(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        let norm = |text: &str| {
            text.replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase()
        };
        norm(left) == norm(right)
    }
    #[cfg(not(windows))]
    {
        let norm = |text: &str| text.trim_end_matches('/').to_string();
        norm(left) == norm(right)
    }
}

/// add 校验：realpath 解析 → 存在 / 是目录 / 可读 → 按 realpath 去重；通过返回归一后的 realpath。
pub fn validate_add(fs: &dyn Fs, path: &str, workspaces: &[Value]) -> Result<String, AddError> {
    let canonical = fs
        .canonicalize(Path::new(path))
        .map_err(|err| map_io_error(&err))?;
    let canonical_text = normalize_canonical(&canonical);
    match fs.is_dir(&canonical) {
        Ok(true) => {}
        Ok(false) => return Err(AddError::NotADirectory),
        Err(err) => return Err(map_io_error(&err)),
    }
    fs.is_readable_dir(&canonical)
        .map_err(|err| map_io_error(&err))?;
    for existing in workspaces {
        let Some(existing_path) = existing.get("path").and_then(Value::as_str) else {
            continue;
        };
        let existing_real = fs
            .canonicalize(Path::new(existing_path))
            .map(|resolved| normalize_canonical(&resolved))
            .unwrap_or_else(|_| existing_path.to_string());
        if same_path(&existing_real, &canonical_text) {
            let id = existing
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            return Err(AddError::WorkspaceExists(id));
        }
    }
    Ok(canonical_text)
}

/// 目标工作区路径（reveal 用）：按 id 在 body 里线性查找。
pub fn workspace_path(args: &Value, id: &str) -> Option<String> {
    workspaces_of(args)
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|item| item.get("path").and_then(Value::as_str))
        .map(str::to_string)
}

/// `list`：逐路径 stat，`missing` = 不存在 / 非目录（stat 失败按 missing 收口，不阻塞其它项）。
pub fn list_value(args: &Value, fs: &dyn Fs) -> Value {
    let items: Vec<Value> = workspaces_of(args)
        .iter()
        .map(|item| {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            let path = item.get("path").and_then(Value::as_str).unwrap_or("");
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| basename(path));
            let missing = !fs.is_dir(Path::new(path)).unwrap_or(false);
            json!({ "id": id, "name": name, "path": path, "missing": missing })
        })
        .collect();
    Value::Array(items)
}

fn put_op(body: Value) -> Value {
    json!({ "op": "put", "args": { "body": body } })
}

/// 单条 add_gen：payload / sig 指向同批更早的 put（`$n` 0 基、四字段全必填）；`base` 存在即补丁世代。
fn add_gen_op(id: &str, index: usize, base: Option<u64>) -> Value {
    let mut args = json!({
        "id": id, "payload": { "$n": index }, "sig": { "$n": index }, "pins": {}
    });
    if let Some(base) = base {
        args["base"] = json!(base);
    }
    json!({ "op": "add_gen", "args": args })
}

/// `data_gen.seq`（非负整数）；缺失 / 非法回 None。
fn data_gen_seq(value: Option<&Value>) -> Option<u64> {
    value.and_then(|gen| gen.get("seq")).and_then(Value::as_u64)
}

/// 顶层字段补丁：变者 replace、缺者 delete；不变者不产 op。
fn top_level_patches(prev: &Value, next: &Value) -> Vec<Value> {
    let mut ops = Vec::new();
    if let (Some(prev_obj), Some(next_obj)) = (prev.as_object(), next.as_object()) {
        for (key, value) in next_obj {
            if prev_obj.get(key) != Some(value) {
                ops.push(json!({ "op": "replace", "path": [key], "value": value }));
            }
        }
        for key in prev_obj.keys() {
            if !next_obj.contains_key(key) {
                ops.push(json!({ "op": "delete", "path": [key] }));
            }
        }
    }
    ops
}

/// 输入槽补丁：按线程键 `replace ["slots", key]` / `delete ["slots", key]`。
fn slot_patches(prev: &Value, next: &Value) -> Vec<Value> {
    let mut ops = Vec::new();
    if let (Some(prev_slots), Some(next_slots)) = (
        prev.get("slots").and_then(Value::as_object),
        next.get("slots").and_then(Value::as_object),
    ) {
        for (key, value) in next_slots {
            if prev_slots.get(key) != Some(value) {
                ops.push(json!({ "op": "replace", "path": ["slots", key], "value": value }));
            }
        }
        for key in prev_slots.keys() {
            if !next_slots.contains_key(key) {
                ops.push(json!({ "op": "delete", "path": ["slots", key] }));
            }
        }
    }
    ops
}

/// 追加数据 body 写：有 base 且补丁非空 → put(补丁) + add_gen(base)；否则整份 put + add_gen。
fn push_body_gen(ops: &mut Vec<Value>, id: &str, prev: &Value, next: Value, base: Option<u64>) {
    let index = ops.len();
    if let Some(base) = base {
        let patches = top_level_patches(prev, &next);
        if !patches.is_empty() {
            ops.push(put_op(json!({ "ops": patches })));
            ops.push(add_gen_op(id, index, Some(base)));
            return;
        }
    }
    ops.push(put_op(next));
    ops.push(add_gen_op(id, index, None));
}

/// 追加输入清槽写：有 base 且槽有变化 → put(slots 补丁) + add_gen(base)；否则整份 put + add_gen。
fn push_input_gen(ops: &mut Vec<Value>, prev: &Value, next: Value, base: Option<u64>) {
    let index = ops.len();
    if let Some(base) = base {
        let patches = slot_patches(prev, &next);
        if !patches.is_empty() {
            ops.push(put_op(json!({ "ops": patches })));
            ops.push(add_gen_op("input", index, Some(base)));
            return;
        }
    }
    ops.push(put_op(next));
    ops.push(add_gen_op("input", index, None));
}

fn batch_directive(ops: Vec<Value>) -> Value {
    json!({ "kind": "write", "request": { "op": "batch", "args": { "ops": ops } } })
}

fn extern_directive(payload: Value) -> Value {
    json!({ "kind": "extern", "payload": payload })
}

/// 一条 batch + 一条 extern 的计划值。
fn plan(ops: Vec<Value>, payload: Value) -> Value {
    json!({ "$directives": [batch_directive(ops), extern_directive(payload)] })
}

fn bad_args(message: &str) -> (String, String) {
    ("bad_args".to_string(), message.to_string())
}

/// 把 workspaces 列表写回 body（保留 body 其它键）。
fn set_workspaces(body: &mut Value, list: Vec<Value>) {
    if !body.is_object() {
        *body = json!({ "version": 1, "workspaces": [] });
    }
    if let Some(object) = body.as_object_mut() {
        object.insert("workspaces".to_string(), Value::Array(list));
    }
}

/// `add`：校验通过 → 合并后 body + add_gen(workspace) + 清槽 + add_gen(input) + extern{ok,workspace}；
/// 失败 → 清槽两条 + extern{ok:false,error}（无论成败都清槽）。
pub fn add_plan(args: &Value, fs: &dyn Fs) -> Result<Value, (String, String)> {
    let thread = thread_key(args);
    let slot = slot_of(args).ok_or_else(|| bad_args("missing workspace.add slot"))?;
    if slot.get("kind").and_then(Value::as_str) != Some("workspace.add") {
        return Err(bad_args("slot kind is not workspace.add"));
    }
    let id = slot
        .get("workspace")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_args("workspace id is required"))?
        .to_string();
    let path = slot
        .get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_args("path is required"))?
        .to_string();
    let name_arg = slot
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut body = require_body(args)?;
    let slots = require_slots(args)?;
    let workspaces: Vec<Value> = body
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // id 唯一性：重复 id 会生成重复条目（realpath 去重不覆盖此情形）。
    if workspaces
        .iter()
        .any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        let idle = clear_slots(&slots, &thread);
        let mut ops = Vec::new();
        push_input_gen(&mut ops, &slots, idle, data_gen_seq(args.get("slots_data_gen")));
        return Ok(plan(ops, AddError::WorkspaceExists(id).payload()));
    }

    match validate_add(fs, &path, &workspaces) {
        Ok(real) => {
            let name = name_arg.unwrap_or_else(|| basename(&real));
            let mut list = workspaces;
            list.push(json!({ "id": id, "name": name, "path": real }));
            let prev_body = body.clone();
            set_workspaces(&mut body, list);
            let idle = clear_slots(&slots, &thread);
            let mut ops = Vec::new();
            push_body_gen(
                &mut ops,
                "workspace",
                &prev_body,
                body,
                data_gen_seq(args.get("body_data_gen")),
            );
            push_input_gen(&mut ops, &slots, idle, data_gen_seq(args.get("slots_data_gen")));
            Ok(plan(ops, json!({ "ok": true, "workspace": id })))
        }
        Err(err) => {
            let idle = clear_slots(&slots, &thread);
            let mut ops = Vec::new();
            push_input_gen(&mut ops, &slots, idle, data_gen_seq(args.get("slots_data_gen")));
            Ok(plan(ops, err.payload()))
        }
    }
}

/// `remove`：删该项的新 body + add_gen(workspace) + 清槽 + add_gen(input) + extern。
/// 目标 id 不在列表时为幂等成功（body 不变、命中 dup 短路），`removed:false`。
pub fn remove_plan(args: &Value) -> Result<Value, (String, String)> {
    let thread = thread_key(args);
    let slot = slot_of(args).ok_or_else(|| bad_args("missing workspace.remove slot"))?;
    if slot.get("kind").and_then(Value::as_str) != Some("workspace.remove") {
        return Err(bad_args("slot kind is not workspace.remove"));
    }
    let id = slot
        .get("workspace")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_args("workspace id is required"))?
        .to_string();

    let mut body = require_body(args)?;
    let slots = require_slots(args)?;
    let list = body
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let before = list.len();
    let filtered: Vec<Value> = list
        .into_iter()
        .filter(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .collect();
    let removed = filtered.len() < before;
    let prev_body = body.clone();
    set_workspaces(&mut body, filtered);
    let idle = clear_slots(&slots, &thread);
    let mut ops = Vec::new();
    push_body_gen(
        &mut ops,
        "workspace",
        &prev_body,
        body,
        data_gen_seq(args.get("body_data_gen")),
    );
    push_input_gen(&mut ops, &slots, idle, data_gen_seq(args.get("slots_data_gen")));
    Ok(plan(
        ops,
        json!({ "ok": true, "workspace": id, "removed": removed }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "chrono-workspace-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn body_with(entries: Vec<Value>) -> Value {
        json!({ "version": 1, "workspaces": entries })
    }

    fn add_args(id: &str, path: &str, name: Option<&str>, body: &Value) -> Value {
        let mut slot = json!({ "kind": "workspace.add", "workspace": id, "path": path });
        if let Some(name) = name {
            slot["name"] = json!(name);
        }
        json!({
            "slot": slot,
            "body": body,
            "slots": { "slots": { "_main": { "kind": "idle" }, "other": { "kind": "chat.message" } } },
            "thread_id": "_main"
        })
    }

    #[test]
    fn list_marks_missing() {
        let dir = temp_dir("list");
        let file = dir.join("a-file.txt");
        std::fs::write(&file, "x").unwrap();
        let missing_path = dir.join("nope");
        let body = body_with(vec![
            json!({ "id": "ok", "name": "Here", "path": dir.to_string_lossy() }),
            json!({ "id": "gone", "path": missing_path.to_string_lossy() }),
            json!({ "id": "file", "path": file.to_string_lossy() }),
        ]);
        let value = list_value(&body, &RealFs);
        let items = value.as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["missing"], false);
        assert_eq!(items[0]["name"], "Here");
        // name 缺省回落 basename。
        assert_eq!(items[1]["name"], "nope");
        assert_eq!(items[1]["missing"], true);
        assert_eq!(items[2]["missing"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_empty_body_is_empty() {
        assert_eq!(list_value(&json!({}), &RealFs), json!([]));
        assert_eq!(list_value(&json!({ "workspaces": [] }), &RealFs), json!([]));
    }

    #[test]
    fn add_success_plan_shape_and_placeholders() {
        let dir = temp_dir("add-ok");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let body = body_with(vec![]);
        let args = add_args("ws-1", &target.to_string_lossy(), None, &body);
        let value = add_plan(&args, &RealFs).unwrap();
        let directives = value["$directives"].as_array().unwrap();
        assert_eq!(directives.len(), 2);
        let ops = directives[0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0]["op"], "put");
        assert_eq!(ops[1]["op"], "add_gen");
        assert_eq!(ops[1]["args"]["id"], "workspace");
        assert_eq!(ops[1]["args"]["payload"], json!({ "$n": 0 }));
        assert_eq!(ops[1]["args"]["sig"], json!({ "$n": 0 }));
        assert_eq!(ops[2]["op"], "put");
        assert_eq!(ops[3]["op"], "add_gen");
        assert_eq!(ops[3]["args"]["id"], "input");
        assert_eq!(ops[3]["args"]["payload"], json!({ "$n": 2 }));
        // name 缺省 basename。
        let added = &ops[0]["args"]["body"]["workspaces"][0];
        assert_eq!(added["id"], "ws-1");
        assert_eq!(added["name"], "target");
        assert_eq!(directives[1]["kind"], "extern");
        assert_eq!(directives[1]["payload"], json!({ "ok": true, "workspace": "ws-1" }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_keeps_existing_entries_and_name_override() {
        let dir = temp_dir("add-keep");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let body = body_with(vec![json!({ "id": "old", "name": "Old", "path": "/old" })]);
        let args = add_args("ws-2", &target.to_string_lossy(), Some("Chosen"), &body);
        let value = add_plan(&args, &RealFs).unwrap();
        let list = value["$directives"][0]["request"]["args"]["ops"][0]["args"]["body"]
            ["workspaces"]
            .as_array()
            .unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], "old");
        assert_eq!(list[1]["name"], "Chosen");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_per_thread_clears_only_this_thread() {
        let dir = temp_dir("add-clear");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let body = body_with(vec![]);
        let args = add_args("ws-3", &target.to_string_lossy(), None, &body);
        let value = add_plan(&args, &RealFs).unwrap();
        let idle_body = &value["$directives"][0]["request"]["args"]["ops"][2]["args"]["body"];
        assert_eq!(idle_body["slots"]["_main"], json!({ "kind": "idle" }));
        assert_eq!(idle_body["slots"]["other"], json!({ "kind": "chat.message" }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_path_not_found_still_clears_slot() {
        let dir = temp_dir("add-missing");
        let body = body_with(vec![]);
        let args = add_args("ws-4", &dir.join("nope").to_string_lossy(), None, &body);
        let value = add_plan(&args, &RealFs).unwrap();
        let directives = value["$directives"].as_array().unwrap();
        let ops = directives[0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0]["op"], "put");
        assert_eq!(ops[1]["args"]["id"], "input");
        assert_eq!(ops[1]["args"]["payload"], json!({ "$n": 0 }));
        assert_eq!(
            directives[1]["payload"],
            json!({ "ok": false, "error": "path_not_found" })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_not_a_directory() {
        let dir = temp_dir("add-file");
        let file = dir.join("a-file");
        std::fs::write(&file, "x").unwrap();
        let body = body_with(vec![]);
        let args = add_args("ws-5", &file.to_string_lossy(), None, &body);
        let value = add_plan(&args, &RealFs).unwrap();
        assert_eq!(
            value["$directives"][1]["payload"],
            json!({ "ok": false, "error": "not_a_directory" })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_workspace_exists_carries_existing_id() {
        let dir = temp_dir("add-dup");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let body = body_with(vec![json!({
            "id": "existing",
            "name": "Target",
            "path": target.to_string_lossy()
        })]);
        let args = add_args("ws-6", &target.to_string_lossy(), None, &body);
        let value = add_plan(&args, &RealFs).unwrap();
        assert_eq!(
            value["$directives"][1]["payload"],
            json!({ "ok": false, "error": "workspace_exists", "workspace": "existing" })
        );
        // 失败路径同样清槽。
        let ops = value["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_missing_slot_or_fields_is_bad_args() {
        assert_eq!(
            add_plan(&json!({}), &RealFs).unwrap_err().0,
            "bad_args"
        );
        let body = body_with(vec![]);
        let mut args = add_args("ws", "C:\\whatever", None, &body);
        args["slot"]["kind"] = json!("workspace.remove");
        assert_eq!(add_plan(&args, &RealFs).unwrap_err().0, "bad_args");
        let mut args = add_args("ws", "C:\\whatever", None, &body);
        args["slot"].as_object_mut().unwrap().remove("path");
        assert_eq!(add_plan(&args, &RealFs).unwrap_err().0, "bad_args");
    }

    #[test]
    fn map_io_error_classifies_permission_denied() {
        assert_eq!(
            map_io_error(&io::Error::from(io::ErrorKind::PermissionDenied)),
            AddError::PermissionDenied
        );
        assert_eq!(
            map_io_error(&io::Error::from(io::ErrorKind::NotFound)),
            AddError::PathNotFound
        );
    }

    /// 注入权限错误的文件系统：覆盖真实 FS 上难以稳定构造的 permission_denied 分支。
    #[derive(Default)]
    struct FakeFs {
        canonical: HashMap<String, Result<String, io::ErrorKind>>,
        dir: HashMap<String, bool>,
        readable: HashMap<String, Result<(), io::ErrorKind>>,
    }

    fn key(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    impl Fs for FakeFs {
        fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
            match self.canonical.get(&key(path)) {
                Some(Ok(resolved)) => Ok(PathBuf::from(resolved)),
                Some(Err(kind)) => Err(io::Error::from(*kind)),
                None => Err(io::Error::from(io::ErrorKind::NotFound)),
            }
        }

        fn is_dir(&self, path: &Path) -> io::Result<bool> {
            self.dir
                .get(&key(path))
                .copied()
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }

        fn is_readable_dir(&self, path: &Path) -> io::Result<()> {
            match self.readable.get(&key(path)) {
                Some(Ok(())) => Ok(()),
                Some(Err(kind)) => Err(io::Error::from(*kind)),
                None => Ok(()),
            }
        }
    }

    #[test]
    fn validate_add_permission_denied_from_readable_check() {
        let mut fs = FakeFs::default();
        fs.canonical.insert(
            "C:\\locked".to_string(),
            Ok("C:\\locked".to_string()),
        );
        fs.dir.insert("C:\\locked".to_string(), true);
        fs.readable.insert(
            "C:\\locked".to_string(),
            Err(io::ErrorKind::PermissionDenied),
        );
        assert_eq!(
            validate_add(&fs, "C:\\locked", &[]).unwrap_err(),
            AddError::PermissionDenied
        );
    }

    #[test]
    fn validate_add_canonicalize_permission_denied() {
        let mut fs = FakeFs::default();
        fs.canonical.insert(
            "C:\\secret".to_string(),
            Err(io::ErrorKind::PermissionDenied),
        );
        assert_eq!(
            validate_add(&fs, "C:\\secret", &[]).unwrap_err(),
            AddError::PermissionDenied
        );
    }

    #[test]
    fn validate_add_canonicalize_not_found() {
        let fs = FakeFs::default();
        assert_eq!(
            validate_add(&fs, "C:\\ghost", &[]).unwrap_err(),
            AddError::PathNotFound
        );
    }

    #[test]
    fn remove_plan_drops_entry_and_clears_slot() {
        let body = body_with(vec![
            json!({ "id": "keep", "name": "Keep", "path": "/keep" }),
            json!({ "id": "drop", "name": "Drop", "path": "/drop" }),
        ]);
        let args = json!({
            "slot": { "kind": "workspace.remove", "workspace": "drop" },
            "body": body,
            "slots": { "slots": { "_main": { "kind": "workspace.remove" }, "other": { "kind": "idle" } } },
            "thread_id": "_main"
        });
        let value = remove_plan(&args).unwrap();
        let ops = value["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 4);
        let list = ops[0]["args"]["body"]["workspaces"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "keep");
        assert_eq!(ops[1]["args"]["id"], "workspace");
        assert_eq!(ops[3]["args"]["id"], "input");
        assert_eq!(
            ops[2]["args"]["body"]["slots"]["other"],
            json!({ "kind": "idle" })
        );
        assert_eq!(
            value["$directives"][1]["payload"],
            json!({ "ok": true, "workspace": "drop", "removed": true })
        );
    }

    #[test]
    fn remove_plan_unknown_id_is_idempotent() {
        let body = body_with(vec![json!({ "id": "keep", "path": "/keep" })]);
        let args = json!({
            "slot": { "kind": "workspace.remove", "workspace": "ghost" },
            "body": body,
            "slots": { "slots": { "_main": { "kind": "workspace.remove" } } },
            "thread_id": "_main"
        });
        let value = remove_plan(&args).unwrap();
        assert_eq!(
            value["$directives"][1]["payload"],
            json!({ "ok": true, "workspace": "ghost", "removed": false })
        );
    }

    #[test]
    fn remove_plan_missing_slot_is_bad_args() {
        assert_eq!(remove_plan(&json!({})).unwrap_err().0, "bad_args");
    }

    #[test]
    fn add_and_remove_require_body_and_slots() {
        let dir = temp_dir("require");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let body = body_with(vec![]);
        // 缺 body：不得产出会清空既有工作区的计划。
        let mut no_body = add_args("ws", &target.to_string_lossy(), None, &body);
        no_body.as_object_mut().unwrap().remove("body");
        assert_eq!(add_plan(&no_body, &RealFs).unwrap_err().0, "bad_args");
        // 缺 slots：不得产出会清空其它线程槽的计划。
        let mut no_slots = add_args("ws", &target.to_string_lossy(), None, &body);
        no_slots.as_object_mut().unwrap().remove("slots");
        assert_eq!(add_plan(&no_slots, &RealFs).unwrap_err().0, "bad_args");
        let remove_body_missing = json!({
            "slot": { "kind": "workspace.remove", "workspace": "x" },
            "slots": { "slots": { "_main": { "kind": "workspace.remove" } } },
        });
        assert_eq!(remove_plan(&remove_body_missing).unwrap_err().0, "bad_args");
        let remove_slots_missing = json!({
            "slot": { "kind": "workspace.remove", "workspace": "x" },
            "body": body_with(vec![]),
        });
        assert_eq!(remove_plan(&remove_slots_missing).unwrap_err().0, "bad_args");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_duplicate_id_is_workspace_exists() {
        let dir = temp_dir("add-dupid");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let body = body_with(vec![json!({ "id": "dup", "name": "Dup", "path": "/other" })]);
        let args = add_args("dup", &target.to_string_lossy(), None, &body);
        let value = add_plan(&args, &RealFs).unwrap();
        assert_eq!(
            value["$directives"][1]["payload"],
            json!({ "ok": false, "error": "workspace_exists", "workspace": "dup" })
        );
        // 失败路径同样清槽（只两条）。
        let ops = value["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 测试内联最小补丁组装：replace / delete（顶层与 slots 键）。
    fn apply_ops(base: &Value, ops: &[Value]) -> Value {
        let mut doc = base.clone();
        for op in ops {
            let path = op["path"].as_array().unwrap();
            let mut node = &mut doc;
            for step in &path[..path.len() - 1] {
                node = node.get_mut(step.as_str().unwrap()).unwrap();
            }
            let last = path[path.len() - 1].as_str().unwrap();
            if op["op"] == "delete" {
                node.as_object_mut().unwrap().remove(last);
            } else {
                node[last] = op["value"].clone();
            }
        }
        doc
    }

    #[test]
    fn add_with_data_gen_writes_patches_and_base() {
        let dir = temp_dir("add-patch");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let body = body_with(vec![]);
        let mut args = add_args("ws-p", &target.to_string_lossy(), None, &body);
        // 让本线程槽确实有变化（workspace.add → idle），才能产输入补丁。
        args["slots"]["slots"]["_main"] = args["slot"].clone();
        let prev_slots = args["slots"].clone();
        args["body_data_gen"] = json!({ "seq": 5, "payload": "a".repeat(64) });
        args["slots_data_gen"] = json!({ "seq": 7, "payload": "b".repeat(64) });

        let value = add_plan(&args, &RealFs).unwrap();
        let ops = value["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[1]["args"]["id"], "workspace");
        assert_eq!(ops[1]["args"]["base"], json!(5));
        assert_eq!(ops[3]["args"]["id"], "input");
        assert_eq!(ops[3]["args"]["base"], json!(7));
        // 补丁组装结果 == 目标整份 body（同内容旧 / 新形态逐字段一致）。
        let next_body = apply_ops(&body, ops[0]["args"]["body"]["ops"].as_array().unwrap());
        assert_eq!(next_body["workspaces"][0]["id"], "ws-p");
        let next_slots = apply_ops(&prev_slots, ops[2]["args"]["body"]["ops"].as_array().unwrap());
        assert_eq!(next_slots["slots"]["_main"], json!({ "kind": "idle" }));
        assert_eq!(next_slots["slots"]["other"], json!({ "kind": "chat.message" }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_empty_input_change_falls_back_to_full() {
        let dir = temp_dir("add-patch-empty");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let body = body_with(vec![]);
        // 默认 add_args 的本线程槽已是 idle → 清槽空改动，回落整份世代。
        let mut args = add_args("ws-e", &target.to_string_lossy(), None, &body);
        args["slots_data_gen"] = json!({ "seq": 7, "payload": "b".repeat(64) });
        let value = add_plan(&args, &RealFs).unwrap();
        let ops = value["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 4);
        assert!(ops[3]["args"].get("base").is_none());
        assert!(ops[2]["args"]["body"].get("ops").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_with_data_gen_writes_patches_and_base() {
        let body = body_with(vec![
            json!({ "id": "keep", "name": "Keep", "path": "/keep" }),
            json!({ "id": "drop", "name": "Drop", "path": "/drop" }),
        ]);
        let mut args = json!({
            "slot": { "kind": "workspace.remove", "workspace": "drop" },
            "body": body.clone(),
            "slots": { "slots": { "_main": { "kind": "workspace.remove" }, "other": { "kind": "idle" } } },
            "thread_id": "_main"
        });
        args["body_data_gen"] = json!({ "seq": 3, "payload": "c".repeat(64) });
        args["slots_data_gen"] = json!({ "seq": 4, "payload": "d".repeat(64) });
        let value = remove_plan(&args).unwrap();
        let ops = value["$directives"][0]["request"]["args"]["ops"].as_array().unwrap();
        assert_eq!(ops[1]["args"]["base"], json!(3));
        assert_eq!(ops[3]["args"]["base"], json!(4));
        let next_body = apply_ops(&body, ops[0]["args"]["body"]["ops"].as_array().unwrap());
        let list = next_body["workspaces"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "keep");
    }

    #[test]
    fn slot_of_reads_from_slots_map() {
        let args = json!({
            "slots": { "slots": { "_main": { "kind": "workspace.add", "workspace": "w", "path": "/p" } } }
        });
        let slot = slot_of(&args).unwrap();
        assert_eq!(slot["workspace"], "w");
        assert_eq!(thread_key(&args), "_main");
    }

    #[test]
    fn slot_of_accepts_bare_slot_args() {
        let args = json!({ "kind": "workspace.remove", "workspace": "w" });
        assert_eq!(slot_of(&args).unwrap()["workspace"], "w");
    }

    #[test]
    fn clear_slots_preserves_other_keys() {
        let body = json!({ "slots": { "a": { "kind": "chat.message" } }, "extra": 1 });
        let cleared = clear_slots(&body, "a");
        assert_eq!(cleared["slots"]["a"], json!({ "kind": "idle" }));
        assert_eq!(cleared["extra"], 1);
    }

    #[test]
    fn basename_handles_trailing_separator() {
        assert_eq!(basename("/home/anyi/"), "anyi");
    }

    #[cfg(windows)]
    #[test]
    fn basename_handles_windows_paths() {
        assert_eq!(basename("C:\\Users\\Anyi"), "Anyi");
    }

    #[cfg(windows)]
    #[test]
    fn same_path_normalizes_case_and_separators() {
        assert!(same_path("C:\\Users\\A\\", "c:/users/a"));
    }

    #[cfg(not(windows))]
    #[test]
    fn same_path_is_case_sensitive_off_windows() {
        assert!(!same_path("/Users/A/", "/users/a"));
        assert!(same_path("/Users/A/", "/Users/A"));
    }
}
