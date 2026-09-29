// `plan`：查询规划主体（查询构造 → 可选多查询扩展 → 去重封顶）。
// 纯计算 + 反向调用 model.chat；无写通道、不读投影、不取时间。
// 模型项（多查询）默认关，失败即降级为单查询（保确定可回放）。

use serde_json::{json, Value};

use crate::port::{chat_text, Ports};

/// 查询集上限：基础查询 + 至多 3 个子查询。
const MAX_QUERIES: usize = 4;

/// 执行查询规划：入参即 args，`ports` 为反向调用面。
pub fn run(args: &Value, ports: &Ports<'_>) -> Value {
    let query = string_field(args, "query");
    let goal = string_field(args, "goal");
    let combined = combine_query(&query, &goal);

    let mut queries = vec![combined.clone()];
    if !bool_field(args, "multi_query") {
        return result(combined, queries);
    }
    let model_config = args.get("model_config").cloned().unwrap_or(Value::Null);
    if model_config.is_null() {
        return result(combined, queries);
    }
    let Ok(text) = chat_text(ports, &model_config, &subquery_prompt(&combined)) else {
        return result(combined, queries);
    };
    for sub in parse_string_array(&text) {
        if sub.is_empty() || queries.iter().any(|existing| existing == &sub) {
            continue;
        }
        queries.push(sub);
        if queries.len() >= MAX_QUERIES {
            break;
        }
    }
    result(combined, queries)
}

/// 结果形状：基础查询 + 实际查询集。
fn result(query: String, queries: Vec<String>) -> Value {
    json!({ "ok": true, "query": query, "queries": queries })
}

/// 查询构造：顶层 query + L1 goal（避免查询漂移）。
fn combine_query(query: &str, goal: &str) -> String {
    if query.is_empty() {
        return goal.to_string();
    }
    if goal.is_empty() {
        return query.to_string();
    }
    format!("{query}\n{goal}")
}

fn subquery_prompt(query: &str) -> String {
    format!(
        "Generate 2 to 3 alternative search queries (synonyms / related phrasing) for the \
following memory lookup. Reply with a JSON array of strings only.\nQuery: {query}"
    )
}

/// 从模型文本解析字符串数组：先按 JSON 解析，失败按行拆（去项目符号 / 编号）。
fn parse_string_array(text: &str) -> Vec<String> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        if let Some(items) = value.as_array() {
            return items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect();
        }
    }
    text.lines()
        .map(|line| {
            let trimmed = line.trim().trim_start_matches(['-', '*']);
            trimmed
                .trim_start_matches(|c: char| {
                    c.is_ascii_digit() || c == '.' || c == ')' || c == '、'
                })
                .trim()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

fn string_field(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn bool_field(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::FakeModel;

    fn plan_with(args: Value, text: &str) -> Value {
        let model = FakeModel::new(text);
        let ports = Ports { model: &model };
        run(&args, &ports)
    }

    #[test]
    fn combines_query_and_goal() {
        let value = plan_with(json!({"query": "note", "goal": "ship it"}), "[]");
        assert_eq!(value["query"], "note\nship it");
        assert_eq!(value["queries"], json!(["note\nship it"]));
    }

    #[test]
    fn falls_back_to_goal_when_query_empty() {
        let value = plan_with(json!({"query": "", "goal": "g"}), "[]");
        assert_eq!(value["query"], "g");
    }

    #[test]
    fn multi_query_defaults_off() {
        let value = plan_with(json!({"query": "note", "model_config": {}}), "[\"other\"]");
        assert_eq!(value["queries"], json!(["note"]));
    }

    #[test]
    fn multi_query_uses_model_when_enabled() {
        let value = plan_with(
            json!({"query": "note", "model_config": {}, "multi_query": true}),
            "[\"alpha\", \"beta\"]",
        );
        assert_eq!(value["queries"], json!(["note", "alpha", "beta"]));
    }

    #[test]
    fn multi_query_requires_model_config() {
        let value = plan_with(json!({"query": "note", "multi_query": true}), "[\"alpha\"]");
        assert_eq!(value["queries"], json!(["note"]));
    }

    #[test]
    fn multi_query_dedups_and_caps() {
        // 重复项剔除；子查询并入后封顶 4 条（基础查询 + 3）。
        let value = plan_with(
            json!({"query": "note", "model_config": {}, "multi_query": true}),
            "[\"note\", \"a\", \"b\", \"c\", \"d\"]",
        );
        assert_eq!(value["queries"], json!(["note", "a", "b", "c"]));
    }

    #[test]
    fn parse_string_array_is_tolerant() {
        assert_eq!(parse_string_array("[\"a\", \"b\"]"), vec!["a", "b"]);
        assert_eq!(
            parse_string_array("1. alpha\n- beta"),
            vec!["alpha", "beta"]
        );
    }
}
