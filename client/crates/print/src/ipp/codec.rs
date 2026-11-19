//! RFC 8010 binary encoding. Decoding is bounds-checked and never panics on hostile input;
//! values with a malformed fixed-size body are kept raw instead of failing the whole message.

use super::tags::{group, value as tag};
use super::value::{Attribute, Group, Message, Value};

const MAX_DEPTH: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// Input ended before end-of-attributes-tag; more bytes may complete it.
    Truncated,
    Invalid(&'static str),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Truncated => f.write_str("truncated IPP message"),
            DecodeError::Invalid(why) => write!(f, "malformed IPP message: {why}"),
        }
    }
}

impl Message {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(1024);
        out.extend_from_slice(&[self.version.0, self.version.1]);
        out.extend_from_slice(&self.code.to_be_bytes());
        out.extend_from_slice(&self.request_id.to_be_bytes());
        for g in &self.groups {
            out.push(g.tag);
            for a in &g.attrs {
                for (i, v) in a.values.iter().enumerate() {
                    encode_value(&mut out, if i == 0 { &a.name } else { "" }, v);
                }
            }
        }
        out.push(group::END);
        out
    }

    /// Parses up to end-of-attributes-tag; returns the message and the offset where document data starts.
    pub fn decode(buf: &[u8]) -> Result<(Message, usize), DecodeError> {
        let mut r = Reader { buf, pos: 0 };
        let version = (r.u8()?, r.u8()?);
        let code = r.u16()?;
        let request_id = u32::from_be_bytes(fixed(r.take(4)?).ok_or(DecodeError::Truncated)?);
        let mut groups: Vec<Group> = Vec::new();
        loop {
            let t = r.u8()?;
            if t == group::END {
                return Ok((Message { version, code, request_id, groups }, r.pos));
            }
            if t == 0 {
                return Err(DecodeError::Invalid("reserved delimiter tag"));
            }
            if t < 0x10 {
                groups.push(Group { tag: t, attrs: Vec::new() });
                continue;
            }
            let group = groups.last_mut().ok_or(DecodeError::Invalid("attribute outside a group"))?;
            let (name, value) = read_value(&mut r, t, 0)?;
            if name.is_empty() {
                let attr = group.attrs.last_mut().ok_or(DecodeError::Invalid("value without attribute name"))?;
                attr.values.push(value);
            } else {
                group.attrs.push(Attribute { name, values: vec![value] });
            }
        }
    }
}

fn encode_value(out: &mut Vec<u8>, name: &str, v: &Value) {
    match v {
        Value::OutOfBand(t) => head(out, *t, name, &[]),
        Value::Integer(n) => head(out, tag::INTEGER, name, &n.to_be_bytes()),
        Value::Boolean(b) => head(out, tag::BOOLEAN, name, &[u8::from(*b)]),
        Value::Enum(n) => head(out, tag::ENUM, name, &n.to_be_bytes()),
        Value::DateTime(d) => head(out, tag::DATE_TIME, name, d),
        Value::Resolution(x, y, units) => {
            let mut b = [0u8; 9];
            b[..4].copy_from_slice(&x.to_be_bytes());
            b[4..8].copy_from_slice(&y.to_be_bytes());
            b[8] = units.to_be_bytes()[0];
            head(out, tag::RESOLUTION, name, &b);
        }
        Value::Range(lo, hi) => {
            let mut b = [0u8; 8];
            b[..4].copy_from_slice(&lo.to_be_bytes());
            b[4..].copy_from_slice(&hi.to_be_bytes());
            head(out, tag::RANGE, name, &b);
        }
        Value::TextLang(lang, s) | Value::NameLang(lang, s) => {
            let t = if matches!(v, Value::TextLang(..)) { tag::TEXT_WITH_LANGUAGE } else { tag::NAME_WITH_LANGUAGE };
            let mut b = Vec::with_capacity(lang.len() + s.len() + 4);
            put(&mut b, clip(lang, 255).as_bytes());
            put(&mut b, clip(s, u16::MAX as usize - 260).as_bytes());
            head(out, t, name, &b);
        }
        Value::Str(t, s) => head(out, *t, name, clip(s, u16::MAX as usize).as_bytes()),
        Value::Collection(members) => {
            head(out, tag::BEG_COLLECTION, name, &[]);
            for m in members.iter().filter(|m| !m.values.is_empty()) {
                head(out, tag::MEMBER_NAME, "", m.name.as_bytes());
                for mv in &m.values {
                    encode_value(out, "", mv);
                }
            }
            head(out, tag::END_COLLECTION, "", &[]);
        }
        Value::Raw(t, data) => head(out, *t, name, data),
    }
}

fn head(out: &mut Vec<u8>, t: u8, name: &str, value: &[u8]) {
    out.push(t);
    put(out, clip(name, u16::MAX as usize).as_bytes());
    put(out, value);
}

fn put(out: &mut Vec<u8>, b: &[u8]) {
    let b = &b[..b.len().min(u16::MAX as usize)];
    out.extend_from_slice(&(b.len() as u16).to_be_bytes());
    out.extend_from_slice(b);
}

/// Longest prefix of `s` within `max` bytes that ends on a char boundary.
pub fn clip(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let end = self.pos.checked_add(n).ok_or(DecodeError::Truncated)?;
        let out = self.buf.get(self.pos..end).ok_or(DecodeError::Truncated)?;
        self.pos = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, DecodeError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    /// One tag's name and value bytes (the tag itself is already consumed).
    fn field(&mut self) -> Result<(&'a [u8], &'a [u8]), DecodeError> {
        let name_len = self.u16()? as usize;
        let name = self.take(name_len)?;
        let len = self.u16()? as usize;
        Ok((name, self.take(len)?))
    }
}

fn read_value(r: &mut Reader, t: u8, depth: usize) -> Result<(String, Value), DecodeError> {
    let (name, data) = r.field()?;
    let value = if t == tag::BEG_COLLECTION { Value::Collection(read_collection(r, depth + 1)?) } else { parse(t, data) };
    Ok((utf8(name), value))
}

fn read_collection(r: &mut Reader, depth: usize) -> Result<Vec<Attribute>, DecodeError> {
    if depth > MAX_DEPTH {
        return Err(DecodeError::Invalid("collections nested too deeply"));
    }
    let mut members: Vec<Attribute> = Vec::new();
    loop {
        let t = r.u8()?;
        if t < 0x10 {
            return Err(DecodeError::Invalid("delimiter inside a collection"));
        }
        match t {
            tag::END_COLLECTION => {
                r.field()?;
                return Ok(members);
            }
            tag::MEMBER_NAME => {
                let (_, data) = r.field()?;
                members.push(Attribute { name: utf8(data), values: Vec::new() });
            }
            _ => {
                let (_, value) = read_value(r, t, depth)?;
                let member = members.last_mut().ok_or(DecodeError::Invalid("collection value without member name"))?;
                member.values.push(value);
            }
        }
    }
}

fn parse(t: u8, data: &[u8]) -> Value {
    let parsed = match t {
        0x10..=0x1F => Some(Value::OutOfBand(t)),
        tag::INTEGER => fixed(data).map(|b| Value::Integer(i32::from_be_bytes(b))),
        tag::ENUM => fixed(data).map(|b| Value::Enum(i32::from_be_bytes(b))),
        tag::BOOLEAN => fixed::<1>(data).map(|b| Value::Boolean(b[0] != 0)),
        tag::DATE_TIME => fixed(data).map(Value::DateTime),
        tag::RESOLUTION => fixed::<9>(data).map(|b| {
            let x = i32::from_be_bytes([b[0], b[1], b[2], b[3]]);
            let y = i32::from_be_bytes([b[4], b[5], b[6], b[7]]);
            Value::Resolution(x, y, i8::from_be_bytes([b[8]]))
        }),
        tag::RANGE => fixed::<8>(data).map(|b| {
            Value::Range(i32::from_be_bytes([b[0], b[1], b[2], b[3]]), i32::from_be_bytes([b[4], b[5], b[6], b[7]]))
        }),
        tag::TEXT_WITH_LANGUAGE | tag::NAME_WITH_LANGUAGE => with_language(data).map(|(lang, s)| {
            if t == tag::TEXT_WITH_LANGUAGE { Value::TextLang(lang, s) } else { Value::NameLang(lang, s) }
        }),
        0x40..=0x5F => Some(Value::Str(t, utf8(data))),
        _ => None,
    };
    parsed.unwrap_or_else(|| Value::Raw(t, data.to_vec()))
}

fn with_language(data: &[u8]) -> Option<(String, String)> {
    let mut r = Reader { buf: data, pos: 0 };
    let lang_len = r.u16().ok()? as usize;
    let lang = r.take(lang_len).ok()?;
    let len = r.u16().ok()? as usize;
    let text = r.take(len).ok()?;
    Some((utf8(lang), utf8(text)))
}

fn fixed<const N: usize>(data: &[u8]) -> Option<[u8; N]> {
    data.try_into().ok()
}

fn utf8(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}
