// 证据构建：七类证据 + 拒绝聚类 + 跨工作区分区 + `orchestration.unhealthy` 触发判据。
// 只产 `kind:'evidence'` 条目（分签红线：不产提案）；纯计算、同输入同输出、不取时间不用随机。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::bag::TraceRef;
use crate::hash;
use crate::thresholds::Thresholds;

/// 构建入参：阈值表 + now + 可选拒绝码归因表 + ③ 基线缓存。
pub struct Options<'a> {
    pub thresholds: &'a Thresholds,
    pub now: &'a Value,
    pub refusal_codes: &'a BTreeMap<String, String>,
    pub state: Option<&'a dyn crate::state::StateStore>,
}

/// 全部证据（按 (class, cluster_key) 确定性排序）+ `orchestration.unhealthy` 触发状态。
pub struct Built {
    pub evidence: Vec<Value>,
    pub unhealthy: Option<Value>,
}

/// 七类证据 + 事件触发判据。
pub fn build(traces: &[TraceRef], options: &Options<'_>) -> Built {
    let mut evidence = Vec::new();
    failure_clusters(traces, options, &mut evidence);
    post_failure(traces, options, &mut evidence);
    cost_anomaly(traces, options, &mut evidence);
    instance_drift(traces, options, &mut evidence);
    fold_candidate(traces, options, &mut evidence);
    no_progress(traces, options, &mut evidence);
    verify_failure(traces, options, &mut evidence);
    evidence.sort_by_key(|entry| {
        (
            entry.get("class").and_then(Value::as_str).unwrap_or("").to_string(),
            hash::canonical(entry.get("cluster_key").unwrap_or(&Value::Null)),
            entry.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        )
    });
    Built {
        evidence,
        unhealthy: unhealthy_event(traces, options),
    }
}

// ---------------------------------------------------------------- 通用

fn make_entry(
    class: &str,
    cluster_key: Value,
    n: usize,
    window: Value,
    traces: Vec<Value>,
    extra: Map<String, Value>,
    options: &Options<'_>,
) -> Value {
    let id = format!(
        "ev-{}",
        hash::content_hash(&json!([class, cluster_key, Value::Object(extra.clone())]))
    );
    let mut object = Map::new();
    object.insert("kind".to_string(), json!("evidence"));
    object.insert("id".to_string(), json!(id));
    object.insert("class".to_string(), json!(class));
    object.insert("cluster_key".to_string(), cluster_key);
    object.insert("n".to_string(), json!(n));
    object.insert("window".to_string(), window);
    object.insert("traces".to_string(), Value::Array(traces));
    object.insert("at".to_string(), options.now.clone());
    object.insert("prev".to_string(), Value::Null);
    for (key, value) in extra {
        object.insert(key, value);
    }
    Value::Object(object)
}

fn window_of(runs: &[String]) -> Value {
    let from = runs.first().cloned().unwrap_or_default();
    let to = runs.last().cloned().unwrap_or_default();
    json!({ "from_run": from, "to_run": to })
}

fn step_string(step: &Value, key: &str) -> String {
    step.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn verify_of(step: &Value) -> Option<&Value> {
    step.get("verify").filter(|value| !value.is_null())
}

fn usage_number(step: &Value, key: &str) -> Option<f64> {
    step.get("usage").and_then(|usage| usage.get(key)).and_then(Value::as_f64)
}

/// 中位数：空集返回 None；偶数取中间两数均值。
fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        Some(values[middle])
    } else {
        Some((values[middle - 1] + values[middle]) / 2.0)
    }
}

fn dominant(counter: &BTreeMap<String, usize>) -> Option<(String, usize)> {
    counter
        .iter()
        .max_by(|left, right| left.1.cmp(right.1).then_with(|| right.0.cmp(left.0)))
        .map(|(key, count)| (key.clone(), *count))
}

// ---------------------------------------------------------------- failure_cluster

struct Cluster {
    code: String,
    attribution: String,
    workspace: String,
    contract_ids: BTreeSet<String>,
    trace_defs: Vec<Option<String>>,
    runs: Vec<String>,
    n: usize,
}

fn failure_clusters(traces: &[TraceRef], options: &Options<'_>, out: &mut Vec<Value>) {
    let mut clusters: BTreeMap<(String, String, String), Cluster> = BTreeMap::new();
    for trace in traces {
        let workspace = trace.workspace_id();
        let mut samples: Vec<(String, String, String)> = Vec::new();
        if let Some(refused) = trace.refused_at() {
            let code = refused.get("code").and_then(Value::as_str).unwrap_or("").to_string();
            let attribution = refused
                .get("attributable_to")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let node_index = refused.get("node_index").and_then(Value::as_u64);
            let contract = contract_at(trace, node_index);
            samples.push((code, attribution, contract));
        }
        for step in trace.steps() {
            if let Some(code) = step.get("refusal").and_then(Value::as_str) {
                if let Some(attribution) = options.refusal_codes.get(code) {
                    samples.push((code.to_string(), attribution.clone(), step_string(step, "contract_id")));
                }
            }
        }
        for (code, attribution, contract) in samples {
            if code.is_empty() || attribution.is_empty() {
                continue;
            }
            let key = (code.clone(), attribution.clone(), workspace.clone());
            let cluster = clusters.entry(key).or_insert_with(|| Cluster {
                code,
                attribution,
                workspace: workspace.clone(),
                contract_ids: BTreeSet::new(),
                trace_defs: Vec::new(),
                runs: Vec::new(),
                n: 0,
            });
            if !contract.is_empty() {
                cluster.contract_ids.insert(contract);
            }
            cluster.trace_defs.push(trace.def.clone());
            cluster.runs.push(trace.run());
            cluster.n += 1;
        }
    }

    // 两档聚合：同一 (码,归因) 在 ≥ min_workspaces 个工作区独立达阈 ⇒ 可支撑 global。
    let threshold = options.thresholds.count("failure_cluster_n", 3);
    let min_workspaces = options.thresholds.count("min_workspaces", 2);
    let mut supported: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for cluster in clusters.values() {
        if cluster.n >= threshold {
            supported
                .entry((cluster.code.clone(), cluster.attribution.clone()))
                .or_default()
                .insert(cluster.workspace.clone());
        }
    }

    for cluster in clusters.values() {
        if cluster.n < threshold {
            continue;
        }
        let contract_id = if cluster.contract_ids.len() == 1 {
            cluster.contract_ids.iter().next().cloned().map(Value::String)
        } else {
            None
        };
        let cluster_key = json!({
            "code": cluster.code,
            "attributable_to": cluster.attribution,
            "workspace_id": cluster.workspace,
            "contract_id": contract_id.clone().unwrap_or(Value::Null),
        });
        let user = cluster.attribution == "user";
        let scope_support = if user {
            "none"
        } else if supported
            .get(&(cluster.code.clone(), cluster.attribution.clone()))
            .map(|workspaces| workspaces.len() >= min_workspaces)
            .unwrap_or(false)
        {
            "global"
        } else {
            "workspace"
        };
        // 能力缺口：仅 `node` 归因且跨多个 contract_id 重复出现（新能力的证据）。
        let capability_gap = cluster.attribution == "node" && cluster.contract_ids.len() >= 2;
        let mut extra = Map::new();
        extra.insert("attributable_to".to_string(), json!(cluster.attribution));
        extra.insert("capability_gap".to_string(), json!(capability_gap));
        extra.insert("scope_support".to_string(), json!(scope_support));
        extra.insert(
            "contracts".to_string(),
            Value::Array(cluster.contract_ids.iter().cloned().map(Value::String).collect()),
        );
        out.push(make_entry(
            "failure_cluster",
            cluster_key,
            cluster.n,
            window_of(&cluster.runs),
            trace_refs_from(cluster.trace_defs.as_slice()),
            extra,
            options,
        ));
    }
}

fn trace_refs_from(defs: &[Option<String>]) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for hash in defs.iter().flatten() {
        if seen.insert(hash.clone()) {
            out.push(json!({ "def": hash }));
        }
    }
    out
}

fn contract_at(trace: &TraceRef, node_index: Option<u64>) -> String {
    let Some(index) = node_index else {
        return String::new();
    };
    trace
        .steps()
        .iter()
        .find(|step| step.get("node_index").and_then(Value::as_u64) == Some(index))
        .map(|step| step_string(step, "contract_id"))
        .unwrap_or_default()
}

// ---------------------------------------------------------------- post_failure

fn post_failure(traces: &[TraceRef], options: &Options<'_>, out: &mut Vec<Value>) {
    struct Acc {
        fail: usize,
        pass: usize,
        reasons: BTreeMap<String, usize>,
        defs: Vec<Option<String>>,
        runs: Vec<String>,
    }
    let mut groups: BTreeMap<(String, String), Acc> = BTreeMap::new();
    for trace in traces {
        let workspace = trace.workspace_id();
        for step in trace.steps() {
            let verdict = step_string(step, "verdict");
            if verdict != "pass" && verdict != "fail" {
                continue;
            }
            let contract = step_string(step, "contract_id");
            if contract.is_empty() {
                continue;
            }
            let acc = groups
                .entry((workspace.clone(), contract))
                .or_insert_with(|| Acc {
                    fail: 0,
                    pass: 0,
                    reasons: BTreeMap::new(),
                    defs: Vec::new(),
                    runs: Vec::new(),
                });
            if verdict == "fail" {
                acc.fail += 1;
                let reason = step_string(step, "post_failed");
                let reason = if reason.is_empty() { "post_failure".to_string() } else { reason };
                *acc.reasons.entry(reason).or_insert(0) += 1;
            } else {
                acc.pass += 1;
            }
            acc.defs.push(trace.def.clone());
            acc.runs.push(trace.run());
        }
    }

    let ratio = options.thresholds.number("post_failure_ratio", 0.5);
    let minimum = options.thresholds.count("post_failure_min", 3);
    for ((workspace, contract), acc) in &groups {
        let total = acc.fail + acc.pass;
        if total < minimum || total == 0 {
            continue;
        }
        let fail_ratio = acc.fail as f64 / total as f64;
        if fail_ratio <= ratio {
            continue;
        }
        let code = dominant(&acc.reasons)
            .map(|(reason, _)| reason)
            .unwrap_or_else(|| "post_failure".to_string());
        let mut extra = Map::new();
        extra.insert("attributable_to".to_string(), json!("graph"));
        extra.insert("capability_gap".to_string(), json!(false));
        extra.insert("scope_support".to_string(), json!("workspace"));
        extra.insert("fail_ratio".to_string(), json!(fail_ratio));
        out.push(make_entry(
            "post_failure",
            json!({
                "code": code,
                "attributable_to": "graph",
                "workspace_id": workspace,
                "contract_id": contract,
            }),
            total,
            window_of(&acc.runs),
            trace_refs_from(&acc.defs),
            extra,
            options,
        ));
    }
}

// ---------------------------------------------------------------- cost_anomaly

/// 一条成本样本：四维用量 + 来源 trace def + run。
type CostSample = (f64, f64, f64, f64, Option<String>, String);

fn cost_anomaly(traces: &[TraceRef], options: &Options<'_>, out: &mut Vec<Value>) {
    let dimensions = ["tokens", "calls", "tool_calls", "walltime_ms"];
    let multiple = options.thresholds.number("cost_anomaly_multiple", 2.0);
    let mut groups: BTreeMap<(String, String), Vec<CostSample>> = BTreeMap::new();
    for trace in traces {
        let workspace = trace.workspace_id();
        for step in trace.steps() {
            let contract = step_string(step, "contract_id");
            if contract.is_empty() {
                continue;
            }
            let values = dimensions.map(|dimension| usage_number(step, dimension).unwrap_or(0.0));
            groups
                .entry((workspace.clone(), contract))
                .or_default()
                .push((
                    values[0],
                    values[1],
                    values[2],
                    values[3],
                    trace.def.clone(),
                    trace.run(),
                ));
        }
    }

    for ((workspace, contract), samples) in &groups {
        if samples.len() < 3 {
            continue;
        }
        let split = samples.len() / 2;
        let baseline = &samples[..split];
        let observed = &samples[split..];
        if baseline.is_empty() || observed.is_empty() {
            continue;
        }
        // 基线走 ③ 缓存（可重算）：键 = 基线样本的确定性哈希；命中 / 未命中输出一致。
        let cache_key = format!("cost|{}|{}", workspace, contract);
        let signature = hash::content_hash(&Value::Array(
            baseline
                .iter()
                .map(|sample| json!([sample.0, sample.1, sample.2, sample.3]))
                .collect(),
        ));
        let mut anomalous = Vec::new();
        let mut baseline_medians = Map::new();
        let mut observed_medians = Map::new();
        let cached = cached_baseline(options, &cache_key, &signature);
        for (index, dimension) in dimensions.iter().enumerate() {
            let baseline_median = match cached.as_ref().and_then(|value| value.get(*dimension)) {
                Some(value) => value.as_f64().unwrap_or(0.0),
                None => {
                    let mut values: Vec<f64> = baseline.iter().map(|sample| sample_dim(sample, index)).collect();
                    median(&mut values).unwrap_or(0.0)
                }
            };
            let mut observed_values: Vec<f64> =
                observed.iter().map(|sample| sample_dim(sample, index)).collect();
            let observed_median = median(&mut observed_values).unwrap_or(0.0);
            baseline_medians.insert((*dimension).to_string(), json!(baseline_median));
            observed_medians.insert((*dimension).to_string(), json!(observed_median));
            if baseline_median > 0.0 && observed_median > baseline_median * multiple {
                anomalous.push((*dimension).to_string());
            }
        }
        if cached.is_none() {
            write_baseline(options, &cache_key, &signature, &Value::Object(baseline_medians.clone()));
        }
        if anomalous.is_empty() {
            continue;
        }
        let defs: Vec<Option<String>> = samples.iter().map(|sample| sample.4.clone()).collect();
        let runs: Vec<String> = samples.iter().map(|sample| sample.5.clone()).collect();
        let mut extra = Map::new();
        extra.insert("attributable_to".to_string(), json!("graph"));
        extra.insert("capability_gap".to_string(), json!(false));
        extra.insert("scope_support".to_string(), json!("workspace"));
        extra.insert("dimensions".to_string(), json!(anomalous));
        extra.insert("baseline_median".to_string(), Value::Object(baseline_medians));
        extra.insert("observed_median".to_string(), Value::Object(observed_medians));
        out.push(make_entry(
            "cost_anomaly",
            json!({
                "code": "cost_anomaly",
                "attributable_to": "graph",
                "workspace_id": workspace,
                "contract_id": contract,
            }),
            samples.len(),
            window_of(&runs),
            trace_refs_from(&defs),
            extra,
            options,
        ));
    }
}

fn sample_dim(sample: &CostSample, index: usize) -> f64 {
    match index {
        0 => sample.0,
        1 => sample.1,
        2 => sample.2,
        _ => sample.3,
    }
}

/// ③ 缓存读：键 = 工作区|契约|基线签名；无 StateStore（纯计算测试）时不读不写。
fn cached_baseline(options: &Options<'_>, key: &str, signature: &str) -> Option<Value> {
    options.state?.read(&format!("{key}|{signature}"))
}

fn write_baseline(options: &Options<'_>, key: &str, signature: &str, value: &Value) {
    if let Some(store) = options.state {
        store.write(&format!("{key}|{signature}"), value);
    }
}

// ---------------------------------------------------------------- instance_drift

fn instance_drift(traces: &[TraceRef], options: &Options<'_>, out: &mut Vec<Value>) {
    struct Acc {
        samples: Vec<(bool, String, Option<String>, String)>,
    }
    let mut groups: BTreeMap<(String, String), Acc> = BTreeMap::new();
    for trace in traces {
        let workspace = trace.workspace_id();
        for step in trace.steps() {
            let Some(instance) = step.get("chosen_instance").and_then(Value::as_str) else {
                continue;
            };
            let verdict = step_string(step, "verdict");
            if verdict != "pass" && verdict != "fail" {
                continue;
            }
            groups
                .entry((workspace.clone(), instance.to_string()))
                .or_insert_with(|| Acc { samples: Vec::new() })
                .samples
                .push((
                    verdict == "pass",
                    step_string(step, "contract_id"),
                    trace.def.clone(),
                    trace.run(),
                ));
        }
    }

    let margin = options.thresholds.number("drift_margin", 0.2);
    let minimum = options.thresholds.count("drift_min_samples", 5);
    for ((workspace, instance), acc) in &groups {
        if acc.samples.len() < minimum * 2 {
            continue;
        }
        let split = acc.samples.len() / 2;
        let (baseline, observed) = acc.samples.split_at(split);
        if baseline.len() < minimum || observed.len() < minimum {
            continue;
        }
        let baseline_rate = baseline.iter().filter(|sample| sample.0).count() as f64 / baseline.len() as f64;
        let observed_rate = observed.iter().filter(|sample| sample.0).count() as f64 / observed.len() as f64;
        if observed_rate >= baseline_rate - margin {
            continue;
        }
        let contracts: BTreeSet<String> = acc
            .samples
            .iter()
            .map(|sample| sample.1.clone())
            .filter(|contract| !contract.is_empty())
            .collect();
        let contract_id = if contracts.len() == 1 {
            contracts.iter().next().cloned().map(Value::String)
        } else {
            None
        };
        let defs: Vec<Option<String>> = acc.samples.iter().map(|sample| sample.2.clone()).collect();
        let runs: Vec<String> = acc.samples.iter().map(|sample| sample.3.clone()).collect();
        let mut extra = Map::new();
        extra.insert("attributable_to".to_string(), json!("node"));
        extra.insert("capability_gap".to_string(), json!(false));
        extra.insert("scope_support".to_string(), json!("workspace"));
        extra.insert("instance".to_string(), json!(instance));
        extra.insert("baseline_rate".to_string(), json!(baseline_rate));
        extra.insert("observed_rate".to_string(), json!(observed_rate));
        out.push(make_entry(
            "instance_drift",
            json!({
                "code": "instance_drift",
                "attributable_to": "node",
                "workspace_id": workspace,
                "contract_id": contract_id.unwrap_or(Value::Null),
            }),
            acc.samples.len(),
            window_of(&runs),
            trace_refs_from(&defs),
            extra,
            options,
        ));
    }
}

// ---------------------------------------------------------------- fold_candidate

fn fold_candidate(traces: &[TraceRef], options: &Options<'_>, out: &mut Vec<Value>) {
    let k = options.thresholds.count("fold_k", 3);
    struct Run {
        workspace: String,
        signature: String,
        path: Vec<String>,
        defs: Vec<Option<String>>,
        runs: Vec<String>,
    }
    let mut completed: Vec<Run> = Vec::new();
    let mut current: Option<Run> = None;
    for trace in traces {
        if trace.outcome() != "done" {
            if let Some(run) = current.take() {
                completed.push(run);
            }
            continue;
        }
        let path: Vec<String> = trace
            .steps()
            .iter()
            .map(|step| step_string(step, "contract_id"))
            .collect();
        let signature = path.join(">");
        let workspace = trace.workspace_id();
        let matches = current
            .as_ref()
            .map(|run| run.signature == signature && run.workspace == workspace)
            .unwrap_or(false);
        if !matches {
            if let Some(run) = current.take() {
                completed.push(run);
            }
            current = Some(Run {
                workspace,
                signature,
                path,
                defs: Vec::new(),
                runs: Vec::new(),
            });
        }
        if let Some(run) = current.as_mut() {
            run.defs.push(trace.def.clone());
            run.runs.push(trace.run());
        }
    }
    if let Some(run) = current.take() {
        completed.push(run);
    }

    for run in completed {
        if run.runs.len() < k {
            continue;
        }
        let mut extra = Map::new();
        extra.insert("attributable_to".to_string(), json!("graph"));
        extra.insert("capability_gap".to_string(), json!(false));
        extra.insert("scope_support".to_string(), json!("workspace"));
        extra.insert("path".to_string(), json!(run.path));
        extra.insert("rounds".to_string(), json!(run.runs.len()));
        out.push(make_entry(
            "fold_candidate",
            json!({
                "code": "fold_candidate",
                "attributable_to": "graph",
                "workspace_id": run.workspace,
                "contract_id": Value::Null,
            }),
            run.runs.len(),
            window_of(&run.runs),
            trace_refs_from(&run.defs),
            extra,
            options,
        ));
    }
}

// ---------------------------------------------------------------- no_progress

fn no_progress(traces: &[TraceRef], options: &Options<'_>, out: &mut Vec<Value>) {
    struct Acc {
        count: usize,
        defs: Vec<Option<String>>,
        runs: Vec<String>,
    }
    let mut groups: BTreeMap<(String, String), Acc> = BTreeMap::new();
    for trace in traces {
        let workspace = trace.workspace_id();
        for step in trace.steps() {
            if step.get("l1_maxed").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let contract = step_string(step, "contract_id");
            if contract.is_empty() {
                continue;
            }
            let acc = groups
                .entry((workspace.clone(), contract))
                .or_insert_with(|| Acc {
                    count: 0,
                    defs: Vec::new(),
                    runs: Vec::new(),
                });
            acc.count += 1;
            acc.defs.push(trace.def.clone());
            acc.runs.push(trace.run());
        }
    }

    let minimum = options.thresholds.count("no_progress_n", 3);
    for ((workspace, contract), acc) in &groups {
        if acc.count < minimum {
            continue;
        }
        let mut extra = Map::new();
        extra.insert("attributable_to".to_string(), json!("node"));
        extra.insert("capability_gap".to_string(), json!(false));
        extra.insert("scope_support".to_string(), json!("workspace"));
        out.push(make_entry(
            "no_progress",
            json!({
                "code": "no_progress",
                "attributable_to": "node",
                "workspace_id": workspace,
                "contract_id": contract,
            }),
            acc.count,
            window_of(&acc.runs),
            trace_refs_from(&acc.defs),
            extra,
            options,
        ));
    }
}

// ---------------------------------------------------------------- verify_failure

fn verify_failure(traces: &[TraceRef], options: &Options<'_>, out: &mut Vec<Value>) {
    struct Acc {
        total: usize,
        details: BTreeMap<String, usize>,
        contracts: BTreeMap<String, BTreeSet<String>>,
        defs: Vec<Option<String>>,
        runs: Vec<String>,
    }
    let mut groups: BTreeMap<String, Acc> = BTreeMap::new();
    for trace in traces {
        let workspace = trace.workspace_id();
        for step in trace.steps() {
            let Some(verify) = verify_of(step) else {
                continue;
            };
            let skipped = verify.get("skipped").and_then(Value::as_bool).unwrap_or(false);
            let passed = verify.get("passed").and_then(Value::as_bool).unwrap_or(true);
            if skipped || passed {
                continue;
            }
            let detail = verify
                .get("detail")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let acc = groups.entry(workspace.clone()).or_insert_with(|| Acc {
                total: 0,
                details: BTreeMap::new(),
                contracts: BTreeMap::new(),
                defs: Vec::new(),
                runs: Vec::new(),
            });
            acc.total += 1;
            *acc.details.entry(detail.clone()).or_insert(0) += 1;
            acc.contracts
                .entry(detail)
                .or_default()
                .insert(step_string(step, "contract_id"));
            acc.defs.push(trace.def.clone());
            acc.runs.push(trace.run());
        }
    }

    let minimum = options.thresholds.count("verify_failure_n", 2);
    let ratio = options.thresholds.number("verify_cluster_ratio", 0.6);
    for (workspace, acc) in &groups {
        if acc.total < minimum {
            continue;
        }
        let Some((detail, count)) = dominant(&acc.details) else {
            continue;
        };
        let share = count as f64 / acc.total as f64;
        if share < ratio {
            continue;
        }
        let contracts = acc.contracts.get(&detail).cloned().unwrap_or_default();
        let contract_id = if contracts.len() == 1 {
            contracts.iter().next().cloned().map(Value::String)
        } else {
            None
        };
        let mut extra = Map::new();
        extra.insert("attributable_to".to_string(), json!("node"));
        // 近 oracle 信号：指向具体能力缺口（不是编排问题）。
        extra.insert("capability_gap".to_string(), json!(true));
        extra.insert("scope_support".to_string(), json!("workspace"));
        extra.insert("detail_cluster".to_string(), json!(detail));
        extra.insert("detail_share".to_string(), json!(share));
        out.push(make_entry(
            "verify_failure",
            json!({
                "code": "verify_failure",
                "attributable_to": "node",
                "workspace_id": workspace,
                "contract_id": contract_id.unwrap_or(Value::Null),
            }),
            count,
            window_of(&acc.runs),
            trace_refs_from(&acc.defs),
            extra,
            options,
        ));
    }
}

// ---------------------------------------------------------------- orchestration.unhealthy

/// 最近连续 N 次以 `refused` 收口 ⇒ 发 `orchestration.unhealthy`（N 读 thresholds，与 #17 同口径）。
fn unhealthy_event(traces: &[TraceRef], options: &Options<'_>) -> Option<Value> {
    let threshold = options.thresholds.count("unhealthy_refused_streak", 3);
    if threshold == 0 {
        return None;
    }
    let mut streak = 0usize;
    let mut newest: Option<&TraceRef> = None;
    for trace in traces.iter().rev() {
        if trace.outcome() != "refused" {
            break;
        }
        if newest.is_none() {
            newest = Some(trace);
        }
        streak += 1;
    }
    if streak < threshold {
        return None;
    }
    Some(json!({
        "fired": true,
        "streak": streak,
        "threshold": threshold,
        "workspace_id": newest.map(TraceRef::workspace_id).unwrap_or_default(),
        "run": newest.map(TraceRef::run).unwrap_or_default(),
        "reason": "consecutive_refused",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(run: &str, workspace: &str, outcome: &str, steps: Value, refused: Value) -> TraceRef {
        TraceRef {
            def: Some(format!("def-{run}")),
            body: json!({
                "kind": "trace",
                "run": run,
                "workspace_id": workspace,
                "outcome": outcome,
                "steps": steps,
                "refused_at": refused,
            }),
        }
    }

    fn options<'a>(
        thresholds: &'a Thresholds,
        now: &'a Value,
        codes: &'a BTreeMap<String, String>,
    ) -> Options<'a> {
        Options {
            thresholds,
            now,
            refusal_codes: codes,
            state: None,
        }
    }

    fn class_of(entry: &Value) -> String {
        entry.get("class").and_then(Value::as_str).unwrap_or("").to_string()
    }

    fn find<'a>(evidence: &'a [Value], class: &str) -> &'a Value {
        evidence
            .iter()
            .find(|entry| class_of(entry) == class)
            .unwrap_or_else(|| panic!("missing evidence class {class}: {evidence:?}"))
    }

    #[test]
    fn failure_cluster_partitions_by_workspace_and_marks_scope_support() {
        let mut map = BTreeMap::new();
        map.insert("failure_cluster_n".to_string(), 1.0);
        map.insert("min_workspaces".to_string(), 2.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let refused = json!({"node_index": 1, "code": "capability_mismatch", "attributable_to": "graph"});
        let steps = json!([{"node_index": 1, "contract_id": "agent.step", "verdict": "fail"}]);
        let traces = vec![
            trace("r1", "w1", "refused", steps.clone(), refused.clone()),
            trace("r2", "w2", "refused", steps.clone(), refused.clone()),
        ];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let clusters: Vec<&Value> = built
            .evidence
            .iter()
            .filter(|entry| class_of(entry) == "failure_cluster")
            .collect();
        // 跨工作区不合并：两条独立证据。
        assert_eq!(clusters.len(), 2);
        let workspaces: BTreeSet<&str> = clusters
            .iter()
            .map(|entry| entry["cluster_key"]["workspace_id"].as_str().unwrap())
            .collect();
        assert_eq!(workspaces, BTreeSet::from(["w1", "w2"]));
        // 同一 (码,归因) 在两个工作区独立出现 ⇒ 可支撑 global。
        assert!(clusters
            .iter()
            .all(|entry| entry["scope_support"] == "global"));
    }

    #[test]
    fn user_attribution_does_not_produce_capability_gap() {
        let mut map = BTreeMap::new();
        map.insert("failure_cluster_n".to_string(), 1.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let refused = json!({"node_index": 1, "code": "denied", "attributable_to": "user"});
        let traces = vec![trace("r1", "w1", "refused", json!([]), refused)];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let cluster = find(&built.evidence, "failure_cluster");
        assert_eq!(cluster["capability_gap"], false);
        assert_eq!(cluster["scope_support"], "none");
        assert_eq!(cluster["cluster_key"]["attributable_to"], "user");
    }

    #[test]
    fn node_attribution_across_contracts_is_capability_gap() {
        let mut map = BTreeMap::new();
        map.insert("failure_cluster_n".to_string(), 1.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let traces = vec![
            trace(
                "r1",
                "w1",
                "refused",
                json!([{"node_index": 1, "contract_id": "a", "verdict": "fail"}]),
                json!({"node_index": 1, "code": "pre_unsat", "attributable_to": "node"}),
            ),
            trace(
                "r2",
                "w1",
                "refused",
                json!([{"node_index": 2, "contract_id": "b", "verdict": "fail"}]),
                json!({"node_index": 2, "code": "pre_unsat", "attributable_to": "node"}),
            ),
        ];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let cluster = find(&built.evidence, "failure_cluster");
        assert_eq!(cluster["capability_gap"], true);
        assert_eq!(cluster["cluster_key"]["contract_id"], Value::Null);
    }

    #[test]
    fn post_failure_detected_by_fail_ratio() {
        let mut map = BTreeMap::new();
        map.insert("post_failure_min".to_string(), 3.0);
        map.insert("post_failure_ratio".to_string(), 0.5);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let steps = json!([
            {"contract_id": "agent.step", "verdict": "fail", "post_failed": "malformed_tool_call"},
            {"contract_id": "agent.step", "verdict": "fail", "post_failed": "malformed_tool_call"},
            {"contract_id": "agent.step", "verdict": "pass"}
        ]);
        let traces = vec![trace("r1", "w1", "done", steps, Value::Null)];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let entry = find(&built.evidence, "post_failure");
        assert_eq!(entry["cluster_key"]["contract_id"], "agent.step");
        assert_eq!(entry["cluster_key"]["code"], "malformed_tool_call");
    }

    #[test]
    fn cost_anomaly_detected_against_window_baseline() {
        let mut map = BTreeMap::new();
        map.insert("cost_anomaly_multiple".to_string(), 2.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let steps = json!([
            {"contract_id": "agent.step", "verdict": "pass", "usage": {"tokens": 1}},
            {"contract_id": "agent.step", "verdict": "pass", "usage": {"tokens": 10}},
            {"contract_id": "agent.step", "verdict": "pass", "usage": {"tokens": 10}}
        ]);
        let traces = vec![trace("r1", "w1", "done", steps, Value::Null)];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let entry = find(&built.evidence, "cost_anomaly");
        assert!(entry["dimensions"]
            .as_array()
            .unwrap()
            .contains(&json!("tokens")));
    }

    #[test]
    fn instance_drift_detected_by_rolling_success() {
        let mut map = BTreeMap::new();
        map.insert("drift_min_samples".to_string(), 2.0);
        map.insert("drift_margin".to_string(), 0.2);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let steps = json!([
            {"contract_id": "agent.step", "chosen_instance": "nd-1", "verdict": "pass"},
            {"contract_id": "agent.step", "chosen_instance": "nd-1", "verdict": "pass"},
            {"contract_id": "agent.step", "chosen_instance": "nd-1", "verdict": "fail"},
            {"contract_id": "agent.step", "chosen_instance": "nd-1", "verdict": "fail"}
        ]);
        let traces = vec![trace("r1", "w1", "done", steps, Value::Null)];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let entry = find(&built.evidence, "instance_drift");
        assert_eq!(entry["instance"], "nd-1");
    }

    #[test]
    fn fold_candidate_after_k_consecutive_success() {
        let mut map = BTreeMap::new();
        map.insert("fold_k".to_string(), 3.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let steps = json!([{"contract_id": "agent.step", "verdict": "pass"}]);
        let traces = vec![
            trace("r1", "w1", "done", steps.clone(), Value::Null),
            trace("r2", "w1", "done", steps.clone(), Value::Null),
            trace("r3", "w1", "done", steps, Value::Null),
        ];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let entry = find(&built.evidence, "fold_candidate");
        assert_eq!(entry["rounds"], 3);
    }

    #[test]
    fn no_progress_from_repeated_l1_maxed() {
        let mut map = BTreeMap::new();
        map.insert("no_progress_n".to_string(), 3.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let steps = json!([
            {"contract_id": "agent.step", "verdict": "fail", "l1_maxed": true},
            {"contract_id": "agent.step", "verdict": "fail", "l1_maxed": true},
            {"contract_id": "agent.step", "verdict": "fail", "l1_maxed": true}
        ]);
        let traces = vec![trace("r1", "w1", "done", steps, Value::Null)];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let entry = find(&built.evidence, "no_progress");
        assert_eq!(entry["cluster_key"]["contract_id"], "agent.step");
    }

    #[test]
    fn verify_failure_is_a_capability_gap() {
        let mut map = BTreeMap::new();
        map.insert("verify_failure_n".to_string(), 2.0);
        map.insert("verify_cluster_ratio".to_string(), 0.6);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let steps = json!([
            {"contract_id": "verify", "verdict": "pass", "verify": {"passed": false, "skipped": false, "detail": "cargo test failed"}},
            {"contract_id": "verify", "verdict": "pass", "verify": {"passed": false, "skipped": false, "detail": "cargo test failed"}}
        ]);
        let traces = vec![trace("r1", "w1", "done", steps, Value::Null)];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let entry = find(&built.evidence, "verify_failure");
        assert_eq!(entry["capability_gap"], true);
        assert_eq!(entry["detail_cluster"], "cargo test failed");
    }

    #[test]
    fn unhealthy_fires_on_consecutive_refusals() {
        let mut map = BTreeMap::new();
        map.insert("unhealthy_refused_streak".to_string(), 3.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let traces = vec![
            trace("r0", "w1", "done", json!([]), Value::Null),
            trace("r1", "w1", "refused", json!([]), Value::Null),
            trace("r2", "w1", "refused", json!([]), Value::Null),
            trace("r3", "w1", "refused", json!([]), Value::Null),
        ];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let event = built.unhealthy.unwrap();
        assert_eq!(event["streak"], 3);
        assert_eq!(event["run"], "r3");
    }

    #[test]
    fn empty_traces_produce_empty_set() {
        let thresholds = Thresholds::default();
        let codes = BTreeMap::new();
        let now = json!(1);
        let built = build(&[], &options(&thresholds, &now, &codes));
        assert!(built.evidence.is_empty());
        assert!(built.unhealthy.is_none());
    }

    #[test]
    fn single_workspace_supports_workspace_scope_only() {
        let mut map = BTreeMap::new();
        map.insert("failure_cluster_n".to_string(), 1.0);
        map.insert("min_workspaces".to_string(), 2.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let traces = vec![trace(
            "r1",
            "w1",
            "refused",
            json!([]),
            json!({"node_index": 1, "code": "capability_mismatch", "attributable_to": "graph"}),
        )];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        let cluster = find(&built.evidence, "failure_cluster");
        assert_eq!(cluster["scope_support"], "workspace");
    }

    #[test]
    fn unhealthy_streak_breaks_on_done() {
        let mut map = BTreeMap::new();
        map.insert("unhealthy_refused_streak".to_string(), 3.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let traces = vec![
            trace("r1", "w1", "refused", json!([]), Value::Null),
            trace("r2", "w1", "refused", json!([]), Value::Null),
            trace("r3", "w1", "done", json!([]), Value::Null),
            trace("r4", "w1", "refused", json!([]), Value::Null),
            trace("r5", "w1", "refused", json!([]), Value::Null),
        ];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        // 最近连续只有 2 次，未达阈。
        assert!(built.unhealthy.is_none());
    }

    #[test]
    fn evidence_contains_no_proposal_kind() {
        let mut map = BTreeMap::new();
        map.insert("failure_cluster_n".to_string(), 1.0);
        let thresholds = Thresholds::from_map(map);
        let codes = BTreeMap::new();
        let now = json!(1);
        let traces = vec![trace(
            "r1",
            "w1",
            "refused",
            json!([]),
            json!({"node_index": 1, "code": "pre_unsat", "attributable_to": "node"}),
        )];
        let built = build(&traces, &options(&thresholds, &now, &codes));
        assert!(built
            .evidence
            .iter()
            .all(|entry| entry["kind"] == "evidence"));
    }
}

