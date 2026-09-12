//! The single channel between the React layer and the network.
//!
//! React never holds a URL or a token: it names a method and an API path, and
//! this module decides what host that reaches and what credentials go with it.
//! Phase 1 adds the bearer token here; the shape of the command does not change.

use serde::Serialize;
use tauri::State;

use crate::config;

#[derive(Debug, Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub json: serde_json::Value,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("invalid api path: {0}")]
    InvalidPath(String),
    #[error("unsupported method: {0}")]
    InvalidMethod(String),
    #[error("request failed: {0}")]
    Transport(String),
}

// Tauri commands must return something serializable; the error travels to React
// as a plain string, never as a structure that could leak request details.
impl Serialize for ApiError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Only the verbs this API actually uses; anything else is refused rather than
/// forwarded.
fn parse_method(raw: &str) -> Result<reqwest::Method, ApiError> {
    match raw.to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "PUT" => Ok(reqwest::Method::PUT),
        "DELETE" => Ok(reqwest::Method::DELETE),
        other => Err(ApiError::InvalidMethod(other.to_string())),
    }
}

pub struct ApiClient {
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("issue-pipeline/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("failed to build HTTP client");
        Self { http }
    }
}

impl Default for ApiClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Reject anything that is not a relative path rooted at `/`.
///
/// Without this the React layer could pass an absolute URL and redirect the
/// request -- and, from Phase 1 on, the bearer token attached to it -- at a host
/// of its choosing. Protocol-relative `//host` is rejected for the same reason.
fn validate_path(path: &str) -> Result<(), ApiError> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err(ApiError::InvalidPath(path.to_string()));
    }
    if path.contains("://") || path.contains("..") {
        return Err(ApiError::InvalidPath(path.to_string()));
    }
    Ok(())
}

#[tauri::command]
pub async fn api_request(
    client: State<'_, ApiClient>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<ApiResponse, ApiError> {
    validate_path(&path)?;
    let method = parse_method(&method)?;
    let url = format!("{}{}", config::api_base_url().trim_end_matches('/'), path);

    let mut request = client.http.request(method, &url);
    if let Some(body) = body {
        request = request.json(&body);
    }

    let response = request
        .send()
        .await
        .map_err(|e| ApiError::Transport(strip_url(&e.to_string(), &url)))?;

    let status = response.status().as_u16();
    // A non-JSON body (a proxy error page, say) still needs to reach the caller
    // as a status plus something readable, not as a parse failure.
    let text = response
        .text()
        .await
        .map_err(|e| ApiError::Transport(strip_url(&e.to_string(), &url)))?;
    let json = serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "raw": text }));

    Ok(ApiResponse { status, json })
}

/// Keep the full URL out of error strings that reach the UI.
fn strip_url(message: &str, url: &str) -> String {
    message.replace(url, "<api>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_traversal_paths() {
        for bad in [
            "https://evil.example/api/me",
            "//evil.example/api/me",
            "/api/../../secret",
            "api/me",
            "",
        ] {
            assert!(validate_path(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn accepts_relative_api_paths() {
        for good in ["/api/health", "/api/drafts?repo_id=1", "/api/runs/abc"] {
            assert!(validate_path(good).is_ok(), "should accept {good:?}");
        }
    }
}
