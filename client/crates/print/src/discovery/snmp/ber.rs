//! Minimal BER for SNMPv1 Get/GetNext requests and their responses (RFC 1157). Parsing is
//! bounds-checked; anything unexpected yields None.

pub type Oid = Vec<u32>;

const MAX_ARCS: usize = 128;

#[derive(Clone, Debug, PartialEq)]
pub enum SnmpValue {
    /// INTEGER, Counter32, Gauge32, TimeTicks, Counter64.
    Int(i64),
    /// OCTET STRING, IpAddress, Opaque.
    Bytes(Vec<u8>),
    Oid(Oid),
    /// NULL, and the SNMPv2 noSuchObject/noSuchInstance/endOfMibView markers.
    Null,
}

impl SnmpValue {
    pub fn text(&self) -> Option<String> {
        let SnmpValue::Bytes(b) = self else { return None };
        let s = String::from_utf8_lossy(b).trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string();
        (!s.is_empty()).then_some(s)
    }

    pub fn int(&self) -> Option<i64> {
        match self {
            SnmpValue::Int(n) => Some(*n),
            _ => None,
        }
    }
}

pub struct Response {
    pub request_id: i32,
    pub error_status: i64,
    pub varbinds: Vec<(Oid, SnmpValue)>,
}

/// GetRequest (or GetNextRequest when `next`) for one OID.
pub fn request(community: &str, request_id: i32, oid: &[u32], next: bool) -> Vec<u8> {
    let varbind = tlv(0x30, &[tlv(0x06, &encode_oid(oid)), tlv(0x05, &[])].concat());
    let pdu = [int(i64::from(request_id)), int(0), int(0), tlv(0x30, &varbind)].concat();
    let message = [int(0), tlv(0x04, community.as_bytes()), tlv(if next { 0xA1 } else { 0xA0 }, &pdu)].concat();
    tlv(0x30, &message)
}

pub fn parse(buf: &[u8]) -> Option<Response> {
    let mut message = Der(Der(buf).expect(0x30)?);
    message.expect(0x02)?;
    message.expect(0x04)?;
    let mut pdu = Der(message.expect(0xA2)?);
    let request_id = i32::try_from(integer(pdu.expect(0x02)?)?).ok()?;
    let error_status = integer(pdu.expect(0x02)?)?;
    pdu.expect(0x02)?;
    let mut list = Der(pdu.expect(0x30)?);
    let mut varbinds = Vec::new();
    while !list.0.is_empty() {
        let mut varbind = Der(list.expect(0x30)?);
        let oid = decode_oid(varbind.expect(0x06)?)?;
        let (tag, data) = varbind.next()?;
        let value = match tag {
            0x02 | 0x41 | 0x42 | 0x43 | 0x46 => SnmpValue::Int(integer(data)?),
            0x04 | 0x40 | 0x44 => SnmpValue::Bytes(data.to_vec()),
            0x06 => SnmpValue::Oid(decode_oid(data)?),
            _ => SnmpValue::Null,
        };
        varbinds.push((oid, value));
    }
    Some(Response { request_id, error_status, varbinds })
}

fn tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = value.len();
    match u8::try_from(len) {
        Ok(n) if n < 0x80 => out.push(n),
        Ok(n) => out.extend_from_slice(&[0x81, n]),
        Err(_) => {
            let [_, _, hi, lo] = u32::try_from(len).unwrap_or(u32::MAX).to_be_bytes();
            out.extend_from_slice(&[0x82, hi, lo]);
        }
    }
    out.extend_from_slice(value);
    out
}

/// Minimal two's-complement INTEGER.
fn int(v: i64) -> Vec<u8> {
    let bytes = v.to_be_bytes();
    let mut start = 0;
    while start < 7 {
        let (b, next) = (bytes[start], bytes[start + 1]);
        if (b == 0 && next & 0x80 == 0) || (b == 0xFF && next & 0x80 != 0) {
            start += 1;
        } else {
            break;
        }
    }
    tlv(0x02, &bytes[start..])
}

fn encode_oid(oid: &[u32]) -> Vec<u8> {
    let mut out = Vec::new();
    if let [a, b, rest @ ..] = oid {
        base128(&mut out, a.saturating_mul(40).saturating_add(*b));
        for &arc in rest {
            base128(&mut out, arc);
        }
    }
    out
}

fn base128(out: &mut Vec<u8>, mut v: u32) {
    let mut tmp = [0u8; 5];
    let mut i = tmp.len();
    loop {
        i -= 1;
        tmp[i] = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            break;
        }
    }
    for (k, b) in tmp.iter().enumerate().skip(i) {
        out.push(if k + 1 < tmp.len() { b | 0x80 } else { *b });
    }
}

fn decode_oid(data: &[u8]) -> Option<Oid> {
    let (&first, rest) = data.split_first()?;
    let mut oid = if first < 80 { vec![u32::from(first / 40), u32::from(first % 40)] } else { vec![2, u32::from(first - 80)] };
    let mut arc: u32 = 0;
    let mut len = 0;
    for &b in rest {
        if arc > u32::MAX >> 7 {
            return None;
        }
        arc = (arc << 7) | u32::from(b & 0x7F);
        len += 1;
        if len > 5 {
            return None;
        }
        if b & 0x80 == 0 {
            oid.push(arc);
            arc = 0;
            len = 0;
            if oid.len() > MAX_ARCS {
                return None;
            }
        }
    }
    (len == 0).then_some(oid)
}

fn integer(data: &[u8]) -> Option<i64> {
    if data.is_empty() || data.len() > 9 {
        return None;
    }
    let negative = data[0] & 0x80 != 0;
    Some(data.iter().fold(if negative { -1i64 } else { 0 }, |acc, &b| acc.wrapping_shl(8) | i64::from(b)))
}

/// A cursor over consecutive TLVs.
struct Der<'a>(&'a [u8]);

impl<'a> Der<'a> {
    fn next(&mut self) -> Option<(u8, &'a [u8])> {
        let (&tag, rest) = self.0.split_first()?;
        let (&first, mut rest) = rest.split_first()?;
        let len = if first < 0x80 {
            usize::from(first)
        } else {
            let n = usize::from(first & 0x7F);
            if n == 0 || n > 4 {
                return None;
            }
            let (bytes, after) = rest.split_at_checked(n)?;
            rest = after;
            bytes.iter().fold(0usize, |acc, &b| (acc << 8) | usize::from(b))
        };
        let (value, after) = rest.split_at_checked(len)?;
        self.0 = after;
        Some((tag, value))
    }

    fn expect(&mut self, tag: u8) -> Option<&'a [u8]> {
        let (t, value) = self.next()?;
        (t == tag).then_some(value)
    }
}
