// 四档 fs/net 映射与 caps 钳制。
// 映射表住**本身份数据世代 body**（`bag.sandbox_tiers`，由调用方入口 term 读出随 bag 传入）；
// 缺省用内建机械兜底（与 `tools/default-body.json` 同形）。本插件**永不发升级、只拒绝**：
// 取「工具声明 caps ∩ 当前档范围」后强制，越界返回 `fs_denied` / `net_denied`。

use std::collections::HashMap;

use serde_json::Value;

/// fs 范围：`full`（不限）> `workspace`（仅工作区）> `none`（全拒）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FsScope {
    None,
    Workspace,
    Full,
}

impl FsScope {
    pub fn rank(self) -> u8 {
        match self {
            FsScope::None => 0,
            FsScope::Workspace => 1,
            FsScope::Full => 2,
        }
    }

    pub fn min(self, other: FsScope) -> FsScope {
        if self.rank() <= other.rank() {
            self
        } else {
            other
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            FsScope::None => "none",
            FsScope::Workspace => "workspace",
            FsScope::Full => "full",
        }
    }

    /// 解析；未知 / 缺失回落 `fallback`（调用方按 fail-closed 选择 fallback）。
    pub fn parse(value: Option<&Value>, fallback: FsScope) -> FsScope {
        match value.and_then(Value::as_str) {
            Some("none") => FsScope::None,
            Some("workspace") => FsScope::Workspace,
            Some("full") => FsScope::Full,
            _ => fallback,
        }
    }
}

/// net 范围：`all` > `limited`（声明 hosts 白名单）> `none`。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NetScope {
    None,
    Limited,
    All,
}

impl NetScope {
    pub fn rank(self) -> u8 {
        match self {
            NetScope::None => 0,
            NetScope::Limited => 1,
            NetScope::All => 2,
        }
    }

    pub fn parse(value: Option<&Value>) -> Option<NetScope> {
        match value.and_then(Value::as_str) {
            Some("none") => Some(NetScope::None),
            Some("limited") => Some(NetScope::Limited),
            Some("all") => Some(NetScope::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            NetScope::None => "none",
            NetScope::Limited => "limited",
            NetScope::All => "all",
        }
    }
}

/// 单档允许范围（fs 读 / fs 写 / net）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TierPolicy {
    pub fs_read: FsScope,
    pub fs_write: FsScope,
    pub net: NetScope,
}

/// caps 未声明时的资源缺省（住档位映射 body 的 `defaults`）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CapsDefaults {
    pub timeout_ms: u64,
    pub mem_mb: u64,
    pub cpu_ms: u64,
    pub output_max: usize,
    pub procs_max: u32,
}

/// 档位映射数据世代 body 的解析结果。
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TierConfig {
    pub version: u64,
    pub impl_name: String,
    pub tiers: HashMap<String, TierPolicy>,
    pub defaults: CapsDefaults,
    pub net_hosts: Vec<String>,
    pub docker_image: String,
}

/// 未知 / 缺失档位按 fail-closed：全拒（不放行任何 fs / net）。
pub const FAIL_CLOSED_POLICY: TierPolicy = TierPolicy {
    fs_read: FsScope::None,
    fs_write: FsScope::None,
    net: NetScope::None,
};

/// 内建兜底（结构化形态见 `tools/default-body.json`；测试保证两者一致）。
pub fn builtin_tiers() -> TierConfig {
    let mut tiers = HashMap::new();
    tiers.insert(
        "auto".to_string(),
        TierPolicy { fs_read: FsScope::Full, fs_write: FsScope::Full, net: NetScope::All },
    );
    tiers.insert(
        "severe".to_string(),
        TierPolicy {
            fs_read: FsScope::Workspace,
            fs_write: FsScope::Workspace,
            net: NetScope::Limited,
        },
    );
    tiers.insert(
        "review".to_string(),
        TierPolicy {
            fs_read: FsScope::Workspace,
            fs_write: FsScope::None,
            net: NetScope::None,
        },
    );
    tiers.insert(
        "deny".to_string(),
        TierPolicy { fs_read: FsScope::None, fs_write: FsScope::None, net: NetScope::None },
    );
    TierConfig {
        version: 1,
        impl_name: "native".to_string(),
        tiers,
        defaults: CapsDefaults {
            timeout_ms: 30_000,
            mem_mb: 1024,
            cpu_ms: 0,
            output_max: 1024 * 1024,
            procs_max: 32,
        },
        net_hosts: Vec::new(),
        docker_image: "alpine:3".to_string(),
    }
}

fn parse_tier_policy(value: &Value, fallback: TierPolicy) -> TierPolicy {
    let Some(object) = value.as_object() else {
        return fallback;
    };
    let fs = object.get("fs");
    TierPolicy {
        fs_read: FsScope::parse(fs.and_then(|item| item.get("read")), fallback.fs_read),
        fs_write: FsScope::parse(fs.and_then(|item| item.get("write")), fallback.fs_write),
        net: NetScope::parse(object.get("net")).unwrap_or(fallback.net),
    }
}

fn parse_u64(value: Option<&Value>, fallback: u64) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(fallback)
}

/// 解析 `bag.sandbox_tiers`：非对象（缺省）用内建；逐段合并，段缺省回落内建。
pub fn parse_tiers(raw: Option<&Value>) -> TierConfig {
    let mut config = builtin_tiers();
    let Some(object) = raw.and_then(Value::as_object) else {
        return config;
    };
    config.version = parse_u64(object.get("version"), config.version);
    if let Some(name) = object.get("impl").and_then(Value::as_str) {
        config.impl_name = name.to_string();
    }
    if let Some(tiers) = object.get("tiers").and_then(Value::as_object) {
        for (name, value) in tiers {
            let fallback = config.tiers.get(name).copied().unwrap_or(FAIL_CLOSED_POLICY);
            config.tiers.insert(name.clone(), parse_tier_policy(value, fallback));
        }
    }
    if let Some(defaults) = object.get("defaults").and_then(Value::as_object) {
        let base = config.defaults;
        config.defaults = CapsDefaults {
            timeout_ms: parse_u64(defaults.get("timeout_ms"), base.timeout_ms),
            mem_mb: parse_u64(defaults.get("mem_mb"), base.mem_mb),
            cpu_ms: parse_u64(defaults.get("cpu_ms"), base.cpu_ms),
            output_max: parse_u64(defaults.get("output_max"), base.output_max as u64) as usize,
            procs_max: parse_u64(defaults.get("procs_max"), base.procs_max as u64) as u32,
        };
    }
    if let Some(hosts) = object.get("net_hosts").and_then(Value::as_array) {
        config.net_hosts = hosts
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(image) = object.get("docker_image").and_then(Value::as_str) {
        config.docker_image = image.to_string();
    }
    config
}

impl TierConfig {
    /// 取档位策略；未知 / 缺失 → fail-closed 全拒。
    pub fn policy(&self, tier: Option<&str>) -> TierPolicy {
        tier.and_then(|name| self.tiers.get(name).copied())
            .unwrap_or(FAIL_CLOSED_POLICY)
    }

    /// 序列化为 body 形状（与 `tools/default-body.json` 同形；测试用）。
    #[cfg(test)]
    pub fn to_value(&self) -> Value {
        let mut tiers = serde_json::Map::new();
        for (name, policy) in &self.tiers {
            tiers.insert(
                name.clone(),
                serde_json::json!({
                    "fs": { "read": policy.fs_read.as_str(), "write": policy.fs_write.as_str() },
                    "net": policy.net.as_str(),
                }),
            );
        }
        serde_json::json!({
            "version": self.version,
            "impl": self.impl_name,
            "tiers": Value::Object(tiers),
            "defaults": {
                "timeout_ms": self.defaults.timeout_ms,
                "mem_mb": self.defaults.mem_mb,
                "cpu_ms": self.defaults.cpu_ms,
                "output_max": self.defaults.output_max,
                "procs_max": self.defaults.procs_max,
            },
            "net_hosts": self.net_hosts,
            "docker_image": self.docker_image,
        })
    }
}

/// 工具声明的 caps（含资源上限）；`fs` 缺省回落当前档范围。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Caps {
    pub fs_read: FsScope,
    pub fs_write: FsScope,
    pub net: NetScope,
    pub net_declared: bool,
    pub timeout_ms: u64,
    pub mem_mb: u64,
    pub cpu_ms: u64,
    pub output_max: usize,
    pub procs_max: u32,
}

/// 解析 `bag.caps`：缺省 / 畸形字段回落档位范围与资源缺省。
pub fn parse_caps(raw: Option<&Value>, policy: &TierPolicy, defaults: &CapsDefaults) -> Caps {
    let object = raw.and_then(Value::as_object);
    let fs = object.and_then(|item| item.get("fs"));
    let net = object.and_then(|item| item.get("net"));
    Caps {
        fs_read: FsScope::parse(fs.and_then(|item| item.get("read")), policy.fs_read),
        fs_write: FsScope::parse(fs.and_then(|item| item.get("write")), policy.fs_write),
        net: NetScope::parse(net).unwrap_or(NetScope::None),
        net_declared: NetScope::parse(net).is_some(),
        timeout_ms: parse_u64(object.and_then(|item| item.get("timeout_ms")), defaults.timeout_ms),
        mem_mb: parse_u64(object.and_then(|item| item.get("mem_mb")), defaults.mem_mb),
        cpu_ms: parse_u64(object.and_then(|item| item.get("cpu_ms")), defaults.cpu_ms),
        output_max: parse_u64(
            object.and_then(|item| item.get("output_max")),
            defaults.output_max as u64,
        ) as usize,
        procs_max: parse_u64(object.and_then(|item| item.get("procs_max")), defaults.procs_max as u64)
            as u32,
    }
}

/// 声明 ∩ 档位范围后的实际放行范围。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Effective {
    pub fs_read: FsScope,
    pub fs_write: FsScope,
}

pub fn effective_scope(caps: &Caps, policy: &TierPolicy) -> Effective {
    Effective {
        fs_read: caps.fs_read.min(policy.fs_read),
        fs_write: caps.fs_write.min(policy.fs_write),
    }
}

/// 声明 net 是否在档位范围内；越档即 `net_denied`（声明级强制，实现尽力）。
pub fn net_within_tier(caps: &Caps, policy: &TierPolicy) -> bool {
    if !caps.net_declared {
        return true;
    }
    caps.net.rank() <= policy.net.rank()
}

impl Effective {
    pub fn allows_read(&self, inside_workspace: bool) -> bool {
        let required = if inside_workspace { FsScope::Workspace } else { FsScope::Full };
        self.fs_read.rank() >= required.rank()
    }

    pub fn allows_write(&self, inside_workspace: bool) -> bool {
        let required = if inside_workspace { FsScope::Workspace } else { FsScope::Full };
        self.fs_write.rank() >= required.rank()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builtin_matches_default_body_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tools/default-body.json");
        let text = std::fs::read_to_string(path).expect("tools/default-body.json");
        let parsed: Value = serde_json::from_str(&text).unwrap();
        let from_file = parse_tiers(Some(&parsed));
        assert_eq!(from_file, builtin_tiers());
    }

    #[test]
    fn tiers_are_monotonic() {
        let config = builtin_tiers();
        let auto = config.policy(Some("auto"));
        let severe = config.policy(Some("severe"));
        let review = config.policy(Some("review"));
        let deny = config.policy(Some("deny"));
        assert!(auto.fs_read.rank() > severe.fs_read.rank());
        assert!(severe.fs_read.rank() > deny.fs_read.rank());
        assert_eq!(review.fs_read, FsScope::Workspace);
        assert_eq!(review.fs_write, FsScope::None);
        assert_eq!(deny.fs_read, FsScope::None);
    }

    #[test]
    fn unknown_tier_fails_closed() {
        let config = builtin_tiers();
        let policy = config.policy(Some("nope"));
        assert_eq!(policy, FAIL_CLOSED_POLICY);
        assert_eq!(config.policy(None), FAIL_CLOSED_POLICY);
    }

    #[test]
    fn data_driven_override_changes_judgement() {
        // 改 body 即改判定：把 severe 的 fs 写放开到 full。
        let raw = json!({
            "version": 1,
            "tiers": { "severe": { "fs": { "read": "workspace", "write": "full" }, "net": "none" } }
        });
        let config = parse_tiers(Some(&raw));
        let policy = config.policy(Some("severe"));
        assert_eq!(policy.fs_write, FsScope::Full);
        // 未覆盖的档位仍回落内建
        assert_eq!(config.policy(Some("review")).fs_write, FsScope::None);
    }

    #[test]
    fn caps_intersection() {
        let config = builtin_tiers();
        let policy = config.policy(Some("severe"));
        let caps = parse_caps(
            Some(&json!({ "fs": { "read": "full", "write": "full" }, "net": "all" })),
            &policy,
            &config.defaults,
        );
        let eff = effective_scope(&caps, &policy);
        assert_eq!(eff.fs_read, FsScope::Workspace);
        assert_eq!(eff.fs_write, FsScope::Workspace);
        assert!(!net_within_tier(&caps, &policy));
    }

    #[test]
    fn missing_caps_fall_back_to_tier() {
        let config = builtin_tiers();
        let policy = config.policy(Some("review"));
        let caps = parse_caps(None, &policy, &config.defaults);
        let eff = effective_scope(&caps, &policy);
        assert_eq!(eff.fs_read, FsScope::Workspace);
        assert_eq!(eff.fs_write, FsScope::None);
        assert!(net_within_tier(&caps, &policy));
    }

    #[test]
    fn net_clamped_per_tier() {
        let config = builtin_tiers();
        let cases = [
            ("auto", "all", true),
            ("auto", "limited", true),
            ("severe", "all", false),
            ("severe", "limited", true),
            ("severe", "none", true),
            ("review", "limited", false),
            ("review", "none", true),
            ("deny", "all", false),
            ("deny", "none", true),
        ];
        for (tier, declared, expected) in cases {
            let policy = config.policy(Some(tier));
            let caps = parse_caps(Some(&json!({ "net": declared })), &policy, &config.defaults);
            assert_eq!(
                net_within_tier(&caps, &policy),
                expected,
                "tier={tier} declared={declared}"
            );
        }
    }

    #[test]
    fn net_declared_none_is_allowed_everywhere() {
        let config = builtin_tiers();
        for tier in ["auto", "severe", "review", "deny"] {
            let policy = config.policy(Some(tier));
            let caps = parse_caps(Some(&json!({ "net": "none" })), &policy, &config.defaults);
            assert!(net_within_tier(&caps, &policy), "tier {tier}");
        }
    }
}
