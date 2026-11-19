use crate::ipp::codec::{DecodeError, clip};
use crate::ipp::tags::{group, value as tag};
use crate::ipp::{Attribute, Group, Message, Value};
use std::time::{Duration, Instant};

/// One RFC 8010 attribute on the wire: tag, then length-prefixed name and value.
fn field(t: u8, name: &str, value: &[u8]) -> Vec<u8> {
    let mut out = vec![t];
    out.extend_from_slice(&u16::try_from(name.len()).unwrap().to_be_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&u16::try_from(value.len()).unwrap().to_be_bytes());
    out.extend_from_slice(value);
    out
}

/// Every value syntax the codec models, with nested and multi-valued collections.
fn sample() -> Message {
    let size = Value::Collection(vec![
        Attribute::new("x-dimension", Value::Integer(21590)),
        Attribute::new("y-dimension", Value::Integer(27940)),
    ]);
    let leaf = Value::Collection(vec![Attribute::new("leaf", Value::Boolean(true))]);
    let col = Value::Collection(vec![
        Attribute::new("media-size", size),
        Attribute::many("media-source", vec![Value::keyword("auto"), Value::keyword("main")]),
        Attribute::new("media-info", Value::TextLang("de".into(), "Briefpapier".into())),
        Attribute::new("media-deep", Value::Collection(vec![Attribute::new("inner", leaf)])),
    ]);
    let mut m = Message::new((2, 0), 0x0002, 0xDEAD_BEEF);
    let op = m.operation();
    op.push("printer-uri", Value::uri("ipp://printer.local:631/ipp/print"));
    op.push("requesting-user-name", Value::NameLang("fr".into(), "Élodie".into()));
    op.push("job-name", Value::name("report.pdf"));
    op.push("document-format", Value::mime("application/pdf"));
    op.push("compression", Value::keyword("none"));
    op.push("job-message", Value::text("héllo wörld"));
    op.push("scheme", Value::Str(tag::URI_SCHEME, "ipps".into()));
    op.push("ipp-attribute-fidelity", Value::Boolean(false));
    let job = m.group_mut(group::JOB);
    job.push("copies", Value::Integer(i32::MAX));
    job.push("job-priority", Value::Integer(-42));
    job.push("orientation-requested", Value::Enum(4));
    job.push("job-hold-until-time", Value::DateTime([0x07, 0xEA, 11, 18, 18, 30, 5, 3, b'-', 5, 0]));
    job.push("printer-resolution", Value::Resolution(600, 1200, 3));
    job.push("metric-resolution", Value::Resolution(118, 118, 4));
    job.push_many("page-ranges", vec![Value::Range(1, 3), Value::Range(5, i32::MAX)]);
    job.push("media-col", col.clone());
    job.push_many("media-col-database", vec![col.clone(), col]);
    job.push("octets", Value::Raw(tag::OCTET_STRING, vec![0, 1, 0xFE, 0xFF]));
    job.push("extension", Value::Raw(tag::EXTENSION, vec![0x40, 0, 0, 1, 9, 9]));
    job.push("unassigned", Value::Raw(0x38, vec![7]));
    let unsupported = m.group_mut(group::UNSUPPORTED);
    for t in [tag::UNSUPPORTED, 0x11, tag::UNKNOWN, tag::NO_VALUE, 0x15, 0x16, 0x17] {
        unsupported.push(&format!("out-of-band-{t:02x}"), Value::OutOfBand(t));
    }
    // Get-Jobs replies repeat the job group once per job; repeats must stay separate groups.
    m.groups.push(Group { tag: group::JOB, attrs: vec![Attribute::new("job-id", Value::Integer(7))] });
    m
}

fn nested(levels: usize) -> Value {
    let leaf = Value::Collection(vec![Attribute::new("leaf", Value::Integer(1))]);
    (1..levels).fold(leaf, |inner, _| Value::Collection(vec![Attribute::new("m", inner)]))
}

#[test]
fn round_trip_preserves_every_value_syntax() {
    let msg = sample();
    let bytes = msg.encode();
    assert_eq!(Message::decode(&bytes), Ok((msg, bytes.len())));
}

#[test]
fn document_data_starts_after_the_end_tag() {
    let mut bytes = sample().encode();
    let head = bytes.len();
    bytes.extend_from_slice(b"%PDF-1.7\n");
    let (_, end) = Message::decode(&bytes).unwrap();
    assert_eq!(end, head);
    assert_eq!(&bytes[end..], b"%PDF-1.7\n");
}

#[test]
fn matches_the_research_example_byte_for_byte() {
    let mut msg = Message::new((2, 0), 0x000B, 1);
    msg.operation().push("printer-uri", Value::uri("ipp://10.0.0.5:631/ipp/print"));
    let wanted = vec![Value::keyword("printer-state"), Value::keyword("printer-state-reasons")];
    msg.operation().push_many("requested-attributes", wanted);
    let mut expected = vec![0x02, 0x00, 0x00, 0x0B, 0x00, 0x00, 0x00, 0x01, 0x01];
    expected.extend(field(0x47, "attributes-charset", b"utf-8"));
    expected.extend(field(0x48, "attributes-natural-language", b"en"));
    expected.extend(field(0x45, "printer-uri", b"ipp://10.0.0.5:631/ipp/print"));
    expected.extend(field(0x44, "requested-attributes", b"printer-state"));
    expected.extend(field(0x44, "", b"printer-state-reasons"));
    expected.push(0x03);
    assert_eq!(expected.len(), 180);
    assert_eq!(msg.encode(), expected);
    assert_eq!(Message::decode(&expected), Ok((msg, 180)));
}

#[test]
fn every_truncation_is_reported_as_truncated() {
    let bytes = sample().encode();
    for cut in 0..bytes.len() {
        assert_eq!(Message::decode(&bytes[..cut]), Err(DecodeError::Truncated), "prefix of {cut} bytes");
    }
}

#[test]
fn malformed_fixed_size_values_are_kept_raw() {
    let cases: [(u8, &[u8]); 7] = [
        (tag::INTEGER, &[0, 1]),
        (tag::ENUM, &[1, 2, 3, 4, 5]),
        (tag::BOOLEAN, &[1, 1]),
        (tag::DATE_TIME, &[0; 10]),
        (tag::RESOLUTION, &[0; 8]),
        (tag::RANGE, &[0; 4]),
        (tag::TEXT_WITH_LANGUAGE, &[0, 9, b'e']),
    ];
    for (t, value) in cases {
        let bytes = [&[2, 0, 0, 0x0B, 0, 0, 0, 1, group::OPERATION][..], &field(t, "x", value), &[group::END]].concat();
        let (msg, _) = Message::decode(&bytes).unwrap();
        assert_eq!(msg.groups[0].attrs[0].values, vec![Value::Raw(t, value.to_vec())], "tag {t:#04x}");
    }
}

#[test]
fn structural_garbage_is_invalid() {
    let invalid = |body: &[Vec<u8>]| {
        let bytes = [vec![2, 0, 0, 0x0B, 0, 0, 0, 1], body.concat()].concat();
        matches!(Message::decode(&bytes), Err(DecodeError::Invalid(_)))
    };
    let op = vec![group::OPERATION];
    let begin = field(tag::BEG_COLLECTION, "c", b"");
    assert!(invalid(&[field(tag::KEYWORD, "x", b"y")]), "attribute before any group");
    assert!(invalid(&[op.clone(), field(tag::KEYWORD, "", b"y")]), "additional value with nothing before it");
    assert!(invalid(&[op.clone(), vec![0x00]]), "reserved delimiter");
    assert!(invalid(&[op.clone(), begin.clone(), field(tag::INTEGER, "", &[0, 0, 0, 1])]), "member value without a name");
    assert!(invalid(&[op, begin, vec![group::JOB]]), "delimiter inside a collection");
}

#[test]
fn collections_nest_up_to_eight_levels() {
    for (levels, ok) in [(8, true), (9, false)] {
        let mut msg = Message::new((2, 0), 0x000B, 1);
        msg.operation().push("c", nested(levels));
        assert_eq!(Message::decode(&msg.encode()).is_ok(), ok, "{levels} levels");
    }
}

#[test]
fn clip_never_splits_a_character() {
    assert_eq!(clip("héllo", 2), "h");
    assert_eq!(clip("héllo", 3), "hé");
    assert_eq!(clip("abc", 10), "abc");
    assert_eq!(clip("€uro", 2), "");
}

#[test]
fn oversized_strings_are_clipped_to_the_wire_limit() {
    let long = "é".repeat(40_000);
    let mut msg = Message::new((2, 0), 0x000B, 1);
    msg.operation().push("job-name", Value::name(&long));
    let (back, _) = Message::decode(&msg.encode()).unwrap();
    let got = back.attr(group::OPERATION, "job-name").and_then(Attribute::str).unwrap();
    assert_eq!(got.len(), 65534, "largest whole number of 2-byte characters within 65535 bytes");
    assert!(long.starts_with(got));
}

/// xorshift64*: deterministic randomness without a dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

#[test]
fn hostile_mutations_never_panic_and_reencode_stably() {
    let base = sample().encode();
    let mut rng = Rng(0x5EED_1234_ABCD_0001);
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut decoded = 0;
    for round in 0..200_000 {
        if round % 1024 == 0 && Instant::now() > deadline {
            break;
        }
        let mut bytes = base.clone();
        for _ in 0..=rng.below(4) {
            if bytes.is_empty() {
                break;
            }
            let at = rng.below(bytes.len());
            match rng.below(6) {
                0 => bytes[at] ^= 1u8 << rng.below(8),
                1 => bytes[at] = [0x00, 0x03, 0x10, 0x34, 0x37, 0x4A, 0x7F, 0xFF][rng.below(8)],
                2 => bytes.insert(at, rng.next() as u8),
                3 => drop(bytes.remove(at)),
                4 => bytes.truncate(at),
                _ => {
                    let chunk = bytes[at..(at + rng.below(16)).min(bytes.len())].to_vec();
                    bytes.splice(at..at, chunk);
                }
            }
        }
        if let Ok((msg, end)) = Message::decode(&bytes) {
            decoded += 1;
            assert!(end <= bytes.len());
            let once = Message::decode(&msg.encode()).expect("a decoded message re-encodes").0;
            let twice = Message::decode(&once.encode()).expect("and decodes again").0;
            assert_eq!(once, twice, "re-encoding is stable after one normalization");
        }
    }
    assert!(decoded > 0, "some mutations should still decode");
}
