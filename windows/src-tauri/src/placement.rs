//! Where the notch sits: style (edge / island / tray), display (main / active / a named one), and the
//! pointer probes behind "Active display", full-screen tuck-away and dragging.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Monitor, Runtime};

use crate::platform;

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Default, Debug, PartialEq, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x as f64 && x < (self.x + self.w) as f64 && y >= self.y as f64 && y < (self.y + self.h) as f64
    }
}

/// The last placement, so probes work while the notch is hidden (tucked away or tray style).
#[derive(Default)]
pub struct Placement {
    pub monitor: String,
    pub notch: Rect,
    pub screen: Rect,
    pub work: Rect,
    pub scale: f64,
}

pub struct PlacementState(pub Mutex<Placement>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceArgs {
    /// Logical pixels.
    pub width: f64,
    pub height: f64,
    /// "edge" | "island" | "tray"
    pub style: String,
    /// "left" | "right" (edge style)
    pub edge: String,
    /// Edge style: vertical centre, 0 (top) … 1 (bottom).
    pub position: f64,
    /// Island style: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottomRight".
    pub island: String,
    /// "main" | "active" | a monitor name.
    pub display: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub name: String,
    pub label: String,
    pub primary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenState {
    /// Monitor under the pointer.
    pub pointer_monitor: Option<String>,
    /// Monitor the notch was last placed on.
    pub notch_monitor: String,
    /// A full-screen app covers the notch's monitor.
    pub fullscreen: bool,
    /// Pointer resting against the screen edge where the notch sits (to bring a tucked notch back).
    pub at_edge: bool,
    /// Pointer inside the notch's rectangle.
    pub over_notch: bool,
    /// The notch had sunk below an ordinary window and was put back on top (see platform::keep_on_top).
    pub re_topped: bool,
    /// The primary mouse button is held down (ends a native window drag, which swallows the mouse-up).
    pub mouse_down: bool,
    /// Pointer position as a fraction of the notch monitor's work area (for dragging), clamped to 0…1.
    pub fx: f64,
    pub fy: f64,
}

fn name_of(m: &Monitor) -> String {
    m.name().cloned().unwrap_or_else(|| format!("{}x{}@{},{}", m.size().width, m.size().height, m.position().x, m.position().y))
}

fn rect_screen(m: &Monitor) -> Rect {
    Rect { x: m.position().x, y: m.position().y, w: m.size().width as i32, h: m.size().height as i32 }
}

fn rect_work(m: &Monitor) -> Rect {
    let a = m.work_area();
    Rect { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 }
}

fn pointer_monitor<R: Runtime>(app: &AppHandle<R>) -> Option<Monitor> {
    let p = app.cursor_position().ok()?;
    app.monitor_from_point(p.x, p.y).ok().flatten()
}

fn resolve_monitor<R: Runtime>(app: &AppHandle<R>, display: &str) -> Result<Monitor, String> {
    let primary = app.primary_monitor().map_err(|e| e.to_string())?;
    let found = match display {
        "main" => None,
        "active" => pointer_monitor(app),
        name => app
            .available_monitors()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|m| name_of(m) == name),
    };
    // A missing (disconnected) display falls back to the main one.
    found
        .or(primary)
        .or_else(|| app.available_monitors().ok()?.into_iter().next())
        .ok_or_else(|| "no monitor".to_string())
}

/// Computes the notch rectangle (physical pixels) for a style inside a monitor.
pub fn compute(args: &PlaceArgs, screen: Rect, work: Rect, scale: f64) -> Rect {
    let w = (args.width * scale).round() as i32;
    let h = (args.height * scale).round() as i32;
    let m = (10.0 * scale).round() as i32;
    let right = work.x + work.w - w;
    let bottom = work.y + work.h - h;
    let (x, y) = match args.style.as_str() {
        "island" => {
            let x = match args.island.as_str() {
                "topLeft" | "bottomLeft" => work.x + m,
                "topRight" | "bottomRight" => right - m,
                _ => work.x + (work.w - w) / 2,
            };
            let y = if args.island.starts_with("bottom") { bottom - m } else { work.y + m };
            (x, y)
        }
        "tray" => {
            // Next to the tray: the end of the taskbar, wherever the taskbar is.
            let top_gap = work.y - screen.y;
            let left_gap = work.x - screen.x;
            if top_gap > 0 {
                (right - m, work.y + m)
            } else if left_gap > 0 {
                (work.x + m, bottom - m)
            } else {
                (right - m, bottom - m)
            }
        }
        _ => {
            let x = if args.edge == "left" { work.x } else { right };
            let centre = (work.h as f64 * args.position.clamp(0.0, 1.0)).round() as i32;
            (x, work.y + (centre - h / 2).clamp(0, (work.h - h).max(0)))
        }
    };
    Rect { x, y, w, h }
}

#[tauri::command]
pub fn place_notch(app: AppHandle, state: tauri::State<'_, PlacementState>, args: PlaceArgs) -> Result<String, String> {
    let win = app.get_webview_window("notch").ok_or("no notch window")?;
    let monitor = resolve_monitor(&app, &args.display)?;
    let scale = monitor.scale_factor();
    let screen = rect_screen(&monitor);
    let work = rect_work(&monitor);
    let r = compute(&args, screen, work, scale);
    platform::set_bounds(&win, r)?;
    let name = name_of(&monitor);
    *state.0.lock().map_err(|e| e.to_string())? = Placement { monitor: name.clone(), notch: r, screen, work, scale };
    Ok(name)
}

#[tauri::command]
pub fn monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let primary = app.primary_monitor().map_err(|e| e.to_string())?.map(|m| name_of(&m));
    let mut list: Vec<Monitor> = app.available_monitors().map_err(|e| e.to_string())?;
    list.sort_by_key(|m| (m.position().x, m.position().y));
    Ok(list
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let name = name_of(m);
            let s = m.size().to_logical::<f64>(m.scale_factor());
            MonitorInfo {
                label: format!("Display {} ({}×{})", i + 1, s.width.round(), s.height.round()),
                primary: primary.as_deref() == Some(name.as_str()),
                name,
            }
        })
        .collect())
}

/// One probe per second from the notch: pointer monitor, full-screen state and edge contact.
#[tauri::command]
pub fn screen_state(app: AppHandle, state: tauri::State<'_, PlacementState>, style: String, edge: String, island: String) -> Result<ScreenState, String> {
    let p = state.0.lock().map_err(|e| e.to_string())?;
    let cursor = app.cursor_position().ok();
    let pointer = cursor.and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten()).map(|m| name_of(&m));
    let (cx, cy) = cursor.map(|c| (c.x, c.y)).unwrap_or((-1e9, -1e9));
    let s = p.screen;
    let n = p.notch;
    let reach = 40.0 * p.scale.max(1.0);
    let at_edge = p.monitor.as_str() == pointer.as_deref().unwrap_or("")
        && match style.as_str() {
            "island" => {
                let near_x = cx >= n.x as f64 - reach && cx <= (n.x + n.w) as f64 + reach;
                let at_y = if island.starts_with("bottom") { cy >= (s.y + s.h) as f64 - 3.0 } else { cy <= s.y as f64 + 2.0 };
                near_x && at_y
            }
            "edge" => {
                let near_y = cy >= n.y as f64 - reach && cy <= (n.y + n.h) as f64 + reach;
                let at_x = if edge == "left" { cx <= s.x as f64 + 2.0 } else { cx >= (s.x + s.w) as f64 - 3.0 };
                near_y && at_x
            }
            _ => false,
        };
    let w = p.work;
    let frac = |v: f64, o: i32, len: i32| if len > 0 { ((v - o as f64) / len as f64).clamp(0.0, 1.0) } else { 0.5 };
    // Twice a second anyway: also the moment to notice the notch sank behind other windows.
    let re_topped = app.get_webview_window("notch").map(|w| platform::keep_on_top(&w)).unwrap_or(false);
    Ok(ScreenState {
        re_topped,
        mouse_down: platform::primary_button_down(),
        pointer_monitor: pointer,
        notch_monitor: p.monitor.clone(),
        fullscreen: platform::fullscreen_app_on(s),
        at_edge,
        over_notch: n.contains(cx, cy),
        fx: frac(cx, w.x, w.w),
        fy: frac(cy, w.y, w.h),
    })
}

/// The toast goes on the notch's display, bottom centre above the taskbar.
pub fn toast_rect(state: &PlacementState, width: f64, height: f64) -> Option<Rect> {
    let p = state.0.lock().ok()?;
    if p.scale == 0.0 {
        return None;
    }
    let w = (width * p.scale).round() as i32;
    let h = (height * p.scale).round() as i32;
    let x = p.work.x + (p.work.w - w) / 2;
    let y = p.work.y + p.work.h - h - (16.0 * p.scale) as i32;
    Some(Rect { x, y, w, h })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(style: &str, edge: &str, island: &str, position: f64) -> PlaceArgs {
        PlaceArgs { width: 100.0, height: 50.0, style: style.into(), edge: edge.into(), position, island: island.into(), display: "main".into() }
    }

    // 1920×1080 screen with a 48 px taskbar at the bottom, scale 1.
    const SCREEN: Rect = Rect { x: 0, y: 0, w: 1920, h: 1080 };
    const WORK: Rect = Rect { x: 0, y: 0, w: 1920, h: 1032 };

    #[test]
    fn edge_right_centred_and_clamped() {
        let r = compute(&args("edge", "right", "", 0.5), SCREEN, WORK, 1.0);
        assert_eq!(r, Rect { x: 1820, y: 491, w: 100, h: 50 });
        let top = compute(&args("edge", "left", "", 0.0), SCREEN, WORK, 1.0);
        assert_eq!((top.x, top.y), (0, 0));
        let bottom = compute(&args("edge", "left", "", 1.0), SCREEN, WORK, 1.0);
        assert_eq!(bottom.y, 1032 - 50);
    }

    #[test]
    fn island_positions() {
        assert_eq!(compute(&args("island", "", "top", 0.0), SCREEN, WORK, 1.0), Rect { x: 910, y: 10, w: 100, h: 50 });
        assert_eq!(compute(&args("island", "", "bottomRight", 0.0), SCREEN, WORK, 1.0), Rect { x: 1810, y: 972, w: 100, h: 50 });
    }

    #[test]
    fn tray_follows_taskbar() {
        assert_eq!(compute(&args("tray", "", "", 0.0), SCREEN, WORK, 1.0), Rect { x: 1810, y: 972, w: 100, h: 50 });
        let top_bar = Rect { x: 0, y: 48, w: 1920, h: 1032 };
        assert_eq!(compute(&args("tray", "", "", 0.0), SCREEN, top_bar, 1.0), Rect { x: 1810, y: 58, w: 100, h: 50 });
    }

    /// The hover morph (NotchApp.tsx, morphAnchor) draws the tab against one corner of the window and grows
    /// the card from there. That only looks still if the window itself grows away from that same corner.
    #[test]
    fn hover_grows_away_from_the_morph_anchor() {
        // (style, edge, island, tab w×h, peek w×h, anchor x, anchor y) — sizes from sizeFor() in NotchApp.tsx.
        let cases = [
            ("edge", "right", "", (50.0, 96.0), (316.0, 96.0), "right", "top"),
            ("edge", "left", "", (50.0, 96.0), (316.0, 96.0), "left", "top"),
            ("island", "", "topLeft", (112.0, 44.0), (340.0, 84.0), "left", "top"),
            ("island", "", "top", (112.0, 44.0), (340.0, 84.0), "center", "top"),
            ("island", "", "topRight", (112.0, 44.0), (340.0, 84.0), "right", "top"),
            ("island", "", "bottomLeft", (112.0, 44.0), (340.0, 84.0), "left", "bottom"),
            ("island", "", "bottomRight", (112.0, 44.0), (340.0, 84.0), "right", "bottom"),
        ];
        for scale in [1.0, 1.25, 1.5] {
            for (style, edge, island, tab, peek, ax, ay) in cases {
                let place = |(w, h): (f64, f64)| {
                    compute(&PlaceArgs { width: w, height: h, ..args(style, edge, island, 0.4) }, SCREEN, WORK, scale)
                };
                let (t, p) = (place(tab), place(peek));
                let what = format!("{style} {edge}{island} @{scale}: tab {t:?} peek {p:?}");
                match ax {
                    "left" => assert_eq!(t.x, p.x, "{what}"),
                    "right" => assert_eq!(t.x + t.w, p.x + p.w, "{what}"),
                    _ => assert!(((2 * t.x + t.w) - (2 * p.x + p.w)).abs() <= 2, "{what}"),
                }
                match ay {
                    "top" => assert_eq!(t.y, p.y, "{what}"),
                    _ => assert_eq!(t.y + t.h, p.y + p.h, "{what}"),
                }
            }
        }
    }

    #[test]
    fn scales_to_physical_pixels() {
        let r = compute(&args("edge", "right", "", 0.5), Rect { w: 3840, h: 2160, ..SCREEN }, Rect { w: 3840, h: 2064, ..WORK }, 2.0);
        assert_eq!((r.w, r.h, r.x), (200, 100, 3640));
    }
}
