// granite-97m 推理引擎：`model_quint8_avx2.onnx` 经 `include_bytes!` 内嵌进二进制
// （构建期输入由宿主 `assets_manifest` 直拷提供）。ModernBERT + CLS pooling + L2 归一。
// 确定性：单线程执行（intra / inter threads = 1），同输入同输出。
// 分词不在此内嵌：经反向 `port.call tokenizer.encode` 取 token ids / mask（`TokenizerPort`）。

use std::sync::{Mutex, OnceLock};

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

/// 模型 id（与 schema 清单一致；向量随 id / dim 变）。
pub const MODEL_ID: &str = "granite-97m";
/// 向量维度。
pub const DIM: usize = 384;
/// 单条文本参与推理的最大 token 数（服务侧内存护栏）。
/// 模型 max_seq 是 32768，但 ModernBERT 的全局注意力按 O(seq²) 分配：32768 token 需 ≈51 GB。
/// 默认窗口仅 ~512 token，故单次推理截断到本上限；超长文本应由调用方先 `tokenizer.chunk` 再逐块 `embed`。
const EMBED_MAX_TOKENS: usize = 2048;

/// granite-97m 权重（≈98 MB，不进世界）。
static MODEL_BYTES: &[u8] = include_bytes!("../granite-97m/model_quint8_avx2.onnx");

/// 引擎加载 / 推理错误：`code` 走协议 `error.code`，`message` 给人读。
#[derive(Clone, Debug)]
pub struct ModelError {
    pub code: String,
    pub message: String,
}

impl ModelError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    fn load(message: impl Into<String>) -> Self {
        Self::new("model_load_failed", message)
    }
}

/// 分词结果：ids / mask 与文本 token 一一对应（`tokenizer.encode` 的对外形状）。
#[derive(Clone, Debug)]
pub struct Encoded {
    pub ids: Vec<i64>,
    pub mask: Vec<i64>,
}

/// 分词端口：生产为反向 `port.call tokenizer.encode`；单测注入本地实现。
pub trait TokenizerPort: Send + Sync {
    fn encode(&self, text: &str, add_special_tokens: bool) -> Result<Encoded, ModelError>;
}

/// 推理引擎：ONNX 会话由互斥锁串行化（保确定、防并发争用）。
pub struct Engine {
    session: Mutex<Session>,
}

/// 进程内唯一引擎；加载失败的错误被缓存（不反复尝试 98 MB 模型）。
static ENGINE: OnceLock<Result<Engine, ModelError>> = OnceLock::new();

/// 取共享引擎；首次访问时加载模型。
pub fn engine() -> Result<&'static Engine, ModelError> {
    match ENGINE.get_or_init(Engine::load) {
        Ok(engine) => Ok(engine),
        Err(error) => Err(error.clone()),
    }
}

/// 预加载：在服务握手后后台执行，避免首个 `embed` 调用承担加载延迟。
pub fn preload() {
    let _ = engine();
}

impl Engine {
    fn load() -> Result<Engine, ModelError> {
        let session = Session::builder()
            .map_err(|err| ModelError::load(format!("session builder: {err}")))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|err| ModelError::load(format!("optimization level: {err}")))?
            .with_intra_threads(1)
            .map_err(|err| ModelError::load(format!("intra threads: {err}")))?
            .with_inter_threads(1)
            .map_err(|err| ModelError::load(format!("inter threads: {err}")))?
            .commit_from_memory(MODEL_BYTES)
            .map_err(|err| ModelError::load(format!("commit model: {err}")))?;
        Ok(Engine {
            session: Mutex::new(session),
        })
    }

    /// 批量文本 -> 384 维 L2 归一向量（与输入一一对应、顺序保持）。
    /// 逐条推理（不 padding）：结果只取决于文本自身，与批次组成无关 ⇒ 索引可重算一致。
    pub fn embed(
        &self,
        texts: &[String],
        tokenizer: &dyn TokenizerPort,
    ) -> Result<Vec<Vec<f32>>, ModelError> {
        let mut vectors = Vec::with_capacity(texts.len());
        for text in texts {
            vectors.push(self.embed_single(text, tokenizer)?);
        }
        Ok(vectors)
    }

    fn embed_single(&self, text: &str, tokenizer: &dyn TokenizerPort) -> Result<Vec<f32>, ModelError> {
        let encoded = tokenizer.encode(text, true)?;
        let sequence = encoded
            .ids
            .len()
            .min(encoded.mask.len())
            .min(EMBED_MAX_TOKENS);
        if sequence == 0 {
            return Err(ModelError::new("inference_failed", "empty token sequence"));
        }
        let ids: Vec<i64> = encoded.ids[..sequence].to_vec();
        let mask: Vec<i64> = encoded.mask[..sequence].to_vec();
        let ids_tensor = Tensor::from_array(([1usize, sequence], ids))
            .map_err(|err| ModelError::new("inference_failed", format!("ids tensor: {err}")))?;
        let mask_tensor = Tensor::from_array(([1usize, sequence], mask))
            .map_err(|err| ModelError::new("inference_failed", format!("mask tensor: {err}")))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| ModelError::new("inference_failed", "session poisoned"))?;
        let outputs = session
            .run(ort::inputs!["input_ids" => ids_tensor, "attention_mask" => mask_tensor])
            .map_err(|err| ModelError::new("inference_failed", err.to_string()))?;
        let hidden = &outputs["last_hidden_state"];
        let (shape, data) = hidden
            .try_extract_tensor::<f32>()
            .map_err(|err| ModelError::new("inference_failed", err.to_string()))?;
        let dims: Vec<i64> = shape.iter().copied().collect();
        if dims.len() != 3 || dims[0] != 1 || dims[2] as usize != DIM {
            return Err(ModelError::new(
                "inference_failed",
                format!("unexpected output shape {dims:?}"),
            ));
        }
        // CLS pooling：取首 token（后处理固定加 <|startoftext|> 于首位）。
        let mut vector = data[..DIM].to_vec();
        l2_normalize(&mut vector);
        Ok(vector)
    }
}

/// L2 归一：零向量保持零（不产生 NaN）。
fn l2_normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in vector.iter_mut() {
            *value /= norm;
        }
    }
}

/// 余弦相似度（两向量已 L2 归一 ⇒ 点积）。
#[cfg(test)]
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
pub use tests::test_tokenizer;

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用分词端口：运行时从兄弟 `tokenizer` 插件资产读入真实分词器
    /// （生产二进制不内嵌 `tokenizer.json`；仅测试期读取）。
    pub struct TestTokenizer {
        inner: tokenizers::Tokenizer,
    }

    impl TestTokenizer {
        fn load() -> Self {
            const PATH: &str =
                concat!(env!("CARGO_MANIFEST_DIR"), "/../tokenizer/granite-97m/tokenizer.json");
            let bytes = std::fs::read(PATH)
                .unwrap_or_else(|err| panic!("需要兄弟 tokenizer 插件资产 {PATH}: {err}"));
            let inner = tokenizers::Tokenizer::from_bytes(bytes)
                .expect("tokenizer.json 应能解析");
            Self { inner }
        }
    }

    impl TokenizerPort for TestTokenizer {
        fn encode(&self, text: &str, add_special_tokens: bool) -> Result<Encoded, ModelError> {
            let encoding = self
                .inner
                .encode(text, add_special_tokens)
                .map_err(|err| ModelError::new("tokenize_failed", err.to_string()))?;
            Ok(Encoded {
                ids: encoding.get_ids().iter().map(|id| *id as i64).collect(),
                mask: encoding
                    .get_attention_mask()
                    .iter()
                    .map(|mask| *mask as i64)
                    .collect(),
            })
        }
    }

    /// 进程内共享测试分词器：避免每个用例重复解析 25 MB。
    pub fn test_tokenizer() -> &'static TestTokenizer {
        static SHARED: OnceLock<TestTokenizer> = OnceLock::new();
        SHARED.get_or_init(TestTokenizer::load)
    }

    fn embed_one(text: &str) -> Vec<f32> {
        let engine = engine().expect("引擎应能加载");
        engine
            .embed(&[text.to_string()], test_tokenizer())
            .unwrap()
            .remove(0)
    }

    fn norm(vector: &[f32]) -> f32 {
        vector.iter().map(|value| value * value).sum::<f32>().sqrt()
    }

    #[test]
    fn dim_is_384_and_l2_normalized() {
        let vector = embed_one("Chrono 本地向量化测试。");
        assert_eq!(vector.len(), DIM);
        assert!((norm(&vector) - 1.0).abs() < 1e-3, "L2 范数应约为 1");
        assert!(vector.iter().all(|value| value.is_finite()));
    }

    #[test]
    fn same_text_same_vector() {
        let first = embed_one("确定性：同文本同向量。");
        let second = embed_one("确定性：同文本同向量。");
        assert_eq!(first, second, "同文本两次应得逐位相同的向量");
    }

    #[test]
    fn batch_matches_single() {
        let engine = engine().unwrap();
        let texts = vec!["first sentence".to_string(), "第二句话".to_string()];
        let batch = engine.embed(&texts, test_tokenizer()).unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0], embed_one(&texts[0]));
        assert_eq!(batch[1], embed_one(&texts[1]));
    }

    #[test]
    fn empty_text_is_embeddable() {
        let vector = embed_one("");
        assert_eq!(vector.len(), DIM);
        assert!((norm(&vector) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn long_text_is_truncated_not_failed() {
        let text = "长文本截断测试。".repeat(8000);
        let vector = embed_one(&text);
        assert_eq!(vector.len(), DIM);
    }

    #[test]
    fn similarity_related_beats_unrelated() {
        let query = embed_one("The weather outside is lovely today.");
        let related = embed_one("It is so sunny and nice outside.");
        let unrelated = embed_one("Quantum computing relies on qubits and superposition.");
        let related_score = cosine(&query, &related);
        let unrelated_score = cosine(&query, &unrelated);
        println!("[sim-en] related={related_score:.4} unrelated={unrelated_score:.4}");
        assert!(
            related_score > unrelated_score + 0.05,
            "相关文本相似度应明显高于无关文本（related={related_score}, unrelated={unrelated_score}）"
        );
        assert!(
            related_score > 0.4,
            "相关文本相似度应足够高：{related_score}"
        );
    }

    #[test]
    fn chinese_similarity_related_beats_unrelated() {
        let query = embed_one("把文本转换成向量，用于长期记忆的语义检索。");
        let related = embed_one("本地向量化服务会为文本生成归一化向量，供检索使用。");
        let unrelated = embed_one("今天晚上应该吃什么晚饭比较好呢？");
        let related_score = cosine(&query, &related);
        let unrelated_score = cosine(&query, &unrelated);
        println!("[sim-zh] related={related_score:.4} unrelated={unrelated_score:.4}");
        assert!(
            related_score > unrelated_score + 0.05,
            "中文相关文本相似度应明显高于无关文本（related={related_score}, unrelated={unrelated_score}）"
        );
        assert!(
            related_score > 0.4,
            "中文文本相似度应足够高：{related_score}"
        );
    }
}
