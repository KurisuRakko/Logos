use dirs::cache_dir;

// Build a SoftwareBitmap straight from the in-memory cut image (no file, no PNG decode)
#[cfg(target_os = "windows")]
fn bitmap_from_memory() -> Option<windows::Graphics::Imaging::SoftwareBitmap> {
    use crate::screenshot::SCREENSHOT_CUT;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Storage::Streams::DataWriter;

    let guard = SCREENSHOT_CUT.lock().unwrap();
    let cut = guard.as_ref()?;
    if !cut.is_current() {
        return None;
    }
    let (width, height) = cut.image.dimensions();
    // RGBA -> BGRA
    let mut bgra = cut.image.as_raw().clone();
    drop(guard);
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let writer = DataWriter::new().ok()?;
    writer.WriteBytes(&bgra).ok()?;
    let buffer = writer.DetachBuffer().ok()?;
    SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
    )
    .ok()
}

#[cfg(target_os = "windows")]
fn bitmap_from_file(
    app_handle: &tauri::AppHandle,
) -> windows::core::Result<windows::Graphics::Imaging::SoftwareBitmap> {
    use windows::core::HSTRING;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Storage::{FileAccessMode, StorageFile};

    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");

    let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.get()?;

    let bitmap = BitmapDecoder::CreateWithIdAsync(
        BitmapDecoder::PngDecoderId()?,
        &file.OpenAsync(FileAccessMode::Read)?.get()?,
    )?
    .get()?;

    bitmap.GetSoftwareBitmapAsync()?.get()
}

// OcrEngine is agile (Send + Sync), so engines are cached per language
#[cfg(target_os = "windows")]
static OCR_ENGINES: once_cell::sync::Lazy<
    std::sync::Mutex<std::collections::HashMap<String, windows::Media::Ocr::OcrEngine>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[cfg(target_os = "windows")]
fn get_ocr_engine(lang: &str) -> Result<windows::Media::Ocr::OcrEngine, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    if let Some(engine) = OCR_ENGINES.lock().unwrap().get(lang) {
        return Ok(engine.clone());
    }
    let engine = match lang {
        "auto" => OcrEngine::TryCreateFromUserProfileLanguages(),
        _ => {
            if let Ok(language) = Language::CreateLanguage(&HSTRING::from(lang)) {
                OcrEngine::TryCreateFromLanguage(&language)
            } else {
                return Err("Language Error".to_string());
            }
        }
    };
    match engine {
        Ok(v) => {
            OCR_ENGINES
                .lock()
                .unwrap()
                .insert(lang.to_string(), v.clone());
            Ok(v)
        }
        Err(e) => {
            if e.to_string().contains("0x00000000") {
                Err("Language package not installed!\n\nSee: https://learn.microsoft.com/zh-cn/windows/powertoys/text-extractor#supported-languages".to_string())
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[tauri::command(async)]
#[cfg(target_os = "windows")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let engine = get_ocr_engine(lang)?;

    let bitmap = match bitmap_from_memory() {
        Some(v) => v,
        None => bitmap_from_file(&app_handle).map_err(|e| e.to_string())?,
    };

    engine
        .RecognizeAsync(&bitmap)
        .and_then(|op| op.get())
        .and_then(|result| result.Text())
        .map(|text| text.to_string_lossy())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
#[cfg(target_os = "macos")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");

    let arch = std::env::consts::ARCH;
    let bin_path = match app_handle
        .path_resolver()
        .resolve_resource(format!("resources/ocr-{arch}-apple-darwin"))
    {
        Some(v) => v,
        None => return Err("Failed to resolve ocr binary".to_string()),
    };

    match std::process::Command::new("chmod")
        .arg("+x")
        .arg(bin_path.to_str().unwrap())
        .output()
    {
        Ok(_) => {}
        Err(e) => return Err(e.to_string()),
    }

    let output = match std::process::Command::new(bin_path)
        .arg(app_cache_dir_path.to_str().unwrap())
        .arg(lang)
        .output()
    {
        Ok(v) => v,
        Err(e) => return Err(e.to_string()),
    };

    if output.status.success() {
        let content = String::from_utf8(output.stdout).unwrap_or_default();
        Ok(content)
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();
        Err(content)
    }
}

#[tauri::command(async)]
#[cfg(target_os = "linux")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    let mut args = ["", ""];
    if lang != "auto" {
        args = ["-l", lang];
    }

    let output = match std::process::Command::new("tesseract")
        .arg(app_cache_dir_path.to_str().unwrap())
        .arg("stdout")
        .args(args)
        .output()
    {
        Ok(v) => v,
        Err(e) => {
            if e.to_string().contains("os error 2") {
                return Err("Tesseract not installed!".to_string());
            }
            return Err(e.to_string());
        }
    };
    if output.status.success() {
        let content = String::from_utf8(output.stdout).unwrap_or_default();
        Ok(content)
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();

        if content.contains("data") {
            if lang == "auto" {
                return Err(
                    "Language data not installed!\nPlease try install tesseract-ocr-eng"
                        .to_string(),
                );
            } else {
                return Err(format!(
                    "Language data not installed!\nPlease try install tesseract-ocr-{lang}"
                ));
            }
        }
        Err(content)
    }
}
