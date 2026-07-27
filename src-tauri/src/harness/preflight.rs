//! Deterministic draft preflight before a Provider request is created.

use std::path::Path;

use crate::models::{ProviderProfile, ProviderSettings};

use super::types::{HarnessDraftRequest, HarnessMode, PermissionLevel, PreflightReport};

pub fn run(
    request: &HarnessDraftRequest,
    workspace: &Path,
    settings: Option<&ProviderSettings>,
    credential_available: impl Fn(&ProviderProfile) -> bool,
) -> PreflightReport {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if request.thread_id.trim().is_empty() {
        errors.push("thread_id is required".to_owned());
    }
    if request.raw_user_input.trim().is_empty() && request.attachment_ids.is_empty() {
        errors.push("draft must contain text or at least one attachment".to_owned());
    }
    if !workspace.is_dir() {
        errors.push("workspace must exist and be a directory".to_owned());
    } else if workspace.is_symlink() {
        errors.push("workspace symlinks are not accepted by the harness".to_owned());
    }

    let selected_profile = settings.and_then(|settings| {
        request
            .requested_profile_id
            .as_deref()
            .or(Some(settings.active_profile_id.as_str()))
            .and_then(|id| settings.profiles.iter().find(|profile| profile.id == id))
    });
    if settings.is_none() {
        errors.push("no Provider settings are configured".to_owned());
    } else if selected_profile.is_none() {
        errors.push("requested Provider profile is not configured".to_owned());
    }
    if let Some(profile) = selected_profile {
        if profile.model.trim().is_empty() {
            errors.push("Provider model is empty".to_owned());
        }
        if profile.base_url.trim().is_empty() {
            errors.push("Provider base URL is empty".to_owned());
        }
        if !profile.allow_unauthenticated && !credential_available(profile) {
            errors.push("Provider credential is unavailable".to_owned());
        }
        if matches!(request.permission_level, PermissionLevel::Full) {
            warnings.push("full permission requires an explicit user confirmation".to_owned());
        }
    }
    if matches!(request.mode, HarnessMode::Chat)
        && !matches!(request.permission_level, PermissionLevel::Request)
    {
        warnings.push("chat mode ignores side-effect permission levels".to_owned());
    }

    PreflightReport {
        ok: errors.is_empty(),
        workspace: workspace.to_string_lossy().into_owned(),
        selected_profile_id: selected_profile.map(|profile| profile.id.clone()),
        mode: request.mode,
        permission_level: request.permission_level,
        errors,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::models::{ProviderProfile, ProviderProtocol};

    fn settings() -> ProviderSettings {
        ProviderSettings {
            profiles: vec![ProviderProfile {
                id: "test".to_owned(),
                name: "Test".to_owned(),
                base_url: "https://example.invalid".to_owned(),
                model: "test-model".to_owned(),
                protocol: ProviderProtocol::OpenaiResponses,
                allow_unauthenticated: false,
                priority: 1,
                failover_enabled: false,
            }],
            active_profile_id: "test".to_owned(),
        }
    }

    fn request() -> HarnessDraftRequest {
        HarnessDraftRequest {
            thread_id: "thread-1".to_owned(),
            raw_user_input: "hello".to_owned(),
            attachment_ids: Vec::new(),
            mode: HarnessMode::Agent,
            permission_level: PermissionLevel::Request,
            requested_profile_id: None,
            workspace: Some("workspace".to_owned()),
        }
    }

    #[test]
    fn missing_credential_blocks_preflight() {
        let report = run(&request(), Path::new("."), Some(&settings()), |_| false);
        assert!(!report.ok);
        assert!(
            report
                .errors
                .iter()
                .any(|error| error.contains("credential"))
        );
    }

    #[test]
    fn valid_workspace_and_credential_pass() {
        let workspace = PathBuf::from(".");
        let report = run(&request(), &workspace, Some(&settings()), |_| true);
        assert!(report.ok, "{:?}", report.errors);
        assert_eq!(report.selected_profile_id.as_deref(), Some("test"));
    }
}
