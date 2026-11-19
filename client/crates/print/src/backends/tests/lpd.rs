use super::{EventLog, listener, payload};
use crate::backends::lpd;
use crate::convert::tests::TestDir;
use crate::engine::CancelFlag;
use crate::error::Error;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(Debug, Default)]
struct Received {
    queue: String,
    control_name: String,
    control: String,
    data_name: String,
    data: Vec<u8>,
}

/// An RFC 1179 receiver: acknowledges with `answer` to the queue, then 0 to everything else.
async fn lpd_server(l: TcpListener, answer: u8) -> Received {
    let (s, _) = l.accept().await.expect("accept");
    let mut s = BufReader::new(s);
    let mut got = Received::default();
    let mut line = Vec::new();
    s.read_until(b'\n', &mut line).await.expect("queue line");
    assert_eq!(line[0], 2, "receive-job command");
    got.queue = String::from_utf8_lossy(&line[1..line.len() - 1]).into_owned();
    s.get_mut().write_all(&[answer]).await.expect("ack");
    loop {
        line.clear();
        if s.read_until(b'\n', &mut line).await.expect("subcommand") == 0 {
            return got;
        }
        let text = String::from_utf8_lossy(&line[1..line.len() - 1]).into_owned();
        let (len, name) = text.split_once(' ').expect("count and name");
        let mut body = vec![0u8; len.parse::<usize>().expect("count") + 1];
        s.get_mut().write_all(&[0]).await.expect("ack");
        s.read_exact(&mut body).await.expect("body");
        assert_eq!(body.pop(), Some(0), "a zero byte ends each file");
        match line[0] {
            2 => (got.control_name, got.control) = (name.into(), String::from_utf8_lossy(&body).into_owned()),
            3 => (got.data_name, got.data) = (name.into(), body),
            other => panic!("unexpected subcommand {other}"),
        }
        s.get_mut().write_all(&[0]).await.expect("ack");
    }
}

#[tokio::test]
async fn control_file_then_data_with_every_copy_inside() {
    let dir = TestDir::new("lpd");
    let p = payload(&dir, b"BODY", b"PRE", b"SUF", 3);
    let (l, port) = listener().await;
    let server = tokio::spawn(lpd_server(l, 0));
    let uri = format!("lpd://127.0.0.1:{port}/Office%20Queue");
    lpd::send(&uri, &p, "Budget \u{e9}2026", "tester", &CancelFlag::default(), &EventLog::default().sink()).await.expect("send");
    let got = server.await.expect("server");
    assert_eq!(got.queue, "Office Queue");
    assert_eq!(got.data, b"PREBODYSUF".repeat(3));
    let lines: Vec<&str> = got.control.lines().collect();
    let data = &got.data_name;
    assert_eq!(lines, ["Hprintbetter", "Ptester", "JBudget 2026", "NBudget 2026", &format!("l{data}"), &format!("U{data}")]);
    assert!(got.control_name.starts_with("cfA") && data.starts_with("dfA") && got.control_name[3..] == data[3..]);
}

#[tokio::test]
async fn a_queue_the_server_refuses_is_unreachable() {
    let dir = TestDir::new("lpd-refused");
    let p = payload(&dir, b"BODY", b"", b"", 1);
    let (l, port) = listener().await;
    let server = tokio::spawn(lpd_server(l, 1));
    let result = lpd::send(&format!("lpd://127.0.0.1:{port}/nope"), &p, "doc", "u", &CancelFlag::default(), &EventLog::default().sink()).await;
    assert!(matches!(&result, Err(Error::Unreachable(m)) if m.contains("\"nope\"")), "{result:?}");
    let got = server.await.expect("server");
    assert!(got.data.is_empty() && got.control.is_empty(), "nothing was sent");
}

#[tokio::test]
async fn cancel_while_waiting_for_an_acknowledgement() {
    let dir = TestDir::new("lpd-cancel");
    let p = payload(&dir, b"BODY", b"", b"", 1);
    let (l, port) = listener().await;
    let _server = tokio::spawn(async move {
        let (s, _) = l.accept().await.expect("accept");
        tokio::time::sleep(Duration::from_secs(30)).await;
        drop(s);
    });
    let cancel = CancelFlag::default();
    let canceler = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.cancel();
        })
    };
    let result = lpd::send(&format!("lpd://127.0.0.1:{port}"), &p, "doc", "u", &cancel, &EventLog::default().sink()).await;
    canceler.await.expect("canceler");
    assert!(matches!(result, Err(Error::Canceled)), "{result:?}");
}
