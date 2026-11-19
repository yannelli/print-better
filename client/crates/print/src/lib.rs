//! pb-print: printer discovery, protocols, document conversion, and LAN sharing.
//! Knows nothing about the Print Better server; the `printbetter` app crate drives it.

pub mod backends;
pub mod convert;
pub mod device_id;
pub mod discovery;
pub mod engine;
pub mod error;
pub mod ipp;
pub mod model;
pub mod share;

pub use discovery::DiscoverOptions;
pub use engine::{CancelFlag, Engine, EngineOptions, PrintEvent, PrintOutcome};
pub use error::{Error, Result};
pub use model::*;
