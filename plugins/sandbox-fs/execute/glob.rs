// 匹配器：`list` / `grep` 的 glob 过滤与 `grep` 的简易正则。
// 无外部依赖、确定性（纯函数，不取时间、不用随机）；`/` 为路径分隔符。

/// glob 匹配：支持 `*`（不跨 `/`）、`**`（跨 `/`）、`?`、`[...]`（可 `!`/`^` 取反、`a-z` 范围）。
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    glob_here(&pattern, 0, &text, 0)
}

fn glob_here(pattern: &[char], mut pi: usize, text: &[char], mut ti: usize) -> bool {
    while pi < pattern.len() {
        match pattern[pi] {
            '*' => {
                let double = pi + 1 < pattern.len() && pattern[pi + 1] == '*';
                let mut rest = if double { pi + 2 } else { pi + 1 };
                if double && rest < pattern.len() && pattern[rest] == '/' {
                    // `**/` 允许匹配零级目录
                    if glob_here(pattern, rest + 1, text, ti) {
                        return true;
                    }
                    rest += 1;
                }
                let mut k = ti;
                loop {
                    if glob_here(pattern, rest, text, k) {
                        return true;
                    }
                    if k >= text.len() {
                        return false;
                    }
                    if !double && text[k] == '/' {
                        return false;
                    }
                    k += 1;
                }
            }
            '?' => {
                if ti >= text.len() || text[ti] == '/' {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
            '[' => {
                if ti >= text.len() {
                    return false;
                }
                let (matched, next) = match_class(pattern, pi, text[ti]);
                if !matched {
                    return false;
                }
                pi = next;
                ti += 1;
            }
            literal => {
                if ti >= text.len() || text[ti] != literal {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
        }
    }
    ti == text.len()
}

/// 解析 `[...]`：返回（是否命中字符，`]` 之后的模式下标）。未闭合按字面 `[` 处理。
fn match_class(pattern: &[char], start: usize, target: char) -> (bool, usize) {
    let mut index = start + 1;
    let mut negated = false;
    if index < pattern.len() && (pattern[index] == '!' || pattern[index] == '^') {
        negated = true;
        index += 1;
    }
    let mut matched = false;
    let mut first = true;
    while index < pattern.len() {
        if pattern[index] == ']' && !first {
            return (matched != negated, index + 1);
        }
        first = false;
        let low = pattern[index];
        if index + 2 < pattern.len() && pattern[index + 1] == '-' && pattern[index + 2] != ']' {
            let high = pattern[index + 2];
            if low <= target && target <= high {
                matched = true;
            }
            index += 3;
            continue;
        }
        if low == target {
            matched = true;
        }
        index += 1;
    }
    (false, start + 1)
}

/// 校验模式是否落在简易正则支持子集内；`Some(reason)` 表示不支持。
/// 调用方在正则模式下必须先校验：不支持即显式报错，**不得**静默退化按字面匹配。
/// 支持：字面、`.`、`*`/`+`/`?`（量词须有可量化原子）、`^`（仅开头）/`$`（仅结尾）、`[...]` 类、
/// 以及把元字符 `.*+?[](){}|\^$` 转义成字面。
/// 不支持：交替 `|`、分组 `(`/`)`、重复 `{...}`、字符类简写 `\d`/`\w`/`\s` 等未知转义、悬空量词、未闭合 `[`。
pub fn regex_unsupported(pattern: &str) -> Option<String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    // 上一个位置是否刚结束一个可被量词作用的原子。
    let mut prev_atom = false;
    while index < chars.len() {
        match chars[index] {
            '|' => return Some("alternation `|` is not supported".to_string()),
            '(' | ')' => return Some("grouping `(`/`)` is not supported".to_string()),
            '{' | '}' => return Some("repetition `{...}` is not supported".to_string()),
            '\\' => {
                index += 1;
                if index >= chars.len() {
                    return Some("trailing backslash `\\`".to_string());
                }
                let escaped = chars[index];
                if !matches!(
                    escaped,
                    '.' | '*' | '+' | '?' | '[' | ']' | '(' | ')' | '{' | '}' | '|' | '\\' | '^' | '$'
                ) {
                    return Some(format!(
                        "escape `\\{escaped}` is not supported (no \\d/\\w/\\s classes)"
                    ));
                }
                prev_atom = true;
            }
            '*' | '+' | '?' => {
                if !prev_atom {
                    return Some(format!("quantifier `{}` has nothing to repeat", chars[index]));
                }
                // 量化后不能紧跟第二个量词。
                prev_atom = false;
            }
            '[' => {
                let Some((_, next)) = parse_class(&chars, index) else {
                    return Some("unclosed character class `[`".to_string());
                };
                index = next - 1;
                prev_atom = true;
            }
            '^' if index == 0 => prev_atom = false,
            '$' if index + 1 == chars.len() => prev_atom = false,
            _ => prev_atom = true,
        }
        index += 1;
    }
    None
}

/// 简易正则：字面、`.`、`*`/`+`/`?`、`^`/`$`、`[...]`、`\` 转义；无分组 / 交替。
/// 仅当 `regex_unsupported` 通过时语义才确定；未校验的非法模式会退化为字面匹配。
pub fn regex_search(pattern: &str, text: &str) -> bool {
    let tokens = match parse_regex(pattern) {
        Some(tokens) => tokens,
        None => return text.contains(pattern),
    };
    let chars: Vec<char> = text.chars().collect();
    let anchored = matches!(tokens.first().map(|t| &t.atom), Some(Atom::Start));
    if anchored {
        return match_seq(&tokens, &chars, 0);
    }
    for start in 0..=chars.len() {
        if match_seq(&tokens, &chars, start) {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq)]
enum Atom {
    Char(char),
    Any,
    Class { negated: bool, items: Vec<(char, char)> },
    Start,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Quant {
    One,
    ZeroOrMore,
    OneOrMore,
    Optional,
}

#[derive(Debug, Clone)]
struct Token {
    atom: Atom,
    quant: Quant,
}

fn parse_regex(pattern: &str) -> Option<Vec<Token>> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let atom = match chars[index] {
            '\\' => {
                index += 1;
                if index >= chars.len() {
                    return None;
                }
                Atom::Char(chars[index])
            }
            '^' if index == 0 => Atom::Start,
            '$' if index + 1 == chars.len() => Atom::End,
            '.' => Atom::Any,
            '[' => {
                let (atom, next) = parse_class(&chars, index)?;
                index = next;
                atom
            }
            '*' | '+' | '?' => return None,
            literal => Atom::Char(literal),
        };
        index += 1;
        let quant = if index < chars.len() {
            match chars[index] {
                '*' => {
                    index += 1;
                    Quant::ZeroOrMore
                }
                '+' => {
                    index += 1;
                    Quant::OneOrMore
                }
                '?' => {
                    index += 1;
                    Quant::Optional
                }
                _ => Quant::One,
            }
        } else {
            Quant::One
        };
        tokens.push(Token { atom, quant });
    }
    Some(tokens)
}

fn parse_class(chars: &[char], start: usize) -> Option<(Atom, usize)> {
    let mut index = start + 1;
    let mut negated = false;
    if index < chars.len() && (chars[index] == '!' || chars[index] == '^') {
        negated = true;
        index += 1;
    }
    let mut items = Vec::new();
    let mut first = true;
    while index < chars.len() {
        if chars[index] == ']' && !first {
            return Some((Atom::Class { negated, items }, index + 1));
        }
        first = false;
        let low = chars[index];
        if index + 2 < chars.len() && chars[index + 1] == '-' && chars[index + 2] != ']' {
            items.push((low, chars[index + 2]));
            index += 3;
            continue;
        }
        items.push((low, low));
        index += 1;
    }
    None
}

fn match_seq(tokens: &[Token], text: &[char], pos: usize) -> bool {
    let Some(token) = tokens.first() else {
        return true;
    };
    let rest = &tokens[1..];
    match token.quant {
        Quant::One => {
            if !atom_matches(&token.atom, text, pos) {
                return false;
            }
            match_seq(rest, text, pos + atom_width(&token.atom))
        }
        Quant::Optional => {
            if atom_matches(&token.atom, text, pos)
                && match_seq(rest, text, pos + atom_width(&token.atom))
            {
                return true;
            }
            match_seq(rest, text, pos)
        }
        Quant::ZeroOrMore | Quant::OneOrMore => {
            let minimum = if token.quant == Quant::OneOrMore { 1 } else { 0 };
            let width = atom_width(&token.atom);
            let mut count = 0;
            while atom_matches(&token.atom, text, pos + count * width) {
                count += 1;
            }
            while count >= minimum {
                if match_seq(rest, text, pos + count * width) {
                    return true;
                }
                if count == 0 {
                    break;
                }
                count -= 1;
            }
            false
        }
    }
}

fn atom_matches(atom: &Atom, text: &[char], pos: usize) -> bool {
    match atom {
        Atom::Char(expected) => pos < text.len() && text[pos] == *expected,
        Atom::Any => pos < text.len(),
        Atom::Start => pos == 0,
        Atom::End => pos == text.len(),
        Atom::Class { negated, items } => {
            if pos >= text.len() {
                return false;
            }
            let hit = items.iter().any(|(low, high)| *low <= text[pos] && text[pos] <= *high);
            hit != *negated
        }
    }
}

fn atom_width(atom: &Atom) -> usize {
    match atom {
        Atom::Start | Atom::End => 0,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_basics() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(glob_match("src/*.rs", "src/main.rs"));
        assert!(!glob_match("src/*.rs", "src/nested/main.rs"));
        assert!(glob_match("a?c", "abc"));
        assert!(glob_match("[a-c]x", "bx"));
        assert!(!glob_match("[!a-c]x", "bx"));
        assert!(glob_match("**", "any/deep/path"));
    }

    #[test]
    fn regex_basics() {
        assert!(regex_search("abc", "xxabcxx"));
        assert!(regex_search("^abc", "abcxx"));
        assert!(!regex_search("^abc", "xabc"));
        assert!(regex_search("abc$", "xxabc"));
        assert!(regex_search("a.c", "azc"));
        assert!(regex_search("ab*c", "ac"));
        assert!(regex_search("ab*c", "abbbc"));
        assert!(regex_search("ab+c", "ac") == false);
        assert!(regex_search("ab+c", "abc"));
        assert!(regex_search("colou?r", "color"));
        assert!(regex_search("colou?r", "colour"));
        assert!(regex_search("[0-9]+", "abc123"));
        assert!(!regex_search("[0-9]+", "abc"));
        assert!(regex_search(r"a\.b", "a.b"));
        assert!(!regex_search(r"a\.b", "axb"));
    }

    #[test]
    fn regex_unsupported_flags_silent_traps() {
        // 交替 / 分组 / 重复 / 未知名类转义 / 悬空量词 / 未闭合类：都必须被识别为不支持。
        assert!(regex_unsupported("foo|bar").is_some());
        assert!(regex_unsupported("(foo)").is_some());
        assert!(regex_unsupported("a{2,3}").is_some());
        assert!(regex_unsupported(r"\d+").is_some());
        assert!(regex_unsupported("*foo").is_some());
        assert!(regex_unsupported("[abc").is_some());
        assert!(regex_unsupported(r"a\").is_some());
        // 支持子集：字面、`.`、量词、锚点、字符类、转义元字符。
        assert!(regex_unsupported("^fn .*\\(\\)").is_none());
        assert!(regex_unsupported("[0-9]+").is_none());
        assert!(regex_unsupported(r"a\.b").is_none());
        assert!(regex_unsupported("colou?r").is_none());
        assert!(regex_unsupported("plain text").is_none());
    }

    #[test]
    fn regex_quantifier_backtracking() {
        assert!(regex_search("a.*b", "axxxb"));
        assert!(regex_search("a.*b.*c", "a1b2c3"));
        assert!(regex_search("^a+$", "aaaa"));
        assert!(!regex_search("^a+$", "aaab"));
    }
}
