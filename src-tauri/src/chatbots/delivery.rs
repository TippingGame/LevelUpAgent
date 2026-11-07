//! Delivery readiness is independent of desktop observation status.
use std::time::{Duration, Instant};

const RETRY_DELAY: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

struct Flight {
    id: String,
    started: Instant,
    progress: Instant,
    phase: String,
}

pub(super) struct DeliverySchedule {
    desktop: bool,
    ready: bool,
    online: bool,
    retry_at: Option<Instant>,
    flight: Option<Flight>,
}

impl DeliverySchedule {
    pub fn new(desktop: bool) -> Self {
        Self {
            desktop,
            ready: false,
            online: false,
            retry_at: None,
            flight: None,
        }
    }

    pub fn ready(&mut self) {
        self.ready = self.desktop;
    }

    pub fn status(&mut self, online: bool) {
        self.online = online;
    }

    pub fn can_send(&self, now: Instant) -> bool {
        (if self.desktop {
            self.ready
        } else {
            self.online
        }) && self.flight.is_none()
            && self.retry_at.is_none_or(|at| now >= at)
    }

    pub fn begin(&mut self, id: String, now: Instant) {
        self.flight = Some(Flight {
            id,
            started: now,
            progress: now,
            phase: String::new(),
        });
    }

    pub fn matches(&self, id: &str) -> bool {
        self.flight.as_ref().is_some_and(|f| f.id == id)
    }

    pub fn progress(&mut self, id: &str, phase: &str, now: Instant) -> bool {
        if !self.desktop || phase.is_empty() {
            return false;
        }
        if let Some(flight) = &mut self.flight
            && flight.id == id
            && flight.phase != phase
        {
            flight.phase = phase.into();
            flight.progress = now;
            return true;
        }
        false
    }

    pub fn finish(&mut self, deferred: bool, now: Instant) {
        self.flight = None;
        self.retry_at = deferred.then_some(now + RETRY_DELAY);
    }

    pub fn timed_out(&self, now: Instant) -> bool {
        self.flight.as_ref().is_some_and(|f| {
            now.duration_since(f.progress) >= IDLE_TIMEOUT
                || now.duration_since(f.started) >= TOTAL_TIMEOUT
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_reply_resumes_while_observation_stays_waiting() {
        let now = Instant::now();
        let mut queue = DeliverySchedule::new(true);
        queue.status(true);
        assert!(!queue.can_send(now), "Wait for initialized controller");
        queue.ready();
        queue.status(false); // No current bound title / no readable bubbles.
        assert!(queue.can_send(now));
        queue.begin("same-reply".into(), now);
        assert!(!queue.can_send(now));
        queue.finish(true, now);
        queue.status(true); // Read-only scan must not defeat the retry delay.
        assert!(!queue.can_send(now + Duration::from_secs(4)));
        queue.status(false);
        assert!(queue.can_send(now + RETRY_DELAY));
        queue.begin("same-reply".into(), now + RETRY_DELAY);
        assert!(queue.matches("same-reply"));
    }

    #[test]
    fn official_transport_still_requires_online() {
        let now = Instant::now();
        let mut queue = DeliverySchedule::new(false);
        queue.ready();
        assert!(!queue.can_send(now));
        queue.status(true);
        assert!(queue.can_send(now));
        queue.status(false);
        assert!(!queue.can_send(now));
    }

    #[test]
    fn progress_extends_idle_deadline_but_not_total_or_duplicate_progress() {
        let now = Instant::now();
        let mut queue = DeliverySchedule::new(true);
        queue.begin("reply".into(), now);
        assert!(!queue.progress("other", "typing", now + Duration::from_secs(40)));
        assert!(queue.timed_out(now + IDLE_TIMEOUT));
        assert!(queue.progress("reply", "typing", now + Duration::from_secs(40)));
        assert!(!queue.timed_out(now + Duration::from_secs(60)));
        assert!(!queue.progress("reply", "typing", now + Duration::from_secs(80)));
        assert!(queue.timed_out(now + Duration::from_secs(85)));
        assert!(queue.progress("reply", "confirming", now + Duration::from_secs(100)));
        assert!(queue.timed_out(now + TOTAL_TIMEOUT));
        queue.finish(false, now);
        assert!(!queue.progress("reply", "late", now));
    }
}
