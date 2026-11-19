use super::{FakeCups, daemon, printer, until};
use crate::daemon::Daemon;
use crate::daemon::remote::{cups, serve, shared};
use crate::proto::{ClientMsg, ClientSettings, SystemPrinterState, SystemPrinters};
use crate::test_util::TempDir;
use pb_print::{PrinterState, Supply, SupplyKind};
use pb_print::ipp::IppClient;
use std::future::Future;
use std::sync::Arc;
use tokio::task::{LocalSet, spawn_local};

/// Runs the subsystem with `fake` as CUPS around `body`; port 0 picks an ephemeral one.
async fn running_on<F: Future>(port: u16, d: &Arc<Daemon>, fake: &Arc<FakeCups>, body: F) -> F::Output {
    LocalSet::new()
        .run_until(async {
            let task = spawn_local(serve(d.clone(), fake.clone(), port));
            let out = body.await;
            d.stopping.cancel();
            task.await.unwrap();
            out
        })
        .await
}

async fn running<F: Future>(d: &Arc<Daemon>, fake: &Arc<FakeCups>, body: F) -> F::Output {
    running_on(0, d, fake, body).await
}

fn status(d: &Daemon) -> (bool, Option<String>, usize) {
    d.with_state(|st| (st.remote.active, st.remote.error.clone(), st.remote.queues.len()))
}

fn uri_of(fake: &FakeCups, queue: &str) -> String {
    let add = fake.calls().into_iter().find(|c| c[1] == queue && c.contains(&"everywhere".to_string())).unwrap();
    add[4].clone()
}

#[tokio::test]
async fn queues_follow_the_snapshot_and_go_away_on_unpair() {
    let dir = TempDir::new();
    let d = daemon(&dir, "http://127.0.0.1:1");
    d.set_remote_printers(vec![
        printer("pr_07", "Upstairs laser", Some("Office"), "Den Pi", true),
        printer("pr_08", "Label maker", None, "Garage Mac", false),
    ]);
    let fake = Arc::new(FakeCups::default());
    running(&d, &fake, async {
        until("both queues", || status(&d) == (true, None, 2)).await;
        assert_eq!(*fake.reachable.lock().unwrap(), [true, true], "the loopback server listens before lpadmin runs");
        let ipp = IppClient::new("pb-test", dir.path());
        let laser = ipp.get_printer_attributes(&uri_of(&fake, "pb_pr_07")).await.unwrap();
        assert_eq!((laser.name.as_deref(), laser.location.as_deref()), (Some("Upstairs laser"), Some("Office")));
        let labels = ipp.get_printer_attributes(&uri_of(&fake, "pb_pr_08")).await.unwrap();
        assert_eq!(labels.status.state, PrinterState::Idle, "accepting while its device is away");
        assert_eq!(labels.status.message.as_deref(), Some("Waiting for Garage Mac"));
        assert_eq!(cups::load(&dir.paths()).len(), 2);

        d.set_remote_printers(vec![printer("pr_07", "Laser (renamed)", Some("Office"), "Den Pi", true)]);
        until("the rename and removal", || status(&d) == (true, None, 1)).await;
        assert_eq!(fake.calls_starting("-x"), [["-x", "pb_pr_08"]]);
        let update = fake.calls().into_iter().find(|c| c.contains(&"Laser (renamed)".to_string())).unwrap();
        assert!(!update.contains(&"everywhere".to_string()), "a rename only updates -D/-L: {update:?}");

        let uri = uri_of(&fake, "pb_pr_07");
        d.forget_credentials();
        until("removal on unpair", || status(&d) == (false, None, 0)).await;
        assert!(fake.queues.lock().unwrap().is_empty() && cups::load(&dir.paths()).is_empty());
        assert!(ipp.get_printer_attributes(&uri).await.is_err(), "the loopback server stopped");
    })
    .await;
}

#[tokio::test]
async fn foreign_queues_are_left_alone_and_lpadmin_failures_show_in_status() {
    let dir = TempDir::new();
    let d = daemon(&dir, "http://127.0.0.1:1");
    d.set_remote_printers(vec![printer("pr_07", "Laser", None, "Den Pi", true), printer("pr_09", "Inkjet", None, "Den Pi", true)]);
    let fake = Arc::new(FakeCups::default());
    fake.queues.lock().unwrap().insert("pb_pr_09".into());
    running(&d, &fake, async {
        until("the one queue it may add", || status(&d).2 == 1).await;
        let error = status(&d).1.unwrap();
        assert!(error.contains("pb_pr_09") && error.contains("already exists"), "{error}");
        assert!(fake.calls().iter().all(|c| c[1] != "pb_pr_09"));

        *fake.refuse.lock().unwrap() = Some("lpadmin: Forbidden".into());
        d.change_settings(ClientSettings { remote_printers: false, ..d.settings() }).unwrap();
        until("the refused removal", || status(&d).1.is_some_and(|e| e.contains("Forbidden"))).await;
        assert_eq!((status(&d).0, status(&d).2), (false, 1), "still recorded, so it is retried");

        *fake.refuse.lock().unwrap() = None;
        d.wake.remote.notify_one();
        until("the retried removal", || status(&d) == (false, None, 0)).await;
        assert!(fake.queues.lock().unwrap().contains("pb_pr_09"), "never touched");
    })
    .await;
}

#[tokio::test]
async fn shutdown_keeps_queues_and_a_restart_changes_nothing() {
    let dir = TempDir::new();
    let d = daemon(&dir, "http://127.0.0.1:1");
    d.set_remote_printers(vec![printer("pr_07", "Laser", None, "Den Pi", true)]);
    let fake = Arc::new(FakeCups::default());
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    running_on(port, &d, &fake, until("the queue", || status(&d) == (true, None, 1))).await;
    assert!(fake.calls_starting("-x").is_empty());
    drop(d);

    let d = daemon(&dir, "http://127.0.0.1:1");
    let calls = fake.calls().len();
    running_on(port, &d, &fake, until("the restart", || status(&d) == (true, None, 1))).await;
    assert_eq!(fake.calls().len(), calls, "the saved snapshot and queue list already match");
}

#[tokio::test]
async fn nothing_happens_until_a_server_sends_a_snapshot() {
    let dir = TempDir::new();
    let d = daemon(&dir, "http://127.0.0.1:1");
    let fake = Arc::new(FakeCups::default());
    running(&d, &fake, until("the server", || status(&d).0)).await;
    assert!(fake.calls().is_empty());
}

#[test]
fn the_loopback_printer_carries_supplies_and_its_web_page() {
    let mut p = printer("pr_07", "Laser", None, "Den Pi", true);
    p.supplies = vec![Supply { name: "Black".into(), kind: SupplyKind::Toner, color: Some("#000000".into()), level: 41 }];
    let s = shared(&p, Some("https://print.example.com/w/ws_01/printers"));
    assert_eq!(s.report.status.supplies, p.supplies);
    assert_eq!(s.info_url.as_deref(), Some("https://print.example.com/w/ws_01/printers/pr_07"));
    assert_eq!(shared(&p, None).info_url, None);
}

#[tokio::test]
async fn new_options_regenerate_the_ppd_and_level_changes_do_not() {
    let dir = TempDir::new();
    let d = daemon(&dir, "http://127.0.0.1:1");
    d.set_remote_printers(vec![printer("pr_07", "Laser", None, "Den Pi", true)]);
    let fake = Arc::new(FakeCups::default());
    let everywhere = |fake: &FakeCups| fake.calls().iter().filter(|c| c.contains(&"everywhere".to_string())).count();
    running(&d, &fake, async {
        until("the queue", || status(&d) == (true, None, 1)).await;
        let mut toner = printer("pr_07", "Laser", None, "Den Pi", true);
        toner.supplies = vec![Supply { name: "Black".into(), kind: SupplyKind::Toner, color: None, level: 41 }];
        d.set_remote_printers(vec![toner.clone()]);
        let ipp = IppClient::new("pb-test", dir.path());
        let uri = uri_of(&fake, "pb_pr_07");
        let mut level = None;
        for _ in 0..500 {
            level = ipp.get_printer_attributes(&uri).await.ok().and_then(|a| a.status.supplies.first().map(|s| s.level));
            if level == Some(41) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(level, Some(41), "the loopback printer reports the new level");
        assert_eq!(everywhere(&fake), 1, "a level change is not a PPD change");

        toner.capabilities.sources = vec!["tray-1".into(), "auto".into()];
        d.set_remote_printers(vec![toner]);
        until("the refresh", || everywhere(&fake) == 2).await;
        assert_eq!(*fake.marked.lock().unwrap(), ["pb_pr_07", "pb_pr_07"]);
        assert_eq!(fake.calls().len(), 2, "an add and a refresh, nothing else");
    })
    .await;
}

fn reports(d: &Daemon) -> Vec<SystemPrinters> {
    let mut rx = d.outbox_rx.try_lock().unwrap();
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|m| if let ClientMsg::SystemPrinters { report } = m { Some(report) } else { None })
        .collect()
}

fn state_of(report: &SystemPrinters, id: &str) -> SystemPrinterState {
    report.printers.iter().find(|p| p.id == id).unwrap().state
}

#[tokio::test]
async fn hidden_printers_get_no_queue_and_the_server_hears_about_it() {
    let dir = TempDir::new();
    let d = daemon(&dir, "http://127.0.0.1:1");
    d.change_settings(ClientSettings { remote_printers_hidden: vec!["pr_08".into()], ..d.settings() }).unwrap();
    d.set_remote_printers(vec![printer("pr_07", "Laser", None, "Den Pi", true), printer("pr_08", "Labels", None, "Den Pi", true)]);
    let fake = Arc::new(FakeCups::default());
    running(&d, &fake, async {
        until("the one shown queue", || status(&d) == (true, None, 1)).await;
        let report = reports(&d).pop().unwrap();
        assert_eq!((state_of(&report, "pr_07"), state_of(&report, "pr_08")), (SystemPrinterState::Added, SystemPrinterState::Hidden));
        assert!(fake.calls().iter().all(|c| c[1] != "pb_pr_08"));

        d.change_settings(ClientSettings { remote_printers_hidden: Vec::new(), ..d.settings() }).unwrap();
        until("the unhidden queue", || status(&d).2 == 2).await;
        until("the new report", || d.with_state(|st| st.remote.report.clone()).is_some_and(|r| state_of(&r, "pr_08") == SystemPrinterState::Added)).await;
        assert!(reports(&d).iter().any(|r| state_of(r, "pr_08") == SystemPrinterState::Added), "sent, not only stored");
    })
    .await;
}

#[tokio::test]
async fn the_default_follows_the_setting_until_someone_changes_it_here() {
    let dir = TempDir::new();
    let d = daemon(&dir, "http://127.0.0.1:1");
    d.set_remote_printers(vec![printer("pr_07", "Laser", None, "Den Pi", true)]);
    let fake = Arc::new(FakeCups::default());
    fake.devices.lock().unwrap().push(("Office_Laser".into(), "ipp://office-laser.local/ipp/print".into()));
    *fake.default.lock().unwrap() = Some("Office_Laser".into());
    running(&d, &fake, async {
        until("the queue", || status(&d) == (true, None, 1)).await;
        assert!(fake.calls_starting("-d").is_empty(), "no choice, no change");

        d.change_settings(ClientSettings { default_printer: Some("pr_07".into()), ..d.settings() }).unwrap();
        until("the new default", || fake.default.lock().unwrap().as_deref() == Some("pb_pr_07")).await;
        until("the report", || d.with_state(|st| st.remote.report.clone()).is_some_and(|r| r.default_printer_id.as_deref() == Some("pr_07"))).await;

        *fake.default.lock().unwrap() = Some("Office_Laser".into());
        d.wake.remote.notify_one();
        until("the setting to let go", || d.settings().default_printer.is_none()).await;
        assert_eq!(fake.calls_starting("-d"), [["-d", "pb_pr_07"]]);
        assert_eq!(fake.default.lock().unwrap().as_deref(), Some("Office_Laser"));
    })
    .await;
}
