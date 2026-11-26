//! Keito Notch for Windows — native side.
//!
//! The app logic (Keito / Jira / Google calls, durations, targets) lives in the TypeScript frontend.
//! This side only does what a web view can't:
//! - place the notch window: edge, island or next to the tray, on the chosen display (placement.rs)
//! - probes for "Active display", full-screen tuck-away and dragging (placement.rs, platform.rs)
//! - the tray icon, the global hotkey (Ctrl+Alt+T) and single-instance handling
//! - secrets in Windows Credential Manager (`keyring`)
//! - the one-shot 127.0.0.1 listener for Google sign-in (OAuth loopback + PKCE)
//! - seconds since the last keyboard/mouse input (idle reminder)

mod oauth;
mod placement;
mod platform;

use placement::PlacementState;

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const SERVICE: &str = "KeitoNotch";
const TRAY_ID: &str = "main";
/// Only these entries may be read or written in Credential Manager.
const SECRET_KEYS: &[&str] = &["keito.apiKey", "jira.token", "google.clientSecret", "google.refreshToken"];

// MARK: Secrets

fn entry(key: &str) -> Result<keyring::Entry, String> {
    if !SECRET_KEYS.contains(&key) {
        return Err(format!("unknown secret {key}"));
    }
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Empty or missing value deletes the entry.
#[tauri::command]
fn secret_set(key: String, value: Option<String>) -> Result<(), String> {
    let e = entry(&key)?;
    match value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        Some(v) => e.set_password(&v).map_err(|e| e.to_string()),
        None => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        },
    }
}

// MARK: Problem log

/// Keeps the log small: past this size the old half is dropped.
const PROBLEM_LOG_MAX: u64 = 256 * 1024;

/// Appends one line to `%LOCALAPPDATA%\ai.keito.notch\logs\problems.log`: UI crashes and unhandled errors,
/// so a notch that "just disappeared" leaves a trace you can read without a debugger.
/// Async: file I/O stays off the main thread that draws the windows.
#[tauri::command]
async fn log_problem(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("problems.log");
    if std::fs::metadata(&path).map(|m| m.len() > PROBLEM_LOG_MAX).unwrap_or(false) {
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        std::fs::write(&path, trim_log(&old)).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    writeln!(f, "{}", one_line(&line)).map_err(|e| e.to_string())
}

/// One log entry per line, at most 8000 characters.
fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " | ").chars().take(8000).collect()
}

/// The newer half of the log, starting at a whole line.
fn trim_log(old: &str) -> &str {
    let mut half = old.len() / 2;
    while !old.is_char_boundary(half) {
        half += 1;
    }
    match old[half..].find('\n') {
        Some(i) => &old[half + i + 1..],
        None => "",
    }
}

#[cfg(test)]
mod log_tests {
    use super::{one_line, trim_log};

    #[test]
    fn trims_to_whole_lines_even_inside_multibyte_text() {
        let old = "één\ntwee ⏎ drie\nvier\n";
        let t = trim_log(old);
        assert!(old.ends_with(t));
        assert!(t.is_empty() || old[..old.len() - t.len()].ends_with('\n'));
    }

    #[test]
    fn one_entry_per_line() {
        assert_eq!(one_line("a\r\nb\nc"), "a |  | b | c");
        assert_eq!(one_line(&"x".repeat(9000)).len(), 8000);
    }
}

// MARK: Windows

/// Shows the notch without taking focus away from what you're doing.
#[tauri::command]
fn show_notch(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("notch").ok_or("no notch window")?;
    platform::show_without_focus(&win);
    Ok(())
}

/// Shows (and lets you click) only `rect` of the notch window — physical px from its top-left — or all of
/// it with None. The hover morph keeps the window at the card's size and clips it to the tab.
#[tauri::command]
fn set_hit_region(app: AppHandle, rect: Option<placement::Rect>) -> Result<(), String> {
    let win = app.get_webview_window("notch").ok_or("no notch window")?;
    platform::set_hit_region(&win, rect)
}

/// Hides the notch (tray style while closed, or tucked away next to a full-screen app).
#[tauri::command]
fn hide_notch(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("notch").ok_or("no notch window")?;
    win.hide().map_err(|e| e.to_string())
}

/// Toast: bottom centre of the notch's display, above the taskbar. Never takes focus,
/// so an open day view stays open.
#[tauri::command]
fn show_toast(app: AppHandle, state: tauri::State<'_, PlacementState>, width: f64, height: f64) -> Result<(), String> {
    let win = app.get_webview_window("toast").ok_or("no toast window")?;
    let r = match placement::toast_rect(&state, width, height) {
        Some(r) => r,
        None => {
            let m = win.primary_monitor().map_err(|e| e.to_string())?.ok_or("no monitor")?;
            let s = m.scale_factor();
            let a = m.work_area();
            let (w, h) = ((width * s) as i32, (height * s) as i32);
            placement::Rect { x: a.position.x + (a.size.width as i32 - w) / 2, y: a.position.y + a.size.height as i32 - h - (16.0 * s) as i32, w, h }
        }
    };
    platform::set_bounds(&win, r)?;
    platform::show_without_focus(&win);
    Ok(())
}

#[tauri::command]
fn hide_toast(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("toast") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Must stay `async`: a sync command runs on the main thread, and creating a webview window there
/// deadlocks WebView2 on Windows — the window appears but stays blank (wry#583, Tauri docs).
#[tauri::command]
async fn open_settings(app: AppHandle, section: Option<String>) -> Result<(), String> {
    open_settings_window(&app, section.as_deref())
}

fn open_settings_window(app: &AppHandle, section: Option<&str>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        if let Some(s) = section {
            let _ = w.emit("settings-section", s);
        }
        w.unminimize().ok();
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = format!("index.html?view=settings&section={}", section.unwrap_or("keito"));
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title("Keito Notch Settings")
        .inner_size(760.0, 580.0)
        .min_inner_size(620.0, 460.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Tray tooltip, e.g. "Keito Notch · 1:23 · Project".
#[tauri::command]
fn set_tray_tooltip(app: AppHandle, text: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(text)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn idle_seconds() -> u64 {
    platform::idle_seconds()
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Opens (or closes) the day view and gives the notch keyboard focus.
fn toggle_day(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("notch") {
        let _ = w.emit("toggle-day", ());
    }
}

fn emit_notch(app: &AppHandle, event: &str) {
    if let Some(w) = app.get_webview_window("notch") {
        let _ = w.emit(event, ());
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let day = MenuItem::with_id(app, "day", "Day view\tCtrl+Alt+T", true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new", "New entry", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Keito Notch", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&day, &new, &settings, &sep, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Keito Notch")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "day" => toggle_day(app),
            "new" => emit_notch(app, "new-entry"),
            "settings" => {
                // Not inline: building a webview window inside an event handler deadlocks WebView2
                // on Windows, like a sync command does (see open_settings). A worker thread is safe.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_settings_window(&app, None);
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_day(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (e.g. from the Start menu) just opens the day view of the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| toggle_day(app)))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_day(app);
                    }
                })
                .build(),
        )
        .manage(oauth::Loopback(Mutex::new(None)))
        .manage(PlacementState(Mutex::new(Default::default())))
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            log_problem,
            placement::place_notch,
            placement::monitors,
            placement::screen_state,
            show_notch,
            hide_notch,
            set_hit_region,
            show_toast,
            hide_toast,
            open_settings,
            set_tray_tooltip,
            idle_seconds,
            quit,
            oauth::oauth_listen,
            oauth::oauth_wait,
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            // Another app may already own Ctrl+Alt+T; the tray icon still works then.
            if let Err(e) = app.global_shortcut().register("ctrl+alt+t") {
                eprintln!("Ctrl+Alt+T is taken: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Keito Notch");
}
