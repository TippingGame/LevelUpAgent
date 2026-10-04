//! Bounded local ComfyUI adapter. Only the fixed See-through graph is submitted.
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

const JSON_LIMIT: usize = 8 * 1024 * 1024;
const IMAGE_LIMIT: usize = 16 * 1024 * 1024;

fn endpoint_url(endpoint: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(endpoint).map_err(|_| "Invalid ComfyUI address")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("ComfyUI must use a loopback HTTP address, e.g. http://127.0.0.1:8188".into());
    }
    if url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1")).map_err(|e| e.to_string())?;
    }
    Ok(url)
}
fn job_id(payload: &Value) -> Result<&str, String> {
    let id = payload["jobId"].as_str().unwrap_or("");
    if id.len() != 32
        || !id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Invalid job ID".into());
    }
    Ok(id)
}
fn prompt_id(value: &Value) -> Result<&str, String> {
    let id = value.as_str().unwrap_or("");
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Invalid prompt ID".into());
    }
    Ok(id)
}
fn validate_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > IMAGE_LIMIT || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Expected PNG up to 16 MiB".into());
    }
    let size = imagesize::blob_size(bytes).map_err(|_| "Invalid PNG header")?;
    if size.width == 0
        || size.height == 0
        || size.width > 8192
        || size.height > 8192
        || size.width * size.height > 32 * 1024 * 1024
    {
        return Err("PNG exceeds 8192 px / 32 MP".into());
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    layer_model: String,
    depth_model: String,
    resolution: u32,
    steps: u32,
    seed: u32,
    quant: String,
    group_offload: bool,
}
fn graph(id: &str, config: Value) -> Result<Value, String> {
    let c: Settings = serde_json::from_value(config).map_err(|_| "Invalid See-through settings")?;
    if [&c.layer_model, &c.depth_model]
        .iter()
        .any(|s| s.trim().is_empty() || s.len() > 256)
        || ![512, 768, 1024, 1280].contains(&c.resolution)
        || !(1..=100).contains(&c.steps)
        || !["none", "nf4"].contains(&c.quant.as_str())
    {
        return Err("Invalid See-through settings".into());
    }
    let model = |name: &str| json!({"model":name,"quant_mode":c.quant,"cache_tag_embeds":true,"group_offload":c.group_offload,"auto_download":false});
    Ok(json!({
        "1":{"class_type":"LoadImage","inputs":{"image":format!("levelup_spine_input_{id}.png")}},
        "2":{"class_type":"SeeThrough_LoadLayerDiffModel","inputs":model(&c.layer_model)},
        "3":{"class_type":"SeeThrough_GenerateLayers","inputs":{"image":["1",0],"layerdiff_model":["2",0],"seed":c.seed,"resolution":c.resolution,"num_inference_steps":c.steps}},
        "4":{"class_type":"SeeThrough_LoadDepthModel","inputs":model(&c.depth_model)},
        "5":{"class_type":"SeeThrough_GenerateDepth","inputs":{"layers":["3",0],"depth_model":["4",0],"seed":c.seed,"resolution_depth":c.resolution}},
        "6":{"class_type":"SeeThrough_PostProcess","inputs":{"layers_depth":["5",0],"tblr_split":true,"use_lama":false}},
        "7":{"class_type":"LevelUpSpineExport","inputs":{"parts":["6",0],"job_id":id}}
    }))
}
async fn bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("ComfyUI HTTP {}", response.status()));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("ComfyUI response exceeds limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > limit {
            return Err("ComfyUI response exceeds limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn json_response(response: Response) -> Result<Value, String> {
    serde_json::from_slice(&bounded(response, JSON_LIMIT).await?)
        .map_err(|e| format!("Invalid ComfyUI JSON: {e}"))
}
fn matching_prompt(value: &Value, id: &str) -> Option<String> {
    // ComfyUI stores [queue number, prompt_id, graph, extra_data, outputs].
    let prompt = value.as_array()?;
    let graph = prompt.get(2)?;
    if graph["7"]["class_type"] != "LevelUpSpineExport" || graph["7"]["inputs"]["job_id"] != id {
        return None;
    }
    prompt_id(prompt.get(1)?).ok().map(str::to_owned)
}

#[tauri::command]
pub async fn spine_comfy_request(
    endpoint: String,
    operation: String,
    payload: Value,
) -> Result<Value, String> {
    let base = endpoint_url(&endpoint)?;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let url = |path: &str| base.join(path).map_err(|e| e.to_string());
    match operation.as_str() {
        "info" => {
            json_response(
                client
                    .get(url("object_info")?)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .await
        }
        "upload" => {
            let id = job_id(&payload)?;
            let image = payload["image"]
                .as_str()
                .and_then(|s| s.strip_prefix("data:image/png;base64,"))
                .ok_or("Expected PNG data URL")?;
            if image.len() > IMAGE_LIMIT * 4 / 3 + 4 {
                return Err("Input image exceeds 16 MiB".into());
            }
            let bytes = STANDARD.decode(image).map_err(|_| "Invalid image base64")?;
            validate_png(&bytes)?;
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(format!("levelup_spine_input_{id}.png"))
                .mime_str("image/png")
                .map_err(|e| e.to_string())?;
            let form = reqwest::multipart::Form::new()
                .part("image", part)
                .text("type", "input")
                .text("overwrite", "false");
            json_response(
                client
                    .post(url("upload/image")?)
                    .multipart(form)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .await
        }
        "submit" => {
            let id = job_id(&payload)?;
            // Build server-side: the IPC caller cannot submit arbitrary custom nodes.
            let prompt = graph(id, payload["config"].clone())?;
            json_response(
                client
                    .post(url("prompt")?)
                    .json(&json!({"prompt":prompt,"client_id":id}))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .await
        }
        "history" => {
            let id = prompt_id(&payload["promptId"])?;
            json_response(
                client
                    .get(url(&format!("history/{id}"))?)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .await
        }
        "recover" => {
            let id = job_id(&payload)?;
            // Read history before queue to cover a job completing between the two calls
            // by querying history once more only if neither returns a match.
            let mut found = Vec::new();
            for attempt in 0..2 {
                let history = json_response(
                    client
                        .get(url("history?max_items=100")?)
                        .send()
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .await?;
                if let Some(entries) = history.as_object() {
                    for entry in entries.values() {
                        if let Some(p) = matching_prompt(&entry["prompt"], id) {
                            found.push(p);
                        }
                    }
                }
                if attempt == 0 {
                    let queue = json_response(
                        client
                            .get(url("queue")?)
                            .send()
                            .await
                            .map_err(|e| e.to_string())?,
                    )
                    .await?;
                    for key in ["queue_running", "queue_pending"] {
                        if let Some(entries) = queue[key].as_array() {
                            for entry in entries {
                                if let Some(p) = matching_prompt(entry, id) {
                                    found.push(p);
                                }
                            }
                        }
                    }
                }
                if !found.is_empty() {
                    break;
                }
            }
            found.sort();
            found.dedup();
            if found.len() > 1 {
                return Err(
                    "Multiple prompts match this job; inspect ComfyUI before continuing".into(),
                );
            }
            Ok(json!({"promptId":found.first()}))
        }
        "image" => {
            let id = job_id(&payload)?;
            let filename = payload["filename"].as_str().unwrap_or("");
            let index = filename
                .strip_prefix(&format!("levelup_spine_{id}_"))
                .and_then(|s| s.strip_suffix(".png"))
                .ok_or("Image does not belong to this job")?;
            if index.len() != 3 || !index.bytes().all(|c| c.is_ascii_digit()) {
                return Err("Invalid layer image name".into());
            }
            let response = client
                .get(url("view")?)
                .query(&[
                    ("filename", filename),
                    ("type", "output"),
                    ("subfolder", ""),
                ])
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let bytes = bounded(response, IMAGE_LIMIT).await?;
            validate_png(&bytes)?;
            Ok(json!({"image":format!("data:image/png;base64,{}",STANDARD.encode(bytes))}))
        }
        _ => Err("Unknown Spine ComfyUI operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const ID: &str = "0123456789abcdef0123456789abcdef";
    fn settings() -> Value {
        json!({"layerModel":"layer.safetensors","depthModel":"depth.safetensors","resolution":768,"steps":20,"seed":1,"quant":"nf4","groupOffload":true})
    }
    #[test]
    fn restricts_addresses_ids_and_graph() {
        for address in [
            "https://localhost:8188",
            "http://example.com",
            "http://127.0.0.1/a",
            "http://u:p@localhost",
            "http://localhost/?x=1",
            "http://0.0.0.0",
        ] {
            assert!(endpoint_url(address).is_err(), "{address}");
        }
        assert_eq!(
            endpoint_url("http://localhost:8188").unwrap().host_str(),
            Some("127.0.0.1")
        );
        assert!(endpoint_url("http://[::1]:8188").is_ok());
        assert!(prompt_id(&json!("../queue")).is_err());
        assert!(job_id(&json!({"jobId":"../evil"})).is_err());
        let graph = graph(ID, settings()).unwrap();
        assert_eq!(graph.as_object().unwrap().len(), 7);
        assert_eq!(graph["2"]["inputs"]["auto_download"], false);
        assert_eq!(graph["4"]["inputs"]["auto_download"], false);
        assert_eq!(graph["6"]["inputs"]["use_lama"], false);
        assert_eq!(
            matching_prompt(&json!([1, "receipt", graph, {}, []]), ID),
            Some("receipt".into())
        );
        assert!(super::graph(ID, json!({"resolution":9000})).is_err());
    }
    #[tokio::test]
    async fn upload_recovery_and_image_requests_are_isolated_by_job() {
        const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let unrelated = json!([
                1,
                "wrong-receipt",
                super::graph("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", settings()).unwrap(),
                {},
                []
            ]);
            let queued = json!([
                2,
                "recovered-receipt",
                super::graph(ID, settings()).unwrap(),
                {},
                []
            ]);
            let responses = [
                ("POST /upload/image ".to_owned(), json!({"name":format!("levelup_spine_input_{ID}.png"),"type":"input","subfolder":""}).to_string().into_bytes()),
                ("GET /history?max_items=100 ".to_owned(),json!({"wrong-receipt":{"prompt":unrelated}}).to_string().into_bytes()),
                ("GET /queue ".to_owned(),json!({"queue_running":[],"queue_pending":[queued]}).to_string().into_bytes()),
                ("GET /history/recovered-receipt ".to_owned(),json!({"recovered-receipt":{"status":{"completed":false}}}).to_string().into_bytes()),
                (format!("GET /view?filename=levelup_spine_{ID}_000.png&type=output&subfolder= "),STANDARD.decode(PNG).unwrap()),
            ];
            for (expected, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: "))
                            .map(|s| s.parse::<usize>().unwrap())
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&request);
                assert!(text.starts_with(&expected), "{text}");
                if expected.starts_with("POST") {
                    assert!(text.contains(&format!("filename=\"levelup_spine_input_{ID}.png\"")));
                    assert!(text.contains("name=\"overwrite\"\r\n\r\nfalse"));
                    assert!(request.windows(8).any(|w| w == b"\x89PNG\r\n\x1a\n"));
                }
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });
        let upload = spine_comfy_request(
            endpoint.clone(),
            "upload".into(),
            json!({"jobId":ID,"image":format!("data:image/png;base64,{PNG}")}),
        )
        .await
        .unwrap();
        assert_eq!(upload["name"], format!("levelup_spine_input_{ID}.png"));
        let receipt = spine_comfy_request(endpoint.clone(), "recover".into(), json!({"jobId":ID}))
            .await
            .unwrap();
        assert_eq!(receipt["promptId"], "recovered-receipt");
        let history = spine_comfy_request(
            endpoint.clone(),
            "history".into(),
            json!({"promptId":receipt["promptId"]}),
        )
        .await
        .unwrap();
        assert_eq!(history["recovered-receipt"]["status"]["completed"], false);
        let image = spine_comfy_request(
            endpoint.clone(),
            "image".into(),
            json!({"jobId":ID,"filename":format!("levelup_spine_{ID}_000.png")}),
        )
        .await
        .unwrap();
        assert_eq!(image["image"], format!("data:image/png;base64,{PNG}"));
        server.await.unwrap();
        let error = spine_comfy_request(
            endpoint,
            "image".into(),
            json!({"jobId":ID,"filename":"levelup_spine_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_000.png"}),
        )
        .await
        .unwrap_err();
        assert!(error.contains("belong"));
    }
    #[tokio::test]
    async fn uses_real_http_for_submission_and_bounded_responses() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("POST /prompt HTTP/1.1"));
            let body: Value =
                serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["prompt"]["7"]["inputs"]["job_id"], ID);
            assert_eq!(body["prompt"]["2"]["inputs"]["auto_download"], false);
            let body = r#"{"prompt_id":"receipt-123"}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let response = spine_comfy_request(
            endpoint,
            "submit".into(),
            json!({"jobId":ID,"config":settings(),"prompt":{"evil":{}}}),
        )
        .await
        .unwrap();
        assert_eq!(response["prompt_id"], "receipt-123");
        server.await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let bytes_read = socket.read(&mut request).await.unwrap();
            assert!(bytes_read > 0);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9000000\r\n\r\n")
                .await
                .unwrap();
        });
        assert!(
            spine_comfy_request(endpoint, "info".into(), json!({}))
                .await
                .unwrap_err()
                .contains("limit")
        );
        server.await.unwrap();
    }
}
