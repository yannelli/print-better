//! Just enough PDF syntax to count pages: dictionaries, arrays, names, numbers and references.

const MAX_DEPTH: u32 = 32;
const MAX_ITEMS: usize = 200_000;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Obj {
    Null,
    Bool(bool),
    Int(i64),
    Real,
    Name(Vec<u8>),
    Str,
    Array(Vec<Obj>),
    Dict(Vec<(Vec<u8>, Obj)>),
    /// An indirect reference; the generation is not needed to find objects.
    Ref(u32),
}

impl Obj {
    pub fn get(&self, key: &[u8]) -> Option<&Obj> {
        match self {
            Obj::Dict(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn int(&self) -> Option<i64> {
        if let Obj::Int(n) = self { Some(*n) } else { None }
    }

    pub fn name(&self) -> Option<&[u8]> {
        if let Obj::Name(n) = self { Some(n) } else { None }
    }

    pub fn items(&self) -> Option<&[Obj]> {
        if let Obj::Array(items) = self { Some(items) } else { None }
    }

    pub fn is_type(&self, name: &[u8]) -> bool {
        self.get(b"Type").and_then(Obj::name) == Some(name)
    }
}

/// Why parsing stopped: `Short` means the buffer ended first, so a bigger read may succeed.
#[derive(Debug, PartialEq)]
pub(super) enum Stop {
    Short,
    Bad,
}

pub(super) type Parsed<T> = Result<T, Stop>;

pub(super) fn is_space(b: u8) -> bool {
    matches!(b, b'\0' | b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn is_regular(b: u8) -> bool {
    !is_space(b) && !b"()<>[]{}/%".contains(&b)
}

pub(super) struct Lexer<'a> {
    pub buf: &'a [u8],
    pub pos: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(buf: &'a [u8], pos: usize) -> Lexer<'a> {
        Lexer { buf, pos }
    }

    fn peek(&self) -> Parsed<u8> {
        self.buf.get(self.pos).copied().ok_or(Stop::Short)
    }

    pub fn skip_space(&mut self) {
        while let Some(&b) = self.buf.get(self.pos) {
            if b == b'%' {
                while self.buf.get(self.pos).is_some_and(|&c| c != b'\r' && c != b'\n') {
                    self.pos += 1;
                }
            } else if is_space(b) {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    /// The token at the cursor; one that runs to the end of the buffer may be cut off.
    fn word(&mut self) -> Parsed<&'a [u8]> {
        let start = self.pos;
        while self.buf.get(self.pos).is_some_and(|&b| is_regular(b)) {
            self.pos += 1;
        }
        if self.pos == self.buf.len() { Err(Stop::Short) } else { Ok(&self.buf[start..self.pos]) }
    }

    pub fn keyword(&mut self, expected: &[u8]) -> Parsed<()> {
        self.skip_space();
        if self.word()? == expected { Ok(()) } else { Err(Stop::Bad) }
    }

    pub fn uint(&mut self) -> Parsed<u64> {
        self.skip_space();
        let word = self.word()?;
        if word.is_empty() || word.len() > 18 || !word.iter().all(u8::is_ascii_digit) {
            return Err(Stop::Bad);
        }
        Ok(word.iter().fold(0, |n, d| n * 10 + u64::from(d - b'0')))
    }

    /// "N G obj" at the cursor; returns N.
    pub fn header(&mut self) -> Parsed<u32> {
        let num = self.uint()?;
        self.uint()?;
        self.keyword(b"obj")?;
        u32::try_from(num).map_err(|_| Stop::Bad)
    }

    /// After a dictionary: where its stream data starts, or None when it isn't a stream.
    pub fn stream_start(&mut self) -> Parsed<Option<usize>> {
        self.skip_space();
        let rest = &self.buf[self.pos..];
        if rest.len() < 6 {
            return Err(Stop::Short);
        }
        if !rest.starts_with(b"stream") {
            return Ok(None);
        }
        self.pos += 6;
        if self.buf.get(self.pos) == Some(&b'\r') {
            self.pos += 1;
        }
        if self.buf.get(self.pos) == Some(&b'\n') {
            self.pos += 1;
        }
        Ok(Some(self.pos))
    }

    pub fn object(&mut self, depth: u32) -> Parsed<Obj> {
        if depth > MAX_DEPTH {
            return Err(Stop::Bad);
        }
        self.skip_space();
        match self.peek()? {
            b'/' => {
                self.pos += 1;
                Ok(Obj::Name(self.word()?.to_vec()))
            }
            b'<' if *self.buf.get(self.pos + 1).ok_or(Stop::Short)? == b'<' => self.dict(depth),
            b'<' => match self.buf[self.pos..].iter().position(|&b| b == b'>') {
                Some(end) => {
                    self.pos += end + 1;
                    Ok(Obj::Str)
                }
                None => Err(Stop::Short),
            },
            b'(' => self.literal(),
            b'[' => self.array(depth),
            b'0'..=b'9' | b'+' | b'-' | b'.' => self.number(),
            _ => match self.word()? {
                b"true" => Ok(Obj::Bool(true)),
                b"false" => Ok(Obj::Bool(false)),
                b"null" => Ok(Obj::Null),
                _ => Err(Stop::Bad),
            },
        }
    }

    fn dict(&mut self, depth: u32) -> Parsed<Obj> {
        self.pos += 2;
        let mut entries = Vec::new();
        loop {
            self.skip_space();
            match self.peek()? {
                b'>' => {
                    if *self.buf.get(self.pos + 1).ok_or(Stop::Short)? != b'>' {
                        return Err(Stop::Bad);
                    }
                    self.pos += 2;
                    return Ok(Obj::Dict(entries));
                }
                b'/' if entries.len() < MAX_ITEMS => {
                    self.pos += 1;
                    let key = self.word()?.to_vec();
                    entries.push((key, self.object(depth + 1)?));
                }
                _ => return Err(Stop::Bad),
            }
        }
    }

    fn array(&mut self, depth: u32) -> Parsed<Obj> {
        self.pos += 1;
        let mut items = Vec::new();
        loop {
            self.skip_space();
            if self.peek()? == b']' {
                self.pos += 1;
                return Ok(Obj::Array(items));
            }
            if items.len() >= MAX_ITEMS {
                return Err(Stop::Bad);
            }
            items.push(self.object(depth + 1)?);
        }
    }

    fn literal(&mut self) -> Parsed<Obj> {
        self.pos += 1;
        let mut open = 1;
        loop {
            let b = self.peek()?;
            self.pos += 1;
            match b {
                b'\\' => {
                    self.peek()?;
                    self.pos += 1;
                }
                b'(' => open += 1,
                b')' if open == 1 => return Ok(Obj::Str),
                b')' => open -= 1,
                _ => {}
            }
        }
    }

    fn number(&mut self) -> Parsed<Obj> {
        let word = self.word()?;
        let Some(n) = std::str::from_utf8(word).ok().and_then(|s| s.parse::<i64>().ok()) else {
            let real = word.iter().all(|b| b.is_ascii_digit() || b"+-.".contains(b));
            return if real { Ok(Obj::Real) } else { Err(Stop::Bad) };
        };
        let after = self.pos;
        if let Ok(num) = u32::try_from(n)
            && self.reference_tail()?
        {
            return Ok(Obj::Ref(num));
        }
        self.pos = after;
        Ok(Obj::Int(n))
    }

    /// After an integer: whether " G R" follows, consuming it if so.
    fn reference_tail(&mut self) -> Parsed<bool> {
        self.skip_space();
        if !self.peek()?.is_ascii_digit() {
            return Ok(false);
        }
        if !self.word()?.iter().all(u8::is_ascii_digit) {
            return Ok(false);
        }
        self.skip_space();
        if self.peek()? != b'R' {
            return Ok(false);
        }
        let ends = !is_regular(*self.buf.get(self.pos + 1).ok_or(Stop::Short)?);
        if ends {
            self.pos += 1;
        }
        Ok(ends)
    }
}
