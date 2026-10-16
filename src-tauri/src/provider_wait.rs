use std::{future::Future, time::Duration};

use tokio_util::sync::CancellationToken;

use crate::models::AgentStreamEvent;

pub const HEADERS_TIMEOUT: Duration = Duration::from_secs(90);
// Codex's documented default SSE idle timeout. This is reset for every event,
// including reasoning and tool arguments; it is not a generation deadline.
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
pub const JSON_TIMEOUT: Duration = Duration::from_secs(300);
pub const FAILED_ATTEMPTS_BUDGET: Duration = Duration::from_secs(300);
const NOTICE_INTERVAL: Duration = Duration::from_secs(30);

pub async fn wait<T>(
    future: impl Future<Output = Result<T, String>>,
    cancellation: &CancellationToken,
    phase: &'static str,
    timeout: Duration,
    emit: &mut impl FnMut(AgentStreamEvent),
) -> Result<T, String> {
    let started = tokio::time::Instant::now();
    let deadline = tokio::time::sleep(timeout);
    let notice = tokio::time::sleep(NOTICE_INTERVAL);
    tokio::pin!(future, deadline, notice);
    let mut notified = false;
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err("REQUEST_CANCELLED".to_owned()),
            result = &mut future => {
                if notified {
                    emit(AgentStreamEvent::wait_finished());
                }
                return result;
            }
            _ = &mut deadline => return Err(format!(
                "[PROVIDER_WAIT_TIMEOUT:{phase}] Provider timed out after {} seconds waiting for {phase}",
                timeout.as_secs(),
            )),
            _ = &mut notice => {
                notified = true;
                emit(AgentStreamEvent::waiting(phase, started.elapsed(), timeout));
                notice.as_mut().reset(tokio::time::Instant::now() + NOTICE_INTERVAL);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn silent_provider_times_out_and_reports_the_wait_phase() {
        for (phase, timeout) in [
            ("headers", HEADERS_TIMEOUT),
            ("stream", STREAM_IDLE_TIMEOUT),
            ("body", JSON_TIMEOUT),
        ] {
            let mut events = Vec::new();
            let started = tokio::time::Instant::now();
            let result = wait(
                std::future::pending::<Result<(), String>>(),
                &CancellationToken::new(),
                phase,
                timeout,
                &mut |event| events.push(event),
            )
            .await;
            assert!(
                result
                    .unwrap_err()
                    .contains(&format!("PROVIDER_WAIT_TIMEOUT:{phase}"))
            );
            assert_eq!(started.elapsed(), timeout);
            assert_eq!(events[0].wait.as_ref().unwrap().elapsed_ms, 30_000);
            assert!(
                events
                    .iter()
                    .all(|event| event.wait.as_ref().unwrap().phase == phase)
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn continuous_progress_can_run_beyond_the_idle_limit() {
        let started = tokio::time::Instant::now();
        let cancellation = CancellationToken::new();
        let mut events = Vec::new();
        for _ in 0..10 {
            wait(
                async {
                    tokio::time::sleep(Duration::from_secs(240)).await;
                    Ok(())
                },
                &cancellation,
                "stream",
                STREAM_IDLE_TIMEOUT,
                &mut |event| events.push(event),
            )
            .await
            .unwrap();
        }
        assert_eq!(started.elapsed(), Duration::from_secs(2_400));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "provider_wait_finished")
                .count(),
            10
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_interrupts_pending_wait() {
        let cancellation = CancellationToken::new();
        let mut emit = |_| {};
        let (result, ()) = tokio::join!(
            wait(
                std::future::pending::<Result<(), String>>(),
                &cancellation,
                "stream",
                STREAM_IDLE_TIMEOUT,
                &mut emit
            ),
            async {
                tokio::time::sleep(Duration::from_secs(15)).await;
                cancellation.cancel();
            }
        );
        assert_eq!(result.unwrap_err(), "REQUEST_CANCELLED");
    }
}
