// Pure helpers for the Logos account login flow (PKCE, login URL, loopback callback parsing).
// Nothing here touches the network or Tauri, so it is unit tested on its own.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub const APP_ID: &str = "logos";
pub const CALLBACK_PORT: u16 = 25885;
pub const RETURN_TO: &str = "http://127.0.0.1:25885/";

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

// RFC 7636: 32 random bytes give a 43-char verifier, the minimum allowed length
pub fn generate_verifier() -> String {
    random_url_safe(32)
}

pub fn challenge_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn generate_state() -> String {
    random_url_safe(16)
}

pub fn build_login_url(phainon_base: &str, state: &str, challenge: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("app_id", APP_ID)
        .append_pair("return_to", RETURN_TO)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .finish();
    format!("{}/auth/login?{}", phainon_base.trim_end_matches('/'), query)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CallbackParams {
    pub login_code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    // the landing page that forwards location.hash back to us
    Page,
    Callback(CallbackParams),
    NotFound,
}

// Route an HTTP request line such as "GET /callback?login_code=x&state=y HTTP/1.1"
pub fn parse_request_line(line: &str) -> Route {
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Route::NotFound;
    };
    if method != "GET" {
        return Route::NotFound;
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    match path {
        "/" => Route::Page,
        "/callback" => {
            let mut params = CallbackParams::default();
            for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
                match k.as_ref() {
                    "login_code" => params.login_code = Some(v.into_owned()),
                    "state" => params.state = Some(v.into_owned()),
                    "error" => params.error = Some(v.into_owned()),
                    _ => {}
                }
            }
            Route::Callback(params)
        }
        _ => Route::NotFound,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallbackError {
    Denied(String),
    StateMismatch,
    MissingCode,
}

impl CallbackError {
    pub fn message(&self) -> String {
        match self {
            CallbackError::Denied(e) => format!("登录未完成：登录服务返回错误（{e}）。"),
            CallbackError::StateMismatch => "登录校验失败：回调参数与本次登录请求不一致，请重新登录。".to_string(),
            CallbackError::MissingCode => "登录未完成：回调中缺少登录码，请重新登录。".to_string(),
        }
    }
}

// Check state before anything else so a stray request cannot end the flow with its own error
pub fn validate_callback(params: &CallbackParams, expected_state: &str) -> Result<String, CallbackError> {
    if params.state.as_deref() != Some(expected_state) {
        return Err(CallbackError::StateMismatch);
    }
    if let Some(error) = &params.error {
        return Err(CallbackError::Denied(error.clone()));
    }
    match &params.login_code {
        Some(code) if !code.is_empty() => Ok(code.clone()),
        _ => Err(CallbackError::MissingCode),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_has_valid_length_and_charset() {
        let v = generate_verifier();
        assert_eq!(v.len(), 43);
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(v, generate_verifier());
    }

    #[test]
    fn challenge_matches_rfc7636_example() {
        // RFC 7636 Appendix B
        assert_eq!(
            challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn state_is_random() {
        assert_eq!(generate_state().len(), 22);
        assert_ne!(generate_state(), generate_state());
    }

    #[test]
    fn login_url_encodes_parameters() {
        let url = build_login_url("https://api.rakko.cn/", "st", "ch");
        assert_eq!(
            url,
            "https://api.rakko.cn/auth/login?app_id=logos&return_to=http%3A%2F%2F127.0.0.1%3A25885%2F&state=st&code_challenge=ch&code_challenge_method=S256"
        );
    }

    #[test]
    fn parses_routes() {
        assert_eq!(parse_request_line("GET / HTTP/1.1"), Route::Page);
        assert_eq!(parse_request_line("GET /?x=1 HTTP/1.1"), Route::Page);
        assert_eq!(parse_request_line("GET /favicon.ico HTTP/1.1"), Route::NotFound);
        assert_eq!(parse_request_line("POST /callback HTTP/1.1"), Route::NotFound);
        assert_eq!(parse_request_line(""), Route::NotFound);
        assert_eq!(
            parse_request_line("GET /callback?login_code=a%2Bb%3D&state=s1&extra=1 HTTP/1.1"),
            Route::Callback(CallbackParams {
                login_code: Some("a+b=".to_string()),
                state: Some("s1".to_string()),
                error: None,
            })
        );
        assert_eq!(
            parse_request_line("GET /callback HTTP/1.1"),
            Route::Callback(CallbackParams::default())
        );
    }

    #[test]
    fn validates_callback() {
        let ok = CallbackParams {
            login_code: Some("code".into()),
            state: Some("s".into()),
            error: None,
        };
        assert_eq!(validate_callback(&ok, "s"), Ok("code".to_string()));
        assert_eq!(validate_callback(&ok, "other"), Err(CallbackError::StateMismatch));

        let no_state = CallbackParams { state: None, ..CallbackParams::default() };
        assert_eq!(validate_callback(&no_state, "s"), Err(CallbackError::StateMismatch));

        let denied = CallbackParams {
            state: Some("s".into()),
            error: Some("access_denied".into()),
            ..CallbackParams::default()
        };
        assert_eq!(
            validate_callback(&denied, "s"),
            Err(CallbackError::Denied("access_denied".into()))
        );

        let empty = CallbackParams {
            login_code: Some(String::new()),
            state: Some("s".into()),
            error: None,
        };
        assert_eq!(validate_callback(&empty, "s"), Err(CallbackError::MissingCode));
    }
}
