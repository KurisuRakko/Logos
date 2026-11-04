// Local PaddleOCR recognition (logos-ocr crate). Nothing is loaded at startup: the models start
// loading in the background when a screenshot begins, and are released after
// logos_ocr::DEFAULT_IDLE_UNLOAD without use.

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::screenshot::{cache_file, SCREENSHOT_CUT};
    use crate::APP;
    use image::buffer::ConvertBuffer;
    use image::RgbImage;
    use log::{error, info};
    use logos_ocr::{OcrService, DEFAULT_IDLE_UNLOAD, REC_MODEL};
    use once_cell::sync::Lazy;
    use std::path::PathBuf;

    static OCR: Lazy<OcrService> = Lazy::new(|| OcrService::new(DEFAULT_IDLE_UNLOAD));

    const MODELS_MISSING: &str =
        "The PaddleOCR model files were not found. Reinstall Logos to restore them.";

    // Bundled resource dir; dev builds also accept the copy fetched into src-tauri/resources
    // by scripts/fetch-ocr-models.mjs
    fn model_dir() -> Result<PathBuf, String> {
        let app = APP.get().ok_or_else(|| MODELS_MISSING.to_string())?;
        let mut candidates = Vec::new();
        if let Some(dir) = app.path_resolver().resolve_resource("resources/paddle-ocr") {
            candidates.push(dir);
        }
        #[cfg(debug_assertions)]
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/paddle-ocr"));
        candidates
            .into_iter()
            .find(|dir| dir.join(REC_MODEL).exists())
            .ok_or_else(|| MODELS_MISSING.to_string())
    }

    // Preloading is only worth it when paddle is one of the configured recognize services;
    // a missing list means the default one, which starts with paddle
    fn paddle_in_use() -> bool {
        match crate::config::get("recognize_service_list") {
            Some(serde_json::Value::Array(list)) => list.iter().any(|key| {
                key.as_str()
                    .map_or(false, |key| key.split('@').next() == Some("paddle"))
            }),
            _ => true,
        }
    }

    pub fn preload() {
        if !paddle_in_use() {
            return;
        }
        match model_dir() {
            Ok(dir) => {
                if !OCR.is_loaded() {
                    info!("Preloading PaddleOCR models");
                }
                OCR.preload(dir)
            }
            Err(e) => error!("{e}"),
        }
    }

    // Same source as system_ocr: the in-memory cut, or the cut file when memory is stale
    fn cut_image() -> Result<RgbImage, String> {
        if let Some(cut) = SCREENSHOT_CUT.lock().unwrap().as_ref() {
            if cut.is_current() {
                return Ok(cut.image.convert());
            }
        }
        image::open(cache_file("pot_screenshot_cut.png"))
            .map(|img| img.into_rgb8())
            .map_err(|e| e.to_string())
    }

    pub fn recognize() -> Result<String, String> {
        let dir = model_dir()?;
        let img = cut_image()?;
        OCR.recognize(&dir, &img)
    }
}

#[cfg(not(target_os = "macos"))]
pub use imp::preload;

// One model covers Simplified Chinese, Traditional Chinese and English; `lang` is accepted for
// the common recognize-service interface, and unsupported languages are filtered by the frontend.
#[tauri::command(async)]
#[cfg(not(target_os = "macos"))]
pub fn paddle_ocr(lang: &str) -> Result<String, String> {
    log::info!("PaddleOCR recognize, language: {lang}");
    imp::recognize()
}

#[tauri::command(async)]
#[cfg(target_os = "macos")]
pub fn paddle_ocr(_lang: &str) -> Result<String, String> {
    Err("PaddleOCR is not available on macOS.".to_string())
}
