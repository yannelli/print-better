use crate::error::Error;
use crate::ipp::check::check;
use crate::ipp::uri::Target;
use crate::ipp::{Message, Value};

#[derive(Debug, PartialEq)]
enum Class {
    Ok,
    NotReady,
    Unsupported,
    Rejected,
    Canceled,
    Protocol,
}

fn class(code: u16) -> Class {
    let target = Target::parse("ipp://10.0.0.5/ipp/print").unwrap();
    let mut reply = Message::new((2, 0), code, 1);
    reply.operation().push("status-message", Value::text("printer says why"));
    let (class, message) = match check(&target, reply) {
        Ok(_) => return Class::Ok,
        Err(Error::Canceled) => return Class::Canceled,
        Err(Error::NotReady(m)) => (Class::NotReady, m),
        Err(Error::Unsupported(m)) => (Class::Unsupported, m),
        Err(Error::Rejected(m)) => (Class::Rejected, m),
        Err(Error::Protocol(m)) => (Class::Protocol, m),
        Err(e) => panic!("unexpected {e:?}"),
    };
    let code_text = format!("(0x{code:04x})");
    assert!(message.contains("10.0.0.5:631") && message.contains(&code_text) && message.contains("printer says why"), "{message}");
    class
}

#[test]
fn ipp_statuses_map_to_the_error_classes_the_engine_routes_on() {
    use Class::*;
    let table = [
        (0x0000, Ok),
        (0x0001, Ok),
        (0x0002, Ok),
        (0x0400, Rejected),
        (0x0401, Rejected),
        (0x0402, Rejected),
        (0x0403, Rejected),
        (0x0404, Rejected),
        (0x0405, NotReady),
        (0x0406, Rejected),
        (0x0407, Rejected),
        (0x0408, Rejected),
        (0x040A, Unsupported),
        (0x040B, Unsupported),
        (0x040E, Unsupported),
        (0x0411, Unsupported),
        (0x0500, Protocol),
        (0x0501, Unsupported),
        (0x0502, NotReady),
        (0x0503, Unsupported),
        (0x0504, NotReady),
        (0x0505, NotReady),
        (0x0506, NotReady),
        (0x0507, NotReady),
        (0x0508, Canceled),
        (0x0509, Unsupported),
        (0x050C, Protocol),
    ];
    for (code, want) in table {
        assert_eq!(class(code), want, "status {code:#06x}");
    }
}
