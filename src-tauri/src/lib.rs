//! Watchfloor's desktop shell (M8, brief §7.3).
//!
//! # What this process is, and deliberately is not
//!
//! It is a window, a global hotkey, a menu-bar count and a notifier. It is
//! **not** a client of the Watchfloor API: it never constructs a request,
//! never holds the bearer token, and has no idea what an item is.
//!
//! ## Why the token is not here
//!
//! The obvious design polls the API from Rust on a timer. That requires the
//! token to live on this side, which means persisting it — and the web UI's
//! whole credential discipline is that the token is held in memory for one
//! tab and never stored (`web/src/auth/AuthContext.tsx`; the login screen
//! promises the reader as much).
//!
//! So the **webview polls**, exactly as the dashboard already does, and calls
//! the commands below. §7.3 asks that the shell ship no credentials beyond the
//! static bearer token; this ships none at all.
//!
//! The consequence, stated rather than hidden: notifications fire only while
//! the app is running. With launch-at-login that is "always", and the window
//! can be hidden to the tray while the webview keeps polling.
//!
//! ## Why it loads a URL instead of bundling the frontend
//!
//! `frontendDist` points at `web/dist` so `tauri build` has something to
//! package, but the window navigates to the **running server** on startup.
//! Bundled assets would be served from `tauri://localhost`, so the frontend's
//! relative `/api/...` calls — §7.1's "the HTTP API is the only contract" —
//! would resolve against the app rather than the server, and fixing that would
//! mean adding CORS to Fastify for the benefit of one client. §7.3 says a
//! shell needing something the web UI does not is a signal the API is wrong.
//! See `docs/superpowers/plans/2026-08-17-m8-native-shells.md`.

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Where the window points when no `WATCHFLOOR_URL` is set.
///
/// `vite preview`'s port, not the API's: the shell wraps the **web UI**, and
/// the web UI is what proxies to the API (see `vite.config.ts`). Pointing this
/// at 8787 would load the token-gated Fastify instance, which cannot serve an
/// HTML page — a browser attaches no `Authorization` header to a navigation,
/// which is the same reason the API never serves the bundle.
const DEFAULT_URL: &str = "http://127.0.0.1:4173";

/// The hotkey that summons the dashboard (§7.3). Cmd+Shift+W on macOS,
/// Ctrl+Shift+W elsewhere.
const HOTKEY_CODE: Code = Code::KeyW;

fn hotkey() -> Shortcut {
    #[cfg(target_os = "macos")]
    let mods = Modifiers::SUPER | Modifiers::SHIFT;
    #[cfg(not(target_os = "macos"))]
    let mods = Modifiers::CONTROL | Modifiers::SHIFT;
    Shortcut::new(Some(mods), HOTKEY_CODE)
}

/// The URL the window should open.
///
/// Read from the environment rather than baked in, because §7.3's deployment
/// is over Tailscale and the host differs per machine. No config file: one
/// value, and an env var is what every other entrypoint in this repo reads
/// (`WF_DB_PATH`, `WF_VAULT_ROOT`, …).
fn target_url() -> String {
    std::env::var("WATCHFLOOR_URL").unwrap_or_else(|_| DEFAULT_URL.to_string())
}

/// Show, focus and unminimise the main window — the hotkey's whole job.
///
/// Separate from the toggle below because "summon" must be idempotent: §7.3
/// calls it "a global hotkey to summon the dashboard", and a summon that hides
/// the window when it happens to be visible is a worse feature than one that
/// always shows it.
fn summon(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Update the menu-bar count.
///
/// §7.3 specified the market ribbon here. Markets is M4b and is blocked on
/// `config/portfolio.yaml`, which only the owner can write, so there is no
/// data — and inventing a placeholder ribbon would be the `not_configured`
/// versus `[]` mistake the MCP tools were careful to avoid. This shows the
/// **hard-override count** instead: the same signal the notifications fire on,
/// so the tray and the notifications tell one story rather than two.
///
/// Called by the webview, which is the only side that can authenticate.
#[tauri::command]
fn set_tray_count(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let tray = app
        .tray_by_id("watchfloor-tray")
        .ok_or_else(|| "tray icon not found".to_string())?;
    // An em dash for zero rather than "0": a wall-glance indicator should read
    // as "nothing to see", and a zero invites a second look to confirm it is
    // not a stuck counter.
    let title = if count == 0 {
        "—".to_string()
    } else {
        count.to_string()
    };
    tray.set_title(Some(title)).map_err(|e| e.to_string())
}

/// True when the caller is running inside this shell.
///
/// The frontend uses it to decide whether to enable shell behaviour at all, so
/// that one build serves both the browser and the shell.
#[tauri::command]
fn shell_info() -> serde_json::Value {
    serde_json::json!({
        "shell": "tauri",
        "version": env!("CARGO_PKG_VERSION"),
        "url": target_url(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // `LaunchAgent` on macOS rather than a login item: it is the same
        // mechanism `io.dram51.watchfloor.cycle` already uses for the ingest
        // job, so the machine has one story about what starts Watchfloor.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // Fire on press only. Without this the handler runs twice
                    // per keystroke and a "summon" that also ran on release
                    // would be a coin flip in any toggle-shaped design.
                    if event.state() == ShortcutState::Pressed && shortcut == &hotkey() {
                        summon(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![set_tray_count, shell_info])
        .setup(|app| {
            let handle = app.handle().clone();

            // The window is built here rather than declared in tauri.conf.json
            // because its URL is not known until runtime -- see target_url().
            let url = target_url();
            let parsed = url
                .parse()
                .map_err(|e| format!("WATCHFLOOR_URL is not a valid URL ({url}): {e}"))?;
            // NOTE: `app.windows` in tauri.conf.json is deliberately EMPTY.
            // Declaring the window there as well made Tauri create `main`
            // before this hook ran, and the build below panicked with
            // "a webview with label `main` already exists" -- found by
            // launching it, which is the only thing that could have.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Watchfloor")
                .inner_size(1440.0, 900.0)
                .min_inner_size(380.0, 480.0)
                .center()
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::webview::Color(5, 7, 10, 255))
                .build()?;

            let show = MenuItem::with_id(app, "show", "Show Watchfloor", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("watchfloor-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .title("—")
                .tooltip("Watchfloor")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => summon(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // A left click on the tray shows the window; the menu is
                    // on right click. That is the macOS convention for a
                    // glanceable item that also has an app behind it.
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        summon(tray.app_handle());
                    }
                })
                .build(app)?;

            // Register the hotkey after setup so a failure is reported rather
            // than silently swallowed -- a global shortcut can be refused by
            // the OS if another app already owns it, and a hotkey that quietly
            // does nothing is the shape of defect this project keeps finding.
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Err(error) = handle.global_shortcut().register(hotkey()) {
                eprintln!(
                    "watchfloor: global hotkey unavailable ({error}). The window and tray still work."
                );
                let _ = handle.emit("shell://hotkey-unavailable", error.to_string());
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Watchfloor shell");
}
