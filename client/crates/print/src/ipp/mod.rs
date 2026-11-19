//! IPP/1.1-2.0 (RFC 8010/8011) codec and client.

mod check;
pub mod client;
pub mod codec;
mod http;
pub(crate) mod job;
pub(crate) mod printer;
pub(crate) mod resolve;
pub mod tags;
mod tls;
pub(crate) mod uri;
pub mod value;
#[cfg(test)]
pub(crate) mod tests;

pub use client::{IppBody, IppClient, IppJob, IppJobState, JobStateKind, PrinterAttrs};
pub use codec::DecodeError;
pub use value::{Attribute, Group, Message, Value};
