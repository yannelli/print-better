//! LAN sharing glue: runs `ShareServer` while `settings.lanSharing` is on and feeds its
//! jobs into the local queue.

use super::Daemon;
use crate::clock::now_ms;
use crate::proto::LAN_SHARE_PORT;
use crate::queue::Queue;
use pb_print::PrinterReport;
use pb_print::share::{ShareOptions, ShareServer, ShareSink, SharedJob, SharedJobState, SharedPrinter};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

const RECHECK: Duration = Duration::from_secs(60);

struct QueueSink(Arc<Queue>);

impl ShareSink for QueueSink {
    fn submit(&self, job: SharedJob) -> Result<u32, String> {
        Ok(self.0.add_shared(job, now_ms()))
    }

    fn state(&self, id: u32) -> Option<(SharedJobState, Option<String>)> {
        self.0.shared_state(id)
    }

    fn cancel(&self, id: u32) -> bool {
        self.0.cancel_shared(id, now_ms())
    }
}

pub async fn run(d: Arc<Daemon>) {
    let mut server: Option<ShareServer> = None;
    let mut served: Vec<(String, String, PrinterReport)> = Vec::new();
    loop {
        let wanted = d.settings().lan_sharing;
        if wanted && server.is_none() {
            let opts = ShareOptions {
                port: LAN_SHARE_PORT,
                spool_dir: d.paths.share_spool(),
                host_label: d.client_name(),
                loopback_only: false,
                formats: None,
            };
            let _ = std::fs::create_dir_all(&opts.spool_dir);
            match ShareServer::start(opts, Arc::new(QueueSink(d.queue.clone()))).await {
                Ok(started) => {
                    log::info!("LAN sharing started on port {LAN_SHARE_PORT}");
                    server = Some(started);
                    served.clear();
                    d.set_share_status(true, None);
                }
                Err(e) => {
                    log::warn!("LAN sharing could not start: {e}");
                    d.set_share_status(false, Some(e.to_string()));
                }
            }
        } else if !wanted && let Some(running) = server.take() {
            running.stop().await;
            log::info!("LAN sharing stopped");
            d.set_share_status(false, None);
        }
        if let Some(running) = &server {
            let printers = shared_printers(&d);
            if printers != served {
                running.set_printers(
                    printers
                        .iter()
                        .map(|(key, name, report)| SharedPrinter { key: key.clone(), name: name.clone(), report: report.clone() })
                        .collect(),
                );
                served = printers;
            }
        }
        tokio::select! {
            _ = d.wake.share.notified() => {}
            _ = sleep(RECHECK) => {}
            _ = d.stopping.canceled() => {
                if let Some(running) = server.take() {
                    running.stop().await;
                }
                return;
            }
        }
    }
}

/// Added printers with `lanShare`, under their server-side names, that discovery can reach.
fn shared_printers(d: &Daemon) -> Vec<(String, String, PrinterReport)> {
    d.with_state(|st| {
        st.saved
            .printers
            .iter()
            .filter(|config| config.added && config.lan_share)
            .filter_map(|config| {
                let report = st.inventory.printers.get(&config.key)?;
                Some((config.key.clone(), config.name.clone(), report.clone()))
            })
            .collect()
    })
}
