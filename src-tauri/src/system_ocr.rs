use dirs::cache_dir;

#[cfg(any(target_os = "windows", test))]
fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x2E80..=0x2FDF
            | 0x3000..=0x30FF
            | 0x3100..=0x318F
            | 0x31C0..=0x32FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA960..=0xA97F
            | 0xAC00..=0xD7FF
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE1F
            | 0xFE30..=0xFE4F
            | 0xFF00..=0xFFEF
            | 0x20000..=0x2FA1F
    )
}

#[cfg(any(target_os = "windows", test))]
fn join_words(words: &[String]) -> String {
    let mut text = String::new();
    let mut prev = None;
    for word in words {
        if let (Some(last), Some(first)) = (prev, word.chars().next()) {
            if !is_cjk(last) && !is_cjk(first) {
                text.push(' ');
            }
        }
        if let Some(last) = word.chars().last() {
            prev = Some(last);
        }
        text.push_str(word);
    }
    text
}

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
const OCR_LANGUAGE_PACK_ERROR: &str = "No Windows OCR language pack is installed. See: https://learn.microsoft.com/zh-cn/windows/powertoys/text-extractor#supported-languages";

#[cfg(target_os = "windows")]
fn map_ocr_error(e: windows::core::Error) -> String {
    if e.to_string().contains("0x00000000") {
        OCR_LANGUAGE_PACK_ERROR.to_string()
    } else {
        e.to_string()
    }
}

#[cfg(target_os = "windows")]
fn create_auto_ocr_engine() -> Result<windows::Media::Ocr::OcrEngine, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    let mut tags = Vec::new();
    match OcrEngine::AvailableRecognizerLanguages() {
        Ok(languages) => {
            for language in languages {
                if let Ok(tag) = language.LanguageTag() {
                    tags.push(tag.to_string_lossy());
                }
            }
        }
        Err(e) => return Err(map_ocr_error(e)),
    }
    if tags.is_empty() {
        return Err(OCR_LANGUAGE_PACK_ERROR.to_string());
    }

    let app_language =
        crate::config::get("app_language").and_then(|v| v.as_str().map(str::to_string));
    let preferred = match app_language.as_deref() {
        Some("zh_cn") => Some("zh-Hans"),
        Some("zh_tw") => Some("zh-Hant"),
        Some("ja") => Some("ja"),
        Some("ko") => Some("ko"),
        _ => None,
    };
    let preferred_tag = preferred.and_then(|p| tags.iter().find(|t| t.starts_with(p)));
    let cjk_tag = ["zh-Hans", "zh-Hant", "ja", "ko"]
        .into_iter()
        .find_map(|p| tags.iter().find(|t| t.starts_with(p)));

    match preferred_tag.or(cjk_tag) {
        Some(tag) => Language::CreateLanguage(&HSTRING::from(tag.as_str()))
            .map_err(map_ocr_error)
            .and_then(|language| {
                OcrEngine::TryCreateFromLanguage(&language).map_err(map_ocr_error)
            }),
        None => OcrEngine::TryCreateFromUserProfileLanguages().map_err(map_ocr_error),
    }
}

#[cfg(target_os = "windows")]
fn get_ocr_engine(lang: &str) -> Result<windows::Media::Ocr::OcrEngine, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    if let Some(engine) = OCR_ENGINES.lock().unwrap().get(lang) {
        return Ok(engine.clone());
    }
    let engine = match lang {
        "auto" => create_auto_ocr_engine()?,
        _ => match Language::CreateLanguage(&HSTRING::from(lang)) {
            Ok(language) => OcrEngine::TryCreateFromLanguage(&language).map_err(map_ocr_error)?,
            Err(_) => return Err("Language Error".to_string()),
        },
    };
    // "auto" is cached under its own key; an app-language change applies from the next launch.
    OCR_ENGINES
        .lock()
        .unwrap()
        .insert(lang.to_string(), engine.clone());
    Ok(engine)
}

#[tauri::command(async)]
#[cfg(target_os = "windows")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let engine = get_ocr_engine(lang)?;

    let bitmap = match bitmap_from_memory() {
        Some(v) => v,
        None => bitmap_from_file(&app_handle).map_err(|e| e.to_string())?,
    };

    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|op| op.get())
        .map_err(|e| e.to_string())?;

    let mut lines = Vec::new();
    for line in result.Lines().map_err(|e| e.to_string())? {
        let mut words = Vec::new();
        for word in line.Words().map_err(|e| e.to_string())? {
            words.push(word.Text().map_err(|e| e.to_string())?.to_string_lossy());
        }
        lines.push(join_words(&words));
    }
    Ok(lines.join("\n"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_words_spaces_only_between_non_cjk_words() {
        let words: Vec<String> = ["打", "回", "的", "Rakko", "Design", "标", "准"]
            .iter()
            .map(|word| word.to_string())
            .collect();
        assert_eq!(join_words(&words), "打回的Rakko Design标准");
    }

    #[test]
    fn is_cjk_covers_han_kana_hangul_and_fullwidth_punctuation() {
        for c in ['汉', 'あ', 'ア', '한', '。', '，'] {
            assert!(is_cjk(c), "{c} should be CJK");
        }
        for c in ['A', 'z', ' ', '-'] {
            assert!(!is_cjk(c), "{c} should not be CJK");
        }
    }
}
