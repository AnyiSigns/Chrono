//! v1 估算器（确定、无外部依赖）：把文本映射为 token 估算数。
//!
//! 规格（写死，同输入同输出）：
//! - CJK 码点：每码点 1 token；
//! - ASCII 词（`[A-Za-z0-9_]` 的极大连续段）：每段 1 token；
//! - 空白（含非 ASCII 空白）：分隔符，0 token；
//! - 其余码点（ASCII 标点 / 符号 + 非 ASCII 非 CJK 字符）：每 4 码点 1 token（不足 4 向上取整）。
//!
//! 这是可替换为真 tokenizer 的接缝：调用方只依赖 `count_text` 的签名与确定性。

/// 其余码点的分桶大小（每桶约 1 token）。
pub const OTHER_BUCKET: u64 = 4;

/// 判断一个码点是否属 CJK 记数范围（Han / 假名 / 谚文 / CJK 标点 / 全角）。
pub fn is_cjk(codepoint: char) -> bool {
    let value = codepoint as u32;
    matches!(value,
        0x2E80..=0x2EFF        // CJK 部首补充
        | 0x2F00..=0x2FDF      // 康熙部首
        | 0x3000..=0x303F      // CJK 符号与标点
        | 0x3040..=0x30FF      // 平假名 / 片假名
        | 0x3100..=0x312F      // 注音符号
        | 0x3130..=0x318F      // 谚文兼容字母
        | 0x3400..=0x4DBF      // CJK 扩展 A
        | 0x4E00..=0x9FFF      // CJK 统一表意
        | 0xA000..=0xA4CF      // 彝文
        | 0xAC00..=0xD7AF      // 谚文音节
        | 0xF900..=0xFAFF      // CJK 兼容表意
        | 0xFE30..=0xFE4F      // CJK 兼容形式
        | 0xFF00..=0xFFEF      // 全角 / 半角形式
        | 0x20000..=0x2FA1F    // CJK 扩展 B–F / 兼容补充
    )
}

/// 判断一个码点是否 ASCII 词字符（字母 / 数字 / 下划线）。
fn is_ascii_word(codepoint: char) -> bool {
    codepoint.is_ascii_alphanumeric() || codepoint == '_'
}

/// 按 v1 规格估算 token 数。纯函数、确定、无副作用。
pub fn count_text(text: &str) -> u64 {
    let mut cjk = 0_u64;
    let mut words = 0_u64;
    let mut others = 0_u64;
    let mut in_word = false;
    for codepoint in text.chars() {
        if is_cjk(codepoint) {
            in_word = false;
            cjk += 1;
        } else if is_ascii_word(codepoint) {
            if !in_word {
                words += 1;
                in_word = true;
            }
        } else if codepoint.is_whitespace() {
            in_word = false;
        } else {
            in_word = false;
            others += 1;
        }
    }
    let other_tokens = others.div_ceil(OTHER_BUCKET);
    cjk + words + other_tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_string_is_zero() {
        assert_eq!(count_text(""), 0);
    }

    #[test]
    fn pure_ascii_words() {
        assert_eq!(count_text("hello"), 1);
        assert_eq!(count_text("hello world"), 2);
        assert_eq!(count_text("hello   world"), 2);
        assert_eq!(count_text("snake_case_name"), 1);
        assert_eq!(count_text("a1_b2 c3"), 2);
    }

    #[test]
    fn ascii_punctuation_buckets() {
        // 4 个标点 = 1 token；不足 4 向上取整。
        assert_eq!(count_text("!!!?"), 1);
        assert_eq!(count_text("!!!"), 1);
        assert_eq!(count_text("foo(bar, baz)"), 3 + 1); // 3 词 + 3 标点 -> 1
    }

    #[test]
    fn cjk_one_token_per_codepoint() {
        assert_eq!(count_text("你好"), 2);
        assert_eq!(count_text("你好世界"), 4);
        assert_eq!(count_text("こんにちは"), 5);
        assert_eq!(count_text("한국어"), 3);
        assert_eq!(count_text("你好，世界"), 5); // 逗号 U+FF0C 属全角 -> CJK
    }

    #[test]
    fn mixed_text() {
        // "Hello" 1 + "世界" 2 + "!" 计入 others(1 -> 1) = 4
        assert_eq!(count_text("Hello世界!"), 4);
        assert_eq!(count_text("abc 中文 def"), 4); // 3 词 + 2 CJK
    }

    #[test]
    fn other_scripts_bucket_by_four() {
        assert_eq!(count_text("éééé"), 1);
        assert_eq!(count_text("ééééé"), 2);
        assert_eq!(count_text("Привет"), 2); // 6 码点 -> ceil(6/4)=2
    }

    #[test]
    fn whitespace_only_is_zero() {
        assert_eq!(count_text("   \n\t\r\n"), 0);
    }

    #[test]
    fn long_text_is_linear_and_deterministic() {
        let unit = "The quick brown fox 中文测试 12345. ";
        let long: String = unit.repeat(500);
        let first = count_text(&long);
        let second = count_text(&long);
        assert_eq!(first, second);
        assert!(first >= 500 * 5);
    }

    #[test]
    fn is_cjk_boundaries() {
        assert!(is_cjk('一'));
        assert!(is_cjk('あ'));
        assert!(is_cjk('，'));
        assert!(!is_cjk('a'));
        assert!(!is_cjk('é'));
        assert!(!is_cjk('!'));
    }
}
