//! Build-time configuration.
//!
//! None of these are secrets -- the OAuth client is a public client, so there
//! is no client secret to protect. They are compiled in so a shipped installer
//! points at the right hosts without a config file, and can be overridden by an
//! environment variable during development.

macro_rules! build_config {
    ($fn_name:ident, $env_key:literal, $default:literal) => {
        pub fn $fn_name() -> String {
            const COMPILED: &str = match option_env!($env_key) {
                Some(v) => v,
                None => $default,
            };
            std::env::var($env_key)
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| COMPILED.to_string())
        }
    };
}

build_config!(
    api_base_url,
    "ISSUE_PIPELINE_API_BASE_URL",
    "http://127.0.0.1:8888"
);
build_config!(gitea_base_url, "ISSUE_PIPELINE_GITEA_BASE_URL", "");
build_config!(gitea_oauth_client_id, "ISSUE_PIPELINE_GITEA_CLIENT_ID", "");
