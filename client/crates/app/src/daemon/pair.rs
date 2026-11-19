//! Pairing state owned by the daemon: storing and forgetting credentials, device-code flow.

use super::{Conn, Daemon, Pairing};
use crate::clock::now_ms;
use crate::net::ServerUrl;
use crate::pairing::{self, DeviceCode};
use crate::store::{self, Credentials, SavedState};
use pb_print::CancelFlag;
use std::io;
use std::sync::Arc;

impl Daemon {
    pub fn store_credentials(&self, creds: Credentials) -> io::Result<()> {
        store::save_credentials(&self.paths, &creds)?;
        log::info!("paired with {} as \"{}\"", creds.server, creds.name);
        {
            let mut st = self.lock();
            st.saved = SavedState::default();
            self.save_saved_state(&st);
            st.creds = Some(creds);
            st.halted_token = None;
            st.pairing = None;
        }
        self.wake.session.notify_one();
        self.wake.remote.notify_one();
        Ok(())
    }

    /// Forgets the pairing: credentials, server-provided printer settings, and every job.
    pub fn forget_credentials(&self) {
        if let Err(e) = store::delete_credentials(&self.paths) {
            log::error!("could not delete credentials: {e}");
        }
        {
            let mut st = self.lock();
            st.creds = None;
            st.halted_token = None;
            st.saved = SavedState::default();
            self.save_saved_state(&st);
            st.conn = Conn::Unpaired;
            st.conn_detail = None;
        }
        self.outbox.set_online(false);
        self.queue.clear();
        self.wake.session.notify_one();
        self.wake.share.notify_one();
        self.wake.remote.notify_one();
        log::info!("unpaired");
    }

    /// Stops the session for this token until the user pairs again (revoked or replaced).
    pub fn halt(&self, token: &str, conn: Conn, detail: &str) {
        let mut st = self.lock();
        st.halted_token = Some(token.to_string());
        st.conn = conn;
        st.conn_detail = Some(detail.to_string());
    }

    pub fn is_halted(&self, token: &str) -> bool {
        self.lock().halted_token.as_deref() == Some(token)
    }

    /// Polls for approval in the background; the status page shows the code meanwhile.
    pub fn start_device_pairing(self: &Arc<Self>, server: ServerUrl, code: DeviceCode) {
        let cancel = CancelFlag::default();
        let id = now_ms();
        {
            let mut st = self.lock();
            if let Some(old) = st.pairing.take() {
                old.cancel.cancel();
            }
            st.pairing = Some(Pairing {
                state: "waiting",
                server: server.origin(),
                user_code: Some(code.user_code.clone()),
                verification_uri: Some(code.verification_uri.clone()),
                verification_uri_complete: Some(code.verification_uri_complete.clone()),
                message: None,
                id,
                cancel: cancel.clone(),
            });
        }
        let d = self.clone();
        tokio::task::spawn_local(async move {
            let result = tokio::select! {
                result = pairing::wait_for_approval(&server, &code) => result,
                _ = cancel.canceled() => return,
            };
            let failure = match result {
                Ok(creds) => d.store_credentials(creds).err().map(|e| format!("Could not save the pairing: {e}")),
                Err(message) => Some(message),
            };
            if let Some(message) = failure {
                let mut st = d.lock();
                if let Some(pairing) = st.pairing.as_mut().filter(|p| p.id == id) {
                    pairing.state = "failed";
                    pairing.message = Some(message);
                }
            }
        });
    }

    pub fn cancel_pairing(&self) {
        if let Some(pairing) = self.lock().pairing.take() {
            pairing.cancel.cancel();
        }
    }
}
