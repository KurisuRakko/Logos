use image::{ImageError, RgbaImage};
use log::{error, info};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

// Last full-screen capture, kept in memory so cut_image does not decode the PNG again
pub static SCREENSHOT: Mutex<Option<RgbaImage>> = Mutex::new(None);
// Last cut result, shared by get_base64 / copy_img / system_ocr
pub static SCREENSHOT_CUT: Mutex<Option<CutImage>> = Mutex::new(None);

pub struct CutImage {
    pub image: RgbaImage,
    // Encoded PNG of `image`
    pub png: Vec<u8>,
    // mtime of pot_screenshot_cut.png right after we wrote it; if the file changes
    // afterwards (written by someone else), the in-memory copy is stale
    pub file_mtime: Option<SystemTime>,
}

impl CutImage {
    pub fn is_current(&self) -> bool {
        match (self.file_mtime, file_mtime(&cache_file("pot_screenshot_cut.png"))) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        }
    }
}

// Path of a file in the app cache dir, creating the dir if needed
pub fn cache_file(name: &str) -> PathBuf {
    use crate::APP;
    use dirs::cache_dir;
    let handle = APP.get().unwrap();
    let mut path = cache_dir().expect("Get Cache Dir Failed");
    path.push(&handle.config().tauri.bundle.identifier);
    if !path.exists() {
        std::fs::create_dir_all(&path).expect("Create Cache Dir Failed");
    }
    path.push(name);
    path
}

fn file_mtime(path: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

// PNG encoding tuned for speed rather than size
pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, ImageError> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};
    let mut buffer = Vec::new();
    PngEncoder::new_with_quality(&mut buffer, CompressionType::Fast, FilterType::Sub)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            ExtendedColorType::Rgba8,
        )?;
    Ok(buffer)
}

// Crop the last screenshot and keep the result in memory; also written to
// pot_screenshot_cut.png because some recognize services read that file
pub fn cut_screenshot(left: u32, top: u32, width: u32, height: u32) {
    use image::imageops::crop_imm;
    let cut = {
        let mut guard = SCREENSHOT.lock().unwrap();
        if guard.is_none() {
            // Fallback: memory empty, load the full screenshot from disk
            match image::open(cache_file("pot_screenshot.png")) {
                Ok(v) => *guard = Some(v.into_rgba8()),
                Err(e) => {
                    error!("{:?}", e.to_string());
                    return;
                }
            }
        }
        let full = guard.as_ref().unwrap();
        crop_imm(full, left, top, width, height).to_image()
    };
    let png = match encode_png(&cut) {
        Ok(v) => v,
        Err(e) => {
            error!("{:?}", e.to_string());
            return;
        }
    };
    let path = cache_file("pot_screenshot_cut.png");
    let file_mtime = match std::fs::write(&path, &png) {
        Ok(_) => file_mtime(&path),
        Err(e) => {
            error!("{:?}", e.to_string());
            None
        }
    };
    *SCREENSHOT_CUT.lock().unwrap() = Some(CutImage {
        image: cut,
        png,
        file_mtime,
    });
}

#[tauri::command]
pub fn screenshot(x: i32, y: i32) {
    use screenshots::{Compression, Screen};
    info!("Screenshot screen with position: x={}, y={}", x, y);
    let screens = Screen::all().unwrap();
    for screen in screens {
        let info = screen.display_info;
        info!("Screen: {:?}", info);
        if info.x == x && info.y == y {
            let image = screen.capture().unwrap();
            // The screenshot window displays this file, so it still has to be written
            let buffer = image.to_png(Compression::Fast).unwrap();
            std::fs::write(cache_file("pot_screenshot.png"), buffer).unwrap();
            *SCREENSHOT.lock().unwrap() =
                RgbaImage::from_raw(image.width(), image.height(), image.rgba().clone());
            break;
        }
    }
}
