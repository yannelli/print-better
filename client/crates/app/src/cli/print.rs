//! `print` and `discover`: through the daemon when it runs, otherwise in this process.

use super::{Failure, Outcome, block_on, print_json};
use crate::local::client::{self, LocalError};
use crate::paths::Paths;
use crate::{choose, daemon, doc, platform, print_error, query, settings, store};
use pb_print::{CancelFlag, DocFormat, Document, PrintEvent, PrinterReport};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

pub fn print(file: &Path, flags: Vec<(&'static str, String)>) -> Outcome {
    let bytes = std::fs::read(file).map_err(|e| Failure::error(format!("Can't read {}: {e}", file.display())))?;
    let mut params: HashMap<String, String> = flags.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    query::job_options(&params).map_err(Failure::usage)?;
    let title = file.file_name().map_or_else(|| "Document".into(), |n| n.to_string_lossy().into_owned());
    params.insert("title".into(), title);
    if let Some(mime) = doc::mime_for_extension(file) {
        params.insert("type".into(), mime.into());
    }
    let encoded: Vec<String> = params.iter().map(|(k, v)| format!("{k}={}", query::encode(v))).collect();
    match client::post_bytes(&format!("/api/print?{}", encoded.join("&")), &bytes) {
        Ok(reply) => watch(&reply),
        Err(LocalError::NotRunning) => print_here(file, &params),
        Err(e) => Err(e.into()),
    }
}

/// Follows a queued job until it finishes; Ctrl+C stops watching but the job stays queued.
fn watch(reply: &Value) -> Outcome {
    let id = reply["id"].as_str().unwrap_or_default();
    println!("Sent to {}. (Ctrl+C stops watching; the job stays queued.)", reply["printer"].as_str().unwrap_or("the printer"));
    let mut last = String::new();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let job = client::get(&format!("/api/jobs/{}", query::encode(id)))?;
        let status = job["status"].as_str().unwrap_or_default();
        let message = job["message"].as_str().unwrap_or_default();
        let line = if message.is_empty() { status.to_string() } else { format!("{status}: {message}") };
        if line != last {
            eprintln!("  {line}");
            last = line;
        }
        match status {
            "completed" => {
                printed(message);
                return Ok(());
            }
            "failed" if message.is_empty() => return Err(Failure::error("The job didn't print.")),
            "failed" => return Err(Failure::error(message)),
            "canceled" => return Err(Failure::error("The job was canceled.")),
            _ => {}
        }
    }
}

fn print_here(file: &Path, params: &HashMap<String, String>) -> Outcome {
    eprintln!("Print Better isn't running, so this prints directly.");
    let paths = Paths::resolve();
    let format = doc::detect(file, params.get("type").map(String::as_str));
    if format == DocFormat::Unknown {
        return Err(Failure::error("Print Better can print PDF, JPEG, PNG, and plain text files."));
    }
    let options = query::job_options(params).map_err(Failure::usage)?;
    let config = store::load_config(&paths);
    let saved = store::load_state(&paths);
    let added: HashSet<String> = saved.printers.iter().filter(|p| p.added).map(|p| p.key.clone()).collect();
    let engine = daemon::make_engine(&paths, &platform::user_name());
    let document = Document {
        path: file.to_path_buf(),
        format,
        name: params.get("title").cloned().unwrap_or_else(|| "Document".into()),
    };
    let outcome = block_on(async {
        let printers = engine.discover(&settings::discover_options(&config.settings, None)).await;
        let printer = choose::printer(&printers, &added, params.get("printer").map(String::as_str)).map_err(Failure::error)?;
        let defaults = saved.printers.iter().find(|c| c.key == printer.key).map(|c| c.defaults.clone()).unwrap_or_default();
        eprintln!("Printing on {}...", printer.name);
        let on_event = |event: PrintEvent| eprintln!("  {}", describe(&event));
        let options = options.over(&defaults);
        engine.print(printer, &document, &options, &CancelFlag::default(), &on_event).await.map_err(|e| Failure::error(print_error::sentence(&e)))
    })??;
    printed(outcome.warning.as_deref().unwrap_or_default());
    Ok(())
}

/// The last line for a finished job; a warning means some of it may not have printed.
fn printed(warning: &str) {
    if warning.is_empty() { println!("Printed.") } else { println!("Printed with a problem: {warning}") }
}

fn describe(event: &PrintEvent) -> String {
    match event {
        PrintEvent::Converting => "Preparing the document".into(),
        PrintEvent::Submitting { route } => format!("Sending to the printer ({})", json!(route).as_str().unwrap_or("printer")),
        PrintEvent::Waiting { message } => message.clone(),
        PrintEvent::Printing { pages_done: Some(n) } => format!("Printing ({n} done)"),
        PrintEvent::Printing { pages_done: None } => "Printing".into(),
    }
}

pub fn discover(json: bool, timeout: u64) -> Outcome {
    let printers: Vec<PrinterReport> = match client::post("/api/discover", &json!({ "timeout": timeout })) {
        Ok(reply) => serde_json::from_value(reply["printers"].clone()).map_err(|e| Failure::error(e.to_string()))?,
        Err(LocalError::NotRunning) => {
            let paths = Paths::resolve();
            let options = settings::discover_options(&store::load_config(&paths).settings, Some(Duration::from_secs(timeout)));
            let engine = daemon::make_engine(&paths, &platform::user_name());
            block_on(engine.discover(&options))?
        }
        Err(e) => return Err(e.into()),
    };
    if json {
        print_json(&printers);
        return Ok(());
    }
    if printers.is_empty() {
        println!("No printers found. Check that the printer is on and connected to this computer or network.");
        return Ok(());
    }
    println!("Found {} printer(s):", printers.len());
    for printer in &printers {
        println!("\n  {}", printer.name);
        if let Some(model) = printer.make_model.as_ref().filter(|m| **m != printer.name) {
            println!("    model  {model}");
        }
        println!("    key    {}", printer.key);
        for route in &printer.routes {
            println!("    via    {}", route.uri);
        }
    }
    Ok(())
}
