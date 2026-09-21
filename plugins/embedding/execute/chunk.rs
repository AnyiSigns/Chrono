// 窗口切块：按 `tokenizer.json` 的真实 token 计数决定窗口边界，输出的 `start` / `end`
// 一律是 **Unicode 码点偏移**（token 只用于决定边界，不外泄为偏移单位）。
// 切块确定（同文本同块集），保证索引可重算一致。

use serde_json::{json, Value};
use tokenizers::Tokenizer;

/// 默认窗口（token）。
pub const DEFAULT_WINDOW: usize = 512;
/// 默认重叠（token）。
pub const DEFAULT_OVERLAP: usize = 64;

/// 切块参数：`window` / `overlap` 按 token 计，`0 <= overlap < window`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkOptions {
    pub window: usize,
    pub overlap: usize,
}

/// 解析 `chunk` 入参里的 `window` / `overlap`；缺省取默认值，非法即 `bad_args`。
pub fn parse_options(args: &Value) -> Result<ChunkOptions, (String, String)> {
    let window = parse_count(args.get("window"), DEFAULT_WINDOW, "window")?;
    let overlap = parse_count(args.get("overlap"), DEFAULT_OVERLAP, "overlap")?;
    if window == 0 {
        return Err(("bad_args".to_string(), "window must be >= 1".to_string()));
    }
    if overlap >= window {
        return Err((
            "bad_args".to_string(),
            format!("overlap ({overlap}) must be < window ({window})"),
        ));
    }
    Ok(ChunkOptions { window, overlap })
}

fn parse_count(raw: Option<&Value>, default: usize, name: &str) -> Result<usize, (String, String)> {
    match raw {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value.as_u64().map(|count| count as usize).ok_or_else(|| {
            (
                "bad_args".to_string(),
                format!("{name} must be a non-negative integer"),
            )
        }),
    }
}

/// 把文本切成窗口块；块不足一块不补，超长逐块且最后一块必达文本末尾。
/// 返回 `[{index, start, end, text}]`，`start` / `end` 为码点偏移。
pub fn chunk_text(
    tokenizer: &Tokenizer,
    text: &str,
    options: &ChunkOptions,
) -> Result<Vec<Value>, (String, String)> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let encoding = tokenizer
        .encode(text, false)
        .map_err(|err| ("tokenize_failed".to_string(), err.to_string()))?;
    let offsets = encoding.get_offsets();
    let token_count = offsets.len();
    if token_count == 0 {
        return Ok(Vec::new());
    }

    let codepoints = codepoint_index(text);
    let window = options.window.max(1);
    let step = window - options.overlap.min(window - 1);
    let mut chunks = Vec::new();
    let mut start_token = 0usize;
    let mut index = 0usize;
    loop {
        let end_token = (start_token + window).min(token_count);
        let start_byte = if start_token == 0 {
            0
        } else {
            floor_char_boundary(text, offsets[start_token].0)
        };
        let end_byte = if end_token == token_count {
            text.len()
        } else {
            ceil_char_boundary(text, offsets[end_token - 1].1)
        };
        if end_byte > start_byte {
            chunks.push(json!({
                "index": index,
                "start": codepoints[start_byte],
                "end": codepoints[end_byte],
                "text": &text[start_byte..end_byte],
            }));
            index += 1;
        }
        if end_token >= token_count {
            break;
        }
        start_token += step;
    }
    Ok(chunks)
}

/// 每个字节位置对应的码点下标（长度 `text.len() + 1`；多字节字符内部指向该字符的码点）。
fn codepoint_index(text: &str) -> Vec<usize> {
    let mut map = vec![0usize; text.len() + 1];
    let mut codepoint = 0usize;
    for (byte, ch) in text.char_indices() {
        for slot in byte..byte + ch.len_utf8() {
            map[slot] = codepoint;
        }
        codepoint += 1;
    }
    map[text.len()] = codepoint;
    map
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut cursor = index.min(text.len());
    while cursor > 0 && !text.is_char_boundary(cursor) {
        cursor -= 1;
    }
    cursor
}

fn ceil_char_boundary(text: &str, index: usize) -> usize {
    let mut cursor = index.min(text.len());
    while cursor < text.len() && !text.is_char_boundary(cursor) {
        cursor += 1;
    }
    cursor
}

/// 按码点偏移取子串（与输出的 `start` / `end` 同口径；测试用参照实现）。
#[cfg(test)]
pub fn slice_codepoints(text: &str, start: usize, end: usize) -> String {
    text.chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokenizer;

    fn tokenizer() -> &'static Tokenizer {
        tokenizer::shared().expect("tokenizer 应能加载")
    }

    fn options(window: usize, overlap: usize) -> ChunkOptions {
        ChunkOptions { window, overlap }
    }

    fn cp_len(text: &str) -> usize {
        text.chars().count()
    }

    #[test]
    fn default_options() {
        let parsed = parse_options(&json!({})).unwrap();
        assert_eq!(parsed.window, DEFAULT_WINDOW);
        assert_eq!(parsed.overlap, DEFAULT_OVERLAP);
    }

    #[test]
    fn invalid_options_rejected() {
        assert!(parse_options(&json!({"window": 0})).is_err());
        assert!(parse_options(&json!({"window": 4, "overlap": 4})).is_err());
        assert!(parse_options(&json!({"window": "x"})).is_err());
    }

    #[test]
    fn empty_text_has_no_chunks() {
        let chunks = chunk_text(tokenizer(), "", &options(8, 2)).unwrap();
        assert!(chunks.is_empty());
    }

    #[test]
    fn short_text_is_one_chunk() {
        let text = "你好，world";
        let chunks = chunk_text(tokenizer(), text, &options(512, 64)).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0]["index"], 0);
        assert_eq!(chunks[0]["start"], 0);
        assert_eq!(chunks[0]["end"], cp_len(text));
        assert_eq!(chunks[0]["text"], text);
    }

    #[test]
    fn mixed_cjk_and_ascii_offsets_are_codepoints() {
        let text = "Chrono 是一个插件化 agent 运行时，支持中英混合文本的向量化与检索。";
        let chunks = chunk_text(tokenizer(), text, &options(8, 2)).unwrap();
        assert!(chunks.len() > 1);
        for (expected_index, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk["index"], expected_index);
            let start = chunk["start"].as_u64().unwrap() as usize;
            let end = chunk["end"].as_u64().unwrap() as usize;
            assert!(end <= cp_len(text));
            let expected = slice_codepoints(text, start, end);
            assert_eq!(chunk["text"], expected, "码点切片应与输出 text 一致");
        }
        // 首块从头、末块到尾：不丢头尾。
        assert_eq!(chunks.first().unwrap()["start"], 0);
        assert_eq!(chunks.last().unwrap()["end"], cp_len(text));
    }

    #[test]
    fn long_text_tail_not_lost() {
        let mut text = String::new();
        for i in 0..400 {
            text.push_str(&format!("句子{i}：Chrono embedding 窗口切块测试。"));
        }
        let chunks = chunk_text(tokenizer(), &text, &options(64, 16)).unwrap();
        assert!(chunks.len() > 1);
        let last = chunks.last().unwrap();
        assert_eq!(last["end"], cp_len(&text), "末块 end 必须达文本末尾");
        let tail_char = text.chars().last().unwrap();
        assert!(last["text"].as_str().unwrap().ends_with(tail_char));
    }

    #[test]
    fn chunking_is_deterministic() {
        let text = "确定性：同文本同块集，token 只用于决定边界。".repeat(20);
        let first = chunk_text(tokenizer(), &text, &options(32, 8)).unwrap();
        let second = chunk_text(tokenizer(), &text, &options(32, 8)).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn windows_overlap_by_token_count() {
        // 窗口 4、重叠 1 ⇒ 步长 3；每块至多 4 token（不含特殊 token）。
        let text = "alpha beta gamma delta epsilon zeta eta theta";
        let chunks = chunk_text(tokenizer(), text, &options(4, 1)).unwrap();
        assert!(chunks.len() >= 2);
        let first_end = chunks[0]["end"].as_u64().unwrap();
        let second_start = chunks[1]["start"].as_u64().unwrap();
        assert!(second_start < first_end, "相邻块应有重叠");
    }

    #[test]
    fn offsets_survive_multibyte_and_emoji() {
        let text = "emoji 😀🚀 与中文混杂的文本，用来校验码点偏移。";
        let chunks = chunk_text(tokenizer(), text, &options(4, 1)).unwrap();
        for chunk in &chunks {
            let start = chunk["start"].as_u64().unwrap() as usize;
            let end = chunk["end"].as_u64().unwrap() as usize;
            assert_eq!(chunk["text"], slice_codepoints(text, start, end));
        }
    }
}
