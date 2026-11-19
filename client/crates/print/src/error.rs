use std::fmt;

#[derive(Debug)]
pub enum Error {
    /// No route reached the printer: refused, timed out, unplugged, DNS failure.
    Unreachable(String),
    /// Reachable but not taking work now: stopped, out of paper, jammed, door open.
    NotReady(String),
    /// Format or option the printer cannot handle even after conversion.
    Unsupported(String),
    /// Printer or spooler refused the job for a reason retrying will not fix.
    Rejected(String),
    Canceled,
    Io(std::io::Error),
    /// Malformed response or unexpected protocol state; treated as transient.
    Protocol(String),
}

impl Error {
    /// Whether the job should stay queued and be retried with backoff.
    pub fn is_transient(&self) -> bool {
        matches!(self, Error::Unreachable(_) | Error::NotReady(_) | Error::Io(_) | Error::Protocol(_))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Unreachable(m) => write!(f, "printer unreachable: {m}"),
            Error::NotReady(m) => write!(f, "printer not ready: {m}"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
            Error::Rejected(m) => write!(f, "rejected: {m}"),
            Error::Canceled => f.write_str("canceled"),
            Error::Io(e) => write!(f, "i/o error: {e}"),
            Error::Protocol(m) => write!(f, "protocol error: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
