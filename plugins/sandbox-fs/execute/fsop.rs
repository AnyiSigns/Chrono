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
use crate::glob::{glob_match, literal_empty_hint, regex_intent, regex_search, regex_unsupported};
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
        "stat" => Ok(("stat", op_stat(&context, path, &args, store)?)),
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

/// 二进制判定：含 NUL 或非合法 UTF-8（伪二进制）。
fn is_binary_bytes(bytes: &[u8]) -> bool {
    has_nul(bytes) || std::str::from_utf8(bytes).is_err()
}

/// 原始字节按 Latin-1 映射为字符串（逐字节 → U+0000..U+00FF，保序、无损）。
/// 用于二进制文件的行切分与 ASCII 模式匹配（非 UTF-8 字节按 Latin-1 解释）。
fn latin1_string(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| *byte as char).collect()
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64 编码（带 `=` 填充，无换行）。
fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let grouped = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[((grouped >> 18) & 0x3f) as usize] as char);
        out.push(BASE64_ALPHABET[((grouped >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(BASE64_ALPHABET[((grouped >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(BASE64_ALPHABET[(grouped & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 小写十六进制编码。
fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 读原始字节并编码（`base64` / `hex`）：按 `output_max` 截断（读上限 + 1 字节判截断），
/// 不要求 UTF-8，故二进制文件也可读。返回编码文本 + 原始字节数 + 截断标记。
fn read_encoded(path: &Path, encoding: &str, max_bytes: usize) -> Result<Value, FsError> {
    let (mut raw, capped) = read_verified_capped(path, max_bytes)?;
    if raw.len() > max_bytes {
        raw.truncate(max_bytes);
    }
    let binary = is_binary_bytes(&raw);
    let text = match encoding {
        "base64" => base64_encode(&raw),
        "hex" => hex_encode(&raw),
        _ => return Err(bad_args(format!("unknown encoding `{encoding}`"))),
    };
    Ok(json!({
        "text": text,
        "encoding": encoding,
        "binary": binary,
        "bytes": raw.len(),
        "content_truncated": capped,
        "truncated": capped,
    }))
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

fn mtime_ms_value(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn mtime_ms(meta: &fs::Metadata) -> Value {
    match mtime_ms_value(meta) {
        Some(ms) => json!(ms),
        None => Value::Null,
    }
}

/// 创建时间（ms）；文件系统不支持时回 null（不冒充 mtime）。
fn ctime_ms(meta: &fs::Metadata) -> Value {
    meta.created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| json!(duration.as_millis() as u64))
        .unwrap_or(Value::Null)
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

fn op_stat(
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
        return Ok(json!({ "exists": false, "is_dir": false, "size": 0, "mtime": Value::Null }));
    }
    let meta = fs::metadata(&canon).map_err(map_io_error)?;
    let mut result = json!({
        "exists": true,
        "is_dir": meta.is_dir(),
        "size": meta.len(),
        "mtime": mtime_ms(&meta),
        "ctime": ctime_ms(&meta),
        // 只读位（跨平台口径：Windows 为只读属性、Unix 为无 owner 写位）；不做完整权限审计。
        "readonly": meta.permissions().readonly(),
    });
    // `recursive:true` + 目录：额外回整棵子树的聚合元信息（总大小 / 最老最新 mtime）。
    // 遍历同 `walk_files`：不跟随目录符号链接、按文件名排序（确定性），不改动单路径字段。
    if meta.is_dir() && arg_bool(args, "recursive") {
        result["aggregate"] = stat_aggregate(&canon);
    }
    Ok(result)
}

/// 目录子树聚合：文件数 / 子目录数 / 总字节数 / 最老与最新 mtime（ms）。不跟随目录符号链接避免环。
fn stat_aggregate(root: &Path) -> Value {
    fn walk(
        dir: &Path,
        files: &mut u64,
        dirs: &mut u64,
        total: &mut u64,
        newest: &mut Option<u64>,
        oldest: &mut Option<u64>,
    ) {
        let Ok(entries) = fs::read_dir(dir) else {
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
                *dirs += 1;
                walk(&path, files, dirs, total, newest, oldest);
            } else if file_type.is_file() {
                *files += 1;
                if let Ok(meta) = fs::metadata(&path) {
                    *total += meta.len();
                    if let Some(ms) = mtime_ms_value(&meta) {
                        if newest.map(|value| ms > value).unwrap_or(true) {
                            *newest = Some(ms);
                        }
                        if oldest.map(|value| ms < value).unwrap_or(true) {
                            *oldest = Some(ms);
                        }
                    }
                }
            }
        }
    }
    let (mut files, mut dirs, mut total) = (0u64, 0u64, 0u64);
    let (mut newest, mut oldest) = (None, None);
    walk(root, &mut files, &mut dirs, &mut total, &mut newest, &mut oldest);
    json!({
        "files": files,
        "dirs": dirs,
        "total_size": total,
        "newest_mtime": newest.map(|ms| json!(ms)).unwrap_or(Value::Null),
        "oldest_mtime": oldest.map(|ms| json!(ms)).unwrap_or(Value::Null),
    })
}

// ── op: read ───────────────────────────────────────────────────────────────

/// 预览模式缺省行数（`preview:true` 且未给 `limit` 时）。
const PREVIEW_LINES: usize = 50;

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
    // `encoding:"base64"|"hex"`：按原始字节读并编码（二进制也可读）；缺省 utf8 保持原有文本口径。
    match arg_str(args, "encoding") {
        Some("utf8") | None => {}
        Some(value @ ("base64" | "hex")) => {
            return read_encoded(&canon, value, context.output_max);
        }
        Some(other) => {
            return Err(bad_args(format!(
                "unknown encoding `{other}` (expected utf8|base64|hex)"
            )))
        }
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
    // 预览模式：只看开头若干行（缺省 50）；显式 limit 仍优先。
    let preview = arg_bool(args, "preview");
    let limit = arg_usize(args, "limit").or(if preview { Some(PREVIEW_LINES) } else { None });
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
        // 生效的预览模式回显（便于区分「只读开头」与整份窗口）。
        "preview": preview,
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
    // `tree:true` 输出层级视图；`depth` 为相对 base 的最大路径段数（1 = 仅直接子项）。
    let tree = arg_bool(args, "tree");
    let depth = arg_usize(args, "depth");
    // `min_depth`：只看相对 base 至少 N 段（与 `depth` 组成区间，缺省 1）。
    let min_depth = arg_usize(args, "min_depth");

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    walk_files(
        &base_canon,
        &base_canon,
        &ignore,
        &mut |file| {
            let relative = relative_slash(&base_canon, file);
            let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if !matches_pattern(&pattern, &relative, &name) || ignored(&ignore, &relative, &name) {
                return;
            }
            let segments = relative.split('/').count();
            if let Some(depth) = depth {
                if segments > depth {
                    return;
                }
            }
            if let Some(min_depth) = min_depth {
                if segments < min_depth {
                    return;
                }
            }
            files.push((relative, file.to_path_buf()));
        },
        &mut |_| {},
    );
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
        paths.push(relative.clone());
    }
    // 因 limit / output_max 未返回的条数（不含被 pattern / ignore / depth 滤掉的，那些本就不入选）。
    let skipped_count = files.len() - paths.len();
    // 截断时在结果主体给出可读警告：明确「这不是全量清单」，避免只看到 truncated 布尔而误当全量。
    let warning = if truncated {
        Some(format!(
            "results truncated: showing {} of {} matched paths ({} not returned); raise `limit` or narrow `pattern` / `depth`",
            paths.len(),
            files.len(),
            skipped_count
        ))
    } else {
        None
    };
    if tree {
        return Ok(json!({
            "tree": render_tree(&paths),
            "truncated": truncated,
            "skipped_count": skipped_count,
            "warning": warning,
        }));
    }
    Ok(json!({
        "paths": paths,
        "truncated": truncated,
        "skipped_count": skipped_count,
        "warning": warning,
    }))
}

/// 把扁平相对路径渲染为层级树：目录在前、文件在后，同级按字典序；过滤后为空的目录剪掉。
/// 每个节点 `{name, path, type:"dir"|"file"}`，目录另有 `children`。`path` 为相对 base 的斜杠路径。
fn render_tree(paths: &[String]) -> Vec<Value> {
    #[derive(Default)]
    struct Node {
        dirs: std::collections::BTreeMap<String, Node>,
        files: Vec<String>,
    }
    fn render(node: &Node, prefix: &str, out: &mut Vec<Value>) {
        let join = |name: &str| -> String {
            if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}/{name}")
            }
        };
        for (name, child) in &node.dirs {
            let path = join(name);
            let mut children = Vec::new();
            render(child, &path, &mut children);
            if children.is_empty() {
                continue;
            }
            out.push(json!({ "name": name, "path": path, "type": "dir", "children": children }));
        }
        for name in &node.files {
            out.push(json!({ "name": name, "path": join(name), "type": "file" }));
        }
    }

    let mut root = Node::default();
    for relative in paths {
        let segments: Vec<&str> = relative.split('/').collect();
        let mut node = &mut root;
        for segment in &segments[..segments.len() - 1] {
            node = node.dirs.entry((*segment).to_string()).or_default();
        }
        if let Some(name) = segments.last() {
            node.files.push((*name).to_string());
        }
    }
    let mut out = Vec::new();
    render(&root, "", &mut out);
    out
}

/// 递归收集文件（不跟随目录符号链接 / junction，避免环）；命中忽略表的目录整棵剪枝。
/// `base` 用于计算相对路径（与忽略表比对）；确定性由调用方排序保证。
/// 被剪掉的目录经 `pruned` 回调上报（相对 `base`，遍历序确定），供结果回显「跳过了哪些目录」。
fn walk_files<F: FnMut(&Path), G: FnMut(&str)>(
    root: &Path,
    base: &Path,
    ignore: &[String],
    visit: &mut F,
    pruned: &mut G,
) {
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
                pruned(&relative);
                continue;
            }
            walk_files(&path, base, ignore, visit, pruned);
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
    let mode_arg = arg_str(args, "mode");
    // 是否显式声明匹配方式：显式声明（含 `regex` 开关）时不自动改写，尊重调用方。
    let mode_declared = mode_arg.is_some()
        || args
            .get("regex")
            .map(|value| !value.is_null())
            .unwrap_or(false);
    let mut is_regex = match mode_arg {
        Some("regex") => true,
        Some("literal") => false,
        Some(other) => {
            return Err(bad_args(format!(
                "unknown grep mode `{other}` (expected literal|regex)"
            )))
        }
        None => args.get("regex").and_then(Value::as_bool).unwrap_or(false),
    };
    // `all`：附加模式数组，命中行须**同时**满足 `pattern` 与 `all` 中每个模式（AND）。
    // OR 已由正则交替 `|` 承担，故这里只补 AND；模式数组与 `pattern` 同语义、同 mode。
    let all_patterns = arg_strings(args, "all");
    // `any`：附加模式数组，命中行**满足其中任一**即可（OR），与主模式一起构成 OR 集合；
    // `any` 为空时 OR 集合仅主模式，行为不变。`all` 仍是 AND。
    let any_patterns = arg_strings(args, "any");
    let mut or_patterns: Vec<String> = Vec::with_capacity(any_patterns.len() + 1);
    or_patterns.push(pattern.clone());
    or_patterns.extend(any_patterns.iter().cloned());
    // 缺省（未显式声明）且模式含强正则信号（`|` / 类简写 / `{n}` 等）时按正则处理，
    // 避免 `TODO|FIXME` 这类模式静默按字面空返；信号模式若语法不合法则回落字面（并给 hint）。
    let regex_signal = or_patterns.iter().any(|value| regex_intent(value));
    if !mode_declared
        && !is_regex
        && regex_signal
        && or_patterns.iter().all(|value| regex_unsupported(value).is_none())
    {
        is_regex = true;
    }
    if is_regex {
        for candidate in or_patterns.iter().chain(all_patterns.iter()) {
            if let Some(reason) = regex_unsupported(candidate) {
                return Err(bad_args(format!("invalid regex: {reason}")));
            }
        }
    }

    let ignore_case = arg_bool(args, "ignore_case");
    let files_only = arg_bool(args, "files_only");
    // `stats`：只回审计聚合（命中文件数 / 命中总数），不逐条回行、不受 `limit` 截断。
    let stats = arg_bool(args, "stats");
    // `binary`：为 true 时把二进制文件按 Latin-1 解码后纳入搜索（而非跳过）；命中条目带 `binary:true`。
    let include_binary = arg_bool(args, "binary");
    let before = arg_usize(args, "before").unwrap_or(0).min(20);
    let after = arg_usize(args, "after").unwrap_or(0).min(20);

    let mut files: Vec<PathBuf> = Vec::new();
    let mut ignored_paths: Vec<String> = Vec::new();
    walk_files(
        &base_canon,
        &base_canon,
        &ignore,
        &mut |file| {
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
        },
        &mut |relative| ignored_paths.push(relative.to_string()),
    );
    files.sort();
    // 忽略表整棵剪掉的目录（相对 base，遍历序确定）；封顶 100 条并标记。
    let ignored_paths_truncated = ignored_paths.len() > 100;
    ignored_paths.truncate(100);

    let folded_or: Vec<String> = if ignore_case {
        or_patterns.iter().map(|value| casefold(value)).collect()
    } else {
        or_patterns.clone()
    };
    let folded_all: Vec<String> = if ignore_case {
        all_patterns.iter().map(|value| casefold(value)).collect()
    } else {
        all_patterns.clone()
    };
    // 命中判定：主模式与 `all` 中每个模式都命中才算命中（AND）；`hay` / 模式已按 ignore_case 归一。
    let pattern_hit = |candidate: &str, hay: &str| -> bool {
        if is_regex {
            regex_search(candidate, hay)
        } else {
            hay.contains(candidate)
        }
    };
    let mut matches = Vec::new();
    let mut used = 0usize;
    let mut truncated = false;
    let mut skipped_binary = 0usize;
    let mut skipped_too_large = 0usize;
    let mut skipped_unreadable = 0usize;
    let mut files_with_matches = 0usize;
    let mut total_matches = 0usize;
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
        let is_binary = is_binary_bytes(&bytes);
        let text = if is_binary {
            if !include_binary {
                skipped_binary += 1;
                continue;
            }
            // 二进制纳搜：按 Latin-1 逐字节映射（ASCII 模式安全；非 UTF-8 字节按 Latin-1 解释）。
            latin1_string(&bytes)
        } else {
            String::from_utf8(bytes).expect("validated utf-8")
        };
        let relative = relative_slash(&base_canon, file);
        let lines = split_lines(&text);
        let mut file_count = 0usize;
        let mut file_first: Option<(usize, String)> = None;
        for (index, line) in lines.iter().enumerate() {
            // ignore_case：模式与命中行同做 Unicode casefold（表驱动，未做 NFC/NFD 规范化）；不改动正则结构校验。
            let folded: String;
            let hay: &str = if ignore_case {
                folded = casefold(line);
                &folded
            } else {
                line.as_str()
            };
            let hit = folded_or.iter().any(|candidate| pattern_hit(candidate, hay))
                && folded_all.iter().all(|candidate| pattern_hit(candidate, hay));
            if !hit {
                continue;
            }
            file_count += 1;
            // `stats`：只计数，不落条目、不受 `limit` 截断。
            if stats {
                continue;
            }
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
            // 仅在二进制命中上标记，文本命中形状不变。
            if is_binary {
                entry["binary"] = json!(true);
            }
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
        if file_count > 0 {
            files_with_matches += 1;
            total_matches += file_count;
        }
        if stats {
            continue;
        }
        if files_only && file_count > 0 {
            if matches.len() >= limit {
                truncated = true;
                break 'outer;
            }
            let (line, text) = file_first.unwrap_or((0, String::new()));
            used += text.len() + relative.len();
            let mut entry = json!({
                "path": relative,
                "line": line,
                "text": text,
                "count": file_count,
            });
            if is_binary {
                entry["binary"] = json!(true);
            }
            matches.push(entry);
        }
    }
    let mode_label = if is_regex { "regex" } else { "literal" };
    // 空结果的诊断优先级：先看 glob 是否把候选滤空（最易被误判为「模式没命中」），再看字面模式是否像正则。
    let hint = if !(matches.is_empty() && total_matches == 0) {
        None
    } else if glob_filter.is_some() && files.is_empty() {
        Some(
            "glob matched no files; check the `glob` filter (brace groups like *.{py,yml} are supported)."
                .to_string(),
        )
    } else if !is_regex {
        literal_empty_hint(&pattern)
    } else {
        None
    };
    // 完整性警告：结果可能不完整时在主体明确说明（截断 / 二进制 / 超限 / 不可读被跳过），
    // 避免调用方把局部结果当全量、漏掉敏感信息。
    let mut caveats: Vec<String> = Vec::new();
    if truncated {
        caveats.push("results truncated; raise `limit` or narrow the search".to_string());
    }
    if skipped_binary > 0 {
        caveats.push(format!("{skipped_binary} binary file(s) skipped (contents not searched)"));
    }
    if skipped_too_large > 0 {
        caveats.push(format!("{skipped_too_large} file(s) over output_max skipped"));
    }
    if skipped_unreadable > 0 {
        caveats.push(format!("{skipped_unreadable} unreadable file(s) skipped"));
    }
    let warning = if caveats.is_empty() {
        None
    } else {
        Some(caveats.join("; "))
    };
    let mut result = json!({
        "matches": matches,
        "truncated": truncated,
        // 审计统计：参与匹配的候选文件数（已过 glob / ignore 过滤），与 skipped 一起核对扫描完整性。
        "files_scanned": files.len(),
        // 未参与匹配的文件计数（不改变 matches 形状）：二进制 / 超 output_max / 不可读。
        "skipped": {
            "binary": skipped_binary,
            "too_large": skipped_too_large,
            "unreadable": skipped_unreadable,
        },
        // 生效参数回显：空结果时据此判断「是路径 / glob / ignore 滤没了，还是模式没命中」。
        "mode": mode_label,
        // 是否把二进制文件纳入搜索（命中条目另带 `binary:true`）。
        "binary": include_binary,
        "base": base_canon.to_string_lossy().replace('\\', "/"),
        "glob": glob_filter,
        "ignore": ignore,
        // 忽略表实际整棵剪掉的目录（相对 base，遍历序）；让「跳过了哪些」可见。
        "ignored_paths": ignored_paths,
        "ignored_paths_truncated": ignored_paths_truncated,
        // 仅当「缺省字面 + 空结果 + 模式像正则」时给出，纯文本空结果不打扰。
        "hint": hint,
        // 结果可能不完整时的主体警告（截断 / 跳过二进制等）；完整时为 null。
        "warning": warning,
    });
    // `stats:true`：只回聚合计数（不逐条回行）；`matches` 为空数组，另有 `stats` 对象。
    if stats {
        result["stats"] = json!({
            "files_with_matches": files_with_matches,
            "total_matches": total_matches,
        });
    }
    Ok(result)
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
    fn grep_regex_alternation_supported_and_syntax_errors_explicit() {
        let dir = TempDir::new("grep-mode");
        dir.write("a.txt", "foo bar\nfoo|bar\n");
        // 缺省：含 `|` 的强正则信号 → 自动按正则 → 两行都命中（`foo` / `foo|bar`）。
        let auto = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"foo|bar"}),
        ));
        assert_eq!(auto["ok"], true, "{auto}");
        assert_eq!(auto["result"]["mode"], "regex", "{auto}");
        assert_eq!(auto["result"]["matches"].as_array().map(Vec::len), Some(2), "{auto}");
        // 显式 regex：交替现已支持 → 两行都命中（`foo` / `foo|bar`）。
        let regex = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"foo|bar","mode":"regex"}),
        ));
        assert_eq!(regex["ok"], true, "{regex}");
        assert_eq!(regex["result"]["matches"].as_array().map(Vec::len), Some(2), "{regex}");
        // 真语法错误（未闭合分组）才 bad_args。
        let bad_regex = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"(foo","mode":"regex"}),
        ));
        assert_eq!(bad_regex["code"], "bad_args", "{bad_regex}");
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
    fn grep_empty_literal_regex_like_reports_hint_and_echo() {
        let dir = TempDir::new("grep-hint");
        dir.write("a.rs", "fn main() {}\n");
        // 缺省含 `|` → 自动走正则（不再静默字面），无命中也不给 hint（并非字面搜索）。
        let auto = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "TODO|FIXME", "glob": "*.rs", "ignore": ["node_modules"]}),
        ));
        assert_eq!(auto["result"]["mode"], "regex", "{auto}");
        assert_eq!(auto["result"]["hint"], Value::Null, "{auto}");
        assert_eq!(auto["result"]["glob"], "*.rs");
        assert_eq!(auto["result"]["ignore"], json!(["node_modules"]));
        // 显式 literal：字面搜索空返 → hint 提示可改 mode:"regex"。
        let literal = call(
            &bag(&dir, "grep", ".", "severe", full_caps(), json!({
                "pattern": "TODO|FIXME", "mode": "literal", "glob": "*.rs"
            })),
        );
        assert_eq!(literal["result"]["mode"], "literal", "{literal}");
        assert!(
            literal["result"]["hint"].as_str().unwrap_or("").contains("mode"),
            "literal hint should suggest regex mode: {literal}"
        );
        // 纯文本空结果不给 hint。
        let plain = call(
            &bag(&dir, "grep", ".", "severe", full_caps(), json!({"pattern": "nonexistent"})),
        );
        assert_eq!(plain["result"]["hint"], Value::Null, "{plain}");
        // 命中时也不给 hint。
        let hit = call(
            &bag(&dir, "grep", ".", "severe", full_caps(), json!({"pattern": "fn main"})),
        );
        assert_eq!(hit["result"]["hint"], Value::Null, "{hit}");
    }

    #[test]
    fn grep_brace_glob_and_no_match_hint() {
        let dir = TempDir::new("grep-brace");
        dir.write("a.py", "key = 1\n");
        dir.write("b.yml", "key: 2\n");
        dir.write("c.rs", "key = 3\n");
        // `{py,yml}` 大括号分组：只搜这两类，rs 不参与；files_scanned 回显候选数。
        let grouped = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "key", "glob": "*.{py,yml}"}),
        ));
        assert_eq!(grouped["result"]["files_scanned"], 2, "{grouped}");
        let paths: Vec<String> = grouped["result"]["matches"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["path"].as_str().map(str::to_string))
            .collect();
        assert_eq!(paths, vec!["a.py".to_string(), "b.yml".to_string()]);
        // glob 一个都匹配不到：显式提示，避免被误当成「模式没命中」。
        let empty = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "key", "glob": "*.{txt,md}"}),
        ));
        assert_eq!(empty["result"]["files_scanned"], 0, "{empty}");
        assert!(
            empty["result"]["hint"].as_str().unwrap_or("").contains("glob"),
            "glob no-match should hint: {empty}"
        );
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
        // 被忽略整棵剪掉的目录可见，供调用方确认搜索范围。
        let ignored: Vec<&str> = grep["result"]["ignored_paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert!(ignored.contains(&"node_modules"), "{grep}");
        assert!(ignored.contains(&"target"), "{grep}");
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
        // 跳过项在主体有可读警告，避免把部分结果当全量而漏报。
        let warning = result["result"]["warning"].as_str().unwrap_or("");
        assert!(warning.contains("binary"), "skipped binary should warn: {result}");
        assert!(warning.contains("output_max"), "too_large should warn: {result}");
        assert_eq!(result["result"]["matches"].as_array().map(Vec::len), Some(1), "{result}");
    }

    #[test]
    fn grep_truncated_reports_warning() {
        let dir = TempDir::new("grep-trunc");
        dir.write("a.txt", "hit\nhit\nhit\n");
        let result = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern":"hit","limit":1}),
        ));
        assert_eq!(result["result"]["truncated"], true, "{result}");
        assert!(
            result["result"]["warning"].as_str().unwrap_or("").contains("truncated"),
            "truncated grep should warn: {result}"
        );
    }

    #[test]
    fn list_depth_tree_and_skipped_count() {
        let dir = TempDir::new("list-tree");
        dir.write("root.rs", "x");
        dir.write("src/a.rs", "x");
        dir.write("src/deep/b.rs", "x");
        // depth=1：只保留相对 base 的 1 段路径（直接子文件）。
        let shallow = call(&bag(
            &dir,
            "list",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "**/*.rs", "depth": 1}),
        ));
        assert_eq!(shallow["result"]["paths"], json!(["root.rs"]), "{shallow}");
        // tree=true：层级视图，目录在前、文件在后。
        let tree = call(&bag(
            &dir,
            "list",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "**/*.rs", "tree": true}),
        ));
        assert!(tree["result"].get("paths").is_none(), "{tree}");
        let nodes = tree["result"]["tree"].as_array().unwrap();
        assert_eq!(nodes[0]["name"], "src");
        assert_eq!(nodes[0]["type"], "dir");
        assert_eq!(nodes[0]["children"][0]["name"], "deep");
        assert_eq!(nodes[0]["children"][0]["type"], "dir");
        assert_eq!(nodes[0]["children"][0]["children"][0]["name"], "b.rs");
        assert_eq!(nodes[0]["children"][1]["name"], "a.rs");
        assert_eq!(nodes[1]["name"], "root.rs");
        assert_eq!(nodes[1]["type"], "file");
        // limit 截断时回 skipped_count（漏了多少条）。
        let capped = call(&bag(
            &dir,
            "list",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "**/*.rs", "limit": 1}),
        ));
        assert_eq!(capped["result"]["truncated"], true, "{capped}");
        assert_eq!(capped["result"]["skipped_count"], 2, "{capped}");
        assert!(
            capped["result"]["warning"].as_str().unwrap_or("").contains("truncated"),
            "truncated list should warn: {capped}"
        );
    }

    #[test]
    fn read_preview_defaults_to_50_lines() {
        let dir = TempDir::new("read-preview");
        let content: String = (1..=120).map(|index| format!("line{index}\n")).collect();
        dir.write("f.txt", &content);
        // 预览缺省 50 行，可续读。
        let preview = call(&bag(
            &dir,
            "read",
            "f.txt",
            "severe",
            full_caps(),
            json!({"preview": true}),
        ));
        assert_eq!(preview["ok"], true, "{preview}");
        assert_eq!(preview["result"]["preview"], true);
        assert_eq!(preview["result"]["total_lines"], 120);
        assert_eq!(preview["result"]["lines_returned"], 50);
        assert_eq!(preview["result"]["has_more"], true);
        assert_eq!(preview["result"]["next_offset"], 50);
        // 显式 limit 覆盖预览缺省。
        let capped = call(&bag(
            &dir,
            "read",
            "f.txt",
            "severe",
            full_caps(),
            json!({"preview": true, "limit": 5}),
        ));
        assert_eq!(capped["result"]["lines_returned"], 5);
        assert_eq!(capped["result"]["next_offset"], 5);
        // 非预览：缺省整份（sandbox 层 limit 缺省为全文）。
        let full = call(&bag(&dir, "read", "f.txt", "severe", full_caps(), json!({})));
        assert_eq!(full["result"]["preview"], false);
        assert_eq!(full["result"]["lines_returned"], 120);
    }

    #[test]
    fn stat_recursive_aggregates_subtree() {
        let dir = TempDir::new("stat-agg");
        dir.write("a.txt", "abc");
        dir.write("sub/b.txt", "de");
        let recursive = call(&bag(
            &dir,
            "stat",
            ".",
            "severe",
            full_caps(),
            json!({"recursive": true}),
        ));
        assert_eq!(recursive["ok"], true, "{recursive}");
        let aggregate = &recursive["result"]["aggregate"];
        assert_eq!(aggregate["files"], 2, "{recursive}");
        assert_eq!(aggregate["dirs"], 1, "{recursive}");
        assert_eq!(aggregate["total_size"], 5, "{recursive}");
        assert!(aggregate["newest_mtime"].is_u64(), "{recursive}");
        assert!(aggregate["oldest_mtime"].is_u64(), "{recursive}");
        // 非递归：不动单路径结果形状，也不回 aggregate。
        let plain = call(&bag(&dir, "stat", ".", "severe", full_caps(), json!({})));
        assert_eq!(plain["result"]["is_dir"], true);
        assert!(plain["result"].get("aggregate").is_none(), "{plain}");
    }

    #[test]
    fn grep_all_requires_every_pattern_on_same_line() {
        let dir = TempDir::new("grep-all");
        dir.write("a.txt", "alpha beta\nbeta only\nalpha only\n");
        // `pattern` + `all` 为 AND：只有同时含 alpha 与 beta 的行命中。
        let result = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "alpha", "all": ["beta"]}),
        ));
        let items = result["result"]["matches"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{result}");
        assert_eq!(items[0]["line"], 1, "{result}");
    }

    #[test]
    fn grep_any_matches_either_pattern() {
        let dir = TempDir::new("grep-any");
        dir.write("a.txt", "alpha\nbeta\ngamma\n");
        // `pattern` 与 `any` 构成 OR：alpha 或 beta 的行都命中。
        let result = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "alpha", "any": ["beta"]}),
        ));
        let lines: Vec<u64> = result["result"]["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["line"].as_u64().unwrap())
            .collect();
        assert_eq!(lines, vec![1, 2], "{result}");
    }

    #[test]
    fn list_min_depth_filters_shallow_files() {
        let dir = TempDir::new("min-depth");
        dir.write("root.rs", "x");
        dir.write("src/a.rs", "x");
        dir.write("src/deep/b.rs", "x");
        let deep = call(&bag(
            &dir,
            "list",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "**/*.rs", "min_depth": 2}),
        ));
        assert_eq!(
            deep["result"]["paths"],
            json!(["src/a.rs", "src/deep/b.rs"]),
            "{deep}"
        );
    }

    #[test]
    fn stat_reports_ctime_and_readonly() {
        let dir = TempDir::new("stat-meta");
        dir.write("a.txt", "x");
        let result = call(&bag(&dir, "stat", "a.txt", "severe", full_caps(), json!({})));
        assert_eq!(result["result"]["readonly"], false, "{result}");
        // ctime 可能为 null（文件系统不支持），字段须存在。
        assert!(result["result"].get("ctime").is_some(), "{result}");
    }

    #[test]
    fn read_encoding_base64_and_hex() {
        let dir = TempDir::new("read-enc");
        fs::write(dir.path.join("bin.dat"), [0u8, 1, 2, 0xff, 0x41]).unwrap();
        let base64 = call(&bag(
            &dir,
            "read",
            "bin.dat",
            "severe",
            full_caps(),
            json!({"encoding": "base64"}),
        ));
        assert_eq!(base64["ok"], true, "{base64}");
        assert_eq!(base64["result"]["text"], "AAEC/0E=", "{base64}");
        assert_eq!(base64["result"]["binary"], true, "{base64}");
        assert_eq!(base64["result"]["bytes"], 5, "{base64}");
        let hex = call(&bag(
            &dir,
            "read",
            "bin.dat",
            "severe",
            full_caps(),
            json!({"encoding": "hex"}),
        ));
        assert_eq!(hex["result"]["text"], "000102ff41", "{hex}");
        // 文本文件按编码读：binary=false。
        dir.write("a.txt", "hi");
        let text_b64 = call(&bag(
            &dir,
            "read",
            "a.txt",
            "severe",
            full_caps(),
            json!({"encoding": "base64"}),
        ));
        assert_eq!(text_b64["result"]["binary"], false, "{text_b64}");
        assert_eq!(text_b64["result"]["text"], "aGk=", "{text_b64}");
        // 未知编码 → bad_args。
        let bad = call(&bag(
            &dir,
            "read",
            "a.txt",
            "severe",
            full_caps(),
            json!({"encoding": "rot13"}),
        ));
        assert_eq!(bad["code"], "bad_args", "{bad}");
    }

    #[test]
    fn grep_binary_searches_raw_bytes_when_enabled() {
        let dir = TempDir::new("grep-bin");
        fs::write(dir.path.join("bin.dat"), [0u8, b's', b'e', b'c', b'r', b'e', b't', 0u8]).unwrap();
        // 默认：二进制被跳过，命中为空且计入 skipped.binary。
        let skipped = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "secret"}),
        ));
        assert_eq!(skipped["result"]["matches"], json!([]), "{skipped}");
        assert_eq!(skipped["result"]["skipped"]["binary"], 1, "{skipped}");
        // binary=true：按 Latin-1 搜到，条目带 binary:true。
        let found = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "secret", "binary": true}),
        ));
        let items = found["result"]["matches"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{found}");
        assert_eq!(items[0]["binary"], true, "{found}");
        assert_eq!(found["result"]["skipped"]["binary"], 0, "{found}");
        assert_eq!(found["result"]["binary"], true, "{found}");
    }

    #[test]
    fn grep_stats_reports_aggregate_counts() {
        let dir = TempDir::new("grep-stats");
        dir.write("a.txt", "hit\nhit\n");
        dir.write("b.txt", "hit\n");
        let result = call(&bag(
            &dir,
            "grep",
            ".",
            "severe",
            full_caps(),
            json!({"pattern": "hit", "stats": true}),
        ));
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["result"]["matches"], json!([]), "{result}");
        assert_eq!(result["result"]["stats"]["files_with_matches"], 2, "{result}");
        assert_eq!(result["result"]["stats"]["total_matches"], 3, "{result}");
        // 非 stats：不注入 stats 字段。
        let plain = call(&bag(&dir, "grep", ".", "severe", full_caps(), json!({"pattern": "hit"})));
        assert!(plain["result"].get("stats").is_none(), "{plain}");
    }
}
