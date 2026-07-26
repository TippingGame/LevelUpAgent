//! Small deterministic state machine inspired by pi's explicit turn events.
//! Persistence and provider execution remain outside this pure transition
//! function so every transition can be tested without credentials or network.

use thiserror::Error;

use super::types::{RuntimeEvent, RuntimeState};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RuntimeError {
    #[error("invalid harness transition from {state:?} on {event:?}")]
    Invalid {
        state: RuntimeState,
        event: RuntimeEvent,
    },
    #[error("terminal harness state cannot transition")]
    Terminal,
}

pub fn transition(state: RuntimeState, event: RuntimeEvent) -> Result<RuntimeState, RuntimeError> {
    use RuntimeEvent as E;
    use RuntimeState as S;

    let next = match (&state, &event) {
        (S::NeedsConfiguration, E::DraftUpdated) => S::DraftSaved,
        (S::DraftSaved, E::PreflightBlocked) => S::NeedsConfiguration,
        (S::DraftSaved, E::PreflightReady) => S::Compiling,
        (S::NeedsConfiguration, E::PreflightReady) => S::Compiling,
        (S::Compiling, E::SnapshotCommitted) => S::Running,
        (S::Running, E::ApprovalRequired) => S::AwaitingApproval,
        (S::AwaitingApproval, E::ApprovalResolved) => S::Running,
        (S::Running, E::CompactionRequired) => S::Compacting,
        (S::Compacting, E::CompactionCommitted) => S::Running,
        (S::Running, E::ProviderStepFinished) => S::Persisting,
        (
            S::Persisting,
            E::SavePointCommitted {
                continue_work: true,
            },
        ) => S::Running,
        (
            S::Persisting,
            E::SavePointCommitted {
                continue_work: false,
            },
        ) => S::Completed,
        (S::Interrupted, E::Resume) => S::Compiling,
        (
            S::Compiling | S::Running | S::AwaitingApproval | S::Compacting | S::Persisting,
            E::Crash,
        ) => S::Interrupted,
        (S::Compiling | S::Running, E::Fail) => S::Failed,
        (
            S::DraftSaved
            | S::NeedsConfiguration
            | S::Compiling
            | S::Running
            | S::AwaitingApproval
            | S::Compacting
            | S::Persisting
            | S::Interrupted,
            E::Cancel,
        ) => S::Cancelled,
        (S::Completed | S::Failed | S::Cancelled, _) => return Err(RuntimeError::Terminal),
        _ => return Err(RuntimeError::Invalid { state, event }),
    };
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_tool_turn_reaches_completed() {
        let state = transition(RuntimeState::DraftSaved, RuntimeEvent::PreflightReady).unwrap();
        let state = transition(state, RuntimeEvent::SnapshotCommitted).unwrap();
        let state = transition(state, RuntimeEvent::ProviderStepFinished).unwrap();
        let state = transition(
            state,
            RuntimeEvent::SavePointCommitted {
                continue_work: false,
            },
        )
        .unwrap();
        assert_eq!(state, RuntimeState::Completed);
    }

    #[test]
    fn configuration_changes_return_to_the_saved_draft() {
        let state = transition(RuntimeState::DraftSaved, RuntimeEvent::PreflightBlocked).unwrap();
        assert_eq!(
            transition(state, RuntimeEvent::DraftUpdated).unwrap(),
            RuntimeState::DraftSaved
        );
    }

    #[test]
    fn approval_and_cancel_are_idempotence_boundaries() {
        let state = transition(RuntimeState::Running, RuntimeEvent::ApprovalRequired).unwrap();
        let state = transition(state, RuntimeEvent::ApprovalResolved).unwrap();
        assert_eq!(
            transition(state, RuntimeEvent::Cancel).unwrap(),
            RuntimeState::Cancelled
        );
        assert_eq!(
            transition(RuntimeState::Cancelled, RuntimeEvent::Cancel),
            Err(RuntimeError::Terminal)
        );
    }

    #[test]
    fn crash_never_jumps_directly_to_running() {
        let state = transition(RuntimeState::Running, RuntimeEvent::Crash).unwrap();
        assert_eq!(state, RuntimeState::Interrupted);
        assert_eq!(
            transition(state, RuntimeEvent::Resume).unwrap(),
            RuntimeState::Compiling
        );
    }
}
