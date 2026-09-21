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
}

/// exec 结果；`code` 仅在超时 / 超限被杀时出现（`timeout` / `oom` / `cpu_exceeded` / `procs_max`）。
#[derive(Clone, Debug)]
pub struct ExecOutcome {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub duration_ms: u64,
    pub code: Option<String>,
}

/// exec 前置失败（结构化码）。`Unsupported` 只在非 win32 分支构造。
#[derive(Clone, Debug)]
pub enum ExecError {
    #[cfg_attr(windows, allow(dead_code))]
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

/// 子进程最小环境白名单：只保留常用命令运行所必需的系统变量。
/// 宿主其余环境（含密钥）一律不继承——密钥只能经 `args.env` 显式下传。
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
];

#[cfg(not(windows))]
const MINIMAL_ENV_KEYS: &[&str] =
    &["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL", "TERM"];

/// 取宿主进程里的最小白名单环境（键大小写不敏感，值原样保留）。
fn minimal_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
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
        .get("workspace_root")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
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
    })
}

/// 执行一次；平台无原生实现即 `sandbox_unsupported`。
pub fn run(request: &ExecRequest) -> Result<ExecOutcome, ExecError> {
    #[cfg(windows)]
    {
        run_native(request)
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        Err(ExecError::Unsupported(
            "native exec isolation is not implemented on this platform".to_string(),
        ))
    }
}

/// 收集输出：读满 limit 后继续排空但丢弃，避免管道写满阻塞；`truncated` 标记。
fn read_limited<R: Read>(reader: Option<R>, limit: usize) -> (Vec<u8>, bool) {
    let Some(mut reader) = reader else {
        return (Vec::new(), false);
    };
    let mut buffer = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                if buffer.len() < limit {
                    let remaining = limit - buffer.len();
                    let take = remaining.min(read);
                    buffer.extend_from_slice(&chunk[..take]);
                    if take < read {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (buffer, truncated)
}

fn spawn_reader<R: Read + Send + 'static>(
    reader: Option<R>,
    limit: usize,
) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || read_limited(reader, limit))
}

fn set_reason(slot: &mut Option<String>, value: &str) {
    if slot.is_none() {
        *slot = Some(value.to_string());
    }
}

fn to_text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(windows)]
fn run_native(request: &ExecRequest) -> Result<ExecOutcome, ExecError> {
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

    let stdout_reader = spawn_reader(child.stdout.take(), request.output_max);
    let stderr_reader = spawn_reader(child.stderr.take(), request.output_max);

    let start = Instant::now();
    let mut reason: Option<String> = None;
    let mut last_stats = None;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(err) => {
                let _ = child.kill();
                return Err(ExecError::Setup(format!("wait failed: {err}")));
            }
        }
        if limit_reached(start.elapsed().as_millis() as u64, request.timeout_ms) {
            set_reason(&mut reason, "timeout");
            terminate(&job, job_attached, pid);
        }
        if job_attached {
            let stats = job.stats();
            last_stats = Some(stats);
            if limit_reached(stats.peak_job_memory, mem_bytes) {
                set_reason(&mut reason, "oom");
                terminate(&job, job_attached, pid);
            }
            if limit_reached((stats.user_time_100ns / 10_000) as u64, request.cpu_ms) {
                set_reason(&mut reason, "cpu_exceeded");
                terminate(&job, job_attached, pid);
            }
            if limit_reached(stats.active_processes as u64, request.procs_max as u64) {
                set_reason(&mut reason, "procs_max");
                terminate(&job, job_attached, pid);
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

    let (stdout_bytes, stdout_truncated) = stdout_reader.join().unwrap_or_default();
    let (stderr_bytes, stderr_truncated) = stderr_reader.join().unwrap_or_default();
    Ok(ExecOutcome {
        exit_code,
        stdout: to_text(stdout_bytes),
        stderr: to_text(stderr_bytes),
        truncated: stdout_truncated || stderr_truncated,
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
    let stdout_reader = spawn_reader(child.stdout.take(), request.output_max);
    let stderr_reader = spawn_reader(child.stderr.take(), request.output_max);

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

    let (stdout_bytes, stdout_truncated) = stdout_reader.join().unwrap_or_default();
    let (stderr_bytes, stderr_truncated) = stderr_reader.join().unwrap_or_default();
    Ok(ExecOutcome {
        exit_code,
        stdout: to_text(stdout_bytes),
        stderr: to_text(stderr_bytes),
        truncated: stdout_truncated || stderr_truncated,
        duration_ms: start.elapsed().as_millis() as u64,
        code: reason,
    })
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
    fn output_is_truncated() {
        let mut req = cmd_request("for /L %i in (1,1,5000) do @echo 0123456789012345678901234567890123456789");
        req.output_max = 256;
        let outcome = run(&req).unwrap();
        assert!(outcome.truncated);
        assert!(outcome.stdout.len() <= 256);
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

    #[cfg(not(windows))]
    #[test]
    fn non_windows_reports_unsupported() {
        let err = run(&request("echo", &["hi"])).unwrap_err();
        assert_eq!(err.code(), "sandbox_unsupported");
    }
}
