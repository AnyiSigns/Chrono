// `sandbox-exec` 服务进程协议面：进程 / 会话执行体生命周期；帧编解码 / 控制帧 / 线程派发走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。
// 档位判定优先取 `sandbox-policy.resolve` 注入的 `bag.resolved`；缺省回落内建同源判定。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, ServiceError, ServiceHandler, ServiceSpec};

use crate::exec;
use crate::grant;
use crate::pathnorm::is_inside_resolved;
use crate::session;
use crate::tiers::{self, FsScope, NetScope};

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "sandbox-exec";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 6] = [
    "exec",
    "exec_start",
    "exec_poll",
    "exec_kill",
    "session_close",
    "capabilities",
];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 处理 `call`：能力类 / 方法 / args 形态门禁 + 方法分派。
pub fn handle_call(method: &str, args: &Value, env: &CallEnv) -> Result<Value, (String, String)> {
    match method {
        "capabilities" => Ok(capabilities()),
        "exec" => handle_exec(args, env),
        "exec_start" => handle_exec_start(args, env),
        "exec_poll" => session::poll(args),
        "exec_kill" => session::kill(args),
        "session_close" => session::session_close(args),
        other => Err(("unknown_method".to_string(), format!("unknown method {other}"))),
    }
}

/// 一次 exec 的判定上下文：caps + 档位策略 + deny / 实现名。
struct Gates {
    caps: tiers::Caps,
    policy: tiers::TierPolicy,
    deny: bool,
    impl_name: String,
    docker_image: String,
}

/// tier / deny / net 门禁 + caps 解析（`exec` 与 `exec_start` 共用）。
/// 优先取 `sandbox-policy.resolve` 注入的 `bag.resolved`；缺省回落内建同源判定。
fn validate_exec_gates(args: &Value, env: &CallEnv) -> Result<Gates, (String, String)> {
    let gates = match resolved_gates(args) {
        Some(gates) => gates,
        None => {
            let config = tiers::parse_tiers(args.get("sandbox_tiers"));
            let tier = args.get("tier").and_then(Value::as_str);
            let policy = config.policy(tier);
            let caps = tiers::parse_caps(args.get("caps"), &policy, &config.defaults);
            Gates {
                deny: policy.fs_read == FsScope::None && policy.fs_write == FsScope::None,
                caps,
                policy,
                impl_name: config.impl_name,
                docker_image: config.docker_image,
            }
        }
    };

    // net 声明越档 → net_denied（声明级强制；实现尽力）。
    if !tiers::net_within_tier(&gates.caps, &gates.policy)
        && !grant_relaxes_net(args, env, &gates.caps, &gates.policy)
    {
        return Err((
            "net_denied".to_string(),
            format!(
                "declared net {} exceeds tier net {}",
                gates.caps.net.as_str(),
                gates.policy.net.as_str()
            ),
        ));
    }
    // deny 档全拒（本插件永不发升级、只拒绝；grant 也不放宽 deny）。
    if gates.deny {
        return Err(("fs_denied".to_string(), "deny tier rejects exec".to_string()));
    }
    Ok(gates)
}

/// 由 `bag.resolved`（`sandbox-policy.resolve` 输出）构造判定上下文；
/// 缺失或形态不合回落 `None`（由内建判定兜底）。
fn resolved_gates(args: &Value) -> Option<Gates> {
    let resolved = args.get("resolved")?;
    let deny = resolved.get("deny_tier")?.as_bool()?;
    let caps = resolved.get("caps")?;
    let fs_read = FsScope::parse(resolved.get("fs_read"), FsScope::None);
    let fs_write = FsScope::parse(resolved.get("fs_write"), FsScope::None);
    let net = NetScope::parse(caps.get("net")).unwrap_or(NetScope::None);
    let policy_net = NetScope::parse(resolved.get("policy_net")).unwrap_or(NetScope::None);
    Some(Gates {
        caps: tiers::Caps {
            fs_read,
            fs_write,
            net,
            net_declared: caps.get("net_declared").and_then(Value::as_bool).unwrap_or(false),
            timeout_ms: caps.get("timeout_ms").and_then(Value::as_u64).unwrap_or(30_000),
            mem_mb: caps.get("mem_mb").and_then(Value::as_u64).unwrap_or(1024),
            cpu_ms: caps.get("cpu_ms").and_then(Value::as_u64).unwrap_or(0),
            output_max: caps
                .get("output_max")
                .and_then(Value::as_u64)
                .unwrap_or(1024 * 1024) as usize,
            procs_max: caps.get("procs_max").and_then(Value::as_u64).unwrap_or(32) as u32,
        },
        policy: tiers::TierPolicy { fs_read, fs_write, net: policy_net },
        deny,
        impl_name: resolved
            .get("impl")
            .and_then(Value::as_str)
            .unwrap_or("native")
            .to_string(),
        docker_image: resolved
            .get("docker_image")
            .and_then(Value::as_str)
            .unwrap_or("alpine:3")
            .to_string(),
    })
}

/// 解析并校验一次性 exec 请求（caps / cwd 落地）。
fn prepare_exec(args: &Value, env: &CallEnv) -> Result<(exec::ExecRequest, Gates), (String, String)> {
    let gates = validate_exec_gates(args, env)?;
    let mut request = exec::parse_request(args, gates.caps.output_max)
        .map_err(|err| (err.code().to_string(), err.message().to_string()))?;
    request.timeout_ms = gates.caps.timeout_ms;
    request.mem_mb = gates.caps.mem_mb;
    request.cpu_ms = gates.caps.cpu_ms;
    request.procs_max = gates.caps.procs_max;
    if let Some(cwd) = resolve_cwd(args, &gates.caps, &gates.policy)? {
        request.cwd = Some(cwd);
    }
    request.isolation = isolation_for(args, &gates.caps, &gates.policy);
    Ok((request, gates))
}

/// 从 bag + 「caps ∩ 档位」解析一次执行的隔离上下文（workspace 根 + 实际放行 fs 范围 + net）。
fn isolation_for(args: &Value, caps: &tiers::Caps, policy: &tiers::TierPolicy) -> exec::Isolation {
    let effective = tiers::effective_scope(caps, policy);
    let workspace_root = args
        .get("workspace_root")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    exec::Isolation {
        workspace_root,
        fs_read: effective.fs_read,
        fs_write: effective.fs_write,
        net: caps.net,
    }
}

fn handle_exec(args: &Value, env: &CallEnv) -> Result<Value, (String, String)> {
    if let Some(session_id) = args.get("session_id").and_then(Value::as_str) {
        return handle_session_exec(session_id, args, env);
    }
    let (request, gates) = prepare_exec(args, env)?;
    run_prepared(&request, &gates)
}

/// 会话命令（阻塞形态）：在常驻 shell 内执行，轮询到结束再按头尾口径回。
fn handle_session_exec(session_id: &str, args: &Value, env: &CallEnv) -> Result<Value, (String, String)> {
    let gates = validate_exec_gates(args, env)?;
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ("bad_args".to_string(), "command required for session exec".to_string()))?;
    let shell = parse_session_shell(args.get("session_shell"));
    let cwd = resolve_cwd(args, &gates.caps, &gates.policy)?;
    let env_pairs = parse_env_pairs(args);
    let start = Instant::now();
    let task_id = session::start_session_task(
        session_id,
        command,
        shell,
        env_pairs,
        cwd,
        gates.caps.mem_mb,
        gates.caps.procs_max,
        gates.caps.timeout_ms,
        gates.caps.output_max,
        isolation_for(args, &gates.caps, &gates.policy),
    )?;

    let mut merged = String::new();
    let mut truncated = false;
    let mut cursor = 0usize;
    let (exit_code, code) = loop {
        let polled = session::poll(&json!({ "task_id": task_id, "cursor": cursor, "wait_ms": 200 }))?;
        if let Some(text) = polled.get("output").and_then(Value::as_str) {
            merged.push_str(text);
        }
        cursor = polled.get("next_cursor").and_then(Value::as_u64).unwrap_or(cursor as u64) as usize;
        if polled.get("truncated").and_then(Value::as_bool) == Some(true) {
            truncated = true;
        }
        if polled.get("running").and_then(Value::as_bool) != Some(true) {
            let exit_code = polled.get("exit_code").and_then(Value::as_i64).map(|value| value as i32);
            let code = polled.get("code").and_then(Value::as_str).map(str::to_string);
            break (exit_code, code);
        }
    };

    let (text, extra_truncated, omitted) = exec::capture_text(&merged, gates.caps.output_max);
    let truncated = truncated || extra_truncated;
    Ok(json!({
        "exit_code": exit_code,
        "stdout": text.clone(),
        "stderr": "",
        "truncated": truncated,
        "omitted_bytes": omitted,
        "combined": [{ "stream": "stdout", "text": text }],
        "combined_truncated": truncated,
        "duration_ms": start.elapsed().as_millis() as u64,
        "code": code,
    }))
}

/// `exec_start`：起一个可轮询的任务（会话命令或一次性进程），立即回 `task_id`。
fn handle_exec_start(args: &Value, env: &CallEnv) -> Result<Value, (String, String)> {
    if let Some(session_id) = args.get("session_id").and_then(Value::as_str) {
        let gates = validate_exec_gates(args, env)?;
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ("bad_args".to_string(), "command required for session exec".to_string()))?;
        let shell = parse_session_shell(args.get("session_shell"));
        let cwd = resolve_cwd(args, &gates.caps, &gates.policy)?;
        let env_pairs = parse_env_pairs(args);
        let task_id = session::start_session_task(
            session_id,
            command,
            shell,
            env_pairs,
            cwd,
            gates.caps.mem_mb,
            gates.caps.procs_max,
            gates.caps.timeout_ms,
            gates.caps.output_max,
            isolation_for(args, &gates.caps, &gates.policy),
        )?;
        return Ok(json!({ "task_id": task_id }));
    }
    let (request, _gates) = prepare_exec(args, env)?;
    let task_id = session::start_process_task(request)?;
    Ok(json!({ "task_id": task_id }))
}

fn run_prepared(request: &exec::ExecRequest, gates: &Gates) -> Result<Value, (String, String)> {
    let outcome = if gates.impl_name == "docker" {
        if !docker_available() {
            return Err((
                "sandbox_unsupported".to_string(),
                "docker runtime unavailable".to_string(),
            ));
        }
        let network = match gates.policy.net {
            NetScope::All => "bridge",
            _ => "none",
        };
        exec::run_docker(request, &gates.docker_image, network)
    } else {
        exec::run(request)
    }
    .map_err(|err| (err.code().to_string(), err.message().to_string()))?;

    Ok(json!({
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "truncated": outcome.truncated,
        "omitted_bytes": outcome.omitted_bytes,
        "combined": outcome
            .combined
            .iter()
            .map(|(is_err, text)| json!({ "stream": if *is_err { "stderr" } else { "stdout" }, "text": text }))
            .collect::<Vec<Value>>(),
        "combined_truncated": outcome.combined_truncated,
        "duration_ms": outcome.duration_ms,
        "code": outcome.code,
    }))
}

/// 会话 shell 口径（tool-shell 按平台提供）：`{cmd, args, syntax}`。
fn parse_session_shell(value: Option<&Value>) -> Option<session::SessionShell> {
    let object = value?.as_object()?;
    let cmd = object.get("cmd")?.as_str()?.to_string();
    let args = object
        .get("args")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let syntax = object.get("syntax").and_then(Value::as_str).unwrap_or("powershell").to_string();
    Some(session::SessionShell { cmd, args, syntax })
}

/// `env` 键值对：`args.env` 或 bag 顶层 `env`（值转字符串，非法丢弃）。
fn parse_env_pairs(args: &Value) -> Vec<(String, String)> {
    args.get("env")
        .or_else(|| args.get("args").and_then(|inner| inner.get("env")))
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| match value {
                    Value::String(text) => Some((key.clone(), text.clone())),
                    Value::Number(number) => Some((key.clone(), number.to_string())),
                    Value::Bool(flag) => Some((key.clone(), flag.to_string())),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 解析并校验 cwd：`bag.cwd` > `workspace_root`；区外须当前档 fs 读范围为 `full`。
fn resolve_cwd(
    args: &Value,
    caps: &tiers::Caps,
    policy: &tiers::TierPolicy,
) -> Result<Option<PathBuf>, (String, String)> {
    let raw = args
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            args.get("workspace_root")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        });
    let Some(text) = raw else {
        return Ok(None);
    };
    let cwd = PathBuf::from(text);
    let workspace_root = args
        .get("workspace_root")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let inside = workspace_root
        .map(|root| is_inside_resolved(&cwd, Path::new(root)))
        .unwrap_or(false);
    if !inside && !tiers::effective_scope(caps, policy).allows_read(false) {
        return Err((
            "fs_denied".to_string(),
            "cwd is outside workspace_root".to_string(),
        ));
    }
    Ok(Some(cwd))
}

/// 有效一次性 grant 且其 net 范围覆盖声明时放宽 net（消费一次）。
fn grant_relaxes_net(
    args: &Value,
    env: &CallEnv,
    caps: &tiers::Caps,
    policy: &tiers::TierPolicy,
) -> bool {
    let raw = args
        .get("grant")
        .or_else(|| args.get("caps").and_then(|caps| caps.get("grant")));
    let Some(grant) = grant::parse_grant(raw) else {
        return false;
    };
    // 绑定 op：只有批准 `exec` 的 grant 才放宽 exec 的 net。
    if grant.op.as_deref() != Some("exec") {
        return false;
    }
    if !grant.paths.is_empty() {
        // exec 无单一目标路径，带路径范围的 grant 不适用于此。
        return false;
    }
    let mut store = grant::global_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match grant::redeem(&grant, args.get("tier").and_then(Value::as_str), env.now, &mut store) {
        Ok(outcome) => outcome
            .net
            .map(|net| net.rank() >= caps.net.rank() && net.rank() <= policy.net.rank().max(caps.net.rank()))
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// 本机 docker 运行时可用性（`docker version`，3s 上限）；结果进程内缓存。
pub fn docker_available() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        let mut child = match Command::new("docker")
            .args(["version", "--format", "{{.Server.Version}}"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return false,
        };
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) => {}
                Err(_) => return false,
            }
            if start.elapsed() >= Duration::from_secs(3) {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    })
}

/// landlock ABI（非 Linux 恒为 `None`）。
#[cfg(target_os = "linux")]
fn linux_landlock_abi() -> Option<i32> {
    crate::landlock::abi()
}

#[cfg(not(target_os = "linux"))]
fn linux_landlock_abi() -> Option<i32> {
    None
}

/// cgroup v2 可用性（非 Linux 恒为 false）。
#[cfg(target_os = "linux")]
fn linux_cgroup_available() -> bool {
    crate::cgroup::available()
}

#[cfg(not(target_os = "linux"))]
fn linux_cgroup_available() -> bool {
    false
}

/// seccomp 过滤可用性（非 Linux 恒为 false）。
#[cfg(target_os = "linux")]
fn linux_seccomp_available() -> bool {
    crate::seccomp::available()
}

#[cfg(not(target_os = "linux"))]
fn linux_seccomp_available() -> bool {
    false
}

/// 命名空间（user / mount / net）可用性（非 Linux 恒为 false）。
#[cfg(target_os = "linux")]
fn linux_namespaces_available() -> bool {
    crate::namespaces::available()
}

#[cfg(not(target_os = "linux"))]
fn linux_namespaces_available() -> bool {
    false
}

/// `capabilities`：本机可用实现与平台能力（自述面）。
pub fn capabilities() -> Value {
    let platform = std::env::consts::OS;
    let native = cfg!(any(windows, target_os = "linux"));
    let docker = docker_available();
    // Linux 隔离层运行态探测（机器能力只走运行态，不落世界）：landlock ABI / cgroup v2。
    let landlock_abi = linux_landlock_abi();
    let cgroup_ok = linux_cgroup_available();
    let seccomp_ok = linux_seccomp_available();
    let namespaces_ok = linux_namespaces_available();
    // 如实自述各后端实际启用的强制项：未实现的隔离层不列出（方案见 README 的落地顺序）。
    let features: Vec<String> = if cfg!(windows) {
        [
            "job_object",
            "process_tree",
            "timeout",
            "mem_limit",
            "cpu_limit",
            "procs_limit",
            "output_truncate",
            "ordered_streams",
        ]
        .iter()
        .map(|item| item.to_string())
        .collect()
    } else if cfg!(target_os = "linux") {
        let mut items: Vec<String> = [
            "process_group",
            "timeout",
            "mem_limit",
            "cpu_limit",
            "procs_limit",
            "output_truncate",
            "ordered_streams",
        ]
        .iter()
        .map(|item| item.to_string())
        .collect();
        if landlock_abi.is_some() {
            items.push("landlock".to_string());
        }
        if cgroup_ok {
            items.push("cgroup_v2".to_string());
        }
        if seccomp_ok {
            items.push("seccomp".to_string());
        }
        if namespaces_ok {
            items.push("namespaces".to_string());
        }
        items
    } else {
        Vec::new()
    };
    // exec 的 fs 强制点：Linux 有 landlock 即为 `landlock`（仅限 workspace / none 档生效），否则不强制。
    let exec_fs = if cfg!(target_os = "linux") && landlock_abi.is_some() {
        "landlock"
    } else {
        "none"
    };
    let docker_features: Vec<String> = if docker {
        [
            "read_only_root",
            "non_root_user",
            "network_isolation",
            "mem_limit",
            "pids_limit",
            "output_truncate",
            "ordered_streams",
        ]
        .iter()
        .map(|item| item.to_string())
        .collect()
    } else {
        Vec::new()
    };
    json!({
        "platform": platform,
        "implementations": [
            {
                "impl": "native",
                "available": native,
                "isolation": "partial",
                "features": features,
                "reason": if native { Value::Null } else { json!("no native isolation on this platform") }
            },
            {
                "impl": "docker",
                "available": docker,
                "isolation": "container",
                "features": docker_features,
                "reason": if docker { Value::Null } else { json!("docker runtime unavailable") }
            }
        ],
        "default_impl": "native",
        // 只有 Linux 才有的隔离层探测明细：landlock ABI 版本（null=不可用）/ cgroup v2 / seccomp / namespaces。
        "linux": {
            "landlock_abi": landlock_abi,
            "cgroup_v2": cgroup_ok,
            "seccomp": seccomp_ok,
            // 实际施加的命名空间种类；**不含 pid**（见 namespaces.rs 的取舍说明）。
            "namespaces": if namespaces_ok { json!(["user", "mount", "net"]) } else { json!([]) },
        },
        // 如实自述：`fsop` 为进程内校验；`exec` 的 fs 范围在 Linux 由 landlock 强制（workspace / none 档）；
        // net 在 Linux 由 net namespace（`caps.net == none`）硬隔离，命名空间不可用时退回 seccomp 套接字过滤。
        "enforcement": {
            "fsop": "in_process",
            "exec_fs": exec_fs,
            "net": if namespaces_ok {
                "namespaces"
            } else if seccomp_ok {
                "seccomp"
            } else {
                "declaration"
            }
        }
    })
}

/// 调用处理器：解析调用帧 `env`，把领域错误映射为协议错误。
struct Handler;

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        let env = CallEnv::parse_value(env);
        handle_call(method, args, &env).map_err(ServiceError::from)
    }
}

/// 服务入口：帧循环由 SDK 起（`call` 独立线程执行，控制帧不被阻塞）。
pub fn run_loop<R: std::io::Read, W: std::io::Write + Send + 'static>(reader: R, writer: W) {
    let shared = plugin_sdk::shared_writer(writer);
    plugin_sdk::run_service(&SPEC, reader, shared, Handler);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_cwd_outside_workspace_denied_in_severe() {
        let base = std::env::temp_dir().join(format!("chrono-cwd-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let err = handle_call(
            "exec",
            &json!({
                "cmd": "cmd.exe",
                "args": ["/c", "echo hi"],
                "cwd": outside.to_string_lossy(),
                "workspace_root": root.to_string_lossy(),
                "tier": "severe",
                "sandbox_tiers": tiers::builtin_tiers().to_value(),
            }),
            &CallEnv::default(),
        )
        .unwrap_err();
        assert_eq!(err.0, "fs_denied");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn exec_cwd_inside_workspace_not_denied() {
        let base = std::env::temp_dir().join(format!("chrono-cwd-in-{}", std::process::id()));
        let root = base.join("root");
        let inside = root.join("sub");
        std::fs::create_dir_all(&inside).unwrap();
        let outcome = handle_call(
            "exec",
            &json!({
                "cmd": "cmd.exe",
                "args": ["/c", "echo hi"],
                "cwd": inside.to_string_lossy(),
                "workspace_root": root.to_string_lossy(),
                "tier": "severe",
                "sandbox_tiers": tiers::builtin_tiers().to_value(),
            }),
            &CallEnv::default(),
        );
        if let Err((code, _)) = outcome {
            assert_ne!(code, "fs_denied");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn exec_cwd_outside_workspace_allowed_in_auto() {
        let base = std::env::temp_dir().join(format!("chrono-cwd-auto-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outcome = handle_call(
            "exec",
            &json!({
                "cmd": "cmd.exe",
                "args": ["/c", "echo hi"],
                "cwd": outside.to_string_lossy(),
                "workspace_root": root.to_string_lossy(),
                "tier": "auto",
                "sandbox_tiers": tiers::builtin_tiers().to_value(),
            }),
            &CallEnv::default(),
        );
        if let Err((code, _)) = outcome {
            assert_ne!(code, "fs_denied");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    fn powershell_session() -> Value {
        json!({ "cmd": "powershell.exe", "args": ["-NoProfile", "-NoLogo", "-NoExit", "-Command", "-"], "syntax": "powershell" })
    }

    #[cfg(windows)]
    fn temp_workspace(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("chrono-sess-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(windows)]
    #[test]
    fn session_persists_cwd_across_commands() {
        let ws = temp_workspace("cwd");
        let base = json!({
            "session_id": "t-cwd",
            "session_shell": powershell_session(),
            "tier": "severe",
            "workspace_root": ws.to_string_lossy(),
            "sandbox_tiers": tiers::builtin_tiers().to_value(),
        });
        let mut first = base.clone();
        first["command"] = json!("Set-Location $env:TEMP");
        let out = handle_call("exec", &first, &CallEnv::default()).unwrap();
        assert_eq!(out["exit_code"], 0, "{out}");

        let mut second = base.clone();
        second["command"] = json!("Write-Output (Get-Location).Path");
        let out = handle_call("exec", &second, &CallEnv::default()).unwrap();
        assert!(out["stdout"].as_str().unwrap_or("").to_lowercase().contains("temp"), "{out}");

        let closed = handle_call("session_close", &json!({ "session_id": "t-cwd" }), &CallEnv::default()).unwrap();
        assert_eq!(closed["closed"], true);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[cfg(windows)]
    #[test]
    fn session_command_reports_exit_code_and_survives_failure() {
        let ws = temp_workspace("rc");
        let shell = powershell_session();
        let mut run = json!({
            "session_id": "t-rc",
            "session_shell": shell,
            "command": "cmd /c exit 7",
            "tier": "severe",
            "workspace_root": ws.to_string_lossy(),
            "sandbox_tiers": tiers::builtin_tiers().to_value(),
        });
        let out = handle_call("exec", &run, &CallEnv::default()).unwrap();
        assert_eq!(out["exit_code"], 7, "{out}");

        run["command"] = json!("Write-Output still-alive");
        let out = handle_call("exec", &run, &CallEnv::default()).unwrap();
        assert_eq!(out["exit_code"], 0, "{out}");
        assert!(out["stdout"].as_str().unwrap_or("").contains("still-alive"), "{out}");
        let _ = handle_call("session_close", &json!({ "session_id": "t-rc" }), &CallEnv::default());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[cfg(windows)]
    #[test]
    fn session_exit_command_reports_code_and_rebuilds() {
        let ws = temp_workspace("exit");
        let run = json!({
            "session_id": "t-exit",
            "session_shell": powershell_session(),
            "command": "exit 5",
            "tier": "severe",
            "workspace_root": ws.to_string_lossy(),
            "sandbox_tiers": tiers::builtin_tiers().to_value(),
        });
        let out = handle_call("exec", &run, &CallEnv::default()).unwrap();
        assert_eq!(out["exit_code"], 5, "{out}");

        // 会话已因 `exit` 终止，下一条命令透明重建会话。
        let mut again = run.clone();
        again["command"] = json!("Write-Output reborn");
        let out = handle_call("exec", &again, &CallEnv::default()).unwrap();
        assert!(out["stdout"].as_str().unwrap_or("").contains("reborn"), "{out}");
        let _ = handle_call("session_close", &json!({ "session_id": "t-exit" }), &CallEnv::default());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[cfg(windows)]
    #[test]
    fn background_task_start_poll_and_kill() {
        let ws = temp_workspace("bg");
        let base = json!({
            "cmd": "cmd.exe",
            "args": ["/c", "echo bg-line"],
            "tier": "severe",
            "workspace_root": ws.to_string_lossy(),
            "sandbox_tiers": tiers::builtin_tiers().to_value(),
        });
        let started = handle_call("exec_start", &base, &CallEnv::default()).unwrap();
        let task_id = started["task_id"].as_str().unwrap().to_string();
        let mut cursor = 0u64;
        let mut output = String::new();
        let mut exit_code = None;
        for _ in 0..100 {
            let polled = handle_call(
                "exec_poll",
                &json!({ "task_id": task_id, "cursor": cursor, "wait_ms": 500 }),
                &CallEnv::default(),
            )
            .unwrap();
            output.push_str(polled["output"].as_str().unwrap_or(""));
            cursor = polled["next_cursor"].as_u64().unwrap_or(cursor);
            if polled["running"] != true {
                exit_code = polled["exit_code"].as_i64();
                break;
            }
        }
        assert!(output.contains("bg-line"), "{output}");
        assert_eq!(exit_code, Some(0));

        // 长任务：能杀。
        let long = json!({
            "cmd": "cmd.exe",
            "args": ["/c", "ping -n 31 127.0.0.1 > nul"],
            "tier": "severe",
            "workspace_root": ws.to_string_lossy(),
            "sandbox_tiers": tiers::builtin_tiers().to_value(),
        });
        let started = handle_call("exec_start", &long, &CallEnv::default()).unwrap();
        let task_id = started["task_id"].as_str().unwrap().to_string();
        let killed = handle_call("exec_kill", &json!({ "task_id": task_id }), &CallEnv::default()).unwrap();
        assert_eq!(killed["killed"], true);
        let polled = handle_call("exec_poll", &json!({ "task_id": task_id }), &CallEnv::default()).unwrap();
        assert_eq!(polled["running"], false);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "sandbox-exec");
        assert_eq!(value["implements"], json!(["sandbox-exec"]));
        assert_eq!(
            value["methods"]["sandbox-exec"],
            json!(["exec", "exec_start", "exec_poll", "exec_kill", "session_close", "capabilities"])
        );
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &CallEnv::default()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn capabilities_self_reports() {
        let value = handle_call("capabilities", &json!({}), &CallEnv::default()).unwrap();
        assert!(value["platform"].is_string());
        assert_eq!(value["implementations"][0]["impl"], "native");
        // 文本匹配口径由 `sandbox-fs` 提供、门面合并，此处不重复。
        assert!(value.get("text").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn capabilities_reports_linux_isolation() {
        let value = capabilities();
        let names: Vec<String> = value["implementations"][0]["features"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let abi = crate::landlock::abi();
        if abi.is_some() {
            assert!(names.iter().any(|item| item == "landlock"), "{names:?}");
            assert_eq!(value["linux"]["landlock_abi"].as_i64(), abi.map(i64::from));
            assert_eq!(value["enforcement"]["exec_fs"], "landlock");
        }
        if crate::cgroup::available() {
            assert!(names.iter().any(|item| item == "cgroup_v2"), "{names:?}");
            assert_eq!(value["linux"]["cgroup_v2"], true);
        }
        if crate::seccomp::available() {
            assert!(names.iter().any(|item| item == "seccomp"), "{names:?}");
            assert_eq!(value["linux"]["seccomp"], true);
        }
        if crate::namespaces::available() {
            assert!(names.iter().any(|item| item == "namespaces"), "{names:?}");
            let kinds = value["linux"]["namespaces"].as_array().unwrap();
            assert!(kinds.iter().any(|item| item == "mount"));
            assert_eq!(value["enforcement"]["net"], "namespaces");
        } else if crate::seccomp::available() {
            assert_eq!(value["enforcement"]["net"], "seccomp");
        }
    }

    #[test]
    fn exec_deny_tier_rejected() {
        let err = handle_call(
            "exec",
            &json!({
                "cmd": "cmd.exe",
                "args": ["/c", "echo hi"],
                "tier": "deny",
                "sandbox_tiers": tiers::builtin_tiers().to_value(),
            }),
            &CallEnv::default(),
        )
        .unwrap_err();
        assert_eq!(err.0, "fs_denied");
    }

    #[test]
    fn exec_net_over_tier_denied() {
        let err = handle_call(
            "exec",
            &json!({
                "cmd": "cmd.exe",
                "args": ["/c", "echo hi"],
                "tier": "review",
                "caps": { "net": "all" },
                "sandbox_tiers": tiers::builtin_tiers().to_value(),
            }),
            &CallEnv::default(),
        )
        .unwrap_err();
        assert_eq!(err.0, "net_denied");
    }

    #[test]
    fn exec_net_grant_requires_exec_op() {
        let config = tiers::builtin_tiers();
        let policy = config.policy(Some("review"));
        let caps = tiers::parse_caps(Some(&json!({ "net": "all" })), &policy, &config.defaults);
        // op 不符的 grant 不放宽 exec 的 net。
        let read_grant = json!({ "grant": { "call_id": "gn-read", "op": "read", "net": "all" } });
        assert!(!grant_relaxes_net(&read_grant, &CallEnv::default(), &caps, &policy));
        // op=exec 且 net 覆盖时放宽（消费一次）。
        let exec_grant = json!({ "grant": { "call_id": "gn-exec", "op": "exec", "net": "all" } });
        assert!(grant_relaxes_net(&exec_grant, &CallEnv::default(), &caps, &policy));
        assert!(!grant_relaxes_net(&exec_grant, &CallEnv::default(), &caps, &policy));
    }

    #[cfg(target_os = "linux")]
    fn bash_session() -> Value {
        json!({ "cmd": "bash", "args": ["-s"], "syntax": "posix" })
    }

    #[cfg(target_os = "linux")]
    fn temp_workspace(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("chrono-sess-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_session_persists_cwd_and_reports_exit() {
        let ws = temp_workspace("linux-cwd");
        let sub = ws.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let base = json!({
            "session_id": "t-linux-cwd",
            "session_shell": bash_session(),
            "tier": "severe",
            "workspace_root": ws.to_string_lossy(),
            "sandbox_tiers": tiers::builtin_tiers().to_value(),
        });
        let mut first = base.clone();
        first["command"] = json!(format!("cd {}", sub.display()));
        let out = handle_call("exec", &first, &CallEnv::default()).unwrap();
        assert_eq!(out["exit_code"], 0, "{out}");

        let mut second = base.clone();
        second["command"] = json!("pwd; echo MARK");
        let out = handle_call("exec", &second, &CallEnv::default()).unwrap();
        let text = out["stdout"].as_str().unwrap_or("");
        assert!(text.contains(&sub.to_string_lossy().to_string()), "{out}");
        assert!(text.contains("MARK"), "{out}");

        // `exit N` 终止 shell：回该退出码，下一条命令透明重建。
        let mut third = base.clone();
        third["command"] = json!("exit 5");
        let out = handle_call("exec", &third, &CallEnv::default()).unwrap();
        assert_eq!(out["exit_code"], 5, "{out}");
        let mut fourth = base.clone();
        fourth["command"] = json!("echo reborn");
        let out = handle_call("exec", &fourth, &CallEnv::default()).unwrap();
        assert!(out["stdout"].as_str().unwrap_or("").contains("reborn"), "{out}");

        let _ = handle_call("session_close", &json!({ "session_id": "t-linux-cwd" }), &CallEnv::default());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_background_task_start_poll_and_kill() {
        let ws = temp_workspace("linux-bg");
        let base = json!({
            "cmd": "sh",
            "args": ["-c", "echo bg-line"],
            "tier": "severe",
            "workspace_root": ws.to_string_lossy(),
            "sandbox_tiers": tiers::builtin_tiers().to_value(),
        });
        let started = handle_call("exec_start", &base, &CallEnv::default()).unwrap();
        let task_id = started["task_id"].as_str().unwrap().to_string();
        let mut cursor = 0u64;
        let mut output = String::new();
        let mut exit_code = None;
        for _ in 0..100 {
            let polled = handle_call(
                "exec_poll",
                &json!({ "task_id": task_id, "cursor": cursor, "wait_ms": 500 }),
                &CallEnv::default(),
            )
            .unwrap();
            output.push_str(polled["output"].as_str().unwrap_or(""));
            cursor = polled["next_cursor"].as_u64().unwrap_or(cursor);
            if polled["running"] != true {
                exit_code = polled["exit_code"].as_i64();
                break;
            }
        }
        assert!(output.contains("bg-line"), "{output}");
        assert_eq!(exit_code, Some(0));

        // 长任务：能杀整组。
        let long = json!({
            "cmd": "sh",
            "args": ["-c", "sleep 30"],
            "tier": "severe",
            "workspace_root": ws.to_string_lossy(),
            "sandbox_tiers": tiers::builtin_tiers().to_value(),
        });
        let started = handle_call("exec_start", &long, &CallEnv::default()).unwrap();
        let task_id = started["task_id"].as_str().unwrap().to_string();
        let killed = handle_call("exec_kill", &json!({ "task_id": task_id }), &CallEnv::default()).unwrap();
        assert_eq!(killed["killed"], true);
        let polled = handle_call("exec_poll", &json!({ "task_id": task_id }), &CallEnv::default()).unwrap();
        assert_eq!(polled["running"], false);
        let _ = std::fs::remove_dir_all(&ws);
    }
}
