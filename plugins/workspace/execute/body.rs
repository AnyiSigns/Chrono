// workspace 能力类的纯逻辑面：workspaces 清单解析 / list 标注 / add 校验 / remove 过滤。
// 清单已出世界：服务写自有持久存储（store.rs），本模块只做校验与列表变换，不落账、不读 ctx、不取时间。
// 输入槽清理由调用方（ui-sidebar）经 input 服务承担——本模块不再构造世界写计划。

use std::io;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

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

fn bad_args(message: &str) -> (String, String) {
    ("bad_args".to_string(), message.to_string())
}

/// 清单里的工作区数组（`workspaces` 非数组回空）。
pub fn workspaces_of(body: &Value) -> Vec<Value> {
    body.get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
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
        let norm = |text: &str| text.replace('/', "\\").trim_end_matches('\\').to_lowercase();
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

/// 目标工作区路径（reveal 用）：按 id 在清单里线性查找。
pub fn workspace_path(workspaces: &[Value], id: &str) -> Option<String> {
    workspaces
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|item| item.get("path").and_then(Value::as_str))
        .map(str::to_string)
}

/// `list`：逐路径 stat，`missing` = 不存在 / 非目录（stat 失败按 missing 收口，不阻塞其它项）。
pub fn list_value(workspaces: &[Value], fs: &dyn Fs) -> Value {
    let items: Vec<Value> = workspaces
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

/// 本线程槽体：`args.slot` 优先；否则 `args.kind` 本身即槽体。
fn slot_of(args: &Value) -> Option<&Value> {
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
    None
}

/// `add`：校验通过 → 追加 `{id,name,path}` 的新清单 + extern`{ok:true,workspace}`；
/// 失败 → 原清单 + extern 错误载荷。清槽由调用方承担。
pub fn add_value(fs: &dyn Fs, args: &Value, current: &[Value]) -> Result<(Vec<Value>, Value), (String, String)> {
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

    // id 唯一性：重复 id 会生成重复条目（realpath 去重不覆盖此情形）。
    if current
        .iter()
        .any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        return Ok((current.to_vec(), AddError::WorkspaceExists(id).payload()));
    }

    match validate_add(fs, &path, current) {
        Ok(real) => {
            let name = name_arg.unwrap_or_else(|| basename(&real));
            let mut list = current.to_vec();
            list.push(json!({ "id": id, "name": name, "path": real }));
            Ok((list, json!({ "ok": true, "workspace": id })))
        }
        Err(err) => Ok((current.to_vec(), err.payload())),
    }
}

/// `remove`：删该项的新清单 + extern`{ok:true,workspace,removed}`。
/// 目标 id 不在列表时为幂等成功（清单不变），`removed:false`。
pub fn remove_value(args: &Value, current: &[Value]) -> Result<(Vec<Value>, Value), (String, String)> {
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
    let before = current.len();
    let filtered: Vec<Value> = current
        .iter()
        .filter(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .cloned()
        .collect();
    let removed = filtered.len() < before;
    Ok((filtered, json!({ "ok": true, "workspace": id, "removed": removed })))
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

    fn add_args(id: &str, path: &str, name: Option<&str>) -> Value {
        let mut slot = json!({ "kind": "workspace.add", "workspace": id, "path": path });
        if let Some(name) = name {
            slot["name"] = json!(name);
        }
        json!({ "slot": slot, "thread_id": "_main" })
    }

    #[test]
    fn list_marks_missing() {
        let dir = temp_dir("list");
        let file = dir.join("a-file.txt");
        std::fs::write(&file, "x").unwrap();
        let missing_path = dir.join("nope");
        let list = workspaces_of(&body_with(vec![
            json!({ "id": "ok", "name": "Here", "path": dir.to_string_lossy() }),
            json!({ "id": "gone", "path": missing_path.to_string_lossy() }),
            json!({ "id": "file", "path": file.to_string_lossy() }),
        ]));
        let value = list_value(&list, &RealFs);
        let items = value.as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["missing"], false);
        assert_eq!(items[0]["name"], "Here");
        assert_eq!(items[1]["name"], "nope");
        assert_eq!(items[1]["missing"], true);
        assert_eq!(items[2]["missing"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_empty_is_empty() {
        assert_eq!(list_value(&[], &RealFs), json!([]));
    }

    #[test]
    fn add_success_appends_and_keeps_existing() {
        let dir = temp_dir("add-ok");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let current = vec![json!({ "id": "old", "name": "Old", "path": "/old" })];
        let args = add_args("ws-1", &target.to_string_lossy(), None);
        let (list, payload) = add_value(&RealFs, &args, &current).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], "old");
        assert_eq!(list[1]["id"], "ws-1");
        assert_eq!(list[1]["name"], "target");
        assert_eq!(payload, json!({ "ok": true, "workspace": "ws-1" }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_name_override() {
        let dir = temp_dir("add-name");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let args = add_args("ws-2", &target.to_string_lossy(), Some("Chosen"));
        let (list, _) = add_value(&RealFs, &args, &[]).unwrap();
        assert_eq!(list[0]["name"], "Chosen");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_path_not_found_keeps_list() {
        let dir = temp_dir("add-missing");
        let args = add_args("ws-4", &dir.join("nope").to_string_lossy(), None);
        let (list, payload) = add_value(&RealFs, &args, &[]).unwrap();
        assert!(list.is_empty());
        assert_eq!(payload, json!({ "ok": false, "error": "path_not_found" }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_not_a_directory() {
        let dir = temp_dir("add-file");
        let file = dir.join("a-file");
        std::fs::write(&file, "x").unwrap();
        let args = add_args("ws-5", &file.to_string_lossy(), None);
        let (_, payload) = add_value(&RealFs, &args, &[]).unwrap();
        assert_eq!(payload, json!({ "ok": false, "error": "not_a_directory" }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_workspace_exists_carries_existing_id() {
        let dir = temp_dir("add-dup");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let current = vec![json!({
            "id": "existing",
            "name": "Target",
            "path": target.to_string_lossy()
        })];
        let args = add_args("ws-6", &target.to_string_lossy(), None);
        let (list, payload) = add_value(&RealFs, &args, &current).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            payload,
            json!({ "ok": false, "error": "workspace_exists", "workspace": "existing" })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_duplicate_id_is_workspace_exists() {
        let dir = temp_dir("add-dupid");
        let target = dir.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let current = vec![json!({ "id": "dup", "name": "Dup", "path": "/other" })];
        let args = add_args("dup", &target.to_string_lossy(), None);
        let (list, payload) = add_value(&RealFs, &args, &current).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            payload,
            json!({ "ok": false, "error": "workspace_exists", "workspace": "dup" })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_missing_slot_or_fields_is_bad_args() {
        assert_eq!(add_value(&RealFs, &json!({}), &[]).unwrap_err().0, "bad_args");
        let mut args = add_args("ws", "C:\\whatever", None);
        args["slot"]["kind"] = json!("workspace.remove");
        assert_eq!(add_value(&RealFs, &args, &[]).unwrap_err().0, "bad_args");
        let mut args = add_args("ws", "C:\\whatever", None);
        args["slot"].as_object_mut().unwrap().remove("path");
        assert_eq!(add_value(&RealFs, &args, &[]).unwrap_err().0, "bad_args");
    }

    #[test]
    fn remove_drops_entry_and_reports_removed() {
        let current = vec![
            json!({ "id": "keep", "name": "Keep", "path": "/keep" }),
            json!({ "id": "drop", "name": "Drop", "path": "/drop" }),
        ];
        let args = json!({ "slot": { "kind": "workspace.remove", "workspace": "drop" }, "thread_id": "_main" });
        let (list, payload) = remove_value(&args, &current).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "keep");
        assert_eq!(payload, json!({ "ok": true, "workspace": "drop", "removed": true }));
    }

    #[test]
    fn remove_unknown_id_is_idempotent() {
        let current = vec![json!({ "id": "keep", "path": "/keep" })];
        let args = json!({ "slot": { "kind": "workspace.remove", "workspace": "ghost" } });
        let (list, payload) = remove_value(&args, &current).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(payload, json!({ "ok": true, "workspace": "ghost", "removed": false }));
    }

    #[test]
    fn remove_missing_slot_is_bad_args() {
        assert_eq!(remove_value(&json!({}), &[]).unwrap_err().0, "bad_args");
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
        fs.canonical.insert("C:\\locked".to_string(), Ok("C:\\locked".to_string()));
        fs.dir.insert("C:\\locked".to_string(), true);
        fs.readable
            .insert("C:\\locked".to_string(), Err(io::ErrorKind::PermissionDenied));
        assert_eq!(
            validate_add(&fs, "C:\\locked", &[]).unwrap_err(),
            AddError::PermissionDenied
        );
    }

    #[test]
    fn validate_add_canonicalize_permission_denied() {
        let mut fs = FakeFs::default();
        fs.canonical
            .insert("C:\\secret".to_string(), Err(io::ErrorKind::PermissionDenied));
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
    fn workspace_path_resolves_from_list() {
        let list = vec![json!({ "id": "w1", "path": "C:\\ws" })];
        assert_eq!(workspace_path(&list, "w1"), Some("C:\\ws".to_string()));
        assert_eq!(workspace_path(&list, "nope"), None);
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
