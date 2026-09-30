// Unicode Default Case Folding（码位折叠）——供 `grep` 的 `ignore_case` 使用。
// 表在 `casefold_table.rs`（生成文件，跑 tools/gen-casefold.py 刷新）；本文件只放折叠入口与测试。
// 口径：只做 casefold，**不含** NFC/NFD 规范化——组合形与分解形不互相匹配（见 README 已知口径）。

use crate::casefold_table::CASEFOLD;

/// 对整串做 casefold：ASCII 走 `to_ascii_lowercase` 快路径，非 ASCII 查表（二分）。
/// 变长映射（如 `ß → ss`）会改变长度，这是 casefold 的定义行为。
pub fn casefold(text: &str) -> String {
    // 无大写 / 无折叠映射时避免额外分配：先探测是否可能变化。
    let mut needs = false;
    for ch in text.chars() {
        if ch.is_ascii() {
            if ch.is_ascii_uppercase() {
                needs = true;
                break;
            }
        } else if CASEFOLD.binary_search_by_key(&(ch as u32), |(cp, _)| *cp).is_ok() {
            needs = true;
            break;
        }
    }
    if !needs {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_ascii() {
            out.push(ch.to_ascii_lowercase());
            continue;
        }
        match CASEFOLD.binary_search_by_key(&(ch as u32), |(cp, _)| *cp) {
            Ok(index) => out.push_str(CASEFOLD[index].1),
            Err(_) => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_and_identity() {
        assert_eq!(casefold("Hello, World!"), "hello, world!");
        assert_eq!(casefold("already-lower_123"), "already-lower_123");
        assert_eq!(casefold(""), "");
    }

    #[test]
    fn full_casefold_examples() {
        assert_eq!(casefold("ß"), "ss");
        assert_eq!(casefold("ẞ"), "ss");
        assert_eq!(casefold("Straße"), "strasse");
        // 希腊结尾 sigma 折叠到普通 sigma。
        assert_eq!(casefold("ς"), "σ");
        // 开尔文符号（U+212A）折叠到 ASCII k。
        assert_eq!(casefold("\u{212A}"), "k");
        // 连字 ﬁ 展开为 fi。
        assert_eq!(casefold("ﬁ"), "fi");
        // 土耳其带点大写 I → i + 组合点。
        assert_eq!(casefold("İ"), "i\u{307}");
    }

    #[test]
    fn table_is_sorted_and_non_ascii() {
        assert!(!CASEFOLD.is_empty());
        assert!(CASEFOLD.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(CASEFOLD.iter().all(|(cp, _)| *cp >= 0x80));
    }
}
