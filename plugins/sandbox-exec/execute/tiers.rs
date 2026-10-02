pub use plugin_sdk::tiers::*;

#[cfg(test)]
mod default_body_test {
    use super::*;
    use serde_json::Value;

    #[test]
    fn builtin_matches_default_body_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tools/default-body.json");
        let text = std::fs::read_to_string(path).expect("tools/default-body.json");
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parse_tiers(Some(&parsed)), builtin_tiers());
    }
}
