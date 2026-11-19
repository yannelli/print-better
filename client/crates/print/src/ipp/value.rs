//! IPP message model: ordered groups of named, multi-valued attributes (RFC 8010 section 3).

use super::tags::{group, value as tag};

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// unsupported, unknown, no-value, not-settable, delete-attribute, admin-define.
    OutOfBand(u8),
    Integer(i32),
    Boolean(bool),
    Enum(i32),
    DateTime([u8; 11]),
    /// Cross-feed, feed, units (3 = dots per inch, 4 = dots per cm).
    Resolution(i32, i32, i8),
    Range(i32, i32),
    /// (language, text)
    TextLang(String, String),
    /// (language, name)
    NameLang(String, String),
    /// Character-string syntaxes (text, name, keyword, uri, charset, mimeMediaType, ...) with their tag.
    Str(u8, String),
    Collection(Vec<Attribute>),
    /// octetString and any syntax this codec does not interpret, extension tag included.
    Raw(u8, Vec<u8>),
}

impl Value {
    pub fn keyword(s: &str) -> Value {
        Value::Str(tag::KEYWORD, s.to_string())
    }
    pub fn text(s: &str) -> Value {
        Value::Str(tag::TEXT, s.to_string())
    }
    pub fn name(s: &str) -> Value {
        Value::Str(tag::NAME, s.to_string())
    }
    pub fn uri(s: &str) -> Value {
        Value::Str(tag::URI, s.to_string())
    }
    pub fn mime(s: &str) -> Value {
        Value::Str(tag::MIME_TYPE, s.to_string())
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(_, s) | Value::TextLang(_, s) | Value::NameLang(_, s) => Some(s),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i32> {
        match self {
            Value::Integer(n) | Value::Enum(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Boolean(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_collection(&self) -> Option<&[Attribute]> {
        match self {
            Value::Collection(members) => Some(members),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Attribute {
    pub name: String,
    pub values: Vec<Value>,
}

impl Attribute {
    pub fn new(name: &str, value: Value) -> Attribute {
        Attribute { name: name.to_string(), values: vec![value] }
    }

    pub fn many(name: &str, values: Vec<Value>) -> Attribute {
        Attribute { name: name.to_string(), values }
    }

    pub fn str(&self) -> Option<&str> {
        self.values.first().and_then(Value::as_str)
    }

    pub fn strs(&self) -> impl Iterator<Item = &str> {
        self.values.iter().filter_map(Value::as_str)
    }

    pub fn int(&self) -> Option<i32> {
        self.values.first().and_then(Value::as_int)
    }

    pub fn ints(&self) -> impl Iterator<Item = i32> + '_ {
        self.values.iter().filter_map(Value::as_int)
    }

    pub fn bool(&self) -> Option<bool> {
        self.values.first().and_then(Value::as_bool)
    }
}

/// Looks up a member of a collection value or an attribute group by name.
pub fn find<'a>(attrs: &'a [Attribute], name: &str) -> Option<&'a Attribute> {
    attrs.iter().find(|a| a.name == name)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub tag: u8,
    pub attrs: Vec<Attribute>,
}

impl Group {
    pub fn get(&self, name: &str) -> Option<&Attribute> {
        find(&self.attrs, name)
    }

    pub fn push(&mut self, name: &str, value: Value) {
        self.attrs.push(Attribute::new(name, value));
    }

    pub fn push_many(&mut self, name: &str, values: Vec<Value>) {
        if !values.is_empty() {
            self.attrs.push(Attribute::many(name, values));
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub version: (u8, u8),
    /// operation-id in requests, status-code in responses.
    pub code: u16,
    pub request_id: u32,
    pub groups: Vec<Group>,
}

impl Message {
    /// A request or response with the mandatory charset and language operation attributes.
    pub fn new(version: (u8, u8), code: u16, request_id: u32) -> Message {
        let mut op = Group { tag: group::OPERATION, attrs: Vec::new() };
        op.push("attributes-charset", Value::Str(tag::CHARSET, "utf-8".into()));
        op.push("attributes-natural-language", Value::Str(tag::LANGUAGE, "en".into()));
        Message { version, code, request_id, groups: vec![op] }
    }

    pub fn group(&self, tag: u8) -> Option<&Group> {
        self.groups.iter().find(|g| g.tag == tag)
    }

    pub fn groups_of(&self, tag: u8) -> impl Iterator<Item = &Group> {
        self.groups.iter().filter(move |g| g.tag == tag)
    }

    /// The first group with `tag`, appended when missing.
    pub fn group_mut(&mut self, tag: u8) -> &mut Group {
        let index = match self.groups.iter().position(|g| g.tag == tag) {
            Some(i) => i,
            None => {
                self.groups.push(Group { tag, attrs: Vec::new() });
                self.groups.len() - 1
            }
        };
        &mut self.groups[index]
    }

    pub fn operation(&mut self) -> &mut Group {
        self.group_mut(group::OPERATION)
    }

    pub fn attr(&self, group_tag: u8, name: &str) -> Option<&Attribute> {
        self.group(group_tag).and_then(|g| g.get(name))
    }

    /// status-message, for error reports.
    pub fn status_message(&self) -> Option<&str> {
        self.attr(group::OPERATION, "status-message").and_then(Attribute::str)
    }
}
