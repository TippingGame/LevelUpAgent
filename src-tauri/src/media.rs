use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine;
use futures_util::{StreamExt, future::join_all};
use reqwest::header::CONTENT_TYPE;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder, Response};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use crate::agent;
use crate::attachment::ManagedReference;
use crate::database::Database;
use crate::models::{
    AttachmentKind, MediaAsset, MediaAssetPage, MediaBatchResult, MediaCatalog,
    MediaGenerationRequest, MediaKind, MediaModelInfo, MediaStatus, ProviderProfile,
    ProviderProtocol, VideoGenerationMode,
};

const MAX_PROMPT_CHARS: usize = 32_000;
const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES: usize = 1024 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct MediaProvider {
    pub profile: ProviderProfile,
    pub api_key: String,
}

fn bearer_auth_if_present(request: RequestBuilder, provider: &MediaProvider) -> RequestBuilder {
    if provider.api_key.is_empty() {
        request
    } else {
        request.bearer_auth(&provider.api_key)
    }
}

fn gemini_auth_if_present(request: RequestBuilder, provider: &MediaProvider) -> RequestBuilder {
    if provider.api_key.is_empty() {
        request
    } else {
        request
            .bearer_auth(&provider.api_key)
            .header("x-goog-api-key", &provider.api_key)
    }
}

#[derive(Clone)]
pub struct MediaSelection {
    pub provider: MediaProvider,
    pub model: String,
}

struct GeneratedBlob {
    bytes: Vec<u8>,
    mime_type: String,
    revised_prompt: Option<String>,
}

struct BlobSource {
    base64: Option<String>,
    url: Option<String>,
    mime_type: Option<String>,
    revised_prompt: Option<String>,
}

struct RemoteVideoJob {
    id: String,
    status: MediaStatus,
    progress: Option<u32>,
}

pub async fn discover_catalog(
    client: &Client,
    providers: &[MediaProvider],
    active_profile_id: &str,
) -> MediaCatalog {
    let requests = providers.iter().map(|provider| async move {
        agent::fetch_models(client, provider.profile.clone(), provider.api_key.as_str()).await
    });
    let responses = join_all(requests).await;
    let mut models = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();

    for (provider, response) in providers.iter().zip(responses) {
        let mut ids = match response {
            Ok(items) => items.into_iter().map(|item| item.id).collect::<Vec<_>>(),
            Err(error) => {
                errors.push(format!("{}: {error}", provider.profile.name));
                Vec::new()
            }
        };
        ids.push(provider.profile.model.clone());
        for id in ids {
            let id = id.trim().trim_start_matches("models/").to_owned();
            if id.is_empty() {
                continue;
            }
            for (kind, rank) in classify_media_model(&id) {
                if seen.insert((provider.profile.id.clone(), kind.clone(), id.clone())) {
                    models.push(MediaModelInfo {
                        id: id.clone(),
                        profile_id: provider.profile.id.clone(),
                        profile_name: provider.profile.name.clone(),
                        kind,
                        rank,
                        recommended: false,
                    });
                }
            }
        }
    }

    for kind in [MediaKind::Image, MediaKind::Video, MediaKind::Audio] {
        let preferred = models
            .iter()
            .enumerate()
            .filter(|(_, item)| item.kind == kind && item.profile_id == active_profile_id)
            .max_by(|(_, left), (_, right)| {
                left.rank
                    .cmp(&right.rank)
                    .then_with(|| right.id.cmp(&left.id))
            })
            .map(|(index, _)| index)
            .or_else(|| {
                models
                    .iter()
                    .enumerate()
                    .filter(|(_, item)| item.kind == kind)
                    .max_by(|(_, left), (_, right)| {
                        left.rank
                            .cmp(&right.rank)
                            .then_with(|| right.id.cmp(&left.id))
                    })
                    .map(|(index, _)| index)
            });
        if let Some(index) = preferred {
            models[index].recommended = true;
        }
    }

    models.sort_by(|left, right| {
        media_kind_order(&left.kind)
            .cmp(&media_kind_order(&right.kind))
            .then_with(|| right.recommended.cmp(&left.recommended))
            .then_with(|| {
                (right.profile_id == active_profile_id).cmp(&(left.profile_id == active_profile_id))
            })
            .then_with(|| right.rank.cmp(&left.rank))
            .then_with(|| left.profile_name.cmp(&right.profile_name))
            .then_with(|| left.id.cmp(&right.id))
    });
    MediaCatalog { models, errors }
}

pub fn selection_candidates(
    providers: &[MediaProvider],
    catalog: &MediaCatalog,
    request: &MediaGenerationRequest,
) -> Vec<MediaSelection> {
    let mut selections = Vec::new();
    let mut seen = HashSet::new();
    for model in &catalog.models {
        if model.kind != request.kind
            || request
                .profile_id
                .as_deref()
                .is_some_and(|id| id != model.profile_id)
            || request
                .model
                .as_deref()
                .is_some_and(|id| id.trim_start_matches("models/") != model.id)
        {
            continue;
        }
        if let Some(provider) = providers
            .iter()
            .find(|provider| provider.profile.id == model.profile_id)
            && seen.insert((model.profile_id.clone(), model.id.clone()))
        {
            selections.push(MediaSelection {
                provider: provider.clone(),
                model: model.id.clone(),
            });
        }
    }

    if selections.is_empty()
        && let Some(model) = request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    {
        for provider in providers.iter().filter(|provider| {
            request
                .profile_id
                .as_deref()
                .is_none_or(|id| id == provider.profile.id)
        }) {
            selections.push(MediaSelection {
                provider: provider.clone(),
                model: model.trim_start_matches("models/").to_owned(),
            });
        }
    }
    selections
}

pub async fn generate_batch(
    client: &Client,
    storage: &Path,
    database: &Database,
    selection: &MediaSelection,
    request: &MediaGenerationRequest,
    thread_id: Option<&str>,
    references: &[ManagedReference],
) -> Result<MediaBatchResult, String> {
    validate_request(request, references)?;
    validate_model_request(&selection.model, request, references)?;
    let batch_id = uuid::Uuid::new_v4().simple().to_string();
    match request.kind {
        MediaKind::Image => {
            generate_images(
                client, storage, database, selection, request, thread_id, references, batch_id,
            )
            .await
        }
        MediaKind::Audio => {
            generate_audio(
                client, database, storage, selection, request, thread_id, batch_id,
            )
            .await
        }
        MediaKind::Video => {
            generate_videos(
                database, client, selection, request, thread_id, references, batch_id,
            )
            .await
        }
    }
}

pub fn list_assets(
    database: &Database,
    storage: &Path,
    limit: usize,
) -> Result<Vec<MediaAsset>, String> {
    database
        .list_media_assets(limit)?
        .into_iter()
        .map(|asset| enrich_asset(storage, asset))
        .collect()
}

pub fn list_assets_page(
    database: &Database,
    storage: &Path,
    kind: &MediaKind,
    limit: usize,
    offset: usize,
) -> Result<MediaAssetPage, String> {
    let limit = limit.clamp(1, 100);
    let mut assets = database.list_media_assets_page(kind, limit.saturating_add(1), offset)?;
    let has_more = assets.len() > limit;
    assets.truncate(limit);
    let assets = assets
        .into_iter()
        .map(|asset| enrich_asset(storage, asset))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MediaAssetPage { assets, has_more })
}

pub fn get_asset(
    database: &Database,
    storage: &Path,
    id: &str,
) -> Result<Option<MediaAsset>, String> {
    database
        .get_media_asset(id)?
        .map(|asset| enrich_asset(storage, asset))
        .transpose()
}

pub fn delete_asset(database: &Database, storage: &Path, id: &str) -> Result<bool, String> {
    let Some(asset) = database.delete_media_asset(id)? else {
        return Ok(false);
    };
    if let Some(file_name) = asset.file_name {
        let path = safe_media_path(storage, &file_name)?;
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not delete media file: {error}")),
        }
    }
    Ok(true)
}

pub async fn export_asset(
    database: &Database,
    storage: &Path,
    id: &str,
    destination: &Path,
) -> Result<PathBuf, String> {
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err("Choose an absolute destination file for the media export".to_owned());
    }
    let asset = database
        .get_media_asset(id)?
        .ok_or_else(|| "Media asset was not found".to_owned())?;
    if asset.status != MediaStatus::Completed {
        return Err("Only completed media can be exported".to_owned());
    }
    let file_name = asset
        .file_name
        .as_deref()
        .ok_or_else(|| "Completed media has no managed file".to_owned())?;
    let source = safe_media_path(storage, file_name)?;
    let metadata = tokio::fs::metadata(&source)
        .await
        .map_err(|error| format!("Could not read media file for export: {error}"))?;
    if !metadata.is_file() {
        return Err("The managed media output is not a file".to_owned());
    }
    if source == destination {
        return Ok(destination.to_path_buf());
    }
    tokio::fs::copy(&source, destination)
        .await
        .map_err(|error| format!("Could not export media file: {error}"))?;
    Ok(destination.to_path_buf())
}

pub async fn refresh_asset(
    client: &Client,
    storage: &Path,
    database: &Database,
    provider: &MediaProvider,
    mut asset: MediaAsset,
) -> Result<MediaAsset, String> {
    if asset.kind != MediaKind::Video
        || matches!(asset.status, MediaStatus::Completed | MediaStatus::Failed)
    {
        return enrich_asset(storage, asset);
    }
    let remote_id = asset
        .remote_id
        .clone()
        .ok_or_else(|| "Video job has no provider job ID".to_owned())?;
    let result = if matches!(
        provider.profile.protocol,
        ProviderProtocol::GeminiGenerateContent
    ) && is_gemini_video_model(&asset.model)
    {
        poll_gemini_video(client, provider, &remote_id).await
    } else {
        poll_openai_video(client, provider, &remote_id).await
    };
    let now = now_millis();
    match result {
        Ok(VideoPoll::Pending { status, progress }) => {
            asset.status = status;
            asset.progress = progress;
            asset.updated_at = now;
        }
        Ok(VideoPoll::Completed { bytes, mime_type }) => {
            let extension = extension_for_mime(&mime_type, MediaKind::Video);
            let file_name = format!("{}.{}", asset.id, extension);
            let path = write_media_file(storage, &file_name, &bytes).await?;
            asset.status = MediaStatus::Completed;
            asset.progress = Some(100);
            asset.mime_type = Some(mime_type);
            asset.file_name = Some(file_name);
            asset.file_path = Some(path.to_string_lossy().into_owned());
            asset.error = None;
            asset.updated_at = now;
        }
        Ok(VideoPoll::Failed { error }) => {
            asset.status = MediaStatus::Failed;
            asset.error = Some(error);
            asset.updated_at = now;
        }
        Err(error) => return Err(error),
    }
    database.save_media_asset(&asset)?;
    enrich_asset(storage, asset)
}

enum VideoPoll {
    Pending {
        status: MediaStatus,
        progress: Option<u32>,
    },
    Completed {
        bytes: Vec<u8>,
        mime_type: String,
    },
    Failed {
        error: String,
    },
}

fn classify_media_model(model: &str) -> Vec<(MediaKind, i64)> {
    let id = model.to_ascii_lowercase();
    let mut kinds = Vec::new();
    if id.contains("gpt-image")
        || id.contains("dall-e")
        || id.contains("imagen")
        || (id.contains("gemini") && id.contains("image"))
        || id.contains("image-generation")
        || id == "grok-imagine"
        || id == "grok-imagine-edit"
        || id.starts_with("grok-imagine-image")
    {
        kinds.push((MediaKind::Image, image_rank(&id)));
    }
    if !id.contains("transcri")
        && !id.contains("speech-to-text")
        && !id.contains("whisper")
        && (id.contains("tts") || id.contains("text-to-speech") || id.contains("speech-generation"))
    {
        kinds.push((MediaKind::Audio, audio_rank(&id)));
    }
    if id.starts_with("sora")
        || id.starts_with("veo")
        || id.contains("video-generation")
        || id.contains("text-to-video")
        || id.starts_with("grok-imagine-video")
    {
        kinds.push((MediaKind::Video, video_rank(&id)));
    }
    kinds
}

fn image_rank(id: &str) -> i64 {
    let family = if id == "gpt-image-2" || id.ends_with("/gpt-image-2") {
        9_900_000_000
    } else if id.starts_with("gpt-image-2-") {
        9_800_000_000
    } else if id.contains("gpt-image-1.5") {
        9_500_000_000
    } else if id.contains("gpt-image-1") {
        9_000_000_000
    } else if id.contains("gemini-3.1") {
        8_800_000_000
    } else if id.contains("gemini-3") {
        8_600_000_000
    } else if id.contains("imagen-4") {
        8_400_000_000
    } else if id.contains("gemini-2.5") {
        8_200_000_000
    } else if id.contains("imagen-3") {
        8_000_000_000
    } else if id == "grok-imagine" || id == "grok-imagine-edit" {
        7_900_000_000
    } else if id.starts_with("grok-imagine-image-quality") {
        8_100_000_000
    } else if id.starts_with("grok-imagine-image") {
        8_000_000_000
    } else if id.contains("dall-e-3") {
        7_000_000_000
    } else {
        6_000_000_000
    };
    family + numeric_version_score(id)
}

fn audio_rank(id: &str) -> i64 {
    let family = if id.contains("gpt-4o-mini-tts") {
        9_500_000_000
    } else if id.contains("gemini-2.5") && id.contains("tts") {
        9_200_000_000
    } else if id.contains("tts-1-hd") {
        8_500_000_000
    } else if id.contains("tts-1") {
        8_000_000_000
    } else {
        7_000_000_000
    };
    family + numeric_version_score(id)
}

fn video_rank(id: &str) -> i64 {
    let family = if id.contains("sora-2-pro") {
        9_800_000_000
    } else if id == "sora-2" || id.starts_with("sora-2-") {
        9_600_000_000
    } else if id.contains("veo-3.1") {
        9_400_000_000
    } else if id.contains("veo-3") {
        9_200_000_000
    } else if id.contains("veo-2") {
        8_500_000_000
    } else if id.contains("grok-imagine-video-1.5") {
        9_100_000_000
    } else if id.starts_with("grok-imagine-video") {
        8_900_000_000
    } else if id.contains("sora") {
        8_000_000_000
    } else {
        7_000_000_000
    };
    family + numeric_version_score(id)
}

fn numeric_version_score(id: &str) -> i64 {
    let groups = id
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<i64>().ok())
        .collect::<Vec<_>>();
    groups
        .into_iter()
        .rev()
        .take(4)
        .rev()
        .fold(0_i64, |score, part| {
            score.saturating_mul(10_000).saturating_add(part.min(9_999))
        })
        .min(99_999_999)
}

fn media_kind_order(kind: &MediaKind) -> u8 {
    match kind {
        MediaKind::Image => 0,
        MediaKind::Video => 1,
        MediaKind::Audio => 2,
    }
}

fn validate_request(
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<(), String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() || prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("Media prompts must contain 1-32,000 characters".to_owned());
    }
    let maximum = match request.kind {
        MediaKind::Image => 8,
        MediaKind::Video => 4,
        MediaKind::Audio => 4,
    };
    if request.count == 0 || request.count > maximum {
        return Err(format!("This media request supports 1-{maximum} outputs"));
    }
    match request.kind {
        MediaKind::Image => {
            if references
                .iter()
                .any(|reference| reference.kind != AttachmentKind::Image)
            {
                return Err("Image generation accepts image references only".to_owned());
            }
            let total = references
                .iter()
                .map(|item| item.bytes.len())
                .sum::<usize>();
            if references.len() > 8 || total > 32 * 1024 * 1024 {
                return Err("Reference images are limited to 8 files and 32 MiB total".to_owned());
            }
        }
        MediaKind::Audio => {
            if !references.is_empty() {
                return Err("Audio generation does not accept reference attachments".to_owned());
            }
        }
        MediaKind::Video => validate_video_references(request, references)?,
    }
    Ok(())
}

fn validate_video_references(
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<(), String> {
    let total = references
        .iter()
        .map(|reference| reference.bytes.len())
        .sum::<usize>();
    if total > 64 * 1024 * 1024 {
        return Err("Video reference attachments may total at most 64 MiB".to_owned());
    }
    match request.video_mode {
        VideoGenerationMode::Text => {
            if !references.is_empty() {
                return Err(
                    "Text-to-video cannot be combined with reference attachments".to_owned(),
                );
            }
        }
        VideoGenerationMode::Image => {
            if references.len() != 1 || references[0].kind != AttachmentKind::Image {
                return Err("Image-to-video requires exactly one source image".to_owned());
            }
        }
        VideoGenerationMode::Reference => {
            if references.is_empty()
                || references.len() > 7
                || references
                    .iter()
                    .any(|reference| reference.kind != AttachmentKind::Image)
            {
                return Err("Reference-to-video requires between 1 and 7 images".to_owned());
            }
            if request.seconds.is_some_and(|seconds| seconds > 10) {
                return Err(
                    "Reference-to-video supports a maximum duration of 10 seconds".to_owned(),
                );
            }
        }
        VideoGenerationMode::Video => {
            if references.len() != 1 || references[0].kind != AttachmentKind::Video {
                return Err("Video editing requires exactly one MP4 source video".to_owned());
            }
        }
    }
    Ok(())
}

fn validate_model_request(
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<(), String> {
    if request.kind == MediaKind::Image
        && request
            .background
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("transparent"))
        && model.to_ascii_lowercase().contains("gpt-image-2")
    {
        return Err(
            "gpt-image-2 does not support a transparent background. Use background=auto/opaque, or select a transparency-capable image model such as gpt-image-1.5."
                .to_owned(),
        );
    }
    if request.kind == MediaKind::Video {
        let normalized = model.trim_start_matches("models/").to_ascii_lowercase();
        if !is_grok_video_model(model) {
            if request.video_mode != VideoGenerationMode::Text || !references.is_empty() {
                return Err(
                    "Reference images and videos are currently supported only by Grok Imagine video models"
                        .to_owned(),
                );
            }
            return Ok(());
        }
        let is_15 = normalized.contains("grok-imagine-video-1.5");
        if is_15 && request.video_mode != VideoGenerationMode::Image {
            return Err(
                "grok-imagine-video-1.5 currently requires image-to-video mode with one source image"
                    .to_owned(),
            );
        }
        if let Some(resolution) = request
            .video_resolution
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let supported = matches!(resolution.to_ascii_lowercase().as_str(), "480p" | "720p")
                || (is_15 && resolution.eq_ignore_ascii_case("1080p"));
            if !supported {
                return Err(if is_15 {
                    "Grok Imagine Video 1.5 resolution must be 480p, 720p, or 1080p".to_owned()
                } else {
                    "Grok Imagine Video resolution must be 480p or 720p".to_owned()
                });
            }
        }
        if request
            .video_aspect_ratio
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some_and(|ratio| !matches!(ratio, "16:9" | "9:16"))
        {
            return Err("Grok video aspect ratio must be 16:9 or 9:16".to_owned());
        }
    }
    Ok(())
}

pub fn prompt_requests_transparency(prompt: &str) -> bool {
    let normalized = prompt.to_ascii_lowercase();
    [
        "transparent background",
        "transparent png",
        "alpha channel",
        "no background",
        "background removal",
        "remove the background",
        "cutout",
    ]
    .iter()
    .any(|term| normalized.contains(term))
        || [
            "透明背景",
            "背景透明",
            "透明底",
            "无背景",
            "去除背景",
            "移除背景",
            "抠图",
        ]
        .iter()
        .any(|term| prompt.contains(term))
}

#[allow(clippy::too_many_arguments)]
async fn generate_images(
    client: &Client,
    storage: &Path,
    database: &Database,
    selection: &MediaSelection,
    request: &MediaGenerationRequest,
    thread_id: Option<&str>,
    references: &[ManagedReference],
    batch_id: String,
) -> Result<MediaBatchResult, String> {
    let native_gemini = matches!(
        selection.provider.profile.protocol,
        ProviderProtocol::GeminiGenerateContent
    ) && !is_grok_image_model(&selection.model);
    // Some OpenAI-compatible relays expose the Images API but reject `n > 1`
    // when they translate it to an upstream image tool. Fan out single-output
    // requests so "outputs each" works consistently for generations and edits.
    let mut provider_request = request.clone();
    provider_request.count = 1;
    let calls = (0..request.count).map(|_| async {
        if native_gemini {
            call_gemini_image(
                client,
                &selection.provider,
                &selection.model,
                &provider_request,
                references,
            )
            .await
        } else {
            call_openai_images(
                client,
                &selection.provider,
                &selection.model,
                &provider_request,
                references,
            )
            .await
        }
    });
    let results = join_all(calls).await;

    let mut assets = Vec::new();
    let mut errors = Vec::new();
    for result in results {
        match result {
            Ok(blobs) => {
                for blob in blobs {
                    match save_completed_blob(
                        database, storage, selection, request, thread_id, &batch_id, blob,
                    )
                    .await
                    {
                        Ok(asset) => assets.push(asset),
                        Err(error) => errors.push(error),
                    }
                }
            }
            Err(error) => errors.push(error),
        }
    }
    if assets.is_empty() {
        return Err(if errors.is_empty() {
            "The provider returned no usable images".to_owned()
        } else {
            errors.join("; ")
        });
    }
    Ok(MediaBatchResult {
        batch_id,
        assets,
        errors,
    })
}

async fn call_openai_images(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<Vec<GeneratedBlob>, String> {
    let prompt = effective_image_prompt(request);
    let grok = is_grok_image_model(model);
    let result = if references.is_empty() {
        let url = agent::endpoint(&provider.profile.base_url, "/v1/images/generations")?;
        let mut body = json!({
            "model": model,
            "prompt": prompt,
            "n": request.count,
            "response_format": "b64_json"
        });
        if grok {
            insert_grok_image_options(&mut body, request);
        } else {
            insert_optional_string(&mut body, "size", request.size.as_deref());
            insert_optional_string(&mut body, "quality", request.quality.as_deref());
            insert_optional_string(&mut body, "output_format", request.output_format.as_deref());
            insert_optional_string(&mut body, "background", request.background.as_deref());
        }
        send_json(bearer_auth_if_present(client.post(url), provider).json(&body)).await
    } else if grok {
        if references.len() > 3 {
            return Err("Grok image editing supports at most 3 reference images".to_owned());
        }
        let url = agent::endpoint(&provider.profile.base_url, "/v1/images/edits")?;
        let mut body = json!({
            "model": model,
            "prompt": prompt,
            "n": request.count,
            "response_format": "b64_json"
        });
        insert_grok_image_options(&mut body, request);
        let images = references
            .iter()
            .map(|image| {
                json!({
                    "url": format!(
                        "data:{};base64,{}",
                        image.mime_type,
                        base64::engine::general_purpose::STANDARD.encode(&image.bytes)
                    ),
                    "type": "image_url"
                })
            })
            .collect::<Vec<_>>();
        if images.len() == 1 {
            body["image"] = images.into_iter().next().unwrap_or_default();
        } else {
            body["images"] = Value::Array(images);
        }
        send_json(bearer_auth_if_present(client.post(url), provider).json(&body)).await
    } else {
        let url = agent::endpoint(&provider.profile.base_url, "/v1/images/edits")?;
        let mut form = Form::new()
            .text("model", model.to_owned())
            .text("prompt", prompt)
            .text("n", request.count.to_string())
            .text("response_format", "b64_json".to_owned());
        for (name, value) in [
            ("size", request.size.as_deref()),
            ("quality", request.quality.as_deref()),
            ("output_format", request.output_format.as_deref()),
            ("background", request.background.as_deref()),
        ] {
            if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
                form = form.text(name, value.to_owned());
            }
        }
        for image in references {
            let part = Part::bytes(image.bytes.clone())
                .file_name(image.file_name.clone())
                .mime_str(&image.mime_type)
                .map_err(|error| format!("Invalid reference image MIME type: {error}"))?;
            form = form.part("image", part);
        }
        send_json(bearer_auth_if_present(client.post(url), provider).multipart(form)).await
    };

    let value = match result {
        Ok(value) => value,
        Err(primary_error)
            if references.is_empty()
                && (model.to_ascii_lowercase().contains("gemini")
                    || model.to_ascii_lowercase().contains("imagen")) =>
        {
            call_openai_chat_image(client, provider, model, request)
                .await
                .map_err(|fallback_error| {
                    format!(
                        "Image endpoint failed: {primary_error}; chat image fallback failed: {fallback_error}"
                    )
                })?
        }
        Err(error) => return Err(error),
    };
    resolve_image_sources(client, parse_image_sources(&value)?).await
}

async fn call_openai_chat_image(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
) -> Result<Value, String> {
    let url = agent::endpoint(&provider.profile.base_url, "/v1/chat/completions")?;
    let prompt = effective_image_prompt(request);
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "modalities": ["text", "image"],
        "n": request.count
    });
    send_json(bearer_auth_if_present(client.post(url), provider).json(&body)).await
}

async fn call_gemini_image(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<Vec<GeneratedBlob>, String> {
    let model = validate_model_segment(model)?;
    let url = agent::endpoint(
        &provider.profile.base_url,
        &format!("/v1beta/models/{model}:generateContent"),
    )?;
    let mut parts = vec![json!({ "text": effective_image_prompt(request) })];
    parts.extend(references.iter().map(|image| {
        json!({
            "inlineData": {
                "mimeType": image.mime_type,
                "data": base64::engine::general_purpose::STANDARD.encode(&image.bytes)
            }
        })
    }));
    let mut generation_config = json!({ "responseModalities": ["TEXT", "IMAGE"] });
    let mut image_config = serde_json::Map::new();
    if let Some(size) = request.size.as_deref().and_then(gemini_aspect_ratio) {
        image_config.insert("aspectRatio".to_owned(), Value::String(size.to_owned()));
    }
    if let Some(quality) = request.quality.as_deref().and_then(gemini_image_size) {
        image_config.insert("imageSize".to_owned(), Value::String(quality.to_owned()));
    }
    if !image_config.is_empty() {
        generation_config["imageConfig"] = Value::Object(image_config);
    }
    let body = json!({
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": generation_config
    });
    let value = send_json(gemini_auth_if_present(client.post(url), provider).json(&body)).await?;
    resolve_image_sources(client, parse_image_sources(&value)?).await
}

fn parse_image_sources(value: &Value) -> Result<Vec<BlobSource>, String> {
    let mut sources = Vec::new();
    if let Some(data) = value.get("data").and_then(Value::as_array) {
        for item in data {
            push_blob_source(&mut sources, item, None);
        }
    }
    if let Some(output) = value.get("output").and_then(Value::as_array) {
        for item in output {
            if item.get("type").and_then(Value::as_str) == Some("image_generation_call") {
                let result = item.get("result").and_then(Value::as_str);
                if let Some(result) = result {
                    sources.push(BlobSource {
                        base64: Some(result.to_owned()),
                        url: None,
                        mime_type: item
                            .get("mime_type")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        revised_prompt: None,
                    });
                }
            }
        }
    }
    if let Some(candidates) = value.get("candidates").and_then(Value::as_array) {
        for part in candidates
            .iter()
            .filter_map(|item| item.get("content"))
            .filter_map(|item| item.get("parts"))
            .filter_map(Value::as_array)
            .flatten()
        {
            if let Some(data) = part
                .get("inlineData")
                .or_else(|| part.get("inline_data"))
                .and_then(|item| item.get("data"))
                .and_then(Value::as_str)
            {
                sources.push(BlobSource {
                    base64: Some(data.to_owned()),
                    url: None,
                    mime_type: part
                        .get("inlineData")
                        .or_else(|| part.get("inline_data"))
                        .and_then(|item| item.get("mimeType").or_else(|| item.get("mime_type")))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    revised_prompt: None,
                });
            }
        }
    }
    if let Some(choices) = value.get("choices").and_then(Value::as_array) {
        for message in choices.iter().filter_map(|item| item.get("message")) {
            if let Some(images) = message.get("images").and_then(Value::as_array) {
                for image in images {
                    push_blob_source(&mut sources, image, None);
                }
            }
            if let Some(parts) = message.get("content").and_then(Value::as_array) {
                for part in parts {
                    push_blob_source(&mut sources, part, None);
                }
            }
        }
    }
    if sources.is_empty() {
        return Err(provider_message(value)
            .unwrap_or_else(|| "The provider returned no image output".to_owned()));
    }
    Ok(sources)
}

fn push_blob_source(sources: &mut Vec<BlobSource>, value: &Value, revised: Option<&str>) {
    let image_url = value
        .get("image_url")
        .and_then(|item| item.get("url").or(Some(item)))
        .and_then(Value::as_str);
    let base64 = value
        .get("b64_json")
        .or_else(|| value.get("base64"))
        .or_else(|| {
            value
                .get("data")
                .filter(|_| value.get("mime_type").is_some())
        })
        .and_then(Value::as_str);
    let url = value.get("url").and_then(Value::as_str).or(image_url);
    if base64.is_some() || url.is_some() {
        sources.push(BlobSource {
            base64: base64.map(str::to_owned),
            url: url.map(str::to_owned),
            mime_type: value
                .get("mime_type")
                .or_else(|| value.get("mimeType"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            revised_prompt: value
                .get("revised_prompt")
                .and_then(Value::as_str)
                .or(revised)
                .map(str::to_owned),
        });
    }
}

async fn resolve_image_sources(
    client: &Client,
    sources: Vec<BlobSource>,
) -> Result<Vec<GeneratedBlob>, String> {
    let futures = sources.into_iter().map(|source| async move {
        let (bytes, declared_mime) =
            resolve_blob_source(client, source.base64, source.url, MAX_IMAGE_BYTES).await?;
        let mime_type = detect_image_mime(&bytes)
            .or_else(|| source.mime_type.filter(|mime| mime.starts_with("image/")))
            .or(declared_mime.filter(|mime| mime.starts_with("image/")))
            .ok_or_else(|| "The provider returned data that is not a supported image".to_owned())?;
        Ok::<_, String>(GeneratedBlob {
            bytes,
            mime_type,
            revised_prompt: source.revised_prompt,
        })
    });
    let results = join_all(futures).await;
    let mut blobs = Vec::new();
    let mut errors = Vec::new();
    for result in results {
        match result {
            Ok(blob) => blobs.push(blob),
            Err(error) => errors.push(error),
        }
    }
    if blobs.is_empty() {
        Err(errors.join("; "))
    } else {
        Ok(blobs)
    }
}

#[allow(clippy::too_many_arguments)]
async fn generate_audio(
    client: &Client,
    database: &Database,
    storage: &Path,
    selection: &MediaSelection,
    request: &MediaGenerationRequest,
    thread_id: Option<&str>,
    batch_id: String,
) -> Result<MediaBatchResult, String> {
    let calls = (0..request.count).map(|_| async {
        if matches!(
            selection.provider.profile.protocol,
            ProviderProtocol::GeminiGenerateContent
        ) {
            call_gemini_audio(client, &selection.provider, &selection.model, request).await
        } else {
            call_openai_audio(client, &selection.provider, &selection.model, request).await
        }
    });
    let results = join_all(calls).await;
    let mut assets = Vec::new();
    let mut errors = Vec::new();
    for result in results {
        match result {
            Ok(blob) => match save_completed_blob(
                database, storage, selection, request, thread_id, &batch_id, blob,
            )
            .await
            {
                Ok(asset) => assets.push(asset),
                Err(error) => errors.push(error),
            },
            Err(error) => errors.push(error),
        }
    }
    if assets.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(MediaBatchResult {
        batch_id,
        assets,
        errors,
    })
}

async fn call_openai_audio(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
) -> Result<GeneratedBlob, String> {
    let url = agent::endpoint(&provider.profile.base_url, "/v1/audio/speech")?;
    let requested_format = request
        .output_format
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("mp3")
        .to_ascii_lowercase();
    let mut body = json!({
        "model": model,
        "input": request.prompt.trim(),
        "voice": request.voice.as_deref().unwrap_or("alloy"),
        "response_format": requested_format
    });
    insert_optional_string(&mut body, "instructions", request.instructions.as_deref());
    let response = bearer_auth_if_present(client.post(url), provider)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Audio provider connection failed: {error}"))?;
    let status = response.status();
    let mime = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(clean_content_type);
    if !status.is_success() {
        return Err(response_error(response, MAX_JSON_BYTES).await);
    }
    let mut bytes = read_limited_response(response, MAX_AUDIO_BYTES).await?;
    let mut mime_type = mime.unwrap_or_else(|| audio_mime_for_format(&requested_format).to_owned());
    if requested_format == "pcm" || mime_type.to_ascii_lowercase().contains("l16") {
        bytes = pcm16_to_wav(&bytes, 24_000, 1);
        mime_type = "audio/wav".to_owned();
    }
    Ok(GeneratedBlob {
        bytes,
        mime_type,
        revised_prompt: None,
    })
}

async fn call_gemini_audio(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
) -> Result<GeneratedBlob, String> {
    let model = validate_model_segment(model)?;
    let url = agent::endpoint(
        &provider.profile.base_url,
        &format!("/v1beta/models/{model}:generateContent"),
    )?;
    let voice = request.voice.as_deref().unwrap_or("Kore");
    let prompt = match request.instructions.as_deref().map(str::trim) {
        Some(instructions) if !instructions.is_empty() => {
            format!("{instructions}\n\n{}", request.prompt.trim())
        }
        _ => request.prompt.trim().to_owned(),
    };
    let body = json!({
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": { "voiceName": voice }
                }
            }
        }
    });
    let value = send_json(gemini_auth_if_present(client.post(url), provider).json(&body)).await?;
    let inline = value
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("content"))
        .and_then(|item| item.get("parts"))
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find_map(|part| part.get("inlineData").or_else(|| part.get("inline_data")))
        })
        .ok_or_else(|| {
            provider_message(&value)
                .unwrap_or_else(|| "The Gemini provider returned no audio output".to_owned())
        })?;
    let encoded = inline
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "The Gemini audio output has no data".to_owned())?;
    let mut bytes = decode_base64_limited(encoded, MAX_AUDIO_BYTES)?;
    let mut mime_type = inline
        .get("mimeType")
        .or_else(|| inline.get("mime_type"))
        .and_then(Value::as_str)
        .map(clean_content_type)
        .unwrap_or_else(|| "audio/L16".to_owned());
    if mime_type.to_ascii_lowercase().contains("l16")
        || mime_type.to_ascii_lowercase().contains("pcm")
    {
        bytes = pcm16_to_wav(&bytes, 24_000, 1);
        mime_type = "audio/wav".to_owned();
    }
    Ok(GeneratedBlob {
        bytes,
        mime_type,
        revised_prompt: None,
    })
}

async fn generate_videos(
    database: &Database,
    client: &Client,
    selection: &MediaSelection,
    request: &MediaGenerationRequest,
    thread_id: Option<&str>,
    references: &[ManagedReference],
    batch_id: String,
) -> Result<MediaBatchResult, String> {
    let calls = (0..request.count).map(|_| async {
        if matches!(
            selection.provider.profile.protocol,
            ProviderProtocol::GeminiGenerateContent
        ) && is_gemini_video_model(&selection.model)
        {
            create_gemini_video(client, &selection.provider, &selection.model, request).await
        } else if is_grok_video_model(&selection.model) {
            create_grok_video(
                client,
                &selection.provider,
                &selection.model,
                request,
                references,
            )
            .await
        } else {
            create_openai_video(client, &selection.provider, &selection.model, request).await
        }
    });
    let results = join_all(calls).await;
    let now = now_millis();
    let mut assets = Vec::new();
    let mut errors = Vec::new();
    for result in results {
        match result {
            Ok(job) => {
                let asset = MediaAsset {
                    id: uuid::Uuid::new_v4().simple().to_string(),
                    batch_id: batch_id.clone(),
                    thread_id: thread_id.map(str::to_owned),
                    provider_id: selection.provider.profile.id.clone(),
                    provider_name: selection.provider.profile.name.clone(),
                    kind: MediaKind::Video,
                    status: job.status,
                    prompt: request.prompt.trim().to_owned(),
                    model: selection.model.clone(),
                    mime_type: None,
                    file_name: None,
                    file_path: None,
                    remote_id: Some(job.id),
                    revised_prompt: None,
                    error: None,
                    progress: job.progress,
                    size: video_size_label(request),
                    quality: request.quality.clone(),
                    output_format: Some("mp4".to_owned()),
                    voice: None,
                    seconds: request.seconds,
                    created_at: now,
                    updated_at: now,
                };
                database.save_media_asset(&asset)?;
                assets.push(asset);
            }
            Err(error) => errors.push(error),
        }
    }
    if assets.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(MediaBatchResult {
        batch_id,
        assets,
        errors,
    })
}

async fn create_openai_video(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
) -> Result<RemoteVideoJob, String> {
    let url = agent::endpoint(&provider.profile.base_url, "/v1/videos")?;
    let mut form = Form::new()
        .text("model", model.to_owned())
        .text("prompt", request.prompt.trim().to_owned());
    if let Some(size) = request
        .size
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        form = form.text("size", size.to_owned());
    }
    if let Some(seconds) = request.seconds {
        form = form.text("seconds", seconds.to_string());
    }
    let value =
        send_json(bearer_auth_if_present(client.post(url), provider).multipart(form)).await?;
    let id = find_string_by_keys(&value, &["id", "request_id", "requestId"])
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The video provider returned no job ID".to_owned())?;
    let status = parse_video_status(value.get("status").and_then(Value::as_str));
    Ok(RemoteVideoJob {
        id: id.to_owned(),
        status,
        progress: parse_progress(&value),
    })
}

async fn create_grok_video(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<RemoteVideoJob, String> {
    let (path, body) = grok_video_request(model, request, references)?;
    let url = agent::endpoint(&provider.profile.base_url, path)?;
    let value = send_json(bearer_auth_if_present(client.post(url), provider).json(&body)).await?;
    let id = find_string_by_keys(&value, &["id", "request_id", "requestId"])
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The Grok video provider returned no request ID".to_owned())?;
    Ok(RemoteVideoJob {
        id: id.to_owned(),
        status: parse_video_status(value.get("status").and_then(Value::as_str)),
        progress: parse_progress(&value),
    })
}

fn grok_video_request(
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<(&'static str, Value), String> {
    let path = if request.video_mode == VideoGenerationMode::Video {
        "/v1/videos/edits"
    } else {
        "/v1/videos/generations"
    };
    let mut body = json!({
        "model": model,
        "prompt": request.prompt.trim(),
    });
    match request.video_mode {
        VideoGenerationMode::Text => {}
        VideoGenerationMode::Image => {
            let reference = references
                .first()
                .ok_or_else(|| "Image-to-video requires one source image".to_owned())?;
            body["image"] = json!({ "url": reference_data_url(reference) });
        }
        VideoGenerationMode::Reference => {
            body["reference_images"] = Value::Array(
                references
                    .iter()
                    .map(|reference| json!({ "url": reference_data_url(reference) }))
                    .collect(),
            );
        }
        VideoGenerationMode::Video => {
            let reference = references
                .first()
                .ok_or_else(|| "Video editing requires one MP4 source video".to_owned())?;
            body["video"] = json!({ "url": reference_data_url(reference) });
        }
    }
    if request.video_mode != VideoGenerationMode::Video {
        if let Some(aspect_ratio) = request
            .video_aspect_ratio
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| grok_video_aspect_ratio(request.size.as_deref()))
        {
            body["aspect_ratio"] = Value::String(aspect_ratio.to_owned());
        }
        if let Some(resolution) = request
            .video_resolution
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| grok_video_resolution(request.size.as_deref()))
        {
            body["resolution"] = Value::String(resolution.to_ascii_lowercase());
        }
        if let Some(seconds) = request.seconds {
            body["duration"] = Value::from(seconds);
        }
    }
    Ok((path, body))
}

fn reference_data_url(reference: &ManagedReference) -> String {
    format!(
        "data:{};base64,{}",
        reference.mime_type,
        base64::engine::general_purpose::STANDARD.encode(&reference.bytes)
    )
}

async fn create_gemini_video(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
) -> Result<RemoteVideoJob, String> {
    let model = validate_model_segment(model)?;
    let url = agent::endpoint(
        &provider.profile.base_url,
        &format!("/v1beta/models/{model}:predictLongRunning"),
    )?;
    let mut parameters = serde_json::Map::new();
    parameters.insert("sampleCount".to_owned(), Value::from(1));
    if let Some(ratio) = request.size.as_deref().and_then(gemini_video_aspect_ratio) {
        parameters.insert("aspectRatio".to_owned(), Value::String(ratio.to_owned()));
    }
    if let Some(seconds) = request.seconds {
        parameters.insert("durationSeconds".to_owned(), Value::from(seconds));
    }
    let body = json!({
        "instances": [{ "prompt": request.prompt.trim() }],
        "parameters": parameters
    });
    let value = send_json(gemini_auth_if_present(client.post(url), provider).json(&body)).await?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The Gemini video provider returned no operation name".to_owned())?;
    Ok(RemoteVideoJob {
        id: name.to_owned(),
        status: MediaStatus::Queued,
        progress: Some(0),
    })
}

async fn poll_openai_video(
    client: &Client,
    provider: &MediaProvider,
    remote_id: &str,
) -> Result<VideoPoll, String> {
    validate_remote_id(remote_id)?;
    let url = agent::endpoint(
        &provider.profile.base_url,
        &format!("/v1/videos/{remote_id}"),
    )?;
    let value = send_json(bearer_auth_if_present(client.get(url), provider)).await?;
    let status = parse_video_status(value.get("status").and_then(Value::as_str));
    if status == MediaStatus::Failed {
        return Ok(VideoPoll::Failed {
            error: provider_message(&value)
                .unwrap_or_else(|| "Video generation failed at the provider".to_owned()),
        });
    }
    if status != MediaStatus::Completed {
        return Ok(VideoPoll::Pending {
            status,
            progress: parse_progress(&value),
        });
    }
    let url = agent::endpoint(
        &provider.profile.base_url,
        &format!("/v1/videos/{remote_id}/content"),
    )?;
    let response = bearer_auth_if_present(client.get(url), provider)
        .send()
        .await
        .map_err(|error| format!("Video download failed: {error}"))?;
    download_video_response(response).await
}

async fn poll_gemini_video(
    client: &Client,
    provider: &MediaProvider,
    remote_id: &str,
) -> Result<VideoPoll, String> {
    validate_gemini_operation(remote_id)?;
    let operation_path = if remote_id.starts_with("v1beta/") {
        format!("/{remote_id}")
    } else {
        format!("/v1beta/{}", remote_id.trim_start_matches('/'))
    };
    let url = agent::endpoint(&provider.profile.base_url, &operation_path)?;
    let value = send_json(gemini_auth_if_present(client.get(url), provider)).await?;
    if value.get("done").and_then(Value::as_bool) != Some(true) {
        return Ok(VideoPoll::Pending {
            status: MediaStatus::InProgress,
            progress: parse_progress(&value),
        });
    }
    if let Some(error) = value.get("error") {
        return Ok(VideoPoll::Failed {
            error: provider_message(error)
                .unwrap_or_else(|| "Gemini video generation failed".to_owned()),
        });
    }
    let video_uri = find_string_by_keys(&value, &["uri", "videoUri", "video_uri"])
        .filter(|uri| uri.starts_with("https://") || uri.starts_with("http://"))
        .ok_or_else(|| {
            "Gemini completed the video job without a downloadable video URI".to_owned()
        })?;
    let response = gemini_auth_if_present(client.get(video_uri), provider)
        .send()
        .await
        .map_err(|error| format!("Gemini video download failed: {error}"))?;
    download_video_response(response).await
}

async fn download_video_response(response: Response) -> Result<VideoPoll, String> {
    let status = response.status();
    let mime_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(clean_content_type)
        .filter(|value| value.starts_with("video/"))
        .unwrap_or_else(|| "video/mp4".to_owned());
    if !status.is_success() {
        return Err(response_error(response, MAX_JSON_BYTES).await);
    }
    let bytes = read_limited_response(response, MAX_VIDEO_BYTES).await?;
    if bytes.is_empty() {
        return Err("The provider returned an empty video".to_owned());
    }
    Ok(VideoPoll::Completed { bytes, mime_type })
}

async fn save_completed_blob(
    database: &Database,
    storage: &Path,
    selection: &MediaSelection,
    request: &MediaGenerationRequest,
    thread_id: Option<&str>,
    batch_id: &str,
    blob: GeneratedBlob,
) -> Result<MediaAsset, String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let extension = extension_for_mime(&blob.mime_type, request.kind.clone());
    let file_name = format!("{id}.{extension}");
    let path = write_media_file(storage, &file_name, &blob.bytes).await?;
    let now = now_millis();
    let asset = MediaAsset {
        id,
        batch_id: batch_id.to_owned(),
        thread_id: thread_id.map(str::to_owned),
        provider_id: selection.provider.profile.id.clone(),
        provider_name: selection.provider.profile.name.clone(),
        kind: request.kind.clone(),
        status: MediaStatus::Completed,
        prompt: request.prompt.trim().to_owned(),
        model: selection.model.clone(),
        mime_type: Some(blob.mime_type),
        file_name: Some(file_name),
        file_path: Some(path.to_string_lossy().into_owned()),
        remote_id: None,
        revised_prompt: blob.revised_prompt,
        error: None,
        progress: Some(100),
        size: request.size.clone(),
        quality: request.quality.clone(),
        output_format: request.output_format.clone(),
        voice: request.voice.clone(),
        seconds: request.seconds,
        created_at: now,
        updated_at: now,
    };
    if let Err(error) = database.save_media_asset(&asset) {
        let _ = tokio::fs::remove_file(path).await;
        return Err(error);
    }
    Ok(asset)
}

pub fn failed_asset(
    database: &Database,
    request: &MediaGenerationRequest,
    thread_id: Option<&str>,
    provider_id: &str,
    provider_name: &str,
    model: &str,
    error: &str,
) -> Result<MediaBatchResult, String> {
    let now = now_millis();
    let batch_id = uuid::Uuid::new_v4().simple().to_string();
    let asset = MediaAsset {
        id: uuid::Uuid::new_v4().simple().to_string(),
        batch_id: batch_id.clone(),
        thread_id: thread_id.map(str::to_owned),
        provider_id: provider_id.to_owned(),
        provider_name: provider_name.to_owned(),
        kind: request.kind.clone(),
        status: MediaStatus::Failed,
        prompt: request.prompt.trim().to_owned(),
        model: model.to_owned(),
        mime_type: None,
        file_name: None,
        file_path: None,
        remote_id: None,
        revised_prompt: None,
        error: Some(error.to_owned()),
        progress: None,
        size: request.size.clone(),
        quality: request.quality.clone(),
        output_format: request.output_format.clone(),
        voice: request.voice.clone(),
        seconds: request.seconds,
        created_at: now,
        updated_at: now,
    };
    database.save_media_asset(&asset)?;
    Ok(MediaBatchResult {
        batch_id,
        assets: vec![asset],
        errors: vec![error.to_owned()],
    })
}

async fn write_media_file(
    storage: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let destination = safe_media_path(storage, file_name)?;
    tokio::fs::create_dir_all(storage)
        .await
        .map_err(|error| format!("Could not create media storage: {error}"))?;
    crate::filesystem::restrict_directory(storage)?;
    let temporary = storage.join(format!(".{file_name}.tmp"));
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|error| format!("Could not stage media output: {error}"))?;
    crate::filesystem::restrict_file(&temporary)?;
    if let Err(error) = file.write_all(bytes).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(format!("Could not write media output: {error}"));
    }
    if let Err(error) = file.sync_all().await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(format!("Could not finalize media output: {error}"));
    }
    drop(file);
    if let Err(error) = tokio::fs::rename(&temporary, &destination).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(format!("Could not activate media output: {error}"));
    }
    crate::filesystem::restrict_file(&destination)?;
    Ok(destination)
}

fn enrich_asset(storage: &Path, mut asset: MediaAsset) -> Result<MediaAsset, String> {
    asset.file_path = match asset.file_name.as_deref() {
        Some(file_name) => {
            let path = safe_media_path(storage, file_name)?;
            path.is_file().then(|| path.to_string_lossy().into_owned())
        }
        None => None,
    };
    if asset.status == MediaStatus::Completed
        && asset.file_name.is_some()
        && asset.file_path.is_none()
    {
        asset.status = MediaStatus::Failed;
        asset.error = Some("The generated media file is missing".to_owned());
    }
    Ok(asset)
}

fn safe_media_path(storage: &Path, file_name: &str) -> Result<PathBuf, String> {
    if file_name.is_empty()
        || file_name.len() > 200
        || !file_name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        || file_name.starts_with('.')
        || file_name.contains("..")
    {
        return Err("Stored media file name is invalid".to_owned());
    }
    Ok(storage.join(file_name))
}

async fn send_json(builder: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = builder
        .send()
        .await
        .map_err(|error| format!("Media provider connection failed: {error}"))?;
    let status = response.status();
    let bytes = read_limited_response(response, MAX_JSON_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "Media provider request failed ({status}): {}",
            provider_error_detail(&bytes)
        ));
    }
    let value: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).map_err(|_| {
            format!(
                "Media provider returned invalid JSON ({status}): {}",
                clean_error_text(&String::from_utf8_lossy(&bytes))
            )
        })?
    };
    Ok(value)
}

async fn response_error(response: Response, maximum: usize) -> String {
    let status = response.status();
    match read_limited_response(response, maximum).await {
        Ok(bytes) => {
            let detail = provider_error_detail(&bytes);
            format!("Media provider request failed ({status}): {detail}")
        }
        Err(error) => format!("Media provider request failed ({status}): {error}"),
    }
}

fn provider_error_detail(bytes: &[u8]) -> String {
    serde_json::Deserializer::from_slice(bytes)
        .into_iter::<Value>()
        .next()
        .and_then(Result::ok)
        .as_ref()
        .and_then(provider_message)
        .unwrap_or_else(|| {
            let text = clean_error_text(&String::from_utf8_lossy(bytes));
            if text.is_empty() {
                "Unknown provider error".to_owned()
            } else {
                text
            }
        })
}

async fn read_limited_response(response: Response, maximum: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(format!(
            "Provider response exceeds the {} MiB limit",
            maximum / 1024 / 1024
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Could not read provider response: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(format!(
                "Provider response exceeds the {} MiB limit",
                maximum / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn resolve_blob_source(
    client: &Client,
    encoded: Option<String>,
    url: Option<String>,
    maximum: usize,
) -> Result<(Vec<u8>, Option<String>), String> {
    if let Some(encoded) = encoded {
        return Ok((decode_base64_limited(&encoded, maximum)?, None));
    }
    let url = url.ok_or_else(|| "Media output has neither data nor a URL".to_owned())?;
    if let Some((mime, encoded)) = parse_data_url(&url) {
        return Ok((
            decode_base64_limited(encoded, maximum)?,
            Some(mime.to_owned()),
        ));
    }
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| "Provider returned an invalid media URL".to_owned())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("Provider returned a media URL with an unsupported scheme".to_owned());
    }
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("Could not download generated media: {error}"))?;
    let status = response.status();
    let mime = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(clean_content_type);
    if !status.is_success() {
        return Err(response_error(response, MAX_JSON_BYTES).await);
    }
    Ok((read_limited_response(response, maximum).await?, mime))
}

fn parse_data_url(value: &str) -> Option<(&str, &str)> {
    let rest = value.strip_prefix("data:")?;
    let (metadata, data) = rest.split_once(',')?;
    let mime = metadata.strip_suffix(";base64")?;
    Some((mime, data))
}

fn decode_base64_limited(value: &str, maximum: usize) -> Result<Vec<u8>, String> {
    if value.len() > maximum.saturating_mul(4) / 3 + 16 {
        return Err("Base64 media output exceeds the size limit".to_owned());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| "Provider returned invalid base64 media data".to_owned())?;
    if bytes.is_empty() || bytes.len() > maximum {
        return Err("Decoded media output is empty or exceeds the size limit".to_owned());
    }
    Ok(bytes)
}

fn detect_image_mime(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png".to_owned())
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg".to_owned())
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp".to_owned())
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif".to_owned())
    } else {
        None
    }
}

fn extension_for_mime(mime: &str, kind: MediaKind) -> &'static str {
    let mime = clean_content_type(mime).to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/png" => "png",
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        "audio/aac" => "aac",
        "audio/flac" => "flac",
        "audio/ogg" | "audio/opus" => "ogg",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/mp4" => "mp4",
        _ => match kind {
            MediaKind::Image => "png",
            MediaKind::Audio => "mp3",
            MediaKind::Video => "mp4",
        },
    }
}

fn audio_mime_for_format(format: &str) -> &'static str {
    match format {
        "wav" | "pcm" => "audio/wav",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "opus" => "audio/ogg",
        _ => "audio/mpeg",
    }
}

fn pcm16_to_wav(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let data_len = pcm.len().min(u32::MAX as usize - 36) as u32;
    let byte_rate = sample_rate
        .saturating_mul(u32::from(channels))
        .saturating_mul(2);
    let block_align = channels.saturating_mul(2);
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32.saturating_add(data_len)).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(&pcm[..data_len as usize]);
    wav
}

fn insert_optional_string(object: &mut Value, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        object[key] = Value::String(value.to_owned());
    }
}

fn provider_message(value: &Value) -> Option<String> {
    let candidates = [
        value.pointer("/error/message"),
        value.pointer("/error/status"),
        value.get("message"),
        value.get("detail"),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(Value::as_str)
        .map(clean_error_text)
        .filter(|value| !value.is_empty())
}

fn clean_error_text(value: &str) -> String {
    let mut output = String::new();
    let mut inside_tag = false;
    for character in value.chars().take(2_000) {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(character),
            _ => {}
        }
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_content_type(value: &str) -> String {
    value
        .split(';')
        .next()
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase()
}

fn parse_video_status(status: Option<&str>) -> MediaStatus {
    match status.unwrap_or_default().to_ascii_lowercase().as_str() {
        "completed" | "succeeded" | "success" | "done" => MediaStatus::Completed,
        "failed" | "cancelled" | "canceled" | "expired" => MediaStatus::Failed,
        "in_progress" | "processing" | "running" => MediaStatus::InProgress,
        _ => MediaStatus::Queued,
    }
}

fn parse_progress(value: &Value) -> Option<u32> {
    [
        value.get("progress"),
        value.pointer("/metadata/progressPercentage"),
        value.pointer("/metadata/progress_percent"),
    ]
    .into_iter()
    .flatten()
    .find_map(|item| {
        item.as_u64()
            .or_else(|| item.as_f64().map(|v| v.round() as u64))
    })
    .map(|value| value.min(100) as u32)
}

fn find_string_by_keys<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(result) = object.get(*key).and_then(Value::as_str) {
                    return Some(result);
                }
            }
            object
                .values()
                .find_map(|item| find_string_by_keys(item, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| find_string_by_keys(item, keys)),
        _ => None,
    }
}

fn validate_model_segment(model: &str) -> Result<&str, String> {
    let model = model.trim().trim_start_matches("models/");
    if model.is_empty()
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("Media model name is invalid".to_owned());
    }
    Ok(model)
}

fn validate_remote_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 240
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Video job ID is invalid".to_owned());
    }
    Ok(())
}

fn validate_gemini_operation(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 500
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
        })
        || value.contains("..")
    {
        return Err("Gemini video operation name is invalid".to_owned());
    }
    Ok(())
}

fn is_gemini_video_model(model: &str) -> bool {
    model
        .trim_start_matches("models/")
        .to_ascii_lowercase()
        .starts_with("veo")
}

fn is_grok_video_model(model: &str) -> bool {
    model
        .trim_start_matches("models/")
        .to_ascii_lowercase()
        .starts_with("grok-imagine-video")
}

fn is_grok_image_model(model: &str) -> bool {
    let model = model.trim_start_matches("models/").to_ascii_lowercase();
    model == "grok-imagine"
        || model == "grok-imagine-edit"
        || model.starts_with("grok-imagine-image")
}

fn insert_grok_image_options(body: &mut Value, request: &MediaGenerationRequest) {
    if let Some(aspect_ratio) = request.size.as_deref().and_then(grok_image_aspect_ratio) {
        body["aspect_ratio"] = Value::String(aspect_ratio.to_owned());
    }
    if let Some(resolution) =
        grok_image_resolution(request.size.as_deref(), request.quality.as_deref())
    {
        body["resolution"] = Value::String(resolution.to_owned());
    }
}

fn grok_image_aspect_ratio(size: &str) -> Option<&'static str> {
    match size.trim().to_ascii_lowercase().as_str() {
        "1024x1024" | "2048x2048" | "1:1" | "square" => Some("1:1"),
        "1536x1024" | "3:2" | "landscape" => Some("3:2"),
        "1024x1536" | "2:3" | "portrait" => Some("2:3"),
        "2048x1152" | "3840x2160" | "16:9" => Some("16:9"),
        "1152x2048" | "2160x3840" | "9:16" => Some("9:16"),
        _ => None,
    }
}

fn grok_image_resolution(size: Option<&str>, quality: Option<&str>) -> Option<&'static str> {
    if let Some(quality) = quality.map(str::trim).filter(|value| !value.is_empty()) {
        return match quality.to_ascii_lowercase().as_str() {
            "1k" | "low" | "medium" => Some("1k"),
            "2k" | "high" | "4k" => Some("2k"),
            _ => None,
        };
    }
    let size = size?.trim().to_ascii_lowercase();
    match size.as_str() {
        "2048x2048" | "2048x1152" | "1152x2048" | "3840x2160" | "2160x3840" => Some("2k"),
        "1024x1024" | "1536x1024" | "1024x1536" => Some("1k"),
        _ => None,
    }
}

fn grok_video_resolution(size: Option<&str>) -> Option<&'static str> {
    match size?.trim().to_ascii_lowercase().as_str() {
        "480p" => Some("480p"),
        "720p" => Some("720p"),
        "1080p" => Some("1080p"),
        // Media Studio's generic video controls are dimensions/aspect ratios;
        // Grok's gateway accepts a resolution tier and chooses the aspect ratio.
        "854x480" | "480x854" => Some("480p"),
        "1280x720" | "720x1280" | "16:9" | "9:16" => Some("720p"),
        "1920x1080" | "1080x1920" => Some("1080p"),
        _ => None,
    }
}

fn grok_video_aspect_ratio(size: Option<&str>) -> Option<&'static str> {
    match size?.trim().to_ascii_lowercase().as_str() {
        "854x480" | "1280x720" | "1920x1080" | "16:9" => Some("16:9"),
        "480x854" | "720x1280" | "1080x1920" | "9:16" => Some("9:16"),
        _ => None,
    }
}

fn video_size_label(request: &MediaGenerationRequest) -> Option<String> {
    match (
        request
            .video_resolution
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        request
            .video_aspect_ratio
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        (Some(resolution), Some(ratio)) => Some(format!("{resolution} · {ratio}")),
        (Some(resolution), None) => Some(resolution.to_owned()),
        (None, Some(ratio)) => Some(ratio.to_owned()),
        (None, None) => request.size.clone(),
    }
}

fn effective_image_prompt(request: &MediaGenerationRequest) -> String {
    let prompt = request.prompt.trim();
    let Some(requirement) = request.size.as_deref().and_then(image_output_requirement) else {
        return prompt.to_owned();
    };
    format!(
        "{prompt}\n\n[Image output requirement: {requirement}. Treat this as a hard composition constraint. Fill the canvas edge to edge without letterboxing, blank margins, or decorative borders.]"
    )
}

fn image_output_requirement(size: &str) -> Option<&'static str> {
    match size.trim().to_ascii_lowercase().as_str() {
        "1024x1024" | "1:1" | "square" => {
            Some("render at 1024x1024 pixels with a 1:1 aspect ratio")
        }
        "1536x1024" | "3:2" | "landscape" => {
            Some("render at 1536x1024 pixels with a 3:2 landscape aspect ratio")
        }
        "1024x1536" | "2:3" | "portrait" => {
            Some("render at 1024x1536 pixels with a 2:3 portrait aspect ratio")
        }
        "2048x2048" => Some("render at 2048x2048 pixels with a 1:1 aspect ratio"),
        "2048x1152" => Some("render at 2048x1152 pixels with a 16:9 landscape aspect ratio"),
        "1152x2048" => Some("render at 1152x2048 pixels with a 9:16 portrait aspect ratio"),
        "3840x2160" => Some("render at 3840x2160 pixels with a 16:9 landscape aspect ratio"),
        "2160x3840" => Some("render at 2160x3840 pixels with a 9:16 portrait aspect ratio"),
        "16:9" => Some("use an exact 16:9 widescreen aspect ratio"),
        "9:16" => Some("use an exact 9:16 portrait aspect ratio"),
        "21:9" => Some("use an exact 21:9 ultrawide aspect ratio"),
        "9:21" => Some("use an exact 9:21 ultra-tall portrait aspect ratio"),
        _ => None,
    }
}

fn gemini_aspect_ratio(size: &str) -> Option<&'static str> {
    match size.trim().to_ascii_lowercase().as_str() {
        "1024x1024" | "1:1" | "square" => Some("1:1"),
        "1536x1024" | "3:2" | "landscape" => Some("3:2"),
        "1024x1536" | "2:3" | "portrait" => Some("2:3"),
        "2048x2048" => Some("1:1"),
        "2048x1152" | "3840x2160" | "16:9" => Some("16:9"),
        "1152x2048" | "2160x3840" | "9:16" => Some("9:16"),
        "21:9" => Some("21:9"),
        "9:21" => Some("9:21"),
        _ => None,
    }
}

fn gemini_video_aspect_ratio(size: &str) -> Option<&'static str> {
    match size.trim().to_ascii_lowercase().as_str() {
        "1280x720" | "1920x1080" | "16:9" | "landscape" => Some("16:9"),
        "720x1280" | "1080x1920" | "9:16" | "portrait" => Some("9:16"),
        _ => None,
    }
}

fn gemini_image_size(quality: &str) -> Option<&'static str> {
    match quality.trim().to_ascii_lowercase().as_str() {
        "1k" | "standard" | "low" | "medium" => Some("1K"),
        "2k" | "high" => Some("2K"),
        "4k" | "ultra" => Some("4K"),
        _ => None,
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn provider(id: &str, model: &str) -> MediaProvider {
        MediaProvider {
            profile: ProviderProfile {
                id: id.to_owned(),
                name: id.to_owned(),
                base_url: "https://example.test".to_owned(),
                model: model.to_owned(),
                protocol: ProviderProtocol::OpenaiChat,
                allow_unauthenticated: false,
                priority: 100,
                failover_enabled: true,
            },
            api_key: "secret".to_owned(),
        }
    }

    struct MockResponse {
        method: &'static str,
        path: &'static str,
        status: u16,
        content_type: &'static str,
        body: Vec<u8>,
    }

    fn mock_sequence(responses: Vec<MockResponse>) -> (String, thread::JoinHandle<()>) {
        mock_sequence_inspecting(responses, |_, _| {})
    }

    fn mock_sequence_inspecting<F>(
        responses: Vec<MockResponse>,
        inspect: F,
    ) -> (String, thread::JoinHandle<()>)
    where
        F: Fn(usize, &[u8]) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for (index, response) in responses.into_iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                let mut expected_size = None;
                loop {
                    let size = stream.read(&mut buffer).unwrap();
                    if size == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..size]);
                    if expected_size.is_none()
                        && let Some(header_end) =
                            request.windows(4).position(|part| part == b"\r\n\r\n")
                    {
                        let headers = String::from_utf8_lossy(&request[..header_end]);
                        let content_length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or_default();
                        expected_size = Some(header_end + 4 + content_length);
                    }
                    if expected_size.is_some_and(|size| request.len() >= size) {
                        break;
                    }
                }
                let first_line = String::from_utf8_lossy(&request)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                assert!(
                    first_line.starts_with(&format!("{} {} ", response.method, response.path)),
                    "unexpected request: {first_line}"
                );
                inspect(index, &request);
                let reason = if response.status < 300 { "OK" } else { "Error" };
                let headers = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status,
                    reason,
                    response.content_type,
                    response.body.len()
                );
                stream.write_all(headers.as_bytes()).unwrap();
                stream.write_all(&response.body).unwrap();
            }
        });
        (format!("http://{address}"), handle)
    }

    fn request(kind: MediaKind, count: u32) -> MediaGenerationRequest {
        MediaGenerationRequest {
            profile_id: Some("primary".to_owned()),
            kind,
            model: None,
            prompt: "A useful test output".to_owned(),
            count,
            size: None,
            quality: None,
            output_format: None,
            background: None,
            voice: None,
            instructions: None,
            seconds: Some(4),
            video_mode: VideoGenerationMode::Text,
            video_resolution: None,
            video_aspect_ratio: None,
            reference_attachment_ids: Vec::new(),
        }
    }

    fn temp_storage(name: &str) -> (PathBuf, Database) {
        let root = std::env::temp_dir().join(format!(
            "levelup-media-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let database = Database::open(&root.join("test.sqlite3")).unwrap();
        (root, database)
    }

    #[test]
    fn classifies_and_ranks_current_generation_models() {
        assert_eq!(classify_media_model("gpt-image-2")[0].0, MediaKind::Image);
        assert!(image_rank("gpt-image-2") > image_rank("gpt-image-1.5"));
        assert!(image_rank("gemini-3.1-flash-image") > image_rank("gemini-2.5-flash-image"));
        assert_eq!(
            classify_media_model("imagen-4.0-generate-001")[0].0,
            MediaKind::Image
        );
        assert_eq!(classify_media_model("grok-imagine")[0].0, MediaKind::Image);
        assert_eq!(
            classify_media_model("grok-imagine-image-quality")[0].0,
            MediaKind::Image
        );
        assert_eq!(
            classify_media_model("grok-imagine-edit")[0].0,
            MediaKind::Image
        );
        assert_eq!(
            classify_media_model("gpt-4o-mini-tts")[0].0,
            MediaKind::Audio
        );
        assert_eq!(
            classify_media_model("gemini-2.5-flash-preview-tts")[0].0,
            MediaKind::Audio
        );
        assert!(classify_media_model("whisper-1").is_empty());
        assert!(video_rank("sora-2-pro") > video_rank("sora-2"));
        assert_eq!(
            classify_media_model("veo-3.1-generate-preview")[0].0,
            MediaKind::Video
        );
        assert_eq!(
            classify_media_model("grok-imagine-video-1.5")[0].0,
            MediaKind::Video
        );
        assert!(video_rank("veo-3.1-generate-preview") > video_rank("veo-3.0-generate-preview"));
    }

    #[test]
    fn catalog_selection_prefers_recommended_model_and_honors_explicit_choice() {
        let providers = vec![
            provider("primary", "text-model"),
            provider("backup", "text-model"),
        ];
        let catalog = MediaCatalog {
            models: vec![
                MediaModelInfo {
                    id: "gpt-image-2".to_owned(),
                    profile_id: "primary".to_owned(),
                    profile_name: "primary".to_owned(),
                    kind: MediaKind::Image,
                    rank: 100,
                    recommended: true,
                },
                MediaModelInfo {
                    id: "gpt-image-1.5".to_owned(),
                    profile_id: "backup".to_owned(),
                    profile_name: "backup".to_owned(),
                    kind: MediaKind::Image,
                    rank: 90,
                    recommended: false,
                },
            ],
            errors: Vec::new(),
        };
        let mut request = MediaGenerationRequest {
            profile_id: None,
            kind: MediaKind::Image,
            model: None,
            prompt: "test".to_owned(),
            count: 1,
            size: None,
            quality: None,
            output_format: None,
            background: None,
            voice: None,
            instructions: None,
            seconds: None,
            video_mode: VideoGenerationMode::Text,
            video_resolution: None,
            video_aspect_ratio: None,
            reference_attachment_ids: Vec::new(),
        };
        let selected = selection_candidates(&providers, &catalog, &request);
        assert_eq!(selected[0].model, "gpt-image-2");
        request.profile_id = Some("backup".to_owned());
        request.model = Some("gpt-image-1.5".to_owned());
        let selected = selection_candidates(&providers, &catalog, &request);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].provider.profile.id, "backup");
    }

    #[test]
    fn normalizes_openai_and_gemini_image_payloads() {
        let openai = json!({"data": [{"b64_json": "aGVsbG8=", "revised_prompt": "better"}]});
        let parsed = parse_image_sources(&openai).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].revised_prompt.as_deref(), Some("better"));
        let gemini = json!({"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": "aGVsbG8="}}]}}]});
        let parsed = parse_image_sources(&gemini).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].mime_type.as_deref(), Some("image/png"));
        let mixed = b"{\"error\":{\"message\":\"Upstream request failed\"}}event: error\ndata: {\"error\":{\"message\":\"Upstream request failed\"}}";
        assert_eq!(provider_error_detail(mixed), "Upstream request failed");
    }

    #[test]
    fn transparency_intent_and_gpt_image_2_compatibility_are_enforced_locally() {
        assert!(!prompt_requests_transparency("一只可爱的像素小猫"));
        assert!(prompt_requests_transparency(
            "一只可爱的像素小猫，透明背景 PNG"
        ));
        let mut request = request(MediaKind::Image, 1);
        request.background = Some("transparent".to_owned());
        assert!(validate_model_request("gpt-image-2", &request, &[]).is_err());
        assert!(validate_model_request("gpt-image-1.5", &request, &[]).is_ok());
    }

    #[test]
    fn reinforces_image_dimensions_in_provider_prompts_and_native_config() {
        let mut request = request(MediaKind::Image, 1);
        request.prompt = "A cinematic city".to_owned();
        request.size = Some("21:9".to_owned());
        let prompt = effective_image_prompt(&request);
        assert!(prompt.starts_with("A cinematic city"));
        assert!(prompt.contains("exact 21:9 ultrawide aspect ratio"));
        assert_eq!(gemini_aspect_ratio("21:9"), Some("21:9"));
        assert_eq!(gemini_aspect_ratio("9:21"), Some("9:21"));

        request.size = Some("1024x1536".to_owned());
        assert!(effective_image_prompt(&request).contains("1024x1536 pixels"));
        request.size = Some("2048x1152".to_owned());
        assert!(effective_image_prompt(&request).contains("2048x1152 pixels"));
        assert_eq!(gemini_aspect_ratio("2048x1152"), Some("16:9"));
        assert_eq!(gemini_aspect_ratio("1152x2048"), Some("9:16"));
        assert_eq!(gemini_aspect_ratio("2048x2048"), Some("1:1"));
        assert_eq!(gemini_aspect_ratio("3840x2160"), Some("16:9"));
        assert_eq!(gemini_aspect_ratio("2160x3840"), Some("9:16"));
        assert_eq!(grok_image_aspect_ratio("2048x1152"), Some("16:9"));
        assert_eq!(grok_image_aspect_ratio("21:9"), None);
        assert_eq!(grok_image_resolution(Some("2048x1152"), None), Some("2k"));
        assert_eq!(
            grok_image_resolution(Some("1024x1024"), Some("high")),
            Some("2k")
        );
        assert_eq!(grok_video_aspect_ratio(Some("720x1280")), Some("9:16"));
        assert_eq!(grok_video_resolution(Some("720x1280")), Some("720p"));
        request.size = Some("auto".to_owned());
        assert_eq!(effective_image_prompt(&request), "A cinematic city");
        request.size = None;
        assert_eq!(effective_image_prompt(&request), "A cinematic city");
    }

    #[test]
    fn builds_grok_video_payloads_for_each_supported_reference_mode() {
        let image = ManagedReference {
            file_name: "reference.png".to_owned(),
            mime_type: "image/png".to_owned(),
            bytes: b"\x89PNG\r\n\x1a\nreference".to_vec(),
            kind: AttachmentKind::Image,
        };
        let mut request = request(MediaKind::Video, 1);
        request.video_mode = VideoGenerationMode::Image;
        request.video_resolution = Some("1080p".to_owned());
        request.video_aspect_ratio = Some("9:16".to_owned());
        request.seconds = Some(12);
        assert!(
            validate_model_request(
                "grok-imagine-video-1.5",
                &request,
                std::slice::from_ref(&image),
            )
            .is_ok()
        );
        let (path, body) = grok_video_request(
            "grok-imagine-video-1.5",
            &request,
            std::slice::from_ref(&image),
        )
        .unwrap();
        assert_eq!(path, "/v1/videos/generations");
        assert!(
            body.pointer("/image/url")
                .and_then(Value::as_str)
                .is_some_and(|value| value.starts_with("data:image/png;base64,"))
        );
        assert_eq!(
            body.get("resolution").and_then(Value::as_str),
            Some("1080p")
        );
        assert_eq!(
            body.get("aspect_ratio").and_then(Value::as_str),
            Some("9:16")
        );

        request.video_mode = VideoGenerationMode::Reference;
        request.video_resolution = Some("720p".to_owned());
        request.seconds = Some(10);
        let references = vec![image.clone(), image.clone()];
        assert!(validate_model_request("grok-imagine-video", &request, &references).is_ok());
        let (_, body) = grok_video_request("grok-imagine-video", &request, &references).unwrap();
        assert_eq!(
            body.get("reference_images")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        assert!(body.get("image").is_none());

        let video = ManagedReference {
            file_name: "source.mp4".to_owned(),
            mime_type: "video/mp4".to_owned(),
            bytes: b"\0\0\0\x18ftypisom".to_vec(),
            kind: AttachmentKind::Video,
        };
        request.video_mode = VideoGenerationMode::Video;
        request.seconds = Some(8);
        let (path, body) =
            grok_video_request("grok-imagine-video", &request, std::slice::from_ref(&video))
                .unwrap();
        assert_eq!(path, "/v1/videos/edits");
        assert!(
            body.pointer("/video/url")
                .and_then(Value::as_str)
                .is_some_and(|value| value.starts_with("data:video/mp4;base64,"))
        );
        assert!(body.get("duration").is_none());
        assert!(body.get("resolution").is_none());
        assert!(body.get("aspect_ratio").is_none());

        request.video_mode = VideoGenerationMode::Text;
        assert!(validate_model_request("grok-imagine-video-1.5", &request, &[]).is_err());
    }

    #[test]
    fn wraps_pcm_as_browser_playable_wav() {
        let wav = pcm16_to_wav(&[0, 0, 1, 0], 24_000, 1);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 48);
    }

    #[tokio::test]
    async fn generates_and_persists_an_openai_image() {
        let png = b"\x89PNG\r\n\x1a\nmock-image";
        let encoded = base64::engine::general_purpose::STANDARD.encode(png);
        let body = json!({ "data": [{ "b64_json": encoded, "revised_prompt": "Refined" }] })
            .to_string()
            .into_bytes();
        let (base_url, server) = mock_sequence(vec![MockResponse {
            method: "POST",
            path: "/v1/images/generations",
            status: 200,
            content_type: "application/json",
            body,
        }]);
        let mut provider = provider("primary", "gpt-image-2");
        provider.profile.base_url = base_url;
        let selection = MediaSelection {
            provider,
            model: "gpt-image-2".to_owned(),
        };
        let (root, database) = temp_storage("image");
        let storage = root.join("media");
        let result = generate_batch(
            &Client::new(),
            &storage,
            &database,
            &selection,
            &request(MediaKind::Image, 1),
            Some("thread-1"),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(result.assets.len(), 1);
        assert_eq!(result.assets[0].status, MediaStatus::Completed);
        assert_eq!(result.assets[0].revised_prompt.as_deref(), Some("Refined"));
        assert!(Path::new(result.assets[0].file_path.as_deref().unwrap()).is_file());
        assert_eq!(database.list_media_assets(10).unwrap().len(), 1);
        let exported = root.join("exported.png");
        export_asset(&database, &storage, &result.assets[0].id, &exported)
            .await
            .unwrap();
        assert_eq!(std::fs::read(exported).unwrap(), png);
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn generates_and_persists_a_grok_image_with_native_options() {
        let png = b"\x89PNG\r\n\x1a\nmock-grok-image";
        let encoded = base64::engine::general_purpose::STANDARD.encode(png);
        let body = json!({ "data": [{ "b64_json": encoded }] })
            .to_string()
            .into_bytes();
        let (base_url, server) = mock_sequence_inspecting(
            vec![MockResponse {
                method: "POST",
                path: "/v1/images/generations",
                status: 200,
                content_type: "application/json",
                body,
            }],
            |_, request| {
                let request = String::from_utf8_lossy(request);
                let body = request.split_once("\r\n\r\n").unwrap().1;
                let value: Value = serde_json::from_str(body).unwrap();
                assert_eq!(
                    value.get("model").and_then(Value::as_str),
                    Some("grok-imagine-image-quality")
                );
                assert_eq!(
                    value.get("aspect_ratio").and_then(Value::as_str),
                    Some("16:9")
                );
                assert_eq!(value.get("resolution").and_then(Value::as_str), Some("2k"));
                assert_eq!(
                    value.get("response_format").and_then(Value::as_str),
                    Some("b64_json")
                );
                assert!(value.get("size").is_none());
                assert!(value.get("quality").is_none());
            },
        );
        let mut provider = provider("grok", "grok-imagine-image-quality");
        provider.profile.base_url = base_url;
        let selection = MediaSelection {
            provider,
            model: "grok-imagine-image-quality".to_owned(),
        };
        let (root, database) = temp_storage("grok-image");
        let storage = root.join("media");
        let mut request = request(MediaKind::Image, 1);
        request.size = Some("2048x1152".to_owned());
        let result = generate_batch(
            &Client::new(),
            &storage,
            &database,
            &selection,
            &request,
            Some("thread-grok-image"),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(result.assets.len(), 1);
        assert_eq!(
            std::fs::read(result.assets[0].file_path.as_deref().unwrap()).unwrap(),
            png
        );
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn splits_multiple_openai_generations_into_single_output_requests() {
        let first =
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nmock-image-one");
        let second =
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nmock-image-two");
        let responses = [first, second]
            .into_iter()
            .map(|encoded| MockResponse {
                method: "POST",
                path: "/v1/images/generations",
                status: 200,
                content_type: "application/json",
                body: json!({ "data": [{ "b64_json": encoded }] })
                    .to_string()
                    .into_bytes(),
            })
            .collect();
        let (base_url, server) = mock_sequence_inspecting(responses, |_, request| {
            let request = String::from_utf8_lossy(request);
            let body = request.split_once("\r\n\r\n").unwrap().1;
            let value: Value = serde_json::from_str(body).unwrap();
            assert_eq!(value.get("n").and_then(Value::as_u64), Some(1));
        });
        let mut provider = provider("primary", "gpt-image-2");
        provider.profile.base_url = base_url;
        let selection = MediaSelection {
            provider,
            model: "gpt-image-2".to_owned(),
        };
        let (root, database) = temp_storage("openai-image-multiple");
        let result = generate_batch(
            &Client::new(),
            &root.join("media"),
            &database,
            &selection,
            &request(MediaKind::Image, 2),
            None,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(result.assets.len(), 2);
        assert!(result.errors.is_empty());
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn splits_multiple_openai_edits_into_single_output_requests() {
        let first =
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nmock-edit-one");
        let second =
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nmock-edit-two");
        let responses = [first, second]
            .into_iter()
            .map(|encoded| MockResponse {
                method: "POST",
                path: "/v1/images/edits",
                status: 200,
                content_type: "application/json",
                body: json!({ "data": [{ "b64_json": encoded }] })
                    .to_string()
                    .into_bytes(),
            })
            .collect();
        let (base_url, server) = mock_sequence_inspecting(responses, |_, request| {
            let request = String::from_utf8_lossy(request);
            assert!(request.contains("name=\"n\"\r\n\r\n1\r\n"));
            assert!(!request.contains("name=\"n\"\r\n\r\n2\r\n"));
        });
        let mut provider = provider("primary", "gpt-image-2");
        provider.profile.base_url = base_url;
        let selection = MediaSelection {
            provider,
            model: "gpt-image-2".to_owned(),
        };
        let references = vec![ManagedReference {
            file_name: "reference.png".to_owned(),
            mime_type: "image/png".to_owned(),
            bytes: b"\x89PNG\r\n\x1a\nmock-reference".to_vec(),
            kind: AttachmentKind::Image,
        }];
        let (root, database) = temp_storage("openai-edit-multiple");
        let result = generate_batch(
            &Client::new(),
            &root.join("media"),
            &database,
            &selection,
            &request(MediaKind::Image, 2),
            None,
            &references,
        )
        .await
        .unwrap();

        assert_eq!(result.assets.len(), 2);
        assert!(result.errors.is_empty());
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn generates_and_persists_a_native_gemini_image() {
        let png = b"\x89PNG\r\n\x1a\nmock-gemini-image";
        let encoded = base64::engine::general_purpose::STANDARD.encode(png);
        let body = json!({
            "candidates": [{
                "content": { "parts": [{
                    "inlineData": { "mimeType": "image/png", "data": encoded }
                }]}
            }]
        })
        .to_string()
        .into_bytes();
        let (base_url, server) = mock_sequence(vec![MockResponse {
            method: "POST",
            path: "/v1beta/models/gemini-3.1-flash-image:generateContent",
            status: 200,
            content_type: "application/json",
            body,
        }]);
        let mut provider = provider("gemini", "gemini-3.1-flash-image");
        provider.profile.base_url = base_url;
        provider.profile.protocol = ProviderProtocol::GeminiGenerateContent;
        let selection = MediaSelection {
            provider,
            model: "gemini-3.1-flash-image".to_owned(),
        };
        let (root, database) = temp_storage("gemini-image");
        let storage = root.join("media");
        let result = generate_batch(
            &Client::new(),
            &storage,
            &database,
            &selection,
            &request(MediaKind::Image, 1),
            None,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(result.assets.len(), 1);
        assert_eq!(result.assets[0].status, MediaStatus::Completed);
        assert_eq!(
            std::fs::read(result.assets[0].file_path.as_deref().unwrap()).unwrap(),
            png
        );
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn preserves_partial_success_in_parallel_audio_generation() {
        let (base_url, server) = mock_sequence(vec![
            MockResponse {
                method: "POST",
                path: "/v1/audio/speech",
                status: 200,
                content_type: "audio/mpeg",
                body: b"ID3mock-audio".to_vec(),
            },
            MockResponse {
                method: "POST",
                path: "/v1/audio/speech",
                status: 500,
                content_type: "application/json",
                body: br#"{"error":{"message":"one output failed"}}"#.to_vec(),
            },
        ]);
        let mut provider = provider("primary", "gpt-4o-mini-tts");
        provider.profile.base_url = base_url;
        let selection = MediaSelection {
            provider,
            model: "gpt-4o-mini-tts".to_owned(),
        };
        let (root, database) = temp_storage("audio-partial");
        let result = generate_batch(
            &Client::new(),
            &root.join("media"),
            &database,
            &selection,
            &request(MediaKind::Audio, 2),
            None,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(result.assets.len(), 1);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.assets[0].mime_type.as_deref(), Some("audio/mpeg"));
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn generates_native_gemini_speech_as_browser_playable_wav() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([0_u8, 0, 1, 0]);
        let body = json!({
            "candidates": [{
                "content": { "parts": [{
                    "inlineData": { "mimeType": "audio/L16;rate=24000", "data": encoded }
                }]}
            }]
        })
        .to_string()
        .into_bytes();
        let (base_url, server) = mock_sequence(vec![MockResponse {
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
            status: 200,
            content_type: "application/json",
            body,
        }]);
        let mut provider = provider("gemini", "gemini-2.5-flash-preview-tts");
        provider.profile.base_url = base_url;
        provider.profile.protocol = ProviderProtocol::GeminiGenerateContent;
        let selection = MediaSelection {
            provider,
            model: "gemini-2.5-flash-preview-tts".to_owned(),
        };
        let (root, database) = temp_storage("gemini-speech");
        let result = generate_batch(
            &Client::new(),
            &root.join("media"),
            &database,
            &selection,
            &request(MediaKind::Audio, 1),
            None,
            &[],
        )
        .await
        .unwrap();
        let asset = &result.assets[0];
        assert_eq!(asset.mime_type.as_deref(), Some("audio/wav"));
        let wav = std::fs::read(asset.file_path.as_deref().unwrap()).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn moves_video_job_from_queued_to_downloaded_completion() {
        let (base_url, server) = mock_sequence(vec![
            MockResponse {
                method: "POST",
                path: "/v1/videos",
                status: 200,
                content_type: "application/json",
                body: br#"{"id":"video_test","status":"queued","progress":0}"#.to_vec(),
            },
            MockResponse {
                method: "GET",
                path: "/v1/videos/video_test",
                status: 200,
                content_type: "application/json",
                body: br#"{"id":"video_test","status":"completed","progress":100}"#.to_vec(),
            },
            MockResponse {
                method: "GET",
                path: "/v1/videos/video_test/content",
                status: 200,
                content_type: "video/mp4",
                body: b"mock-mp4-content".to_vec(),
            },
        ]);
        let mut provider = provider("primary", "sora-2");
        provider.profile.base_url = base_url;
        let selection = MediaSelection {
            provider: provider.clone(),
            model: "sora-2".to_owned(),
        };
        let (root, database) = temp_storage("video");
        let storage = root.join("media");
        let created = generate_batch(
            &Client::new(),
            &storage,
            &database,
            &selection,
            &request(MediaKind::Video, 1),
            Some("thread-1"),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(created.assets[0].status, MediaStatus::Queued);
        let completed = refresh_asset(
            &Client::new(),
            &storage,
            &database,
            &provider,
            created.assets[0].clone(),
        )
        .await
        .unwrap();
        assert_eq!(completed.status, MediaStatus::Completed);
        assert_eq!(completed.progress, Some(100));
        assert!(Path::new(completed.file_path.as_deref().unwrap()).is_file());
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn moves_grok_video_job_from_request_id_to_downloaded_completion() {
        let (base_url, server) = mock_sequence_inspecting(
            vec![
                MockResponse {
                    method: "POST",
                    path: "/v1/videos/generations",
                    status: 200,
                    content_type: "application/json",
                    body: br#"{"request_id":"grok_video_test","status":"queued","progress":0}"#
                        .to_vec(),
                },
                MockResponse {
                    method: "GET",
                    path: "/v1/videos/grok_video_test",
                    status: 200,
                    content_type: "application/json",
                    body:
                        br#"{"request_id":"grok_video_test","status":"completed","progress":100}"#
                            .to_vec(),
                },
                MockResponse {
                    method: "GET",
                    path: "/v1/videos/grok_video_test/content",
                    status: 200,
                    content_type: "video/mp4",
                    body: b"mock-grok-mp4-content".to_vec(),
                },
            ],
            |index, request| {
                if index == 0 {
                    let request = String::from_utf8_lossy(request);
                    let body = request.split_once("\r\n\r\n").unwrap().1;
                    let value: Value = serde_json::from_str(body).unwrap();
                    assert_eq!(
                        value.get("resolution").and_then(Value::as_str),
                        Some("720p")
                    );
                    assert_eq!(
                        value.get("aspect_ratio").and_then(Value::as_str),
                        Some("16:9")
                    );
                    assert_eq!(value.get("duration").and_then(Value::as_u64), Some(8));
                }
            },
        );
        let mut provider = provider("grok", "grok-imagine-video");
        provider.profile.base_url = base_url;
        let selection = MediaSelection {
            provider: provider.clone(),
            model: "grok-imagine-video".to_owned(),
        };
        let (root, database) = temp_storage("grok-video");
        let storage = root.join("media");
        let mut request = request(MediaKind::Video, 1);
        request.size = Some("1280x720".to_owned());
        request.seconds = Some(8);
        let created = generate_batch(
            &Client::new(),
            &storage,
            &database,
            &selection,
            &request,
            Some("thread-grok-video"),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(created.assets[0].status, MediaStatus::Queued);
        let completed = refresh_asset(
            &Client::new(),
            &storage,
            &database,
            &provider,
            created.assets[0].clone(),
        )
        .await
        .unwrap();
        assert_eq!(completed.status, MediaStatus::Completed);
        assert!(Path::new(completed.file_path.as_deref().unwrap()).is_file());
        server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn moves_native_veo_job_from_operation_to_downloaded_completion() {
        let (download_base, download_server) = mock_sequence(vec![MockResponse {
            method: "GET",
            path: "/video.mp4",
            status: 200,
            content_type: "video/mp4",
            body: b"mock-veo-content".to_vec(),
        }]);
        let completed = json!({
            "done": true,
            "response": {
                "generateVideoResponse": {
                    "generatedSamples": [{
                        "video": { "uri": format!("{download_base}/video.mp4") }
                    }]
                }
            }
        })
        .to_string()
        .into_bytes();
        let (base_url, server) = mock_sequence(vec![
            MockResponse {
                method: "POST",
                path: "/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
                status: 200,
                content_type: "application/json",
                body: br#"{"name":"operations/veo-test"}"#.to_vec(),
            },
            MockResponse {
                method: "GET",
                path: "/v1beta/operations/veo-test",
                status: 200,
                content_type: "application/json",
                body: completed,
            },
        ]);
        let mut provider = provider("gemini", "veo-3.1-generate-preview");
        provider.profile.base_url = base_url;
        provider.profile.protocol = ProviderProtocol::GeminiGenerateContent;
        let selection = MediaSelection {
            provider: provider.clone(),
            model: "veo-3.1-generate-preview".to_owned(),
        };
        let (root, database) = temp_storage("veo-video");
        let storage = root.join("media");
        let created = generate_batch(
            &Client::new(),
            &storage,
            &database,
            &selection,
            &request(MediaKind::Video, 1),
            None,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(created.assets[0].status, MediaStatus::Queued);
        assert_eq!(
            created.assets[0].remote_id.as_deref(),
            Some("operations/veo-test")
        );
        let completed = refresh_asset(
            &Client::new(),
            &storage,
            &database,
            &provider,
            created.assets[0].clone(),
        )
        .await
        .unwrap();
        assert_eq!(completed.status, MediaStatus::Completed);
        assert_eq!(
            std::fs::read(completed.file_path.as_deref().unwrap()).unwrap(),
            b"mock-veo-content"
        );
        server.join().unwrap();
        download_server.join().unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }
}
