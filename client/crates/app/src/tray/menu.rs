//! Menu model and actions shared by every platform's tray.

use crate::local::{client, page_url};
use crate::platform;
use serde_json::{Value, json};
use std::time::Duration;

const POLL: Duration = Duration::from_secs(3);
const NOTICE_CHARS: usize = 60;

#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    pub status: String,
    /// "Name: state" for each added printer.
    pub printers: Vec<String>,
    /// A short line when printers from other devices can't be offered here.
    pub remote_problem: Option<String>,
    pub paused: bool,
    /// `settings.tray`; when off the icon hides but keeps polling so it can come back.
    pub visible: bool,
    pub dashboard: Option<String>,
    /// The daemon answered and has no pairing yet.
    pub unpaired: bool,
    /// A newer release this device can install now.
    pub update: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    OpenDashboard = 1,
    OpenStatusPage,
    TogglePause,
    FindPrinters,
    HideIcon,
    Quit,
    Update,
}

impl Action {
    pub const MENU: [Action; 7] = [
        Action::Update,
        Action::OpenDashboard,
        Action::OpenStatusPage,
        Action::TogglePause,
        Action::FindPrinters,
        Action::HideIcon,
        Action::Quit,
    ];

    pub fn label(self, model: &Model) -> String {
        let label = match self {
            Action::Update => return format!("Update to {}", model.update.as_deref().unwrap_or_default()),
            Action::OpenDashboard => "Open dashboard",
            Action::OpenStatusPage => "Open status page",
            Action::TogglePause if model.paused => "Resume printing",
            Action::TogglePause => "Pause printing",
            Action::FindPrinters => "Find printers",
            Action::HideIcon => "Hide this icon…",
            Action::Quit => "Quit Print Better",
        };
        label.into()
    }

    /// The update item appears only while there is one to install.
    pub fn shown(self, model: &Model) -> bool {
        self != Action::Update || model.update.is_some()
    }

    /// Menu item tag (macOS) / command id (Windows).
    #[cfg(any(target_os = "macos", windows))]
    pub fn tag(self) -> isize {
        self as isize
    }

    #[cfg(any(target_os = "macos", windows))]
    pub fn from_tag(tag: isize) -> Option<Action> {
        Action::MENU.into_iter().find(|a| a.tag() == tag)
    }
}

impl Model {
    pub fn not_running() -> Model {
        Model {
            status: "Print Better is not running".into(),
            printers: Vec::new(),
            remote_problem: None,
            paused: false,
            visible: true,
            dashboard: None,
            unpaired: false,
            update: None,
        }
    }

    fn from_status(status: &Value) -> Model {
        let paused = status["settings"]["paused"] == true;
        let jobs = status["jobs"].as_array().map(Vec::as_slice).unwrap_or_default();
        let active = jobs.iter().filter(|j| j["status"] == "dispatched" || j["status"] == "printing").count();
        let update = &status["update"];
        let latest = update["latest"].as_str().unwrap_or_default();
        let updating = update["phase"].is_string();
        let line = match status["connection"].as_str().unwrap_or_default() {
            "unpaired" => "Not set up yet".to_string(),
            "revoked" => "Removed from Print Better".into(),
            "replaced" => "Stopped: another copy is connected".into(),
            "connecting" => "Connecting…".into(),
            "offline" => "Offline, reconnecting…".into(),
            _ if updating => format!("Updating to {latest}…"),
            _ if paused => "Printing is paused".into(),
            _ if active == 1 => "Printing 1 job".into(),
            _ if active > 1 => format!("Printing {active} jobs"),
            _ => "Ready".into(),
        };
        let printers = status["printers"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter(|p| p["added"] == true)
            .map(|p| format!("{}: {}", p["name"].as_str().unwrap_or("Printer"), super::state_label(p["state"].as_str().unwrap_or_default())))
            .collect();
        let remote_problem = status["remotePrinters"]["error"]
            .as_str()
            .filter(|e| status["settings"]["remotePrinters"] == true && crate::daemon::REMOTE_PRINTERS_SUPPORTED && *e != crate::daemon::REMOTE_PRINTERS_NO_CUPS)
            .map(|error| {
                let short: String = error.chars().take(NOTICE_CHARS).collect();
                let more = if short.len() < error.len() { "…" } else { "" };
                format!("Remote printers: {short}{more}")
            });
        Model {
            status: line,
            printers,
            remote_problem,
            paused,
            visible: status["settings"]["tray"] != false,
            dashboard: status["dashboardUrl"].as_str().map(String::from),
            unpaired: status["paired"] == false,
            update: (update["available"] == true && !updating && !latest.is_empty()).then(|| latest.to_string()),
        }
    }
}

pub fn fetch() -> Model {
    client::get("/api/status").map_or_else(|_| Model::not_running(), |status| Model::from_status(&status))
}

/// Polls the daemon on a background thread and hands every changed model to `apply`.
pub fn poll(apply: impl Fn(Model) + Send + 'static) {
    let spawned = std::thread::Builder::new().name("tray-poll".into()).spawn(move || {
        let mut last: Option<Model> = None;
        let mut greeted = false;
        loop {
            let model = fetch();
            if model.unpaired && !greeted {
                greeted = true;
                crate::first_run::open_pairing_page_once();
            }
            if last.as_ref() != Some(&model) {
                apply(model.clone());
                last = Some(model);
            }
            std::thread::sleep(POLL);
        }
    });
    if let Err(e) = spawned {
        log::error!("tray: could not start polling: {e}");
    }
}

/// Runs a menu action off the UI thread. Quitting a standalone `tray-ui` only closes the
/// icon, which the platform code handles before calling this.
pub fn perform(action: Action, in_process: bool) {
    std::thread::spawn(move || {
        let result = match action {
            Action::OpenDashboard => {
                if let Some(url) = fetch().dashboard {
                    platform::open_url(&url);
                }
                Ok(())
            }
            Action::OpenStatusPage => {
                platform::open_url(&page_url());
                Ok(())
            }
            Action::TogglePause => client::get("/api/settings")
                .and_then(|s| client::post("/api/settings", &json!({ "paused": s["paused"] != true })))
                .map(drop),
            Action::FindPrinters => client::post("/api/discover", &json!({})).map(drop),
            Action::Update => client::post("/api/update", &json!({ "install": true })).map(drop),
            Action::HideIcon => {
                let hidden = client::post("/api/settings", &json!({ "tray": false })).map(drop);
                platform::open_url(&format!("{}#tray-hidden", page_url()));
                hidden
            }
            Action::Quit if in_process => client::post("/api/quit", &json!({})).map(drop),
            Action::Quit => Ok(()),
        };
        if let Err(e) = result {
            log::warn!("tray action failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::Model;
    use serde_json::{Value, json};

    fn status(on: bool, error: Option<&str>) -> Value {
        json!({ "connection": "online", "settings": { "remotePrinters": on }, "remotePrinters": { "error": error } })
    }

    #[test]
    fn an_installable_update_adds_a_menu_item_until_it_starts() {
        let model = |update: Value| Model::from_status(&json!({ "connection": "online", "settings": {}, "update": update }));
        let ready = model(json!({ "latest": "0.3.0", "available": true, "phase": null }));
        assert_eq!(ready.update.as_deref(), Some("0.3.0"));
        assert!(super::Action::Update.shown(&ready));
        assert_eq!(super::Action::Update.label(&ready), "Update to 0.3.0");
        let busy = model(json!({ "latest": "0.3.0", "available": true, "phase": "downloading" }));
        assert_eq!((busy.update, busy.status.as_str()), (None, "Updating to 0.3.0…"));
        let current = model(json!({ "latest": "0.3.0", "available": false }));
        assert!(!super::Action::Update.shown(&current));
        assert_eq!(current.status, "Ready");
    }

    #[test]
    fn remote_printer_problems_get_one_short_line() {
        let problem = |on, error| Model::from_status(&status(on, error)).remote_problem;
        if !crate::daemon::REMOTE_PRINTERS_SUPPORTED {
            assert_eq!(problem(true, Some("Not available on Windows yet")), None);
            return;
        }
        assert_eq!(problem(true, Some("lpadmin: Forbidden")).as_deref(), Some("Remote printers: lpadmin: Forbidden"));
        let long = "lpadmin: Forbidden. ".repeat(10);
        let line = problem(true, Some(&long)).unwrap();
        assert!(line.starts_with("Remote printers: lpadmin") && line.ends_with('…') && line.chars().count() == 78, "{line}");
        assert_eq!(problem(false, Some(&long)), None, "off means nothing to report");
        assert_eq!(problem(true, None), None);
    }
}
