// 扩展点选择器：读宿主注入的 `embedding-provider` 成员表（身份名，码元序），
// 按请求 `model` 经各成员 `describe-models`（结果按进程缓存）选出提供方，带 `provider` 反向调用其 `embed`。
// 选择规则（确定性）：
//   1. 请求指定 model：恰好一个成员声明该 model → 选它；0 个 → `unknown_model`；
//      多个 → `ambiguous_model`（按成员码元序列出候选）。
//   2. 未指定 model（字典序首命中）：成员按码元序，取首个声明了模型的成员的首个模型。
//   3. 某成员 `describe-models` 失败（未就绪 / 出错）只跳过该成员，不阻断选择。
// 加减提供方 = 世界成员表变化 → 宿主重启并重注入 → 本选择器代码零改动。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use plugin_sdk::PortLink;

/// 扩展类名（拥有方 `embedding` 声明契约）。
pub const CAPABILITY: &str = "embedding-provider";

/// 提供方声明的一个模型：`describe-models` 项。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    pub model: String,
    pub dim: u64,
}

/// 一次选择的产物：目标提供方身份名 + 其声明里解析出的模型 id。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selected {
    pub provider: String,
    pub model: String,
}

/// 选择 / 调用错误：`code` 走协议 `error.code`，`message` 给人读。
#[derive(Clone, Debug)]
pub struct SelectorError {
    pub code: String,
    pub message: String,
}

impl SelectorError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// 选择器：成员表 + `describe-models` 结果缓存（进程内；成员变化由宿主重启重注入承担）。
pub struct Selector {
    link: Arc<PortLink>,
    members: Vec<String>,
    describes: Mutex<HashMap<String, Vec<ModelInfo>>>,
}

impl Selector {
    pub fn new(link: Arc<PortLink>, members: Vec<String>) -> Self {
        Self {
            link,
            members,
            describes: Mutex::new(HashMap::new()),
        }
    }

    /// 按请求 model 选提供方。返回目标提供方与其模型 id。
    pub fn resolve(&self, requested: Option<&str>) -> Result<Selected, SelectorError> {
        let described = self.described_members();
        match requested {
            Some(model) => {
                let mut hits: Vec<(String, ModelInfo)> = Vec::new();
                for (provider, models) in &described {
                    for info in models {
                        if info.model == model {
                            hits.push((provider.clone(), info.clone()));
                        }
                    }
                }
                match hits.len() {
                    0 => Err(SelectorError::new(
                        "unknown_model",
                        format!("no embedding provider declares model {model}"),
                    )),
                    1 => Ok(Selected {
                        provider: hits[0].0.clone(),
                        model: hits[0].1.model.clone(),
                    }),
                    _ => {
                        let providers: Vec<String> =
                            hits.iter().map(|(provider, _)| provider.clone()).collect();
                        Err(SelectorError::new(
                            "ambiguous_model",
                            format!(
                                "model {model} declared by multiple providers: {}",
                                providers.join(", ")
                            ),
                        ))
                    }
                }
            }
            None => {
                // 字典序首命中：成员按码元序，取首个声明了模型的成员的首个模型。
                for (provider, models) in &described {
                    if let Some(first) = models.first() {
                        return Ok(Selected {
                            provider: provider.clone(),
                            model: first.model.clone(),
                        });
                    }
                }
                Err(SelectorError::new(
                    "unknown_model",
                    "no embedding provider declares any model",
                ))
            }
        }
    }

    /// 带 `provider` 反向调用选中成员的 `embed`，原样返回 `{model, dim, vectors}`（轻校验形状）。
    pub fn embed(&self, selected: &Selected, texts: &[String]) -> Result<Value, SelectorError> {
        let value = self
            .link
            .call_with_provider(
                CAPABILITY,
                "embed",
                json!({ "texts": texts, "model": selected.model }),
                &selected.provider,
            )
            .map_err(|error| SelectorError::new(&error.code, error.message))?;
        validate_embed_result(&value)?;
        Ok(value)
    }

    /// 逐成员取 `describe-models`（命中缓存则复用；失败只跳过该成员），按成员码元序返回。
    fn described_members(&self) -> Vec<(String, Vec<ModelInfo>)> {
        let mut out = Vec::with_capacity(self.members.len());
        for member in &self.members {
            if let Some(cached) = self.cached(member) {
                out.push((member.clone(), cached));
                continue;
            }
            match self.describe_member(member) {
                Ok(models) => {
                    self.cache(member, &models);
                    out.push((member.clone(), models));
                }
                Err(error) => {
                    plugin_sdk::log(
                        "embedding",
                        &format!("describe-models {member} failed: {} {}", error.code, error.message),
                    );
                }
            }
        }
        out
    }

    fn cached(&self, member: &str) -> Option<Vec<ModelInfo>> {
        self.describes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(member)
            .cloned()
    }

    fn cache(&self, member: &str, models: &[ModelInfo]) {
        self.describes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(member.to_string(), models.to_vec());
    }

    fn describe_member(&self, member: &str) -> Result<Vec<ModelInfo>, SelectorError> {
        let value = self
            .link
            .call_with_provider(CAPABILITY, "describe-models", json!({}), member)
            .map_err(|error| SelectorError::new(&error.code, error.message))?;
        parse_models(&value)
    }
}

/// 解析 `describe-models` 结果：接受 `{models:[…]}` 或裸数组；逐项取 `{model, dim}`，坏项跳过。
pub fn parse_models(value: &Value) -> Result<Vec<ModelInfo>, SelectorError> {
    let raw = if let Some(array) = value.as_array() {
        array
    } else {
        value
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                SelectorError::new(
                    "provider_bad_result",
                    "describe-models returned no models array",
                )
            })?
    };
    let mut models = Vec::with_capacity(raw.len());
    for item in raw {
        let model = item.get("model").and_then(Value::as_str);
        let dim = item.get("dim").and_then(Value::as_u64);
        if let (Some(model), Some(dim)) = (model, dim) {
            if dim > 0 {
                models.push(ModelInfo {
                    model: model.to_string(),
                    dim,
                });
            }
        }
    }
    Ok(models)
}

/// 轻校验 `embed` 结果形状：`{model, dim>0, vectors:[…]}`；形状不合作数据错误。
fn validate_embed_result(value: &Value) -> Result<(), SelectorError> {
    let model = value.get("model").and_then(Value::as_str);
    let dim = value.get("dim").and_then(Value::as_u64);
    let vectors = value.get("vectors").and_then(Value::as_array);
    if model.is_none() || dim.is_none() || vectors.is_none() {
        return Err(SelectorError::new(
            "provider_bad_result",
            "embed returned no {model, dim, vectors}",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_models_reads_object_and_bare_array() {
        let wrapped = parse_models(&json!({"models":[{"model":"a","dim":8}]})).unwrap();
        assert_eq!(wrapped, vec![ModelInfo { model: "a".into(), dim: 8 }]);
        let bare = parse_models(&json!([{"model":"b","dim":4}])).unwrap();
        assert_eq!(bare, vec![ModelInfo { model: "b".into(), dim: 4 }]);
    }

    #[test]
    fn parse_models_skips_bad_items_and_rejects_wrong_shape() {
        let mixed = parse_models(&json!({"models":[{"model":"a"},{"model":"b","dim":0},{"model":"c","dim":2}]})).unwrap();
        assert_eq!(mixed, vec![ModelInfo { model: "c".into(), dim: 2 }]);
        assert_eq!(
            parse_models(&json!({})).unwrap_err().code,
            "provider_bad_result"
        );
    }

    #[test]
    fn validate_embed_result_rejects_missing_fields() {
        assert!(validate_embed_result(&json!({"model":"a","dim":4,"vectors":[]})).is_ok());
        assert_eq!(
            validate_embed_result(&json!({"dim":4})).unwrap_err().code,
            "provider_bad_result"
        );
    }

    fn selector_with(members: Vec<&str>) -> Selector {
        let link = Arc::new(PortLink::with_timeout(
            plugin_sdk::shared_writer(std::io::sink()),
            "embedding",
            std::time::Duration::from_millis(1),
        ));
        Selector::new(link, members.into_iter().map(str::to_string).collect())
    }

    #[test]
    fn resolve_by_requested_model_is_exact() {
        let selector = selector_with(vec!["embedding-fixture", "embedding-local"]);
        selector.cache("embedding-fixture", &[ModelInfo { model: "x".into(), dim: 8 }]);
        selector.cache(
            "embedding-local",
            &[ModelInfo { model: "granite-97m".into(), dim: 384 }],
        );
        assert_eq!(
            selector.resolve(Some("x")).unwrap(),
            Selected { provider: "embedding-fixture".into(), model: "x".into() }
        );
        assert_eq!(
            selector.resolve(Some("granite-97m")).unwrap(),
            Selected { provider: "embedding-local".into(), model: "granite-97m".into() }
        );
        assert_eq!(selector.resolve(Some("nope")).unwrap_err().code, "unknown_model");
    }

    #[test]
    fn no_model_picks_lexicographically_first_member() {
        let selector = selector_with(vec!["embedding-fixture", "embedding-local"]);
        selector.cache("embedding-fixture", &[ModelInfo { model: "x".into(), dim: 8 }]);
        selector.cache(
            "embedding-local",
            &[ModelInfo { model: "granite-97m".into(), dim: 384 }],
        );
        assert_eq!(
            selector.resolve(None).unwrap(),
            Selected { provider: "embedding-fixture".into(), model: "x".into() }
        );
    }

    #[test]
    fn duplicate_model_across_members_is_ambiguous() {
        let selector = selector_with(vec!["embedding-a", "embedding-b"]);
        selector.cache("embedding-a", &[ModelInfo { model: "x".into(), dim: 8 }]);
        selector.cache("embedding-b", &[ModelInfo { model: "x".into(), dim: 8 }]);
        let error = selector.resolve(Some("x")).unwrap_err();
        assert_eq!(error.code, "ambiguous_model");
        assert!(error.message.contains("embedding-a"));
        assert!(error.message.contains("embedding-b"));
    }

    #[test]
    fn no_models_at_all_is_unknown_model() {
        let selector = selector_with(vec![]);
        assert_eq!(selector.resolve(None).unwrap_err().code, "unknown_model");
    }
}
