use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::Path;

use base64::Engine;
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use zip::ZipArchive;

use crate::models::{AgentMessage, AttachmentKind, ImageAttachment};

const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE: usize = 8;
const MAX_DOCUMENTS_PER_MESSAGE: usize = 8;
const MAX_ATTACHMENTS_PER_MESSAGE: usize = 12;
const MAX_REQUEST_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_REQUEST_TEXT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REQUEST_DOCUMENT_BYTES: u64 = 48 * 1024 * 1024;
const MAX_CONTEXT_CHARS_PER_FILE: usize = 48_000;
const MAX_CONTEXT_CHARS_PER_REQUEST: usize = 120_000;
const MAX_ARCHIVE_ENTRIES: usize = 4_096;
const MAX_ARCHIVE_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 96 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DocumentType {
    Pdf,
    Docx,
    Xlsx,
    Pptx,
}

impl DocumentType {
    fn mime_type(self) -> &'static str {
        match self {
            Self::Pdf => "application/pdf",
            Self::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Self::Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            Self::Pptx => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Pdf => "PDF",
            Self::Docx => "DOCX",
            Self::Xlsx => "XLSX",
            Self::Pptx => "PPTX",
        }
    }
}

struct ExtractedDocument {
    text: String,
    detail: String,
}

pub fn import(storage: &Path, source: &Path) -> Result<ImageAttachment, String> {
    let metadata = std::fs::metadata(source)
        .map_err(|error| format!("Could not read selected attachment metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Selected attachment is not a regular file".to_owned());
    }
    if metadata.len() == 0 || metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err("Attachments must be between 1 byte and 20 MiB".to_owned());
    }
    let bytes = std::fs::read(source)
        .map_err(|error| format!("Could not read selected attachment: {error}"))?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .chars()
        .take(240)
        .collect::<String>();
    let (kind, mime_type) = classify_attachment(&name, &bytes)?;

    std::fs::create_dir_all(storage)
        .map_err(|error| format!("Could not create attachment storage: {error}"))?;
    crate::filesystem::restrict_directory(storage)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let destination = storage.join(format!("{id}.bin"));
    let temporary = storage.join(format!(".{id}.tmp"));
    let mut file = std::fs::File::create(&temporary)
        .map_err(|error| format!("Could not stage attachment: {error}"))?;
    crate::filesystem::restrict_file(&temporary)?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Could not store attachment: {error}"));
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Could not activate attachment: {error}"));
    }
    Ok(ImageAttachment {
        id,
        name,
        mime_type,
        size_bytes: bytes.len() as u64,
        kind,
        data_base64: None,
        text_content: None,
    })
}

pub fn resolve(storage: &Path, messages: &mut [AgentMessage]) -> Result<(), String> {
    let active_user_index = messages.iter().rposition(|message| message.role == "user");
    let mut image_total = 0_u64;
    let mut text_total = 0_u64;
    let mut document_total = 0_u64;
    let mut context_chars_remaining = MAX_CONTEXT_CHARS_PER_REQUEST;

    for (message_index, message) in messages.iter_mut().enumerate() {
        if message.attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
            return Err("A message may contain at most 12 attachments".to_owned());
        }
        if message.role != "user" && !message.attachments.is_empty() {
            return Err("Only user messages may contain attachments".to_owned());
        }
        let is_active_user = active_user_index == Some(message_index);
        let mut image_count = 0_usize;
        let mut document_count = 0_usize;

        for attachment in &mut message.attachments {
            validate_id(&attachment.id)?;
            let path = storage.join(format!("{}.bin", attachment.id));
            let metadata = std::fs::metadata(&path)
                .map_err(|_| format!("Attachment '{}' is no longer available", attachment.name))?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ATTACHMENT_BYTES {
                return Err(format!(
                    "Attachment '{}' has an invalid size",
                    attachment.name
                ));
            }
            attachment.size_bytes = metadata.len();
            attachment.data_base64 = None;
            attachment.text_content = None;

            if !is_active_user {
                attachment.text_content = Some(format!(
                    "[Context metadata: status=historical_reference_omitted; kind={}; source_bytes={}]\nThis earlier attachment is retained by LevelUpAgent but is not resent on every turn. Ask the user to reattach it only if its full content is required.",
                    attachment_kind_label(&attachment.kind),
                    metadata.len(),
                ));
                continue;
            }

            let bytes = std::fs::read(&path).map_err(|error| {
                format!("Could not read attachment '{}': {error}", attachment.name)
            })?;
            let (kind, mime_type) = classify_attachment(&attachment.name, &bytes)?;
            attachment.kind = kind;
            attachment.mime_type = mime_type;

            match attachment.kind {
                AttachmentKind::Image => {
                    image_count += 1;
                    if image_count > MAX_IMAGES_PER_MESSAGE {
                        return Err("A message may contain at most 8 images".to_owned());
                    }
                    image_total = image_total.saturating_add(bytes.len() as u64);
                    if image_total > MAX_REQUEST_IMAGE_BYTES {
                        return Err("Images in one request may total at most 32 MiB".to_owned());
                    }
                    attachment.data_base64 =
                        Some(base64::engine::general_purpose::STANDARD.encode(bytes));
                }
                AttachmentKind::Text => {
                    text_total = text_total.saturating_add(bytes.len() as u64);
                    if text_total > MAX_REQUEST_TEXT_BYTES {
                        return Err(
                            "Text attachments in one request may total at most 4 MiB".to_owned()
                        );
                    }
                    let text = std::str::from_utf8(&bytes).map_err(|_| {
                        format!("Attachment '{}' is not valid UTF-8", attachment.name)
                    })?;
                    attachment.text_content = Some(context_excerpt(
                        text,
                        "UTF-8 text",
                        bytes.len() as u64,
                        &mut context_chars_remaining,
                    ));
                }
                AttachmentKind::Document => {
                    document_count += 1;
                    if document_count > MAX_DOCUMENTS_PER_MESSAGE {
                        return Err(
                            "A message may contain at most 8 PDF or Office documents".to_owned()
                        );
                    }
                    document_total = document_total.saturating_add(bytes.len() as u64);
                    if document_total > MAX_REQUEST_DOCUMENT_BYTES {
                        return Err(
                            "PDF and Office documents in one request may total at most 48 MiB"
                                .to_owned(),
                        );
                    }
                    let document_type =
                        document_type_from_mime(&attachment.mime_type).ok_or_else(|| {
                            format!(
                                "Attachment '{}' is not a supported document",
                                attachment.name
                            )
                        })?;
                    let extracted = extract_document(document_type, &bytes).map_err(|error| {
                        format!("Could not extract '{}': {error}", attachment.name)
                    })?;
                    attachment.text_content = Some(context_excerpt(
                        &extracted.text,
                        &format!("{}; {}", document_type.label(), extracted.detail),
                        bytes.len() as u64,
                        &mut context_chars_remaining,
                    ));
                }
            }
        }
    }
    Ok(())
}

pub fn delete(storage: &Path, id: &str) -> Result<bool, String> {
    validate_id(id)?;
    match std::fs::remove_file(storage.join(format!("{id}.bin"))) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not delete attachment: {error}")),
    }
}

fn classify_attachment(name: &str, bytes: &[u8]) -> Result<(AttachmentKind, String), String> {
    if let Some(mime_type) = detect_image_mime(bytes) {
        return Ok((AttachmentKind::Image, mime_type.to_owned()));
    }
    if let Some(document_type) = detect_document_type(bytes)? {
        return Ok((
            AttachmentKind::Document,
            document_type.mime_type().to_owned(),
        ));
    }
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err("Text and code attachments may be at most 1 MiB".to_owned());
    }
    let mime_type = detect_text_mime(name, bytes).ok_or_else(|| {
        "Only PNG/JPEG/WebP/GIF images, PDF/DOCX/XLSX/PPTX documents, and supported UTF-8 text or code files are allowed".to_owned()
    })?;
    Ok((AttachmentKind::Text, mime_type.to_owned()))
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.len() != 32 || !id.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("Attachment ID is invalid".to_owned());
    }
    Ok(())
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn detect_document_type(bytes: &[u8]) -> Result<Option<DocumentType>, String> {
    if bytes.starts_with(b"%PDF-") {
        lopdf::Document::load_mem(bytes)
            .map_err(|error| format!("Invalid PDF document: {error}"))?;
        return Ok(Some(DocumentType::Pdf));
    }
    if !bytes.starts_with(b"PK") {
        return Ok(None);
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Invalid Office document container: {error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("Office document contains too many archive entries".to_owned());
    }
    let mut total = 0_u64;
    let mut names = HashSet::new();
    let mut docx = false;
    let mut xlsx = false;
    let mut pptx = false;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("Could not inspect Office document: {error}"))?;
        if file.enclosed_name().is_none() {
            return Err("Office document contains an unsafe archive path".to_owned());
        }
        if !names.insert(file.name().to_owned()) {
            return Err("Office document contains duplicate archive paths".to_owned());
        }
        if file.size() > MAX_ARCHIVE_ENTRY_BYTES {
            return Err("Office document contains an oversized archive entry".to_owned());
        }
        total = total.saturating_add(file.size());
        if total > MAX_ARCHIVE_TOTAL_BYTES {
            return Err("Office document expands beyond the 96 MiB safety limit".to_owned());
        }
        match file.name() {
            "word/document.xml" => docx = true,
            "xl/workbook.xml" => xlsx = true,
            "ppt/presentation.xml" => pptx = true,
            _ => {}
        }
    }
    let kinds = usize::from(docx) + usize::from(xlsx) + usize::from(pptx);
    if kinds > 1 {
        return Err("Office document contains conflicting package types".to_owned());
    }
    Ok(if docx {
        Some(DocumentType::Docx)
    } else if xlsx {
        Some(DocumentType::Xlsx)
    } else if pptx {
        Some(DocumentType::Pptx)
    } else {
        None
    })
}

fn document_type_from_mime(mime_type: &str) -> Option<DocumentType> {
    match mime_type {
        "application/pdf" => Some(DocumentType::Pdf),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            Some(DocumentType::Docx)
        }
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => {
            Some(DocumentType::Xlsx)
        }
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => {
            Some(DocumentType::Pptx)
        }
        _ => None,
    }
}

fn detect_text_mime(name: &str, bytes: &[u8]) -> Option<&'static str> {
    std::str::from_utf8(bytes).ok()?;
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "txt" | "log" => Some("text/plain"),
        "md" | "markdown" => Some("text/markdown"),
        "json" | "jsonc" => Some("application/json"),
        "toml" => Some("application/toml"),
        "yaml" | "yml" => Some("application/yaml"),
        "xml" => Some("application/xml"),
        "csv" => Some("text/csv"),
        "tsv" => Some("text/tab-separated-values"),
        "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go" | "java" | "kt"
        | "kts" | "swift" | "c" | "cc" | "cpp" | "h" | "hpp" | "cs" | "rb" | "php" | "sh"
        | "ps1" | "sql" | "html" | "css" | "scss" | "vue" | "svelte" => Some("text/plain"),
        _ => None,
    }
}

fn extract_document(
    document_type: DocumentType,
    bytes: &[u8],
) -> Result<ExtractedDocument, String> {
    match document_type {
        DocumentType::Pdf => extract_pdf(bytes),
        DocumentType::Docx => extract_docx(bytes),
        DocumentType::Xlsx => extract_xlsx(bytes),
        DocumentType::Pptx => extract_pptx(bytes),
    }
}

fn extract_pdf(bytes: &[u8]) -> Result<ExtractedDocument, String> {
    let document = lopdf::Document::load_mem(bytes).map_err(|error| error.to_string())?;
    let pages = document.get_pages();
    let mut text = String::new();
    let mut extracted_pages = 0_usize;
    for page_number in pages.keys().copied() {
        if let Ok(page_text) = document.extract_text(&[page_number])
            && !page_text.trim().is_empty()
        {
            text.push_str(&format!("--- Page {page_number} ---\n"));
            text.push_str(page_text.trim());
            text.push_str("\n\n");
            extracted_pages += 1;
        }
    }
    if text.is_empty() {
        text.push_str(
            "[No extractable text was found. The PDF may contain scanned images or outlined text.]",
        );
    }
    Ok(ExtractedDocument {
        text: normalize_extracted_text(&text),
        detail: format!("pages={}; pages_with_text={extracted_pages}", pages.len()),
    })
}

fn extract_docx(bytes: &[u8]) -> Result<ExtractedDocument, String> {
    let xml = read_zip_text(bytes, "word/document.xml")?
        .ok_or_else(|| "word/document.xml is missing".to_owned())?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut text = String::new();
    let mut in_text = false;
    let mut paragraphs = 0_usize;
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(event) => {
                let name = event.name();
                if name.as_ref() == b"w:t" {
                    in_text = true;
                }
            }
            Event::Empty(event) => match event.name().as_ref() {
                b"w:tab" => text.push('\t'),
                b"w:br" | b"w:cr" => text.push('\n'),
                _ => {}
            },
            Event::Text(event) if in_text => {
                text.push_str(&decode_xml_text(&reader, event.as_ref())?)
            }
            Event::CData(event) if in_text => {
                text.push_str(&String::from_utf8_lossy(event.as_ref()))
            }
            Event::End(event) => match event.name().as_ref() {
                b"w:t" => in_text = false,
                b"w:p" => {
                    text.push('\n');
                    paragraphs += 1;
                }
                b"w:tc" => text.push('\t'),
                b"w:tr" => text.push('\n'),
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(ExtractedDocument {
        text: normalize_extracted_text(&text),
        detail: format!("paragraphs={paragraphs}"),
    })
}

fn extract_pptx(bytes: &[u8]) -> Result<ExtractedDocument, String> {
    let ordered = ordered_ooxml_parts(
        bytes,
        "ppt/presentation.xml",
        "ppt/_rels/presentation.xml.rels",
        "ppt/",
        b"p:sldId",
        "ppt/slides/slide",
        ".xml",
    )?;
    let mut text = String::new();
    for (index, path) in ordered.iter().enumerate() {
        let xml =
            read_zip_text(bytes, path)?.ok_or_else(|| format!("Slide part '{path}' is missing"))?;
        let slide_text = extract_tagged_text(&xml, b"a:t", b"a:p")?;
        text.push_str(&format!("--- Slide {} ---\n", index + 1));
        if slide_text.trim().is_empty() {
            text.push_str("[No extractable slide text]");
        } else {
            text.push_str(slide_text.trim());
        }
        text.push_str("\n\n");
    }
    Ok(ExtractedDocument {
        text: normalize_extracted_text(&text),
        detail: format!("slides={}", ordered.len()),
    })
}

fn extract_xlsx(bytes: &[u8]) -> Result<ExtractedDocument, String> {
    let shared_strings = read_zip_text(bytes, "xl/sharedStrings.xml")?
        .map(|xml| parse_shared_strings(&xml))
        .transpose()?
        .unwrap_or_default();
    let workbook_xml = read_zip_text(bytes, "xl/workbook.xml")?
        .ok_or_else(|| "xl/workbook.xml is missing".to_owned())?;
    let relationships_xml = read_zip_text(bytes, "xl/_rels/workbook.xml.rels")?;
    let relationships = relationships_xml
        .as_deref()
        .map(parse_relationships)
        .transpose()?
        .unwrap_or_default();
    let sheets = parse_workbook_sheets(&workbook_xml)?;
    let fallback_parts = sorted_zip_parts(bytes, "xl/worksheets/sheet", ".xml")?;
    let mut text = String::new();
    let mut extracted_sheets = 0_usize;

    for (index, (name, relationship_id)) in sheets.iter().enumerate() {
        let path = relationships
            .get(relationship_id)
            .and_then(|target| resolve_ooxml_target("xl/", target))
            .or_else(|| fallback_parts.get(index).cloned());
        let Some(path) = path else { continue };
        let Some(xml) = read_zip_text(bytes, &path)? else {
            continue;
        };
        let cells = parse_worksheet_cells(&xml, &shared_strings)?;
        text.push_str(&format!("--- Sheet: {name} ---\n"));
        if cells.is_empty() {
            text.push_str("[No populated cells]\n\n");
        } else {
            for (reference, value) in cells {
                text.push_str(&reference);
                text.push('\t');
                text.push_str(&value);
                text.push('\n');
            }
            text.push('\n');
        }
        extracted_sheets += 1;
    }
    if extracted_sheets == 0 {
        for (index, path) in fallback_parts.iter().enumerate() {
            let Some(xml) = read_zip_text(bytes, path)? else {
                continue;
            };
            text.push_str(&format!("--- Sheet {} ---\n", index + 1));
            for (reference, value) in parse_worksheet_cells(&xml, &shared_strings)? {
                text.push_str(&format!("{reference}\t{value}\n"));
            }
            text.push('\n');
            extracted_sheets += 1;
        }
    }
    Ok(ExtractedDocument {
        text: normalize_extracted_text(&text),
        detail: format!("sheets={extracted_sheets}"),
    })
}

fn read_zip_text(bytes: &[u8], name: &str) -> Result<Option<String>, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let mut found = None;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        if file.name() == name {
            found = Some(index);
            break;
        }
    }
    let Some(index) = found else { return Ok(None) };
    let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
    if file.size() > MAX_ARCHIVE_ENTRY_BYTES {
        return Err(format!(
            "Archive part '{name}' exceeds the extraction limit"
        ));
    }
    let mut output = String::with_capacity(file.size().min(1024 * 1024) as usize);
    file.read_to_string(&mut output)
        .map_err(|error| format!("Archive part '{name}' is not valid UTF-8 XML: {error}"))?;
    Ok(Some(output))
}

fn sorted_zip_parts(bytes: &[u8], prefix: &str, suffix: &str) -> Result<Vec<String>, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let mut parts = Vec::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = file.name();
        if name.starts_with(prefix) && name.ends_with(suffix) {
            parts.push(name.to_owned());
        }
    }
    parts.sort_by_key(|path| {
        path.trim_end_matches(suffix)
            .trim_start_matches(prefix)
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });
    Ok(parts)
}

fn ordered_ooxml_parts(
    bytes: &[u8],
    owner_path: &str,
    relationships_path: &str,
    base: &str,
    item_tag: &[u8],
    fallback_prefix: &str,
    fallback_suffix: &str,
) -> Result<Vec<String>, String> {
    let fallback = sorted_zip_parts(bytes, fallback_prefix, fallback_suffix)?;
    let Some(owner_xml) = read_zip_text(bytes, owner_path)? else {
        return Ok(fallback);
    };
    let Some(relationships_xml) = read_zip_text(bytes, relationships_path)? else {
        return Ok(fallback);
    };
    let relationships = parse_relationships(&relationships_xml)?;
    let relationship_ids = parse_relationship_ids(&owner_xml, item_tag)?;
    let ordered = relationship_ids
        .iter()
        .filter_map(|id| relationships.get(id))
        .filter_map(|target| resolve_ooxml_target(base, target))
        .collect::<Vec<_>>();
    Ok(if ordered.is_empty() {
        fallback
    } else {
        ordered
    })
}

fn parse_relationships(xml: &str) -> Result<HashMap<String, String>, String> {
    let mut reader = Reader::from_str(xml);
    let mut relationships = HashMap::new();
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(event) | Event::Empty(event)
                if event.name().as_ref() == b"Relationship" =>
            {
                if let (Some(id), Some(target)) =
                    (attribute(&event, &[b"Id"]), attribute(&event, &[b"Target"]))
                {
                    relationships.insert(id, target);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(relationships)
}

fn parse_relationship_ids(xml: &str, item_tag: &[u8]) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    let mut ids = Vec::new();
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(event) | Event::Empty(event) if event.name().as_ref() == item_tag => {
                if let Some(id) = attribute(&event, &[b"r:id", b"id"]) {
                    ids.push(id);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(ids)
}

fn parse_workbook_sheets(xml: &str) -> Result<Vec<(String, String)>, String> {
    let mut reader = Reader::from_str(xml);
    let mut sheets = Vec::new();
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(event) | Event::Empty(event) if event.name().as_ref() == b"sheet" => {
                if let (Some(name), Some(id)) = (
                    attribute(&event, &[b"name"]),
                    attribute(&event, &[b"r:id", b"id"]),
                ) {
                    sheets.push((name, id));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(sheets)
}

fn parse_shared_strings(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(event) => match event.name().as_ref() {
                b"si" => {
                    in_item = true;
                    current.clear();
                }
                b"t" if in_item => in_text = true,
                _ => {}
            },
            Event::Text(event) if in_text => {
                current.push_str(&decode_xml_text(&reader, event.as_ref())?)
            }
            Event::End(event) => match event.name().as_ref() {
                b"t" => in_text = false,
                b"si" => {
                    strings.push(current.clone());
                    in_item = false;
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(strings)
}

#[derive(Default)]
struct CellState {
    reference: String,
    value_type: String,
    formula: String,
    value: String,
    inline_text: String,
}

#[derive(Clone, Copy)]
enum CellCapture {
    Formula,
    Value,
    InlineText,
}

fn parse_worksheet_cells(
    xml: &str,
    shared_strings: &[String],
) -> Result<Vec<(String, String)>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut cells = Vec::new();
    let mut cell: Option<CellState> = None;
    let mut capture = None;
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(event) => match event.name().as_ref() {
                b"c" => {
                    cell = Some(CellState {
                        reference: attribute(&event, &[b"r"]).unwrap_or_else(|| "?".to_owned()),
                        value_type: attribute(&event, &[b"t"]).unwrap_or_default(),
                        ..CellState::default()
                    });
                }
                b"f" if cell.is_some() => capture = Some(CellCapture::Formula),
                b"v" if cell.is_some() => capture = Some(CellCapture::Value),
                b"t" if cell.is_some() => capture = Some(CellCapture::InlineText),
                _ => {}
            },
            Event::Text(event) => {
                let value = decode_xml_text(&reader, event.as_ref())?;
                if let (Some(cell), Some(capture)) = (cell.as_mut(), capture) {
                    match capture {
                        CellCapture::Formula => cell.formula.push_str(&value),
                        CellCapture::Value => cell.value.push_str(&value),
                        CellCapture::InlineText => cell.inline_text.push_str(&value),
                    }
                }
            }
            Event::End(event) => match event.name().as_ref() {
                b"f" | b"v" | b"t" => capture = None,
                b"c" => {
                    if let Some(cell) = cell.take() {
                        let display = display_cell_value(&cell, shared_strings);
                        if !display.is_empty() {
                            cells.push((cell.reference, display));
                        }
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(cells)
}

fn display_cell_value(cell: &CellState, shared_strings: &[String]) -> String {
    let raw = match cell.value_type.as_str() {
        "s" => cell
            .value
            .parse::<usize>()
            .ok()
            .and_then(|index| shared_strings.get(index))
            .cloned()
            .unwrap_or_else(|| format!("[missing shared string {}]", cell.value)),
        "inlineStr" => cell.inline_text.clone(),
        "b" => {
            if cell.value == "1" {
                "TRUE".to_owned()
            } else {
                "FALSE".to_owned()
            }
        }
        "e" => format!("[error {}]", cell.value),
        _ => {
            if cell.inline_text.is_empty() {
                cell.value.clone()
            } else {
                cell.inline_text.clone()
            }
        }
    };
    if cell.formula.is_empty() {
        raw
    } else if raw.is_empty() {
        format!("={}", cell.formula)
    } else {
        format!("={} [cached: {raw}]", cell.formula)
    }
}

fn extract_tagged_text(xml: &str, text_tag: &[u8], paragraph_tag: &[u8]) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut output = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(event) if event.name().as_ref() == text_tag => in_text = true,
            Event::Text(event) if in_text => {
                output.push_str(&decode_xml_text(&reader, event.as_ref())?)
            }
            Event::End(event) if event.name().as_ref() == text_tag => in_text = false,
            Event::End(event) if event.name().as_ref() == paragraph_tag => output.push('\n'),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(output)
}

fn attribute(event: &BytesStart<'_>, names: &[&[u8]]) -> Option<String> {
    event
        .attributes()
        .with_checks(false)
        .flatten()
        .find_map(|attribute| {
            names
                .iter()
                .any(|name| attribute.key.as_ref() == *name)
                .then(|| {
                    let raw = String::from_utf8_lossy(attribute.value.as_ref());
                    quick_xml::escape::unescape(&raw)
                        .map(|value| value.into_owned())
                        .unwrap_or_else(|_| raw.into_owned())
                })
        })
}

fn decode_xml_text(reader: &Reader<&[u8]>, bytes: &[u8]) -> Result<String, String> {
    let decoded = reader
        .decoder()
        .decode(bytes)
        .map_err(|error| error.to_string())?;
    quick_xml::escape::unescape(&decoded)
        .map(|value| value.into_owned())
        .map_err(|error| error.to_string())
}

fn resolve_ooxml_target(base: &str, target: &str) -> Option<String> {
    let combined = if target.starts_with('/') {
        target.trim_start_matches('/').to_owned()
    } else {
        format!("{base}{}", target.replace('\\', "/"))
    };
    let mut parts = Vec::new();
    for part in combined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            value => parts.push(value),
        }
    }
    Some(parts.join("/"))
}

fn context_excerpt(text: &str, detail: &str, source_bytes: u64, remaining: &mut usize) -> String {
    let total_chars = text.chars().count();
    let budget = (*remaining).min(MAX_CONTEXT_CHARS_PER_FILE);
    let (excerpt, included_chars, truncated) = excerpt_chars(text, budget);
    *remaining = remaining.saturating_sub(included_chars);
    let detail = detail.replace(['\r', '\n', ']'], " ");
    let mut output = format!(
        "[Context metadata: source_bytes={source_bytes}; extracted_chars={total_chars}; included_chars={included_chars}; truncated={truncated}; {detail}]\n"
    );
    if excerpt.is_empty() {
        output.push_str("[Content omitted because the 120000-character attachment context budget is exhausted.]");
    } else {
        output.push_str(&excerpt);
    }
    output
}

fn excerpt_chars(text: &str, budget: usize) -> (String, usize, bool) {
    let total = text.chars().count();
    if total <= budget {
        return (text.to_owned(), total, false);
    }
    if budget == 0 {
        return (String::new(), 0, true);
    }
    let marker_reserve = 120.min(budget / 3);
    let content_budget = budget.saturating_sub(marker_reserve);
    let head_count = content_budget.saturating_mul(3) / 4;
    let tail_count = content_budget.saturating_sub(head_count);
    let head = text.chars().take(head_count).collect::<String>();
    let tail = text
        .chars()
        .skip(total.saturating_sub(tail_count))
        .collect::<String>();
    let omitted = total.saturating_sub(head_count + tail_count);
    let excerpt =
        format!("{head}\n\n[... deterministically truncated {omitted} characters ...]\n\n{tail}");
    (excerpt, head_count + tail_count, true)
}

fn normalize_extracted_text(text: &str) -> String {
    let normalized = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\0', "");
    let mut output = String::new();
    let mut blank_lines = 0_usize;
    for line in normalized.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank_lines += 1;
            if blank_lines > 2 {
                continue;
            }
        } else {
            blank_lines = 0;
        }
        output.push_str(line);
        output.push('\n');
    }
    output.trim().to_owned()
}

fn attachment_kind_label(kind: &AttachmentKind) -> &'static str {
    match kind {
        AttachmentKind::Image => "image",
        AttachmentKind::Text => "text",
        AttachmentKind::Document => "document",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{Dictionary, Object, Stream, dictionary};
    use zip::write::SimpleFileOptions;

    fn root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("levelup-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn user_message(attachments: Vec<ImageAttachment>) -> AgentMessage {
        AgentMessage {
            role: "user".to_owned(),
            content: "Inspect".to_owned(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            internal: false,
            attachments,
        }
    }

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, content) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn imports_and_resolves_managed_png_without_trusting_frontend_mime() {
        let root = root("attachment");
        let source = root.join("sample.png");
        std::fs::write(&source, b"\x89PNG\r\n\x1a\ncontent").unwrap();
        let storage = root.join("managed");
        let mut attachment = import(&storage, &source).unwrap();
        attachment.mime_type = "image/jpeg".to_owned();
        let mut messages = vec![user_message(vec![attachment])];
        resolve(&storage, &mut messages).unwrap();
        assert_eq!(messages[0].attachments[0].mime_type, "image/png");
        assert!(messages[0].attachments[0].data_base64.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsupported_and_forged_attachments() {
        let root = root("attachment-reject");
        let source = root.join("not-supported.bin");
        std::fs::write(&source, b"not an image").unwrap();
        assert!(import(&root.join("managed"), &source).is_err());
        let mut messages = vec![user_message(vec![ImageAttachment {
            id: "../escape".to_owned(),
            name: "bad".to_owned(),
            mime_type: "image/png".to_owned(),
            size_bytes: 1,
            kind: AttachmentKind::Image,
            data_base64: None,
            text_content: None,
        }])];
        assert!(resolve(&root, &mut messages).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn imports_and_resolves_utf8_code_as_untrusted_text_context() {
        let root = root("text-attachment");
        let source = root.join("example.rs");
        std::fs::write(&source, "fn main() { println!(\"hello\"); }\n").unwrap();
        let storage = root.join("managed");
        let attachment = import(&storage, &source).unwrap();
        assert_eq!(attachment.kind, AttachmentKind::Text);
        let mut messages = vec![user_message(vec![attachment])];
        resolve(&storage, &mut messages).unwrap();
        let context = messages[0].attachments[0].text_content.as_deref().unwrap();
        assert!(context.contains("fn main"));
        assert!(context.contains("extracted_chars="));
        assert!(messages[0].attachments[0].data_base64.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extracts_real_minimal_docx_xlsx_and_pptx_artifacts() {
        let root = root("office-artifacts");
        let storage = root.join("managed");
        let docx = root.join("sample.docx");
        write_zip(
            &docx,
            &[(
                "word/document.xml",
                r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>"#,
            )],
        );
        let xlsx = root.join("sample.xlsx");
        write_zip(
            &xlsx,
            &[
                (
                    "xl/workbook.xml",
                    r#"<workbook xmlns:r="r"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>"#,
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
                ),
                (
                    "xl/sharedStrings.xml",
                    r#"<sst><si><t>Hello XLSX</t></si></sst>"#,
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>"#,
                ),
            ],
        );
        let pptx = root.join("sample.pptx");
        write_zip(
            &pptx,
            &[
                (
                    "ppt/presentation.xml",
                    r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>"#,
                ),
                (
                    "ppt/_rels/presentation.xml.rels",
                    r#"<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>"#,
                ),
                (
                    "ppt/slides/slide1.xml",
                    r#"<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Hello PPTX</a:t></a:r></a:p></p:sld>"#,
                ),
            ],
        );
        let attachments = [&docx, &xlsx, &pptx]
            .into_iter()
            .map(|path| import(&storage, path).unwrap())
            .collect::<Vec<_>>();
        assert!(
            attachments
                .iter()
                .all(|item| item.kind == AttachmentKind::Document)
        );
        let mut messages = vec![user_message(attachments)];
        resolve(&storage, &mut messages).unwrap();
        let contexts = messages[0]
            .attachments
            .iter()
            .map(|item| item.text_content.as_deref().unwrap())
            .collect::<Vec<_>>();
        assert!(contexts[0].contains("Hello DOCX"));
        assert!(contexts[1].contains("A1\tHello XLSX"));
        assert!(contexts[1].contains("B1\t=1+1 [cached: 2]"));
        assert!(contexts[2].contains("Hello PPTX"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_conflicting_and_path_escaping_office_packages() {
        let root = root("unsafe-office-artifacts");
        let conflict = root.join("conflict.docx");
        write_zip(
            &conflict,
            &[
                ("word/document.xml", "<w:document/>"),
                ("xl/workbook.xml", "<workbook/>"),
            ],
        );
        assert!(
            import(&root.join("managed"), &conflict)
                .unwrap_err()
                .contains("conflicting package types")
        );

        let escaping = root.join("escaping.docx");
        write_zip(
            &escaping,
            &[
                ("word/document.xml", "<w:document/>"),
                ("../outside.xml", "unsafe"),
            ],
        );
        assert!(
            import(&root.join("managed"), &escaping)
                .unwrap_err()
                .contains("unsafe archive path")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extracts_text_from_a_real_minimal_pdf_artifact() {
        let root = root("pdf-artifact");
        let source = root.join("sample.pdf");
        let mut document = lopdf::Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let content = lopdf::content::Content {
            operations: vec![
                lopdf::content::Operation::new("BT", vec![]),
                lopdf::content::Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 14.into()]),
                lopdf::content::Operation::new("Td", vec![72.into(), 720.into()]),
                lopdf::content::Operation::new("Tj", vec![Object::string_literal("Hello PDF")]),
                lopdf::content::Operation::new("ET", vec![]),
            ],
        };
        let content_id =
            document.add_object(Stream::new(Dictionary::new(), content.encode().unwrap()));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
            "Resources" => resources_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            }),
        );
        let catalog_id =
            document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        document.trailer.set("Root", catalog_id);
        document.compress();
        document.save(&source).unwrap();
        let storage = root.join("managed");
        let attachment = import(&storage, &source).unwrap();
        let mut messages = vec![user_message(vec![attachment])];
        resolve(&storage, &mut messages).unwrap();
        assert!(
            messages[0].attachments[0]
                .text_content
                .as_deref()
                .unwrap()
                .contains("Hello PDF")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn deterministically_truncates_current_context_and_marks_history() {
        let root = root("context-governance");
        let storage = root.join("managed");
        let old_source = root.join("old.txt");
        let current_source = root.join("current.txt");
        std::fs::write(&old_source, "old context").unwrap();
        std::fs::write(&current_source, "a".repeat(80_000)).unwrap();
        let old_attachment = import(&storage, &old_source).unwrap();
        let current_attachment = import(&storage, &current_source).unwrap();
        let mut messages = vec![
            user_message(vec![old_attachment]),
            user_message(vec![current_attachment]),
        ];
        resolve(&storage, &mut messages).unwrap();
        let old = messages[0].attachments[0].text_content.as_deref().unwrap();
        let current = messages[1].attachments[0].text_content.as_deref().unwrap();
        assert!(old.contains("historical_reference_omitted"));
        assert!(current.contains("truncated=true"));
        assert!(current.contains("deterministically truncated"));
        assert!(current.len() < 50_000);
        let _ = std::fs::remove_dir_all(root);
    }
}
