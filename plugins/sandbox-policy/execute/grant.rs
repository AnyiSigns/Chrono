// 一次性 `caps.grant` 消费面：批准后放行**本次**调用，绑定 `call_id`、校验范围 / 档位。
// grant 不进世界；本插件只消费、不签发（签发归编排 / 审批面）。消费记录驻进程内存，
// 同一 `call_id` 第二次出现即拒（不可重放为常设权限）。

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::tiers::{FsScope, NetScope};

/// 批准后的一次性放行凭据。绑定 `{call_id, op, path, tier, expires}`：
/// `op` 与目标路径必须与批准项一致，`paths` 空视为**不适用**（无 grant），
/// `fs` 缺省**不额外放宽**（grant 只能收紧到显式声明的范围）。
#[derive(Clone, Debug, PartialEq)]
pub struct Grant {
    pub call_id: String,
    pub op: Option<String>,
    pub tier: Option<String>,
    pub expires: Option<f64>,
    pub fs_read: Option<FsScope>,
    pub fs_write: Option<FsScope>,
    pub net: Option<NetScope>,
    /// 允许的路径范围（原样字符串，由 fsop 侧解析 / 比对）；空 = 不适用（不构成 grant）。
    pub paths: Vec<String>,
}

fn fs_scope(value: Option<&Value>) -> Option<FsScope> {
    match value.and_then(Value::as_str) {
        Some("none") => Some(FsScope::None),
        Some("workspace") => Some(FsScope::Workspace),
        Some("full") => Some(FsScope::Full),
        _ => None,
    }
}

/// 解析 `bag.grant` / `bag.caps.grant`；缺 `call_id` 或形态非法 → `None`（当作无 grant）。
pub fn parse_grant(raw: Option<&Value>) -> Option<Grant> {
    let object = raw.and_then(Value::as_object)?;
    let call_id = object.get("call_id").and_then(Value::as_str)?.trim();
    if call_id.is_empty() {
        return None;
    }
    let fs = object.get("fs");
    Some(Grant {
        call_id: call_id.to_string(),
        op: object.get("op").and_then(Value::as_str).map(str::to_string),
        tier: object.get("tier").and_then(Value::as_str).map(str::to_string),
        expires: object.get("expires").and_then(Value::as_f64),
        fs_read: fs_scope(fs.and_then(|item| item.get("read"))),
        fs_write: fs_scope(fs.and_then(|item| item.get("write"))),
        net: NetScope::parse(object.get("net")),
        paths: object
            .get("paths")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
    })
}

/// 已消费 `call_id` 的记录容量上限；超出按插入序淘汰最旧（凭据自身的 `expires` 仍兜底）。
const MAX_CONSUMED_GRANTS: usize = 4096;
/// 未声明 `expires` 的凭据，其消费记录保留的缺省时长（秒）。
const DEFAULT_CONSUMED_TTL_SECS: f64 = 3600.0;

/// 已消费的 `call_id`（进程内，一次性语义）：记录 `call_id → 过期时刻`，有容量上限与 TTL。
#[derive(Default)]
pub struct GrantStore {
    consumed: HashMap<String, f64>,
    order: VecDeque<String>,
}

impl GrantStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_consumed(&self, call_id: &str) -> bool {
        self.consumed.contains_key(call_id)
    }

    /// 标记消费；返回 `true` 表示本次是首次消费。
    /// `expires` = 凭据自身过期时刻（`None` 时按 `now + DEFAULT_CONSUMED_TTL_SECS` 记账）。
    pub fn consume(&mut self, call_id: &str, now: f64, expires: Option<f64>) -> bool {
        self.prune(now);
        if self.consumed.contains_key(call_id) {
            return false;
        }
        let expires_at = expires.unwrap_or(now + DEFAULT_CONSUMED_TTL_SECS).max(now);
        self.consumed.insert(call_id.to_string(), expires_at);
        self.order.push_back(call_id.to_string());
        while self.order.len() > MAX_CONSUMED_GRANTS {
            if let Some(oldest) = self.order.pop_front() {
                self.consumed.remove(&oldest);
            }
        }
        true
    }

    /// 清理已过期记录；`now` 来自帧 `env.now`，不取系统时钟。
    fn prune(&mut self, now: f64) {
        if self.consumed.values().all(|expires| *expires >= now) {
            return;
        }
        self.consumed.retain(|_, expires| *expires >= now);
        let consumed = &self.consumed;
        self.order.retain(|call_id| consumed.contains_key(call_id));
    }
}

/// 服务进程内的全局 grant 记录。
pub fn global_store() -> &'static Mutex<GrantStore> {
    static STORE: OnceLock<Mutex<GrantStore>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(GrantStore::new()))
}

/// 放宽后的实际范围：`None` = 该维度未声明、不额外放宽（grant 只收紧到显式声明）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GrantOutcome {
    pub fs_read: Option<FsScope>,
    pub fs_write: Option<FsScope>,
    pub net: Option<NetScope>,
}

/// 校验并消费 grant：档位一致、未过期、未消费过。
/// 任一不符返回 `Err`（调用方回落档位强制，即 fail-closed 拒绝）。
pub fn redeem(
    grant: &Grant,
    tier: Option<&str>,
    now: f64,
    store: &mut GrantStore,
) -> Result<GrantOutcome, ()> {
    if let Some(expected) = &grant.tier {
        if tier != Some(expected.as_str()) {
            return Err(());
        }
    }
    if let Some(expires) = grant.expires {
        if expires < now {
            return Err(());
        }
    }
    if !store.consume(&grant.call_id, now, grant.expires) {
        return Err(());
    }
    Ok(GrantOutcome {
        // 未显式声明的维度不额外放宽（不回落 full）；net 缺省不额外放宽。
        fs_read: grant.fs_read,
        fs_write: grant.fs_write,
        net: grant.net,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_minimal_grant() {
        let grant = parse_grant(Some(&json!({"call_id":"c1","tier":"severe","expires":1000}))).unwrap();
        assert_eq!(grant.call_id, "c1");
        assert_eq!(grant.tier.as_deref(), Some("severe"));
        assert_eq!(grant.expires, Some(1000.0));
        assert!(grant.paths.is_empty());
    }

    #[test]
    fn parse_rejects_missing_call_id() {
        assert!(parse_grant(Some(&json!({"tier":"severe"}))).is_none());
        assert!(parse_grant(Some(&json!({"call_id":"  "}))).is_none());
        assert!(parse_grant(None).is_none());
    }

    #[test]
    fn redeem_is_one_time() {
        let grant = parse_grant(Some(&json!({"call_id":"c2","tier":"severe"}))).unwrap();
        let mut store = GrantStore::new();
        assert!(redeem(&grant, Some("severe"), 0.0, &mut store).is_ok());
        assert!(redeem(&grant, Some("severe"), 0.0, &mut store).is_err());
    }

    #[test]
    fn redeem_checks_tier_and_expiry() {
        let mut store = GrantStore::new();
        let grant = parse_grant(Some(&json!({"call_id":"c3","tier":"severe"}))).unwrap();
        assert!(redeem(&grant, Some("review"), 0.0, &mut store).is_err());
        let expiring = parse_grant(Some(&json!({"call_id":"c4","expires":500}))).unwrap();
        assert!(redeem(&expiring, Some("severe"), 1000.0, &mut store).is_err());
        assert!(redeem(&expiring, Some("severe"), 499.0, &mut store).is_ok());
    }

    #[test]
    fn redeem_does_not_default_missing_fs_to_full() {
        // 未声明 fs 的 grant 不得放宽到 full（只允许显式声明收紧）。
        let grant = parse_grant(Some(&json!({"call_id":"c5"}))).unwrap();
        let mut store = GrantStore::new();
        let outcome = redeem(&grant, Some("severe"), 0.0, &mut store).unwrap();
        assert_eq!(outcome.fs_read, None);
        assert_eq!(outcome.fs_write, None);
        assert_eq!(outcome.net, None);
    }

    #[test]
    fn parse_grant_reads_op_binding() {
        let grant = parse_grant(Some(&json!({"call_id":"c7","op":"write","paths":["/ws/a"]}))).unwrap();
        assert_eq!(grant.op.as_deref(), Some("write"));
        assert_eq!(grant.paths, vec!["/ws/a".to_string()]);
    }

    #[test]
    fn redeem_respects_explicit_scope() {
        let grant = parse_grant(Some(&json!({
            "call_id":"c6",
            "fs": {"read":"workspace","write":"none"},
            "net":"limited"
        })))
        .unwrap();
        let mut store = GrantStore::new();
        let outcome = redeem(&grant, None, 0.0, &mut store).unwrap();
        assert_eq!(outcome.fs_read, Some(FsScope::Workspace));
        assert_eq!(outcome.fs_write, Some(FsScope::None));
        assert_eq!(outcome.net, Some(NetScope::Limited));
    }

    #[test]
    fn consumed_records_expire_and_are_capacity_bounded() {
        let mut store = GrantStore::new();
        assert!(store.consume("short", 0.0, Some(10.0)));
        assert!(store.is_consumed("short"));
        // 过期后同一 call_id 可再次消费（记录已随 TTL 清理）。
        assert!(store.consume("other", 100.0, Some(200.0)));
        assert!(!store.is_consumed("short"));
        // 容量上限：超出后最旧记录被淘汰，但不 panic。
        for index in 0..MAX_CONSUMED_GRANTS + 8 {
            assert!(store.consume(&format!("bulk-{index}"), 100.0, Some(1000.0)));
        }
        assert!(store.is_consumed(&format!("bulk-{}", MAX_CONSUMED_GRANTS + 7)));
        assert!(!store.is_consumed("bulk-0"));
    }
}
