//! `pair` and `unpair`. With the daemon running, pairing goes through it so the
//! credentials land in the service's own data folder.

use super::{Failure, Outcome, block_on, confirm};
use crate::local::client::{self, LocalError};
use crate::net::ServerUrl;
use crate::paths::Paths;
use crate::store::{self, Credentials};
use crate::{fsx, pairing, platform};
use serde_json::{Value, json};
use std::time::Duration;

pub fn pair(server: &str, token: Option<&str>, name: Option<&str>) -> Outcome {
    let url = ServerUrl::parse(server).map_err(Failure::usage)?;
    match client::get("/api/status") {
        Ok(status) => return via_daemon(&url, token, name, &status),
        Err(LocalError::NotRunning) => {}
        Err(e) => return Err(e.into()),
    }
    let paths = Paths::resolve();
    if let Some(existing) = store::load_credentials(&paths) {
        return already_paired(&existing.server, &existing.name, &url);
    }
    let creds = match token {
        Some(token) => block_on(pairing::enroll(&url, token, name))?,
        None => block_on(device_flow(&url, name))?,
    }
    .map_err(Failure::error)?;
    store::save_credentials(&paths, &creds).map_err(|e| Failure::error(format!("Could not save the pairing: {e}")))?;
    println!("Paired as \"{}\".", creds.name);
    Ok(())
}

async fn device_flow(url: &ServerUrl, name: Option<&str>) -> Result<Credentials, String> {
    let code = pairing::request_code(url, name).await?;
    show_code(&code.user_code, &code.verification_uri_complete);
    pairing::wait_for_approval(url, &code).await
}

fn via_daemon(url: &ServerUrl, token: Option<&str>, name: Option<&str>, status: &Value) -> Outcome {
    if status["connection"] == "revoked" {
        return Err(Failure::error("This device was removed from the server. Run \"printbetter unpair\", then pair again."));
    }
    if status["paired"] == true {
        return already_paired(text(&status["server"]), text(&status["name"]), url);
    }
    let reply = client::post("/api/pair", &json!({ "server": url.origin(), "token": token, "name": name }))?;
    if reply["paired"] == true {
        println!("Paired as \"{}\".", text(&reply["name"]));
        return Ok(());
    }
    show_code(text(&reply["userCode"]), text(&reply["verificationUriComplete"]));
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let status = client::get("/api/status")?;
        if status["paired"] == true {
            println!("Paired as \"{}\".", text(&status["name"]));
            return Ok(());
        }
        match status["pairing"]["state"].as_str() {
            Some("failed") => return Err(Failure::error(text(&status["pairing"]["message"]))),
            Some(_) => {}
            None => return Err(Failure::error("Pairing was canceled.")),
        }
    }
}

fn show_code(code: &str, link: &str) {
    println!("To finish pairing, open this link and check that it shows the same code:\n");
    println!("    {link}\n\n    Code: {code}\n");
    if platform::open_url(link) {
        println!("Your browser should open by itself.");
    }
    println!("Waiting for approval (press Ctrl+C to stop)...");
}

fn already_paired(server: &str, name: &str, wanted: &ServerUrl) -> Outcome {
    if server == wanted.origin() {
        println!("Already paired with {server} as \"{name}\".");
        return Ok(());
    }
    let message = format!("Already paired with {server} as \"{name}\". Run \"printbetter unpair\" first to pair with {}.", wanted.origin());
    Err(Failure::error(message))
}

pub fn unpair(yes: bool) -> Outcome {
    let status = client::get("/api/status");
    let paths = Paths::resolve();
    let server = match &status {
        Ok(status) if status["paired"] == true => text(&status["server"]).to_string(),
        Ok(_) => return Err(Failure::not_paired()),
        Err(LocalError::NotRunning) => store::load_credentials(&paths).ok_or_else(Failure::not_paired)?.server,
        Err(_) => return status.map(drop).map_err(Failure::from),
    };
    let question = format!("Disconnect this device from {server}? Printing from the web will stop. [y/N] ");
    if !yes && !confirm(&question, "Add --yes to unpair without being asked.")? {
        return Err(Failure::error("Nothing changed."));
    }
    if status.is_ok() {
        client::post("/api/unpair", &json!({}))?;
    } else {
        store::delete_credentials(&paths).map_err(|e| Failure::error(format!("Could not remove the pairing: {e}")))?;
        let _ = fsx::remove_if_exists(&paths.state_file());
        let _ = std::fs::remove_dir_all(paths.jobs());
    }
    println!("Unpaired. Pair again any time with: printbetter pair --server URL");
    Ok(())
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}
