//! How print-engine errors read to people: the engine's own sentence, without its category prefix.

use pb_print::Error;

pub fn sentence(e: &Error) -> String {
    match e {
        Error::Unreachable(m) | Error::NotReady(m) | Error::Unsupported(m) | Error::Rejected(m) | Error::Protocol(m) => {
            m.clone()
        }
        Error::Canceled => "Canceled".into(),
        Error::Io(e) => format!("Something went wrong on this computer ({}).", e.kind()),
    }
}

#[cfg(test)]
mod tests {
    use super::sentence;
    use pb_print::Error;
    use std::io;

    #[test]
    fn every_variant_reads_as_its_own_sentence() {
        let text = |m: &str| m.to_string();
        assert_eq!(sentence(&Error::Unreachable(text("The printer is off."))), "The printer is off.");
        assert_eq!(sentence(&Error::NotReady(text("Out of paper."))), "Out of paper.");
        assert_eq!(sentence(&Error::Unsupported(text("Can't print PNG."))), "Can't print PNG.");
        let rejected = "It may have printed; it won't be sent again.";
        assert_eq!(sentence(&Error::Rejected(text(rejected))), rejected);
        assert_eq!(sentence(&Error::Protocol(text("Unexpected answer."))), "Unexpected answer.");
        assert_eq!(sentence(&Error::Canceled), "Canceled");
        let io = Error::Io(io::Error::new(io::ErrorKind::PermissionDenied, "EACCES /dev/usb/lp0"));
        assert_eq!(sentence(&io), "Something went wrong on this computer (permission denied).");
    }
}
