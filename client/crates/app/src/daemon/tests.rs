//! Settings last-write-wins between local changes (CLI, page, tray) and the hub, and when the
//! inventory counts as changed.

use super::Daemon;
use crate::clock::now_ms;
use crate::proto::{ClientMsg, ClientSettings};
use crate::store::{self, LocalConfig};
use crate::test_util::TempDir;

/// A daemon whose saved settings were last changed at `updated_at`.
fn daemon(dir: &TempDir, settings: ClientSettings, updated_at: i64, tray_capable: bool) -> Daemon {
    store::save_config(&dir.paths(), &LocalConfig { settings, settings_updated_at: updated_at }).unwrap();
    let d = Daemon::new(dir.paths(), tray_capable, false);
    d.outbox.set_online(true);
    d
}

fn sent(d: &Daemon) -> Vec<(ClientSettings, i64)> {
    let mut rx = d.outbox_rx.try_lock().unwrap();
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|msg| match msg {
            ClientMsg::Settings { settings, updated_at } => Some((settings, updated_at)),
            _ => None,
        })
        .collect()
}

fn paused() -> ClientSettings {
    ClientSettings { paused: true, ..ClientSettings::default() }
}

#[test]
fn newer_server_settings_win_and_are_saved() {
    let dir = TempDir::new();
    let d = daemon(&dir, ClientSettings::default(), 100, false);
    d.apply_server_settings(paused(), 200);
    assert!(d.settings().paused);
    let saved = store::load_config(&dir.paths());
    assert_eq!((saved.settings, saved.settings_updated_at), (paused(), 200));
    assert!(sent(&d).is_empty());
}

#[test]
fn older_server_settings_lose_and_ours_are_sent_back() {
    let dir = TempDir::new();
    let d = daemon(&dir, paused(), 300, false);
    d.apply_server_settings(ClientSettings::default(), 200);
    assert!(d.settings().paused);
    assert_eq!(sent(&d), [(paused(), 300)]);
    assert_eq!(store::load_config(&dir.paths()).settings_updated_at, 300);
}

#[test]
fn a_tie_takes_the_servers_copy() {
    let dir = TempDir::new();
    let d = daemon(&dir, ClientSettings::default(), 200, false);
    d.apply_server_settings(paused(), 200);
    assert!(d.settings().paused);
    assert!(sent(&d).is_empty());
}

#[test]
fn local_change_is_stamped_later_than_any_earlier_one_and_sent() {
    let dir = TempDir::new();
    let future = now_ms() + 10 * 24 * 3600 * 1000;
    let d = daemon(&dir, ClientSettings::default(), future, false);
    d.change_settings(paused()).unwrap();
    assert_eq!(sent(&d), [(paused(), future + 1)]);
    assert_eq!(store::load_config(&dir.paths()).settings_updated_at, future + 1);
    let before = now_ms();
    let dir = TempDir::new();
    let d = daemon(&dir, ClientSettings::default(), 5, false);
    d.change_settings(paused()).unwrap();
    assert!(sent(&d)[0].1 >= before, "stamped with the current time");
}

#[test]
fn unchanged_local_settings_are_not_sent() {
    let dir = TempDir::new();
    let d = daemon(&dir, paused(), 100, false);
    d.change_settings(paused()).unwrap();
    assert!(sent(&d).is_empty());
    assert_eq!(store::load_config(&dir.paths()).settings_updated_at, 100);
}

#[test]
fn turning_remote_printers_off_is_synced_like_any_setting() {
    let dir = TempDir::new();
    let d = daemon(&dir, ClientSettings::default(), 100, false);
    let off = ClientSettings { remote_printers: false, ..ClientSettings::default() };
    d.change_settings(off.clone()).unwrap();
    assert_eq!(sent(&d).into_iter().map(|(s, _)| s).collect::<Vec<_>>(), [off]);
    assert!(!store::load_config(&dir.paths()).settings.remote_printers);
}

#[test]
fn turning_the_tray_on_restarts_only_a_daemon_that_can_show_it() {
    let hidden = ClientSettings { tray: false, ..ClientSettings::default() };
    let dir = TempDir::new();
    let d = daemon(&dir, hidden.clone(), 100, true);
    d.apply_server_settings(ClientSettings::default(), 200);
    assert!(d.restart_requested() && d.stopping.is_canceled());
    let dir = TempDir::new();
    let d = daemon(&dir, hidden, 100, false);
    d.apply_server_settings(ClientSettings::default(), 200);
    assert!(!d.restart_requested() && !d.stopping.is_canceled());
}

#[test]
fn a_capability_change_is_an_inventory_change_and_a_status_change_is_not() {
    use super::state::Inventory;
    use pb_print::{PrinterReport, PrinterState};
    let laser = |duplex: bool, state: PrinterState| {
        let mut p: PrinterReport = serde_json::from_value(serde_json::json!({
            "key": "uuid:5f0c2a7e", "name": "Laser", "makeModel": null, "uuid": null, "location": null, "local": false, "routes": [],
            "capabilities": { "formats": [], "color": false, "duplex": false, "media": [], "mediaDefault": null, "resolutions": [], "copiesMax": 1 },
            "status": { "state": "idle", "reasons": [], "message": null, "supplies": [] }
        }))
        .unwrap();
        p.capabilities.duplex = duplex;
        p.status.state = state;
        p
    };
    let mut inventory = Inventory::default();
    let keep = std::collections::HashSet::new();
    assert!(inventory.merge(vec![laser(false, PrinterState::Idle)], &keep));
    assert!(!inventory.merge(vec![laser(false, PrinterState::Printing)], &keep), "status travels as printer_status");
    assert!(inventory.merge(vec![laser(true, PrinterState::Printing)], &keep), "a printer that can now duplex is re-reported");
}
