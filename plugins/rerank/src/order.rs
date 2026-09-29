// `order`：候选重排主体（MMR 多样性排序 → 可选 listwise 语义重排），回 key 顺序。
// 纯计算 + 反向调用 embedding.embed / model.chat；无写通道、不读投影、不取时间。
// 语义重排（模型项）默认关，失败 / 解析不出即保留原序；MMR 向量化失败即降级为分数序（保确定可回放）。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::port::{chat_text, Ports};
use crate::vector::{self, MmrItem};

/// 一条候选：逻辑 key + 相关度分数 + 用于向量化 / 提示词截断的文本。
#[derive(Clone, Debug)]
pub struct OrderItem {
    pub key: String,
    pub score: f64,
    pub text: String,
}

/// 执行候选重排：入参即 args，`ports` 为反向调用面。
pub fn run(args: &Value, ports: &Ports<'_>) -> Value {
    let items = parse_items(args);
    let mmr_lambda = float_field(args, "mmr_lambda").unwrap_or(0.7).clamp(0.0, 1.0);
    let rerank = args.get("rerank").and_then(Value::as_bool).unwrap_or(false);
    let model = {
        let value = string_field(args, "model");
        if value.is_empty() {
            "granite-97m".to_string()
        } else {
            value
        }
    };
    let model_config = args.get("model_config").cloned().unwrap_or(Value::Null);

    let ordered = order_items(items, mmr_lambda, ports, &model);
    let ordered = apply_rerank(ordered, rerank, &model_config, ports);
    let order: Vec<Value> = ordered.iter().map(|item| json!(item.key)).collect();
    json!({ "ok": true, "order": order })
}

/// 排序：MMR（多样性）为主；MMR 需要候选向量，向量化失败即降级为分数序。
fn order_items(
    mut items: Vec<OrderItem>,
    lambda: f64,
    ports: &Ports<'_>,
    model: &str,
) -> Vec<OrderItem> {
    if items.len() <= 1 || lambda >= 1.0 {
        sort_by_score(&mut items);
        return items;
    }
    let texts: Vec<String> = items.iter().map(|item| item.text.clone()).collect();
    let Ok(vectors) = ports.embedding.embed(&texts, model) else {
        sort_by_score(&mut items);
        return items;
    };
    if vectors.len() != items.len() {
        sort_by_score(&mut items);
        return items;
    }
    let mmr_items: Vec<MmrItem> = items
        .iter()
        .zip(vectors)
        .map(|(item, vector)| MmrItem {
            key: item.key.clone(),
            relevance: item.score,
            vector,
        })
        .collect();
    let order = vector::mmr_order(&mmr_items, lambda);
    reorder_by_keys(items, &order)
}

fn sort_by_score(items: &mut [OrderItem]) {
    items.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.key.cmp(&right.key))
    });
}

/// 按 key 顺序重排（key 唯一）；未出现在顺序里的项按原序追加（确定兜底）。
fn reorder_by_keys(items: Vec<OrderItem>, order: &[String]) -> Vec<OrderItem> {
    let mut positions: BTreeMap<String, usize> = BTreeMap::new();
    for (index, item) in items.iter().enumerate() {
        positions.insert(item.key.clone(), index);
    }
    let mut slots: Vec<Option<OrderItem>> = items.into_iter().map(Some).collect();
    let mut out = Vec::new();
    for key in order {
        if let Some(index) = positions.get(key).copied() {
            if let Some(item) = slots.get_mut(index).and_then(Option::take) {
                out.push(item);
            }
        }
    }
    for item in slots.into_iter().flatten() {
        out.push(item);
    }
    out
}

/// 语义重排（开关，默认关）：eff model.chat listwise 重排；失败 / 解析不出即保留原序。
fn apply_rerank(
    items: Vec<OrderItem>,
    rerank: bool,
    model_config: &Value,
    ports: &Ports<'_>,
) -> Vec<OrderItem> {
    if !rerank || items.len() <= 1 || model_config.is_null() {
        return items;
    }
    let Ok(text) = chat_text(ports, model_config, &rerank_prompt(&items)) else {
        return items;
    };
    let order = parse_index_order(&text, items.len());
    if order.is_empty() {
        return items;
    }
    reorder_by_indices(items, &order)
}

fn rerank_prompt(items: &[OrderItem]) -> String {
    let mut lines = String::from(
        "Reorder the candidate memories by relevance to the query, most relevant first. \
Reply with a JSON array of zero-based indices only.\nCandidates:\n",
    );
    for (index, item) in items.iter().enumerate() {
        let snippet: String = item.text.chars().take(160).collect();
        lines.push_str(&format!("{index}. {snippet}\n"));
    }
    lines
}

/// 解析模型文本里的重排索引：先按 JSON 数组，失败按非数字分隔扫描；越界 / 重复剔除。
fn parse_index_order(text: &str, count: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let push = |index: usize, out: &mut Vec<usize>| {
        if index < count && !out.contains(&index) {
            out.push(index);
        }
    };
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        if let Some(items) = value.as_array() {
            for item in items {
                if let Some(index) = item.as_u64() {
                    push(index as usize, &mut out);
                }
            }
            return out;
        }
    }
    for token in text.split(|c: char| !c.is_ascii_digit()) {
        if token.is_empty() {
            continue;
        }
        if let Ok(index) = token.parse::<usize>() {
            push(index, &mut out);
        }
    }
    out
}

/// 按索引顺序重排；未提及的下标按原序追加（确定兜底）。
fn reorder_by_indices(items: Vec<OrderItem>, order: &[usize]) -> Vec<OrderItem> {
    let mut slots: Vec<Option<OrderItem>> = items.into_iter().map(Some).collect();
    let mut out = Vec::new();
    for &index in order {
        if let Some(item) = slots.get_mut(index).and_then(Option::take) {
            out.push(item);
        }
    }
    for item in slots.into_iter().flatten() {
        out.push(item);
    }
    out
}

fn parse_items(args: &Value) -> Vec<OrderItem> {
    args.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(OrderItem {
                        key: item.get("key")?.as_str()?.to_string(),
                        score: item.get("score")?.as_f64()?,
                        text: item
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn string_field(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn float_field(args: &Value, key: &str) -> Option<f64> {
    args.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{FakeEmbedding, FakeModel};

    fn item(key: &str, score: f64, text: &str) -> Value {
        json!({ "key": key, "score": score, "text": text })
    }

    fn order_with(args: Value, model_text: &str, dim: usize) -> Value {
        let embedding = FakeEmbedding::new(dim);
        let model = FakeModel::new(model_text);
        let ports = Ports {
            embedding: &embedding,
            model: &model,
        };
        run(&args, &ports)
    }

    fn keys(value: &Value) -> Vec<String> {
        value["order"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn pure_relevance_sorts_by_score_then_key() {
        let value = order_with(
            json!({"items": [item("b", 0.5, "x"), item("a", 0.9, "y"), item("c", 0.5, "z")], "mmr_lambda": 1.0}),
            "[]",
            4,
        );
        assert_eq!(keys(&value), vec!["a", "b", "c"]);
    }

    #[test]
    fn mmr_uses_vectors_and_is_deterministic() {
        // a 与 b 向量相同（近重复）；c 独立。lambda=0 → 纯多样性。
        let args = json!({
            "items": [item("a", 0.9, "same"), item("b", 0.89, "same"), item("c", 0.8, "other")],
            "mmr_lambda": 0.0,
        });
        let embedding = FakeEmbedding::with_vectors(
            2,
            vec![
                ("same".to_string(), vec![1.0, 0.0]),
                ("other".to_string(), vec![0.0, 1.0]),
            ],
        );
        let model = FakeModel::new("[]");
        let ports = Ports {
            embedding: &embedding,
            model: &model,
        };
        let value = run(&args, &ports);
        assert_eq!(keys(&value), vec!["a", "c", "b"]);
    }

    #[test]
    fn semantic_rerank_reorders_by_model_indices() {
        let value = order_with(
            json!({
                "items": [item("a", 0.9, "x"), item("b", 0.5, "y")],
                "mmr_lambda": 1.0,
                "rerank": true,
                "model_config": {},
            }),
            "[1, 0]",
            4,
        );
        assert_eq!(keys(&value), vec!["b", "a"]);
    }

    #[test]
    fn semantic_rerank_defaults_off() {
        let value = order_with(
            json!({
                "items": [item("a", 0.9, "x"), item("b", 0.5, "y")],
                "mmr_lambda": 1.0,
                "model_config": {},
            }),
            "[1, 0]",
            4,
        );
        assert_eq!(keys(&value), vec!["a", "b"]);
    }

    #[test]
    fn single_item_and_empty_are_stable() {
        assert_eq!(keys(&order_with(json!({"items": []}), "[]", 4)), Vec::<String>::new());
        assert_eq!(
            keys(&order_with(json!({"items": [item("a", 0.1, "x")]}), "[]", 4)),
            vec!["a"]
        );
    }

    #[test]
    fn parse_index_order_is_tolerant() {
        assert_eq!(parse_index_order("[2, 0, 5]", 3), vec![2, 0]);
        assert_eq!(parse_index_order("2, 0, 0", 3), vec![2, 0]);
    }
}
