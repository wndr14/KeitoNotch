//! Windows specifics. Other platforms get harmless fallbacks so the app can be developed on a Mac.

use tauri::WebviewWindow;

/// Seconds since the last keyboard or mouse input anywhere in the session.
#[cfg(windows)]
pub fn idle_seconds() -> u64 {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a valid, correctly sized LASTINPUTINFO.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return 0;
    }
    // Both are 32-bit tick counts; wrapping_sub handles the 49-day rollover.
    let now = unsafe { GetTickCount() };
    (now.wrapping_sub(info.dwTime) / 1000) as u64
}

#[cfg(not(windows))]
pub fn idle_seconds() -> u64 {
    0
}

/// The primary mouse button is down right now (the right one when the buttons are swapped).
#[cfg(windows)]
pub fn primary_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    // SAFETY: plain input-state queries.
    unsafe {
        let key = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
        (GetAsyncKeyState(key as i32) as u16 & 0x8000) != 0
    }
}

#[cfg(not(windows))]
pub fn primary_button_down() -> bool {
    false
}

/// Shows a window without activating it (SW_SHOWNOACTIVATE), so the app you're typing in keeps focus.
#[cfg(windows)]
pub fn show_without_focus(win: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    match win.hwnd() {
        // SAFETY: the handle belongs to a live window owned by this process.
        Ok(hwnd) => unsafe {
            ShowWindow(hwnd.0 as _, SW_SHOWNOACTIVATE);
        },
        Err(_) => {
            let _ = win.show();
        }
    }
}

#[cfg(not(windows))]
pub fn show_without_focus(win: &WebviewWindow) {
    let _ = win.show();
}

/// Puts an always-on-top window back in the topmost band when Windows has left it below an ordinary window.
/// Measured 26-11 on the work laptop: the notch still had WS_EX_TOPMOST but sat at place 55 in the z-order,
/// under a maximised Windows Terminal and Chrome, so the tab was invisible and clicks on it went to the
/// terminal. One SetWindowPos(HWND_TOPMOST) brought it back. Returns true when it had to; cheap otherwise
/// (only the few topmost windows above it are visited).
#[cfg(windows)]
pub fn keep_on_top(win: &WebviewWindow) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindow, GetWindowLongW, IsWindowVisible, SetWindowPos, GWL_EXSTYLE, GW_HWNDPREV, HWND_TOPMOST, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
    };
    let Ok(hwnd) = win.hwnd() else { return false };
    let hwnd = hwnd.0 as _;
    // SAFETY: plain z-order queries and one SetWindowPos on a live window owned by this process.
    unsafe {
        if IsWindowVisible(hwnd) == 0 {
            return false;
        }
        let mut above = GetWindow(hwnd, GW_HWNDPREV);
        let mut buried = false;
        for _ in 0..2000 {
            if above.is_null() {
                break;
            }
            if IsWindowVisible(above) != 0 && (GetWindowLongW(above, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST) == 0 {
                buried = true;
                break;
            }
            above = GetWindow(above, GW_HWNDPREV);
        }
        if buried {
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        buried
    }
}

#[cfg(not(windows))]
pub fn keep_on_top(_win: &WebviewWindow) -> bool {
    false
}

/// Moves and resizes a window in ONE step (physical pixels). Separate set_size + set_position calls let
/// Windows draw the frame in between: measured on hover, the island grew 228 px off-screen at its old
/// spot for ~4 ms before moving, and shrank at the wrong spot on leave — a visible jump.
#[cfg(windows)]
pub fn set_bounds(win: &WebviewWindow, r: crate::placement::Rect) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER};
    let hwnd = win.hwnd().map_err(|e| e.to_string())?;
    // SAFETY: the handle belongs to a live window owned by this process; plain geometry change.
    let ok = unsafe {
        SetWindowPos(hwnd.0 as _, std::ptr::null_mut(), r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE)
    };
    if ok == 0 {
        return Err("SetWindowPos failed".into());
    }
    Ok(())
}

/// Clips the window to `r` (physical px, relative to the window), or removes the clip with None.
/// Outside the region Windows neither draws the window nor sends it the mouse: clicks fall through to
/// whatever is underneath. That lets the notch keep the peek card's size while showing only the tab,
/// so hovering never resizes the window (a resize makes WebView2 show its old frame for a moment).
#[cfg(windows)]
pub fn set_hit_region(win: &WebviewWindow, r: Option<crate::placement::Rect>) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn};
    let hwnd = win.hwnd().map_err(|e| e.to_string())?;
    // SAFETY: plain GDI calls on a live window owned by this process. After a successful SetWindowRgn
    // the system owns the region; on failure we delete it ourselves.
    unsafe {
        let rgn = match r {
            Some(r) => CreateRectRgn(r.x, r.y, r.x + r.w, r.y + r.h),
            None => std::ptr::null_mut(),
        };
        if SetWindowRgn(hwnd.0 as _, rgn, 1) == 0 {
            if !rgn.is_null() {
                DeleteObject(rgn);
            }
            return Err("SetWindowRgn failed".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_hit_region(_win: &WebviewWindow, _r: Option<crate::placement::Rect>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn set_bounds(win: &WebviewWindow, r: crate::placement::Rect) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize};
    win.set_position(PhysicalPosition::new(r.x, r.y)).map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(r.w as u32, r.h as u32)).map_err(|e| e.to_string())
}

/// A full-screen app (game, video, presentation) covers this monitor: the foreground window is at least as
/// large as the whole screen and isn't the desktop, the taskbar or one of our own windows.
#[cfg(windows)]
pub fn fullscreen_app_on(screen: crate::placement::Rect) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId};
    if screen.w <= 0 {
        return false;
    }
    // SAFETY: plain Win32 queries on the foreground window handle; buffers are sized correctly.
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, &mut pid);
        if pid == GetCurrentProcessId() {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(fg, class.as_mut_ptr(), class.len() as i32);
        let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            return false;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetWindowRect(fg, &mut r) == 0 {
            return false;
        }
        r.left <= screen.x && r.top <= screen.y && r.right >= screen.x + screen.w && r.bottom >= screen.y + screen.h
    }
}

#[cfg(not(windows))]
pub fn fullscreen_app_on(_screen: crate::placement::Rect) -> bool {
    false
}
