// `sandbox-policy` 服务进程协议面：档位（tiers）与授权（grant）判定的单一来源。
// 判定按数据形态求值：四档映射表住调用方随 bag 传入的 `sandbox_tiers` 数据世代 body，
// 本插件不读投影、无写通道。`resolve` 为纯判定（同输入同输出），`consume` 消费一次性 grant
// （消费记录驻本进程内存，不可重放为常设权限）。帧编解码 / 控制帧 / 线程派发走 plugin-sdk。

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, ServiceError, ServiceHandler, ServiceSpec};

use crate::grant;
use crate::tiers::{self, FsScope};

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "sandbox-policy";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算（grant 消费记录驻内存，重启即清，符合一次性语义）。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["resolve", "consume"];

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

/// 处理 `call`：方法分派。
pub fn handle_call(method: &str, args: &Value, env: &CallEnv) -> Result<Value, (String, String)> {
    match method {
        "resolve" => Ok(resolve(args)),
        "consume" => Ok(consume(args, env.now)),
        other => Err(("unknown_method".to_string(), format!("unknown method {other}"))),
    }
}

/// 解析档位映射表并给出「声明 caps ∩ 当前档」后的实际放行范围。
/// 未知 / 缺失档 fail-closed 全拒（`deny_tier`）；越档 net 由 `net_within_tier` 标注。
/// 一次性 grant 不在此消费：解析结果随 `grant` 字段下传，由执行方在决定放行时就地消费。
pub fn resolve(args: &Value) -> Value {
    let config = tiers::parse_tiers(args.get("sandbox_tiers"));
    let tier = args.get("tier").and_then(Value::as_str);
    let policy = config.policy(tier);
    let caps = tiers::parse_caps(args.get("caps"), &policy, &config.defaults);
    let effective = tiers::effective_scope(&caps, &policy);
    json!({
        "tier": tier,
        "deny_tier": policy.fs_read == FsScope::None && policy.fs_write == FsScope::None,
        "impl": config.impl_name,
        "docker_image": config.docker_image,
        "policy_net": policy.net.as_str(),
        "caps": {
            "net": caps.net.as_str(),
            "net_declared": caps.net_declared,
            "fs_read": caps.fs_read.as_str(),
            "fs_write": caps.fs_write.as_str(),
            "timeout_ms": caps.timeout_ms,
            "mem_mb": caps.mem_mb,
            "cpu_ms": caps.cpu_ms,
            "output_max": caps.output_max,
            "procs_max": caps.procs_max,
        },
        "net_within_tier": tiers::net_within_tier(&caps, &policy),
        "fs_read": effective.fs_read.as_str(),
        "fs_write": effective.fs_write.as_str(),
    })
}

/// 校验并消费一次性 grant：档位一致、未过期、未消费过；任一不符即 `ok:false`（调用方 fail-closed）。
pub fn consume(args: &Value, now: f64) -> Value {
    let Some(parsed) = grant::parse_grant(args.get("grant")) else {
        return json!({ "ok": false, "code": "bad_grant" });
    };
    let tier = args.get("tier").and_then(Value::as_str);
    let now = args.get("now").and_then(Value::as_f64).unwrap_or(now);
    let mut store = grant::global_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match grant::redeem(&parsed, tier, now, &mut store) {
        Ok(outcome) => json!({
            "ok": true,
            "fs_read": outcome.fs_read.map(FsScope::as_str),
            "fs_write": outcome.fs_write.map(FsScope::as_str),
            "net": outcome.net.map(|net| net.as_str()),
        }),
        Err(_) => json!({ "ok": false, "code": "grant_rejected" }),
    }
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
    use crate::tiers::builtin_tiers;

    fn bag(tier: &str, caps: Value) -> Value {
        json!({ "tier": tier, "caps": caps, "sandbox_tiers": builtin_tiers().to_value() })
    }

    #[test]
    fn resolve_clamps_caps_to_tier() {
        let value = resolve(&bag(
            "severe",
            json!({ "fs": { "read": "full", "write": "full" }, "net": "all" }),
        ));
        assert_eq!(value["fs_read"], "workspace");
        assert_eq!(value["fs_write"], "workspace");
        assert_eq!(value["net_within_tier"], false);
        assert_eq!(value["caps"]["net"], "all");
        assert_eq!(value["deny_tier"], false);
    }

    #[test]
    fn resolve_unknown_tier_fails_closed() {
        let value = resolve(&bag("nope", json!({})));
        assert_eq!(value["deny_tier"], true);
        assert_eq!(value["fs_read"], "none");
    }

    #[test]
    fn resolve_missing_tier_fails_closed() {
        let value = resolve(&json!({ "sandbox_tiers": builtin_tiers().to_value() }));
        assert_eq!(value["deny_tier"], true);
    }

    #[test]
    fn consume_is_one_time() {
        let grant = json!({ "call_id": "p-1", "tier": "severe" });
        let first = consume(&json!({ "grant": grant, "tier": "severe" }), 0.0);
        assert_eq!(first["ok"], true);
        let second = consume(&json!({ "grant": grant, "tier": "severe" }), 0.0);
        assert_eq!(second["ok"], false);
    }

    #[test]
    fn consume_rejects_tier_mismatch() {
        let value = consume(
            &json!({ "grant": { "call_id": "p-2" }, "tier": "review" }),
            0.0,
        );
        let _ = value;
        let missing = consume(&json!({ "grant": { "tier": "severe" } }), 0.0);
        assert_eq!(missing["ok"], false);
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "sandbox-policy");
        assert_eq!(value["implements"], json!(["sandbox-policy"]));
        assert_eq!(value["methods"]["sandbox-policy"], json!(["resolve", "consume"]));
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &CallEnv::default()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }
}
