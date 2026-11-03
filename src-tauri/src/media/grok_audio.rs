use super::*;

pub(super) async fn call_grok_audio(
    client: &Client,
    provider: &MediaProvider,
    request: &MediaGenerationRequest,
) -> Result<GeneratedBlob, String> {
    let format = request
        .output_format
        .as_deref()
        .unwrap_or("mp3")
        .trim()
        .to_ascii_lowercase();
    let format = if format.is_empty() { "mp3" } else { &format };
    if !matches!(format, "mp3" | "wav") {
        return Err("Grok speech supports MP3 or WAV output in Media Studio".to_owned());
    }
    let voice = request
        .voice
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("eve");
    let body = json!({
        "text": request.prompt.trim(),
        "language": "auto",
        "voice_id": voice,
        "output_format": { "codec": format }
    });
    let response = bearer_auth_if_present(
        client.post(native_endpoint(&provider.profile.base_url, "/v1/tts")?),
        provider,
    )
    .json(&body)
    .send()
    .await
    .map_err(|error| format!("Audio provider connection failed: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, MAX_JSON_BYTES).await);
    }
    decode_audio(read_limited_response(response, MAX_AUDIO_BYTES).await?)
}

fn audio_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        return Some("audio/wav");
    }
    if (bytes.len() >= 10 && bytes.starts_with(b"ID3"))
        || (bytes.len() >= 4
            && bytes[0] == 0xff
            && bytes[1] & 0xe0 == 0xe0
            && bytes[1] & 0x18 != 0x08
            && bytes[1] & 0x06 != 0
            && bytes[2] & 0xf0 != 0xf0
            && bytes[2] & 0x0c != 0x0c)
    {
        return Some("audio/mpeg");
    }
    None
}

fn decode_audio(mut bytes: Vec<u8>) -> Result<GeneratedBlob, String> {
    // Inspect bytes before the MIME header: gateways may use generic or missing headers.
    if audio_mime(&bytes).is_none()
        && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
    {
        if let Some(encoded) = value.get("audio").and_then(Value::as_str) {
            bytes = decode_base64_limited(encoded, MAX_AUDIO_BYTES)?;
        } else if let Some(message) = provider_message(&value) {
            return Err(message);
        }
    }
    let mime_type = audio_mime(&bytes)
        .ok_or_else(|| "The Grok provider did not return a valid MP3 or WAV audio file".to_owned())?
        .to_owned();
    Ok(GeneratedBlob {
        bytes,
        mime_type,
        revised_prompt: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::tests::{
        MockResponse, mock_sequence, mock_sequence_inspecting, provider, request, temp_storage,
    };

    #[tokio::test]
    async fn generates_and_persists_grok_speech_through_native_tts_endpoint() {
        for (label, mime, response_body, expected, format, voice) in [
            ("mp3", "audio/mpeg", b"ID3mock-audio".to_vec(), b"ID3mock-audio".to_vec(), "mp3", "eve"),
            ("generic", "application/octet-stream", b"ID3mock-audio".to_vec(), b"ID3mock-audio".to_vec(), "mp3", "eve"),
            ("missing", "", vec![0xff, 0xfb, 0x90, 0, 1, 2], vec![0xff, 0xfb, 0x90, 0, 1, 2], "mp3", "eve"),
            ("wav", "application/json", pcm16_to_wav(&[0, 0, 1, 0], 24_000, 1), pcm16_to_wav(&[0, 0, 1, 0], 24_000, 1), "wav", "ara"),
            ("envelope", "application/json", json!({"audio": "SUQzbW9jay1hdWRpbw==", "content_type": "audio/mpeg", "audio_timestamps": {}}).to_string().into_bytes(), b"ID3mock-audio".to_vec(), "mp3", "eve"),
        ] {
            let (base_url, server) = mock_sequence_inspecting(vec![MockResponse {
                method: "POST", path: "/proxy/v1/tts", status: 200, content_type: mime, body: response_body,
            }], move |_, raw| {
                let raw = String::from_utf8_lossy(raw);
                let (headers, body) = raw.split_once("\r\n\r\n").unwrap();
                assert!(headers.to_ascii_lowercase().contains("authorization: bearer secret"));
                assert!(headers.to_ascii_lowercase().contains("content-type: application/json"));
                let body: Value = serde_json::from_str(body).unwrap();
                assert_eq!(body, json!({"text": "Hello Grok", "language": "auto", "voice_id": voice, "output_format": {"codec": format}}));
            });
            let mut provider = provider("grok", "grok-voice-tts");
            provider.profile.base_url = format!("{base_url}/proxy/v1/");
            let selection = MediaSelection { provider, model: "grok-voice-tts".to_owned(), protocol: ProviderProtocol::OpenaiChat };
            let (root, database) = temp_storage(&format!("grok-speech-{label}"));
            let mut request = request(MediaKind::Audio, 1);
            request.prompt = " Hello Grok ".to_owned();
            request.output_format = Some(format.to_owned());
            request.voice = if voice == "eve" { None } else { Some(format!(" {voice} ")) };
            let result = generate_batch(&Client::new(), &root.join("media"), &database, &selection, &request, None, &[]).await.unwrap();
            assert_eq!(result.assets.len(), 1);
            assert!(result.errors.is_empty());
            let asset = &result.assets[0];
            assert_eq!(asset.status, MediaStatus::Completed);
            assert_eq!(asset.mime_type.as_deref(), Some(audio_mime_for_format(format)));
            let path = asset.file_path.as_deref().unwrap();
            assert!(path.ends_with(&format!(".{format}")));
            assert_eq!(std::fs::read(path).unwrap(), expected);
            server.join().unwrap();
            drop(database);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[tokio::test]
    async fn rejects_grok_error_bodies_and_unsupported_formats() {
        for (status, mime, body, expected) in [
            (
                200,
                "audio/mpeg",
                "<html>login required</html>",
                "valid MP3 or WAV",
            ),
            (
                200,
                "application/octet-stream",
                "not audio",
                "valid MP3 or WAV",
            ),
            (
                200,
                "application/json",
                r#"{"error":{"message":"Voice unavailable"}}"#,
                "Voice unavailable",
            ),
            (
                200,
                "application/json",
                r#"{"audio":"bm90IGF1ZGlv"}"#,
                "valid MP3 or WAV",
            ),
            (200, "application/json", r#"{"audio":"!!bad!!"}"#, "base64"),
            (200, "audio/mpeg", "", "valid MP3 or WAV"),
            (404, "text/plain", "404 page not found", "404"),
        ] {
            let (base_url, server) = mock_sequence(vec![MockResponse {
                method: "POST",
                path: "/v1/tts",
                status,
                content_type: mime,
                body: body.as_bytes().to_vec(),
            }]);
            let mut provider = provider("grok", "grok-voice-tts");
            provider.profile.base_url = base_url;
            let error = call_grok_audio(&Client::new(), &provider, &request(MediaKind::Audio, 1))
                .await
                .err()
                .unwrap();
            assert!(error.contains(expected), "unexpected error: {error}");
            server.join().unwrap();
        }
        let mut request = request(MediaKind::Audio, 1);
        request.output_format = Some("flac".to_owned());
        let error = call_grok_audio(
            &Client::new(),
            &provider("grok", "grok-voice-tts"),
            &request,
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("MP3 or WAV"));
    }
}
