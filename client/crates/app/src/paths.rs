use std::path::PathBuf;

#[cfg(any(target_os = "macos", windows))]
const APP_DIR: &str = "Print Better";
pub const CREDENTIALS_FILE: &str = "credentials.json";
pub const CONFIG_FILE: &str = "config.json";
/// A per-user install's config folder, relative to that user's home (default XDG location on Linux).
#[cfg(target_os = "macos")]
pub const USER_CONFIG_DIR: &str = "Library/Application Support/Print Better";
#[cfg(all(unix, not(target_os = "macos")))]
pub const USER_CONFIG_DIR: &str = ".config/printbetter";

/// Config, state, and log locations per docs/architecture.md (Paths).
#[derive(Clone, Debug)]
pub struct Paths {
    pub config: PathBuf,
    pub state: PathBuf,
    pub logs: PathBuf,
}

impl Paths {
    pub fn resolve() -> Paths {
        match std::env::var_os("PRINTBETTER_HOME").filter(|v| !v.is_empty()) {
            Some(home) => {
                let home = PathBuf::from(home);
                Paths { config: home.clone(), logs: home.join("logs"), state: home }
            }
            None => platform_paths(),
        }
    }

    pub fn credentials(&self) -> PathBuf {
        self.config.join(CREDENTIALS_FILE)
    }

    pub fn config_file(&self) -> PathBuf {
        self.config.join(CONFIG_FILE)
    }

    pub fn state_file(&self) -> PathBuf {
        self.state.join("state.json")
    }

    pub fn jobs(&self) -> PathBuf {
        self.state.join("jobs")
    }

    pub fn spool(&self) -> PathBuf {
        self.state.join("spool")
    }

    pub fn share_spool(&self) -> PathBuf {
        self.state.join("share-spool")
    }

    pub fn remote_spool(&self) -> PathBuf {
        self.state.join("remote-spool")
    }

    /// System print queues this daemon created for remote printers; survives unpairing.
    pub fn remote_queues(&self) -> PathBuf {
        self.state.join("remote-queues.json")
    }

    /// Downloaded releases waiting to be installed.
    pub fn updates(&self) -> PathBuf {
        self.state.join("updates")
    }

    pub fn engine(&self) -> PathBuf {
        self.state.join("engine")
    }

    pub fn log_file(&self) -> PathBuf {
        self.logs.join("printbetter.log")
    }
}

fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(target_os = "macos")]
fn platform_paths() -> Paths {
    let (support, logs) = if crate::platform::is_system() {
        (PathBuf::from("/Library/Application Support"), PathBuf::from("/Library/Logs"))
    } else {
        let library = home().join("Library");
        (library.join("Application Support"), library.join("Logs"))
    };
    let dir = support.join(APP_DIR);
    Paths { config: dir.clone(), state: dir, logs: logs.join(APP_DIR) }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_paths() -> Paths {
    if crate::platform::is_system() {
        let state = PathBuf::from("/var/lib/printbetter");
        return Paths { config: PathBuf::from("/etc/printbetter"), logs: state.join("logs"), state };
    }
    let xdg = |var: &str, fallback: &str| {
        std::env::var_os(var)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(fallback))
    };
    let state = xdg("XDG_STATE_HOME", ".local/state").join("printbetter");
    Paths { config: xdg("XDG_CONFIG_HOME", ".config").join("printbetter"), logs: state.join("logs"), state }
}

#[cfg(windows)]
fn platform_paths() -> Paths {
    let base = std::env::var_os("LOCALAPPDATA")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("AppData").join("Local"));
    let dir = base.join(APP_DIR);
    Paths { config: dir.clone(), logs: dir.join("logs"), state: dir }
}

/// Where the SYSTEM account keeps its data; `service install --system` copies the pairing there.
#[cfg(windows)]
pub fn windows_system_dir() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join(r"System32\config\systemprofile\AppData\Local").join(APP_DIR)
}
