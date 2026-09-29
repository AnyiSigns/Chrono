// `search`：检索流水线编排（查询规划 → 向量化 → 索引检索 → 归并回溯 → 过滤 → 时间衰减 →
// 阈值 → 去重 → 候选重排（MMR + 可选语义重排）→ 预算截断），结果写入 bag.recall（返回值）。
// 服务不读投影、无写通道、不取时间；一切输入随 bag 传入，跨插件调用只走反向调用。
// 查询构造 / 多查询与候选重排（MMR / 语义）是重逻辑，分别委派 query-plan.plan / rerank.order；
// 本服务只留编排与查询向量缓存（③）。模型项（多查询 / 语义重排）默认关，失败即降级（保确定可回放）。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::bag;
use crate::config::{self, RetrievalConfig};
use crate::decay;
use crate::dedup;
use crate::error::ServiceError;
use crate::hash;
use crate::port::Ports;
use crate::state::StateStore;
use crate::vector::{self, ChunkHit, EntryScore};

/// 一条候选条目（已归并到条目级）。
#[derive(Clone, Debug)]
struct Candidate {
    entry_hash: String,
    entry_id: String,
    chunk_index: u64,
    score_raw: f64,
    score: f64,
    text: String,
    meta: Value,
}

/// 执行检索：`bag` 为调用方装配（方法入参即 bag），`env` 为调用帧 env。
pub fn run(
    bag: &Value,
    env: &Value,
    ports: &Ports<'_>,
    state: &dyn StateStore,
) -> Result<Value, (String, String)> {
    let config = config::from_bag(bag);
    let raw_query = bag::query_of(bag);
    let goal = bag::goal_of(bag);
    if raw_query.trim().is_empty() && goal.trim().is_empty() {
        return Ok(empty_result(&config, "", Vec::new()));
    }

    // 查询规划委派 query-plan.plan（查询构造 + 可选多查询）。
    let plan = ports
        .query_plan
        .plan(json!({
            "query": raw_query,
            "goal": goal,
            "model_config": bag::model_config(bag),
            "multi_query": config.multi_query,
        }))
        .map_err(into_error)?;
    let queries = plan_queries(&plan);
    let query = plan
        .get("query")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| queries.first().cloned().unwrap_or_default());

    let vectors = embed_texts(&queries, &config, ports, state).map_err(into_error)?;

    let hits = match search_all(&vectors, &config, ports).map_err(into_error)? {
        SearchOutcome::Hits(hits) => hits,
        // #21 冷索引首查回 `status:'index_building'`：不静默当空集，回结构化「索引构建中」。
        SearchOutcome::IndexBuilding => {
            return Ok(index_building_result(&config, &query, queries))
        }
    };
    let grouped = vector::group_by_entry(&hits);
    let hashes: Vec<String> = grouped
        .iter()
        .map(|entry| entry.entry_hash.clone())
        .collect();
    let entries = read_entries(&hashes, ports);

    let mut stats = Stats::default();
    let candidates = build_candidates(&grouped, &entries, &mut stats);
    let candidates = apply_filters(candidates, &config, bag, &mut stats);
    let candidates = apply_decay(candidates, &config, bag, env);
    let candidates = apply_threshold(candidates, &config, &mut stats);
    let candidates = apply_dedup(candidates, bag, &mut stats);
    let candidates = apply_order(candidates, &config, bag, ports);

    let limit = config::effective_limit(&config);
    let recall: Vec<Value> = candidates.iter().take(limit).map(candidate_json).collect();

    Ok(json!({
        "ok": true,
        "kind": "search",
        "status": "ready",
        "model": { "id": config.model, "dim": config.dim },
        "query": query,
        "queries": queries,
        "recall": recall,
        "count": recall.len(),
        "budget": limit,
        "stats": stats.to_json(),
    }))
}

/// 各阶段丢弃计数。
#[derive(Default)]
struct Stats {
    missing: usize,
    scope: usize,
    tags: usize,
    source: usize,
    threshold: usize,
    dedup: usize,
}

impl Stats {
    fn to_json(&self) -> Value {
        json!({
            "missing": self.missing,
            "scope": self.scope,
            "tags": self.tags,
            "source": self.source,
            "threshold": self.threshold,
            "dedup": self.dedup,
        })
    }
}

fn into_error(error: ServiceError) -> (String, String) {
    (error.code, error.message)
}

/// 从 query-plan.plan 结果取查询集；缺失 / 非数组回空集。
fn plan_queries(plan: &Value) -> Vec<String> {
    plan.get("queries")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 空结果：不报错、不产写。
fn empty_result(config: &RetrievalConfig, query: &str, queries: Vec<String>) -> Value {
    json!({
        "ok": true,
        "kind": "search",
        "status": "ready",
        "model": { "id": config.model, "dim": config.dim },
        "query": query,
        "queries": queries,
        "recall": [],
        "count": 0,
        "budget": config::effective_limit(config),
        "stats": Stats::default().to_json(),
    })
}

/// 索引构建中（#21 冷索引首查）：不报错、不产写；调用方据此稍后重试，而非当成空集。
fn index_building_result(config: &RetrievalConfig, query: &str, queries: Vec<String>) -> Value {
    json!({
        "ok": true,
        "kind": "search",
        "status": "index_building",
        "reason": "index_building",
        "model": { "id": config.model, "dim": config.dim },
        "query": query,
        "queries": queries,
        "recall": [],
        "count": 0,
        "budget": config::effective_limit(config),
        "stats": Stats::default().to_json(),
    })
}

/// 向量化（含 ③ 查询向量缓存）：命中即用，未命中批量重算并回写。
fn embed_texts(
    texts: &[String],
    config: &RetrievalConfig,
    ports: &Ports<'_>,
    state: &dyn StateStore,
) -> Result<Vec<Vec<f64>>, ServiceError> {
    let mut resolved: Vec<Option<Vec<f64>>> = vec![None; texts.len()];
    let mut pending: Vec<(usize, String)> = Vec::new();
    for (index, text) in texts.iter().enumerate() {
        let key = cache_key(&config.model, text);
        if let Some(vector) = state.read(&key).and_then(read_vector) {
            resolved[index] = Some(vector);
            continue;
        }
        pending.push((index, text.clone()));
    }
    if !pending.is_empty() {
        let pending_texts: Vec<String> = pending.iter().map(|(_, text)| text.clone()).collect();
        let vectors = ports.embedding.embed(&pending_texts, &config.model)?;
        if vectors.len() != pending_texts.len() {
            return Err(ServiceError::new(
                "bad_backend",
                "embedding.embed returned wrong vector count",
            ));
        }
        for ((index, text), vector) in pending.iter().zip(vectors) {
            state.write(&cache_key(&config.model, text), &json!(vector));
            resolved[*index] = Some(vector);
        }
    }
    Ok(resolved
        .into_iter()
        .map(|v| v.unwrap_or_default())
        .collect())
}

fn cache_key(model: &str, text: &str) -> String {
    hash::hash64(&format!("{model}\n{text}"))
}

fn read_vector(value: Value) -> Option<Vec<f64>> {
    value
        .as_array()?
        .iter()
        .map(Value::as_f64)
        .collect::<Option<Vec<f64>>>()
}

/// 每查询索引检索的结果：命中集，或索引构建中（#21 冷索引首查，非空集）。
enum SearchOutcome {
    Hits(Vec<ChunkHit>),
    IndexBuilding,
}

/// 每查询索引检索，再按 chunk 取跨查询最高分归并。
/// `memory-store` owner 自行持有条目与索引，故只传查询向量与 top_k，不传投影切片。
fn search_all(
    vectors: &[Vec<f64>],
    config: &RetrievalConfig,
    ports: &Ports<'_>,
) -> Result<SearchOutcome, ServiceError> {
    let per_query = config::per_query_top_k(config, vectors.len());
    let mut groups = Vec::with_capacity(vectors.len());
    for vector in vectors {
        let args = json!({
            "query_vector": vector,
            "top_k": per_query,
        });
        let value = ports.memory.search(args)?;
        if value.get("ok").and_then(Value::as_bool) == Some(false) {
            let code = value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("memory_search_failed");
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("");
            return Err(ServiceError::new(code, message));
        }
        if value.get("status").and_then(Value::as_str) == Some("index_building") {
            return Ok(SearchOutcome::IndexBuilding);
        }
        groups.push(parse_hits(&value));
    }
    Ok(SearchOutcome::Hits(vector::merge_chunk_hits(&groups)))
}

fn parse_hits(value: &Value) -> Vec<ChunkHit> {
    value
        .get("hits")
        .and_then(Value::as_array)
        .map(|hits| {
            hits.iter()
                .filter_map(|hit| {
                    Some(ChunkHit {
                        entry_hash: hit.get("entry_hash")?.as_str()?.to_string(),
                        chunk_index: hit.get("chunk_index")?.as_u64()?,
                        score: hit.get("score")?.as_f64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// chunk → entry 回溯：批量调 memory.read 取条目正文；失败 / 缺失按未命中处理。
fn read_entries(hashes: &[String], ports: &Ports<'_>) -> BTreeMap<String, Value> {
    if hashes.is_empty() {
        return BTreeMap::new();
    }
    let args = json!({ "hashes": hashes });
    let Ok(value) = ports.memory.read(args) else {
        return BTreeMap::new();
    };
    let mut map = BTreeMap::new();
    if let Some(entries) = value.get("entries").and_then(Value::as_array) {
        for item in entries {
            let Some(hash) = item.get("hash").and_then(Value::as_str) else {
                continue;
            };
            let Some(entry) = item.get("entry") else {
                continue;
            };
            if !entry.is_null() {
                map.insert(hash.to_string(), entry.clone());
            }
        }
    }
    map
}

fn build_candidates(
    grouped: &[EntryScore],
    entries: &BTreeMap<String, Value>,
    stats: &mut Stats,
) -> Vec<Candidate> {
    let mut candidates = Vec::with_capacity(grouped.len());
    for score in grouped {
        let Some(entry) = entries.get(&score.entry_hash) else {
            stats.missing += 1;
            continue;
        };
        candidates.push(Candidate {
            entry_hash: score.entry_hash.clone(),
            entry_id: bag::string_of(entry, "id"),
            chunk_index: score.chunk_index,
            score_raw: score.score,
            score: score.score,
            text: bag::string_of(entry, "text"),
            meta: entry.get("meta").cloned().unwrap_or_else(|| json!({})),
        });
    }
    candidates
}

/// 过滤：工作区范围（默认开，当前工作区 + 全局条目）+ 标签 / 来源。
fn apply_filters(
    candidates: Vec<Candidate>,
    config: &RetrievalConfig,
    bag: &Value,
    stats: &mut Stats,
) -> Vec<Candidate> {
    let workspace = bag::workspace_of(bag);
    candidates
        .into_iter()
        .filter(
            |candidate| match filter_reason(candidate, config, &workspace) {
                None => true,
                Some("scope") => {
                    stats.scope += 1;
                    false
                }
                Some("tags") => {
                    stats.tags += 1;
                    false
                }
                Some(_) => {
                    stats.source += 1;
                    false
                }
            },
        )
        .collect()
}

fn filter_reason<'a>(
    candidate: &Candidate,
    config: &RetrievalConfig,
    workspace: &str,
) -> Option<&'a str> {
    if config.workspace_scope && !workspace.is_empty() {
        let entry_workspace = candidate
            .meta
            .get("workspace")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !entry_workspace.is_empty() && entry_workspace != workspace {
            return Some("scope");
        }
    }
    if !config.tags.is_empty() {
        let entry_tags = candidate
            .meta
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| tags.iter().filter_map(Value::as_str).collect::<Vec<&str>>())
            .unwrap_or_default();
        if !entry_tags
            .iter()
            .any(|tag| config.tags.iter().any(|wanted| wanted == tag))
        {
            return Some("tags");
        }
    }
    if !config.source.is_empty() {
        let source = candidate
            .meta
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !config.source.iter().any(|wanted| wanted == source) {
            return Some("source");
        }
    }
    None
}

/// 时间衰减：score × exp(-λ · age)；age 由 bag 时间 − meta.at 算（服务不取时间）。
fn apply_decay(
    mut candidates: Vec<Candidate>,
    config: &RetrievalConfig,
    bag: &Value,
    env: &Value,
) -> Vec<Candidate> {
    if config.decay_lambda <= 0.0 {
        return candidates;
    }
    let now = bag::now_of(bag, env);
    for candidate in candidates.iter_mut() {
        let at = candidate.meta.get("at").cloned().unwrap_or(Value::Null);
        candidate.score *= decay::decay_factor(now, &at, config.decay_lambda);
    }
    candidates
}

/// 阈值：先衰减再卡阈值。
fn apply_threshold(
    candidates: Vec<Candidate>,
    config: &RetrievalConfig,
    stats: &mut Stats,
) -> Vec<Candidate> {
    candidates
        .into_iter()
        .filter(|candidate| {
            if candidate.score < config.min_score {
                stats.threshold += 1;
                false
            } else {
                true
            }
        })
        .collect()
}

/// 去重：与 bag.dedup_set 预去重 + 候选间同规范化键取最高分。
fn apply_dedup(candidates: Vec<Candidate>, bag: &Value, stats: &mut Stats) -> Vec<Candidate> {
    let set: BTreeSet<String> = bag::dedup_set(bag);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for candidate in candidates {
        let key = dedup::dedup_key(&candidate.text);
        if (!key.is_empty() && set.contains(&key)) || seen.contains(&key) {
            stats.dedup += 1;
            continue;
        }
        seen.insert(key);
        out.push(candidate);
    }
    out
}

/// 候选重排委派 rerank.order（MMR + 可选语义重排）：传候选（key / score / text）与策略，回 key 顺序。
/// 重排服务失败即降级为分数序（不报错、不阻塞召回）。
fn apply_order(
    mut candidates: Vec<Candidate>,
    config: &RetrievalConfig,
    bag: &Value,
    ports: &Ports<'_>,
) -> Vec<Candidate> {
    if candidates.is_empty() {
        return candidates;
    }
    let items: Vec<Value> = candidates
        .iter()
        .map(|candidate| {
            json!({
                "key": candidate.entry_hash,
                "score": candidate.score,
                "text": candidate.text,
            })
        })
        .collect();
    let args = json!({
        "items": items,
        "mmr_lambda": config.mmr_lambda,
        "rerank": config.rerank,
        "model": config.model,
        "model_config": bag::model_config(bag),
    });
    let Ok(value) = ports.rerank.order(args) else {
        sort_by_score(&mut candidates);
        return candidates;
    };
    let order = parse_order(&value);
    if order.is_empty() {
        sort_by_score(&mut candidates);
        return candidates;
    }
    reorder_by_keys(candidates, &order)
}

/// 从 rerank.order 结果取 key 顺序；缺失 / 非数组回空集。
fn parse_order(value: &Value) -> Vec<String> {
    value
        .get("order")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 按 key 顺序重排（entry_hash 唯一）；未出现在顺序里的项按原序追加（确定兜底）。
fn reorder_by_keys(candidates: Vec<Candidate>, order: &[String]) -> Vec<Candidate> {
    let mut positions: BTreeMap<String, usize> = BTreeMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        positions.insert(candidate.entry_hash.clone(), index);
    }
    let mut slots: Vec<Option<Candidate>> = candidates.into_iter().map(Some).collect();
    let mut out = Vec::new();
    for key in order {
        if let Some(index) = positions.get(key).copied() {
            if let Some(candidate) = slots.get_mut(index).and_then(Option::take) {
                out.push(candidate);
            }
        }
    }
    for candidate in slots.into_iter().flatten() {
        out.push(candidate);
    }
    out
}

fn sort_by_score(candidates: &mut [Candidate]) {
    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.entry_hash.cmp(&right.entry_hash))
    });
}

fn candidate_json(candidate: &Candidate) -> Value {
    let mut object = Map::new();
    object.insert("entry_hash".to_string(), json!(candidate.entry_hash));
    object.insert("entry_id".to_string(), json!(candidate.entry_id));
    object.insert("chunk_index".to_string(), json!(candidate.chunk_index));
    object.insert("score".to_string(), json!(candidate.score));
    object.insert("score_raw".to_string(), json!(candidate.score_raw));
    object.insert("text".to_string(), json!(candidate.text));
    object.insert("meta".to_string(), candidate.meta.clone());
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{FakeBuildingMemory, FakeEmbedding, FakeMemory, FakeQueryPlan, FakeRerank};
    use crate::state::MemoryStateStore;

    fn entry(id: &str, text: &str, workspace: Option<&str>, source: &str, at: &str) -> Value {
        let mut meta = json!({"source": source, "at": at});
        if let Some(workspace) = workspace {
            meta["workspace"] = json!(workspace);
        }
        json!({"id": id, "text": text, "meta": meta, "chunks": []})
    }

    fn memory() -> FakeMemory {
        let mut entries = BTreeMap::new();
        entries.insert(
            "e1".to_string(),
            entry(
                "m-1",
                "alpha note",
                Some("w1"),
                "manual",
                "1970-01-01T00:00:00Z",
            ),
        );
        entries.insert(
            "e2".to_string(),
            entry(
                "m-2",
                "beta note",
                Some("w2"),
                "session",
                "2024-01-01T00:00:00Z",
            ),
        );
        let hits = vec![
            json!({"entry_hash": "e2", "chunk_index": 0, "score": 0.9}),
            json!({"entry_hash": "e2", "chunk_index": 1, "score": 0.8}),
            json!({"entry_hash": "e1", "chunk_index": 0, "score": 0.5}),
        ];
        FakeMemory::new(hits, entries)
    }

    fn run_with(bag: &Value, memory: &FakeMemory) -> Value {
        let embedding = FakeEmbedding::new(4);
        let query_plan = FakeQueryPlan;
        let rerank = FakeRerank;
        let ports = Ports {
            embedding: &embedding,
            memory,
            query_plan: &query_plan,
            rerank: &rerank,
        };
        run(bag, &json!({}), &ports, &MemoryStateStore::new()).unwrap()
    }

    fn hashes(value: &Value) -> Vec<String> {
        value["recall"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["entry_hash"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn hits_are_deterministic_and_same_entry_not_duplicated() {
        let bag = json!({
            "query": "note", "workspace": "w1",
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false}
        });
        let first = run_with(&bag, &memory());
        let second = run_with(&bag, &memory());
        assert_eq!(first, second);
        assert_eq!(hashes(&first), vec!["e2", "e1"]);
        assert_eq!(first["recall"][0]["chunk_index"], 0);
    }

    #[test]
    fn empty_library_returns_empty_set() {
        let empty = FakeMemory::new(Vec::new(), BTreeMap::new());
        let bag = json!({"query": "note", "retrieval": {"mmr_lambda": 1.0}});
        let value = run_with(&bag, &empty);
        assert_eq!(value["count"], 0);
        assert!(value["recall"].as_array().unwrap().is_empty());
    }

    #[test]
    fn index_building_is_structured_not_silent_empty() {
        let embedding = FakeEmbedding::new(4);
        let memory = FakeBuildingMemory;
        let query_plan = FakeQueryPlan;
        let rerank = FakeRerank;
        let ports = Ports {
            embedding: &embedding,
            memory: &memory,
            query_plan: &query_plan,
            rerank: &rerank,
        };
        let bag = json!({"query": "note", "memory": {"body": {"count": 0}, "refs": {}}});
        let value = run(&bag, &json!({}), &ports, &MemoryStateStore::new()).unwrap();
        assert_eq!(value["status"], "index_building");
        assert_eq!(value["reason"], "index_building");
        assert_eq!(value["count"], 0);
        assert!(value["recall"].as_array().unwrap().is_empty());
    }

    #[test]
    fn bag_without_memory_slice_still_queries_owner() {
        // L3 切片不再随 bag 传入：bag 无 memory 键时仍应问 memory-store owner 并召回。
        let embedding = FakeEmbedding::new(4);
        let query_plan = FakeQueryPlan;
        let rerank = FakeRerank;
        let memory = memory();
        let ports = Ports {
            embedding: &embedding,
            memory: &memory,
            query_plan: &query_plan,
            rerank: &rerank,
        };
        let value = run(
            &json!({"query": "note", "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false}}),
            &json!({}),
            &ports,
            &MemoryStateStore::new(),
        )
        .unwrap();
        assert_eq!(hashes(&value), vec!["e2", "e1"]);
    }

    #[test]
    fn workspace_scope_defaults_on() {
        let bag = json!({"query": "note", "workspace": "w1", "retrieval": {"mmr_lambda": 1.0}});
        let value = run_with(&bag, &memory());
        assert_eq!(hashes(&value), vec!["e1"]);
        assert_eq!(value["stats"]["scope"], 1);
    }

    #[test]
    fn global_entry_is_kept_under_scope() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "g1".to_string(),
            entry("m-g", "global note", None, "manual", "1970-01-01T00:00:00Z"),
        );
        let hits = vec![json!({"entry_hash": "g1", "chunk_index": 0, "score": 0.7})];
        let memory = FakeMemory::new(hits, entries);
        let bag = json!({"query": "note", "workspace": "w1", "retrieval": {"mmr_lambda": 1.0}});
        let value = run_with(&bag, &memory);
        assert_eq!(hashes(&value), vec!["g1"]);
    }

    #[test]
    fn tag_and_source_filters_apply() {
        let bag = json!({
            "query": "note", "workspace": "w1",
            "retrieval": {"mmr_lambda": 1.0, "source": ["manual"]}
        });
        assert_eq!(hashes(&run_with(&bag, &memory())), vec!["e1"]);
        let bag = json!({
            "query": "note",
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false, "tags": ["nope"]}
        });
        assert_eq!(run_with(&bag, &memory())["count"], 0);
    }

    #[test]
    fn budget_caps_recall_count() {
        let bag = json!({
            "query": "note", "recall_budget": 1,
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false}
        });
        let value = run_with(&bag, &memory());
        assert_eq!(value["count"], 1);
        assert_eq!(hashes(&value), vec!["e2"]);
        assert_eq!(value["budget"], 1);
    }

    #[test]
    fn dedup_set_drops_matching_entry() {
        let bag = json!({
            "query": "note", "workspace": "w1", "dedup_set": ["alpha note"],
            "retrieval": {"mmr_lambda": 1.0}
        });
        let value = run_with(&bag, &memory());
        assert_eq!(value["count"], 0);
        assert_eq!(value["stats"]["dedup"], 1);
    }

    #[test]
    fn threshold_drops_low_scores() {
        let bag = json!({
            "query": "note", "workspace": "w1",
            "retrieval": {"mmr_lambda": 1.0, "min_score": 0.6}
        });
        let value = run_with(&bag, &memory());
        assert_eq!(value["count"], 0);
        assert_eq!(value["stats"]["threshold"], 1);
    }

    #[test]
    fn time_decay_reorders_toward_recent() {
        // e1 分数更高但很旧；λ 使 e2（较新）反超。
        let bag = json!({
            "query": "note", "now": 1_704_067_200_000.0,
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false, "decay_lambda": 0.01}
        });
        let value = run_with(&bag, &memory());
        assert_eq!(hashes(&value), vec!["e2", "e1"]);
    }

    #[test]
    fn no_write_directives_are_produced() {
        let bag = json!({"query": "note", "workspace": "w1"});
        let value = run_with(&bag, &memory());
        assert!(value.get("$directives").is_none());
    }

    #[test]
    fn query_vector_cache_avoids_recompute() {
        let embedding = FakeEmbedding::new(4);
        let memory = memory();
        let query_plan = FakeQueryPlan;
        let rerank = FakeRerank;
        let ports = Ports {
            embedding: &embedding,
            memory: &memory,
            query_plan: &query_plan,
            rerank: &rerank,
        };
        let state = MemoryStateStore::new();
        let bag = json!({"query": "note", "retrieval": {"mmr_lambda": 1.0}});
        let first = run(&bag, &json!({}), &ports, &state).unwrap();
        assert!(state.read(&cache_key("granite-97m", "note")).is_some());
        let second = run(&bag, &json!({}), &ports, &state).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn query_and_goal_are_combined_via_query_plan() {
        // 查询构造已委派 query-plan：goal 拼进基础查询与查询集。
        let bag = json!({
            "query": "note", "goal": "ship it",
            "retrieval": {"mmr_lambda": 1.0, "workspace_scope": false}
        });
        let value = run_with(&bag, &memory());
        assert_eq!(value["query"], "note\nship it");
        assert_eq!(value["queries"], json!(["note\nship it"]));
    }
}
