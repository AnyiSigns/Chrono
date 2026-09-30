// 结构化文件操作 `fsop`：六 op `stat` / `read` / `list` / `grep` / `write` / `replace`。
// 强制点在**本插件**：realpath 解析 + 与 `workspace_root` 前缀比对（Windows 大小写不敏感、
// `\\?\` 前缀归一、junction / reparse point 由 canonicalize 解析）；取「声明 caps ∩ 当前档」后执行；
// 一次性 `caps.grant` 绑定 `{call_id, op, path, tier, expires}` 校验后放宽**本次**（`deny` 档不放宽）。
// 写路径把「读校验 → rename」纳入进程内写互斥（与 grant 存储分开的一把 `Mutex`；生产入口 `fsop()`
// 另持全局 grant 存储锁已串行化，收益边界见 `write_lock`），并在 rename 前对目标再读复核，
// 收口 `write` / `replace` 的 TOCTOU。
// 诚实口径：进程内 best-effort，非 OS 级隔离——`exec` 可跑任意命令绕过本锁直接改文件，故只作兜底
// （Docker 后端才真隔离）。
// 确定性：遍历按路径字典序、不取时间、不用随机；`stat.mtime` 取自文件系统、不参与确定性保证。

use std::fs;
use std::io::{Read as IoRead, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::casefold::casefold;
use crate::glob::{glob_match, regex_search, regex_unsupported};
use crate::grant::{self, Grant, GrantStore};
use crate::hash::sha256_hex;
use crate::tiers::{self, Effective, FsScope};

/// 结构化失败（code + 人读 message），fsop 统一回 `{ok:false, code, message}`。
#[derive(Debug, Clone)]
pub struct FsError {
    pub code: &'static str,
    pub message: String,
}

impl FsError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

fn bad_path(message: impl Into<String>) -> FsError {
    FsError::new("bad_path", message)
}
fn bad_args(message: impl Into<String>) -> FsError {
    FsError::new("bad_args", message)
}
fn path_not_found(message: impl Into<String>) -> FsError {
    FsError::new("path_not_found", message)
}
fn not_a_directory(message: impl Into<String>) -> FsError {
    FsError::new("not_a_directory", message)
}
fn not_a_file(message: impl Into<String>) -> FsError {
    FsError::new("not_a_file", message)
}
fn io_error(message: impl Into<String>) -> FsError {
    FsError::new("io_error", message)
}
fn edit_conflict(message: impl Into<String>) -> FsError {
    FsError::new("edit_conflict", message)
}
fn too_large(message: impl Into<String>) -> FsError {
    FsError::new("too_large", message)
}
fn binary_unsupported(message: impl Into<String>) -> FsError {
    FsError::new("binary_unsupported", message)
}
fn fs_denied(message: impl Into<String>) -> FsError {
    FsError::new("fs_denied", message)
}
fn permission_denied(message: impl Into<String>) -> FsError {
    FsError::new("permission_denied", message)
}

/// io 错误 → 结构化码：权限 / 不存在如实归类，其余归 `io_error`，不伪装成 `path_not_found`。
fn map_io_error(err: std::io::Error) -> FsError {
    match err.kind() {
        std::io::ErrorKind::NotFound => path_not_found(err.to_string()),
        std::io::ErrorKind::PermissionDenied => permission_denied(err.to_string()),
        _ => io_error(err.to_string()),
    }
}

/// 一次 fsop 的执行上下文（档位强制 + 一次性 grant）。
pub struct FsContext {
    pub op: String,
    pub tier: Option<String>,
    pub workspace_root: Option<PathBuf>,
    pub workspace_canon: Option<PathBuf>,
    pub effective: Effective,
    /// `deny` 档：fs 读写全拒，任何 grant 都不得放宽（与 `handle_exec` 对齐）。
    pub deny_tier: bool,
    pub grant: Option<Grant>,
    pub output_max: usize,
    pub now: f64,
}

impl FsContext {
    /// 校验读权限：档位范围内放行；有效 grant 放宽本次。
    fn check_read(&self, inside: bool, target: &Path, store: &mut GrantStore) -> Result<(), FsError> {
        self.check(inside, target, false, store)
    }

    /// 校验写权限。
    fn check_write(&self, inside: bool, target: &Path, store: &mut GrantStore) -> Result<(), FsError> {
        self.check(inside, target, true, store)
    }

    fn check(
        &self,
        inside: bool,
        target: &Path,
        write: bool,
        store: &mut GrantStore,
    ) -> Result<(), FsError> {
        // deny 档在任何 grant 之前短路：grant 不放宽 deny。
        if self.deny_tier {
            return Err(fs_denied("deny tier rejects fsop"));
        }
        if let Some(grant) = &self.grant {
            // grant 必须绑定 op 与目标路径；`paths` 空 = 不适用。
            if grant.op.as_deref() == Some(self.op.as_str()) && grant_path_allows(grant, self, target)
            {
                // 只允许 grant 显式声明的范围放宽本次；未声明即不额外放宽。
                let declared = if write { grant.fs_write } else { grant.fs_read };
                if let Some(declared) = declared {
                    let required = if inside { FsScope::Workspace } else { FsScope::Full };
                    // 范围不足不烧掉一次性凭据。
                    if declared.rank() >= required.rank()
                        && grant::redeem(grant, self.tier.as_deref(), self.now, store).is_ok()
                    {
                        return Ok(());
                    }
                }
            }
        }
        let allowed = if write {
            self.effective.allows_write(inside)
        } else {
            self.effective.allows_read(inside)
        };
        if allowed {
            Ok(())
        } else {
            Err(fs_denied(format!(
                "{} {} denied by tier",
                if write { "write" } else { "read" },
                if inside { "inside workspace" } else { "outside workspace" }
            )))
        }
    }
}

/// fsop 入口：使用进程内一次性 grant 记录。
pub fn fsop(bag: &Value, now: f64) -> Value {
    let mut store = grant::global_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    fsop_with_store(bag, now, &mut store)
}

/// fsop 入口（显式 grant 记录，供测试与调用方复用）。
pub fn fsop_with_store(bag: &Value, now: f64, store: &mut GrantStore) -> Value {
    match run_op(bag, now, store) {
        Ok((op, result)) => json!({ "ok": true, "op": op, "result": result }),
        Err(err) => json!({ "ok": false, "code": err.code, "message": err.message }),
    }
}

fn run_op(bag: &Value, now: f64, store: &mut GrantStore) -> Result<(&'static str, Value), FsError> {
    let op = bag.get("op").and_then(Value::as_str).unwrap_or("").to_string();
    let path = bag.get("path").and_then(Value::as_str);
    let args = bag.get("args").cloned().unwrap_or(Value::Null);
    let context = build_context(bag, now, &op)?;
    match op.as_str() {
        "stat" => Ok(("stat", op_stat(&context, path, store)?)),
        "read" => Ok(("read", op_read(&context, path, &args, store)?)),
        "list" => Ok(("list", op_list(&context, path, &args, store)?)),
        "grep" => Ok(("grep", op_grep(&context, path, &args, store)?)),
        "write" => Ok(("write", op_write(&context, path, &args, store)?)),
        "replace" => Ok(("replace", op_replace(&context, path, &args, store)?)),
        other => Err(bad_args(format!("unknown fsop {other}"))),
    }
}

fn build_context(bag: &Value, now: f64, op: &str) -> Result<FsContext, FsError> {
    let tier = bag.get("tier").and_then(Value::as_str).map(str::to_string);
    let (deny_tier, effective, output_max) = match resolved_gate(bag) {
        Some(gate) => gate,
        None => {
            let config = tiers::parse_tiers(bag.get("sandbox_tiers"));
            let policy = config.policy(tier.as_deref());
            let caps = tiers::parse_caps(bag.get("caps"), &policy, &config.defaults);
            (
                policy.fs_read == FsScope::None && policy.fs_write == FsScope::None,
                tiers::effective_scope(&caps, &policy),
                caps.output_max.max(1),
            )
        }
    };
    let workspace_root = bag
        .get("workspace_root")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let workspace_canon = workspace_root.as_deref().and_then(|root| fs::canonicalize(root).ok());
    let grant_raw = bag
        .get("grant")
        .or_else(|| bag.get("caps").and_then(|caps| caps.get("grant")));
    Ok(FsContext {
        op: op.to_string(),
        tier,
        workspace_root,
        workspace_canon,
        effective,
        deny_tier,
        grant: grant::parse_grant(grant_raw),
        output_max,
        now,
    })
}

/// 判定提供方 `sandbox-policy.resolve` 注入的预解析判定（`bag.resolved`）：
/// 取 `deny_tier` / effective fs 范围 / `output_max`；缺失或形态不合回落 `None`（由调用方内建判定兜底）。
fn resolved_gate(bag: &Value) -> Option<(bool, Effective, usize)> {
    let resolved = bag.get("resolved")?;
    let deny_tier = resolved.get("deny_tier")?.as_bool()?;
    let effective = Effective {
        fs_read: FsScope::parse(resolved.get("fs_read"), FsScope::None),
        fs_write: FsScope::parse(resolved.get("fs_write"), FsScope::None),
    };
    let output_max = resolved
        .get("caps")
        .and_then(|caps| caps.get("output_max"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    Some((deny_tier, effective, output_max))
}

// ── 路径解析与范围判定 ─────────────────────────────────────────────────────

fn validate_form(value: &str) -> Result<(), FsError> {
    if value.trim().is_empty() {
        return Err(bad_path("empty path"));
    }
    if value.contains('\0') {
        return Err(bad_path("NUL in path"));
    }
    if value.chars().any(char::is_control) {
        return Err(bad_path("control character in path"));
    }
    Ok(())
}

fn resolve_path_arg(path: &str, workspace_root: Option<&Path>) -> Result<PathBuf, FsError> {
    validate_form(path)?;
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Ok(candidate.to_path_buf());
    }
    let Some(root) = workspace_root else {
        return Err(bad_path("relative path without workspace_root"));
    };
    Ok(root.join(candidate))
}

/// `list` / `grep` 的基准：`args.base` > `path` > `workspace_root`。
fn resolve_base_arg(
    base: Option<&str>,
    path: Option<&str>,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, FsError> {
    if let Some(base) = base {
        return resolve_path_arg(base, workspace_root);
    }
    if let Some(path) = path.filter(|value| !value.trim().is_empty()) {
        return resolve_path_arg(path, workspace_root);
    }
    match workspace_root {
        Some(root) => Ok(root.to_path_buf()),
        None => Err(bad_path("no base and no workspace_root")),
    }
}

/// canonicalize；目标不存在时解析其父目录后拼回文件名（用于新建 / stat）。
fn canonical_or_parent(target: &Path) -> Result<(PathBuf, bool), FsError> {
    match fs::canonicalize(target) {
        Ok(canon) => return Ok((canon, true)),
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(permission_denied(err.to_string()));
        }
        Err(_) => {}
    }
    if let Some(parent) = target.parent() {
        match fs::canonicalize(parent) {
            Ok(canon_parent) => {
                if let Some(name) = target.file_name() {
                    return Ok((canon_parent.join(name), false));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(permission_denied(err.to_string()));
            }
            Err(_) => {}
        }
    }
    Err(path_not_found("path does not exist"))
}

/// 免竞态打开（v1 尽力）：打开规范路径后 fstat + 重新 canonicalize 复核路径未在检查与打开之间改变；
/// 最多读 `limit + 1` 字节（多 1 字节用于判断是否被上限截断）。
/// 符号链接已在 canonicalize 阶段解析；目录被换链的窄窗口由本复核兜底（非 OS 级隔离）。
fn read_verified_capped(path: &Path, limit: usize) -> Result<(Vec<u8>, bool), FsError> {
    let file = fs::File::open(path).map_err(map_io_error)?;
    let _metadata = file.metadata().map_err(map_io_error)?;
    if let Ok(after) = fs::canonicalize(path) {
        if norm_key(&after) != norm_key(path) {
            return Err(fs_denied("path changed between check and open"));
        }
    }
    let mut bytes = Vec::new();
    let mut reader = file.take(limit.saturating_add(1) as u64);
    reader
        .read_to_end(&mut bytes)
        .map_err(|err| FsError::new("sandbox_setup_failed", err.to_string()))?;
    let capped = bytes.len() > limit;
    Ok((bytes, capped))
}

/// 读全量（用于哈希比对 / `replace`；调用方须先按 `metadata().len()` 判上限）。
fn read_verified(path: &Path) -> Result<Vec<u8>, FsError> {
    read_verified_capped(path, usize::MAX).map(|(bytes, _)| bytes)
}

fn strip_extended(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    text
}

pub(crate) fn norm_key(path: &Path) -> String {
    let text = strip_extended(path).replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// `target` 是否落在 `root` 内（含自身）；Windows 大小写不敏感、分隔符归一。
pub(crate) fn is_inside(target: &Path, root: &Path) -> bool {
    let target_key = norm_key(target);
    let root_key = norm_key(root);
    if target_key == root_key {
        return true;
    }
    let root_trimmed = root_key.trim_end_matches('/');
    target_key.starts_with(&format!("{root_trimmed}/"))
}

fn inside_workspace(context: &FsContext, target: &Path) -> bool {
    match &context.workspace_canon {
        Some(root) => is_inside(target, root),
        None => false,
    }
}

/// grant.paths 为空 = **不适用**（不构成 grant，一律不放宽）；否则 target 必须落在任一 grant 路径下。
fn grant_path_allows(grant: &Grant, context: &FsContext, target: &Path) -> bool {
    if grant.paths.is_empty() {
        return false;
    }
    for raw in &grant.paths {
        let candidate = match resolve_path_arg(raw, context.workspace_root.as_deref()) {
            Ok(candidate) => candidate,
            Err(_) => continue,
        };
        if let Ok((canon, _)) = canonical_or_parent(&candidate) {
            if is_inside(target, &canon) {
                return true;
            }
        }
    }
    false
}

// ── 文本工具 ───────────────────────────────────────────────────────────────

fn has_nul(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

/// 行切分：只按 `\n` 切、保留行尾 `\r`（CRLF 文件的 `\r` 属于内容，读窗口据此与文件字节一致）；
/// 不保留末尾空行（`a\n` 只有一行）。
fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if lines.last().map(String::is_empty).unwrap_or(false) {
        lines.pop();
    }
    lines
}

/// 归一为 CRLF：先统一成 LF，再把 `\n` 换成 `\r\n`。
fn to_crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

/// 行尾口径适配：文件是 CRLF、而 old 用 LF 时按文件风格转换 old/new（反之亦然），
/// 使「用别处读到的 LF 文本去改 CRLF 文件」可用；混合行尾的文件不做转换。
fn adapt_line_endings<'a>(
    text: &str,
    old: &'a str,
    new: &'a str,
) -> (std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>) {
    use std::borrow::Cow;
    let file_crlf = text.contains("\r\n") && !text.replace("\r\n", "").contains('\r');
    if file_crlf && !old.contains('\r') {
        return (Cow::Owned(to_crlf(old)), Cow::Owned(to_crlf(new)));
    }
    if !text.contains('\r') && old.contains('\r') {
        let to_lf = |value: &str| value.replace("\r\n", "\n");
        return (Cow::Owned(to_lf(old)), Cow::Owned(to_lf(new)));
    }
    (Cow::Borrowed(old), Cow::Borrowed(new))
}

/// 把字节截到 `max_bytes` 内的最长 UTF-8 前缀（不切断多字节字符）；返回（文本，是否被截断）。
/// 截断后仍非合法 UTF-8（非 NUL 的伪二进制，如 GBK / UTF-16）→ `binary_unsupported`，不再静默 lossy 解码。
fn decode_utf8_capped(mut bytes: Vec<u8>, max_bytes: usize) -> Result<(String, bool), FsError> {
    if bytes.len() <= max_bytes {
        return match String::from_utf8(bytes) {
            Ok(text) => Ok((text, false)),
            Err(_) => Err(binary_unsupported("file is not valid UTF-8")),
        };
    }
    let mut cut = max_bytes;
    // 若切点落在多字节字符中间，回退到该字符起始字节。
    while cut > 0 && (bytes[cut] & 0xC0) == 0x80 {
        cut -= 1;
    }
    bytes.truncate(cut);
    match String::from_utf8(bytes) {
        Ok(text) => Ok((text, true)),
        Err(_) => Err(binary_unsupported("file is not valid UTF-8")),
    }
}

fn mtime_ms(meta: &fs::Metadata) -> Value {
    match meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    {
        Some(duration) => json!(duration.as_millis() as u64),
        None => Value::Null,
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn arg_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key).and_then(Value::as_u64).map(|value| value as usize)
}

fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn arg_strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn relative_slash(base: &Path, path: &Path) -> String {
    match path.strip_prefix(base) {
        Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
        Err(_) => path.to_string_lossy().replace('\\', "/"),
    }
}

fn matches_pattern(pattern: &str, relative: &str, name: &str) -> bool {
    if pattern.contains('/') {
        glob_match(pattern, relative)
    } else {
        glob_match(pattern, name) || glob_match(pattern, relative)
    }
}

/// 忽略判定：含 `/` 的条目按相对路径 glob；否则按「文件名 / 整路径 / **任一路径段**」匹配——
/// 故目录名条目（`.git` / `node_modules` / `target` 等）能命中目录并整棵剪枝，`*.log` 仍按文件段命中。
fn ignored(patterns: &[String], relative: &str, name: &str) -> bool {
    patterns.iter().any(|pattern| {
        if pattern.contains('/') {
            return glob_match(pattern, relative);
        }
        if glob_match(pattern, name) || glob_match(pattern, relative) {
            return true;
        }
        relative.split('/').any(|segment| glob_match(pattern, segment))
    })
}

// ── op: stat ───────────────────────────────────────────────────────────────

fn op_stat(context: &FsContext, path: Option<&str>, store: &mut GrantStore) -> Result<Value, FsError> {
    let path = path.ok_or_else(|| bad_args("path required"))?;
    let target = resolve_path_arg(path, context.workspace_root.as_deref())?;
    let (canon, exists) = canonical_or_parent(&target)?;
    context.check_read(inside_workspace(context, &canon), &canon, store)?;
    if !exists {
        return Ok(json!({ "exists": false, "is_dir": false, "size": 0, "mtime": Value::Null }));
    }
    let meta = fs::metadata(&canon).map_err(map_io_error)?;
    Ok(json!({
        "exists": true,
        "is_dir": meta.is_dir(),
        "size": meta.len(),
        "mtime": mtime_ms(&meta),
    }))
}

// ── op: read ───────────────────────────────────────────────────────────────

fn op_read(
    context: &FsContext,
    path: Option<&str>,
    args: &Value,
    store: &mut GrantStore,
) -> Result<Value, FsError> {
    let path = path.ok_or_else(|| bad_args("path required"))?;
    let target = resolve_path_arg(path, context.workspace_root.as_deref())?;
    let (canon, exists) = canonical_or_parent(&target)?;
    context.check_read(inside_workspace(context, &canon), &canon, store)?;
    if !exists {
        return Err(path_not_found("file does not exist"));
    }
    let meta = fs::metadata(&canon).map_err(map_io_error)?;
    if !meta.is_file() {
        return Err(not_a_file("expected a file"));
    }
    // 读前按上限截断（最多读 output_max + 1 字节）：超限返回截断内容 + truncated（非错）。
    let (raw, _) = read_verified_capped(&canon, context.output_max)?;
    if has_nul(&raw) {
        return Err(binary_unsupported("file contains NUL bytes"));
    }
    let (text, size_truncated) = decode_utf8_capped(raw, context.output_max)?;
    let lines = split_lines(&text);
    let total_lines = lines.len();
    let offset = arg_usize(args, "offset").unwrap_or(0).min(total_lines);
    let limit = arg_usize(args, "limit");
    let end = match limit {
        Some(limit) => offset.saturating_add(limit).min(total_lines),
        None => total_lines,
    };
    let window = lines[offset..end].join("\n");
    let lines_returned = end - offset;
    // 字节被 output_max 截断时，文件其余内容不可再经本工具读到：`has_more` 不成立、不提供续读游标。
    let has_more = !size_truncated && end < total_lines;
    let next_offset = if has_more { json!(end) } else { Value::Null };
    // 行号统一 1 基：空窗口仍给出游标所指行（offset+1），`end_line` 无内容时为 null。
    let start_line = offset + 1;
    let end_line = if lines_returned > 0 {
        json!(end)
    } else {
        Value::Null
    };
    Ok(json!({
        "text": window,
        // 未截断时为全文行数；被 output_max 截断时仅为已读部分的计数（见 content_truncated）。
        "total_lines": total_lines,
        // 返回窗口首行 / 末行的 1 基行号；`text` 为原始文本、不带行号前缀。
        "start_line": start_line,
        "end_line": end_line,
        "lines_returned": lines_returned,
        // 窗口之后是否还有行可续读；续读用 next_offset 作为下一次 offset（0 基）。
        "has_more": has_more,
        "next_offset": next_offset,
        // 内容因 output_max 被按字节截断（末行可能不完整、文件其余不可读）；标记，非错。
        "content_truncated": size_truncated,
        // 窗口不是整份文件（跳过头 / 未到尾 / 按字节截断）即标记，非错。保留旧口径。
        "truncated": size_truncated || offset > 0 || end < total_lines,
        "binary": false,
    }))
}

// ── op: list ───────────────────────────────────────────────────────────────

fn op_list(
    context: &FsContext,
    path: Option<&str>,
    args: &Value,
    store: &mut GrantStore,
) -> Result<Value, FsError> {
    let base = resolve_base_arg(arg_str(args, "base"), path, context.workspace_root.as_deref())?;
    let (base_canon, exists) = canonical_or_parent(&base)?;
    context.check_read(inside_workspace(context, &base_canon), &base_canon, store)?;
    if !exists {
        return Err(path_not_found("directory does not exist"));
    }
    if !base_canon.is_dir() {
        return Err(not_a_directory("expected a directory"));
    }
    let pattern = arg_str(args, "pattern").unwrap_or("*").to_string();
    let ignore = arg_strings(args, "ignore");
    let limit = arg_usize(args, "limit").unwrap_or(200);

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    walk_files(&base_canon, &base_canon, &ignore, &mut |file| {
        let relative = relative_slash(&base_canon, file);
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !matches_pattern(&pattern, &relative, &name) || ignored(&ignore, &relative, &name) {
            return;
        }
        files.push((relative, file.to_path_buf()));
    });
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut paths = Vec::new();
    let mut used = 0usize;
    let mut truncated = false;
    for (relative, _) in &files {
        if paths.len() >= limit || used + relative.len() > context.output_max {
            truncated = true;
            break;
        }
        used += relative.len();
        paths.push(Value::String(relative.clone()));
    }
    Ok(json!({ "paths": paths, "truncated": truncated }))
}

/// 递归收集文件（不跟随目录符号链接 / junction，避免环）；命中忽略表的目录整棵剪枝。
/// `base` 用于计算相对路径（与忽略表比对）；确定性由调用方排序保证。
fn walk_files<F: FnMut(&Path)>(root: &Path, base: &Path, ignore: &[String], visit: &mut F) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|entry| entry.file_name());
    for entry in items {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            let relative = relative_slash(base, &path);
            let name = entry.file_name().to_string_lossy().to_string();
            if !ignore.is_empty() && ignored(ignore, &relative, &name) {
                continue;
            }
            walk_files(&path, base, ignore, visit);
        } else if file_type.is_file() {
            visit(&path);
        }
    }
}

// ── op: grep ───────────────────────────────────────────────────────────────

fn op_grep(
    context: &FsContext,
    path: Option<&str>,
    args: &Value,
    store: &mut GrantStore,
) -> Result<Value, FsError> {
    let pattern = arg_str(args, "pattern")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_args("pattern required"))?
        .to_string();
    let base = resolve_base_arg(arg_str(args, "base"), path, context.workspace_root.as_deref())?;
    let (base_canon, exists) = canonical_or_parent(&base)?;
    context.check_read(inside_workspace(context, &base_canon), &base_canon, store)?;
    if !exists {
        return Err(path_not_found("directory does not exist"));
    }
    if !base_canon.is_dir() {
        return Err(not_a_directory("expected a directory"));
    }
    let glob_filter = arg_str(args, "glob").map(str::to_string);
    let ignore = arg_strings(args, "ignore");
    let limit = arg_usize(args, "limit").unwrap_or(200);
    // 匹配模式：显式 `mode:"literal"|"regex"` 优先；否则 `regex` 布尔开关；两者都缺省按**字面**匹配
    // （默认不猜正则，避免 `[error]` / `C:\foo` 这类字面量被静默当正则）。正则模式下先校验支持子集：
    // 不支持即显式 `bad_args`，**绝不**静默退化按字面匹配。
    let is_regex = match arg_str(args, "mode") {
        Some("regex") => true,
        Some("literal") => false,
        Some(other) => {
            return Err(bad_args(format!(
                "unknown grep mode `{other}` (expected literal|regex)"
            )))
        }
        None => args.get("regex").and_then(Value::as_bool).unwrap_or(false),
    };
    if is_regex {
        if let Some(reason) = regex_unsupported(&pattern) {
            return Err(bad_args(format!(
                "regex pattern not supported: {reason}; use mode:\"literal\" or simplify the pattern"
            )));
        }
    }

    let ignore_case = arg_bool(args, "ignore_case");
    let files_only = arg_bool(args, "files_only");
    let before = arg_usize(args, "before").unwrap_or(0).min(20);
    let after = arg_usize(args, "after").unwrap_or(0).min(20);

    let mut files: Vec<PathBuf> = Vec::new();
    walk_files(&base_canon, &base_canon, &ignore, &mut |file| {
        let relative = relative_slash(&base_canon, file);
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(glob_filter) = &glob_filter {
            if !matches_pattern(glob_filter, &relative, &name) {
                return;
            }
        }
        if ignored(&ignore, &relative, &name) {
            return;
        }
        files.push(file.to_path_buf());
    });
    files.sort();

    let folded_pattern = if ignore_case {
        casefold(&pattern)
    } else {
        pattern.clone()
    };
    let mut matches = Vec::new();
    let mut used = 0usize;
    let mut truncated = false;
    let mut skipped_binary = 0usize;
    let mut skipped_too_large = 0usize;
    let mut skipped_unreadable = 0usize;
    'outer: for file in &files {
        let Ok(meta) = fs::metadata(file) else {
            skipped_unreadable += 1;
            continue;
        };
        if meta.len() as usize > context.output_max {
            skipped_too_large += 1;
            continue;
        }
        let Ok(bytes) = fs::read(file) else {
            skipped_unreadable += 1;
            continue;
        };
        if has_nul(&bytes) {
            skipped_binary += 1;
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            skipped_binary += 1;
            continue;
        };
        let relative = relative_slash(&base_canon, file);
        let lines = split_lines(&text);
        let mut file_count = 0usize;
        let mut file_first: Option<(usize, String)> = None;
        for (index, line) in lines.iter().enumerate() {
            // ignore_case：模式与命中行同做 Unicode casefold（表驱动，未做 NFC/NFD 规范化）；不改动正则结构校验。
            let hit = if ignore_case {
                let hay = casefold(line);
                if is_regex {
                    regex_search(&folded_pattern, &hay)
                } else {
                    hay.contains(folded_pattern.as_str())
                }
            } else if is_regex {
                regex_search(&pattern, line)
            } else {
                line.contains(pattern.as_str())
            };
            if !hit {
                continue;
            }
            file_count += 1;
            if files_only {
                // 每文件只保留首个命中（含行号）与命中总数，避免整文件命中刷屏。
                if file_first.is_none() {
                    file_first = Some((index + 1, line.chars().take(1000).collect()));
                }
                continue;
            }
            if matches.len() >= limit || used >= context.output_max {
                truncated = true;
                break 'outer;
            }
            let excerpt: String = line.chars().take(1000).collect();
            let mut entry = json!({
                "path": relative,
                "line": index + 1,
                "text": excerpt,
            });
            if before > 0 || after > 0 {
                let context_line = |line: &String| -> String { line.chars().take(1000).collect() };
                let start = index.saturating_sub(before);
                let end = (index + after + 1).min(lines.len());
                let before_lines: Vec<String> = lines[start..index].iter().map(context_line).collect();
                let after_lines: Vec<String> = lines[index + 1..end].iter().map(context_line).collect();
                entry["before"] = json!(before_lines);
                entry["after"] = json!(after_lines);
            }
            used += excerpt.len() + relative.len();
            matches.push(entry);
        }
        if files_only && file_count > 0 {
            if matches.len() >= limit {
                truncated = true;
                break 'outer;
            }
            let (line, text) = file_first.unwrap_or((0, String::new()));
            used += text.len() + relative.len();
            matches.push(json!({
                "path": relative,
                "line": line,
                "text": text,
                "count": file_count,
            }));
        }
    }
    Ok(json!({
        "matches": matches,
        "truncated": truncated,
        // 未参与匹配的文件计数（不改变 matches 形状）：二进制 / 超 output_max / 不可读。
        "skipped": {
            "binary": skipped_binary,
            "too_large": skipped_too_large,
            "unreadable": skipped_unreadable,
        },
    }))
}

// ── op: write ──────────────────────────────────────────────────────────────

fn op_write(
    context: &FsContext,
    path: Option<&str>,
    args: &Value,
    store: &mut GrantStore,
) -> Result<Value, FsError> {
    let path = path.ok_or_else(|| bad_args("path required"))?;
    let data = arg_str(args, "data").ok_or_else(|| bad_args("data required"))?;
    if data.len() > context.output_max {
        return Err(too_large(format!(
            "write payload {} bytes exceeds output_max {}",
            data.len(),
            context.output_max
        )));
    }
    let target = resolve_path_arg(path, context.workspace_root.as_deref())?;
    let (canon, exists) = canonical_or_parent(&target)?;
    context.check_write(inside_workspace(context, &canon), &canon, store)?;
    let expected = arg_str(args, "expected_hash");
    let create = arg_bool(args, "create");
    let exclusive = arg_bool(args, "exclusive");
    let hash = sha256_hex(data.as_bytes());
    // 写互斥：读校验与 rename 同处一个临界区；`exec` 绕过本锁的并发改写由 rename 前复核兜底。
    let _guard = write_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // 独占新建：目标已存在即 edit_conflict（`create_new` 语义），使「新建」只发一次 write、可被单 op grant 覆盖。
    if exclusive {
        if !create {
            return Err(path_not_found("file does not exist (create=false)"));
        }
        if canon.exists() {
            return Err(edit_conflict("file already exists"));
        }
        atomic_write_new(&canon, data.as_bytes())?;
        return Ok(json!({ "bytes_written": data.len(), "created": true, "hash": hash }));
    }
    if exists {
        if !canon.is_file() {
            return Err(not_a_file("expected a file"));
        }
        let mut base: Option<Vec<u8>> = None;
        if let Some(expected) = expected {
            let meta = fs::metadata(&canon).map_err(map_io_error)?;
            if meta.len() as usize > context.output_max {
                return Err(too_large(format!(
                    "existing file {} bytes exceeds output_max {}; expected_hash unavailable",
                    meta.len(),
                    context.output_max
                )));
            }
            let current = read_verified(&canon)?;
            if sha256_hex(&current) != expected {
                return Err(edit_conflict("expected_hash mismatch"));
            }
            base = Some(current);
        }
        // 临时文件 + rename：不跟随目标路径上的符号链接（rename 替换链接本身）。
        atomic_write_verified(&canon, data.as_bytes(), base.as_deref())?;
        Ok(json!({ "bytes_written": data.len(), "created": false, "hash": hash }))
    } else {
        if !create {
            return Err(path_not_found("file does not exist (create=false)"));
        }
        atomic_write_verified(&canon, data.as_bytes(), None)?;
        Ok(json!({ "bytes_written": data.len(), "created": true, "hash": hash }))
    }
}

// ── op: replace ────────────────────────────────────────────────────────────

fn op_replace(
    context: &FsContext,
    path: Option<&str>,
    args: &Value,
    store: &mut GrantStore,
) -> Result<Value, FsError> {
    let path = path.ok_or_else(|| bad_args("path required"))?;
    let old = arg_str(args, "old")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_args("old required"))?;
    let new = arg_str(args, "new").unwrap_or("");
    let replace_all = arg_bool(args, "replace_all");
    let target = resolve_path_arg(path, context.workspace_root.as_deref())?;
    let (canon, exists) = canonical_or_parent(&target)?;
    context.check_write(inside_workspace(context, &canon), &canon, store)?;
    if !exists {
        return Err(path_not_found("file does not exist"));
    }
    if !canon.is_file() {
        return Err(not_a_file("expected a file"));
    }
    // 写互斥：读校验 → 替换计算 → rename 同一临界区；`exec` 绕过本锁的并发改写由 rename 前复核兜底。
    let guard = write_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // 上限预检纳入临界区：避免预检与读之间的并发增长把超大文件整份读进内存；
    // 读本身再按上限截断二次兜底（文件在 metadata 与 read 之间增长时仍不越界）。
    let meta = fs::metadata(&canon).map_err(map_io_error)?;
    if meta.len() as usize > context.output_max {
        return Err(too_large(format!(
            "file {} bytes exceeds output_max {}",
            meta.len(),
            context.output_max
        )));
    }
    let (current, capped) = read_verified_capped(&canon, context.output_max)?;
    if capped {
        return Err(too_large(format!(
            "file exceeds output_max {}",
            context.output_max
        )));
    }
    if has_nul(&current) {
        return Err(binary_unsupported("file contains NUL bytes"));
    }
    let text =
        String::from_utf8(current.clone()).map_err(|_| binary_unsupported("file is not UTF-8"))?;
    if let Some(expected) = arg_str(args, "expected_hash") {
        if sha256_hex(&current) != expected {
            return Err(edit_conflict("expected_hash mismatch"));
        }
    }
    // 行尾口径：直接匹配优先；不中且文件与 old 行尾风格不一致时，按文件风格转换 old/new 再匹配
    // （用别处读到的 LF 文本改 CRLF 文件）。混合行尾的文件不做转换。
    let mut old_used = old.to_string();
    let mut new_used = new.to_string();
    let mut positions: Vec<usize> = text.match_indices(old).map(|(index, _)| index).collect();
    if positions.is_empty() {
        let (adapted_old, adapted_new) = adapt_line_endings(&text, old, new);
        if adapted_old.as_ref() != old {
            let adapted_positions: Vec<usize> =
                text.match_indices(adapted_old.as_ref()).map(|(index, _)| index).collect();
            if !adapted_positions.is_empty() {
                old_used = adapted_old.into_owned();
                new_used = adapted_new.into_owned();
                positions = adapted_positions;
            }
        }
    }
    if positions.is_empty() {
        return Err(edit_conflict("old not found"));
    }
    if positions.len() > 1 && !replace_all {
        // 诊断带上命中行号（最多列 20 处）：模型据此收窄锚点或改用 replace_all，无需再读一遍。
        let line_number = |position: usize| 1 + text[..position].matches('\n').count();
        let mut lines: Vec<String> = positions.iter().take(20).map(|p| line_number(*p).to_string()).collect();
        if positions.len() > lines.len() {
            lines.push("…".to_string());
        }
        return Err(edit_conflict(format!(
            "old is not unique ({} matches at lines {}); use replace_all or a longer anchor",
            positions.len(),
            lines.join(", ")
        )));
    }
    let count = if replace_all { positions.len() } else { 1 };
    let next = if replace_all {
        text.replace(old_used.as_str(), new_used.as_str())
    } else {
        text.replacen(old_used.as_str(), new_used.as_str(), 1)
    };
    if next.len() > context.output_max {
        return Err(too_large(format!(
            "replacement {} bytes exceeds output_max {}",
            next.len(),
            context.output_max
        )));
    }
    atomic_write_verified(&canon, next.as_bytes(), Some(&current))?;
    // rename 已完成，patch 合成不再触盘：先放锁，避免大片段 diff 长时间占用写互斥。
    drop(guard);

    let (added_per, removed_per, diff_lines) = line_diff(&old_used, &new_used);
    let mut patch = String::new();
    for position in positions.iter().take(count) {
        let line_number = 1 + text[..*position].matches('\n').count();
        let old_count = split_lines(&old_used).len().max(1);
        let new_count = split_lines(&new_used).len();
        patch.push_str(&format!(
            "@@ -{line_number},{old_count} +{line_number},{new_count} @@\n"
        ));
        for (marker, line) in &diff_lines {
            patch.push(*marker);
            patch.push_str(line);
            patch.push('\n');
        }
    }
    Ok(json!({
        "replaced": count,
        "added": added_per * count,
        "removed": removed_per * count,
        // 真实写入字节数：原子重写后的整份文件大小（与 `write` 的 bytes_written 同口径）。
        "bytes_written": next.len(),
        "patch": patch,
    }))
}

/// fsop 写互斥：与 grant 存储分开的一把进程内锁，串行化「读校验 → rename」临界区。
/// 收益边界：生产入口 `fsop()` 已持全局 grant 存储锁，把全部 fsop 串行化，故本锁在生产路径下冗余；
/// 保留它是为让 `fsop_with_store`（测试 / 未来按 store 解耦）不依赖 grant 存储实现细节也能保证临界区。
/// 进程内 best-effort，非 OS 级隔离：`exec` 不受此锁约束（见 `atomic_write_verified` 的复核兜底）。
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 在目标同目录写临时文件（sync 落盘），返回临时路径；调用方负责 rename / 清理。
fn write_temp(path: &Path, bytes: &[u8]) -> Result<PathBuf, FsError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".{name}.chrono-tmp-{}-{seq}", std::process::id()));
    {
        let mut file = fs::File::create(&temp)
            .map_err(|err| FsError::new("sandbox_setup_failed", err.to_string()))?;
        file.write_all(bytes)
            .map_err(|err| FsError::new("sandbox_setup_failed", err.to_string()))?;
        file.sync_all()
            .map_err(|err| FsError::new("sandbox_setup_failed", err.to_string()))?;
    }
    Ok(temp)
}

/// 原子写 + rename 前复核：`base` 非 None 时，rename 前重读目标，与 `base` 不符即 `edit_conflict`。
/// 进程内 best-effort：`exec` 可跑任意命令绕过 fsop 写锁，本复核是兜底而非 OS 级隔离。
fn atomic_write_verified(path: &Path, bytes: &[u8], base: Option<&[u8]>) -> Result<(), FsError> {
    let temp = write_temp(path, bytes)?;
    if let Some(base) = base {
        // 区分「读失败」与「内容不符」：外部占用导致读失败是环境问题（sandbox_setup_failed），
        // 只有真正读到且与 base 不符才是 edit_conflict。
        match fs::read(path) {
            Ok(current) if current.as_slice() == base => {}
            Ok(_) => {
                let _ = fs::remove_file(&temp);
                return Err(edit_conflict("file changed between read and rename"));
            }
            Err(err) => {
                let _ = fs::remove_file(&temp);
                return Err(FsError::new(
                    "sandbox_setup_failed",
                    format!("cannot re-read target before rename: {err}"),
                ));
            }
        }
    }
    fs::rename(&temp, path).map_err(|err| {
        let _ = fs::remove_file(&temp);
        FsError::new("sandbox_setup_failed", err.to_string())
    })
}

/// 独占新建：rename 前确认目标仍不存在（`create_new` 语义的进程内 best-effort 版）。
fn atomic_write_new(path: &Path, bytes: &[u8]) -> Result<(), FsError> {
    let temp = write_temp(path, bytes)?;
    if path.exists() {
        let _ = fs::remove_file(&temp);
        return Err(edit_conflict("file already exists"));
    }
    fs::rename(&temp, path).map_err(|err| {
        let _ = fs::remove_file(&temp);
        FsError::new("sandbox_setup_failed", err.to_string())
    })
}

/// 行级 LCS diff：返回（added 行数，removed 行数，逐行标记）。超大片段回落整体替换。
fn line_diff(old: &str, new: &str) -> (usize, usize, Vec<(char, String)>) {
    let old_lines = split_lines(old);
    let new_lines = split_lines(new);
    let (rows, cols) = (old_lines.len(), new_lines.len());
    if rows.saturating_mul(cols) > 4_000_000 {
        let mut ops = Vec::new();
        for line in &old_lines {
            ops.push(('-', line.clone()));
        }
        for line in &new_lines {
            ops.push(('+', line.clone()));
        }
        return (new_lines.len(), old_lines.len(), ops);
    }
    let mut table = vec![vec![0usize; cols + 1]; rows + 1];
    for row in (0..rows).rev() {
        for col in (0..cols).rev() {
            table[row][col] = if old_lines[row] == new_lines[col] {
                table[row + 1][col + 1] + 1
            } else {
                table[row + 1][col].max(table[row][col + 1])
            };
        }
    }
    let mut ops = Vec::new();
    let (mut row, mut col) = (0usize, 0usize);
    while row < rows && col < cols {
        if old_lines[row] == new_lines[col] {
            ops.push((' ', old_lines[row].clone()));
            row += 1;
            col += 1;
        } else if table[row + 1][col] >= table[row][col + 1] {
            ops.push(('-', old_lines[row].clone()));
            row += 1;
        } else {
            ops.push(('+', new_lines[col].clone()));
            col += 1;
        }
    }
    while row < rows {
        ops.push(('-', old_lines[row].clone()));
        row += 1;
    }
    while col < cols {
        ops.push(('+', new_lines[col].clone()));
        col += 1;
    }
    let added = ops.iter().filter(|(marker, _)| *marker == '+').count();
    let removed = ops.iter().filter(|(marker, _)| *marker == '-').count();
    (added, removed, ops)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let id = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "chrono-sandbox-fsop-{}-{}-{}",
                tag,
                std::process::id(),
                id
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn write(&self, relative: &str, content: &str) -> PathBuf {
            let target = self.path.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&target, content).unwrap();
            target
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn bag(dir: &TempDir, op: &str, path: &str, tier: &str, caps: Value, args: Value) -> Value {
        json!({
            "op": op,
            "path": path,
            "args": args,
            "tier": tier,
            "workspace_root": dir.path.to_string_lossy(),
            "caps": caps,
            "sandbox_tiers": crate::tiers::builtin_tiers().to_value(),
        })
    }

    fn call(bag: &Value) -> Value {
        let mut store = GrantStore::new();
        fsop_with_store(bag, 0.0, &mut store)
    }

    fn full_caps() -> Value {
        json!({ "fs": { "read": "full", "write": "full" }, "net": "none" })
    }

    #[test]
    fn stat_read_list_grep_roundtrip() {
        let dir = TempDir::new("basic");
        dir.write("a.txt", "alpha\nbeta\n");
        dir.write("nested/b.rs", "fn main() {}\n");

        let stat = call(&bag(&dir, "stat", "a.txt", "severe", full_caps(), json!({})));
        assert_eq!(stat["ok"], true);
        assert_eq!(stat["result"]["exists"], true);
        assert_eq!(stat["result"]["is_dir"], false);
        assert_eq!(stat["result"]["size"], 11);

        let read = call(&bag(&dir, "read", "a.txt", "severe", full_caps(), json!({})));
        assert_eq!(read["result"]["text"], "alpha\nbeta");
        assert_eq!(read["result"]["total_lines"], 2);

        let window = call(&bag(
            &dir,
            "read",
            "a.txt",
            "severe",
            full_caps(),
            json!({"offset":1,"limit":1}),
        ));
        assert_eq!(window["result"]["text"], "beta");
        assert_eq!(window["result"]["truncated"], true);

        let list = call(&bag(
            &dir,
            "list",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"**/*.rs"}),
        ));
        assert_eq!(list["result"]["paths"], json!(["nested/b.rs"]));

        let grep = call(&bag(&dir, "grep", ".", "severe", full_caps(), json!({"pattern":"beta"})));
        assert_eq!(grep["result"]["matches"][0]["line"], 2);
        assert_eq!(grep["result"]["matches"][0]["text"], "beta");
    }

    #[test]
    fn read_reports_window_metadata() {
        let dir = TempDir::new("read-window");
        dir.write("a.txt", "l1\nl2\nl3\n");
        let window = call(&bag(
            &dir,
            "read",
            "a.txt",
            "severe",
            full_caps(),
            json!({"offset":1,"limit":1}),
        ));
        assert_eq!(window["result"]["text"], "l2");
        assert_eq!(window["result"]["start_line"], 2);
        assert_eq!(window["result"]["end_line"], 2);
        assert_eq!(window["result"]["lines_returned"], 1);
        assert_eq!(window["result"]["has_more"], true);
        assert_eq!(window["result"]["next_offset"], 2);
        assert_eq!(window["result"]["content_truncated"], false);

        // 读到尾部：无更多行，next_offset 为 null。
        let tail = call(&bag(
            &dir,
            "read",
            "a.txt",
            "severe",
            full_caps(),
            json!({"offset":2,"limit":1}),
        ));
        assert_eq!(tail["result"]["has_more"], false);
        assert_eq!(tail["result"]["next_offset"], Value::Null);
        assert_eq!(tail["result"]["end_line"], 3);

        // 越界 offset 被夹到文件尾：空窗口游标为末尾行之后，end_line 为 null。
        let empty = call(&bag(
            &dir,
            "read",
            "a.txt",
            "severe",
            full_caps(),
            json!({"offset":9,"limit":1}),
        ));
        assert_eq!(empty["result"]["lines_returned"], 0);
        assert_eq!(empty["result"]["start_line"], 4);
        assert_eq!(empty["result"]["end_line"], Value::Null);
        assert_eq!(empty["result"]["has_more"], false);
    }

    #[test]
    fn list_is_deterministic() {
        let dir = TempDir::new("order");
        for name in ["z.txt", "a.txt", "m/inner.txt", "b.txt"] {
            dir.write(name, "x");
        }
        let list = call(&bag(&dir, "list", ".", "severe", full_caps(), json!({})));
        assert_eq!(
            list["result"]["paths"],
            json!(["a.txt", "b.txt", "m/inner.txt", "z.txt"])
        );
    }

    #[test]
    fn realpath_outside_denied_by_tier() {
        let dir = TempDir::new("inside");
        let outside = TempDir::new("outside");
        let outside_file = outside.write("secret.txt", "top secret");
        // severe 档只允许工作区内：区外读被拒。
        let denied = call(&bag(
            &dir,
            "read",
            &outside_file.to_string_lossy(),
            "severe",
            full_caps(),
            json!({}),
        ));
        assert_eq!(denied["ok"], false);
        assert_eq!(denied["code"], "fs_denied");
        // auto 档区外可读。
        let allowed = call(&bag(
            &dir,
            "read",
            &outside_file.to_string_lossy(),
            "auto",
            full_caps(),
            json!({}),
        ));
        assert_eq!(allowed["ok"], true);
    }

    #[test]
    fn tier_matrix_fs() {
        let dir = TempDir::new("matrix");
        dir.write("f.txt", "hello");
        // auto：区内读写均过
        assert_eq!(call(&bag(&dir, "read", "f.txt", "auto", full_caps(), json!({})))["ok"], true);
        assert_eq!(
            call(&bag(&dir, "write", "f.txt", "auto", full_caps(), json!({"data":"x"})))["ok"],
            true
        );
        // severe：区内读写均过
        assert_eq!(call(&bag(&dir, "read", "f.txt", "severe", full_caps(), json!({})))["ok"], true);
        assert_eq!(
            call(&bag(&dir, "write", "f.txt", "severe", full_caps(), json!({"data":"y"})))["ok"],
            true
        );
        // review：区内读可、写拒
        assert_eq!(call(&bag(&dir, "read", "f.txt", "review", full_caps(), json!({})))["ok"], true);
        let review_write =
            call(&bag(&dir, "write", "f.txt", "review", full_caps(), json!({"data":"z"})));
        assert_eq!(review_write["code"], "fs_denied");
        // deny：全拒
        assert_eq!(
            call(&bag(&dir, "read", "f.txt", "deny", full_caps(), json!({})))["code"],
            "fs_denied"
        );
        assert_eq!(
            call(&bag(&dir, "write", "f.txt", "deny", full_caps(), json!({"data":"z"})))["code"],
            "fs_denied"
        );
        // 未知档 fail-closed
        assert_eq!(
            call(&bag(&dir, "read", "f.txt", "nope", full_caps(), json!({})))["code"],
            "fs_denied"
        );
    }

    fn grant_bag(dir: &TempDir, op: &str, path: &str, tier: &str, grant: Value) -> Value {
        json!({
            "op": op, "path": path, "args": { "data": "x" },
            "tier": tier, "workspace_root": dir.path.to_string_lossy(),
            "caps": full_caps(), "sandbox_tiers": crate::tiers::builtin_tiers().to_value(),
            "grant": grant,
        })
    }

    #[test]
    fn grant_relaxes_one_call_only() {
        let dir = TempDir::new("grant");
        let outside = TempDir::new("grant-out");
        let outside_file = outside.write("secret.txt", "data");
        let path = outside_file.to_string_lossy().to_string();
        // grant 绑定 op + path，才构成有效放宽。
        let grant = json!({
            "call_id":"call-1","op":"read","tier":"severe",
            "fs":{"read":"full"},"paths":[path.clone()]
        });
        let mut store = GrantStore::new();
        let first = fsop_with_store(&grant_bag(&dir, "read", &path, "severe", grant.clone()), 0.0, &mut store);
        assert_eq!(first["ok"], true, "{first}");
        // 同一 call_id 第二次即拒（不可重放）
        let second = fsop_with_store(&grant_bag(&dir, "read", &path, "severe", grant), 0.0, &mut store);
        assert_eq!(second["ok"], false);
        assert_eq!(second["code"], "fs_denied");
    }

    #[test]
    fn grant_without_paths_is_not_applicable() {
        // paths 空 = 不适用：不构成 grant，越界照拒且不消费。
        let dir = TempDir::new("grant-nopaths");
        let outside = TempDir::new("grant-nopaths-out");
        let outside_file = outside.write("s.txt", "data");
        let mut store = GrantStore::new();
        let grant = json!({"call_id":"np","op":"read","fs":{"read":"full"}});
        let result = fsop_with_store(
            &grant_bag(&dir, "read", &outside_file.to_string_lossy(), "severe", grant),
            0.0,
            &mut store,
        );
        assert_eq!(result["code"], "fs_denied");
        assert!(!store.is_consumed("np"));
    }

    #[test]
    fn grant_paths_must_cover_target() {
        let dir = TempDir::new("grant-path-miss");
        let outside = TempDir::new("grant-path-miss-out");
        let outside_file = outside.write("s.txt", "data");
        let other = outside.write("other.txt", "other");
        let mut store = GrantStore::new();
        let grant = json!({
            "call_id":"pm","op":"read","fs":{"read":"full"},
            "paths":[other.to_string_lossy()],
        });
        let result = fsop_with_store(
            &grant_bag(&dir, "read", &outside_file.to_string_lossy(), "severe", grant),
            0.0,
            &mut store,
        );
        assert_eq!(result["code"], "fs_denied");
        assert!(!store.is_consumed("pm"));
    }

    #[test]
    fn grant_without_fs_does_not_relax_write() {
        let dir = TempDir::new("grant-nofs");
        let outside = TempDir::new("grant-nofs-out");
        let target = outside.write("s.txt", "data");
        let mut store = GrantStore::new();
        let grant = json!({
            "call_id":"nf","op":"write","paths":[target.to_string_lossy()],
        });
        let result = fsop_with_store(
            &grant_bag(&dir, "write", &target.to_string_lossy(), "severe", grant),
            0.0,
            &mut store,
        );
        assert_eq!(result["code"], "fs_denied");
        // 未声明 fs：不得放宽，也不消费凭据。
        assert!(!store.is_consumed("nf"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "data");
    }

    #[test]
    fn grant_op_must_match() {
        let dir = TempDir::new("grant-op");
        let outside = TempDir::new("grant-op-out");
        let target = outside.write("s.txt", "data");
        let mut store = GrantStore::new();
        // 批准的是 read，却用于 write：op 不符，不放宽。
        let grant = json!({
            "call_id":"op","op":"read","fs":{"write":"full"},"paths":[target.to_string_lossy()],
        });
        let result = fsop_with_store(
            &grant_bag(&dir, "write", &target.to_string_lossy(), "severe", grant),
            0.0,
            &mut store,
        );
        assert_eq!(result["code"], "fs_denied");
        assert!(!store.is_consumed("op"));
    }

    #[test]
    fn grant_expiry_uses_frame_now() {
        let dir = TempDir::new("grant-exp");
        let outside = TempDir::new("grant-exp-out");
        let target = outside.write("s.txt", "data");
        let mut store = GrantStore::new();
        let grant = json!({
            "call_id":"exp","op":"read","fs":{"read":"full"},
            "paths":[target.to_string_lossy()],"expires":100.0,
        });
        let expired = fsop_with_store(
            &grant_bag(&dir, "read", &target.to_string_lossy(), "severe", grant.clone()),
            200.0,
            &mut store,
        );
        assert_eq!(expired["code"], "fs_denied");
        assert!(!store.is_consumed("exp"));
        // 未过期时生效（用帧 env.now）。
        let live = fsop_with_store(
            &grant_bag(&dir, "read", &target.to_string_lossy(), "severe", grant),
            50.0,
            &mut store,
        );
        assert_eq!(live["ok"], true, "{live}");
    }

    #[test]
    fn deny_tier_rejects_even_with_grant() {
        let dir = TempDir::new("grant-deny");
        dir.write("f.txt", "hello");
        let mut store = GrantStore::new();
        // deny 档 + 无 paths 的 grant：仍 fs_denied。
        let grant = json!({"call_id":"dn","op":"read","fs":{"read":"full"}});
        let no_paths = fsop_with_store(
            &grant_bag(&dir, "read", "f.txt", "deny", grant),
            0.0,
            &mut store,
        );
        assert_eq!(no_paths["code"], "fs_denied");
        // deny 档 + 完整绑定（op/path/fs）的 grant：同样 fs_denied，且不消费。
        let full_grant = json!({
            "call_id":"dn2","op":"read","fs":{"read":"full"},"paths":[dir.path.to_string_lossy()],
        });
        let bound = fsop_with_store(
            &grant_bag(&dir, "read", "f.txt", "deny", full_grant),
            0.0,
            &mut store,
        );
        assert_eq!(bound["code"], "fs_denied");
        assert!(!store.is_consumed("dn2"));
    }

    #[test]
    fn grant_tier_mismatch_is_ignored() {
        let dir = TempDir::new("grant-tier");
        let outside = TempDir::new("grant-tier-out");
        let outside_file = outside.write("s.txt", "data");
        let mut store = GrantStore::new();
        let result = fsop_with_store(
            &json!({
                "op":"read","path":outside_file.to_string_lossy(),"args":{},
                "tier":"review","workspace_root":dir.path.to_string_lossy(),
                "caps":full_caps(),"sandbox_tiers":crate::tiers::builtin_tiers().to_value(),
                "grant":{"call_id":"c","tier":"severe"},
            }),
            0.0,
            &mut store,
        );
        assert_eq!(result["code"], "fs_denied");
        assert!(!store.is_consumed("c"));
    }

    #[test]
    fn edit_conflict_three_ways() {
        let dir = TempDir::new("conflict");
        dir.write("f.txt", "one two two\n");
        // 未命中
        let missing = call(&bag(
            &dir,
            "replace",
            "f.txt",
            "severe",
            full_caps(),
            json!({"old":"nope","new":"x"}),
        ));
        assert_eq!(missing["code"], "edit_conflict");
        // 非唯一
        let ambiguous = call(&bag(
            &dir,
            "replace",
            "f.txt",
            "severe",
            full_caps(),
            json!({"old":"two","new":"x"}),
        ));
        assert_eq!(ambiguous["code"], "edit_conflict");
        // expected_hash 不符
        let mismatch = call(&bag(
            &dir,
            "replace",
            "f.txt",
            "severe",
            full_caps(),
            json!({"old":"one","new":"1","expected_hash":"deadbeef"}),
        ));
        assert_eq!(mismatch["code"], "edit_conflict");
        // replace_all 成功
        let ok = call(&bag(
            &dir,
            "replace",
            "f.txt",
            "severe",
            full_caps(),
            json!({"old":"two","new":"2","replace_all":true}),
        ));
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["result"]["replaced"], 2);
        assert_eq!(fs::read_to_string(dir.path.join("f.txt")).unwrap(), "one 2 2\n");
    }

    #[test]
    fn replace_patch_and_counts() {
        let dir = TempDir::new("patch");
        dir.write("f.txt", "line1\nold\nline3\n");
        let result = call(&bag(
            &dir,
            "replace",
            "f.txt",
            "severe",
            full_caps(),
            json!({"old":"old","new":"new"}),
        ));
        assert_eq!(result["result"]["added"], 1);
        assert_eq!(result["result"]["removed"], 1);
        let patch = result["result"]["patch"].as_str().unwrap();
        assert!(patch.contains("@@ -2,1 +2,1 @@"));
        assert!(patch.contains("-old"));
        assert!(patch.contains("+new"));
    }

    #[test]
    fn binary_and_read_truncation() {
        let dir = TempDir::new("binary");
        fs::write(dir.path.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        let binary = call(&bag(&dir, "read", "bin.dat", "severe", full_caps(), json!({})));
        assert_eq!(binary["code"], "binary_unsupported");
        // read 超 output_max：返回截断内容 + truncated（非错）。
        dir.write("big.txt", &"a".repeat(100));
        let capped = call(&bag(
            &dir,
            "read",
            "big.txt",
            "severe",
            json!({"fs":{"read":"full","write":"full"},"output_max":10}),
            json!({}),
        ));
        assert_eq!(capped["ok"], true, "{capped}");
        assert_eq!(capped["result"]["truncated"], true);
        assert_eq!(capped["result"]["content_truncated"], true);
        assert_eq!(capped["result"]["has_more"], false);
        assert_eq!(capped["result"]["text"].as_str().unwrap().len(), 10);
    }

    #[test]
    fn read_truncation_keeps_utf8_boundary() {
        let dir = TempDir::new("utf8-cut");
        // 每个汉字 3 字节；上限 4 只能容纳一个汉字，不得切断第二个字符。
        dir.write("cn.txt", "汉字汉字");
        let capped = call(&bag(
            &dir,
            "read",
            "cn.txt",
            "severe",
            json!({"fs":{"read":"full","write":"full"},"output_max":4}),
            json!({}),
        ));
        assert_eq!(capped["ok"], true, "{capped}");
        assert_eq!(capped["result"]["truncated"], true);
        assert_eq!(capped["result"]["text"], "汉");
    }

    #[test]
    fn replace_input_over_output_max_is_too_large() {
        let dir = TempDir::new("replace-large");
        dir.write("big.txt", &"a".repeat(100));
        let result = call(&bag(
            &dir,
            "replace",
            "big.txt",
            "severe",
            json!({"fs":{"read":"full","write":"full"},"output_max":10}),
            json!({"old":"a","new":"b"}),
        ));
        assert_eq!(result["code"], "too_large");
    }

    #[test]
    fn write_does_not_follow_final_symlink() {
        let dir = TempDir::new("write-link");
        let outside = TempDir::new("write-link-out");
        let secret = outside.write("secret.txt", "original");
        let link = dir.path.join("link.txt");
        if create_file_symlink(&secret, &link).is_err() {
            // 无符号链接权限（如 Windows 未开开发者模式）：跳过逃逸用例。
            return;
        }
        // 直接对链接路径原子写：rename 替换链接本身，不写穿到区外目标。
        atomic_write_verified(&link, b"changed", None).unwrap();
        assert_eq!(fs::read_to_string(&secret).unwrap(), "original");
        assert!(!fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&link).unwrap(), "changed");
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[test]
    fn bad_path_forms() {
        let dir = TempDir::new("badpath");
        let empty = call(&bag(&dir, "read", "", "severe", full_caps(), json!({})));
        assert_eq!(empty["code"], "bad_path");
        let nul = call(&bag(&dir, "read", "a\0b", "severe", full_caps(), json!({})));
        assert_eq!(nul["code"], "bad_path");
    }

    #[test]
    fn missing_paths_report_structured_codes() {
        let dir = TempDir::new("missing");
        let missing = call(&bag(&dir, "read", "nope.txt", "severe", full_caps(), json!({})));
        assert_eq!(missing["code"], "path_not_found");
        dir.write("file.txt", "x");
        let not_dir = call(&bag(&dir, "list", "file.txt", "severe", full_caps(), json!({})));
        assert_eq!(not_dir["code"], "not_a_directory");
        let stat_missing = call(&bag(&dir, "stat", "gone.txt", "severe", full_caps(), json!({})));
        assert_eq!(stat_missing["result"]["exists"], false);
    }

    #[test]
    fn write_create_and_expected_hash() {
        let dir = TempDir::new("write");
        let created = call(&bag(
            &dir,
            "write",
            "new.txt",
            "severe",
            full_caps(),
            json!({"data":"hi","create":true}),
        ));
        assert_eq!(created["result"]["created"], true);
        assert_eq!(created["result"]["bytes_written"], 2);
        let hash = created["result"]["hash"].as_str().unwrap().to_string();
        assert_eq!(hash, sha256_hex(b"hi"));
        // create 缺省时不存在即拒
        let refused =
            call(&bag(&dir, "write", "other.txt", "severe", full_caps(), json!({"data":"x"})));
        assert_eq!(refused["code"], "path_not_found");
        // expected_hash 命中
        let ok = call(&bag(
            &dir,
            "write",
            "new.txt",
            "severe",
            full_caps(),
            json!({"data":"yo","expected_hash":hash}),
        ));
        assert_eq!(ok["ok"], true);
    }

    #[test]
    fn unknown_op_is_bad_args() {
        let dir = TempDir::new("unknown");
        let result = call(&bag(&dir, "nope", "a", "severe", full_caps(), json!({})));
        assert_eq!(result["code"], "bad_args");
    }

    #[test]
    fn grep_regex_and_glob_filter() {
        let dir = TempDir::new("grep");
        dir.write("a.rs", "fn alpha() {}\nfn beta() {}\n");
        dir.write("b.txt", "alpha in text\n");
        let result = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"^fn .*\\(\\)","mode":"regex","glob":"*.rs"}),
        ));
        let matches = result["result"]["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0]["path"], "a.rs");
        assert_eq!(matches[0]["line"], 1);
    }

    #[test]
    fn grep_regex_unsupported_is_explicit() {
        let dir = TempDir::new("grep-mode");
        dir.write("a.txt", "foo bar\nfoo|bar\n");
        // 缺省按字面：`|` 不再触发正则，命中字面串 "foo|bar" 行。
        let auto = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"foo|bar"}),
        ));
        assert_eq!(auto["ok"], true, "{auto}");
        assert_eq!(auto["result"]["matches"].as_array().map(Vec::len), Some(1));
        assert_eq!(auto["result"]["matches"][0]["line"], 2);
        // 显式 regex：`|` 结构不在支持子集 → bad_args（绝不静默按字面匹配）。
        let regex = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"foo|bar","mode":"regex"}),
        ));
        assert_eq!(regex["code"], "bad_args", "{regex}");
        // 显式 literal：按字面串命中 "foo|bar" 行。
        let literal = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"foo|bar","mode":"literal"}),
        ));
        assert_eq!(literal["result"]["matches"].as_array().map(Vec::len), Some(1));
        assert_eq!(literal["result"]["matches"][0]["line"], 2);
        // 未知 mode → bad_args。
        let bad = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"foo","mode":"nah"}),
        ));
        assert_eq!(bad["code"], "bad_args");
    }

    #[test]
    fn grep_files_only_ignore_case_and_context() {
        let dir = TempDir::new("grep-plus");
        dir.write("a.txt", "Alpha\nbeta\nGamma\n");
        dir.write("b.txt", "alpha again\n");
        // ignore_case + files_only：每文件一条，带 count。
        let files = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"alpha","ignore_case":true,"files_only":true}),
        ));
        let items = files["result"]["matches"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["path"], "a.txt");
        assert_eq!(items[0]["line"], 1);
        assert_eq!(items[0]["count"], 1);
        assert_eq!(items[1]["path"], "b.txt");

        // 上下文行：before / after 各取一行。
        let ctx = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"beta","before":1,"after":1}),
        ));
        let hit = &ctx["result"]["matches"][0];
        assert_eq!(hit["line"], 2);
        assert_eq!(hit["before"], json!(["Alpha"]));
        assert_eq!(hit["after"], json!(["Gamma"]));
    }

    #[test]
    fn grep_ignore_case_uses_unicode_casefold() {
        let dir = TempDir::new("casefold");
        dir.write("s.txt", "Straße\n");
        // ß → ss 的变长折叠：STRASSE 命中 Straße。
        let result = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"STRASSE","ignore_case":true}),
        ));
        let items = result["result"]["matches"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["path"], "s.txt");
        assert_eq!(items[0]["line"], 1);
    }

    #[test]
    fn edit_conflict_reports_match_lines() {
        let dir = TempDir::new("edit-lines");
        dir.write("f.txt", "dup\nx\ndup\n");
        let result = call(&bag(
            &dir,
            "replace",
            "f.txt",
            "severe",
            full_caps(),
            json!({"old":"dup","new":"D"}),
        ));
        assert_eq!(result["code"], "edit_conflict");
        let message = result["message"].as_str().unwrap_or("");
        assert!(message.contains("2 matches"), "{message}");
        assert!(message.contains("lines 1, 3"), "{message}");
    }

    #[test]
    fn read_invalid_utf8_is_binary_unsupported() {
        let dir = TempDir::new("non-utf8");
        // 0xFF 0xFE 无 NUL 字节：非合法 UTF-8 的伪二进制，不得静默 lossy 解码。
        fs::write(dir.path.join("gbk.dat"), [0xFFu8, 0xFE, 0x41]).unwrap();
        let result = call(&bag(&dir, "read", "gbk.dat", "severe", full_caps(), json!({})));
        assert_eq!(result["code"], "binary_unsupported");
    }

    #[cfg(windows)]
    #[test]
    fn workspace_root_case_insensitive_on_windows() {
        let dir = TempDir::new("case");
        dir.write("f.txt", "hello");
        let mut raw = bag(&dir, "read", "f.txt", "severe", full_caps(), json!({}));
        let upper = dir.path.to_string_lossy().to_uppercase();
        raw["workspace_root"] = json!(upper);
        // Windows 下大小写不敏感：大写根仍判区内；非 Windows 由 canonicalize 归一。
        let result = call(&raw);
        assert_eq!(result["ok"], true, "{result}");
    }

    #[test]
    fn concurrent_expected_hash_replace_serializes() {
        let dir = TempDir::new("toctou");
        dir.write("f.txt", "base\n");
        let expected = sha256_hex(b"base\n");
        let results: Vec<Value> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2u32)
                .map(|index| {
                    let root = dir.path.clone();
                    let expected = expected.clone();
                    scope.spawn(move || {
                        let bag = json!({
                            "op": "replace", "path": "f.txt",
                            "args": {
                                "old": "base", "new": format!("v{index}"),
                                "expected_hash": expected,
                            },
                            "tier": "severe",
                            "workspace_root": root.to_string_lossy(),
                            "caps": full_caps(),
                            "sandbox_tiers": crate::tiers::builtin_tiers().to_value(),
                        });
                        let mut store = GrantStore::new();
                        fsop_with_store(&bag, 0.0, &mut store)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect()
        });
        // 同一 expected_hash 的并发替换：写锁串行化后恰一个成功，另一个读到的已非 base。
        let succeeded = results.iter().filter(|result| result["ok"] == true).count();
        let conflicted = results
            .iter()
            .filter(|result| result["code"] == "edit_conflict")
            .count();
        assert_eq!(succeeded, 1, "{results:?}");
        assert_eq!(conflicted, 1, "{results:?}");
    }

    #[test]
    fn atomic_write_verified_read_failure_is_setup_error() {
        let dir = TempDir::new("verify-read-fail");
        // base 非 None 但目标不可读（不存在）：属环境问题，回 sandbox_setup_failed，不误判为内容已变。
        let target = dir.path.join("missing.txt");
        let err = atomic_write_verified(&target, b"next", Some(b"base")).unwrap_err();
        assert_eq!(err.code, "sandbox_setup_failed");
        assert!(!target.exists());
        let leftovers: Vec<_> = fs::read_dir(&dir.path)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("chrono-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn atomic_write_verified_rejects_stale_base() {
        let dir = TempDir::new("verify-base");
        let target = dir.write("f.txt", "current");
        // rename 前复核发现目标已非读取时的内容：拒写，目标保持原样。
        let err = atomic_write_verified(&target, b"next", Some(b"stale")).unwrap_err();
        assert_eq!(err.code, "edit_conflict");
        assert_eq!(fs::read_to_string(&target).unwrap(), "current");
        // base 命中则正常替换。
        atomic_write_verified(&target, b"next", Some(b"current")).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "next");
    }

    #[test]
    fn ignore_prunes_directories_for_list_and_grep() {
        let dir = TempDir::new("ignore-dir");
        dir.write("keep/a.txt", "needle\n");
        dir.write("node_modules/dep/b.txt", "needle\n");
        dir.write("target/debug/c.txt", "needle\n");
        dir.write("nested/.git/config", "needle\n");

        let list = call(&bag(
            &dir,
            "list",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"**/*.txt","ignore":["node_modules","target",".git"]}),
        ));
        assert_eq!(list["result"]["paths"], json!(["keep/a.txt"]));

        let grep = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"needle","ignore":["node_modules","target",".git"]}),
        ));
        let paths: Vec<&str> = grep["result"]["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["keep/a.txt"]);
    }

    #[test]
    fn read_preserves_crlf_and_replace_adapts_line_endings() {
        let dir = TempDir::new("crlf");
        dir.write("win.txt", "alpha\r\nbeta\r\ngamma\r\n");
        // read 保留原始行尾：窗口文本与文件字节一致。
        let read = call(&bag(&dir, "read", "win.txt", "severe", full_caps(), json!({"offset":1,"limit":1})));
        assert_eq!(read["result"]["text"], "beta\r");
        // 用 LF 形态的 old（如别处读到的文本）替换 CRLF 文件：按文件风格适配后命中。
        let lf = call(&bag(
            &dir,
            "replace",
            "win.txt",
            "severe",
            full_caps(),
            json!({"old":"beta\ngamma","new":"BETA\nGAMMA"}),
        ));
        assert_eq!(lf["ok"], true, "{lf}");
        assert_eq!(lf["result"]["replaced"], 1);
        assert_eq!(
            fs::read_to_string(dir.path.join("win.txt")).unwrap(),
            "alpha\r\nBETA\r\nGAMMA\r\n"
        );
        assert_eq!(lf["result"]["bytes_written"], 20);
    }

    #[test]
    fn write_exclusive_rejects_existing_and_creates_fresh() {
        let dir = TempDir::new("exclusive");
        let created = call(&bag(
            &dir,
            "write",
            "new.txt",
            "severe",
            full_caps(),
            json!({"data":"hi","create":true,"exclusive":true}),
        ));
        assert_eq!(created["result"]["created"], true);
        assert_eq!(fs::read_to_string(dir.path.join("new.txt")).unwrap(), "hi");
        // 已存在即 edit_conflict，且不改内容。
        let conflict = call(&bag(
            &dir,
            "write",
            "new.txt",
            "severe",
            full_caps(),
            json!({"data":"other","create":true,"exclusive":true}),
        ));
        assert_eq!(conflict["code"], "edit_conflict");
        assert_eq!(fs::read_to_string(dir.path.join("new.txt")).unwrap(), "hi");
    }

    #[test]
    fn expected_file_but_directory_is_not_a_file() {
        let dir = TempDir::new("not-a-file");
        dir.write("sub/inner.txt", "x");
        let read = call(&bag(&dir, "read", "sub", "severe", full_caps(), json!({})));
        assert_eq!(read["code"], "not_a_file", "{read}");
        let replace = call(&bag(
            &dir,
            "replace",
            "sub",
            "severe",
            full_caps(),
            json!({"old":"x","new":"y"}),
        ));
        assert_eq!(replace["code"], "not_a_file", "{replace}");
    }

    #[test]
    fn grep_reports_skipped_files() {
        let dir = TempDir::new("grep-skip");
        dir.write("ok.txt", "hit\n");
        dir.write("big.txt", "hit\nhit\n");
        fs::write(dir.path.join("bin.dat"), [0u8, 1, 2]).unwrap();
        // output_max=4：big.txt 超限、bin.dat 归二进制；ok.txt 正常命中。
        let result = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            json!({"fs":{"read":"full","write":"full"},"output_max":4}),
            json!({"pattern":"hit"}),
        ));
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["result"]["skipped"]["binary"], 1, "{result}");
        assert_eq!(result["result"]["skipped"]["too_large"], 1, "{result}");
        assert_eq!(result["result"]["skipped"]["unreadable"], 0, "{result}");
        assert_eq!(result["result"]["matches"].as_array().map(Vec::len), Some(1), "{result}");
    }
}
