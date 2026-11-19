//! Windows notification-area icon (Shell_NotifyIconW) owned by an unshown top-level window,
//! which, unlike a message-only window, receives the TaskbarCreated broadcast.

use super::menu::{self, Action, Model};
use crate::platform::wide;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NIM_SETVERSION, NIN_SELECT,
    NOTIFYICON_VERSION_4, NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CW_USEDEFAULT, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
    DispatchMessageW, GetCursorPos, GetMessageW, HICON, HMENU, MENU_ITEM_FLAGS, MF_GRAYED, MF_SEPARATOR, MF_STRING,
    MSG, PostMessageW, PostQuitMessage, RegisterClassW, RegisterWindowMessageW, SetForegroundWindow, TPM_NONOTIFY,
    TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu, TranslateMessage, WM_APP, WM_CONTEXTMENU, WM_DESTROY, WM_NULL,
    WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

const WM_TRAY: u32 = WM_APP + 1;
const WM_MODEL: u32 = WM_APP + 2;
const NIN_KEYSELECT: u32 = NIN_SELECT + 1;
const ICON_ID: u32 = 1;

struct Shared {
    model: Model,
    in_process: bool,
    shown: bool,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
static ICON: AtomicUsize = AtomicUsize::new(0);

fn shared() -> MutexGuard<'static, Option<Shared>> {
    SHARED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs the message loop on the calling thread until the icon is closed.
pub fn run(in_process: bool) {
    *shared() = Some(Shared { model: Model::not_running(), in_process, shown: false });
    let class = wide("PrintBetterTray");
    let title = wide("Print Better");
    // SAFETY: Win32 window setup with NUL-terminated strings that outlive the calls.
    let hwnd = unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSW { lpfnWndProc: Some(window_proc), hInstance: instance, lpszClassName: class.as_ptr(), ..Default::default() };
        if RegisterClassW(&wc) == 0 {
            log::error!("tray: could not register the window class");
            return;
        }
        let (x, size) = (CW_USEDEFAULT, CW_USEDEFAULT);
        let null = std::ptr::null_mut();
        CreateWindowExW(0, class.as_ptr(), title.as_ptr(), WS_OVERLAPPEDWINDOW, x, x, size, size, null, null, instance, std::ptr::null())
    };
    if hwnd.is_null() {
        log::error!("tray: could not create its window");
        return;
    }
    let taskbar = wide("TaskbarCreated");
    // SAFETY: NUL-terminated string; returns 0 on failure, which never matches a message.
    TASKBAR_CREATED.store(unsafe { RegisterWindowMessageW(taskbar.as_ptr()) }, Ordering::SeqCst);
    ICON.store(super::windows_icon::create() as usize, Ordering::SeqCst);
    sync_icon(hwnd);
    let window = hwnd as usize;
    menu::poll(move |model| {
        if let Some(state) = shared().as_mut() {
            state.model = model;
        }
        // SAFETY: posting to our own window; a destroyed window just drops the message.
        unsafe { PostMessageW(window as HWND, WM_MODEL, 0, 0) };
    });
    // SAFETY: standard message loop for this thread's window.
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => {
            // With NOTIFYICON_VERSION_4 the event is in the low word of lParam.
            if matches!((lparam as u32) & 0xFFFF, NIN_SELECT | NIN_KEYSELECT | WM_CONTEXTMENU) {
                show_menu(hwnd);
            }
            0
        }
        WM_MODEL => {
            sync_icon(hwnd);
            0
        }
        WM_DESTROY => {
            remove_icon(hwnd);
            // SAFETY: ends this thread's message loop.
            unsafe { PostQuitMessage(0) };
            0
        }
        _ if msg != 0 && msg == TASKBAR_CREATED.load(Ordering::SeqCst) => {
            // Explorer restarted and forgot every icon.
            if let Some(state) = shared().as_mut() {
                state.shown = false;
            }
            sync_icon(hwnd);
            0
        }
        // SAFETY: default handling for everything else.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn notify_data(hwnd: HWND, model: &Model) -> NOTIFYICONDATAW {
    let mut data = NOTIFYICONDATAW {
        cbSize: u32::try_from(size_of::<NOTIFYICONDATAW>()).unwrap_or(0),
        hWnd: hwnd,
        uID: ICON_ID,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP,
        uCallbackMessage: WM_TRAY,
        hIcon: ICON.load(Ordering::SeqCst) as HICON,
        ..Default::default()
    };
    let tip: Vec<u16> = format!("Print Better: {}", model.status).encode_utf16().take(data.szTip.len() - 1).collect();
    data.szTip[..tip.len()].copy_from_slice(&tip);
    data
}

/// Adds, updates, or removes the icon to match `settings.tray`.
fn sync_icon(hwnd: HWND) {
    let mut guard = shared();
    let Some(state) = guard.as_mut() else { return };
    let mut data = notify_data(hwnd, &state.model);
    // SAFETY: `data` is fully initialized and identifies our window's icon.
    unsafe {
        match (state.model.visible, state.shown) {
            (true, false) => {
                if Shell_NotifyIconW(NIM_ADD, &data) != 0 {
                    data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
                    Shell_NotifyIconW(NIM_SETVERSION, &data);
                    state.shown = true;
                }
            }
            (true, true) => {
                Shell_NotifyIconW(NIM_MODIFY, &data);
            }
            (false, true) => {
                Shell_NotifyIconW(NIM_DELETE, &data);
                state.shown = false;
            }
            (false, false) => {}
        }
    }
}

fn remove_icon(hwnd: HWND) {
    let mut guard = shared();
    let Some(state) = guard.as_mut().filter(|s| s.shown) else { return };
    let data = notify_data(hwnd, &state.model);
    // SAFETY: deletes the icon identified by our window and id.
    unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
    state.shown = false;
}

fn show_menu(hwnd: HWND) {
    let Some((model, in_process)) = shared().as_ref().map(|s| (s.model.clone(), s.in_process)) else { return };
    // SAFETY: the menu is created, shown modally, and destroyed within this function.
    let chosen = unsafe {
        let popup = CreatePopupMenu();
        if popup.is_null() {
            return;
        }
        append(popup, MF_STRING | MF_GRAYED, 0, &model.status);
        AppendMenuW(popup, MF_SEPARATOR, 0, std::ptr::null());
        if model.printers.is_empty() {
            append(popup, MF_STRING | MF_GRAYED, 0, "No printers added yet");
        }
        for line in model.printers.iter().chain(&model.remote_problem) {
            append(popup, MF_STRING | MF_GRAYED, 0, line);
        }
        AppendMenuW(popup, MF_SEPARATOR, 0, std::ptr::null());
        for action in Action::MENU.into_iter().filter(|a| a.shown(&model)) {
            if action == Action::HideIcon {
                AppendMenuW(popup, MF_SEPARATOR, 0, std::ptr::null());
            }
            let disabled = action == Action::OpenDashboard && model.dashboard.is_none();
            let flags = if disabled { MF_STRING | MF_GRAYED } else { MF_STRING };
            append(popup, flags, action.tag().unsigned_abs(), &action.label(&model));
        }
        let mut point = POINT { x: 0, y: 0 };
        GetCursorPos(&mut point);
        // The classic dance so the menu closes when the user clicks elsewhere.
        SetForegroundWindow(hwnd);
        let flags = TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY;
        let chosen = TrackPopupMenu(popup, flags, point.x, point.y, 0, hwnd, std::ptr::null());
        PostMessageW(hwnd, WM_NULL, 0, 0);
        DestroyMenu(popup);
        chosen
    };
    match Action::from_tag(chosen as isize) {
        Some(Action::Quit) => {
            remove_icon(hwnd);
            if in_process {
                menu::perform(Action::Quit, true);
            } else {
                // SAFETY: destroying our own window ends the message loop via WM_DESTROY.
                unsafe { DestroyWindow(hwnd) };
            }
        }
        Some(action) => menu::perform(action, in_process),
        None => {}
    }
}

/// Appends a text item; `&` would otherwise mark a keyboard accelerator.
unsafe fn append(menu: HMENU, flags: MENU_ITEM_FLAGS, id: usize, text: &str) {
    let text = wide(&text.replace('&', "&&"));
    // SAFETY: caller passes a live menu; `text` is NUL-terminated and copied by Windows.
    unsafe { AppendMenuW(menu, flags, id, text.as_ptr()) };
}
