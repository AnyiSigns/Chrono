// 时间衰减：score × exp(-λ · age_seconds)，age = now − meta.at（服务不取时间，now 由 bag / 调用帧 env 传入）。
// 时间值支持 epoch 毫秒（数字）与 ISO 8601（字符串，UTC 或带偏移）；无法解析时衰减因子回 1（fail-open）。
// 纯函数、无 IO：同输入同输出。

use serde_json::Value;

/// 解析时间值为 epoch 毫秒。数字按 epoch 毫秒；字符串按 ISO 8601。
pub fn parse_time_ms(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return if number.is_finite() {
            Some(number)
        } else {
            None
        };
    }
    parse_iso8601_ms(value.as_str()?)
}

/// 解析 ISO 8601（`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]`）为 epoch 毫秒。
/// 只覆盖内存条目 `meta.at` 的形态；越界 / 畸形返回 `None`。
pub fn parse_iso8601_ms(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    if bytes[4] != b'-' {
        return None;
    }
    let month: i64 = text.get(5..7)?.parse().ok()?;
    if bytes[7] != b'-' {
        return None;
    }
    let day: i64 = text.get(8..10)?.parse().ok()?;

    let mut hour = 0_i64;
    let mut minute = 0_i64;
    let mut second = 0_i64;
    let mut millis = 0_i64;
    let mut offset_minutes = 0_i64;

    let mut index = 10;
    if index < bytes.len() && (bytes[index] == b'T' || bytes[index] == b' ') {
        index += 1;
        hour = parse_two(text, index)?;
        index += 2;
        if get_byte(bytes, index)? != b':' {
            return None;
        }
        index += 1;
        minute = parse_two(text, index)?;
        index += 2;
        if index < bytes.len() && bytes[index] == b':' {
            index += 1;
            second = parse_two(text, index)?;
            index += 2;
        }
        if index < bytes.len() && bytes[index] == b'.' {
            index += 1;
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            let mut fraction = text.get(start..index)?.to_string();
            fraction.truncate(3);
            while fraction.len() < 3 {
                fraction.push('0');
            }
            millis = fraction.parse().ok()?;
        }
        if index < bytes.len() {
            match bytes[index] {
                b'Z' | b'z' => {}
                b'+' | b'-' => {
                    let sign = if bytes[index] == b'-' { -1 } else { 1 };
                    index += 1;
                    let offset_hour = parse_two(text, index)?;
                    index += 2;
                    if index < bytes.len() && bytes[index] == b':' {
                        index += 1;
                    }
                    let offset_minute = parse_two(text, index)?;
                    offset_minutes = sign * (offset_hour * 60 + offset_minute);
                }
                _ => {}
            }
        }
    }

    let days = days_from_civil(year, month, day)?;
    let total_seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(total_seconds as f64 * 1000.0 + millis as f64)
}

fn parse_two(text: &str, index: usize) -> Option<i64> {
    text.get(index..index + 2)?.parse().ok()
}

fn get_byte(bytes: &[u8], index: usize) -> Option<u8> {
    bytes.get(index).copied()
}

/// 民用日期 → 自 1970-01-01 的天数（Howard Hinnant 算法）；月 / 日越界回 `None`。
fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

/// 衰减因子：`λ ≤ 0` / 时间缺失 / `at` 不可解析 → 1.0；`at` 在未来 → age 取 0。
pub fn decay_factor(now_ms: Option<f64>, at: &Value, lambda: f64) -> f64 {
    if lambda <= 0.0 {
        return 1.0;
    }
    let Some(now) = now_ms else {
        return 1.0;
    };
    let Some(at) = parse_time_ms(at) else {
        return 1.0;
    };
    let age_seconds = ((now - at) / 1000.0).max(0.0);
    (-lambda * age_seconds).exp()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_epoch_milliseconds() {
        assert_eq!(parse_time_ms(&json!(1000.0)), Some(1000.0));
    }

    #[test]
    fn parses_iso_utc() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(
            parse_iso8601_ms("1970-01-02T00:00:00.500Z"),
            Some(86_400_000.0 + 500.0)
        );
    }

    #[test]
    fn parses_iso_with_offset() {
        // +02:00 的 02:00 == UTC 00:00
        assert_eq!(parse_iso8601_ms("1970-01-01T02:00:00+02:00"), Some(0.0));
    }

    #[test]
    fn date_only_is_midnight_utc() {
        assert_eq!(parse_iso8601_ms("1970-01-01"), Some(0.0));
    }

    #[test]
    fn malformed_is_none() {
        assert_eq!(parse_iso8601_ms("not-a-date"), None);
        assert_eq!(parse_iso8601_ms("2020-13-01"), None);
        assert_eq!(parse_iso8601_ms("2020-01-32"), None);
    }

    #[test]
    fn decay_halves_after_one_half_life() {
        let lambda = std::f64::consts::LN_2 / 1000.0; // 半衰期 1000 秒
        let at = json!("1970-01-01T00:00:00Z");
        let factor = decay_factor(Some(1_000_000.0), &at, lambda);
        assert!((factor - 0.5).abs() < 1e-9);
    }

    #[test]
    fn zero_lambda_or_missing_time_is_no_decay() {
        let at = json!("1970-01-01T00:00:00Z");
        assert_eq!(decay_factor(Some(1_000_000.0), &at, 0.0), 1.0);
        assert_eq!(decay_factor(None, &at, 1.0), 1.0);
        assert_eq!(decay_factor(Some(1_000_000.0), &json!("bad"), 1.0), 1.0);
    }

    #[test]
    fn future_timestamp_has_no_negative_age() {
        let at = json!("1970-01-01T00:00:10Z");
        assert_eq!(decay_factor(Some(0.0), &at, 1.0), 1.0);
    }
}
