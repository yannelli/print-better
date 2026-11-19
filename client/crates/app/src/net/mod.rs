//! Talking to the Print Better server: URL rules, TLS, HTTP requests, and the WebSocket.

pub mod http;
pub mod stream;
pub mod url;
pub mod ws;

pub use http::NetError;
pub use url::ServerUrl;

pub const USER_AGENT: &str = concat!("PrintBetter/", env!("CARGO_PKG_VERSION"));
