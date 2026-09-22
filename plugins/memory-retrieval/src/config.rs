// 召回策略配置：从 bag 解析（服务不读投影，配置由调用方入口 term 读出随 bag 传入）。
// 缺省与 schema/retrieval.json 顶层 defaults 一致；非法值按缺省处理（执行件不承担校验，机械兜底）。

use serde_json::{Map, Value};

/// 召回策略配置。
#[derive(Clone, Debug, PartialEq)]
pub struct RetrievalConfig {
    pub top_k: usize,
    pub recall_budget: Option<usize>,
    pub min_score: f64,
    pub decay_lambda: f64,
    pub workspace_scope: bool,
    pub tags: Vec<String>,
    pub source: Vec<String>,
    pub mmr_lambda: f64,
    pub rerank: bool,
    pub multi_query: bool,
    pub model: String,
    pub dim: usize,
}

impl Default for RetrievalConfig {
    fn default() -> Self {
        Self {
            top_k: 8,
            recall_budget: None,
            min_score: 0.0,
            decay_lambda: 0.0,
            workspace_scope: true,
            tags: Vec::new(),
            source: Vec::new(),
            mmr_lambda: 0.7,
            rerank: false,
            multi_query: false,
            model: "granite-97m".to_string(),
            dim: 384,
        }
    }
}

/// 配置来源：优先 `bag.retrieval`，其次 `bag.options`，都没有则全缺省。
pub fn section(bag: &Value) -> Map<String, Value> {
    for key in ["retrieval", "options"] {
        if let Some(object) = bag.get(key).and_then(Value::as_object) {
            return object.clone();
        }
    }
    Map::new()
}

/// 从 bag 解析配置：策略段 + 顶层覆盖（`recall_budget` / `model`）。
pub fn from_bag(bag: &Value) -> RetrievalConfig {
    let mut config = RetrievalConfig::default();
    let section = section(bag);
    if let Some(value) = uint_field(&section, "top_k") {
        config.top_k = value.max(1) as usize;
    }
    config.recall_budget = uint_field(&section, "recall_budget").map(|value| value.max(1) as usize);
    if let Some(value) = float_field(&section, "min_score") {
        config.min_score = value;
    }
    if let Some(value) = float_field(&section, "decay_lambda") {
        config.decay_lambda = value.max(0.0);
    }
    if let Some(value) = bool_field(&section, "workspace_scope") {
        config.workspace_scope = value;
    }
    if let Some(value) = string_list_field(&section, "tags") {
        config.tags = value;
    }
    if let Some(value) = string_list_field(&section, "source") {
        config.source = value;
    }
    if let Some(value) = float_field(&section, "mmr_lambda") {
        config.mmr_lambda = value.clamp(0.0, 1.0);
    }
    if let Some(value) = bool_field(&section, "rerank") {
        config.rerank = value;
    }
    if let Some(value) = bool_field(&section, "multi_query") {
        config.multi_query = value;
    }
    if let Some(value) = section.get("model").and_then(Value::as_str) {
        if !value.is_empty() {
            config.model = value.to_string();
        }
    }
    if let Some(value) = uint_field(&section, "dim") {
        config.dim = value.max(1) as usize;
    }

    // 顶层覆盖：预算由 loop-policy 按 thresholds 写入 bag.recall_budget。
    if let Some(value) = bag.get("recall_budget").and_then(Value::as_u64) {
        config.recall_budget = Some(value.max(1) as usize);
    }
    if let Some(value) = bag.get("model").and_then(Value::as_str) {
        if !value.is_empty() {
            config.model = value.to_string();
        }
    }
    config
}

/// 最终注入条数上限 = min(top_k, 预算)；预算缺省即 top_k。
pub fn effective_limit(config: &RetrievalConfig) -> usize {
    let budget = config.recall_budget.unwrap_or(config.top_k);
    config.top_k.min(budget).max(1)
}

/// 每查询取回条数：留出跨查询归并余量，封顶 200。
pub fn per_query_top_k(config: &RetrievalConfig, query_count: usize) -> usize {
    let limit = effective_limit(config);
    let queries = query_count.max(1);
    (limit.saturating_mul(queries)).clamp(1, 200)
}

fn uint_field(object: &Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(Value::as_u64)
}

fn float_field(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn bool_field(object: &Map<String, Value>, key: &str) -> Option<bool> {
    object.get(key).and_then(Value::as_bool)
}

fn string_list_field(object: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    let array = object.get(key)?.as_array()?;
    Some(
        array
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_schema() {
        let config = from_bag(&json!({}));
        assert_eq!(config, RetrievalConfig::default());
        assert_eq!(config.top_k, 8);
        assert!(config.workspace_scope);
        assert!(!config.multi_query && !config.rerank);
    }

    #[test]
    fn reads_retrieval_section() {
        let config = from_bag(&json!({
            "retrieval": {
                "top_k": 3, "min_score": 0.4, "decay_lambda": 0.001,
                "workspace_scope": false, "tags": ["a"], "source": ["manual"],
                "mmr_lambda": 1.0, "rerank": true, "multi_query": true, "dim": 4
            }
        }));
        assert_eq!(config.top_k, 3);
        assert_eq!(config.min_score, 0.4);
        assert_eq!(config.tags, vec!["a"]);
        assert_eq!(config.source, vec!["manual"]);
        assert!(config.rerank && config.multi_query);
        assert_eq!(config.dim, 4);
    }

    #[test]
    fn top_level_budget_overrides_section() {
        let config = from_bag(&json!({"retrieval": {"recall_budget": 9}, "recall_budget": 2}));
        assert_eq!(config.recall_budget, Some(2));
        assert_eq!(effective_limit(&config), 2);
    }

    #[test]
    fn per_query_scales_with_query_count() {
        let config = RetrievalConfig {
            top_k: 5,
            recall_budget: Some(3),
            ..Default::default()
        };
        assert_eq!(per_query_top_k(&config, 1), 3);
        assert_eq!(per_query_top_k(&config, 2), 6);
        assert_eq!(per_query_top_k(&config, 100), 200);
    }
}
