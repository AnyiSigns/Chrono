// `sandbox` 服务进程协议面：方法分派与领域逻辑；帧编解码 / 控制帧 / 线程派发走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。

use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, ServiceError, ServiceHandler, ServiceSpec};

use crate::exec;
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
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "sandbox");
        assert_eq!(value["implements"], json!(["sandbox"]));
        assert_eq!(value["methods"]["sandbox"], json!(["exec", "fsop", "capabilities"]));
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
}
