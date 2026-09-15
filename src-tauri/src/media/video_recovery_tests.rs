use super::tests::{
    MockResponse, mock_sequence, mock_sequence_inspecting, provider, request, temp_storage,
};
use super::*;

#[test]
fn submission_keeps_nested_task_state_and_never_invents_progress() {
    for status in ["queued", "running", "completed"] {
        let value = json!({"request_id":"trace", "data":{"task":{"id":"actual", "status":status, "progress":null}}});
        let job = compatible_video_job(&value).unwrap();
        assert_eq!(job.id, "actual");
        assert_eq!(job.status, parse_video_status(Some(status)));
        assert_eq!(job.progress, None);
        assert_eq!(job.output.is_some(), status == "completed");
    }
    let job = compatible_video_job(
        &json!({"status":"success", "request_id":"trace", "data":{"task_id":"accepted"}}),
    )
    .unwrap();
    assert_eq!(job.status, MediaStatus::Queued);
    assert_eq!(job.id, "accepted");
    assert!(compatible_video_job(&json!({"id":"job", "status":"unknown"})).is_err());
    assert_eq!(parse_progress(&json!({"progress":-5})), None);
}

#[tokio::test]
async fn completed_submission_survives_restart_and_download_failure_without_polling_or_resubmitting()
 {
    let (base_url, server) = mock_sequence(vec![
        MockResponse {method:"POST",path:"/v1/videos",status:200,content_type:"application/json",body:br#"{"request_id":"trace","data":{"task":{"id":"job","status":"completed","progress":null}}}"#.to_vec()},
        MockResponse {method:"GET",path:"/v1/videos/job/content",status:503,content_type:"application/json",body:br#"{"error":"download unavailable"}"#.to_vec()},
        MockResponse {method:"GET",path:"/v1/videos/job/content",status:200,content_type:"video/mp4",body:b"recovered-video".to_vec()},
    ]);
    let mut provider = provider("primary", "Seedance-2.5");
    provider.profile.base_url = base_url;
    let selection = MediaSelection {
        provider: provider.clone(),
        model: "Seedance-2.5".into(),
        protocol: ProviderProtocol::OpenaiChat,
    };
    let (root, database) = temp_storage("completed-submit");
    let storage = root.join("media");
    let mut input = request(MediaKind::Video, 1);
    input.seconds = Some(4);
    let batch = generate_batch(
        &Client::new(),
        &storage,
        &database,
        &selection,
        &input,
        None,
        &[],
    )
    .await
    .unwrap();
    let asset = &batch.assets[0];
    assert_eq!(asset.status, MediaStatus::InProgress);
    assert_eq!(asset.remote_id.as_deref(), Some("job"));
    assert!(asset.video_output.is_some());
    assert!(
        serde_json::to_value(asset)
            .unwrap()
            .get("progress")
            .is_none()
    );
    let updates = std::sync::Mutex::new(Vec::new());
    let refreshes = MediaRefreshes::default();
    assert!(
        refreshes
            .refresh(
                &Client::new(),
                &storage,
                &database,
                &provider,
                &asset.id,
                &|update| updates.lock().unwrap().push(update.clone())
            )
            .await
            .is_err()
    );
    assert!(
        updates
            .lock()
            .unwrap()
            .iter()
            .any(|update| update.download_progress.is_some())
    );
    let pending = database.get_media_asset(&asset.id).unwrap().unwrap();
    assert!(pending.video_output.is_some());
    drop(database);
    let database = Database::open(&root.join("test.sqlite3")).unwrap();
    let completed = refreshes
        .refresh(
            &Client::new(),
            &storage,
            &database,
            &provider,
            &asset.id,
            &|_| {},
        )
        .await
        .unwrap();
    assert_eq!(completed.status, MediaStatus::Completed);
    assert!(completed.video_output.is_none());
    assert_eq!(
        std::fs::read(completed.file_path.unwrap()).unwrap(),
        b"recovered-video"
    );
    server.join().unwrap();
    drop(database);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn completed_poll_prefers_output_url_and_reports_download_before_stream_finishes() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let output_url = format!("http://{}/output.mp4", listener.local_addr().unwrap());
    let (release, wait) = tokio::sync::oneshot::channel();
    let download = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![];
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut buf = [0; 1024];
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&buf[..n]);
        }
        assert!(
            !String::from_utf8_lossy(&request)
                .to_ascii_lowercase()
                .contains("authorization:")
        );
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 10\r\nConnection: close\r\n\r\n12345").await.unwrap();
        wait.await.unwrap();
        stream.write_all(b"67890").await.unwrap();
    });
    let (base_url, server) = mock_sequence_inspecting(
        vec![
            MockResponse {
                method: "POST",
                path: "/v1/videos",
                status: 200,
                content_type: "application/json",
                body: br#"{"task_id":"job","status":"running"}"#.to_vec(),
            },
            MockResponse {
                method: "GET",
                path: "/v1/videos/job",
                status: 200,
                content_type: "application/json",
                body: json!({"id":"job","status":"completed","url":output_url})
                    .to_string()
                    .into_bytes(),
            },
        ],
        |index, bytes| {
            if index == 1 {
                assert!(
                    String::from_utf8_lossy(bytes)
                        .to_ascii_lowercase()
                        .contains("cache-control: no-cache, no-store")
                );
            }
        },
    );
    let mut provider = provider("primary", "Seedance-2.5");
    provider.profile.base_url = base_url;
    let selection = MediaSelection {
        provider: provider.clone(),
        model: "Seedance-2.5".into(),
        protocol: ProviderProtocol::OpenaiChat,
    };
    let (root, database) = temp_storage("stream-progress");
    let storage = root.join("media");
    let mut input = request(MediaKind::Video, 1);
    input.seconds = Some(4);
    let batch = generate_batch(
        &Client::new(),
        &storage,
        &database,
        &selection,
        &input,
        None,
        &[],
    )
    .await
    .unwrap();
    assert_eq!(batch.assets[0].status, MediaStatus::InProgress);
    let (updates, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let callback = |asset: &MediaAsset| {
        updates.send(asset.clone()).unwrap();
    };
    let client = Client::new();
    let refreshes = MediaRefreshes::default();
    {
        let refresh = refreshes.refresh(
            &client,
            &storage,
            &database,
            &provider,
            &batch.assets[0].id,
            &callback,
        );
        tokio::pin!(refresh);
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(5));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                result=&mut refresh=>panic!("finished before output stream was released: {result:?}"),
                _=&mut deadline=>panic!("download progress was never published"),
                update=receive.recv()=>{
                    let update=update.unwrap();
                    if update.download_progress.as_ref().is_some_and(|progress|progress.received_bytes==5) {
                        assert_eq!(update.status,MediaStatus::InProgress);
                        assert!(database.get_media_asset(&update.id).unwrap().unwrap().video_output.is_some());
                        break;
                    }
                }
            }
        }
        release.send(()).unwrap();
        let completed = refresh.await.unwrap();
        assert_eq!(completed.status, MediaStatus::Completed);
        download.await.unwrap();
        server.join().unwrap();
        assert_eq!(
            std::fs::read(completed.file_path.unwrap()).unwrap(),
            b"1234567890"
        );
    }
    drop(database);
    std::fs::remove_dir_all(root).unwrap();
}
