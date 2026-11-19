//! JSON views for the status page, CLI, and tray.

use crate::daemon::{self, Daemon, State};
use crate::platform;
use crate::proto::PrinterConfig;
use crate::queue::record::JobRecord;
use pb_print::PrinterReport;
use serde_json::{Value, json};

pub fn build(d: &Daemon) -> Value {
    let printers = printers(d);
    let jobs: Vec<Value> = d.queue.list().iter().map(|rec| job(d, rec)).collect();
    let name = d.client_name();
    d.with_state(|st| {
        let creds = st.creds.as_ref();
        json!({
            "running": true,
            "version": crate::VERSION,
            "paired": creds.is_some(),
            "server": creds.map(|c| c.server.clone()),
            "dashboardUrl": creds.map(|c| format!("{}/", c.server)),
            "clientId": creds.map(|c| c.client_id.clone()),
            "workspaceId": creds.map(|c| c.workspace_id.clone()),
            "name": name,
            "connection": st.conn,
            "connectionDetail": st.conn_detail,
            "settings": st.config.settings,
            "pairing": st.pairing,
            "printers": printers,
            "jobs": jobs,
            "lanSharing": { "active": st.share_active, "error": st.share_error },
            "remotePrinters": remote_printers(st),
            "update": daemon::update_status(st),
            "discoveredAt": st.inventory.discovered_at,
            "logFile": d.paths.log_file(),
            "trayCapable": d.tray_capable,
            "system": platform::is_system(),
        })
    })
}

/// Printers on other devices and the system queues standing in for them here.
fn remote_printers(st: &State) -> Value {
    let printers: Vec<Value> = st
        .saved
        .remote_printers
        .iter()
        .flatten()
        .map(|p| json!({ "id": p.id, "name": p.name, "queue": st.remote.queues.get(&p.id), "online": p.online }))
        .collect();
    json!({ "active": st.remote.active, "error": st.remote.error, "printers": printers })
}

/// Known printers under their server-side names, plus added printers discovery can't see now.
pub fn printers(d: &Daemon) -> Vec<Value> {
    d.with_state(|st| {
        let config_for = |key: &str| st.saved.printers.iter().find(|c| c.key == key);
        let mut out: Vec<Value> =
            st.inventory.printers.values().map(|report| printer(report, config_for(&report.key))).collect();
        for config in st.saved.printers.iter().filter(|c| c.added && !st.inventory.printers.contains_key(&c.key)) {
            out.push(json!({
                "key": config.key,
                "name": config.name,
                "state": "offline",
                "message": "Not found on the network right now",
                "added": true,
                "lanShare": config.lan_share,
                "missing": true,
            }));
        }
        out
    })
}

fn printer(report: &PrinterReport, config: Option<&PrinterConfig>) -> Value {
    json!({
        "key": report.key,
        "name": config.map_or(&report.name, |c| &c.name),
        "makeModel": report.make_model,
        "location": report.location,
        "local": report.local,
        "state": report.status.state,
        "message": report.status.message,
        "reasons": report.status.reasons,
        "supplies": report.status.supplies,
        "routes": report.routes.iter().map(|r| r.kind).collect::<Vec<_>>(),
        "added": config.is_some_and(|c| c.added),
        "lanShare": config.is_some_and(|c| c.lan_share),
        "missing": false,
    })
}

pub fn job(d: &Daemon, rec: &JobRecord) -> Value {
    let printer_name = d.with_state(|st| {
        st.saved
            .printers
            .iter()
            .find(|c| c.key == rec.printer_key)
            .map(|c| c.name.clone())
            .or_else(|| st.inventory.printers.get(&rec.printer_key).map(|p| p.name.clone()))
    });
    json!({
        "id": rec.id,
        "title": rec.title,
        "printerKey": rec.printer_key,
        "printerName": printer_name,
        "status": rec.status,
        "running": d.queue.is_running(&rec.id),
        "message": rec.message,
        "pages": rec.pages,
        "source": rec.source,
        "user": rec.user,
        "createdAt": rec.created_at,
        "updatedAt": rec.updated_at,
    })
}
