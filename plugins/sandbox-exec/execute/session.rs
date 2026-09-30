// 统一任务内核：前台 / 后台 / 会话命令共用一套「任务」——可增量读输出、可轮询、可杀。
// 会话是常驻 shell（Windows 用 `-NoExit -Command -` 的行式 REPL，命令经 base64 + `Invoke-Expression`
// 送入，支持多行且 `cd` / `$env:` 跨命令延续）。会话与任务都是**进程内存活对象**：不落世界、
// 不进 chain、不跨宿主重启；重启后由调用方透明重建（`session_missing`）。
//
// 输出统一进有界缓冲：超出 `output_max` 丢尾并记 `dropped`（游标是稳定字节偏移，故只截尾不挪头）。
// 会话命令按哨兵帧判定结束（PowerShell `Write-Output` / POSIX `printf`），并回带命令退出码。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::exec::ExecRequest;

/// 会话空闲上限：超过即回收（下次调用透明重建）。
const SESSION_IDLE_MS: u64 = 30 * 60 * 1000;
/// 会话容量上限：超出时淘汰最久未用的空闲会话。
const SESSION_CAPACITY: usize = 16;
/// 会话原始流缓冲上限：命令执行期间超限丢头（哨兵在尾部，不受影响）。
const SESSION_RAW_CAP: usize = 4 * 1024 * 1024;
/// 任务保留上限 / 容量：为后台任务输出留出读取窗口。
const TASK_RETENTION_MS: u64 = 10 * 60 * 1000;
const TASK_CAPACITY: usize = 64;

// ── 输出缓冲 ────────────────────────────────────────────────────────────────

/// 有界输出缓冲：头部顺序追加（供游标增量读），溢出进尾部环形；两头之外丢弃并计数。
pub struct OutputBuf {
    bytes: Vec<u8>,
    tail: std::collections::VecDeque<u8>,
    cap: usize,
    tail_cap: usize,
    total: u64,
    dropped: u64,
}

impl OutputBuf {
    fn new(cap: usize) -> Self {
        let cap = cap.max(1);
        Self {
            bytes: Vec::new(),
            tail: std::collections::VecDeque::new(),
            cap,
            tail_cap: (cap / 3).max(1024).min(cap),
            total: 0,
            dropped: 0,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.total = self.total.saturating_add(chunk.len() as u64);
        let mut rest = chunk;
        if self.bytes.len() < self.cap {
            let take = (self.cap - self.bytes.len()).min(rest.len());
            self.bytes.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
        if rest.is_empty() {
            return;
        }
        if self.tail_cap == 0 {
            self.dropped = self.dropped.saturating_add(rest.len() as u64);
            return;
        }
        self.tail.extend(rest.iter().copied());
        while self.tail.len() > self.tail_cap {
            self.tail.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
    }

    fn clear(&mut self) {
        self.bytes.clear();
        self.tail.clear();
        self.total = 0;
        self.dropped = 0;
    }

    fn truncated(&self) -> bool {
        self.dropped > 0
    }

    /// 尾部文本（UTF-8 边界已夹齐）；仅在任务结束时并入最终结果。
    fn tail_text(&self) -> String {
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        String::from_utf8_lossy(crate::exec::utf8_suffix(&tail)).into_owned()
    }
}

fn slice_from_cursor(buf: &OutputBuf, cursor: usize) -> (String, usize) {
    let start = cursor.min(buf.bytes.len());
    let text = String::from_utf8_lossy(&buf.bytes[start..]).into_owned();
    (text, buf.bytes.len())
}

// ── 任务 ────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct TaskStatus {
    pub running: bool,
    pub exit_code: Option<i32>,
    pub code: Option<String>,
}

struct TaskEntry {
    output: Arc<Mutex<OutputBuf>>,
    status: Arc<Mutex<TaskStatus>>,
    created: Instant,
    kill: Box<dyn Fn() + Send + Sync>,
}

fn tasks() -> &'static Mutex<HashMap<String, Arc<TaskEntry>>> {
    static TASKS: OnceLock<Mutex<HashMap<String, Arc<TaskEntry>>>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id(prefix: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("{prefix}-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

fn register_task(output: Arc<Mutex<OutputBuf>>, status: Arc<Mutex<TaskStatus>>, kill: Box<dyn Fn() + Send + Sync>) -> String {
    let id = next_id("task");
    let entry = Arc::new(TaskEntry {
        output,
        status,
        created: Instant::now(),
        kill,
    });
    let mut map = tasks().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    sweep_tasks(&mut map);
    if map.len() >= TASK_CAPACITY {
        // 淘汰最老的已结束任务；仍在运行的优先保留。
        let victim = map
            .iter()
            .filter(|(_, entry)| !entry.status.lock().map(|s| s.running).unwrap_or(false))
            .min_by_key(|(_, entry)| entry.created)
            .map(|(id, _)| id.clone());
        if let Some(victim) = victim {
            map.remove(&victim);
        }
    }
    map.insert(id.clone(), entry);
    id
}

fn sweep_tasks(map: &mut HashMap<String, Arc<TaskEntry>>) {
    let now = Instant::now();
    map.retain(|_, entry| {
        let running = entry.status.lock().map(|s| s.running).unwrap_or(false);
        running || now.duration_since(entry.created).as_millis() as u64 <= TASK_RETENTION_MS
    });
}

// ── 会话 ────────────────────────────────────────────────────────────────────

/// 会话 shell 口径：由调用方（tool-shell）按平台提供，本插件只按 `syntax` 拼哨兵帧。
pub struct SessionShell {
    pub cmd: String,
    pub args: Vec<String>,
    pub syntax: String,
}

struct Session {
    shell: Mutex<std::process::Child>,
    stdin: Mutex<std::process::ChildStdin>,
    raw: Arc<Mutex<OutputBuf>>,
    alive: Arc<AtomicBool>,
    busy: AtomicBool,
    syntax: String,
    last_used: Mutex<Instant>,
    #[cfg(windows)]
    job: Option<Arc<crate::win32::JobHandle>>,
    #[cfg(target_os = "linux")]
    cgroup: Option<crate::cgroup::Cgroup>,
}

impl Session {
    fn touch(&self) {
        if let Ok(mut last) = self.last_used.lock() {
            *last = Instant::now();
        }
    }

    fn dead(&self) -> bool {
        !self.alive.load(Ordering::Relaxed)
    }

    /// 会话 shell 若已退出，取其退出码（命令 `exit N` 会终止 shell，此时 N 即命令退出码）。
    /// EOF 观察到与进程真正退出之间有窗口，故短暂重试 reap。
    fn reap_exit_code(&self) -> Option<i32> {
        for _ in 0..200 {
            if let Ok(mut shell) = self.shell.lock() {
                match shell.try_wait() {
                    Ok(Some(status)) => return status.code(),
                    Ok(None) => {}
                    Err(_) => return None,
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    fn kill(&self) {
        self.alive.store(false, Ordering::Relaxed);
        if let Ok(mut shell) = self.shell.lock() {
            // Linux：会话 shell 自成进程组，杀整组（含其子进程）。
            #[cfg(target_os = "linux")]
            crate::linux::kill_group(shell.id() as i32);
            let _ = shell.kill();
            let _ = shell.wait();
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate(1);
        }
        #[cfg(target_os = "linux")]
        if let Some(group) = &self.cgroup {
            group.cleanup();
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn spawn_session_reader<R: Read + Send + 'static>(reader: Option<R>, raw: Arc<Mutex<OutputBuf>>, alive: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let Some(mut reader) = reader else {
            alive.store(false, Ordering::Relaxed);
            return;
        };
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if let Ok(mut buf) = raw.lock() {
                        buf.push(&chunk[..read]);
                    }
                }
                Err(_) => break,
            }
        }
        alive.store(false, Ordering::Relaxed);
    });
}

/// 确保会话存在：缺则按 `shell` 起常驻 shell；再做空闲回收与容量淘汰。
fn ensure_session(
    session_id: &str,
    shell: Option<SessionShell>,
    env: &[(String, String)],
    cwd: Option<&PathBuf>,
    mem_mb: u64,
    procs_max: u32,
    isolation: &crate::exec::Isolation,
) -> Result<Arc<Session>, (String, String)> {
    let mut map = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    // 空闲回收（先摘出再杀，避免持锁做重活）。
    let mut expired: Vec<Arc<Session>> = Vec::new();
    map.retain(|_, session| {
        let idle = session
            .last_used
            .lock()
            .map(|last| now.duration_since(*last).as_millis() as u64 > SESSION_IDLE_MS)
            .unwrap_or(false);
        let keep = !idle && !session.dead();
        if !keep {
            expired.push(Arc::clone(session));
        }
        keep
    });
    for session in expired {
        session.kill();
    }
    if let Some(existing) = map.get(session_id) {
        if !existing.dead() {
            existing.touch();
            return Ok(Arc::clone(existing));
        }
    }
    map.remove(session_id);
    if map.len() >= SESSION_CAPACITY {
        let victim = map
            .iter()
            .filter(|(_, session)| !session.busy.load(Ordering::Relaxed))
            .min_by_key(|(_, session)| session.last_used.lock().map(|l| *l).unwrap_or(now))
            .map(|(id, _)| id.clone());
        if let Some(victim) = victim {
            if let Some(session) = map.remove(&victim) {
                session.kill();
            }
        }
    }
    let Some(shell) = shell else {
        return Err(("session_missing".to_string(), "session does not exist and no shell provided".to_string()));
    };
    let session = spawn_session(&shell, env, cwd, mem_mb, procs_max, isolation)?;
    map.insert(session_id.to_string(), Arc::clone(&session));
    Ok(session)
}

#[cfg(windows)]
fn spawn_session(
    shell: &SessionShell,
    env: &[(String, String)],
    cwd: Option<&PathBuf>,
    mem_mb: u64,
    procs_max: u32,
    _isolation: &crate::exec::Isolation,
) -> Result<Arc<Session>, (String, String)> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    use crate::exec::minimal_env;
    use crate::win32::JobHandle;

    let mut command = Command::new(&shell.cmd);
    command.args(&shell.args);
    command.env_clear();
    for (key, value) in minimal_env() {
        command.env(key, value);
    }
    for (key, value) in env {
        command.env(key, value);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.creation_flags(CREATE_NO_WINDOW.0);
    let mut child = command
        .spawn()
        .map_err(|err| ("sandbox_setup_failed".to_string(), format!("session spawn failed: {err}")))?;

    // 会话 shell 只挂内存 / 进程数上限（CPU 时间上限按整会话累计会误杀，故不设）；超时由命令执行器按墙钟强制。
    let job = JobHandle::create(mem_mb.saturating_mul(1024 * 1024), 0, procs_max).ok();
    if let Some(job) = &job {
        use std::ffi::c_void;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        let handle = HANDLE(child.as_raw_handle() as *mut c_void);
        let _ = job.assign(handle);
    }

    let raw = Arc::new(Mutex::new(OutputBuf::new(SESSION_RAW_CAP)));
    let alive = Arc::new(AtomicBool::new(true));
    spawn_session_reader(child.stdout.take(), Arc::clone(&raw), Arc::clone(&alive));
    spawn_session_reader(child.stderr.take(), Arc::clone(&raw), Arc::clone(&alive));
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| ("sandbox_setup_failed".to_string(), "session stdin unavailable".to_string()))?;
    Ok(Arc::new(Session {
        shell: Mutex::new(child),
        stdin: Mutex::new(stdin),
        raw,
        alive,
        busy: AtomicBool::new(false),
        syntax: shell.syntax.clone(),
        last_used: Mutex::new(Instant::now()),
        job: job.map(Arc::new),
    }))
}

#[cfg(not(windows))]
fn spawn_session(
    shell: &SessionShell,
    env: &[(String, String)],
    cwd: Option<&PathBuf>,
    mem_mb: u64,
    procs_max: u32,
    isolation: &crate::exec::Isolation,
) -> Result<Arc<Session>, (String, String)> {
    #[cfg(target_os = "linux")]
    {
        linux_spawn_session(shell, env, cwd, mem_mb, procs_max, isolation)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (shell, env, cwd, mem_mb, procs_max, isolation);
        Err((
            "sandbox_unsupported".to_string(),
            "persistent sessions require native isolation (not implemented on this platform)".to_string(),
        ))
    }
}

/// Linux 常驻会话：bash -s + 三管道；进程组树杀；内存 / 进程数用 cgroup（无 cgroup 只回退内存），
/// 并施加 landlock（按创建时档位的 fs 范围）与 seccomp 基础集。**不含**命名空间：会话长寿且被跨
/// 不同 caps 的命令复用，绑定某一网络的 net namespace 会误伤后续命令。
#[cfg(target_os = "linux")]
fn linux_spawn_session(
    shell: &SessionShell,
    env: &[(String, String)],
    cwd: Option<&PathBuf>,
    mem_mb: u64,
    procs_max: u32,
    isolation: &crate::exec::Isolation,
) -> Result<Arc<Session>, (String, String)> {
    use std::os::unix::io::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    use crate::exec::minimal_env;
    use crate::landlock;
    use crate::linux::{set_rlimit, write_all, RLIMIT_AS};

    let mut command = Command::new(&shell.cmd);
    command.args(&shell.args);
    command.env_clear();
    for (key, value) in minimal_env() {
        command.env(key, value);
    }
    for (key, value) in env {
        command.env(key, value);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.process_group(0);

    let mem_bytes = mem_mb.saturating_mul(1024 * 1024);
    let cgroup = crate::cgroup::Cgroup::create(&crate::exec::cgroup_id(), mem_bytes, procs_max);
    let cgroup_procs = cgroup.as_ref().and_then(|group| group.procs_file().ok());
    let use_cgroup_mem = cgroup_procs.is_some() && mem_bytes > 0;
    let cgroup_fd = cgroup_procs.as_ref().map(|file| file.as_raw_fd());

    let ruleset = landlock::build_ruleset(
        isolation.workspace_root.as_deref(),
        isolation.fs_read,
        isolation.fs_write,
    )
    .ok()
    .flatten();
    let ruleset_fd = ruleset.as_ref().map(|file| file.as_raw_fd());
    let seccomp_filter = if crate::seccomp::available() {
        Some(crate::seccomp::build_filter(false))
    } else {
        None
    };

    // SAFETY: pre_exec 内只调用异步信号安全接口（setrlimit / write / prctl / landlock / seccomp）。
    unsafe {
        command.pre_exec(move || {
            if mem_bytes > 0 && !use_cgroup_mem {
                set_rlimit(RLIMIT_AS, mem_bytes, mem_bytes)?;
            }
            if let Some(fd) = cgroup_fd {
                write_all(fd, b"0")?;
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

    let mut child = command
        .spawn()
        .map_err(|err| ("sandbox_setup_failed".to_string(), format!("session spawn failed: {err}")))?;
    let raw = Arc::new(Mutex::new(OutputBuf::new(SESSION_RAW_CAP)));
    let alive = Arc::new(AtomicBool::new(true));
    spawn_session_reader(child.stdout.take(), Arc::clone(&raw), Arc::clone(&alive));
    spawn_session_reader(child.stderr.take(), Arc::clone(&raw), Arc::clone(&alive));
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| ("sandbox_setup_failed".to_string(), "session stdin unavailable".to_string()))?;
    Ok(Arc::new(Session {
        shell: Mutex::new(child),
        stdin: Mutex::new(stdin),
        raw,
        alive,
        busy: AtomicBool::new(false),
        syntax: shell.syntax.clone(),
        last_used: Mutex::new(Instant::now()),
        cgroup,
    }))
}

// ── 会话命令：哨兵帧 ────────────────────────────────────────────────────────

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// 把一条命令包装成「命令 + 哨兵」脚本。PowerShell 走 base64 + `Invoke-Expression`（支持多行，
/// 且在调用作用域执行，故 `cd` / `$env:` 延续）；POSIX 直接贴命令 + `printf` 哨兵。
fn wrap_command(syntax: &str, command: &str, marker: &str) -> String {
    if syntax == "posix" {
        return format!("{command}\nprintf '{marker}%s\\n' \"$?\"\n");
    }
    let encoded = base64_encode(command.as_bytes());
    format!(
        "$global:LASTEXITCODE = 0\n$__chrono = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))\nInvoke-Expression $__chrono\nWrite-Output ('{marker}' + [string]$LASTEXITCODE)\n"
    )
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// 解析哨兵后的退出码（首个整数；缺失 / 非数按 0）。
fn parse_exit_code(after: &[u8]) -> i32 {
    let text = String::from_utf8_lossy(after);
    let digits: String = text.chars().skip_while(|c| !c.is_ascii_digit() && *c != '-').take_while(|c| c.is_ascii_digit() || *c == '-').collect();
    digits.parse::<i32>().unwrap_or(0)
}

fn run_session_command(
    session: Arc<Session>,
    command: String,
    output: Arc<Mutex<OutputBuf>>,
    status: Arc<Mutex<TaskStatus>>,
    timeout_ms: u64,
) {
    let marker = format!("__CHRONO_END_{}__", next_id("m"));
    let script = wrap_command(&session.syntax, &command, &marker);
    if let Ok(mut raw) = session.raw.lock() {
        raw.clear();
    }
    let write_result = match session.stdin.lock() {
        Ok(mut stdin) => stdin.write_all(script.as_bytes()).and_then(|_| stdin.flush()),
        Err(_) => Err(std::io::Error::new(std::io::ErrorKind::Other, "session stdin poisoned")),
    };
    if let Err(err) = write_result {
        finish_task(&status, None, Some("session_write_failed"), Some(format!("session stdin write failed: {err}")));
        session.busy.store(false, Ordering::Relaxed);
        return;
    }

    let start = Instant::now();
    let mut consumed = 0usize;
    let mut exit_code: Option<i32> = None;
    let mut code: Option<String> = None;
    loop {
        if session.dead() {
            match session.reap_exit_code() {
                Some(code) => exit_code = Some(code),
                None => code = Some("session_died".to_string()),
            }
            break;
        }
        let mut found = false;
        if let Ok(raw) = session.raw.lock() {
            if let Some(pos) = find_bytes(&raw.bytes, marker.as_bytes()) {
                if let Ok(mut buf) = output.lock() {
                    buf.push(&raw.bytes[consumed.min(pos)..pos]);
                }
                exit_code = Some(parse_exit_code(&raw.bytes[pos + marker.len()..]));
                found = true;
            } else {
                if let Ok(mut buf) = output.lock() {
                    buf.push(&raw.bytes[consumed.min(raw.bytes.len())..]);
                }
                consumed = raw.bytes.len();
            }
        }
        if found {
            break;
        }
        if timeout_ms > 0 && start.elapsed().as_millis() as u64 >= timeout_ms {
            code = Some("timeout".to_string());
            session.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    if let Ok(mut raw) = session.raw.lock() {
        raw.clear();
    }
    finish_task(&status, exit_code, code.as_deref(), None);
    session.busy.store(false, Ordering::Relaxed);
    session.touch();
}

fn finish_task(status: &Arc<Mutex<TaskStatus>>, exit_code: Option<i32>, code: Option<&str>, _message: Option<String>) {
    if let Ok(mut state) = status.lock() {
        state.running = false;
        state.exit_code = exit_code;
        state.code = code.map(str::to_string);
    }
}

/// 启动一条会话命令任务；会话被占用即 `session_busy`。
pub fn start_session_task(
    session_id: &str,
    command: &str,
    shell: Option<SessionShell>,
    env: Vec<(String, String)>,
    cwd: Option<PathBuf>,
    mem_mb: u64,
    procs_max: u32,
    timeout_ms: u64,
    output_max: usize,
    isolation: crate::exec::Isolation,
) -> Result<String, (String, String)> {
    let session = ensure_session(session_id, shell, &env, cwd.as_ref(), mem_mb, procs_max, &isolation)?;
    if session.busy.swap(true, Ordering::SeqCst) {
        return Err(("session_busy".to_string(), "another command is running in this session".to_string()));
    }
    let output = Arc::new(Mutex::new(OutputBuf::new(output_max)));
    let status = Arc::new(Mutex::new(TaskStatus {
        running: true,
        exit_code: None,
        code: None,
    }));
    let kill_session: Arc<Session> = Arc::clone(&session);
    let kill: Box<dyn Fn() + Send + Sync> = Box::new(move || kill_session.clone().kill());
    let task_id = register_task(Arc::clone(&output), Arc::clone(&status), kill);
    let command = command.to_string();
    std::thread::spawn(move || run_session_command(session, command, output, status, timeout_ms));
    Ok(task_id)
}

// ── 一次性进程任务 ──────────────────────────────────────────────────────────

/// 读线程：把进程输出持续推入有界缓冲（前台 / 后台 / 会话共用的输出侧）。
fn spawn_pump<R: Read + Send + 'static>(reader: Option<R>, output: Arc<Mutex<OutputBuf>>) {
    std::thread::spawn(move || {
        let Some(mut reader) = reader else { return };
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if let Ok(mut buf) = output.lock() {
                        buf.push(&chunk[..read]);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// 非阻塞起一次性进程：输出经读线程入有界缓冲，监视线程按上限杀整树并回填状态。
#[cfg(windows)]
pub fn start_process_task(request: ExecRequest) -> Result<String, (String, String)> {
    let mut spawned = crate::exec::spawn_process(&request)
        .map_err(|err| (err.code().to_string(), err.message().to_string()))?;
    let output = Arc::new(Mutex::new(OutputBuf::new(request.output_max)));
    let status = Arc::new(Mutex::new(TaskStatus {
        running: true,
        exit_code: None,
        code: None,
    }));
    spawn_pump(spawned.child.stdout.take(), Arc::clone(&output));
    spawn_pump(spawned.child.stderr.take(), Arc::clone(&output));
    let pid = spawned.pid;
    let attached = spawned.job_attached;
    let job_for_kill = Arc::clone(&spawned.job);
    let kill: Box<dyn Fn() + Send + Sync> = Box::new(move || {
        if attached {
            job_for_kill.terminate(1);
        } else {
            let _ = crate::win32::kill_tree(pid);
        }
    });
    let task_id = register_task(Arc::clone(&output), Arc::clone(&status), kill);
    let job = Arc::clone(&spawned.job);
    let mut child = spawned.child;
    std::thread::spawn(move || {
        let start = Instant::now();
        let (exit_code, reason) =
            crate::exec::monitor_process(&mut child, &job, attached, pid, &request, start);
        let _ = child.wait();
        finish_task(&status, exit_code, reason.as_deref(), None);
    });
    Ok(task_id)
}

/// 非阻塞起一次性进程（Linux）：复用 `exec::spawn_linux` / `monitor_linux` 的隔离与树杀，
/// 输出经读线程入有界缓冲，监视线程按上限杀整组并回填状态。
#[cfg(not(windows))]
pub fn start_process_task(request: ExecRequest) -> Result<String, (String, String)> {
    #[cfg(target_os = "linux")]
    {
        let mut spawn = crate::exec::spawn_linux(&request)
            .map_err(|err| (err.code().to_string(), err.message().to_string()))?;
        let output = Arc::new(Mutex::new(OutputBuf::new(request.output_max)));
        let status = Arc::new(Mutex::new(TaskStatus {
            running: true,
            exit_code: None,
            code: None,
        }));
        spawn_pump(spawn.child.stdout.take(), Arc::clone(&output));
        spawn_pump(spawn.child.stderr.take(), Arc::clone(&output));
        let pgid = spawn.pgid;
        let kill: Box<dyn Fn() + Send + Sync> = Box::new(move || {
            crate::linux::kill_group(pgid);
        });
        let task_id = register_task(Arc::clone(&output), Arc::clone(&status), kill);
        std::thread::spawn(move || {
            let start = Instant::now();
            let (exit_code, reason) = crate::exec::monitor_linux(&mut spawn, &request, start);
            let _ = spawn.child.wait();
            spawn.cleanup();
            finish_task(&status, exit_code, reason.as_deref(), None);
        });
        Ok(task_id)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = request;
        Err((
            "sandbox_unsupported".to_string(),
            "native exec isolation is not implemented on this platform".to_string(),
        ))
    }
}

// ── 轮询 / 杀 / 关会话 ──────────────────────────────────────────────────────

/// `exec_poll`：自 `cursor` 起取新输出（可选 `wait_ms` 等待新数据或结束）。
pub fn poll(bag: &Value) -> Result<Value, (String, String)> {
    let task_id = bag
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ("bad_args".to_string(), "task_id required".to_string()))?;
    let cursor = bag.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
    let wait_ms = bag.get("wait_ms").and_then(Value::as_u64).unwrap_or(0);
    let entry = {
        let map = tasks().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        map.get(task_id).cloned()
    };
    let Some(entry) = entry else {
        return Err(("task_not_found".to_string(), format!("no task {task_id}")));
    };
    wait_for_output(&entry, cursor, wait_ms);
    let (text, next_cursor, truncated, dropped, tail) = {
        let buf = entry.output.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (text, next) = slice_from_cursor(&buf, cursor);
        (text, next, buf.truncated(), buf.dropped, buf.tail_text())
    };
    let status = entry.status.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(json!({
        "output": text,
        "next_cursor": next_cursor,
        "running": status.running,
        "exit_code": status.exit_code,
        "code": status.code,
        "truncated": truncated,
        "dropped_bytes": dropped,
        "tail": tail,
    }))
}

fn wait_for_output(entry: &Arc<TaskEntry>, cursor: usize, wait_ms: u64) {
    if wait_ms == 0 {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    loop {
        let len = entry.output.lock().map(|buf| buf.bytes.len()).unwrap_or(0);
        let running = entry.status.lock().map(|s| s.running).unwrap_or(false);
        if len > cursor || !running || Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// `exec_kill`：杀任务（一次性 = 杀进程树；会话命令 = 杀会话）。
pub fn kill(bag: &Value) -> Result<Value, (String, String)> {
    let task_id = bag
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ("bad_args".to_string(), "task_id required".to_string()))?;
    let entry = {
        let map = tasks().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        map.get(task_id).cloned()
    };
    let Some(entry) = entry else {
        return Err(("task_not_found".to_string(), format!("no task {task_id}")));
    };
    (entry.kill)();
    finish_task(&entry.status, None, Some("killed"), None);
    Ok(json!({ "killed": true }))
}

/// `session_close`：关闭并回收一个会话。
pub fn session_close(bag: &Value) -> Result<Value, (String, String)> {
    let session_id = bag
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ("bad_args".to_string(), "session_id required".to_string()))?;
    let removed = {
        let mut map = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        map.remove(session_id)
    };
    let Some(session) = removed else {
        return Ok(json!({ "closed": false }));
    };
    session.kill();
    Ok(json!({ "closed": true }))
}
