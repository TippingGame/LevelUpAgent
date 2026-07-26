//! Cooperative interruption primitive for a harness operation.
//!
//! The epoch/reset behavior is adapted from jcode's `InterruptSignal` (MIT).
//! It prevents a late notification from cancelling a newer operation after a
//! stop/resume boundary.

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use tokio::sync::Notify;

#[derive(Clone, Debug)]
pub struct InterruptSignal {
    interrupted: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    notify: Arc<Notify>,
}

impl Default for InterruptSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl InterruptSignal {
    pub fn new() -> Self {
        Self {
            interrupted: Arc::new(AtomicBool::new(false)),
            epoch: Arc::new(AtomicU64::new(0)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn fire(&self) -> u64 {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.interrupted.store(true, Ordering::Release);
        self.notify.notify_waiters();
        epoch
    }

    pub fn is_set(&self) -> bool {
        self.interrupted.load(Ordering::Acquire)
    }

    pub fn current_epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    pub fn reset(&self) {
        self.interrupted.store(false, Ordering::Release);
    }

    pub fn reset_if_epoch(&self, observed_epoch: u64) -> bool {
        if self.current_epoch() != observed_epoch {
            return false;
        }
        self.interrupted.store(false, Ordering::Release);
        if self.current_epoch() == observed_epoch {
            true
        } else {
            self.interrupted.store(true, Ordering::Release);
            false
        }
    }

    pub async fn notified(&self) {
        self.notify.notified().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fire_notifies_and_epoch_guards_reset() {
        let signal = InterruptSignal::new();
        let waiter = signal.clone();
        let pending = tokio::spawn(async move {
            waiter.notified().await;
            waiter.is_set()
        });
        tokio::task::yield_now().await;

        let first = signal.fire();
        assert!(pending.await.unwrap());
        assert!(signal.is_set());
        assert!(signal.reset_if_epoch(first));
        assert!(!signal.is_set());

        let second = signal.fire();
        assert!(!signal.reset_if_epoch(first));
        assert!(signal.reset_if_epoch(second));
        assert!(!signal.is_set());
    }
}
