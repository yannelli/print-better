//! One-page hardware checks: the ignored tests print ONE page each (PB_HW_SOCKET=host:9100,
//! PB_HW_IPP=ipp://host/ipp/print); `hardware_preview` decodes the same payloads to target/hw-preview/.
#![cfg(feature = "raster")]

mod support;

use pb_print::convert::convert_to;
use pb_print::ipp::{IppBody, IppJob, JobStateKind, PrinterAttrs};
use pb_print::*;
use std::path::{Path, PathBuf};
use std::time::Duration;
use support::{PAGE_MEDIA, decode, longest_dark_run_mm, test_page, today, write_png};
use tokio::io::AsyncReadExt;

const SOCKET_PATH: &str = "PNG > PCL raster over AppSocket (port 9100)";
const IPP_PATH: &str = "PDF > PWG raster over IPP";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pb-hw-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

fn engine(state: &Path) -> Engine {
    Engine::new(EngineOptions { user_agent: "PrintBetter-hwtest".into(), requesting_user: "pb-hwtest".into(), state_dir: state.into() })
}

fn actual_size() -> JobOptions {
    JobOptions { fit: Some(Fit::None), copies: Some(1), ..JobOptions::default() }
}

fn pdf_doc(dir: &Path, path_label: &str) -> Document {
    let path = dir.join("page.pdf");
    std::fs::write(&path, test_page(path_label, &today())).expect("write page");
    Document { path, format: DocFormat::Pdf, name: format!("Print Better hardware test: {path_label}") }
}

/// The socket test's input: the test page rendered to a 300 dpi grayscale PNG.
async fn socket_png(dir: &Path) -> Document {
    let attrs = PrinterAttrs {
        capabilities: Capabilities { media_default: Some(PAGE_MEDIA.into()), ..Capabilities::default() },
        pwg_types: vec!["sgray_8".into()],
        pwg_resolutions: vec![300],
        ..PrinterAttrs::default()
    };
    let pwg = dir.join("page.pwg");
    convert_to(&pdf_doc(dir, SOCKET_PATH), "image/pwg-raster", &attrs, &actual_size(), dir, &pwg).await.expect("render page");
    let (page, _) = decode::pwg(&std::fs::read(&pwg).expect("read pwg")).remove(0);
    let path = dir.join("page.png");
    write_png(&path, &page);
    Document { path, format: DocFormat::Png, name: format!("Print Better hardware test: {SOCKET_PATH}") }
}

fn socket_printer(uri: String) -> PrinterReport {
    PrinterReport {
        key: "net:hwtest".into(),
        name: "Hardware test printer".into(),
        make_model: None,
        uuid: None,
        location: None,
        local: false,
        routes: vec![Route { kind: RouteKind::Socket, uri }],
        capabilities: Capabilities {
            formats: vec!["application/vnd.hp-PCL".into()],
            media_default: Some(std::env::var("PB_HW_MEDIA").unwrap_or_else(|_| "na_letter_8.5x11in".into())),
            ..Capabilities::default()
        },
        status: PrinterStatus::default(),
    }
}

/// Printer attributes for the IPP payload: the real printer's when PB_HW_IPP is set (read-only).
async fn ipp_attrs(engine: &Engine) -> PrinterAttrs {
    match std::env::var("PB_HW_IPP") {
        Ok(uri) => engine.ipp().get_printer_attributes(&uri).await.expect("Get-Printer-Attributes"),
        Err(_) => PrinterAttrs {
            capabilities: Capabilities { media_default: Some("na_letter_8.5x11in".into()), ..Capabilities::default() },
            pwg_types: vec!["sgray_8".into()],
            pwg_resolutions: vec![300, 600],
            ..PrinterAttrs::default()
        },
    }
}

async fn ipp_pwg_file(engine: &Engine, dir: &Path) -> PathBuf {
    let out = dir.join("job.pwg");
    let pages = convert_to(&pdf_doc(dir, IPP_PATH), "image/pwg-raster", &ipp_attrs(engine).await, &actual_size(), dir, &out).await;
    assert_eq!(pages.expect("convert"), Some(1), "exactly one page");
    out
}

/// Checks a decoded payload page and saves it for inspection.
fn check_and_save(page: &decode::Page, name: &str) -> PathBuf {
    let ruler = longest_dark_run_mm(page);
    assert!((99.5..=100.8).contains(&ruler), "{name}: 10 cm ruler measures {ruler:.2} mm");
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/hw-preview");
    std::fs::create_dir_all(&dir).expect("preview dir");
    let path = dir.join(format!("{name}.png"));
    write_png(&path, page);
    println!("{name}: {}x{} px at {} dpi, ruler {ruler:.2} mm -> {}", page.width, page.height, page.dpi, path.display());
    path
}

#[tokio::test]
async fn hardware_preview() {
    let dir = scratch("preview");
    let e = engine(&dir);
    let doc = socket_png(&dir).await;
    let (l, port) = loop {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        if ![47631, 8631].contains(&port) {
            break (l, port);
        }
    };
    let uri = format!("socket://127.0.0.1:{port}");
    let capture = tokio::spawn(async move {
        let (mut s, _) = l.accept().await.expect("accept");
        let mut bytes = Vec::new();
        s.read_to_end(&mut bytes).await.expect("read");
        bytes
    });
    let outcome = e.print(&socket_printer(uri), &doc, &actual_size(), &CancelFlag::default(), &|_| {}).await;
    assert_eq!(outcome.expect("print to fake socket").pages, Some(1));
    let pcl = capture.await.expect("capture");
    assert!(pcl.starts_with(b"\x1b%-12345X@PJL JOB NAME=\"Print Better hardware test: PNG > PCL raster"));
    let pages = decode::pcl(&pcl);
    assert_eq!(pages.len(), 1, "exactly one page");
    check_and_save(&pages[0], "socket-pcl");

    let pwg = std::fs::read(ipp_pwg_file(&e, &dir).await).expect("read pwg");
    let pages = decode::pwg(&pwg);
    assert_eq!(pages.len(), 1, "exactly one page");
    check_and_save(&pages[0].0, "ipp-pwg");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "prints one page to the printer in PB_HW_SOCKET"]
async fn socket_pcl() {
    let target = std::env::var("PB_HW_SOCKET").expect("set PB_HW_SOCKET=host:9100");
    let dir = scratch("socket");
    let doc = socket_png(&dir).await;
    let events = |e: PrintEvent| println!("event: {e:?}");
    let outcome = engine(&dir).print(&socket_printer(format!("socket://{target}")), &doc, &actual_size(), &CancelFlag::default(), &events).await;
    println!("outcome: {outcome:?}");
    assert_eq!(outcome.expect("printed").pages, Some(1));
}

#[tokio::test]
#[ignore = "prints one page to the printer in PB_HW_IPP"]
async fn ipp_pwg() {
    let uri = std::env::var("PB_HW_IPP").expect("set PB_HW_IPP=ipp://host/ipp/print");
    let dir = scratch("ipp");
    let e = engine(&dir);
    let file = ipp_pwg_file(&e, &dir).await;
    let job = IppJob { name: format!("Print Better hardware test: {IPP_PATH}"), user: "pb-hwtest".into(), format: "image/pwg-raster".into(), options: JobOptions::default() };
    let id = e.ipp().print_job(&uri, &job, IppBody::File(file)).await.expect("Print-Job accepted");
    println!("job {id} accepted");
    for _ in 0..150 {
        let state = e.ipp().job_state(&uri, id).await.expect("Get-Job-Attributes");
        println!("job {id}: {:?} {:?} {:?}", state.state, state.reasons, state.message);
        match state.state {
            JobStateKind::Completed => return,
            JobStateKind::Aborted | JobStateKind::Canceled => panic!("job ended as {:?}", state.state),
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
    panic!("job {id} did not finish within 5 minutes");
}
