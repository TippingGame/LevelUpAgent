//! Batch 0/1 harness primitives.
//!
//! The shape of this module deliberately follows the small, composable pieces
//! used by the upstream projects instead of importing their TUI or provider
//! stacks. The interrupt and compaction invariants are adapted from jcode
//! (MIT), the event/turn boundaries from pi (MIT), and the workspace/tool
//! separation from grok-build (Apache-2.0). See `THIRD_PARTY_NOTICES.md`.

#![allow(dead_code)]

pub mod context;
pub mod interrupt;
pub mod persistence;
pub mod policy;
pub mod preflight;
pub mod runtime;
pub mod types;

pub use policy::evaluate_tool_call;
pub use preflight::run as preflight;
