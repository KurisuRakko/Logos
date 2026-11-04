// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cmd;
mod config;
mod error;
mod hotkey;
mod lang_detect;
mod logos_account;
mod screenshot;
mod system_ocr;
mod tray;
mod window;

use cmd::*;
use config::*;
use hotkey::*;
use lang_detect::*;
use logos_account::*;
use log::info;
use once_cell::sync::OnceCell;
use screenshot::{get_screenshot_target, screenshot};
use std::sync::Mutex;
use system_ocr::*;
use tauri::api::notification::Notification;
use tauri::Manager;
use tauri_plugin_log::LogTarget;
use tray::*;
use window::config_window;
use window::text_translate;

// Global AppHandle
pub static APP: OnceCell<tauri::AppHandle> = OnceCell::new();

// Text to be translated
pub struct StringWrapper(pub Mutex<String>);

const RETRY_FLAG: &str = "--logos-retry";

fn panic_log_path() -> Option<std::path::PathBuf> {
    // 与 tauri v1 app_log_dir 保持一致，不依赖 tauri 状态
    #[cfg(target_os = "macos")]
    let base = dirs::home_dir().map(|h| h.join("Library/Logs"));
    #[cfg(not(target_os = "macos"))]
    let base = dirs::config_dir();
    let dir = base?.join("com.pot-app.desktop");
    #[cfg(not(target_os = "macos"))]
    let dir = dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("panic.log"))
}

fn write_panic_log(msg: &str) {
    use std::io::Write;
    let Some(path) = panic_log_path() else { return };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            f,
            "[unix {}] [v{}] [pid {}] {}",
            ts,
            env!("CARGO_PKG_VERSION"),
            std::process::id(),
            msg
        );
    }
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let bt = std::backtrace::Backtrace::force_capture();
        write_panic_log(&format!("panic at {}: {}\nbacktrace:\n{}", location, payload, bt));
        default_hook(info);
    }));
}

// 重启自身：子进程带 RETRY_FLAG，启动后先等待再构建，确保本进程（持有单实例锁）已退出
fn relaunch_with_retry_flag() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.args(std::env::args_os().skip(1)).arg(RETRY_FLAG);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ())
}

fn main() {
    install_panic_hook();
    let is_retry = std::env::args().any(|a| a == RETRY_FLAG);
    if is_retry {
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, cwd| {
            Notification::new(&app.config().tauri.bundle.identifier)
                .title("The program is already running. Please do not start it again!")
                .body(cwd)
                .icon("pot")
                .show()
                .unwrap();
        }))
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([LogTarget::LogDir, LogTarget::Stdout])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs_watch::init())
        .system_tray(tauri::SystemTray::new())
        .setup(|app| {
            info!("============== Start App ==============");
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let trusted =
                    macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
                info!("MacOS Accessibility Trusted: {}", trusted);
            }
            // Global AppHandle
            APP.get_or_init(|| app.handle());
            // Init Config
            info!("Init Config Store");
            init_config(app);
            // Check First Run
            if is_first_run() {
                // Open Config Window
                info!("First Run, opening config window");
                config_window();
            }
            app.manage(StringWrapper(Mutex::new("".to_string())));
            // Update Tray Menu
            update_tray(app.app_handle(), "".to_string(), "".to_string());
            // Register Global Shortcut
            match register_shortcut("all") {
                Ok(()) => {}
                Err(e) => Notification::new(app.config().tauri.bundle.identifier.clone())
                    .title("Failed to register global shortcut")
                    .body(&e)
                    .icon("pot")
                    .show()
                    .unwrap(),
            }
            match get("proxy_enable") {
                Some(v) => {
                    if v.as_bool().unwrap() && get("proxy_host").map_or(false, |host| !host.as_str().unwrap().is_empty()) {
                        let _ = set_proxy();
                    }
                }
                None => {}
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reload_store,
            get_text,
            cut_image,
            get_base64,
            copy_img,
            system_ocr,
            set_proxy,
            unset_proxy,
            text_translate,
            register_shortcut_by_frontend,
            update_tray,
            screenshot,
            get_screenshot_target,
            lang_detect,
            font_list,
            logos_account_login,
            logos_account_cancel_login,
            logos_account_token,
            logos_account_status,
            logos_account_logout
        ])
        .on_system_tray_event(tray_event_handler);
    info!("Building app");
    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(e) => {
            let msg = format!("error while building tauri application: {:?}", e);
            log::error!("{}", msg);
            write_panic_log(&msg);
            let is_webview_err = msg.contains("CreateWebview");
            if is_webview_err && !is_retry {
                match relaunch_with_retry_flag() {
                    Ok(()) => write_panic_log("relaunched with retry flag"),
                    Err(re) => write_panic_log(&format!("relaunch failed: {}", re)),
                }
            }
            log::logger().flush();
            std::process::exit(1);
        }
    };
    info!("App built");
    // 窗口关闭不退出
    app.run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
