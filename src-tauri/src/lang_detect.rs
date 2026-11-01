// https://crates.io/crates/lingua
use lingua::{Language, LanguageDetector, LanguageDetectorBuilder};
use once_cell::sync::Lazy;

// Built on first use only; building the detector is expensive
static DETECTOR: Lazy<LanguageDetector> = Lazy::new(|| {
    let languages = vec![
        Language::Chinese,
        Language::Japanese,
        Language::English,
        Language::Korean,
        Language::French,
        Language::Spanish,
        Language::German,
        Language::Russian,
        Language::Italian,
        Language::Portuguese,
        Language::Turkish,
        Language::Arabic,
        Language::Vietnamese,
        Language::Thai,
        Language::Indonesian,
        Language::Malay,
        Language::Hindi,
        Language::Mongolian,
        Language::Bokmal,
        Language::Nynorsk,
        Language::Persian,
        Language::Ukrainian,
    ];
    LanguageDetectorBuilder::from_languages(&languages).build()
});

#[tauri::command]
pub fn lang_detect(text: &str) -> Result<&str, ()> {
    if let Some(lang) = DETECTOR.detect_language_of(text) {
        match lang {
            Language::Chinese => Ok("zh_cn"),
            Language::Japanese => Ok("ja"),
            Language::English => Ok("en"),
            Language::Korean => Ok("ko"),
            Language::French => Ok("fr"),
            Language::Spanish => Ok("es"),
            Language::German => Ok("de"),
            Language::Russian => Ok("ru"),
            Language::Italian => Ok("it"),
            Language::Portuguese => Ok("pt_pt"),
            Language::Turkish => Ok("tr"),
            Language::Arabic => Ok("ar"),
            Language::Vietnamese => Ok("vi"),
            Language::Thai => Ok("th"),
            Language::Indonesian => Ok("id"),
            Language::Malay => Ok("ms"),
            Language::Hindi => Ok("hi"),
            Language::Mongolian => Ok("mn_cy"),
            Language::Bokmal => Ok("nb_no"),
            Language::Nynorsk => Ok("nn_no"),
            Language::Persian => Ok("fa"),
            Language::Ukrainian => Ok("uk"),
        }
    } else {
        return Ok("en");
    }
}
