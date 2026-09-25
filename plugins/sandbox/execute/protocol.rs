// `sandbox` 服务进程协议面（docs/protocol.md §二）：握手 / manifest / call / 控制 / EOF 自退出。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。
// `call` 在独立线程执行（exec 可能长跑），控制帧（probe / reload / drain）不被阻塞。

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::exec;
use crate::frames;
use crate::fsop;
use crate::grant;
use crate::tiers::{self, FsScope, NetScope};

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "sandbox";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 3] = ["exec", "fsop", "capabilities"];

/// 调用帧的 `env`（宿主填写，机械）。本服务不落世界、不发事件，只用 `now` 判 grant TTL。
#[derive(Clone, Debug, Default)]
pub struct CallEnv {
    pub now: f64,
}

fn parse_env(raw: Option<&Value>) -> CallEnv {
    let Some(object) = raw.and_then(Value::as_object) else {
        return CallEnv::default();
    };
    CallEnv {
        now: object.get("now").and_then(Value::as_f64).unwrap_or(0.0),
    }
}

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    json!({
        "v": PROTOCOL,
        "identity": IDENTITY,
        "implements": [IDENTITY],
        "methods": { IDENTITY: METHODS },
        "protocol": PROTOCOL,
        "state": STATE,
    })
}

fn error_frame(id: &Value, code: &str, message: &str) -> Value {
    json!({ "v": PROTOCOL, "id": id, "kind": "error", "ok": false, "code": code, "message": message })
}

/// 处理控制帧；返回待写响应（`call` / `drain` / 未知种类由调用方处理）。
pub fn handle_control(message: &Value) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    match message.get("kind").and_then(Value::as_str) {
        Some("hello") => {
            let mut response = manifest();
            response["id"] = id;
            response["kind"] = json!("manifest");
            Some(response)
        }
        Some("probe") => Some(json!({ "v": PROTOCOL, "id": id, "kind": "pong", "ok": true })),
        Some("reload") => {
            frames::log("reload");
            Some(json!({ "v": PROTOCOL, "id": id, "kind": "ack" }))
        }
        _ => None,
    }
}

/// 处理 `call`：能力类 / 方法 / args 形态门禁 + 方法分派。
pub fn handle_call(method: &str, args: &Value, env: &CallEnv) -> Result<Value, (String, String)> {
    match method {
        "capabilities" => Ok(capabilities()),
        "fsop" => Ok(fsop::fsop(args, env.now)),
        "exec" => handle_exec(args, env),
        other => Err(("unknown_method".to_string(), format!("unknown method {other}"))),
    }
}

fn handle_exec(args: &Value, env: &CallEnv) -> Result<Value, (String, String)> {
    let config = tiers::parse_tiers(args.get("sandbox_tiers"));
    let tier = args.get("tier").and_then(Value::as_str);
    let policy = config.policy(tier);
    let caps = tiers::parse_caps(args.get("caps"), &policy, &config.defaults);

    // net 声明越档 → net_denied（声明级强制；实现尽力）。
    if !tiers::net_within_tier(&caps, &policy) && !grant_relaxes_net(args, env, &caps, &policy) {
        return Err((
            "net_denied".to_string(),
            format!(
                "declared net {} exceeds tier net {}",
                caps.net.as_str(),
                policy.net.as_str()
            ),
        ));
    }
    // deny 档全拒（本插件永不发升级、只拒绝；grant 也不放宽 deny）。
    if policy.fs_read == FsScope::None && policy.fs_write == FsScope::None {
        return Err(("fs_denied".to_string(), "deny tier rejects exec".to_string()));
    }

    let mut request = exec::parse_request(args, caps.output_max)
        .map_err(|err| (err.code().to_string(), err.message().to_string()))?;
    request.timeout_ms = caps.timeout_ms;
    request.mem_mb = caps.mem_mb;
    request.cpu_ms = caps.cpu_ms;
    request.procs_max = caps.procs_max;

    let outcome = if config.impl_name == "docker" {
        if !docker_available() {
            return Err((
                "sandbox_unsupported".to_string(),
                "docker runtime unavailable".to_string(),
            ));
        }
        let network = match policy.net {
            NetScope::All => "bridge",
            _ => "none",
        };
        exec::run_docker(&request, &config.docker_image, network)
    } else {
        exec::run(&request)
    }
    .map_err(|err| (err.code().to_string(), err.message().to_string()))?;

    Ok(json!({
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "truncated": outcome.truncated,
        "duration_ms": outcome.duration_ms,
        "code": outcome.code,
    }))
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

/// `capabilities`：本机可用实现与平台能力（自述面）。
pub fn capabilities() -> Value {
    let platform = std::env::consts::OS;
    let native = cfg!(windows);
    let docker = docker_available();
    let features: Vec<&str> = if native {
        vec![
            "job_object",
            "timeout",
            "mem_limit",
            "cpu_limit",
            "procs_limit",
            "output_truncate",
        ]
    } else {
        Vec::new()
    };
    let docker_features: Vec<&str> = if docker {
        vec![
            "read_only_root",
            "non_root_user",
            "network_isolation",
            "mem_limit",
            "pids_limit",
        ]
    } else {
        Vec::new()
    };
    json!({
        "platform": platform,
        "implementations": [
            { "impl": "native", "available": native, "features": features },
            {
                "impl": "docker",
                "available": docker,
                "features": docker_features,
                "reason": if docker { Value::Null } else { json!("docker runtime unavailable") }
            }
        ],
        "default_impl": "native",
        // 如实自述：`exec` 的 fs 范围不做强制（native 进程内只强制 `fsop`）；
        // net 为声明级强制；docker 的 OS 级隔离（只读根 / 非 root / 网络）见其 features。
        "enforcement": {
            "fsop": "in_process",
            "exec_fs": "none",
            "net": "declaration"
        }
    })
}

fn call_response(message: &Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let port = message.get("port").and_then(Value::as_str).unwrap_or("");
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let args = message.get("args").cloned().unwrap_or(Value::Null);
    let env = parse_env(message.get("env"));
    if port != IDENTITY {
        return error_frame(&id, "unresolved_cap", &format!("unknown capability {port}"));
    }
    match handle_call(method, &args, &env) {
        Ok(value) => json!({ "v": PROTOCOL, "id": id, "kind": "result", "ok": true, "value": value }),
        Err((code, message)) => error_frame(&id, &code, &message),
    }
}

fn wait_for_inflight(inflight: &Arc<(Mutex<usize>, Condvar)>, deadline_ms: u64) {
    let (lock, cvar) = &**inflight;
    let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    while *count > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next, timeout) = match cvar.wait_timeout(count, remaining) {
            Ok(pair) => pair,
            Err(poisoned) => poisoned.into_inner(),
        };
        count = next;
        if timeout.timed_out() {
            break;
        }
    }
}

/// 在途调用上限：超过即回结构化错误，避免无界 `thread::spawn` 耗尽资源。
const MAX_INFLIGHT: usize = 128;

/// 在途调用计数守卫：构造时自增，`Drop` 时持锁自减并唤醒 `drain`。
/// 必须在 `spawn` 前构造并 move 进线程——否则子线程可能在自增前完成，计数不归零。
struct InflightGuard {
    inflight: Arc<(Mutex<usize>, Condvar)>,
}

impl InflightGuard {
    /// 未达上限时自增并返回守卫；已达上限返回 `None`（调用方回 `overloaded`，不 spawn）。
    fn try_acquire(inflight: Arc<(Mutex<usize>, Condvar)>) -> Option<Self> {
        {
            let (lock, _) = &*inflight;
            let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if *count >= MAX_INFLIGHT {
                return None;
            }
            *count += 1;
        }
        Some(Self { inflight })
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        let (lock, cvar) = &*self.inflight;
        let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *count = count.saturating_sub(1);
        cvar.notify_all();
    }
}

/// 帧循环：`call` 独立线程执行；`drain` 等在途结束再 `bye`；EOF（stdin 断开）即自退出。
pub fn run_loop<R: Read, W: Write + Send + 'static>(mut reader: R, writer: W) {
    let out = Arc::new(Mutex::new(writer));
    let inflight: Arc<(Mutex<usize>, Condvar)> = Arc::new((Mutex::new(0), Condvar::new()));
    loop {
        let message = match frames::read_frame(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(err) => {
                frames::log(&format!("bad frame: {err}"));
                break;
            }
        };
        match message.get("kind").and_then(Value::as_str).unwrap_or("") {
            "call" => {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                let Some(guard) = InflightGuard::try_acquire(Arc::clone(&inflight)) else {
                    frames::log("call rejected: inflight limit reached");
                    if let Ok(mut writer) = out.lock() {
                        let _ = frames::write_frame(
                            &mut *writer,
                            &error_frame(&id, "overloaded", "inflight limit reached"),
                        );
                    }
                    continue;
                };
                let out = Arc::clone(&out);
                let fallback = Arc::clone(&out);
                if let Err(err) = thread::Builder::new().spawn(move || {
                    let response = call_response(&message);
                    if let Ok(mut writer) = out.lock() {
                        let _ = frames::write_frame(&mut *writer, &response);
                    }
                    // guard 随闭包结束（或 spawn 失败）而 Drop：计数必归零。
                    drop(guard);
                }) {
                    frames::log(&format!("spawn call failed: {err}"));
                    if let Ok(mut writer) = fallback.lock() {
                        let _ = frames::write_frame(
                            &mut *writer,
                            &error_frame(&id, "spawn_failed", &err.to_string()),
                        );
                    }
                }
            }
            "drain" => {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                let deadline = message.get("deadline_ms").and_then(Value::as_u64).unwrap_or(5000);
                wait_for_inflight(&inflight, deadline);
                if let Ok(mut guard) = out.lock() {
                    let _ = frames::write_frame(
                        &mut *guard,
                        &json!({ "v": PROTOCOL, "id": id, "kind": "bye" }),
                    );
                }
                return;
            }
            _ => {
                if let Some(response) = handle_control(&message) {
                    if let Ok(mut guard) = out.lock() {
                        let _ = frames::write_frame(&mut *guard, &response);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::encode_frame;

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "sandbox");
        assert_eq!(value["implements"], json!(["sandbox"]));
        assert_eq!(value["methods"]["sandbox"], json!(["exec", "fsop", "capabilities"]));
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn hello_returns_manifest() {
        let response = handle_control(&json!({"kind":"hello","id":"h1","impl":"sandbox"})).unwrap();
        assert_eq!(response["kind"], "manifest");
        assert_eq!(response["id"], "h1");
        assert_eq!(response["identity"], "sandbox");
    }

    #[test]
    fn probe_returns_pong() {
        let response = handle_control(&json!({"kind":"probe","id":"p1"})).unwrap();
        assert_eq!(response["kind"], "pong");
        assert_eq!(response["ok"], true);
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

    #[test]
    fn unknown_capability_is_unresolved() {
        let response = call_response(&json!({"kind":"call","id":"c1","port":"other","method":"capabilities","args":{}}));
        assert_eq!(response["kind"], "error");
        assert_eq!(response["code"], "unresolved_cap");
    }

    #[test]
    fn loop_handshake_then_eof_exits() {
        let mut bytes = encode_frame(&json!({"v":"1","id":"h","kind":"hello","impl":"sandbox"})).unwrap();
        bytes.extend_from_slice(&encode_frame(&json!({"v":"1","id":"p","kind":"probe"})).unwrap());
        let out: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let sink = Arc::clone(&out);
            run_loop(std::io::Cursor::new(bytes), SharedWriter(sink));
        }
        let written = out.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(written);
        let manifest = frames::read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(manifest["kind"], "manifest");
        let pong = frames::read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(pong["kind"], "pong");
        assert!(frames::read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn inflight_guard_bounds_concurrent_calls() {
        let inflight: Arc<(Mutex<usize>, Condvar)> = Arc::new((Mutex::new(0), Condvar::new()));
        let mut guards = Vec::new();
        for _ in 0..MAX_INFLIGHT {
            guards.push(InflightGuard::try_acquire(Arc::clone(&inflight)).expect("under limit"));
        }
        assert!(InflightGuard::try_acquire(Arc::clone(&inflight)).is_none());
        drop(guards.pop());
        assert!(InflightGuard::try_acquire(Arc::clone(&inflight)).is_some());
    }

    /// 测试用共享写端：把 run_loop 的输出收进内存。
    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
