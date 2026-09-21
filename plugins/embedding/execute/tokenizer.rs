// 分词器：`tokenizer.json` 经 `include_bytes!` 内嵌进二进制（构建期输入由宿主 `assets_manifest` 直拷提供）。
// 单一实现、进程内共享：`embed` 与 `chunk` 用同一份分词器，token 计数与窗口边界一致。

use std::sync::OnceLock;

use tokenizers::Tokenizer;

/// granite-97m 的分词器（≈25 MB，不进世界）。
static TOKENIZER_BYTES: &[u8] = include_bytes!("../granite-97m/tokenizer.json");

/// 进程内唯一分词器实例；首次访问时解析，之后共享。
static SHARED: OnceLock<Result<Tokenizer, String>> = OnceLock::new();

/// 取共享分词器；解析失败的错误被缓存（同一次进程内不重复解析 25 MB）。
pub fn shared() -> Result<&'static Tokenizer, String> {
    match SHARED.get_or_init(parse) {
        Ok(tokenizer) => Ok(tokenizer),
        Err(message) => Err(message.clone()),
    }
}

fn parse() -> Result<Tokenizer, String> {
    Tokenizer::from_bytes(TOKENIZER_BYTES).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_and_counts_tokens() {
        let tokenizer = shared().expect("tokenizer 应能加载");
        let encoding = tokenizer.encode("你好，world", true).expect("编码应成功");
        // 后处理固定加 <|startoftext|>(CLS) 与 <|return|>(EOS)。
        assert_eq!(encoding.get_ids()[0], 179934);
        assert_eq!(*encoding.get_ids().last().unwrap(), 179938);
        assert!(encoding.len() > 2);
    }

    #[test]
    fn token_count_is_deterministic() {
        let tokenizer = shared().unwrap();
        let text = "Chrono 是一个插件化 agent 运行时。";
        let first = tokenizer.encode(text, false).unwrap();
        let second = tokenizer.encode(text, false).unwrap();
        assert_eq!(first.get_ids(), second.get_ids());
        assert_eq!(first.get_offsets(), second.get_offsets());
    }
}
