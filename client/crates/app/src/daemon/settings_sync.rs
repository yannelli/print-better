//! Settings last-write-wins with the hub, and what the daemon does when they change.

use super::Daemon;
use crate::clock::now_ms;
use crate::logger;
use crate::proto::{ClientMsg, ClientSettings, PrinterConfig};
use crate::store::{self, LocalConfig};

impl Daemon {
    /// A local change (CLI, status page, tray): persisted, applied, and sent to the hub.
    pub fn change_settings(&self, next: ClientSettings) -> Result<(), String> {
        let now = self.server_time_ms();
        let (old, updated_at) = {
            let mut st = self.lock();
            if st.config.settings == next {
                return Ok(());
            }
            let config = LocalConfig {
                settings: next.clone(),
                settings_updated_at: now.max(st.config.settings_updated_at + 1),
            };
            store::save_config(&self.paths, &config).map_err(|e| format!("Could not save settings: {e}"))?;
            let updated_at = config.settings_updated_at;
            (std::mem::replace(&mut st.config, config).settings, updated_at)
        };
        self.outbox.send(ClientMsg::Settings { settings: next.clone(), updated_at });
        self.settings_changed(&old, &next);
        Ok(())
    }

    /// `settings` from the hub. The newer `updatedAt` wins; if ours is newer, send it back.
    pub fn apply_server_settings(&self, settings: ClientSettings, updated_at: i64) {
        let old = {
            let mut st = self.lock();
            if updated_at < st.config.settings_updated_at {
                let ours = ClientMsg::Settings {
                    settings: st.config.settings.clone(),
                    updated_at: st.config.settings_updated_at,
                };
                drop(st);
                self.outbox.send(ours);
                return;
            }
            let config = LocalConfig { settings: settings.clone(), settings_updated_at: updated_at };
            if let Err(e) = store::save_config(&self.paths, &config) {
                log::warn!("could not save settings: {e}");
            }
            std::mem::replace(&mut st.config, config).settings
        };
        self.settings_changed(&old, &settings);
    }

    fn settings_changed(&self, old: &ClientSettings, new: &ClientSettings) {
        if old == new {
            return;
        }
        log::info!("settings updated");
        if old.paused != new.paused {
            self.queue.wake();
        }
        if old.discovery != new.discovery {
            self.wake.discover.notify_one();
        }
        if old.lan_sharing != new.lan_sharing {
            self.wake.share.notify_one();
        }
        let shown = |s: &ClientSettings| (s.remote_printers, s.remote_printers_hidden.clone(), s.default_printer.clone());
        if shown(old) != shown(new) {
            self.wake.remote.notify_one();
        }
        if old.log_level != new.log_level {
            logger::set_debug(new.log_level == "debug");
        }
        // AppKit needs the main thread, which tokio already owns; a fresh process can take it.
        if new.tray && !old.tray && self.tray_capable && !self.tray_running {
            self.stop(true, "showing the tray icon");
        }
    }

    pub fn on_welcome(
        &self,
        name: String,
        settings: ClientSettings,
        settings_updated_at: i64,
        server_time: i64,
        printers: Vec<PrinterConfig>,
    ) {
        {
            let mut st = self.lock();
            st.clock_offset_ms = Some(server_time - now_ms());
            st.saved.name = Some(name);
            st.saved.printers = printers;
            self.save_saved_state(&st);
        }
        self.apply_server_settings(settings, settings_updated_at);
        self.wake.share.notify_one();
        self.queue.wake();
    }

    pub fn set_printer_configs(&self, printers: Vec<PrinterConfig>) {
        {
            let mut st = self.lock();
            st.saved.printers = printers;
            self.save_saved_state(&st);
        }
        self.wake.share.notify_one();
        self.queue.wake();
    }
}
