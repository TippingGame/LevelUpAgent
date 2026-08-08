//! Encoding-aware text-file support for workspace tools.
//!
//! The agent protocol carries text as Unicode, while files on Windows (and
//! especially older Chinese projects) are not necessarily UTF-8.  This module
//! keeps the boundary explicit: decode bytes once, remember the source
//! encoding/BOM/line-ending style, and encode edits back to that same format.
//! The detection order deliberately gives an unambiguous UTF-8 file priority
//! over legacy guesses, then handles BOM-marked UTF-16 and common legacy
//! encodings through the Mozilla `encoding_rs` implementation.

use std::fmt;
use std::ops::Range;

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{BIG5, Encoding, GB18030, GBK, SHIFT_JIS, WINDOWS_1252};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Gbk,
    Gb18030,
    Big5,
    ShiftJis,
    Windows1252,
}

impl TextEncoding {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf16Le => "UTF-16LE",
            Self::Utf16Be => "UTF-16BE",
            Self::Gbk => "GBK",
            Self::Gb18030 => "GB18030",
            Self::Big5 => "Big5",
            Self::ShiftJis => "Shift-JIS",
            Self::Windows1252 => "Windows-1252",
        }
    }

    fn legacy_encoding(self) -> Option<&'static Encoding> {
        match self {
            Self::Gbk => Some(GBK),
            Self::Gb18030 => Some(GB18030),
            Self::Big5 => Some(BIG5),
            Self::ShiftJis => Some(SHIFT_JIS),
            Self::Windows1252 => Some(WINDOWS_1252),
            Self::Utf8 | Self::Utf16Le | Self::Utf16Be => None,
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        let normalized = value
            .trim()
            .to_ascii_lowercase()
            .replace(['-', '_', ' '], "");
        match normalized.as_str() {
            "utf8" => Some(Self::Utf8),
            "utf16le" | "unicode" => Some(Self::Utf16Le),
            "utf16be" => Some(Self::Utf16Be),
            "gbk" | "gb2312" | "cp936" | "windows936" | "ms936" | "936" => Some(Self::Gbk),
            "gb18030" => Some(Self::Gb18030),
            "big5" | "cp950" => Some(Self::Big5),
            "shiftjis" | "sjis" => Some(Self::ShiftJis),
            "windows1252" | "cp1252" => Some(Self::Windows1252),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineEnding {
    Lf,
    CrLf,
    Cr,
}

impl LineEnding {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Lf => "LF",
            Self::CrLf => "CRLF",
            Self::Cr => "CR",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct DecodedText {
    /// Content exposed to the model.  Line endings are normalized to `\n` and
    /// an encoding BOM is not included in this string.
    pub(crate) content: String,
    pub(crate) encoding: TextEncoding,
    pub(crate) bom: bool,
    pub(crate) line_ending: LineEnding,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TextEncodingError(String);

impl fmt::Display for TextEncodingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for TextEncodingError {}

/// Decode a workspace file and retain enough metadata to write an edit back
/// without silently changing its representation.
pub(crate) fn decode(bytes: &[u8]) -> Result<DecodedText, TextEncodingError> {
    if bytes.is_empty() {
        return Ok(from_decoded(TextEncoding::Utf8, String::new()));
    }

    // BOMs are authoritative.  Strip them before decoding so the model never
    // accidentally copies U+FEFF into the first line of a replacement.
    if bytes.starts_with(&[0xff, 0xfe, 0x00, 0x00]) || bytes.starts_with(&[0x00, 0x00, 0xfe, 0xff])
    {
        return Err(TextEncodingError(
            "UTF-32 text is not supported by the workspace text tools; convert it to UTF-8 before editing".to_owned(),
        ));
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return decode_with_kind(TextEncoding::Utf8, true, &bytes[3..]);
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        return decode_utf16(TextEncoding::Utf16Le, true, &bytes[2..]);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return decode_utf16(TextEncoding::Utf16Be, true, &bytes[2..]);
    }
    // Strict UTF-8 is always preferred.  This prevents a legacy detector from
    // reinterpreting ordinary Chinese/emoji UTF-8 as GBK or another charset.
    if let Ok(text) = std::str::from_utf8(bytes) {
        if is_text_like(text) {
            return Ok(from_decoded(TextEncoding::Utf8, text.to_owned()));
        }
        // BOM-less UTF-16 made up mostly of ASCII is also valid UTF-8 at the
        // byte level because every other byte is NUL.  Give the strong NUL
        // pattern a chance before classifying those bytes as binary.
        if let Some(decoded) = decode_bomless_utf16(bytes) {
            return Ok(decoded);
        }
        return Err(TextEncodingError(
            "UTF-8 bytes contain binary/control data and cannot be edited as text".to_owned(),
        ));
    }

    // A few tools emit UTF-16 without a BOM.  Detect the characteristic NUL
    // pattern only when it is strong enough, then require valid UTF-16 text.
    if let Some(decoded) = decode_bomless_utf16(bytes) {
        return Ok(decoded);
    }

    decode_legacy(bytes)
}

/// Decode using a caller-supplied encoding instead of the heuristic fallback.
/// BOMs remain authoritative: a hint that conflicts with a BOM is rejected so
/// an explicit override cannot silently strip or reinterpret the file header.
/// A valid non-BOM UTF-8 text stream containing non-ASCII characters is also
/// protected from a legacy hint; pure ASCII is byte-identical in the supported
/// legacy code pages, so a hint may safely label that otherwise unknowable
/// project convention. Callers that truly want a conversion must perform it as
/// an explicit, separately reviewed operation rather than through this path.
pub(crate) fn decode_with_hint(
    bytes: &[u8],
    encoding: TextEncoding,
) -> Result<DecodedText, TextEncodingError> {
    if bytes.is_empty() {
        return Ok(from_decoded(encoding, String::new()));
    }
    if bytes.starts_with(&[0xff, 0xfe, 0x00, 0x00]) || bytes.starts_with(&[0x00, 0x00, 0xfe, 0xff])
    {
        return Err(TextEncodingError(
            "UTF-32 text is not supported by the workspace text tools".to_owned(),
        ));
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        if encoding != TextEncoding::Utf8 {
            return Err(TextEncodingError(format!(
                "The file has a UTF-8 BOM, which conflicts with the requested {} encoding",
                encoding.label()
            )));
        }
        return decode_with_kind(TextEncoding::Utf8, true, &bytes[3..]);
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        if encoding != TextEncoding::Utf16Le {
            return Err(TextEncodingError(format!(
                "The file has a UTF-16LE BOM, which conflicts with the requested {} encoding",
                encoding.label()
            )));
        }
        return decode_utf16(TextEncoding::Utf16Le, true, &bytes[2..]);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        if encoding != TextEncoding::Utf16Be {
            return Err(TextEncodingError(format!(
                "The file has a UTF-16BE BOM, which conflicts with the requested {} encoding",
                encoding.label()
            )));
        }
        return decode_utf16(TextEncoding::Utf16Be, true, &bytes[2..]);
    }
    // An explicit legacy hint is for an ambiguous no-BOM legacy file, not a
    // license to reinterpret an ordinary UTF-8 source file.  Without this
    // guard a model that guessed `gbk` for a valid UTF-8 file could turn every
    // Chinese character into mojibake before the host had a chance to preserve
    // the original bytes.
    // Pure ASCII is byte-for-byte identical in every supported legacy code
    // page.  Let an explicit legacy hint label that otherwise unknowable
    // project convention so a later edit can add non-ASCII text in the
    // requested encoding.  This does not reinterpret any existing character.
    // UTF-16 is not ASCII-compatible at the byte level. Permit it only when
    // the strong alternating-NUL heuristic independently confirms the hinted
    // endianness; otherwise ordinary ASCII bytes remain protected.
    let ascii_compatible_legacy_hint = encoding.legacy_encoding().is_some() && bytes.is_ascii();
    let strong_utf16_hint = matches!(encoding, TextEncoding::Utf16Le | TextEncoding::Utf16Be)
        && decode_bomless_utf16(bytes).is_some_and(|detected| detected.encoding == encoding);
    if encoding != TextEncoding::Utf8
        && !ascii_compatible_legacy_hint
        && !strong_utf16_hint
        && std::str::from_utf8(bytes).is_ok()
    {
        return Err(TextEncodingError(format!(
            "The bytes are valid UTF-8; refusing to reinterpret them as {}. Encoding hints only resolve ambiguous legacy files",
            encoding.label()
        )));
    }
    match encoding {
        TextEncoding::Utf8 => decode_with_kind(TextEncoding::Utf8, false, bytes),
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => decode_utf16(encoding, false, bytes),
        _ => decode_legacy_as(encoding, bytes),
    }
}

/// Decode bytes with a known encoding without applying the file-text safety
/// checks or line-ending normalization used by [`decode`].  Git patches are a
/// mixed stream: their headers are ASCII/UTF-8 while hunk payloads may use the
/// source file's legacy code page.  Callers use this helper only after the
/// encoding has been established from the file itself, and still get a strict
/// no-replacement guarantee for the selected codec.
pub(crate) fn decode_bytes_with_encoding(
    bytes: &[u8],
    encoding: TextEncoding,
) -> Result<String, TextEncodingError> {
    if bytes.starts_with(&[0xff, 0xfe, 0x00, 0x00]) || bytes.starts_with(&[0x00, 0x00, 0xfe, 0xff])
    {
        return Err(TextEncodingError(
            "UTF-32 byte streams are not supported".to_owned(),
        ));
    }
    let content = match encoding {
        TextEncoding::Utf8 if bytes.starts_with(&[0xef, 0xbb, 0xbf]) => &bytes[3..],
        TextEncoding::Utf16Le if bytes.starts_with(&[0xff, 0xfe]) => &bytes[2..],
        TextEncoding::Utf16Be if bytes.starts_with(&[0xfe, 0xff]) => &bytes[2..],
        TextEncoding::Utf8
            if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) =>
        {
            return Err(TextEncodingError(
                "The byte stream has a UTF-16 BOM but UTF-8 was requested".to_owned(),
            ));
        }
        TextEncoding::Utf16Le
            if bytes.starts_with(&[0xef, 0xbb, 0xbf]) || bytes.starts_with(&[0xfe, 0xff]) =>
        {
            return Err(TextEncodingError(
                "The byte stream BOM conflicts with UTF-16LE".to_owned(),
            ));
        }
        TextEncoding::Utf16Be
            if bytes.starts_with(&[0xef, 0xbb, 0xbf]) || bytes.starts_with(&[0xff, 0xfe]) =>
        {
            return Err(TextEncodingError(
                "The byte stream BOM conflicts with UTF-16BE".to_owned(),
            ));
        }
        _ => bytes,
    };
    match encoding {
        TextEncoding::Utf8 => std::str::from_utf8(content)
            .map(str::to_owned)
            .map_err(|error| TextEncodingError(format!("Invalid UTF-8 bytes: {error}"))),
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => decode_utf16_text(encoding, content),
        _ => {
            let codec = encoding.legacy_encoding().ok_or_else(|| {
                TextEncodingError(format!("{} is not supported", encoding.label()))
            })?;
            codec
                .decode_without_bom_handling_and_without_replacement(content)
                .map(|text| text.into_owned())
                .ok_or_else(|| {
                    TextEncodingError(format!("Invalid {} byte sequence", encoding.label()))
                })
        }
    }
}

/// Map byte ranges in the LF-normalized model view back to the original file
/// bytes.  `edit_file` uses this map to splice only the requested range, so
/// untouched mixed line endings and legacy-codec byte sequences remain exact.
pub(crate) fn map_normalized_ranges_to_source(
    bytes: &[u8],
    decoded: &DecodedText,
    ranges: &[Range<usize>],
) -> Result<Vec<Range<usize>>, TextEncodingError> {
    if ranges.is_empty() {
        return Ok(Vec::new());
    }
    let boundaries = source_boundaries(bytes, decoded)?;
    let mut mapped = Vec::with_capacity(ranges.len());
    let mut previous_end = 0;
    for range in ranges {
        if range.start > range.end
            || range.end > decoded.content.len()
            || !decoded.content.is_char_boundary(range.start)
            || !decoded.content.is_char_boundary(range.end)
        {
            return Err(TextEncodingError(
                "The edit range is not aligned to valid Unicode character boundaries".to_owned(),
            ));
        }
        let start = boundaries
            .get(range.start)
            .and_then(|offset| *offset)
            .ok_or_else(|| {
                TextEncodingError(
                    "The edit starts inside a multi-byte source character; include the complete character"
                        .to_owned(),
                )
            })?;
        let end = boundaries
            .get(range.end)
            .and_then(|offset| *offset)
            .ok_or_else(|| {
                TextEncodingError(
                    "The edit ends inside a multi-byte source character; include the complete character"
                        .to_owned(),
                )
            })?;
        if start < previous_end || end < start || end > bytes.len() {
            return Err(TextEncodingError(
                "The edit ranges do not map monotonically to the source bytes".to_owned(),
            ));
        }
        previous_end = end;
        mapped.push(start..end);
    }
    Ok(mapped)
}

#[derive(Debug)]
struct DecodedUnit {
    text: String,
    raw_start: usize,
    raw_end: usize,
}

#[derive(Debug, Clone, Copy)]
struct SourceChar {
    character: char,
    raw_start: Option<usize>,
    raw_end: Option<usize>,
}

fn source_boundaries(
    bytes: &[u8],
    decoded: &DecodedText,
) -> Result<Vec<Option<usize>>, TextEncodingError> {
    let units = source_units(bytes, decoded.encoding, decoded.bom)?;
    let content_start = source_content_start(decoded.encoding, decoded.bom);
    let mut chars = Vec::new();
    for unit in &units {
        let count = unit.text.chars().count();
        for (index, character) in unit.text.chars().enumerate() {
            chars.push(SourceChar {
                character,
                raw_start: (index == 0).then_some(unit.raw_start),
                raw_end: (index + 1 == count).then_some(unit.raw_end),
            });
        }
    }

    let mut normalized = String::new();
    let mut boundaries = vec![None; decoded.content.len() + 1];
    boundaries[0] = Some(content_start);
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if current.character == '\r'
            && chars
                .get(index + 1)
                .is_some_and(|next| next.character == '\n')
        {
            append_source_char(
                &mut normalized,
                &mut boundaries,
                '\n',
                current.raw_start,
                chars[index + 1].raw_end,
            );
            index += 2;
        } else if current.character == '\r' {
            // `DecodedText::content` normalizes standalone CR as well as
            // CRLF. Keep the source-byte boundary at the same raw character
            // while reproducing that normalized model view.
            append_source_char(
                &mut normalized,
                &mut boundaries,
                '\n',
                current.raw_start,
                current.raw_end,
            );
            index += 1;
        } else {
            append_source_char(
                &mut normalized,
                &mut boundaries,
                current.character,
                current.raw_start,
                current.raw_end,
            );
            index += 1;
        }
    }
    if normalized != decoded.content {
        return Err(TextEncodingError(
            "The source-byte map did not reproduce the decoded text".to_owned(),
        ));
    }
    Ok(boundaries)
}

fn append_source_char(
    normalized: &mut String,
    boundaries: &mut [Option<usize>],
    character: char,
    raw_start: Option<usize>,
    raw_end: Option<usize>,
) {
    let start = normalized.len();
    if boundaries[start].is_none() {
        boundaries[start] = raw_start;
    }
    normalized.push(character);
    let end = normalized.len();
    if boundaries[end].is_none() {
        boundaries[end] = raw_end;
    }
}

fn source_content_start(encoding: TextEncoding, bom: bool) -> usize {
    if !bom {
        0
    } else {
        match encoding {
            TextEncoding::Utf8 => 3,
            TextEncoding::Utf16Le | TextEncoding::Utf16Be => 2,
            _ => 0,
        }
    }
}

fn source_units(
    bytes: &[u8],
    encoding: TextEncoding,
    bom: bool,
) -> Result<Vec<DecodedUnit>, TextEncodingError> {
    let offset = source_content_start(encoding, bom);
    if bytes.len() < offset {
        return Err(TextEncodingError(
            "The source encoding header is incomplete".to_owned(),
        ));
    }
    let content = &bytes[offset..];
    match encoding {
        TextEncoding::Utf8 => source_units_utf8(content, offset),
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            source_units_utf16(content, offset, encoding)
        }
        _ => source_units_legacy(content, offset, encoding),
    }
}

fn source_units_utf8(bytes: &[u8], offset: usize) -> Result<Vec<DecodedUnit>, TextEncodingError> {
    let text = std::str::from_utf8(bytes).map_err(|error| {
        TextEncodingError(format!("UTF-8 source map contains invalid bytes: {error}"))
    })?;
    Ok(text
        .char_indices()
        .map(|(index, character)| DecodedUnit {
            text: character.to_string(),
            raw_start: offset + index,
            raw_end: offset + index + character.len_utf8(),
        })
        .collect())
}

#[allow(clippy::manual_is_multiple_of)]
fn source_units_utf16(
    bytes: &[u8],
    offset: usize,
    encoding: TextEncoding,
) -> Result<Vec<DecodedUnit>, TextEncodingError> {
    if bytes.len() % 2 != 0 {
        return Err(TextEncodingError(
            "UTF-16 source map contains an incomplete code unit".to_owned(),
        ));
    }
    let mut units = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let first = match encoding {
            TextEncoding::Utf16Le => u16::from_le_bytes([bytes[index], bytes[index + 1]]),
            TextEncoding::Utf16Be => u16::from_be_bytes([bytes[index], bytes[index + 1]]),
            _ => unreachable!("source_units_utf16 called for a non-UTF-16 encoding"),
        };
        let (character, width) = if (0xD800..=0xDBFF).contains(&first) {
            if index + 3 >= bytes.len() {
                return Err(TextEncodingError(
                    "UTF-16 source map contains an incomplete surrogate pair".to_owned(),
                ));
            }
            let second = match encoding {
                TextEncoding::Utf16Le => u16::from_le_bytes([bytes[index + 2], bytes[index + 3]]),
                TextEncoding::Utf16Be => u16::from_be_bytes([bytes[index + 2], bytes[index + 3]]),
                _ => unreachable!("source_units_utf16 called for a non-UTF-16 encoding"),
            };
            if !(0xDC00..=0xDFFF).contains(&second) {
                return Err(TextEncodingError(
                    "UTF-16 source map contains an invalid surrogate pair".to_owned(),
                ));
            }
            let scalar = 0x1_0000 + (((first as u32) - 0xD800) << 10) + ((second as u32) - 0xDC00);
            (
                char::from_u32(scalar).ok_or_else(|| {
                    TextEncodingError("UTF-16 source map contains an invalid scalar".to_owned())
                })?,
                4,
            )
        } else if (0xDC00..=0xDFFF).contains(&first) {
            return Err(TextEncodingError(
                "UTF-16 source map contains an unpaired low surrogate".to_owned(),
            ));
        } else {
            (
                char::from_u32(first as u32).ok_or_else(|| {
                    TextEncodingError("UTF-16 source map contains an invalid scalar".to_owned())
                })?,
                2,
            )
        };
        units.push(DecodedUnit {
            text: character.to_string(),
            raw_start: offset + index,
            raw_end: offset + index + width,
        });
        index += width;
    }
    Ok(units)
}

fn source_units_legacy(
    bytes: &[u8],
    offset: usize,
    encoding: TextEncoding,
) -> Result<Vec<DecodedUnit>, TextEncodingError> {
    let codec = encoding.legacy_encoding().ok_or_else(|| {
        TextEncodingError(format!("{} is not a legacy encoding", encoding.label()))
    })?;
    let mut decoder = codec.new_decoder_without_bom_handling();
    let mut units = Vec::new();
    let mut consumed = 0;
    let mut pending_start = 0;
    while consumed < bytes.len() {
        let mut output = [0_u8; 64];
        let last = consumed + 1 == bytes.len();
        let (result, read, written) = decoder.decode_to_utf8_without_replacement(
            &bytes[consumed..consumed + 1],
            &mut output,
            last,
        );
        if read == 0 {
            return Err(TextEncodingError(format!(
                "{} source map made no progress",
                encoding.label()
            )));
        }
        let next = consumed + read;
        if written > 0 {
            let text = std::str::from_utf8(&output[..written])
                .map_err(|_| TextEncodingError("Legacy decoder returned invalid UTF-8".to_owned()))?
                .to_owned();
            units.push(DecodedUnit {
                text,
                raw_start: offset + pending_start,
                raw_end: offset + next,
            });
            pending_start = next;
        }
        consumed = next;
        if matches!(result, encoding_rs::DecoderResult::Malformed(..)) {
            return Err(TextEncodingError(format!(
                "The bytes are not valid {} text",
                encoding.label()
            )));
        }
    }
    if pending_start != bytes.len() {
        return Err(TextEncodingError(format!(
            "{} source map ended with an incomplete sequence",
            encoding.label()
        )));
    }
    Ok(units)
}

/// Decode process output with a slightly less strict text policy than file
/// editing. ANSI escape sequences and other harmless terminal controls are
/// common in command output, while invalid legacy byte sequences first get a
/// Chinese-code-page fallback instead of an eager UTF-8 replacement; truly
/// undecodable binary output still uses a last-resort lossy display.
pub(crate) fn decode_command_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        if let Ok(text) = std::str::from_utf8(&bytes[3..]) {
            return normalize_line_endings(text);
        }
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        if let Ok(text) = decode_utf16_text(TextEncoding::Utf16Le, &bytes[2..]) {
            return normalize_line_endings(&text);
        }
    } else if bytes.starts_with(&[0xfe, 0xff])
        && let Ok(text) = decode_utf16_text(TextEncoding::Utf16Be, &bytes[2..])
    {
        return normalize_line_endings(&text);
    }
    if let Ok(decoded) = decode(bytes) {
        return decoded.content;
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return normalize_line_endings(text);
    }

    // When the whole stream is not confidently decodable (common for ANSI
    // framed output or a mixed-code-page command), decode newline-delimited
    // records independently before falling back to a single codec. A stream
    // that the strict file detector accepted as one legacy encoding remains
    // authoritative, avoiding per-line guesses on ordinary source output.
    if bytes.contains(&b'\n')
        && let Some(text) = decode_legacy_output_lines(bytes)
    {
        return normalize_line_endings(&text);
    }

    let candidate_codecs = [
        (TextEncoding::Gbk, GBK),
        (TextEncoding::Gb18030, GB18030),
        (TextEncoding::Big5, BIG5),
        (TextEncoding::ShiftJis, SHIFT_JIS),
        (TextEncoding::Windows1252, WINDOWS_1252),
    ];
    let has_gb18030_four_byte_sequence = contains_gb18030_four_byte_sequence(bytes);
    let detected = detect_legacy_kind(bytes, has_gb18030_four_byte_sequence);
    let mut best: Option<(TextEncoding, i64, String)> = None;
    let mut detected_candidate: Option<(TextEncoding, i64, String)> = None;
    for (kind, encoding) in candidate_codecs {
        if has_gb18030_four_byte_sequence && kind == TextEncoding::Gbk {
            continue;
        }
        let Some(decoded) = encoding.decode_without_bom_handling_and_without_replacement(bytes)
        else {
            continue;
        };
        let text = decoded.into_owned();
        let score = output_quality_score(kind, &text);
        if detected == Some(kind) && score > 0 {
            detected_candidate = Some((kind, score, text.clone()));
        }
        if score > 0
            && best
                .as_ref()
                .is_none_or(|(_, best_score, _)| score > *best_score)
        {
            best = Some((kind, score, text));
        }
    }
    let selected = detected_candidate.and_then(|candidate| {
        let (_, best_score, _) = best.as_ref()?;
        // Keep the detector from overriding a clearly better-quality
        // candidate, but let it break the common short GBK/Big5/JIS tie where
        // score-only ordering would default to GBK.
        (candidate.1 >= *best_score - 16).then_some(candidate)
    });
    let selected = selected.or(best);
    selected
        .map(|(_, _, text)| normalize_line_endings(&text))
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

fn decode_legacy_output_lines(bytes: &[u8]) -> Option<String> {
    let mut output = String::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let line_end = bytes[offset..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| offset + index + 1)
            .unwrap_or(bytes.len());
        let has_newline = line_end > offset && bytes[line_end - 1] == b'\n';
        let body_end = if has_newline { line_end - 1 } else { line_end };
        output.push_str(&decode_legacy_output_line(&bytes[offset..body_end])?);
        if has_newline {
            output.push('\n');
        }
        offset = line_end;
    }
    Some(output)
}

fn decode_legacy_output_line(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Some(text.to_owned());
    }
    let candidate_codecs = [
        (TextEncoding::Gbk, GBK),
        (TextEncoding::Gb18030, GB18030),
        (TextEncoding::Big5, BIG5),
        (TextEncoding::ShiftJis, SHIFT_JIS),
        (TextEncoding::Windows1252, WINDOWS_1252),
    ];
    let has_gb18030_four_byte_sequence = contains_gb18030_four_byte_sequence(bytes);
    let detected = detect_legacy_kind(bytes, has_gb18030_four_byte_sequence);
    let mut candidates = Vec::new();
    for (kind, encoding) in candidate_codecs {
        if has_gb18030_four_byte_sequence && kind == TextEncoding::Gbk {
            continue;
        }
        let Some(decoded) = encoding.decode_without_bom_handling_and_without_replacement(bytes)
        else {
            continue;
        };
        let text = decoded.into_owned();
        let score = output_quality_score(kind, &text);
        if score > 0 {
            candidates.push((kind, score, text));
        }
    }
    if candidates.is_empty() {
        return None;
    }
    let best_score = candidates.iter().map(|(_, score, _)| *score).max()?;
    if let Some(kind) = detected
        && let Some((_, score, _)) = candidates
            .iter()
            .find(|(candidate, _, _)| *candidate == kind)
        && *score >= best_score - 16
    {
        return candidates
            .into_iter()
            .find(|(candidate, _, _)| *candidate == kind)
            .map(|(_, _, text)| text);
    }
    let mut best = candidates.into_iter();
    let mut selected = best.next()?;
    for candidate in best {
        if candidate.1 > selected.1 {
            selected = candidate;
        }
    }
    Some(selected.2)
}

fn contains_gb18030_four_byte_sequence(bytes: &[u8]) -> bool {
    bytes.windows(4).any(|window| {
        (0x81..=0xfe).contains(&window[0])
            && (0x30..=0x39).contains(&window[1])
            && (0x81..=0xfe).contains(&window[2])
            && (0x30..=0x39).contains(&window[3])
    })
}

fn decode_with_kind(
    encoding: TextEncoding,
    bom: bool,
    bytes: &[u8],
) -> Result<DecodedText, TextEncodingError> {
    match encoding {
        TextEncoding::Utf8 => {
            let text = std::str::from_utf8(bytes)
                .map_err(|error| {
                    TextEncodingError(format!(
                        "{} contains invalid UTF-8: {error}",
                        encoding.label()
                    ))
                })?
                .to_owned();
            if !is_text_like(&text) {
                return Err(TextEncodingError(
                    "UTF-8 bytes contain binary/control data and cannot be edited as text"
                        .to_owned(),
                ));
            }
            Ok(from_decoded_with_bom(encoding, bom, text))
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => decode_utf16(encoding, bom, bytes),
        _ => unreachable!("legacy encodings use decode_legacy"),
    }
}

#[allow(clippy::manual_is_multiple_of)]
fn decode_utf16(
    encoding: TextEncoding,
    bom: bool,
    bytes: &[u8],
) -> Result<DecodedText, TextEncodingError> {
    let text = decode_utf16_text(encoding, bytes)?;
    if !is_text_like(&text) {
        return Err(TextEncodingError(format!(
            "{} contains binary/control data and cannot be edited as text",
            encoding.label()
        )));
    }
    Ok(from_decoded_with_bom(encoding, bom, text))
}

#[allow(clippy::manual_is_multiple_of)]
fn decode_utf16_text(encoding: TextEncoding, bytes: &[u8]) -> Result<String, TextEncodingError> {
    if bytes.len() % 2 != 0 {
        return Err(TextEncodingError(format!(
            "{} file has an incomplete 16-bit code unit",
            encoding.label()
        )));
    }
    let units = bytes.chunks_exact(2).map(|pair| match encoding {
        TextEncoding::Utf16Le => u16::from_le_bytes([pair[0], pair[1]]),
        TextEncoding::Utf16Be => u16::from_be_bytes([pair[0], pair[1]]),
        _ => unreachable!("decode_utf16 called for a non-UTF-16 encoding"),
    });
    let text = char::decode_utf16(units)
        .collect::<Result<String, _>>()
        .map_err(|error| {
            TextEncodingError(format!(
                "{} contains an invalid surrogate: {error}",
                encoding.label()
            ))
        })?;
    Ok(text)
}

#[allow(clippy::manual_is_multiple_of)]
fn decode_bomless_utf16(bytes: &[u8]) -> Option<DecodedText> {
    if bytes.len() < 4 || bytes.len() % 2 != 0 {
        return None;
    }
    let even_nuls = bytes
        .iter()
        .enumerate()
        .filter(|(index, byte)| index % 2 == 0 && **byte == 0)
        .count();
    let odd_nuls = bytes
        .iter()
        .enumerate()
        .filter(|(index, byte)| index % 2 == 1 && **byte == 0)
        .count();
    // A single or two NULs in a short byte stream are not enough evidence:
    // binary data and UTF-8 strings containing embedded NULs can look like
    // BOM-less UTF-16.  Require a strong majority of the expected high-byte
    // slots (and at least three slots) before opting into this heuristic.
    let code_units = bytes.len() / 2;
    let threshold = (code_units * 3).div_ceil(4);
    let threshold = threshold.max(3);
    let candidate = if odd_nuls >= threshold {
        TextEncoding::Utf16Le
    } else if even_nuls >= threshold {
        TextEncoding::Utf16Be
    } else {
        return None;
    };
    let decoded = decode_utf16(candidate, false, bytes).ok()?;
    (text_quality_score(&decoded.content) > 0 && is_text_like(&decoded.content)).then_some(decoded)
}

fn decode_legacy(bytes: &[u8]) -> Result<DecodedText, TextEncodingError> {
    // GBK is intentionally tried before GB18030: CP936/GBK files are by far
    // the common case for Chinese Windows projects, and this preserves their
    // original two-byte representation on a round trip.  A GB18030 four-byte
    // lead/trail pattern disables that preference so supplementary characters
    // are not reinterpreted as two unrelated GBK characters.
    let candidate_codecs = [
        (TextEncoding::Gbk, GBK),
        (TextEncoding::Gb18030, GB18030),
        (TextEncoding::Big5, BIG5),
        (TextEncoding::ShiftJis, SHIFT_JIS),
        (TextEncoding::Windows1252, WINDOWS_1252),
    ];
    let has_gb18030_four_byte_sequence = contains_gb18030_four_byte_sequence(bytes);
    let mut candidates = Vec::new();
    for (kind, encoding) in candidate_codecs {
        if has_gb18030_four_byte_sequence && kind == TextEncoding::Gbk {
            continue;
        }
        let Ok(text) = decode_legacy_text(kind, encoding, bytes) else {
            continue;
        };
        let score = encoding_quality_score(kind, &text);
        candidates.push(LegacyCandidate { kind, score, text });
    }
    if candidates.is_empty() {
        return Err(TextEncodingError(
            "File is not valid UTF-8/UTF-16 or a supported Chinese/legacy text encoding; binary files cannot be edited as text".to_owned(),
        ));
    }
    candidates.sort_by(|left, right| right.score.cmp(&left.score));

    let distinct_texts = candidates
        .iter()
        .map(|candidate| candidate.text.as_str())
        .collect::<std::collections::HashSet<_>>();
    let detected_kind = detect_legacy_kind(bytes, has_gb18030_four_byte_sequence);
    let selected = detected_kind
        .and_then(|kind| candidates.iter().find(|candidate| candidate.kind == kind))
        .or_else(|| candidates.first());
    let Some(selected) = selected else {
        unreachable!("candidates was checked to be non-empty");
    };

    // If every valid codec produces the same Unicode text, the encoding label
    // is the only ambiguity.  Prefer GB18030 when a four-byte sequence proves
    // it, otherwise retain the detector's choice or the stable GBK ordering.
    if distinct_texts.len() == 1 {
        return Ok(from_decoded_with_bom(
            selected.kind,
            false,
            selected.text.clone(),
        ));
    }

    let non_ascii_characters = selected
        .text
        .chars()
        .filter(|character| !character.is_ascii())
        .count();
    let strong_evidence = has_gb18030_four_byte_sequence
        || (selected.kind == TextEncoding::ShiftJis
            && selected.text.chars().any(is_japanese_script));
    // chardetng is deliberately used as a second, maintained signal instead
    // of treating a hand-written CJK score as certainty.  Short legacy
    // snippets remain information-theoretically ambiguous, so require either
    // strong byte/script evidence or enough non-ASCII context before choosing.
    if detected_kind == Some(selected.kind)
        && (strong_evidence || non_ascii_characters >= 6)
        && !legacy_script_conflicts(selected.kind, &selected.text)
    {
        return Ok(from_decoded_with_bom(
            selected.kind,
            false,
            selected.text.clone(),
        ));
    }

    let labels = candidates
        .iter()
        .map(|candidate| candidate.kind.label())
        .collect::<Vec<_>>();
    Err(TextEncodingError(format!(
        "Legacy text encoding is ambiguous (possible: {}). Pass an explicit encoding such as gbk/gb2312, gb18030, big5, shift-jis, or windows-1252",
        labels.join(", ")
    )))
}

/// A decoder can legally map the same multibyte byte stream to printable text
/// in more than one East-Asian code page.  In particular, Japanese kana in a
/// GBK/Big5 candidate is a strong sign that the detector selected a plausible
/// but wrong alternative (and the reverse is true for a Shift-JIS candidate
/// with no kana).  Silently accepting that result would make the next full-file
/// write a mojibake rewrite.  Keep automatic detection conservative and let an
/// explicit `encoding` hint handle genuinely mixed-language legacy files.
fn legacy_script_conflicts(encoding: TextEncoding, text: &str) -> bool {
    let japanese = text
        .chars()
        .filter(|character| is_japanese_script(*character))
        .count();
    match encoding {
        TextEncoding::ShiftJis => japanese == 0 && text.chars().any(is_cjk),
        TextEncoding::Gbk | TextEncoding::Gb18030 | TextEncoding::Big5 => japanese > 0,
        TextEncoding::Utf8
        | TextEncoding::Utf16Le
        | TextEncoding::Utf16Be
        | TextEncoding::Windows1252 => false,
    }
}

#[derive(Debug)]
struct LegacyCandidate {
    kind: TextEncoding,
    score: i64,
    text: String,
}

fn detect_legacy_kind(bytes: &[u8], has_gb18030_four_byte_sequence: bool) -> Option<TextEncoding> {
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    let guessed = detector.guess(None, Utf8Detection::Deny);
    if guessed == GBK {
        return Some(if has_gb18030_four_byte_sequence {
            TextEncoding::Gb18030
        } else {
            TextEncoding::Gbk
        });
    }
    if guessed == BIG5 {
        Some(TextEncoding::Big5)
    } else if guessed == SHIFT_JIS {
        Some(TextEncoding::ShiftJis)
    } else if guessed == WINDOWS_1252 {
        Some(TextEncoding::Windows1252)
    } else if guessed == GB18030 {
        Some(TextEncoding::Gb18030)
    } else {
        None
    }
}

fn decode_legacy_as(
    encoding: TextEncoding,
    bytes: &[u8],
) -> Result<DecodedText, TextEncodingError> {
    let codec = encoding.legacy_encoding().ok_or_else(|| {
        TextEncodingError(format!("{} is not a legacy encoding", encoding.label()))
    })?;
    let text = decode_legacy_text(encoding, codec, bytes)?;
    Ok(from_decoded_with_bom(encoding, false, text))
}

fn decode_legacy_text(
    encoding: TextEncoding,
    codec: &'static Encoding,
    bytes: &[u8],
) -> Result<String, TextEncodingError> {
    let Some(decoded) = codec.decode_without_bom_handling_and_without_replacement(bytes) else {
        return Err(TextEncodingError(format!(
            "The bytes are not valid {} text",
            encoding.label()
        )));
    };
    let text = decoded.into_owned();
    if text_quality_score(&text) <= 0 || !is_text_like(&text) {
        return Err(TextEncodingError(format!(
            "The bytes contain binary/control data, not {} text",
            encoding.label()
        )));
    }
    Ok(text)
}

fn text_quality_score(text: &str) -> i64 {
    if text.is_empty() {
        return 1;
    }
    let mut score = 0_i64;
    for character in text.chars() {
        if character == '\0' {
            score -= 100;
        } else if character.is_control() && !matches!(character, '\n' | '\r' | '\t' | '\x0c') {
            score -= 12;
        } else {
            score += 1;
            if is_cjk(character) {
                score += 3;
            }
        }
    }
    score
}

fn encoding_quality_score(encoding: TextEncoding, text: &str) -> i64 {
    let mut score = text_quality_score(text);
    if encoding == TextEncoding::ShiftJis {
        score += text
            .chars()
            .filter(|character| is_japanese(*character))
            .count() as i64
            * 8;
    }
    score
}

fn output_quality_score(encoding: TextEncoding, text: &str) -> i64 {
    let mut score = 0_i64;
    for character in text.chars() {
        if character == '\0' {
            score -= 100;
        } else if character.is_control()
            && !matches!(character, '\n' | '\r' | '\t' | '\x0c' | '\x1b')
        {
            score -= 12;
        } else {
            score += 1;
            if is_cjk(character) {
                score += 3;
            }
            if encoding == TextEncoding::ShiftJis && is_japanese(character) {
                score += 8;
            }
        }
    }
    score
}

fn is_text_like(text: &str) -> bool {
    !text.chars().any(|character| {
        character == '\0'
            || (character.is_control() && !matches!(character, '\n' | '\r' | '\t' | '\x0c'))
            || character == '\u{fffd}'
    })
}

fn is_cjk(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xf900..=0xfaff
            | 0x20000..=0x2fa1f
    )
}

fn is_japanese(character: char) -> bool {
    matches!(
        character as u32,
        0x3040..=0x30ff | 0x31f0..=0x31ff
    )
}

fn is_japanese_script(character: char) -> bool {
    is_japanese(character) || matches!(character as u32, 0xff66..=0xff9d)
}

fn from_decoded(encoding: TextEncoding, text: String) -> DecodedText {
    from_decoded_with_bom(encoding, false, text)
}

fn from_decoded_with_bom(encoding: TextEncoding, bom: bool, text: String) -> DecodedText {
    let line_ending = detect_line_ending(&text);
    let content = normalize_line_endings(&text);
    DecodedText {
        content,
        encoding,
        bom,
        line_ending,
    }
}

pub(crate) fn normalize_line_endings(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

pub(crate) fn detect_line_ending(content: &str) -> LineEnding {
    let crlf = content.matches("\r\n").count();
    let without_crlf = content.replace("\r\n", "");
    let lf = without_crlf.matches('\n').count();
    let cr = without_crlf.matches('\r').count();
    if crlf > 0 && crlf >= lf && crlf >= cr {
        LineEnding::CrLf
    } else if cr > 0 && cr >= lf {
        LineEnding::Cr
    } else {
        LineEnding::Lf
    }
}

pub(crate) fn encode(
    content: &str,
    encoding: TextEncoding,
    bom: bool,
    line_ending: LineEnding,
) -> Result<Vec<u8>, TextEncodingError> {
    let normalized = normalize_line_endings(content);
    let restored = match line_ending {
        LineEnding::Lf => normalized,
        LineEnding::CrLf => normalized.replace('\n', "\r\n"),
        LineEnding::Cr => normalized.replace('\n', "\r"),
    };
    let mut bytes = Vec::new();
    match encoding {
        TextEncoding::Utf8 => {
            if bom {
                bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            }
            bytes.extend_from_slice(restored.as_bytes());
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            if bom {
                bytes.extend_from_slice(if encoding == TextEncoding::Utf16Le {
                    &[0xff, 0xfe]
                } else {
                    &[0xfe, 0xff]
                });
            }
            for unit in restored.encode_utf16() {
                let encoded = if encoding == TextEncoding::Utf16Le {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                };
                bytes.extend_from_slice(&encoded);
            }
        }
        _ => {
            let legacy = encoding
                .legacy_encoding()
                .expect("legacy encoding must have an encoding_rs mapping");
            let (encoded, _, had_errors) = legacy.encode(&restored);
            if had_errors {
                return Err(TextEncodingError(format!(
                    "The edited text contains characters that {} cannot represent; refusing to replace the file",
                    encoding.label()
                )));
            }
            bytes.extend_from_slice(encoded.as_ref());
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_utf8_bom_and_crlf() {
        let mut original = vec![0xef, 0xbb, 0xbf];
        original.extend_from_slice("第一行\r\n第二行\r\n".as_bytes());
        let decoded = decode(&original).unwrap();
        assert_eq!(decoded.encoding, TextEncoding::Utf8);
        assert!(decoded.bom);
        assert_eq!(decoded.line_ending, LineEnding::CrLf);
        assert_eq!(decoded.content, "第一行\n第二行\n");
        let bytes = encode(
            "第一行\n改后\n",
            decoded.encoding,
            decoded.bom,
            decoded.line_ending,
        )
        .unwrap();
        let mut expected = vec![0xef, 0xbb, 0xbf];
        expected.extend_from_slice("第一行\r\n改后\r\n".as_bytes());
        assert_eq!(bytes, expected);
    }

    #[test]
    fn round_trips_utf16le_chinese() {
        let text = "配置项=中文\r\n";
        let bytes = encode(text, TextEncoding::Utf16Le, true, LineEnding::CrLf).unwrap();
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.encoding, TextEncoding::Utf16Le);
        assert!(decoded.bom);
        assert_eq!(decoded.content, "配置项=中文\n");
        let rewritten = encode(
            &decoded.content,
            decoded.encoding,
            decoded.bom,
            decoded.line_ending,
        )
        .unwrap();
        assert_eq!(rewritten, bytes);
    }

    #[test]
    fn detects_bomless_utf16_ascii_and_big_endian_text() {
        let little_endian = "Write-Output '中文'\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let decoded_le = decode(&little_endian).unwrap();
        assert_eq!(decoded_le.encoding, TextEncoding::Utf16Le);
        assert_eq!(decoded_le.content, "Write-Output '中文'\n");

        let big_endian = "hello\r\n"
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect::<Vec<_>>();
        let decoded_be = decode(&big_endian).unwrap();
        assert_eq!(decoded_be.encoding, TextEncoding::Utf16Be);
        assert_eq!(decoded_be.content, "hello\n");
    }

    #[test]
    fn detects_and_preserves_gbk() {
        let (bytes, _, had_errors) = GBK.encode("中文配置文件内容\r\n");
        assert!(!had_errors);
        let decoded = decode(bytes.as_ref()).unwrap();
        assert_eq!(decoded.encoding, TextEncoding::Gbk);
        assert_eq!(decoded.content, "中文配置文件内容\n");
        let rewritten = encode(
            "中文修改\n",
            decoded.encoding,
            decoded.bom,
            decoded.line_ending,
        )
        .unwrap();
        let (expected, _, expected_errors) = GBK.encode("中文修改\r\n");
        assert!(!expected_errors);
        assert_eq!(rewritten, expected.as_ref());
    }

    #[test]
    fn detects_gb18030_four_byte_characters() {
        let text = "𠀀配置\r\n";
        let (bytes, _, had_errors) = GB18030.encode(text);
        assert!(!had_errors);
        let decoded = decode(bytes.as_ref()).unwrap();
        assert_eq!(decoded.encoding, TextEncoding::Gb18030);
        assert_eq!(decoded.content, "𠀀配置\n");
    }

    #[test]
    fn detects_other_declared_legacy_encodings() {
        let (big5_bytes, _, big5_errors) = BIG5.encode("繁體中文測試 臺灣中文\r\n");
        assert!(!big5_errors);
        let big5 = decode(big5_bytes.as_ref()).unwrap();
        assert_eq!(big5.encoding, TextEncoding::Big5);

        let (shift_jis_bytes, _, shift_jis_errors) = SHIFT_JIS.encode("日本語テスト\r\n");
        assert!(!shift_jis_errors);
        let shift_jis = decode(shift_jis_bytes.as_ref()).unwrap();
        assert_eq!(shift_jis.encoding, TextEncoding::ShiftJis);

        // A short all-Kanji file is intentionally ambiguous to automatic
        // detection; an explicit hint must still decode it losslessly.
        let (kanji_bytes, _, kanji_errors) = SHIFT_JIS.encode("日本語\r\n");
        assert!(!kanji_errors);
        assert!(decode(kanji_bytes.as_ref()).is_err());
        let hinted = decode_with_hint(kanji_bytes.as_ref(), TextEncoding::ShiftJis).unwrap();
        assert_eq!(hinted.content, "日本語\n");
        assert_eq!(
            TextEncoding::parse("Shift-JIS"),
            Some(TextEncoding::ShiftJis)
        );
        assert_eq!(TextEncoding::parse("GB2312"), Some(TextEncoding::Gbk));
    }

    #[test]
    fn explicit_legacy_hint_cannot_reinterpret_valid_utf8() {
        let bytes = "中文配置\n".as_bytes();
        assert!(decode_with_hint(bytes, TextEncoding::Gbk).is_err());
        assert!(decode_with_hint(bytes, TextEncoding::Big5).is_err());
        assert!(decode_with_hint("损坏标记=�\n".as_bytes(), TextEncoding::Gbk).is_err());
        assert!(decode_with_hint("中文\u{1b}[0m".as_bytes(), TextEncoding::Gbk).is_err());
        assert_eq!(
            decode_with_hint(bytes, TextEncoding::Utf8).unwrap().content,
            "中文配置\n"
        );
    }

    #[test]
    fn explicit_legacy_hint_can_label_ascii_compatible_text() {
        let bytes = b"// project title\r\n";
        for encoding in [
            TextEncoding::Gbk,
            TextEncoding::Gb18030,
            TextEncoding::Big5,
            TextEncoding::ShiftJis,
            TextEncoding::Windows1252,
        ] {
            let decoded = decode_with_hint(bytes, encoding).unwrap();
            assert_eq!(decoded.encoding, encoding);
            assert_eq!(decoded.content, "// project title\n");
        }
        assert!(decode_with_hint(bytes, TextEncoding::Utf16Le).is_err());
        assert!(decode_with_hint(bytes, TextEncoding::Utf16Be).is_err());

        let utf16le = "hello\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let utf16be = "hello\r\n"
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect::<Vec<_>>();
        assert_eq!(
            decode_with_hint(&utf16le, TextEncoding::Utf16Le)
                .unwrap()
                .content,
            "hello\n"
        );
        assert_eq!(
            decode_with_hint(&utf16be, TextEncoding::Utf16Be)
                .unwrap()
                .content,
            "hello\n"
        );
        assert!(decode_with_hint(&utf16le, TextEncoding::Utf16Be).is_err());
        assert!(decode_with_hint(&utf16be, TextEncoding::Utf16Le).is_err());
    }

    #[test]
    fn detects_representative_legacy_phrases() {
        let samples = [
            (
                TextEncoding::Gbk,
                GBK,
                "你好世界 软件开发工具 编码转换测试\r\n",
            ),
            (TextEncoding::Big5, BIG5, "繁體中文測試 臺灣中文\r\n"),
            (
                TextEncoding::ShiftJis,
                SHIFT_JIS,
                "日本語テスト ひらがな\r\n",
            ),
        ];
        for (expected_encoding, codec, source) in samples {
            let (bytes, _, had_errors) = codec.encode(source);
            assert!(!had_errors);
            let decoded = decode(bytes.as_ref()).unwrap();
            assert_eq!(decoded.encoding, expected_encoding, "source={source}");
            assert_eq!(decoded.content, normalize_line_endings(source));
        }
    }

    #[test]
    fn rejects_automatic_legacy_guess_with_conflicting_japanese_script() {
        for (codec, encoding) in [(GBK, TextEncoding::Gbk), (BIG5, TextEncoding::Big5)] {
            let (bytes, _, had_errors) = codec.encode("日本語テスト ひらがな カタカナ\r\n");
            assert!(!had_errors);
            assert!(decode(bytes.as_ref()).is_err(), "encoding={encoding:?}");
            let hinted = decode_with_hint(bytes.as_ref(), encoding).unwrap();
            assert_eq!(hinted.content, "日本語テスト ひらがな カタカナ\n");
        }
    }

    #[test]
    fn rejects_binary_like_bytes() {
        assert!(decode(&[0, 159, 32, 0, 1, 2, 3, 4]).is_err());
        assert!(decode(b"text\x1b[31m").is_err());
        assert!(decode(b"a\0b\0").is_err());
    }

    #[test]
    fn command_output_keeps_legacy_text_with_ansi_controls() {
        let (bytes, _, had_errors) = GBK.encode("中文");
        assert!(!had_errors);
        let mut framed = vec![0x1b, b'[', b'3', b'1', b'm'];
        framed.extend_from_slice(bytes.as_ref());
        framed.extend_from_slice(b"\x1b[0m");
        assert_eq!(decode_command_output(&framed), "\x1b[31m中文\x1b[0m");

        let utf16 = encode(
            "\x1b[31m中文\x1b[0m\n",
            TextEncoding::Utf16Le,
            true,
            LineEnding::Lf,
        )
        .unwrap();
        assert_eq!(decode_command_output(&utf16), "\x1b[31m中文\x1b[0m\n");
    }

    #[test]
    fn command_output_uses_a_lossless_legacy_fallback_for_short_patch_text() {
        let (line, _, had_errors) = GBK.encode("+修改\n");
        assert!(!had_errors);
        let mut patch = b"@@ -1 +1 @@\n".to_vec();
        patch.extend_from_slice(line.as_ref());
        let decoded = decode_command_output(&patch);
        assert!(decoded.contains("+修改"), "decoded={decoded:?}");
        assert!(!decoded.contains('\u{fffd}'));
    }

    #[test]
    fn command_output_decodes_big5_and_shift_jis_without_mojibake() {
        let samples = [(BIG5, "繁體中文輸出"), (SHIFT_JIS, "日本語テスト")];
        for (codec, expected) in samples {
            let (bytes, _, had_errors) = codec.encode(expected);
            assert!(!had_errors);
            let mut framed = vec![0x1b, b'[', b'2', b'K'];
            framed.extend_from_slice(bytes.as_ref());
            framed.extend_from_slice(b"\x1b[0m");
            let decoded = decode_command_output(&framed);
            assert!(
                decoded.contains(expected),
                "expected={expected:?}, decoded={decoded:?}"
            );
            assert!(!decoded.contains('\u{fffd}'));
        }
    }

    #[test]
    fn normalizes_and_detects_mixed_line_endings() {
        assert_eq!(normalize_line_endings("a\r\nb\rc\n"), "a\nb\nc\n");
        assert_eq!(detect_line_ending("a\r\nb\r\nc\r\n"), LineEnding::CrLf);
    }
}
