pub fn normalize_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(String::new());
    }
    if input.len() > 8192 {
        return Err("URL exceeds 8192 bytes".into());
    }
    let url = url::Url::parse(input).map_err(|err| format!("invalid URL: {err}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("only HTTP(S) URLs without embedded credentials are supported".into());
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_web_urls_and_empty_tabs_are_accepted() {
        for input in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "https://user:secret@host",
            "https://",
        ] {
            assert!(normalize_url(input).is_err(), "{input}");
        }
        assert_eq!(normalize_url("").unwrap(), "");
        assert_eq!(
            normalize_url("http://localhost:3000").unwrap(),
            "http://localhost:3000/"
        );
    }
}
