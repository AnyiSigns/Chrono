// 上下文去重：与上下文调配器同口径的规范化 dedup_key。
// 规则（本插件侧定义，与调配器实现对拍防漂移）：去首尾空白 → 空白折叠为单空格 → 转小写。
// 调用方把「在上下文条目的 dedup_key 列表」放 bag.dedup_set 传入，本插件据此做尽力预去重。

/// 规范化去重键。
pub fn dedup_key(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_whitespace_and_case() {
        assert_eq!(dedup_key("  Hello   World \n"), "hello world");
        assert_eq!(dedup_key("Hello\tWorld"), "hello world");
    }

    #[test]
    fn empty_text_is_empty_key() {
        assert_eq!(dedup_key("   "), "");
    }

    #[test]
    fn distinct_texts_stay_distinct() {
        assert_ne!(dedup_key("alpha"), dedup_key("beta"));
    }
}
