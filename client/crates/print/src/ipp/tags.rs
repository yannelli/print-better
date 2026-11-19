//! RFC 8010/8011 wire constants (plus the PWG and CUPS extensions we use).

pub mod op {
    pub const PRINT_JOB: u16 = 0x0002;
    pub const VALIDATE_JOB: u16 = 0x0004;
    pub const CREATE_JOB: u16 = 0x0005;
    pub const SEND_DOCUMENT: u16 = 0x0006;
    pub const CANCEL_JOB: u16 = 0x0008;
    pub const GET_JOB_ATTRIBUTES: u16 = 0x0009;
    pub const GET_JOBS: u16 = 0x000A;
    pub const GET_PRINTER_ATTRIBUTES: u16 = 0x000B;
    pub const CANCEL_MY_JOBS: u16 = 0x0039;
    pub const CLOSE_JOB: u16 = 0x003B;
    pub const IDENTIFY_PRINTER: u16 = 0x003C;
    pub const CUPS_GET_PRINTERS: u16 = 0x4002;
}

pub mod status {
    pub const OK: u16 = 0x0000;
    pub const OK_IGNORED_OR_SUBSTITUTED: u16 = 0x0001;
    pub const BAD_REQUEST: u16 = 0x0400;
    pub const FORBIDDEN: u16 = 0x0401;
    pub const NOT_AUTHENTICATED: u16 = 0x0402;
    pub const NOT_AUTHORIZED: u16 = 0x0403;
    pub const NOT_POSSIBLE: u16 = 0x0404;
    pub const CLIENT_TIMEOUT: u16 = 0x0405;
    pub const NOT_FOUND: u16 = 0x0406;
    pub const GONE: u16 = 0x0407;
    pub const TOO_LARGE: u16 = 0x0408;
    pub const DOCUMENT_FORMAT_NOT_SUPPORTED: u16 = 0x040A;
    pub const ATTRIBUTES_NOT_SUPPORTED: u16 = 0x040B;
    pub const CONFLICTING_ATTRIBUTES: u16 = 0x040E;
    pub const DOCUMENT_FORMAT_ERROR: u16 = 0x0411;
    pub const INTERNAL_ERROR: u16 = 0x0500;
    pub const OPERATION_NOT_SUPPORTED: u16 = 0x0501;
    pub const SERVICE_UNAVAILABLE: u16 = 0x0502;
    pub const VERSION_NOT_SUPPORTED: u16 = 0x0503;
    pub const DEVICE_ERROR: u16 = 0x0504;
    pub const TEMPORARY_ERROR: u16 = 0x0505;
    pub const NOT_ACCEPTING_JOBS: u16 = 0x0506;
    pub const BUSY: u16 = 0x0507;
    pub const JOB_CANCELED: u16 = 0x0508;
    pub const MULTIPLE_DOCUMENTS_NOT_SUPPORTED: u16 = 0x0509;
}

pub mod group {
    pub const OPERATION: u8 = 0x01;
    pub const JOB: u8 = 0x02;
    pub const END: u8 = 0x03;
    pub const PRINTER: u8 = 0x04;
    pub const UNSUPPORTED: u8 = 0x05;
}

pub mod value {
    pub const UNSUPPORTED: u8 = 0x10;
    pub const UNKNOWN: u8 = 0x12;
    pub const NO_VALUE: u8 = 0x13;
    pub const INTEGER: u8 = 0x21;
    pub const BOOLEAN: u8 = 0x22;
    pub const ENUM: u8 = 0x23;
    pub const OCTET_STRING: u8 = 0x30;
    pub const DATE_TIME: u8 = 0x31;
    pub const RESOLUTION: u8 = 0x32;
    pub const RANGE: u8 = 0x33;
    pub const BEG_COLLECTION: u8 = 0x34;
    pub const TEXT_WITH_LANGUAGE: u8 = 0x35;
    pub const NAME_WITH_LANGUAGE: u8 = 0x36;
    pub const END_COLLECTION: u8 = 0x37;
    pub const TEXT: u8 = 0x41;
    pub const NAME: u8 = 0x42;
    pub const KEYWORD: u8 = 0x44;
    pub const URI: u8 = 0x45;
    pub const URI_SCHEME: u8 = 0x46;
    pub const CHARSET: u8 = 0x47;
    pub const LANGUAGE: u8 = 0x48;
    pub const MIME_TYPE: u8 = 0x49;
    pub const MEMBER_NAME: u8 = 0x4A;
    pub const EXTENSION: u8 = 0x7F;
}

/// printer-state enum values.
pub mod printer_state {
    pub const IDLE: i32 = 3;
    pub const PROCESSING: i32 = 4;
    pub const STOPPED: i32 = 5;
}

/// job-state enum values.
pub mod job_state {
    pub const PENDING: i32 = 3;
    pub const PENDING_HELD: i32 = 4;
    pub const PROCESSING: i32 = 5;
    pub const PROCESSING_STOPPED: i32 = 6;
    pub const CANCELED: i32 = 7;
    pub const ABORTED: i32 = 8;
    pub const COMPLETED: i32 = 9;
}

pub fn is_success(status: u16) -> bool {
    status < 0x0100
}
