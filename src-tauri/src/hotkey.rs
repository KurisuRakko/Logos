use crate::config::{get, set};
use crate::window::{input_translate, ocr_recognize, ocr_translate, selection_translate};
use crate::APP;
use log::{info, warn};
use tauri::{AppHandle, GlobalShortcutManager};

const MODIFIER_KEYS: [&str; 11] = [
    "ctrl",
    "control",
    "shift",
    "alt",
    "option",
    "super",
    "command",
    "cmd",
    "commandorcontrol",
    "cmdorctrl",
    "meta",
];

fn is_modifier_key(part: &str) -> bool {
    let part = part.trim().to_ascii_lowercase();
    MODIFIER_KEYS.contains(&part.as_str())
}

// A valid global shortcut must contain at least one key that is not a modifier.
fn contains_non_modifier_key(hotkey: &str) -> bool {
    hotkey
        .split('+')
        .any(|part| !part.trim().is_empty() && !is_modifier_key(part))
}

fn register<F>(app_handle: &AppHandle, name: &str, handler: F, key: &str) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    let hotkey = {
        if key.is_empty() {
            match get(name) {
                Some(v) => v.as_str().unwrap().to_string(),
                None => {
                    set(name, "");
                    String::new()
                }
            }
        } else {
            key.to_string()
        }
    };

    if !hotkey.is_empty() && !contains_non_modifier_key(&hotkey) {
        if key.is_empty() {
            // The value came from the config, so clear it to avoid reloading it on startup.
            set(name, "");
            warn!(
                "Cleared modifier-only global shortcut config: {} = {:?}",
                name, hotkey
            );
        } else {
            warn!(
                "Refusing to register modifier-only global shortcut: {} for {}",
                hotkey, name
            );
        }
        return Err("The shortcut must include a non-modifier key.".to_string());
    }

    if !hotkey.is_empty() {
        match app_handle
            .global_shortcut_manager()
            .register(hotkey.as_str(), handler)
        {
            Ok(()) => {
                info!("Registered global shortcut: {} for {}", hotkey, name);
            }
            Err(e) => {
                warn!("Failed to register global shortcut: {} {:?}", hotkey, e);
                return Err(e.to_string());
            }
        };
    }
    Ok(())
}

// Register global shortcuts
pub fn register_shortcut(shortcut: &str) -> Result<(), String> {
    let app_handle = APP.get().unwrap();
    match shortcut {
        "hotkey_selection_translate" => register(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            "",
        )?,
        "hotkey_input_translate" => {
            register(app_handle, "hotkey_input_translate", input_translate, "")?
        }
        "hotkey_ocr_recognize" => register(app_handle, "hotkey_ocr_recognize", ocr_recognize, "")?,
        "hotkey_ocr_translate" => register(app_handle, "hotkey_ocr_translate", ocr_translate, "")?,
        "all" => {
            let mut failures: Vec<String> = Vec::new();
            if let Err(e) = register(
                app_handle,
                "hotkey_selection_translate",
                selection_translate,
                "",
            ) {
                failures.push(format!("hotkey_selection_translate: {}", e));
            }
            if let Err(e) = register(app_handle, "hotkey_input_translate", input_translate, "") {
                failures.push(format!("hotkey_input_translate: {}", e));
            }
            if let Err(e) = register(app_handle, "hotkey_ocr_recognize", ocr_recognize, "") {
                failures.push(format!("hotkey_ocr_recognize: {}", e));
            }
            if let Err(e) = register(app_handle, "hotkey_ocr_translate", ocr_translate, "") {
                failures.push(format!("hotkey_ocr_translate: {}", e));
            }
            if !failures.is_empty() {
                return Err(failures.join("\n"));
            }
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
pub fn register_shortcut_by_frontend(name: &str, shortcut: &str) -> Result<(), String> {
    let app_handle = APP.get().unwrap();
    match name {
        "hotkey_selection_translate" => register(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            shortcut,
        )?,
        "hotkey_input_translate" => register(
            app_handle,
            "hotkey_input_translate",
            input_translate,
            shortcut,
        )?,
        "hotkey_ocr_recognize" => {
            register(app_handle, "hotkey_ocr_recognize", ocr_recognize, shortcut)?
        }
        "hotkey_ocr_translate" => {
            register(app_handle, "hotkey_ocr_translate", ocr_translate, shortcut)?
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::contains_non_modifier_key;

    #[test]
    fn modifier_only_hotkeys_are_rejected() {
        assert!(!contains_non_modifier_key("Alt"));
        assert!(!contains_non_modifier_key("Ctrl+Shift"));
        assert!(!contains_non_modifier_key(""));
        assert!(!contains_non_modifier_key("Ctrl+Alt+Shift+Super"));
    }

    #[test]
    fn hotkeys_with_a_regular_key_are_accepted() {
        assert!(contains_non_modifier_key("Alt+D"));
        assert!(contains_non_modifier_key("F1"));
        assert!(contains_non_modifier_key("F24"));
        assert!(contains_non_modifier_key("ctrl+d"));
        assert!(contains_non_modifier_key("Ctrl+Shift+Space"));
    }
}
