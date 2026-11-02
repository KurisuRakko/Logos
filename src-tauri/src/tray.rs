use crate::config::{get, set};
use crate::window::config_window;
use crate::window::input_translate;
use crate::window::ocr_translate;
use log::info;
use tauri::CustomMenuItem;
use tauri::GlobalShortcutManager;
use tauri::SystemTrayEvent;
use tauri::SystemTrayMenu;
use tauri::SystemTrayMenuItem;
use tauri::SystemTraySubmenu;
use tauri::{AppHandle, Manager};

// Tray menu labels for one language
struct TrayText {
    input_translate: &'static str,
    auto_copy: &'static str,
    copy_source: &'static str,
    copy_target: &'static str,
    copy_source_target: &'static str,
    copy_disable: &'static str,
    ocr_translate: &'static str,
    config: &'static str,
    view_log: &'static str,
    restart: &'static str,
    quit: &'static str,
}

const TEXT_EN: TrayText = TrayText {
    input_translate: "Input Translate",
    auto_copy: "Auto Copy",
    copy_source: "Source",
    copy_target: "Target",
    copy_source_target: "Source+Target",
    copy_disable: "Disable",
    ocr_translate: "OCR Translate",
    config: "Config",
    view_log: "View Log",
    restart: "Restart",
    quit: "Quit",
};

const TEXT_ZH_CN: TrayText = TrayText {
    input_translate: "输入翻译",
    auto_copy: "自动复制",
    copy_source: "原文",
    copy_target: "译文",
    copy_source_target: "原文+译文",
    copy_disable: "关闭",
    ocr_translate: "截图翻译",
    config: "偏好设置",
    view_log: "查看日志",
    restart: "重启应用",
    quit: "退出",
};

const TEXT_ZH_TW: TrayText = TrayText {
    input_translate: "輸入翻譯",
    auto_copy: "自動複製",
    copy_source: "原文",
    copy_target: "譯文",
    copy_source_target: "原文+譯文",
    copy_disable: "關閉",
    ocr_translate: "截圖翻譯",
    config: "偏好設定",
    view_log: "查看日誌",
    restart: "重啓程式",
    quit: "退出",
};

const TEXT_JA: TrayText = TrayText {
    input_translate: "翻訳を入力",
    auto_copy: "自動コピー",
    copy_source: "原文",
    copy_target: "訳文",
    copy_source_target: "原文+訳文",
    copy_disable: "閉じる",
    ocr_translate: "スクリーンショットの翻訳",
    config: "プリファレンス設定",
    view_log: "ログを見る",
    restart: "アプリの再起動",
    quit: "退出する",
};

const TEXT_KO: TrayText = TrayText {
    input_translate: "입력 번역",
    auto_copy: "자동 복사",
    copy_source: "원문",
    copy_target: "번역문",
    copy_source_target: "원문+번역문",
    copy_disable: "닫기",
    ocr_translate: "스크린샷 번역",
    config: "기본 설정",
    view_log: "로그 보기",
    restart: "응용 프로그램 다시 시작",
    quit: "퇴출",
};

const TEXT_FR: TrayText = TrayText {
    input_translate: "Traduction d'entrée",
    auto_copy: "Copier automatiquement",
    copy_source: "Source",
    copy_target: "Cible",
    copy_source_target: "Source+Cible",
    copy_disable: "Désactiver",
    ocr_translate: "Traduction d'image",
    config: "Paramètres",
    view_log: "Voir le journal",
    restart: "Redémarrer l'application",
    quit: "Quitter",
};

const TEXT_DE: TrayText = TrayText {
    input_translate: "Eingabeübersetzung",
    auto_copy: "Automatisch kopieren",
    copy_source: "Quelle",
    copy_target: "Ziel",
    copy_source_target: "Quelle+Ziel",
    copy_disable: "Deaktivieren",
    ocr_translate: "Bildübersetzung",
    config: "Einstellungen",
    view_log: "Protokoll anzeigen",
    restart: "Anwendung neu starten",
    quit: "Beenden",
};

const TEXT_RU: TrayText = TrayText {
    input_translate: "Ввод перевода",
    auto_copy: "Автоматическое копирование",
    copy_source: "Источник",
    copy_target: "Цель",
    copy_source_target: "Источник+Цель",
    copy_disable: "Отключить",
    ocr_translate: "Перевод изображения",
    config: "Настройки",
    view_log: "Просмотр журнала",
    restart: "Перезапустить приложение",
    quit: "Выход",
};

const TEXT_PT_BR: TrayText = TrayText {
    input_translate: "Traduzir Entrada",
    auto_copy: "Copiar Automaticamente",
    copy_source: "Origem",
    copy_target: "Destino",
    copy_source_target: "Origem+Destino",
    copy_disable: "Desabilitar",
    ocr_translate: "Tradução de Imagem",
    config: "Configurações",
    view_log: "Exibir Registro",
    restart: "Reiniciar aplicativo",
    quit: "Sair",
};

const TEXT_UK: TrayText = TrayText {
    input_translate: "Введення перекладу",
    auto_copy: "Автоматичне копіювання",
    copy_source: "Джерело",
    copy_target: "Мета",
    copy_source_target: "Джерело+Мета",
    copy_disable: "Відключивши",
    ocr_translate: "Переклад зображення",
    config: "Настройка",
    view_log: "Перегляд журналу",
    restart: "Перезапустити додаток",
    quit: "Вихід",
};

fn tray_text(language: &str) -> &'static TrayText {
    match language {
        "zh_cn" => &TEXT_ZH_CN,
        "zh_tw" => &TEXT_ZH_TW,
        "ja" => &TEXT_JA,
        "ko" => &TEXT_KO,
        "fr" => &TEXT_FR,
        "de" => &TEXT_DE,
        "ru" => &TEXT_RU,
        "pt_br" => &TEXT_PT_BR,
        "uk" => &TEXT_UK,
        _ => &TEXT_EN,
    }
}

fn tray_menu(text: &TrayText) -> SystemTrayMenu {
    SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("input_translate", text.input_translate))
        .add_submenu(SystemTraySubmenu::new(
            text.auto_copy,
            SystemTrayMenu::new()
                .add_item(CustomMenuItem::new("copy_source", text.copy_source))
                .add_item(CustomMenuItem::new("copy_target", text.copy_target))
                .add_item(CustomMenuItem::new(
                    "copy_source_target",
                    text.copy_source_target,
                ))
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(CustomMenuItem::new("copy_disable", text.copy_disable)),
        ))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("ocr_translate", text.ocr_translate))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("config", text.config))
        .add_item(CustomMenuItem::new("view_log", text.view_log))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("restart", text.restart))
        .add_item(CustomMenuItem::new("quit", text.quit))
}

#[tauri::command]
pub fn update_tray(app_handle: tauri::AppHandle, mut language: String, mut copy_mode: String) {
    let tray_handle = app_handle.tray_handle();

    if language.is_empty() {
        language = match get("app_language") {
            Some(v) => v.as_str().unwrap().to_string(),
            None => {
                set("app_language", "en");
                "en".to_string()
            }
        };
    }
    if copy_mode.is_empty() {
        copy_mode = match get("translate_auto_copy") {
            Some(v) => v.as_str().unwrap().to_string(),
            None => {
                set("translate_auto_copy", "disable");
                "disable".to_string()
            }
        };
    }

    info!(
        "Update tray with language: {}, copy mode: {}",
        language, copy_mode
    );
    tray_handle
        .set_menu(tray_menu(tray_text(language.as_str())))
        .unwrap();
    #[cfg(not(target_os = "linux"))]
    tray_handle
        .set_tooltip(&format!("Logos {}", app_handle.package_info().version))
        .unwrap();

    match copy_mode.as_str() {
        "source" => tray_handle
            .get_item("copy_source")
            .set_selected(true)
            .unwrap(),
        "target" => tray_handle
            .get_item("copy_target")
            .set_selected(true)
            .unwrap(),
        "source_target" => tray_handle
            .get_item("copy_source_target")
            .set_selected(true)
            .unwrap(),
        "disable" => tray_handle
            .get_item("copy_disable")
            .set_selected(true)
            .unwrap(),
        _ => {}
    }
}

pub fn tray_event_handler<'a>(app: &'a AppHandle, event: SystemTrayEvent) {
    match event {
        #[cfg(target_os = "windows")]
        SystemTrayEvent::LeftClick { .. } => on_tray_click(),
        SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "input_translate" => on_input_translate_click(),
            "copy_source" => on_auto_copy_click(app, "source"),
            "copy_target" => on_auto_copy_click(app, "target"),
            "copy_source_target" => on_auto_copy_click(app, "source_target"),
            "copy_disable" => on_auto_copy_click(app, "disable"),
            "ocr_translate" => on_ocr_translate_click(),
            "config" => on_config_click(),
            "view_log" => on_view_log_click(app),
            "restart" => on_restart_click(app),
            "quit" => on_quit_click(app),
            _ => {}
        },
        _ => {}
    }
}

#[cfg(target_os = "windows")]
fn on_tray_click() {
    let event = match get("tray_click_event") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => {
            set("tray_click_event", "config");
            "config".to_string()
        }
    };
    match event.as_str() {
        "config" => config_window(),
        "translate" => input_translate(),
        "ocr_recognize" | "ocr_translate" => ocr_translate(),
        "disable" => {}
        _ => config_window(),
    }
}
fn on_input_translate_click() {
    input_translate();
}
fn on_auto_copy_click(app: &AppHandle, mode: &str) {
    info!("Set copy mode to: {}", mode);
    set("translate_auto_copy", mode);
    app.emit_all("translate_auto_copy_changed", mode).unwrap();
    update_tray(app.app_handle(), "".to_string(), mode.to_string());
}
fn on_ocr_translate_click() {
    ocr_translate();
}

fn on_config_click() {
    config_window();
}

fn on_view_log_click(app: &AppHandle) {
    use tauri::api::path::app_log_dir;
    let log_path = app_log_dir(&app.config()).unwrap();
    tauri::api::shell::open(&app.shell_scope(), log_path.to_str().unwrap(), None).unwrap();
}
fn on_restart_click(app: &AppHandle) {
    info!("============== Restart App ==============");
    app.restart();
}
fn on_quit_click(app: &AppHandle) {
    app.global_shortcut_manager().unregister_all().unwrap();
    info!("============== Quit App ==============");
    app.exit(0);
}
