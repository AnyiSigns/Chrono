// 一次性进程执行 `exec`：cwd = workspace_root；子进程环境**清空后**只注入最小白名单 + `args.env`；
// 资源上限（timeout_ms / mem_mb / cpu_ms / output_max / procs_max）超限杀**整树**；
// stdout / stderr 截断到 output_max（标记 truncated）；返回 `{exit_code, stdout, stderr, truncated, duration_ms, code?}`。
// win32 原生后端走 Job Object（`win32.rs`）；linux / mac 原生未验证 → `sandbox_unsupported`（诚实口径）。
// 计时用系统单调时钟（`Instant`）：exec 本身是效果、结果进审计，单调计时是运行态观测、不落世界、不影响可回放。

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::tiers::{FsScope, NetScope};

/// 一次执行的隔离上下文：由调用方从「声明 caps ∩ 当前档」解析后随请求传入。
/// 缺省（读 / 写 `Full`、net `All`、无 `workspace_root`）表示不限制。
/// 机器能力（landlock / cgroup / seccomp 是否可用）只走运行态探测，不由此结构承载。
/// 字段仅在 Linux 原生隔离里被读取，其余平台保留形状以免调用方分叉。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Debug)]
pub struct Isolation {
    pub workspace_root: Option<PathBuf>,
    pub fs_read: FsScope,
    pub fs_write: FsScope,
    pub net: NetScope,
}

impl Default for Isolation {
    fn default() -> Self {
        Self {
            workspace_root: None,
            fs_read: FsScope::Full,
            fs_write: FsScope::Full,
            net: NetScope::All,
        }
    }
}

/// 一次 exec 的入参（资源上限由调用方从 caps / 档位缺省解析后传入）。
#[derive(Clone, Debug)]
pub struct ExecRequest {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
    pub timeout_ms: u64,
    pub mem_mb: u64,
    pub cpu_ms: u64,
    pub procs_max: u32,
    pub output_max: usize,
    pub isolation: Isolation,
}

/// exec 结果；`code` 仅在超时 / 超限被杀时出现（`timeout` / `oom` / `cpu_exceeded` / `procs_max`）。
#[derive(Clone, Debug)]
pub struct ExecOutcome {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    /// 被头尾截断丢弃的字节数（stdout + stderr 合计）；未截断为 0。
    pub omitted_bytes: usize,
    /// 按到达顺序合并的 stdout / stderr 分块（`(is_stderr, text)`），保留交错关系。
    pub combined: Vec<(bool, String)>,
    /// 合并流是否因超 `output_max` 被截尾。
    pub combined_truncated: bool,
    pub duration_ms: u64,
    pub code: Option<String>,
}

/// exec 前置失败（结构化码）。`Unsupported` 只在非 win32 分支构造。
#[derive(Clone, Debug)]
pub enum ExecError {
    #[cfg_attr(any(windows, target_os = "linux"), allow(dead_code))]
    Unsupported(String),
    Setup(String),
}

impl ExecError {
    pub fn code(&self) -> &'static str {
        match self {
            ExecError::Unsupported(_) => "sandbox_unsupported",
            ExecError::Setup(_) => "sandbox_setup_failed",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            ExecError::Unsupported(message) | ExecError::Setup(message) => message,
        }
    }
}

/// 子进程最小环境白名单：只保留常用命令运行所必需的系统变量与用户位置变量。
/// 用户位置变量（`USERPROFILE` / `APPDATA` / `HOME` 等）不是密钥，但缺失会让 git / npm / python
/// 等工具找不到配置与缓存而失败；密钥仍只能经 `args.env` 显式下传，宿主其余环境一律不继承。
#[cfg(windows)]
const MINIMAL_ENV_KEYS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "TEMP",
    "TMP",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "USERNAME",
    "PSModulePath",
];

#[cfg(not(windows))]
const MINIMAL_ENV_KEYS: &[&str] =
    &["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL", "TERM"];

/// 取宿主进程里的最小白名单环境（键大小写不敏感，值原样保留）。
pub(crate) fn minimal_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut out = Vec::new();
    for (key, value) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if MINIMAL_ENV_KEYS
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&key_text))
        {
            out.push((key, value));
        }
    }
    out
}

/// 统一资源上限边界：`limit > 0` 且 `value >= limit` 即视为到达上限。
fn limit_reached(value: u64, limit: u64) -> bool {
    limit > 0 && value >= limit
}

fn env_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// 解析 exec 的 bag：顶层 `{cmd, args, env}` 与 `{args:{cmd, args, env}}` 两种形状都接受。
pub fn parse_request(bag: &Value, output_max: usize) -> Result<ExecRequest, ExecError> {
    let inner = if bag.get("cmd").is_some() || bag.get("command").is_some() || bag.get("program").is_some() {
        bag.clone()
    } else if bag.get("args").map(Value::is_object).unwrap_or(false) {
        bag.get("args").cloned().unwrap_or_else(|| bag.clone())
    } else {
        bag.clone()
    };
    let cmd = inner
        .get("cmd")
        .or_else(|| inner.get("command"))
        .or_else(|| inner.get("program"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ExecError::Setup("cmd required".to_string()))?;
    if cmd.trim().is_empty() {
        return Err(ExecError::Setup("cmd must not be empty".to_string()));
    }
    let args = match inner.get("args") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    };
    let env = inner
        .get("env")
        .or_else(|| bag.get("env"))
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| env_string(value).map(|text| (key.clone(), text)))
                .collect()
        })
        .unwrap_or_default();
    let cwd = bag
        .get("cwd")
        .or_else(|| inner.get("cwd"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            bag.get("workspace_root")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .map(PathBuf::from);
    Ok(ExecRequest {
        cmd,
        args,
        env,
        cwd,
        timeout_ms: 0,
        mem_mb: 0,
        cpu_ms: 0,
        procs_max: 0,
        output_max,
        isolation: Isolation::default(),
    })
}

/// 执行一次；平台无原生实现即 `sandbox_unsupported`。
pub fn run(request: &ExecRequest) -> Result<ExecOutcome, ExecError> {
    #[cfg(windows)]
    {
        run_native(request)
    }
    #[cfg(target_os = "linux")]
    {
        run_linux(request)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = request;
        Err(ExecError::Unsupported(
            "native exec isolation is not implemented on this platform".to_string(),
        ))
    }
}

/// 截断标记预留：头尾之间插入省略标记，预留固定字节，保证最终文本不超过 `output_max`。
const TRUNCATION_MARKER_RESERVE: usize = 48;

/// 单流输出捕获：边读边保留头 `head_limit` + 尾 `tail_limit`，中间丢弃并计数，避免无上限缓冲。
struct StreamCapture {
    head: Vec<u8>,
    tail: std::collections::VecDeque<u8>,
    head_limit: usize,
    tail_limit: usize,
    total: usize,
}

impl StreamCapture {
    fn new(limit: usize) -> Self {
        let budget = limit.saturating_sub(TRUNCATION_MARKER_RESERVE).max(1);
        let head_limit = (budget * 7 / 10).max(1);
        let tail_limit = budget - head_limit;
        Self {
            head: Vec::new(),
            tail: std::collections::VecDeque::new(),
            head_limit,
            tail_limit,
            total: 0,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.total = self.total.saturating_add(chunk.len());
        let mut rest = chunk;
        if self.head.len() < self.head_limit {
            let take = (self.head_limit - self.head.len()).min(rest.len());
            self.head.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
        if rest.is_empty() || self.tail_limit == 0 {
            return;
        }
        self.tail.extend(rest.iter().copied());
        while self.tail.len() > self.tail_limit {
            self.tail.pop_front();
        }
    }

    /// 收尾文本：未超限即全文；超限则「头 … 省略标记 … 尾」，两端各自夹到合法 UTF-8 边界。
    fn finish(self) -> (String, bool, usize) {
        let StreamCapture {
            head,
            tail,
            head_limit,
            tail_limit,
            total,
        } = self;
        let limit = head_limit + tail_limit;
        if total <= limit {
            let mut bytes = head;
            bytes.extend(tail.iter().copied());
            return (String::from_utf8_lossy(&bytes).into_owned(), false, 0);
        }
        let tail: Vec<u8> = tail.into_iter().collect();
        let head_text = String::from_utf8_lossy(utf8_prefix(&head)).into_owned();
        let tail_text = String::from_utf8_lossy(utf8_suffix(&tail)).into_owned();
        let omitted = total.saturating_sub(head.len() + tail.len());
        let text = format!("{head_text}\n… [{omitted} bytes omitted] …\n{tail_text}");
        (text, true, omitted)
    }
}

/// 对已完成文本套用与 `exec` 一致的头尾截断口径（会话合并输出用）。
pub fn capture_text(text: &str, limit: usize) -> (String, bool, usize) {
    let mut capture = StreamCapture::new(limit);
    capture.push(text.as_bytes());
    capture.finish()
}

/// 最长合法 UTF-8 前缀（最多回退 3 字节）。
fn utf8_prefix(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 {
        if std::str::from_utf8(&bytes[..end]).is_ok() {
            return &bytes[..end];
        }
        end -= 1;
    }
    &bytes[..0]
}

/// 最长合法 UTF-8 后缀（最多前进 3 字节）。
pub(crate) fn utf8_suffix(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < bytes.len() {
        if std::str::from_utf8(&bytes[start..]).is_ok() {
            return &bytes[start..];
        }
        start += 1;
    }
    &bytes[bytes.len()..]
}

/// 有序分块缓冲：逐流头尾截断 + 一份按到达序合并的 stdout / stderr 分块（保交错）。
struct OrderedCapture {
    out: StreamCapture,
    err: StreamCapture,
    combined: Vec<(bool, String)>,
    combined_bytes: usize,
    combined_dropped: bool,
    limit: usize,
}

impl OrderedCapture {
    fn new(limit: usize) -> Self {
        Self {
            out: StreamCapture::new(limit),
            err: StreamCapture::new(limit),
            combined: Vec::new(),
            combined_bytes: 0,
            combined_dropped: false,
            limit,
        }
    }

    /// 记一块输出：逐流照常截断；合并流按到达序拼接，超 `output_max` 丢尾。
    fn apply(&mut self, is_err: bool, bytes: &[u8]) {
        if is_err {
            self.err.push(bytes);
        } else {
            self.out.push(bytes);
        }
        let text = String::from_utf8_lossy(bytes).into_owned();
        if text.is_empty() {
            return;
        }
        if self.combined_bytes + text.len() <= self.limit {
            self.combined_bytes += text.len();
            match self.combined.last_mut() {
                Some((last_err, last_text)) if *last_err == is_err => last_text.push_str(&text),
                _ => self.combined.push((is_err, text)),
            }
        } else {
            self.combined_dropped = true;
        }
    }

    fn finish(self) -> (String, String, bool, usize, Vec<(bool, String)>, bool) {
        let OrderedCapture {
            out,
            err,
            combined,
            combined_dropped,
            ..
        } = self;
        let (stdout, stdout_truncated, stdout_omitted) = out.finish();
        let (stderr, stderr_truncated, stderr_omitted) = err.finish();
        (
            stdout,
            stderr,
            stdout_truncated || stderr_truncated,
            stdout_omitted + stderr_omitted,
            combined,
            combined_dropped,
        )
    }
}

/// 逐流读线程：把块按到达序推入共享通道（`bool` = 是否 stderr）。
fn spawn_ordered<R: Read + Send + 'static>(
    reader: Option<R>,
    is_err: bool,
    tx: std::sync::mpsc::Sender<(bool, Vec<u8>)>,
) {
    std::thread::spawn(move || {
        let Some(mut reader) = reader else {
            return;
        };
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if tx.send((is_err, chunk[..read].to_vec())).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn set_reason(slot: &mut Option<String>, value: &str) {
    if slot.is_none() {
        *slot = Some(value.to_string());
    }
}

/// 已挂起的原生进程 + 其 Job（Job 句柄须存活至进程结束；Arc 供任务注册表与监视线程共享）。
#[cfg(windows)]
pub struct SpawnedProcess {
    pub child: std::process::Child,
    pub pid: u32,
    pub job: std::sync::Arc<crate::win32::JobHandle>,
    pub job_attached: bool,
}

/// 起一个原生进程：清环境 + 白名单 + `args.env`，cwd，挂 Job，Resume。
#[cfg(windows)]
pub fn spawn_process(request: &ExecRequest) -> Result<SpawnedProcess, ExecError> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

    use crate::win32::{resume_process, JobHandle};

    let mem_bytes = request.mem_mb.saturating_mul(1024 * 1024);
    let job = JobHandle::create(mem_bytes, request.cpu_ms, request.procs_max)
        .map_err(|err| ExecError::Setup(format!("job object create failed: {err}")))?;

    let mut command = Command::new(&request.cmd);
    command.args(&request.args);
    command.env_clear();
    for (key, value) in minimal_env() {
        command.env(key, value);
    }
    for (key, value) in &request.env {
        command.env(key, value);
    }
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.creation_flags(CREATE_SUSPENDED.0 | CREATE_NO_WINDOW.0);

    let mut child = command
        .spawn()
        .map_err(|err| ExecError::Setup(format!("spawn failed: {err}")))?;
    let pid = child.id();
    let process_handle = HANDLE(child.as_raw_handle() as *mut c_void);
    let job_attached = job.assign(process_handle).is_ok();
    if let Err(err) = resume_process(pid) {
        let _ = child.kill();
        return Err(ExecError::Setup(format!("resume failed: {err}")));
    }
    Ok(SpawnedProcess {
        child,
        pid,
        job: std::sync::Arc::new(job),
        job_attached,
    })
}

/// 等到进程退出或触发上限；返回（退出码，被杀原因）。上限触发即杀整树。
#[cfg(windows)]
pub fn monitor_process(
    child: &mut std::process::Child,
    job: &crate::win32::JobHandle,
    job_attached: bool,
    pid: u32,
    request: &ExecRequest,
    start: Instant,
) -> (Option<i32>, Option<String>) {
    let mem_bytes = request.mem_mb.saturating_mul(1024 * 1024);
    let mut reason: Option<String> = None;
    let mut last_stats = None;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                break None;
            }
        }
        if limit_reached(start.elapsed().as_millis() as u64, request.timeout_ms) {
            set_reason(&mut reason, "timeout");
            terminate(job, job_attached, pid);
        }
        if job_attached {
            let stats = job.stats();
            last_stats = Some(stats);
            if limit_reached(stats.peak_job_memory, mem_bytes) {
                set_reason(&mut reason, "oom");
                terminate(job, job_attached, pid);
            }
            if limit_reached((stats.user_time_100ns / 10_000) as u64, request.cpu_ms) {
                set_reason(&mut reason, "cpu_exceeded");
                terminate(job, job_attached, pid);
            }
            if limit_reached(stats.active_processes as u64, request.procs_max as u64) {
                set_reason(&mut reason, "procs_max");
                terminate(job, job_attached, pid);
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    if reason.is_none() {
        if let Some(stats) = last_stats {
            if limit_reached((stats.user_time_100ns / 10_000) as u64, request.cpu_ms) {
                reason = Some("cpu_exceeded".to_string());
            } else if limit_reached(stats.peak_job_memory, mem_bytes) {
                reason = Some("oom".to_string());
            } else if limit_reached(stats.active_processes as u64, request.procs_max as u64) {
                reason = Some("procs_max".to_string());
            }
        }
    }
    (exit_code, reason)
}

#[cfg(windows)]
fn run_native(request: &ExecRequest) -> Result<ExecOutcome, ExecError> {
    let mut spawned = spawn_process(request)?;
    let (tx, rx) = std::sync::mpsc::channel::<(bool, Vec<u8>)>();
    spawn_ordered(spawned.child.stdout.take(), false, tx.clone());
    spawn_ordered(spawned.child.stderr.take(), true, tx.clone());
    drop(tx);
    let limit = request.output_max;
    let collector = std::thread::spawn(move || {
        let mut capture = OrderedCapture::new(limit);
        for (is_err, bytes) in rx {
            capture.apply(is_err, &bytes);
        }
        capture.finish()
    });

    let start = Instant::now();
    let (exit_code, reason) = monitor_process(
        &mut spawned.child,
        &spawned.job,
        spawned.job_attached,
        spawned.pid,
        request,
        start,
    );

    let (stdout, stderr, truncated, omitted_bytes, combined, combined_truncated) =
        collector.join().unwrap_or_default();
    Ok(ExecOutcome {
        exit_code,
        stdout,
        stderr,
        truncated,
        omitted_bytes,
        combined,
        combined_truncated,
        duration_ms: start.elapsed().as_millis() as u64,
        code: reason,
    })
}

#[cfg(windows)]
fn terminate(job: &crate::win32::JobHandle, attached: bool, pid: u32) {
    if attached {
        job.terminate(1);
    } else {
        let _ = crate::win32::kill_tree(pid);
    }
}

/// 容器内非 root 用户（alpine 的 nobody:nogroup）。
const DOCKER_USER: &str = "65534:65534";

/// Docker 后端：容器内执行（`--network` / `--read-only` / `--user` / bind mount 工作区 /
/// `--memory` / `--pids-limit`）。`args.env` 只以 `-e <键>` 下传（值经 CLI 环境转发，
/// 不出现在 argv）；`limited` 网络白名单未实现，一律回落 `--network none`。
/// 依赖外部 docker 运行时；本仓库开发机无 docker，此路径未在本机验证（能力自述如实报 unavailable）。
pub fn run_docker(
    request: &ExecRequest,
    image: &str,
    network: &str,
) -> Result<ExecOutcome, ExecError> {
    let name = format!("chrono-sandbox-{}", std::process::id());
    let mut args: Vec<String> = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--name".to_string(),
        name.clone(),
        "--network".to_string(),
        network.to_string(),
        "--read-only".to_string(),
        "--user".to_string(),
        DOCKER_USER.to_string(),
    ];
    if request.mem_mb > 0 {
        args.push("--memory".to_string());
        args.push(format!("{}m", request.mem_mb));
    }
    if request.procs_max > 0 {
        args.push("--pids-limit".to_string());
        args.push(request.procs_max.to_string());
    }
    if let Some(cwd) = &request.cwd {
        let dir = cwd.to_string_lossy().to_string();
        args.push("-v".to_string());
        args.push(format!("{dir}:{dir}"));
        args.push("-w".to_string());
        args.push(dir);
    }
    // 只传键名：docker 从 CLI 环境取原值转发进容器，避免明文出现在进程 argv。
    for (key, _value) in &request.env {
        args.push("-e".to_string());
        args.push(key.clone());
    }
    args.push(image.to_string());
    args.push(request.cmd.clone());
    args.extend(request.args.iter().cloned());

    let mut command = Command::new("docker");
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    for (key, value) in minimal_env() {
        command.env(key, value);
    }
    for (key, value) in &request.env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|err| ExecError::Setup(format!("docker spawn failed: {err}")))?;
    let (tx, rx) = std::sync::mpsc::channel::<(bool, Vec<u8>)>();
    spawn_ordered(child.stdout.take(), false, tx.clone());
    spawn_ordered(child.stderr.take(), true, tx.clone());
    drop(tx);
    let limit = request.output_max;
    let collector = std::thread::spawn(move || {
        let mut capture = OrderedCapture::new(limit);
        for (is_err, bytes) in rx {
            capture.apply(is_err, &bytes);
        }
        capture.finish()
    });

    let start = Instant::now();
    let mut reason: Option<String> = None;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(err) => {
                let _ = child.kill();
                return Err(ExecError::Setup(format!("docker wait failed: {err}")));
            }
        }
        if request.timeout_ms > 0 && start.elapsed().as_millis() as u64 >= request.timeout_ms {
            reason = Some("timeout".to_string());
            let _ = child.kill();
            let _ = Command::new("docker")
                .args(["rm", "-f", &name])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if reason.is_some() {
        let _ = child.wait();
    }

    let (stdout, stderr, truncated, omitted_bytes, combined, combined_truncated) =
        collector.join().unwrap_or_default();
    Ok(ExecOutcome {
        exit_code,
        stdout,
        stderr,
        truncated,
        omitted_bytes,
        combined,
        combined_truncated,
        duration_ms: start.elapsed().as_millis() as u64,
        code: reason,
    })
}

/// 已挂起的 Linux 进程 + 其 cgroup（供同步 `run` 与后台任务复用）。
#[cfg(target_os = "linux")]
pub struct LinuxSpawn {
    pub child: std::process::Child,
    pub pgid: i32,
    cgroup: Option<crate::cgroup::Cgroup>,
}

#[cfg(target_os = "linux")]
impl LinuxSpawn {
    /// 退出后回收 cgroup（含 `cgroup.kill` 兜底杀残留）。
    pub fn cleanup(&self) {
        if let Some(group) = &self.cgroup {
            group.cleanup();
        }
    }

    fn oom_killed(&self) -> bool {
        self.cgroup.as_ref().map(|group| group.oom_killed()).unwrap_or(false)
    }
}

/// 起一个 Linux 进程：清环境 + 白名单 + `args.env`，独立进程组，`pre_exec` 内按序施加
/// cgroup 迁入 → namespaces → landlock → seccomp，内存 / 进程数无 cgroup 时回退 rlimit。
#[cfg(target_os = "linux")]
pub fn spawn_linux(request: &ExecRequest) -> Result<LinuxSpawn, ExecError> {
    use std::os::unix::io::AsRawFd;
    use std::os::unix::process::CommandExt;

    use crate::cgroup::Cgroup;
    use crate::landlock;
    use crate::linux::{set_rlimit, write_all, RLIMIT_AS, RLIMIT_CPU, RLIMIT_NPROC};

    let mut command = Command::new(&request.cmd);
    command.args(&request.args);
    command.env_clear();
    for (key, value) in minimal_env() {
        command.env(key, value);
    }
    for (key, value) in &request.env {
        command.env(key, value);
    }
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // `process_group(0)`：子进程自成进程组（pgid = pid），超时 / 超限时 killpg 杀整组。
    command.process_group(0);

    let mem_bytes = request.mem_mb.saturating_mul(1024 * 1024);
    let cpu_secs = if request.cpu_ms > 0 {
        (request.cpu_ms / 1000).max(1)
    } else {
        0
    };
    let procs_max = request.procs_max;

    // cgroup v2 优先承担内存 / 进程数上限：内存超限可判 `oom`，进程数按 cgroup 计数（不误伤 root 的
    // 全局 RLIMIT_NPROC 计数）。不可用即回退 rlimit（见 pre_exec）。
    let cgroup = Cgroup::create(&cgroup_id(), mem_bytes, procs_max);
    let cgroup_procs = cgroup.as_ref().and_then(|group| group.procs_file().ok());
    // 只有确实拿到 `cgroup.procs`（能把子进程迁入）才用它替代 rlimit，否则回退 rlimit。
    let cgroup_active = cgroup_procs.is_some();
    let use_cgroup_mem = cgroup_active && mem_bytes > 0;
    let use_cgroup_pids = cgroup_active && procs_max > 0;
    let cgroup_fd = cgroup_procs.as_ref().map(|file| file.as_raw_fd());

    // landlock 规则集在父进程建好（路径解析 / 分配都在 fork 前），子进程只做 restrict_self。
    let ruleset = landlock::build_ruleset(
        request.isolation.workspace_root.as_deref(),
        request.isolation.fs_read,
        request.isolation.fs_write,
    )
    .ok()
    .flatten();
    let ruleset_fd = ruleset.as_ref().map(|file| file.as_raw_fd());

    // seccomp 过滤器同样在父进程编译；基础禁用集恒定，`net == none` 且未上 net namespace 时加本地套接字白名单。
    let namespace_plan = if crate::namespaces::available() {
        Some(crate::namespaces::build(request.isolation.net == NetScope::None))
    } else {
        None
    };
    let net_namespace = namespace_plan.as_ref().map(|plan| plan.net).unwrap_or(false);
    let seccomp_filter = if crate::seccomp::available() {
        Some(crate::seccomp::build_filter(request.isolation.net == NetScope::None && !net_namespace))
    } else {
        None
    };

    // SAFETY: pre_exec 内只调用异步信号安全接口（setrlimit / write / prctl / unshare / mount /
    // landlock / seccomp syscall）；失败以 errno 返回，fork 后不做会分配或加锁的操作。
    unsafe {
        command.pre_exec(move || {
            if mem_bytes > 0 && !use_cgroup_mem {
                set_rlimit(RLIMIT_AS, mem_bytes, mem_bytes)?;
            }
            if cpu_secs > 0 {
                // 软限触发 SIGXCPU、硬限再高 1s：让 CPU 超限以可判别的信号收尾（软==硬会被内核直接 SIGKILL）。
                set_rlimit(RLIMIT_CPU, cpu_secs, cpu_secs + 1)?;
            }
            if procs_max > 0 && !use_cgroup_pids {
                set_rlimit(RLIMIT_NPROC, procs_max as u64, procs_max as u64)?;
            }
            // 顺序：迁 cgroup（需宿主权限）→ 命名空间 → landlock → seccomp（装上不可撤）。
            if let Some(fd) = cgroup_fd {
                write_all(fd, b"0")?;
            }
            if let Some(plan) = &namespace_plan {
                crate::namespaces::apply(plan)?;
            }
            if let Some(fd) = ruleset_fd {
                landlock::restrict_self(fd)?;
            }
            if let Some(filter) = &seccomp_filter {
                crate::seccomp::apply(filter)?;
            }
            Ok(())
        });
    }

    let child = command
        .spawn()
        .map_err(|err| ExecError::Setup(format!("spawn failed: {err}")))?;
    let pgid = child.id() as i32;
    Ok(LinuxSpawn { child, pgid, cgroup })
}

/// 等到进程退出或触发上限；返回（退出码，被杀原因）。上限触发即 `killpg` 杀整组。
#[cfg(target_os = "linux")]
pub fn monitor_linux(
    spawn: &mut LinuxSpawn,
    request: &ExecRequest,
    start: Instant,
) -> (Option<i32>, Option<String>) {
    use std::os::unix::process::ExitStatusExt;

    use crate::linux::{kill_group, SIGKILL, SIGXCPU};

    let mut reason: Option<String> = None;
    let exit_code = loop {
        match spawn.child.try_wait() {
            Ok(Some(status)) => {
                // 被信号终止（RLIMIT_CPU 的 SIGXCPU / cgroup OOM 的 SIGKILL）无退出码，据信号归类。
                if status.signal() == Some(SIGXCPU) {
                    set_reason(&mut reason, "cpu_exceeded");
                } else if status.signal() == Some(SIGKILL) && spawn.oom_killed() {
                    set_reason(&mut reason, "oom");
                }
                break status.code();
            }
            Ok(None) => {}
            Err(_) => {
                set_reason(&mut reason, "wait_failed");
                kill_group(spawn.pgid);
                break None;
            }
        }
        if limit_reached(start.elapsed().as_millis() as u64, request.timeout_ms) {
            set_reason(&mut reason, "timeout");
            kill_group(spawn.pgid);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    (exit_code, reason)
}

/// Linux 原生执行（同步）：起进程 + 有序输出捕获 + 监视 / 树杀 + cgroup 回收。
#[cfg(target_os = "linux")]
fn run_linux(request: &ExecRequest) -> Result<ExecOutcome, ExecError> {
    let mut spawn = spawn_linux(request)?;
    let (tx, rx) = std::sync::mpsc::channel::<(bool, Vec<u8>)>();
    spawn_ordered(spawn.child.stdout.take(), false, tx.clone());
    spawn_ordered(spawn.child.stderr.take(), true, tx.clone());
    drop(tx);
    let limit = request.output_max;
    let collector = std::thread::spawn(move || {
        let mut capture = OrderedCapture::new(limit);
        for (is_err, bytes) in rx {
            capture.apply(is_err, &bytes);
        }
        capture.finish()
    });

    let start = Instant::now();
    let (exit_code, reason) = monitor_linux(&mut spawn, request, start);
    spawn.cleanup();

    let (stdout, stderr, truncated, omitted_bytes, combined, combined_truncated) =
        collector.join().unwrap_or_default();
    Ok(ExecOutcome {
        exit_code,
        stdout,
        stderr,
        truncated,
        omitted_bytes,
        combined,
        combined_truncated,
        duration_ms: start.elapsed().as_millis() as u64,
        code: reason,
    })
}

/// 每次执行一个唯一 cgroup 名（pid + 进程内序号）：避免并发执行撞名。
#[cfg(target_os = "linux")]
pub(crate) fn cgroup_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(cmd: &str, args: &[&str]) -> ExecRequest {
        ExecRequest {
            cmd: cmd.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            env: Vec::new(),
            cwd: None,
            timeout_ms: 10_000,
            mem_mb: 0,
            cpu_ms: 0,
            procs_max: 0,
            output_max: 64 * 1024,
            isolation: Isolation::default(),
        }
    }

    #[cfg(windows)]
    fn cmd_request(script: &str) -> ExecRequest {
        request("cmd.exe", &["/c", script])
    }

    #[test]
    fn parse_request_accepts_both_shapes() {
        let flat = parse_request(
            &json!({"cmd":"cmd.exe","args":["/c","echo hi"],"env":{"A":"1"}}),
            1024,
        )
        .unwrap();
        assert_eq!(flat.cmd, "cmd.exe");
        assert_eq!(flat.args, vec!["/c", "echo hi"]);
        assert_eq!(flat.env, vec![("A".to_string(), "1".to_string())]);

        let nested = parse_request(
            &json!({"args":{"cmd":"cmd.exe","args":["/c","echo hi"],"env":{"B":2}}}),
            1024,
        )
        .unwrap();
        assert_eq!(nested.cmd, "cmd.exe");
        assert_eq!(nested.env, vec![("B".to_string(), "2".to_string())]);

        assert!(parse_request(&json!({"args":[]}), 1024).is_err());
    }

    #[test]
    fn parse_request_prefers_cwd_over_workspace_root() {
        let parsed = parse_request(
            &json!({"cmd":"cmd.exe","cwd":"C:\\x","workspace_root":"C:\\ws"}),
            1024,
        )
        .unwrap();
        assert_eq!(parsed.cwd, Some(PathBuf::from("C:\\x")));

        let fallback =
            parse_request(&json!({"cmd":"cmd.exe","workspace_root":"C:\\ws"}), 1024).unwrap();
        assert_eq!(fallback.cwd, Some(PathBuf::from("C:\\ws")));
    }

    #[cfg(windows)]
    #[test]
    fn normal_command_and_exit_code() {
        let outcome = run(&cmd_request("echo hello")).unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.stdout.contains("hello"), "{}", outcome.stdout);
        assert!(outcome.code.is_none());

        let failing = run(&cmd_request("exit 3")).unwrap();
        assert_eq!(failing.exit_code, Some(3));
        assert!(failing.code.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn env_is_injected() {
        let mut req = cmd_request("echo %CHRONO_TEST_VAR%");
        req.env.push(("CHRONO_TEST_VAR".to_string(), "injected-value".to_string()));
        let outcome = run(&req).unwrap();
        assert!(outcome.stdout.contains("injected-value"), "{}", outcome.stdout);
    }

    #[cfg(windows)]
    #[test]
    fn host_env_is_not_inherited() {
        // 宿主设密钥，子进程经 env_clear + 白名单后读不到。
        std::env::set_var("CHRONO_SECRET", "leaked-value");
        let outcome = run(&cmd_request("echo [%CHRONO_SECRET%]")).unwrap();
        std::env::remove_var("CHRONO_SECRET");
        // 未定义时 cmd 原样回显 %CHRONO_SECRET%，关键是不含宿主值。
        assert!(!outcome.stdout.contains("leaked-value"), "{}", outcome.stdout);
    }

    #[cfg(windows)]
    #[test]
    fn minimal_env_keeps_system_root() {
        // 白名单保留 SystemRoot 等系统变量，保证 cmd.exe 仍可运行。
        let keys: Vec<String> = minimal_env()
            .into_iter()
            .map(|(key, _)| key.to_string_lossy().to_lowercase())
            .collect();
        assert!(keys.iter().any(|key| key == "systemroot" || key == "path"));
    }

    #[cfg(windows)]
    #[test]
    fn minimal_env_keeps_user_locations() {
        // 用户位置变量入白名单：git / npm / python 需要它们定位配置与缓存。
        let keys: Vec<String> = minimal_env()
            .into_iter()
            .map(|(key, _)| key.to_string_lossy().to_lowercase())
            .collect();
        for expected in ["userprofile", "appdata", "localappdata"] {
            let host_has = std::env::vars_os()
                .any(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(expected));
            if host_has {
                assert!(keys.iter().any(|key| key == expected), "missing {expected}: {keys:?}");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn output_is_truncated() {
        let mut req = cmd_request("for /L %i in (1,1,5000) do @echo 0123456789012345678901234567890123456789");
        req.output_max = 256;
        let outcome = run(&req).unwrap();
        assert!(outcome.truncated);
        assert!(outcome.omitted_bytes > 0);
        assert!(outcome.stdout.contains("bytes omitted"), "{}", outcome.stdout);
        assert!(outcome.stdout.len() <= 256, "{}", outcome.stdout.len());
    }

    #[cfg(windows)]
    #[test]
    fn combined_preserves_both_streams() {
        let req = cmd_request("echo OUT1 & echo ERR1 1>&2 & echo OUT2");
        let outcome = run(&req).unwrap();
        assert!(outcome.combined.iter().any(|(is_err, _)| *is_err), "{:?}", outcome.combined);
        assert!(outcome.combined.iter().any(|(is_err, _)| !*is_err), "{:?}", outcome.combined);
        let joined: String = outcome.combined.iter().map(|(_, text)| text.as_str()).collect();
        assert!(joined.contains("OUT1") && joined.contains("ERR1"), "{joined}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_normal_command_and_exit_code() {
        let req = request("sh", &["-c", "echo hi; exit 3"]);
        let outcome = run(&req).unwrap();
        assert_eq!(outcome.exit_code, Some(3));
        assert!(outcome.stdout.contains("hi"), "{}", outcome.stdout);
        assert_eq!(outcome.code, None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_timeout_kills_process_group() {
        let mut req = request("sh", &["-c", "sleep 5"]);
        req.timeout_ms = 300;
        let outcome = run(&req).unwrap();
        assert_eq!(outcome.code.as_deref(), Some("timeout"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cpu_rlimit_reports_cpu_exceeded() {
        let mut req = request("sh", &["-c", "while :; do :; done"]);
        req.cpu_ms = 1000; // → RLIMIT_CPU 1s → SIGXCPU
        req.timeout_ms = 10_000;
        let outcome = run(&req).unwrap();
        assert_eq!(outcome.code.as_deref(), Some("cpu_exceeded"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_combined_preserves_both_streams() {
        let req = request("sh", &["-c", "echo OUT1; echo ERR1 1>&2"]);
        let outcome = run(&req).unwrap();
        assert!(outcome.combined.iter().any(|(is_err, _)| *is_err), "{:?}", outcome.combined);
        assert!(outcome.combined.iter().any(|(is_err, _)| !*is_err), "{:?}", outcome.combined);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cwd_is_respected() {
        let dir = std::env::temp_dir().join(format!("chrono-linux-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut req = request("sh", &["-c", "pwd"]);
        req.cwd = Some(dir.clone());
        let outcome = run(&req).unwrap();
        assert!(
            outcome.stdout.trim().ends_with(dir.to_string_lossy().as_ref()),
            "cwd={:?} stdout={}",
            dir,
            outcome.stdout
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 工作区档隔离上下文（读 / 写限到 workspace，net none）。
    #[cfg(target_os = "linux")]
    fn workspace_isolation(root: &std::path::Path) -> Isolation {
        Isolation {
            workspace_root: Some(root.to_path_buf()),
            fs_read: FsScope::Workspace,
            fs_write: FsScope::Workspace,
            net: NetScope::None,
        }
    }

    #[cfg(target_os = "linux")]
    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("chrono-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_landlock_confines_writes_to_workspace() {
        if crate::landlock::abi().is_none() {
            return;
        }
        let base = temp_root("ll-write");
        let ws = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        // 区内写：放行，且 `2>/dev/null` 这类重定向不被误伤。
        let mut inside = request("sh", &["-c", "echo inside > inside.txt; echo x 2>/dev/null"]);
        inside.cwd = Some(ws.clone());
        inside.isolation = workspace_isolation(&ws);
        let outcome = run(&inside).unwrap();
        assert_eq!(outcome.exit_code, Some(0), "stderr={}", outcome.stderr);
        assert!(ws.join("inside.txt").exists());
        assert_eq!(
            std::fs::read_to_string(ws.join("inside.txt")).unwrap().trim(),
            "inside"
        );

        // 区外写：landlock 拒绝（EACCES），文件不落地。
        let target = outside.join("out.txt");
        let mut denied = request("sh", &["-c", &format!("echo out > {}", target.display())]);
        denied.isolation = workspace_isolation(&ws);
        let outcome = run(&denied).unwrap();
        assert_ne!(outcome.exit_code, Some(0), "stdout={} stderr={}", outcome.stdout, outcome.stderr);
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_landlock_confines_reads_to_workspace() {
        if crate::landlock::abi().is_none() {
            return;
        }
        let base = temp_root("ll-read");
        let ws = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(ws.join("ok.txt"), "visible").unwrap();
        std::fs::write(outside.join("secret.txt"), "hidden").unwrap();

        let mut inside = request("sh", &["-c", &format!("cat {}", ws.join("ok.txt").display())]);
        inside.isolation = workspace_isolation(&ws);
        let outcome = run(&inside).unwrap();
        assert_eq!(outcome.exit_code, Some(0), "stderr={}", outcome.stderr);
        assert!(outcome.stdout.contains("visible"), "{}", outcome.stdout);

        let mut denied = request(
            "sh",
            &["-c", &format!("cat {}", outside.join("secret.txt").display())],
        );
        denied.isolation = workspace_isolation(&ws);
        let outcome = run(&denied).unwrap();
        assert_ne!(outcome.exit_code, Some(0), "stdout={} stderr={}", outcome.stdout, outcome.stderr);
        assert!(!outcome.stdout.contains("hidden"), "{}", outcome.stdout);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cgroup_child_joins_own_cgroup() {
        if !crate::cgroup::available() {
            return;
        }
        let mut req = request("sh", &["-c", "cat /proc/self/cgroup"]);
        req.mem_mb = 64;
        let outcome = run(&req).unwrap();
        assert_eq!(outcome.exit_code, Some(0), "stderr={}", outcome.stderr);
        assert!(outcome.stdout.contains("chrono-"), "{}", outcome.stdout);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cgroup_oom_reports_code() {
        if !crate::cgroup::available() {
            return;
        }
        // `exec sort /dev/zero`：sh 被替换成唯一的 sort 进程，无界缓冲直到超过 memory.max=64MB →
        // 内核 OOM 杀直接子进程（确定性；避免命令替换把 OOM 目标落到孙进程）。
        let mut req = request(
            "sh",
            &["-c", "exec sort /dev/zero"],
        );
        req.mem_mb = 64;
        req.timeout_ms = 30_000;
        let outcome = run(&req).unwrap();
        assert_eq!(
            outcome.code.as_deref(),
            Some("oom"),
            "code={:?} exit={:?} stderr={}",
            outcome.code,
            outcome.exit_code,
            outcome.stderr
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_seccomp_blocks_mount() {
        if !crate::seccomp::available() {
            return;
        }
        let dir = temp_root("seccomp-mount");
        let command = format!("mount -t tmpfs none {}", dir.display());
        let req = request("sh", &["-c", &command]);
        let outcome = run(&req).unwrap();
        assert_ne!(
            outcome.exit_code,
            Some(0),
            "stdout={} stderr={}",
            outcome.stdout,
            outcome.stderr
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_net_none_blocks_inet_connectivity() {
        if !crate::namespaces::available() && !crate::seccomp::available() {
            return;
        }
        let mut denied = request("bash", &["-c", "exec 3<>/dev/tcp/1.1.1.1/80"]);
        denied.isolation.net = NetScope::None;
        denied.timeout_ms = 5_000;
        let outcome = run(&denied).unwrap();
        assert_ne!(outcome.exit_code, Some(0), "stdout={} stderr={}", outcome.stdout, outcome.stderr);
        assert_ne!(outcome.code.as_deref(), Some("timeout"), "stderr={}", outcome.stderr);
        if !crate::namespaces::available() {
            // 无 net namespace 时由 seccomp 挡 socket：EPERM → "Operation not permitted"。
            assert!(outcome.stderr.contains("not permitted"), "stderr={}", outcome.stderr);
        }

        // 本地命令不受 net=none 影响。
        let mut ok = request("sh", &["-c", "echo local-ok"]);
        ok.isolation.net = NetScope::None;
        assert_eq!(run(&ok).unwrap().exit_code, Some(0));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_net_namespace_hides_host_interfaces() {
        if !crate::namespaces::available() {
            return;
        }
        let host = std::fs::read_to_string("/proc/net/dev").unwrap_or_default();
        let host_interfaces: Vec<String> = host
            .lines()
            .skip(2)
            .filter_map(|line| line.split(':').next())
            .map(str::trim)
            .filter(|name| !name.is_empty() && *name != "lo")
            .map(str::to_string)
            .collect();
        if host_interfaces.is_empty() {
            return;
        }
        let mut req = request("sh", &["-c", "cat /proc/net/dev"]);
        req.isolation.net = NetScope::None;
        let outcome = run(&req).unwrap();
        assert!(outcome.stdout.contains("lo"), "{}", outcome.stdout);
        for name in &host_interfaces {
            assert!(!outcome.stdout.contains(name.as_str()), "host iface {name} leaked: {}", outcome.stdout);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_mount_and_user_namespaces_are_distinct() {
        if !crate::namespaces::available() {
            return;
        }
        let req = request("sh", &["-c", "readlink /proc/self/ns/mnt; readlink /proc/self/ns/user"]);
        let outcome = run(&req).unwrap();
        assert_eq!(outcome.exit_code, Some(0), "stderr={}", outcome.stderr);
        let host_mnt = std::fs::read_link("/proc/self/ns/mnt").unwrap();
        let host_user = std::fs::read_link("/proc/self/ns/user").unwrap();
        let text = outcome.stdout;
        assert!(!text.contains(host_mnt.to_string_lossy().as_ref()), "mount ns not isolated: {text}");
        assert!(!text.contains(host_user.to_string_lossy().as_ref()), "user ns not isolated: {text}");
    }

    #[test]
    fn stream_capture_returns_full_when_under_limit() {
        let mut capture = StreamCapture::new(1000);
        capture.push("hello 中".as_bytes());
        let (text, truncated, omitted) = capture.finish();
        assert_eq!(text, "hello 中");
        assert!(!truncated);
        assert_eq!(omitted, 0);
    }

    #[test]
    fn stream_capture_head_tail_keeps_utf8_boundaries() {
        let chunk = "中".repeat(500);
        let mut capture = StreamCapture::new(200);
        capture.push(chunk.as_bytes());
        let (text, truncated, omitted) = capture.finish();
        assert!(truncated);
        assert!(omitted > 0);
        assert!(text.starts_with('中'));
        assert!(text.ends_with('中'));
        assert!(text.contains("bytes omitted"));
        assert!(text.len() <= 200, "len={}", text.len());
    }

    #[cfg(windows)]
    #[test]
    fn timeout_kills_tree() {
        let mut req = cmd_request("ping -n 31 127.0.0.1 > nul");
        req.timeout_ms = 400;
        let outcome = run(&req).unwrap();
        assert_eq!(outcome.code.as_deref(), Some("timeout"));
        assert!(outcome.duration_ms < 10_000, "{}", outcome.duration_ms);
    }

    #[cfg(windows)]
    #[test]
    fn cwd_is_workspace_root() {
        let dir = std::env::temp_dir().join(format!("chrono-sandbox-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut req = cmd_request("cd");
        req.cwd = Some(dir.clone());
        let outcome = run(&req).unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        let expected = std::fs::canonicalize(&dir).unwrap();
        assert!(
            outcome.stdout.to_lowercase().contains(&expected.to_string_lossy().to_lowercase())
                || outcome.stdout.contains(&dir.to_string_lossy().to_string()),
            "cwd={} stdout={}",
            dir.display(),
            outcome.stdout
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    #[test]
    fn non_windows_reports_unsupported() {
        let err = run(&request("echo", &["hi"])).unwrap_err();
        assert_eq!(err.code(), "sandbox_unsupported");
    }
}
