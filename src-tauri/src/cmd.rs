use crate::config::get;
use crate::config::StoreWrapper;
use crate::error::Error;
use crate::screenshot::{cache_file, cut_screenshot, SCREENSHOT_CUT};
use crate::StringWrapper;
use crate::APP;
use log::{error, info};
use tauri::Manager;

#[tauri::command]
pub fn get_text(state: tauri::State<StringWrapper>) -> String {
    return state.0.lock().unwrap().to_string();
}

#[tauri::command]
pub fn reload_store() {
    let state = APP.get().unwrap().state::<StoreWrapper>();
    let mut store = state.0.lock().unwrap();
    store.load().unwrap();
}

#[tauri::command]
pub fn cut_image(left: u32, top: u32, width: u32, height: u32) {
    info!("Cut image: {}x{}+{}+{}", width, height, left, top);
    cut_screenshot(left, top, width, height);
}

#[tauri::command]
pub fn get_base64() -> String {
    use base64::{engine::general_purpose, Engine as _};
    // Use the PNG encoded by cut_image; read the file only when memory is stale
    if let Some(cut) = SCREENSHOT_CUT.lock().unwrap().as_ref() {
        if cut.is_current() {
            return general_purpose::STANDARD.encode(&cut.png);
        }
    }
    let path = cache_file("pot_screenshot_cut.png");
    if !path.exists() {
        return "".to_string();
    }
    match std::fs::read(path) {
        Ok(v) => general_purpose::STANDARD.encode(&v),
        Err(e) => {
            error!("{:?}", e.to_string());
            "".to_string()
        }
    }
}

#[tauri::command]
pub fn copy_img(width: usize, height: usize) -> Result<(), Error> {
    use arboard::{Clipboard, ImageData};
    use std::borrow::Cow;

    let guard = SCREENSHOT_CUT.lock().unwrap();
    let decoded;
    let bytes: &[u8] = match guard.as_ref() {
        Some(cut) if cut.is_current() => cut.image.as_raw(),
        _ => {
            decoded = image::open(cache_file("pot_screenshot_cut.png"))?.into_rgba8();
            decoded.as_raw()
        }
    };

    let img = ImageData {
        width,
        height,
        bytes: Cow::from(bytes),
    };
    let result = Clipboard::new()?.set_image(img)?;
    Ok(result)
}

#[tauri::command]
pub fn set_proxy() -> Result<bool, ()> {
    let host = match get("proxy_host") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => return Err(()),
    };
    let port = match get("proxy_port") {
        Some(v) => v.as_i64().unwrap(),
        None => return Err(()),
    };
    let no_proxy = match get("no_proxy") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => return Err(()),
    };
    let proxy = format!("http://{}:{}", host, port);

    std::env::set_var("http_proxy", &proxy);
    std::env::set_var("https_proxy", &proxy);
    std::env::set_var("all_proxy", &proxy);
    std::env::set_var("no_proxy", &no_proxy);
    Ok(true)
}

#[tauri::command]
pub fn unset_proxy() -> Result<bool, ()> {
    std::env::remove_var("http_proxy");
    std::env::remove_var("https_proxy");
    std::env::remove_var("all_proxy");
    std::env::remove_var("no_proxy");
    Ok(true)
}

#[tauri::command]
pub fn font_list() -> Result<Vec<String>, Error> {
    use font_kit::source::SystemSource;
    let source = SystemSource::new();

    Ok(source.all_families()?)
}

