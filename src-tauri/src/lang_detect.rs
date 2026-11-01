// https://crates.io/crates/whatlang
// Pure Rust trigram detector with no bundled models, replacing lingua to keep the binary small.
use whatlang::Lang;

#[tauri::command]
pub fn lang_detect(text: &str) -> Result<&str, ()> {
    Ok(detect(text))
}

/// Returns the pot language code for `text`, falling back to "en" when unsure.
pub fn detect(text: &str) -> &'static str {
    if let Some(code) = detect_cjk(text) {
        return code;
    }
    match whatlang::detect_lang(text) {
        Some(lang) => map_lang(lang).unwrap_or("en"),
        None => "en",
    }
}

// Decide CJK by script first: whatlang is weak on short mixed Han/kana text.
// Any kana means Japanese, Hangul means Korean, mostly-Han means Chinese.
fn detect_cjk(text: &str) -> Option<&'static str> {
    let (mut han, mut kana, mut hangul, mut letters) = (0usize, 0usize, 0usize, 0usize);
    for c in text.chars() {
        match c as u32 {
            0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F => kana += 1,
            0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF => hangul += 1,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FFFF => han += 1,
            _ if c.is_alphabetic() => letters += 1,
            _ => continue,
        }
    }
    if kana > 0 {
        Some("ja")
    } else if hangul > 0 && hangul >= han {
        Some("ko")
    } else if han > 0 && han >= letters {
        Some("zh_cn")
    } else {
        None
    }
}

fn map_lang(lang: Lang) -> Option<&'static str> {
    Some(match lang {
        Lang::Cmn => "zh_cn",
        Lang::Jpn => "ja",
        Lang::Eng => "en",
        Lang::Kor => "ko",
        Lang::Fra => "fr",
        Lang::Spa => "es",
        Lang::Deu => "de",
        Lang::Rus => "ru",
        Lang::Ita => "it",
        Lang::Por => "pt_pt",
        Lang::Tur => "tr",
        Lang::Ara => "ar",
        Lang::Vie => "vi",
        Lang::Tha => "th",
        Lang::Ind => "id",
        Lang::Hin => "hi",
        Lang::Nob => "nb_no",
        Lang::Pes => "fa",
        Lang::Ukr => "uk",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::detect;

    #[test]
    fn detects_common_languages() {
        assert_eq!(detect("今天天气很好，我们去公园散步吧。"), "zh_cn");
        assert_eq!(detect("今日はいい天気ですね。"), "ja");
        assert_eq!(detect("東京都"), "zh_cn"); // kanji only is ambiguous; treated as Chinese
        assert_eq!(detect("오늘 날씨가 정말 좋네요."), "ko");
        assert_eq!(detect("The weather is really nice today."), "en");
        assert_eq!(detect("Сегодня очень хорошая погода."), "ru");
        assert_eq!(detect("Il fait très beau aujourd'hui, allons au parc."), "fr");
    }
}
