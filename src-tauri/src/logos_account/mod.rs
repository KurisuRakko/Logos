// Logos account: Phainon native login with PKCE through a loopback listener on 127.0.0.1:25885.
// The refresh token lives in the OS credential store (Windows Credential Manager); the access
// token only ever stays in memory.
mod oauth;

use crate::config::get;
use log::{info, warn};
use once_cell::sync::Lazy;
use oauth::{CallbackError, Route, CALLBACK_PORT};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::api::http::{Body, ClientBuilder, HttpRequestBuilder};
use tauri::Manager;

const DEFAULT_PHAINON_BASE: &str = "https://api.rakko.cn";
const KEYRING_SERVICE: &str = "com.pot-app.desktop.logos";
const KEYRING_USER: &str = "refresh_token";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
// refresh this long before the access token expires
const REFRESH_LEEWAY_SECS: u64 = 60;
// Phainon issues 15-minute access tokens; used only if expires_in is missing
const DEFAULT_ACCESS_TTL_SECS: u64 = 15 * 60;

const CALLBACK_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Logos 账号登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f6f6f4;color:#1f1f1f}
@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ececea}}p{font-size:16px}</style></head>
<body><p id="msg">正在完成登录……</p>
<script>
const params = new URLSearchParams(location.hash.slice(1));
new URLSearchParams(location.search).forEach((v, k) => { if (!params.has(k)) params.set(k, v); });
history.replaceState(null, '', '/');
fetch('/callback?' + params.toString())
  .then((r) => r.ok)
  .catch(() => false)
  .then((ok) => {
    document.getElementById('msg').textContent = ok
      ? '登录完成，可以关闭此页面。'
      : '登录未完成，请返回 Logos 查看原因后重试。';
  });
</script></body></html>"#;

#[derive(Debug, Clone, Serialize, Default)]
pub struct AccountUser {
    pub sub: String,
    pub name: Option<String>,
    pub preferred_username: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountStatus {
    pub logged_in: bool,
    pub user: Option<AccountUser>,
}

#[derive(Default)]
struct Session {
    access_token: Option<String>,
    // unix seconds
    access_expires_at: u64,
    user: Option<AccountUser>,
}

// Async mutex: a refresh rotates the refresh token, so two concurrent refreshes would trip
// Phainon's reuse detection and revoke the session. Holding the lock across the request
// serializes them.
static SESSION: Lazy<tokio::sync::Mutex<Session>> = Lazy::new(|| tokio::sync::Mutex::new(Session::default()));
// bumped by every login attempt; an older listener loop sees the change and gives up the port
static LOGIN_GENERATION: AtomicU64 = AtomicU64::new(0);

fn phainon_base() -> String {
    get("logos_phainon_base")
        .and_then(|v| v.as_str().map(|s| s.trim().trim_end_matches('/').to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PHAINON_BASE.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------- credential store ----------

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("无法访问系统凭据管理器：{e}"))
}

fn load_refresh_token() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("无法读取系统凭据管理器中的登录信息：{e}")),
    }
}

fn store_refresh_token(token: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(token)
        .map_err(|e| format!("无法将登录信息写入系统凭据管理器：{e}"))
}

fn delete_refresh_token() {
    match keyring_entry().map(|entry| entry.delete_credential()) {
        Ok(Ok(())) | Ok(Err(keyring::Error::NoEntry)) => {}
        Ok(Err(e)) => warn!("Failed to delete Logos refresh token: {e}"),
        Err(e) => warn!("{e}"),
    }
}

// ---------- Phainon API ----------

enum ApiFailure {
    // Phainon answered with a 4xx: the credential is no longer usable
    Rejected { code: String, status: u16 },
    // network error or 5xx: worth retrying later, keep the stored credential
    Unavailable(String),
}

impl ApiFailure {
    fn message(&self) -> String {
        match self {
            ApiFailure::Rejected { code, status } => match code.as_str() {
                "app_access_denied" => "当前账号未获准使用 Logos，请联系管理员开通。".to_string(),
                "app_disabled" => "Logos 应用已被管理员停用。".to_string(),
                "rate_limited" => "登录请求过于频繁，请稍后重试。".to_string(),
                c if c.contains("login_code") || c.contains("pkce") || c.contains("verifier") => {
                    "登录码无效或已过期，请重新登录。".to_string()
                }
                _ => format!("登录服务拒绝了请求（HTTP {status}，{code}）。"),
            },
            ApiFailure::Unavailable(msg) => msg.clone(),
        }
    }
}

async fn phainon_request(method: &str, path: &str, body: Option<Value>, bearer: Option<&str>) -> Result<Value, ApiFailure> {
    let unavailable = |e: String| ApiFailure::Unavailable(format!("无法连接登录服务：{e}"));
    let client = ClientBuilder::new()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| unavailable(e.to_string()))?;
    let mut request = HttpRequestBuilder::new(method, format!("{}{}", phainon_base(), path))
        .map_err(|e| unavailable(e.to_string()))?
        .timeout(Duration::from_secs(20));
    if let Some(body) = body {
        request = request.body(Body::Json(body));
    }
    if let Some(token) = bearer {
        request = request
            .header("Authorization", format!("Bearer {token}"))
            .map_err(|e| unavailable(e.to_string()))?;
    }
    let response = client.send(request).await.map_err(|e| unavailable(e.to_string()))?;
    let raw = response.bytes().await.map_err(|e| unavailable(e.to_string()))?;
    let data: Value = serde_json::from_slice(&raw.data).unwrap_or(Value::Null);
    match raw.status {
        200..=299 => Ok(data),
        status @ 400..=499 => Err(ApiFailure::Rejected {
            code: data["error"]["code"].as_str().unwrap_or("unknown").to_string(),
            status,
        }),
        status => Err(ApiFailure::Unavailable(format!("登录服务暂时不可用（HTTP {status}），请稍后重试。"))),
    }
}

// Store a token pair returned by /auth/exchange or /auth/refresh
fn apply_token_pair(session: &mut Session, data: &Value) -> Result<(), String> {
    let access = data["access_token"].as_str().ok_or("登录服务返回的数据缺少 access_token。")?;
    let refresh = data["refresh_token"].as_str().ok_or("登录服务返回的数据缺少 refresh_token。")?;
    store_refresh_token(refresh)?;
    session.access_token = Some(access.to_string());
    session.access_expires_at = now_secs() + data["expires_in"].as_u64().unwrap_or(DEFAULT_ACCESS_TTL_SECS);
    Ok(())
}

async fn fetch_user(session: &mut Session) {
    let Some(token) = session.access_token.clone() else { return };
    match phainon_request("GET", "/auth/me", None, Some(&token)).await {
        Ok(data) => {
            let user = &data["user"];
            session.user = Some(AccountUser {
                sub: user["sub"].as_str().unwrap_or_default().to_string(),
                name: user["name"].as_str().map(str::to_string),
                preferred_username: user["preferred_username"].as_str().map(str::to_string),
            });
        }
        Err(e) => warn!("Failed to load Logos account user: {}", e.message()),
    }
}

fn clear_session(session: &mut Session) {
    *session = Session::default();
    delete_refresh_token();
}

// Ok(None) means signed out. Err is a transient failure (network, credential store) that
// leaves the stored refresh token untouched.
async fn ensure_access_token(session: &mut Session) -> Result<Option<String>, String> {
    if let Some(token) = &session.access_token {
        if now_secs() + REFRESH_LEEWAY_SECS < session.access_expires_at {
            return Ok(Some(token.clone()));
        }
    }
    session.access_token = None;
    let Some(refresh) = load_refresh_token()? else {
        session.user = None;
        return Ok(None);
    };
    match phainon_request("POST", "/auth/refresh", Some(json!({ "refresh_token": refresh })), None).await {
        Ok(data) => {
            apply_token_pair(session, &data)?;
            if session.user.is_none() {
                fetch_user(session).await;
            }
            Ok(session.access_token.clone())
        }
        // only an explicit rejection drops the credential; 429 and other 4xx count as transient
        Err(e @ ApiFailure::Rejected { status: 400 | 401 | 403, .. }) => {
            info!("Logos refresh token rejected: {}", e.message());
            clear_session(session);
            Ok(None)
        }
        Err(e) => Err(e.message()),
    }
}

// ---------- loopback listener ----------

fn bind_callback_listener() -> Result<TcpListener, String> {
    // an earlier attempt may still hold the port for one poll interval after being superseded
    let mut last_error = None;
    for _ in 0..8 {
        match TcpListener::bind(("127.0.0.1", CALLBACK_PORT)) {
            Ok(listener) => return Ok(listener),
            Err(e) => last_error = Some(e),
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let e = last_error.unwrap();
    Err(match e.kind() {
        ErrorKind::AddrInUse | ErrorKind::PermissionDenied => format!(
            "本地端口 {CALLBACK_PORT} 已被占用，无法接收登录回调。请关闭占用该端口的程序后重试。"
        ),
        _ => format!("无法在本地端口 {CALLBACK_PORT} 上监听登录回调：{e}"),
    })
}

fn read_request_line(stream: &mut TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while buf.len() < 16 * 1024 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let text = String::from_utf8_lossy(&buf);
    text.lines().next().unwrap_or_default().to_string()
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

// Blocks until the browser reports back, the attempt is superseded, or 5 minutes pass
fn wait_for_login_code(listener: TcpListener, expected_state: &str, generation: u64) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("无法监听登录回调：{e}"))?;
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        if LOGIN_GENERATION.load(Ordering::SeqCst) != generation {
            return Err("登录已取消。".to_string());
        }
        if Instant::now() >= deadline {
            return Err("登录超时：5 分钟内未完成登录，请重新登录。".to_string());
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(format!("登录回调监听出错：{e}")),
        };
        let _ = stream.set_nonblocking(false);
        match oauth::parse_request_line(&read_request_line(&mut stream)) {
            Route::Page => respond(&mut stream, "200 OK", "text/html", CALLBACK_PAGE),
            Route::Callback(params) => match oauth::validate_callback(&params, expected_state) {
                Ok(code) => {
                    respond(&mut stream, "200 OK", "text/plain", "ok");
                    return Ok(code);
                }
                // a request without our state did not come from this login; reject it and keep waiting
                Err(CallbackError::StateMismatch) => {
                    respond(&mut stream, "400 Bad Request", "text/plain", "invalid callback");
                }
                Err(e) => {
                    respond(&mut stream, "400 Bad Request", "text/plain", "invalid callback");
                    return Err(e.message());
                }
            },
            Route::NotFound => respond(&mut stream, "404 Not Found", "text/plain", "not found"),
        }
    }
}

// ---------- commands ----------

#[tauri::command]
pub async fn logos_account_login(app: tauri::AppHandle) -> Result<AccountStatus, String> {
    let generation = LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let listener = tauri::async_runtime::spawn_blocking(bind_callback_listener)
        .await
        .map_err(|e| e.to_string())??;

    let verifier = oauth::generate_verifier();
    let state = oauth::generate_state();
    let login_url = oauth::build_login_url(&phainon_base(), &state, &oauth::challenge_s256(&verifier));
    // ShellExecute on Windows: opens the default browser without a console window
    tauri::api::shell::open(&app.shell_scope(), &login_url, None).map_err(|e| format!("无法打开浏览器：{e}"))?;
    info!("Logos account login started");

    let login_code = tauri::async_runtime::spawn_blocking(move || wait_for_login_code(listener, &state, generation))
        .await
        .map_err(|e| e.to_string())??;

    let mut session = SESSION.lock().await;
    let data = phainon_request(
        "POST",
        "/auth/exchange",
        Some(json!({ "login_code": login_code, "code_verifier": verifier })),
        None,
    )
    .await
    .map_err(|e| e.message())?;
    apply_token_pair(&mut session, &data)?;
    session.user = None;
    fetch_user(&mut session).await;
    info!("Logos account login completed");
    Ok(AccountStatus { logged_in: true, user: session.user.clone() })
}

#[tauri::command]
pub fn logos_account_cancel_login() {
    LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub async fn logos_account_token() -> Result<Option<String>, String> {
    let mut session = SESSION.lock().await;
    ensure_access_token(&mut session).await
}

#[tauri::command]
pub async fn logos_account_status() -> Result<AccountStatus, String> {
    let mut session = SESSION.lock().await;
    let token = ensure_access_token(&mut session).await?;
    if token.is_some() && session.user.is_none() {
        fetch_user(&mut session).await;
    }
    Ok(AccountStatus { logged_in: token.is_some(), user: session.user.clone() })
}

#[tauri::command]
pub async fn logos_account_logout() -> Result<(), String> {
    let mut session = SESSION.lock().await;
    // abandon a login that is still waiting for the browser
    LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(Some(refresh)) = load_refresh_token() {
        // best effort: the local credential is removed even if the server is unreachable
        if let Err(e) = phainon_request("POST", "/auth/logout", Some(json!({ "refresh_token": refresh })), None).await {
            warn!("Logos logout request failed: {}", e.message());
        }
    }
    clear_session(&mut session);
    Ok(())
}
