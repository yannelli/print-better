use crate::proto::ClientMsg;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Messages for the server. Dropped while offline: after reconnecting the hub re-offers
/// unfinished jobs (answered with their latest status) and the inventory is re-sent.
#[derive(Clone)]
pub struct Outbox {
    tx: UnboundedSender<ClientMsg>,
    online: Arc<AtomicBool>,
}

impl Outbox {
    pub fn new() -> (Outbox, UnboundedReceiver<ClientMsg>) {
        let (tx, rx) = unbounded_channel();
        (Outbox { tx, online: Arc::new(AtomicBool::new(false)) }, rx)
    }

    pub fn send(&self, msg: ClientMsg) {
        if self.is_online() {
            let _ = self.tx.send(msg);
        }
    }

    pub fn set_online(&self, online: bool) {
        self.online.store(online, Ordering::SeqCst);
    }

    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }
}
