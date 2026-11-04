use crate::config::get;
use crate::config::set;
use crate::StringWrapper;
use crate::APP;
#[cfg(target_os = "macos")]
use dirs::cache_dir;
use log::{info, warn};
#[cfg(target_os = "macos")]
use std::fs;
use tauri::Manager;
use tauri::Monitor;
use tauri::Window;
use tauri::WindowBuilder;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use window_shadows::set_shadow;

// Get daemon window instance
fn get_daemon_window() -> Window {
    let app_handle = APP.get().unwrap();
    match app_handle.get_window("daemon") {
        Some(v) => v,
        None => {
            warn!("Daemon window not found, create new daemon window!");
            WindowBuilder::new(
                app_handle,
                "daemon",
                tauri::WindowUrl::App("daemon.html".into()),
            )
            .title("Daemon")
            .additional_browser_args("--disable-web-security")
            .visible(false)
            .build()
            .unwrap()
        }
    }
}

// Get monitor where the mouse is currently located
fn get_current_monitor(x: i32, y: i32) -> Monitor {
    info!("Mouse position: {}, {}", x, y);
    let daemon_window = get_daemon_window();
    let monitors = daemon_window.available_monitors().unwrap();

    for m in monitors {
        let size = m.size();
        let position = m.position();

        if x >= position.x
            && x <= (position.x + size.width as i32)
            && y >= position.y
            && y <= (position.y + size.height as i32)
        {
            info!("Current Monitor: {:?}", m);
            return m;
        }
    }
    warn!("Current Monitor not found, using primary monitor");
    daemon_window.primary_monitor().unwrap().unwrap()
}

// Creating a window on the mouse monitor
fn build_window(label: &str, title: &str) -> (Window, bool) {
    use mouse_position::mouse_position::{Mouse, Position};

    let mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };
    let current_monitor = get_current_monitor(mouse_position.x, mouse_position.y);
    let position = current_monitor.position();

    let app_handle = APP.get().unwrap();
    match app_handle.get_window(label) {
        Some(v) => {
            // Windows are kept alive (the frontend hides instead of closing).
            // Callers finish sizing/positioning first and then call `reactivate`
            info!("Window existence: {}", label);
            (v, true)
        }
        None => {
            info!("Window not existence, Creating new window: {}", label);
            let mut builder = tauri::WindowBuilder::new(
                app_handle,
                label,
                tauri::WindowUrl::App("index.html".into()),
            )
            .position(position.x.into(), position.y.into())
            .additional_browser_args("--disable-web-security")
            .focused(true)
            .title(title)
            .visible(false);

            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            // Opaque on purpose: on some WebView2 setups the transparent areas render black
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.decorations(false);
            }
            let window = builder.build().unwrap();

            if label != "screenshot" {
                #[cfg(not(target_os = "linux"))]
                set_shadow(&window, true).unwrap_or_default();
                #[cfg(target_os = "windows")]
                round_corners(&window);
            }
            let _ = window.current_monitor();
            (window, false)
        }
    }
}

// Windows 11 does not round undecorated windows by itself; earlier versions ignore the attribute
#[cfg(target_os = "windows")]
fn round_corners(window: &Window) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    if let Ok(hwnd) = window.hwnd() {
        let preference = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                HWND(hwnd.0 as _),
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &preference as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&preference) as u32,
            );
        }
    }
}

// Bring a reused window back and tell the page it has been reactivated
fn reactivate(window: &Window, show: bool) {
    if show {
        window.show().unwrap_or_default();
        window.set_focus().unwrap_or_default();
    }
    window.emit("window_reactivate", ()).unwrap_or_default();
}

pub fn config_window() {
    let (window, exists) = build_window("config", "Config");
    window
        .set_min_size(Some(tauri::LogicalSize::new(800, 400)))
        .unwrap();
    window.set_size(tauri::LogicalSize::new(800, 600)).unwrap();
    window.center().unwrap();
    if exists {
        reactivate(&window, true);
    }
}

fn translate_window() -> Window {
    use mouse_position::mouse_position::{Mouse, Position};
    // Mouse physical position
    let mut mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };
    let (window, exists) = build_window("translate", "Translate");
    window.set_skip_taskbar(true).unwrap();
    // Get Translate Window Size
    let width = match get("translate_window_width") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("translate_window_width", 350);
            350
        }
    };
    let height = match get("translate_window_height") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("translate_window_height", 420);
            420
        }
    };

    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();

    window
        .set_size(tauri::PhysicalSize::new(
            (width as f64) * dpi,
            (height as f64) * dpi,
        ))
        .unwrap();

    let position_type = match get("translate_window_position") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => "mouse".to_string(),
    };

    match position_type.as_str() {
        "mouse" => {
            // Adjust window position
            let monitor_size = monitor.size();
            let monitor_size_width = monitor_size.width as f64;
            let monitor_size_height = monitor_size.height as f64;
            let monitor_position = monitor.position();
            let monitor_position_x = monitor_position.x as f64;
            let monitor_position_y = monitor_position.y as f64;

            if mouse_position.x as f64 + width as f64 * dpi
                > monitor_position_x + monitor_size_width
            {
                mouse_position.x -= (width as f64 * dpi) as i32;
                if (mouse_position.x as f64) < monitor_position_x {
                    mouse_position.x = monitor_position_x as i32;
                }
            }
            if mouse_position.y as f64 + height as f64 * dpi
                > monitor_position_y + monitor_size_height
            {
                mouse_position.y -= (height as f64 * dpi) as i32;
                if (mouse_position.y as f64) < monitor_position_y {
                    mouse_position.y = monitor_position_y as i32;
                }
            }

            window
                .set_position(tauri::PhysicalPosition::new(
                    mouse_position.x,
                    mouse_position.y,
                ))
                .unwrap();
        }
        _ => {
            let position_x = match get("translate_window_position_x") {
                Some(v) => v.as_i64().unwrap(),
                None => 0,
            };
            let position_y = match get("translate_window_position_y") {
                Some(v) => v.as_i64().unwrap(),
                None => 0,
            };
            window
                .set_position(tauri::PhysicalPosition::new(
                    (position_x as f64) * dpi,
                    (position_y as f64) * dpi,
                ))
                .unwrap();
        }
    }

    if exists {
        reactivate(&window, true);
    }
    window
}

pub fn selection_translate() {
    use selection::get_text;
    // Get Selected Text
    let text = get_text();
    if !text.trim().is_empty() {
        let app_handle = APP.get().unwrap();
        // Write into State
        let state: tauri::State<StringWrapper> = app_handle.state();
        state.0.lock().unwrap().replace_range(.., &text);
    }

    let window = translate_window();
    window.emit("new_text", text).unwrap();
}

#[tauri::command(async)]
pub fn text_translate(text: String) {
    if !text.trim().is_empty() {
        let app_handle = APP.get().unwrap();
        let state: tauri::State<StringWrapper> = app_handle.state();
        state.0.lock().unwrap().replace_range(.., &text);
    }
    let window = translate_window();
    window.emit("new_text", text).unwrap();
}

pub fn input_translate() {
    let app_handle = APP.get().unwrap();
    // Clear State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[INPUT_TRANSLATE]");
    let window = translate_window();
    let position_type = match get("translate_window_position") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => "mouse".to_string(),
    };
    if position_type == "mouse" {
        window.center().unwrap();
    }

    window.emit("new_text", "[INPUT_TRANSLATE]").unwrap();
}

pub fn image_translate() {
    let app_handle = APP.get().unwrap();
    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[IMAGE_TRANSLATE]");
    let window = translate_window();
    window.emit("new_text", "[IMAGE_TRANSLATE]").unwrap();
}

#[cfg(not(target_os = "macos"))]
fn screenshot_window() -> Window {
    // Load the local OCR models while the user is still selecting a region
    crate::paddle_ocr::preload();
    // A visible translate window would end up in the capture
    if let Some(translate) = APP.get().unwrap().get_window("translate") {
        if translate.is_visible().unwrap_or(false) {
            translate.hide().unwrap_or_default();
        }
    }
    let (window, exists) = build_window("screenshot", "Screenshot");

    // The monitor under the mouse; the page captures this one instead of asking currentMonitor(),
    // which can still report the old monitor right after the hidden window is moved
    use mouse_position::mouse_position::Mouse;
    let (x, y) = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x, y),
        Mouse::Error => (0, 0),
    };
    let position = *get_current_monitor(x, y).position();
    *crate::screenshot::SCREENSHOT_TARGET.lock().unwrap() = Some((position.x, position.y));

    if exists {
        // Move the reused window to the target monitor before going fullscreen again
        window.set_fullscreen(false).unwrap_or_default();
        window
            .set_position(tauri::PhysicalPosition::new(position.x, position.y))
            .unwrap_or_default();
    }
    window.set_skip_taskbar(true).unwrap();
    #[cfg(target_os = "macos")]
    {
        let monitor = window.current_monitor().unwrap().unwrap();
        let size = monitor.size();
        window.set_decorations(false).unwrap();
        window.set_size(*size).unwrap();
    }

    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(true).unwrap();

    window.set_always_on_top(true).unwrap();
    if exists {
        // Not shown here: the page captures the screen first and shows itself once the
        // new image is loaded, otherwise the capture would contain this window
        window
            .emit(
                "window_reactivate",
                serde_json::json!({ "x": position.x, "y": position.y }),
            )
            .unwrap_or_default();
    }
    window
}

// Only one pending "success" listener on the screenshot window; a cancelled
// screenshot (window hidden, not closed) must not leave its listener behind
#[cfg(not(target_os = "macos"))]
static SCREENSHOT_LISTENER: std::sync::Mutex<Option<tauri::EventHandler>> =
    std::sync::Mutex::new(None);

#[cfg(not(target_os = "macos"))]
fn on_screenshot_success<F>(handler: F)
where
    F: Fn() + Send + 'static,
{
    let window = screenshot_window();
    let mut pending = SCREENSHOT_LISTENER.lock().unwrap();
    if let Some(old) = pending.take() {
        window.unlisten(old);
    }
    let window_ = window.clone();
    *pending = Some(window.listen("success", move |event| {
        window_.unlisten(event.id());
        let mut pending = SCREENSHOT_LISTENER.lock().unwrap();
        if *pending == Some(event.id()) {
            *pending = None;
        }
        drop(pending);
        handler();
    }));
}

pub fn ocr_translate() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            image_translate();
            ();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        on_screenshot_success(image_translate);
    }
}
