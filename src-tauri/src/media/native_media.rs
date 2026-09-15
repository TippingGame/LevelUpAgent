//! MiniMax's native media protocol and the common Seedance video relay contract.
use super::*;

pub(super) fn is_minimax_image_model(model: &str) -> bool {
    matches!(
        model
            .trim_start_matches("models/")
            .to_ascii_lowercase()
            .as_str(),
        "image-01" | "image-01-live"
    )
}

pub(super) fn is_minimax_video_model(model: &str) -> bool {
    matches!(
        model
            .trim_start_matches("models/")
            .to_ascii_lowercase()
            .as_str(),
        "minimax-h3" | "minimax-h3-max"
    )
}

pub(super) fn is_seedance_video_model(model: &str) -> bool {
    matches!(
        model
            .trim_start_matches("models/")
            .to_ascii_lowercase()
            .as_str(),
        "seedance-2" | "seedance-2.0" | "seedance-2.5"
    )
}

pub(super) fn native_endpoint(base_url: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut base =
        reqwest::Url::parse(base_url).map_err(|_| "Invalid media Base URL".to_owned())?;
    let current = base.path().trim_end_matches('/');
    let prefix = current
        .strip_suffix("/v1")
        .or_else(|| current.strip_suffix("/v2"))
        .unwrap_or(current)
        .to_owned();
    base.set_path(&prefix);
    agent::endpoint(base.as_str(), path)
}

pub(super) fn validate_public_reference_url(value: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| "Reference images require a public HTTPS URL".to_owned())?;
    let host = parsed.host_str().unwrap_or("").trim_matches(['[', ']']);
    let private_ip = host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || ip.to_ipv4_mapped().is_some()
        }
    });
    if parsed.scheme() != "https"
        || host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || !host.contains('.')
        || private_ip
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || value.len() > 4096
    {
        return Err("Reference images require a public HTTPS URL without credentials or fragments; local, data, and private-network URLs cannot be used by this relay".to_owned());
    }
    Ok(())
}

pub(super) fn validate_native_video_request(
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<(), String> {
    validate_video_references(request, references)?;
    let id = model.to_ascii_lowercase();
    let seedance = is_seedance_video_model(model);
    let max = id.ends_with("-max");
    let version_25 = id.ends_with("2.5");
    if request.prompt.chars().count() > 7000 {
        return Err("This video model supports prompts up to 7,000 characters".to_owned());
    }
    let seconds = request.seconds.unwrap_or(5);
    if seconds < if max { 5 } else { 4 } || seconds > if version_25 { 30 } else { 15 } {
        return Err(format!(
            "{model} duration must be {}–{} seconds",
            if max { 5 } else { 4 },
            if version_25 { 30 } else { 15 }
        ));
    }
    let default_resolution = if seedance { "480p" } else { "768p" };
    let resolution = request
        .video_resolution
        .as_deref()
        .unwrap_or(default_resolution)
        .to_ascii_lowercase();
    let supported = if seedance {
        matches!(resolution.as_str(), "480p" | "720p")
            || (!version_25 && matches!(resolution.as_str(), "1080p" | "4k"))
    } else if max {
        matches!(resolution.as_str(), "480p" | "768p")
    } else {
        matches!(resolution.as_str(), "768p" | "2k")
    };
    if !supported {
        return Err(format!("{model} does not support resolution {resolution}"));
    }
    let ratio = request.video_aspect_ratio.as_deref().unwrap_or("16:9");
    if !matches!(
        ratio,
        "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive"
    ) || (ratio == "adaptive"
        && !matches!(
            request.video_mode,
            VideoGenerationMode::Image | VideoGenerationMode::FirstLast
        ))
    {
        return Err("Unsupported video aspect ratio for this generation mode".to_owned());
    }
    if request.video_mode == VideoGenerationMode::Video
        || (max && request.video_mode == VideoGenerationMode::Reference)
    {
        return Err(format!(
            "{model} does not support the selected reference mode"
        ));
    }
    let reference_count = references.len() + request.reference_urls.len();
    if request.video_mode == VideoGenerationMode::Reference
        && reference_count > if version_25 { 30 } else { 9 }
    {
        return Err(format!("{model} has too many reference images"));
    }
    Ok(())
}

pub(super) fn uses_direct_minimax_media(provider: &MediaProvider) -> bool {
    reqwest::Url::parse(&provider.profile.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| {
            matches!(
                host.as_str(),
                "api.minimax.cn" | "api.minimaxi.com" | "api.minimax.io"
            )
        })
}

/// Publish local images once before starting parallel jobs. The API's reference
/// endpoint returns expiring public URLs that compatible upstreams can fetch.
pub(super) async fn upload_video_references(
    client: &Client,
    provider: &MediaProvider,
    references: &[ManagedReference],
) -> Result<Vec<String>, String> {
    if references.iter().any(|reference| {
        reference.bytes.len() > 20 * 1024 * 1024
            || !matches!(
                reference.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            )
    }) {
        return Err(
            "Video reference uploads support PNG, JPEG, WebP or GIF images up to 20 MiB each"
                .to_owned(),
        );
    }
    let endpoint = native_endpoint(&provider.profile.base_url, "/v1/media/references")?;
    let mut urls = Vec::with_capacity(references.len());
    for reference in references {
        let part = Part::bytes(reference.bytes.clone())
            .file_name(reference.file_name.clone())
            .mime_str(&reference.mime_type)
            .map_err(|error| format!("Invalid reference image MIME: {error}"))?;
        let value = send_json(bearer_auth_if_present(client.post(endpoint.clone()), provider).multipart(Form::new().part("file", part))).await
            .map_err(|error| format!("Could not upload the video reference to this connection: {error}. Use a LevelUpAPI connection with media uploads enabled, or enter a public HTTPS image URL."))?;
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| "The reference upload returned no public URL".to_owned())?;
        validate_public_reference_url(url)?;
        urls.push(url.to_owned());
    }
    Ok(urls)
}

pub(super) fn native_video_body(
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<Value, String> {
    validate_native_video_request(model, request, references)?;
    let urls = if references.is_empty() {
        request.reference_urls.clone()
    } else {
        references.iter().map(reference_data_url).collect()
    };
    let frame_mode = matches!(
        request.video_mode,
        VideoGenerationMode::Image | VideoGenerationMode::FirstLast
    );
    let prompt = numbered_reference_prompt(
        request.prompt.trim(),
        urls.len(),
        request.video_mode == VideoGenerationMode::FirstLast,
    );
    if prompt.chars().count() > 7000 {
        return Err(
            "The video prompt including reference order must contain at most 7,000 characters"
                .to_owned(),
        );
    }
    if is_minimax_video_model(model) {
        let mut content = vec![json!({"type": "text", "text": prompt})];
        content.extend(urls.iter().enumerate().map(|(index, url)| json!({
            "type": "image_url", "image_url": {"url": url},
            "role": if frame_mode { if index == 0 { "first_frame" } else { "last_frame" } } else { "reference_image" }
        })));
        Ok(
            json!({"model": model, "content": content, "duration": request.seconds.unwrap_or(5),
            "resolution": request.video_resolution.as_deref().unwrap_or("768P").to_ascii_uppercase(),
            "ratio": if frame_mode { "adaptive" } else { request.video_aspect_ratio.as_deref().unwrap_or("16:9") }}),
        )
    } else {
        if !references.is_empty() {
            return Err(
                "Seedance local references must be uploaded before video generation".to_owned(),
            );
        }
        let mut body = json!({"model": model, "prompt": prompt, "duration": request.seconds.unwrap_or(5),
            "resolution": request.video_resolution.as_deref().unwrap_or("480p")});
        // Anyu normalizes historical Auto to an omitted ratio for frame inputs.
        if !frame_mode {
            body["ratio"] = json!(request.video_aspect_ratio.as_deref().unwrap_or("16:9"));
        }
        if frame_mode {
            body["first_image"] = json!(urls[0]);
            if urls.len() == 2 {
                body["last_image"] = json!(urls[1]);
            }
        } else if !urls.is_empty() {
            body["referenceImages"] = json!(urls);
        }
        Ok(body)
    }
}

pub(super) async fn create_native_video(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
) -> Result<RemoteVideoJob, String> {
    let direct_minimax = is_minimax_video_model(model) && uses_direct_minimax_media(provider);
    let mut body = native_video_body(model, request, references)?;
    if is_minimax_video_model(model) && !direct_minimax {
        // Gateways expose the same compatible contract used by the web studio.
        // Native content/role fields belong only to MiniMax's direct API.
        let content = body["content"].as_array().unwrap();
        let prompt = content[0]["text"].clone();
        let urls: Vec<Value> = content
            .iter()
            .skip(1)
            .map(|item| item["image_url"]["url"].clone())
            .collect();
        body.as_object_mut().unwrap().remove("content");
        body["prompt"] = prompt;
        if matches!(
            request.video_mode,
            VideoGenerationMode::Image | VideoGenerationMode::FirstLast
        ) {
            body["first_image"] = urls[0].clone();
            if urls.len() == 2 {
                body["last_image"] = urls[1].clone();
            }
        } else if !urls.is_empty() {
            body["referenceImages"] = json!(urls);
        }
    }
    if is_minimax_video_model(model)
        && serde_json::to_vec(&body)
            .map_err(|error| format!("Could not encode MiniMax video request: {error}"))?
            .len()
            > 64 * 1024 * 1024
    {
        return Err("MiniMax video requests may total at most 64 MiB including encoded references; use smaller images or public HTTPS URLs".to_owned());
    }
    let path = if direct_minimax {
        "/v2/video_generation"
    } else {
        "/v1/videos"
    };
    let value = send_json(
        bearer_auth_if_present(
            client.post(native_endpoint(&provider.profile.base_url, path)?),
            provider,
        )
        .json(&body),
    )
    .await?;
    check_minimax_error(&value)?;
    let mut job = compatible_video_job(&value)?;
    if direct_minimax && job.status == MediaStatus::Completed {
        let url = video_task_payload(&value)
            .pointer("/content/url")
            .and_then(Value::as_str)
            .ok_or_else(|| "MiniMax succeeded without a video URL".to_owned())?;
        job.output = Some(MediaVideoOutput::MiniMax {
            url: url.to_owned(),
        });
    }
    Ok(job)
}

pub(super) async fn poll_minimax_video(
    client: &Client,
    provider: &MediaProvider,
    id: &str,
) -> Result<VideoPoll, String> {
    validate_remote_id(id)?;
    let url = native_endpoint(
        &provider.profile.base_url,
        &format!("/v2/query/video_generation/{id}"),
    )?;
    let value = send_json(bearer_auth_if_present(
        video_status_request(client.get(url)),
        provider,
    ))
    .await?;
    check_minimax_error(&value)?;
    let task = value
        .get("task")
        .ok_or_else(|| "MiniMax returned no task object".to_owned())?;
    let status = task
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "MiniMax returned no task status".to_owned())?;
    match status {
        "queued" | "running" => Ok(VideoPoll::Pending {
            status: if status == "queued" {
                MediaStatus::Queued
            } else {
                MediaStatus::InProgress
            },
            progress: parse_progress(task),
            gateway_status: task
                .get("gateway_status")
                .and_then(Value::as_str)
                .map(str::to_owned),
            error: None,
        }),
        "failed" | "cancelled" => Ok(VideoPoll::Failed {
            error: provider_message(task).unwrap_or_else(|| format!("MiniMax video task {status}")),
        }),
        "succeeded" => {
            let url = task
                .pointer("/content/url")
                .and_then(Value::as_str)
                .ok_or_else(|| "MiniMax succeeded without a video URL".to_owned())?;
            Ok(VideoPoll::Ready(MediaVideoOutput::MiniMax {
                url: url.to_owned(),
            }))
        }
        _ => Err(format!("Unknown MiniMax video task status: {status}")),
    }
}

fn check_minimax_error(value: &Value) -> Result<(), String> {
    if let Some(code) = value
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .filter(|code| *code != 0)
    {
        return Err(format!(
            "MiniMax error {code}: {}",
            value
                .pointer("/base_resp/status_msg")
                .and_then(Value::as_str)
                .unwrap_or("Media generation failed")
        ));
    }
    Ok(())
}

fn minimax_image_body(
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
    mask: Option<&ManagedReference>,
) -> Result<Value, String> {
    if mask.is_some() {
        return Err(
            "MiniMax images support character references, not explicit edit masks".to_owned(),
        );
    }
    let prompt =
        numbered_reference_prompt(&effective_image_prompt(request), references.len(), false);
    if prompt.chars().count() > 1500 {
        return Err("MiniMax image prompts must contain at most 1,500 characters".to_owned());
    }
    let mut body =
        json!({"model": model, "prompt": prompt, "n": request.count, "response_format": "base64"});
    if let Some(size) = request.size.as_deref().filter(|size| *size != "auto") {
        if let Some((width, height)) = size.split_once('x') {
            let width = width
                .parse::<u32>()
                .map_err(|_| "Invalid MiniMax image width")?;
            let height = height
                .parse::<u32>()
                .map_err(|_| "Invalid MiniMax image height")?;
            if model.eq_ignore_ascii_case("image-01-live")
                || !(512..=2048).contains(&width)
                || !(512..=2048).contains(&height)
                || width % 8 != 0
                || height % 8 != 0
            {
                return Err("MiniMax custom image dimensions require image-01, 512–2048 pixels, in multiples of 8".to_owned());
            }
            body["width"] = json!(width);
            body["height"] = json!(height);
        } else {
            if !matches!(
                size,
                "1:1" | "16:9" | "4:3" | "3:2" | "2:3" | "3:4" | "9:16" | "21:9"
            ) || (size == "21:9" && model.eq_ignore_ascii_case("image-01-live"))
            {
                return Err("Unsupported MiniMax image aspect ratio".to_owned());
            }
            body["aspect_ratio"] = json!(size);
        }
    }
    if !references.is_empty() {
        if references.iter().any(|image| {
            image.bytes.len() >= 10 * 1024 * 1024
                || !matches!(image.mime_type.as_str(), "image/jpeg" | "image/png")
        }) {
            return Err(
                "MiniMax character references require JPEG or PNG images smaller than 10 MB"
                    .to_owned(),
            );
        }
        body["subject_reference"] = json!(
            references
                .iter()
                .map(|image| json!({"type": "character", "image_file": reference_data_url(image)}))
                .collect::<Vec<_>>()
        );
    }
    Ok(body)
}

pub(super) async fn call_minimax_image(
    client: &Client,
    provider: &MediaProvider,
    model: &str,
    request: &MediaGenerationRequest,
    references: &[ManagedReference],
    mask: Option<&ManagedReference>,
) -> Result<Vec<GeneratedBlob>, String> {
    let body = minimax_image_body(model, request, references, mask)?;
    let url = native_endpoint(&provider.profile.base_url, "/v1/image_generation")?;
    let value = send_json(bearer_auth_if_present(client.post(url), provider).json(&body)).await?;
    resolve_image_sources(client, minimax_image_sources(&value)?).await
}

fn minimax_image_sources(value: &Value) -> Result<Vec<BlobSource>, String> {
    check_minimax_error(value)?;
    let mut sources = Vec::new();
    for (field, encoded) in [("image_base64", true), ("image_urls", false)] {
        if let Some(items) = value
            .pointer(&format!("/data/{field}"))
            .and_then(Value::as_array)
        {
            sources.extend(
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|item| !item.is_empty())
                    .map(|item| BlobSource {
                        base64: if encoded && !item.starts_with("data:") {
                            Some(item.to_owned())
                        } else {
                            None
                        },
                        url: if !encoded || item.starts_with("data:") {
                            Some(item.to_owned())
                        } else {
                            None
                        },
                        mime_type: None,
                        revised_prompt: None,
                    }),
            );
            if !sources.is_empty() {
                break;
            }
        }
    }
    if sources.is_empty() {
        return Err("MiniMax returned no successful images".to_owned());
    }
    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(model: &str) -> MediaGenerationRequest {
        serde_json::from_value(json!({"kind": "video", "model": model, "prompt": "A slow camera pan", "count": 1, "seconds": 10})).unwrap()
    }

    #[test]
    fn native_versions_are_siblings_and_preserve_gateway_prefixes() {
        assert_eq!(
            native_endpoint("https://gateway.test/proxy/v1", "/v2/video_generation")
                .unwrap()
                .as_str(),
            "https://gateway.test/proxy/v2/video_generation"
        );
        assert_eq!(
            native_endpoint("https://api.minimax.cn/v2/", "/v1/image_generation")
                .unwrap()
                .as_str(),
            "https://api.minimax.cn/v1/image_generation"
        );
    }

    #[test]
    fn h3_first_last_frames_preserve_roles_and_force_adaptive_ratio() {
        let mut request = request("MiniMax-H3");
        request.video_mode = VideoGenerationMode::FirstLast;
        request.reference_urls = vec![
            "https://cdn.test/first.png".into(),
            "https://cdn.test/last.png".into(),
        ];
        request.video_resolution = Some("2K".into());
        let body = native_video_body("MiniMax-H3", &request, &[]).unwrap();
        assert_eq!(body["content"][1]["role"], "first_frame");
        assert_eq!(body["content"][2]["role"], "last_frame");
        assert_eq!(
            body["content"][2]["image_url"]["url"],
            "https://cdn.test/last.png"
        );
        assert_eq!(body["ratio"], "adaptive");
        assert_eq!(body["duration"], 10);
        assert!(body.get("prompt").is_none());
        assert!(
            body["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Image 1 / 图 1 is the first frame")
        );
        request.reference_urls.swap(0, 1);
        let swapped = native_video_body("MiniMax-H3", &request, &[]).unwrap();
        assert_eq!(
            swapped["content"][1]["image_url"]["url"],
            "https://cdn.test/last.png"
        );
        assert_eq!(swapped["content"][1]["role"], "first_frame");
        assert_eq!(swapped["content"][2]["role"], "last_frame");
        request.seconds = Some(30);
        assert!(native_video_body("MiniMax-H3", &request, &[]).is_err());
        request.seconds = Some(10);
        assert!(native_video_body("MiniMax-H3-Max", &request, &[]).is_err());
    }

    #[test]
    fn seedance_25_allows_30_seconds_and_uses_compatible_frame_fields() {
        let mut request = request("Seedance-2.5");
        request.seconds = Some(30);
        request.video_mode = VideoGenerationMode::FirstLast;
        request.reference_urls = vec![
            "https://cdn.test/first.png".into(),
            "https://cdn.test/last.png".into(),
        ];
        let body = native_video_body("Seedance-2.5", &request, &[]).unwrap();
        assert_eq!(body["first_image"], "https://cdn.test/first.png");
        assert_eq!(body["last_image"], "https://cdn.test/last.png");
        assert!(body.get("ratio").is_none());
        assert!(body.get("images").is_none());
        assert!(
            body["prompt"]
                .as_str()
                .unwrap()
                .contains("Image 2 / 图 2 is the last frame")
        );
        request.reference_urls.swap(0, 1);
        let swapped = native_video_body("Seedance-2.5", &request, &[]).unwrap();
        assert_eq!(swapped["first_image"], "https://cdn.test/last.png");
        assert_eq!(swapped["last_image"], "https://cdn.test/first.png");
        assert!(native_video_body("Seedance-2", &request, &[]).is_err());
        request.video_resolution = Some("1080p".into());
        assert!(native_video_body("Seedance-2.5", &request, &[]).is_err());
        request.seconds = Some(15);
        assert!(native_video_body("Seedance-2", &request, &[]).is_ok());
    }

    #[test]
    fn video_reference_limits_follow_model_and_reject_unfetchable_urls() {
        let mut request = request("Seedance-2.5");
        request.video_mode = VideoGenerationMode::Reference;
        request.reference_urls = (0..30)
            .map(|index| format!("https://cdn.test/{index}.png"))
            .collect();
        assert_eq!(
            native_video_body("Seedance-2.5", &request, &[]).unwrap()["referenceImages"]
                .as_array()
                .unwrap()
                .len(),
            30
        );
        assert!(native_video_body("Seedance-2", &request, &[]).is_err());
        request.reference_urls.truncate(9);
        assert!(native_video_body("MiniMax-H3", &request, &[]).is_ok());
        assert!(native_video_body("MiniMax-H3-Max", &request, &[]).is_err());
        for url in [
            "data:image/png;base64,abcd",
            "http://cdn.test/image.png",
            "https://127.0.0.1/a",
            "https://10.1.2.3/a",
            "https://localhost/a",
            "https://[::1]/a",
            "https://user:password@cdn.test/a",
            "https://cdn.test/a#fragment",
        ] {
            assert!(
                validate_public_reference_url(url).is_err(),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn minimax_image_errors_are_checked_before_returned_images() {
        assert!(minimax_image_sources(&json!({"base_resp": {"status_code": 1008, "status_msg": "insufficient balance"}, "data": {"image_urls": ["https://cdn.test/old.png"]}})).is_err());
        assert!(minimax_image_sources(&json!({"base_resp": {"status_code": 0}, "metadata": {"success_count": 0, "failed_count": 1}, "data": {"image_urls": []}})).is_err());
        let sources = minimax_image_sources(&json!({"base_resp": {"status_code": 0}, "data": {"image_base64": ["YWJj", "data:image/png;base64,YWJj"]}})).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].base64.as_deref(), Some("YWJj"));
        assert!(sources[1].url.as_deref().unwrap().starts_with("data:"));
    }

    #[test]
    fn minimax_image_dimensions_and_character_references_use_native_fields() {
        let mut request = request("image-01");
        request.kind = MediaKind::Image;
        request.size = Some("2048x1152".into());
        let reference = ManagedReference {
            file_name: "portrait.png".into(),
            mime_type: "image/png".into(),
            bytes: vec![1, 2, 3],
            kind: AttachmentKind::Image,
        };
        let body = minimax_image_body("image-01", &request, std::slice::from_ref(&reference), None)
            .unwrap();
        assert_eq!(body["width"], 2048);
        assert_eq!(body["height"], 1152);
        assert_eq!(body["response_format"], "base64");
        assert_eq!(body["subject_reference"][0]["type"], "character");
        assert!(body.get("size").is_none());
        let mut other = reference.clone();
        other.bytes = vec![4, 5, 6];
        let ordered = minimax_image_body(
            "image-01",
            &request,
            &[other.clone(), reference.clone()],
            None,
        )
        .unwrap();
        assert!(
            ordered["prompt"]
                .as_str()
                .unwrap()
                .contains("Reference image order: 2 images")
        );
        assert_eq!(
            ordered["subject_reference"][0]["image_file"],
            reference_data_url(&other)
        );
        assert_eq!(
            ordered["subject_reference"][1]["image_file"],
            reference_data_url(&reference)
        );
        assert!(minimax_image_body("image-01-live", &request, &[], None).is_err());
        assert!(minimax_image_body("image-01", &request, &[], Some(&reference)).is_err());
    }
}
