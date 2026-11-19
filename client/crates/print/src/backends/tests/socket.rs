use super::{EventLog, closed_port, drop_after, listener, payload, read_all, stall};
use crate::backends::{STALLED, pjl, socket};
use crate::convert::tests::TestDir;
use crate::engine::{CancelFlag, PrintEvent};
use crate::error::Error;
use crate::model::{ColorMode, DocFormat, JobOptions, Sides};
use std::time::Duration;

#[tokio::test]
async fn sends_each_copy_in_its_own_pjl_job() {
    let dir = TestDir::new("socket-pjl");
    let options = JobOptions {
        sides: Some(Sides::TwoSidedLongEdge),
        media: Some("iso_a4_210x297mm".into()),
        color_mode: Some(ColorMode::Monochrome),
        ..JobOptions::default()
    };
    let (prefix, suffix) = pjl::wrap(DocFormat::Pdf, "Q3 \"final\" r\u{e9}port", &options).expect("pdf takes pjl");
    let head = String::from_utf8_lossy(&prefix).into_owned();
    assert_eq!(
        head,
        "\x1b%-12345X@PJL JOB NAME=\"Q3 final rport\"\r\n@PJL SET DUPLEX=ON\r\n@PJL SET BINDING=LONGEDGE\r\n\
         @PJL SET PAPER=A4\r\n@PJL SET RENDERMODE=GRAYSCALE\r\n@PJL ENTER LANGUAGE=PDF\r\n"
    );
    assert_eq!(suffix, b"\x1b%-12345X@PJL EOJ NAME=\"Q3 final rport\"\r\n\x1b%-12345X");
    let p = payload(&dir, b"%PDF-1.4 body", &prefix, &suffix, 2);
    let (l, port) = listener().await;
    let server = tokio::spawn(read_all(l));
    let log = EventLog::default();
    socket::send(&format!("socket://127.0.0.1:{port}"), &p, &CancelFlag::default(), &log.sink()).await.expect("send");
    let one = [prefix.as_slice(), b"%PDF-1.4 body", &suffix].concat();
    assert_eq!(server.await.expect("server"), [one.clone(), one].concat());
    assert_eq!(log.list(), [PrintEvent::Printing { pages_done: None }]);
}

#[test]
fn pjl_only_wraps_page_description_languages() {
    let o = JobOptions::default();
    assert!(pjl::wrap(DocFormat::PwgRaster, "x", &o).is_none() && pjl::wrap(DocFormat::Urf, "x", &o).is_none());
    let (pcl, _) = pjl::wrap(DocFormat::Pcl, "", &o).expect("pcl");
    assert!(String::from_utf8_lossy(&pcl).ends_with("NAME=\"Print Better\"\r\n@PJL ENTER LANGUAGE=PCL\r\n"));
    let long = "n".repeat(300);
    let (ps, _) = pjl::wrap(DocFormat::PostScript, &long, &o).expect("ps");
    assert!(String::from_utf8_lossy(&ps).contains(&format!("NAME=\"{}\"", "n".repeat(80))));
}

#[tokio::test]
async fn refused_connection_is_unreachable() {
    let dir = TestDir::new("socket-refused");
    let p = payload(&dir, b"data", b"", b"", 1);
    let uri = format!("socket://127.0.0.1:{}", closed_port().await);
    let err = socket::send(&uri, &p, &CancelFlag::default(), &EventLog::default().sink()).await.expect_err("refused");
    assert!(matches!(&err, Error::Unreachable(m) if m.contains("refused")), "{err:?}");
}

#[tokio::test]
async fn hang_up_after_some_bytes_is_rejected_not_retried() {
    let dir = TestDir::new("socket-drop");
    let p = payload(&dir, &vec![b'x'; 16 << 20], b"", b"", 1);
    let (l, port) = listener().await;
    let server = tokio::spawn(drop_after(l, 64 * 1024));
    let err = socket::send(&format!("socket://127.0.0.1:{port}"), &p, &CancelFlag::default(), &EventLog::default().sink())
        .await
        .expect_err("dropped");
    server.await.expect("server");
    assert!(matches!(&err, Error::Rejected(m) if m.contains("partway")), "{err:?}");
}

#[tokio::test]
async fn a_stalled_printer_reports_waiting_and_cancel_stops_it() {
    let dir = TestDir::new("socket-stall");
    let p = payload(&dir, &vec![b'x'; 32 << 20], b"", b"", 1);
    let (l, port) = listener().await;
    let _server = tokio::spawn(stall(l));
    let (log, cancel) = (EventLog::default(), CancelFlag::default());
    let watcher = {
        let (log, cancel) = (log.clone(), cancel.clone());
        tokio::spawn(async move {
            for _ in 0..200 {
                if log.waited() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            cancel.cancel();
        })
    };
    let result = socket::send(&format!("socket://127.0.0.1:{port}"), &p, &cancel, &log.sink()).await;
    watcher.await.expect("watcher");
    assert!(matches!(result, Err(Error::Canceled)), "{result:?}");
    assert!(log.list().contains(&PrintEvent::Waiting { message: STALLED.into() }), "{:?}", log.list());
}
