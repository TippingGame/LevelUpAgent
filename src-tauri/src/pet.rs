use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::pet_life::{
    PetKnowledgeInput, PetLearningQuest, PetLifeSettings, PetLifeSnapshot, StoredPetLife,
};

const DEFAULT_PET_ID: &str = "yui";
const STATE_VERSION: u32 = 3;
const SPRITESHEET_WIDTH: usize = 1_536;
const SPRITESHEET_HEIGHT: usize = 1_872;
const MAX_SPRITESHEET_BYTES: u64 = 24 * 1024 * 1024;
const MAX_SEEN_USAGE_IDS: usize = 20_000;
const MAX_MEMORIES_PER_PET: usize = 100;
const PET_BACKUP_VERSION: u32 = 1;
const MAX_BACKUP_JSON_BYTES: u64 = 8 * 1024 * 1024;
const PET_WINDOW_WIDTH: f64 = 430.0;
const PET_WINDOW_HEIGHT: f64 = 580.0;
const DEFAULT_PET_SCALE: f64 = 0.75;
const MIN_PET_SCALE: f64 = 0.55;
const MAX_PET_SCALE: f64 = 1.45;
const PET_SCALE_UNITS: f64 = 1_000.0;
static ACTIVE_PET_SCALE: AtomicU32 = AtomicU32::new(750);
static PET_PROMPT_VISIBLE: AtomicBool = AtomicBool::new(false);
const DEFAULT_MANIFEST: &[u8] = include_bytes!("../resources/pets/yui/pet.json");
const DEFAULT_SPRITESHEET: &[u8] = include_bytes!("../resources/pets/yui/spritesheet.webp");

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetManifest {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    pub spritesheet_path: String,
    #[serde(default)]
    pub personality: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetProfile {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub spritesheet_path: String,
    pub personality: Option<String>,
    pub removable: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredPetProgress {
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    requests: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetMemory {
    pub id: String,
    pub text: String,
    pub kind: String,
    pub confidence: f64,
    pub evidence_count: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredPetState {
    #[serde(default = "state_version")]
    version: u32,
    #[serde(default = "default_pet_id")]
    active_pet_id: String,
    #[serde(default = "default_overlay_visible")]
    overlay_visible: bool,
    #[serde(default)]
    progress: BTreeMap<String, StoredPetProgress>,
    #[serde(default)]
    seen_usage_ids: Vec<String>,
    #[serde(default)]
    memories: BTreeMap<String, Vec<PetMemory>>,
    #[serde(default)]
    scales: BTreeMap<String, f64>,
    #[serde(default)]
    life: BTreeMap<String, StoredPetLife>,
}

impl Default for StoredPetState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            active_pet_id: DEFAULT_PET_ID.to_owned(),
            overlay_visible: true,
            progress: BTreeMap::new(),
            seen_usage_ids: Vec::new(),
            memories: BTreeMap::new(),
            scales: BTreeMap::new(),
            life: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetProgress {
    pub pet_id: String,
    pub level: u64,
    pub total_xp: u64,
    pub current_xp: u64,
    pub required_xp: u64,
    pub progress: f64,
    pub total_tokens: u64,
    pub requests: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetDashboard {
    pub pets: Vec<PetProfile>,
    pub active_pet_id: String,
    pub progress: PetProgress,
    pub memories: Vec<PetMemory>,
    pub overlay_visible: bool,
    pub scale: f64,
    pub life: PetLifeSnapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetBackupData {
    version: u32,
    exported_at: i64,
    pet_id: String,
    progress: StoredPetProgress,
    memories: Vec<PetMemory>,
    scale: f64,
    life: StoredPetLife,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBackupResult {
    pub pet_id: String,
    pub destination: String,
    pub exported_at: i64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetActivity {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub state: String,
}

#[derive(Default)]
pub struct PetRuntime {
    activities: Mutex<Vec<PetActivity>>,
}

impl PetRuntime {
    pub fn activities(&self) -> Result<Vec<PetActivity>, String> {
        self.activities
            .lock()
            .map(|items| items.clone())
            .map_err(|_| "Could not lock desktop pet activity state".to_owned())
    }

    pub fn replace(&self, activities: Vec<PetActivity>) -> Result<Vec<PetActivity>, String> {
        let normalized = activities
            .into_iter()
            .take(12)
            .filter_map(normalize_activity)
            .collect::<Vec<_>>();
        *self
            .activities
            .lock()
            .map_err(|_| "Could not lock desktop pet activity state".to_owned())? =
            normalized.clone();
        Ok(normalized)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetRuntimeSnapshot {
    pub dashboard: PetDashboard,
    pub activities: Vec<PetActivity>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HatchRequirement {
    pub id: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HatchEnvironment {
    pub configured: bool,
    pub bundled: bool,
    pub codex_home: String,
    pub hatch_skill_path: Option<String>,
    pub imagegen_skill_path: Option<String>,
    pub python_command: Option<String>,
    pub work_directory: String,
    pub package_directory: String,
    pub missing: Vec<HatchRequirement>,
}

pub struct PetManager {
    root: PathBuf,
    state_path: PathBuf,
    codex_home: PathBuf,
    built_in_skills: Option<PathBuf>,
    work_directory: PathBuf,
    state: Mutex<StoredPetState>,
}

impl PetManager {
    #[cfg(test)]
    pub fn open(app_data: &Path, home: &Path) -> Result<Self, String> {
        Self::open_with_skills(app_data, home, None)
    }

    pub fn open_with_skills(
        app_data: &Path,
        home: &Path,
        built_in_skills: Option<&Path>,
    ) -> Result<Self, String> {
        let root = app_data.join("pets");
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create desktop pet storage: {error}"))?;
        crate::filesystem::restrict_directory(&root)?;
        ensure_default_pet(&root)?;

        let state_path = app_data.join("pet-state.json");
        let state = load_state(&state_path)?;
        update_runtime_pet_scale(scale_for(&state, &state.active_pet_id));
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let work_directory = app_data.join("pet-hatch");
        Ok(Self {
            root,
            state_path,
            codex_home,
            built_in_skills: built_in_skills.map(Path::to_path_buf),
            work_directory,
            state: Mutex::new(state),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn overlay_visible(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.overlay_visible)
            .unwrap_or(true)
    }

    pub fn dashboard(&self) -> Result<PetDashboard, String> {
        let pets = self.list_profiles()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Could not lock desktop pet state".to_owned())?;
        if !pets.iter().any(|pet| pet.id == state.active_pet_id) {
            state.active_pet_id = DEFAULT_PET_ID.to_owned();
            save_state(&self.state_path, &state)?;
        }
        let active_pet_id = state.active_pet_id.clone();
        let progress = progress_for(
            &active_pet_id,
            state
                .progress
                .get(&active_pet_id)
                .cloned()
                .unwrap_or_default(),
        );
        let memories = state
            .memories
            .get(&active_pet_id)
            .cloned()
            .unwrap_or_default();
        let display_name = pets
            .iter()
            .find(|pet| pet.id == active_pet_id)
            .map(|pet| pet.display_name.as_str())
            .unwrap_or("Starlight Echo");
        let now = now_millis();
        let (life, life_changed) = {
            let life = state
                .life
                .entry(active_pet_id.clone())
                .or_insert_with(|| StoredPetLife::new(now));
            let changed = life.tick(now, display_name, &memories);
            (life.snapshot(now), changed)
        };
        PET_PROMPT_VISIBLE.store(life.prompt.is_some(), Ordering::Relaxed);
        if life_changed {
            save_state(&self.state_path, &state)?;
        }
        let scale = scale_for(&state, &active_pet_id);
        update_runtime_pet_scale(scale);
        Ok(PetDashboard {
            pets,
            active_pet_id,
            progress,
            memories,
            overlay_visible: state.overlay_visible,
            scale,
            life,
        })
    }

    pub fn set_active(&self, pet_id: &str) -> Result<PetDashboard, String> {
        validate_pet_id(pet_id)?;
        if !self.root.join(pet_id).is_dir() {
            return Err("The selected Starlight Echo is not installed".to_owned());
        }
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Could not lock desktop pet state".to_owned())?;
            state.active_pet_id = pet_id.to_owned();
            save_state(&self.state_path, &state)?;
        }
        self.dashboard()
    }

    pub fn set_overlay_visible(&self, visible: bool) -> Result<PetDashboard, String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Could not lock desktop pet state".to_owned())?;
            state.overlay_visible = visible;
            save_state(&self.state_path, &state)?;
        }
        self.dashboard()
    }

    pub fn set_scale(&self, pet_id: &str, scale: f64) -> Result<PetDashboard, String> {
        validate_pet_id(pet_id)?;
        if !scale.is_finite() {
            return Err("Afterimage scale must be a finite number".to_owned());
        }
        if !self.root.join(pet_id).is_dir() {
            return Err("The selected afterimage is not installed".to_owned());
        }
        let scale = scale.clamp(MIN_PET_SCALE, MAX_PET_SCALE);
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Could not lock afterimage state".to_owned())?;
            state.scales.insert(pet_id.to_owned(), scale);
            if state.active_pet_id == pet_id {
                update_runtime_pet_scale(scale);
            }
            save_state(&self.state_path, &state)?;
        }
        self.dashboard()
    }

    pub fn regenerate_daily_plan(&self, pet_id: &str) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, display_name, memories| {
            life.generate_daily_plan(now, display_name, memories, true);
            Ok(())
        })
    }

    pub fn toggle_study(&self, pet_id: &str, source: &str) -> Result<PetDashboard, String> {
        let source = source.trim().chars().take(40).collect::<String>();
        self.mutate_life(pet_id, |life, now, _, _| {
            life.toggle_study(now, &source);
            Ok(())
        })
    }

    pub fn add_task(
        &self,
        pet_id: &str,
        title: &str,
        notes: &str,
        due_date: Option<&str>,
        recurrence: Option<&str>,
        priority: u8,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            life.add_task(now, title, notes, due_date, recurrence, priority)?;
            Ok(())
        })
    }

    pub fn set_task_completed(
        &self,
        pet_id: &str,
        task_id: &str,
        completed: bool,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            if life.set_task_completed(now, task_id, completed) {
                Ok(())
            } else {
                Err("The selected echo task was not found".to_owned())
            }
        })
    }

    pub fn delete_task(&self, pet_id: &str, task_id: &str) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            if life.delete_task(now, task_id) {
                Ok(())
            } else {
                Err("The selected echo task was not found".to_owned())
            }
        })
    }

    pub fn complete_schedule_item(
        &self,
        pet_id: &str,
        item_id: &str,
        completed: bool,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            if life.complete_schedule_item(now, item_id, completed) {
                Ok(())
            } else {
                Err("The selected schedule item was not found".to_owned())
            }
        })
    }

    pub fn check_in(&self, pet_id: &str) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            life.check_in(now)?;
            Ok(())
        })
    }

    pub fn bond_with_user(&self, pet_id: &str) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            life.bond_with_user(now);
            Ok(())
        })
    }

    pub fn respond_to_prompt(
        &self,
        pet_id: &str,
        prompt_id: &str,
        action: &str,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            life.respond_to_prompt(now, prompt_id, action)
        })
    }

    pub fn record_knowledge(
        &self,
        pet_id: &str,
        input: PetKnowledgeInput<'_>,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            life.record_knowledge(now, input)?;
            Ok(())
        })
    }

    pub fn claim_learning_quest(&self, pet_id: &str) -> Result<Option<PetLearningQuest>, String> {
        validate_pet_id(pet_id)?;
        let pets = self.list_profiles()?;
        let profile = pets
            .iter()
            .find(|pet| pet.id == pet_id)
            .ok_or_else(|| "The selected Starlight Echo is not installed".to_owned())?;
        let now = now_millis();
        let claimed = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Could not lock Starlight Echo state".to_owned())?;
            let memories = state.memories.get(pet_id).cloned().unwrap_or_default();
            let life = state
                .life
                .entry(pet_id.to_owned())
                .or_insert_with(|| StoredPetLife::new(now));
            life.tick(now, &profile.display_name, &memories);
            let claimed = life.claim_learning_quest(now);
            if claimed.is_some() {
                save_state(&self.state_path, &state)?;
            }
            claimed
        };
        Ok(claimed)
    }

    pub fn complete_learning_quest(
        &self,
        pet_id: &str,
        quest_id: &str,
        input: PetKnowledgeInput<'_>,
        provider_id: Option<&str>,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            life.complete_learning_quest(now, quest_id, input, provider_id)?;
            Ok(())
        })
    }

    pub fn fail_learning_quest(
        &self,
        pet_id: &str,
        quest_id: &str,
        error: &str,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            if life.fail_learning_quest(now, quest_id, error) {
                Ok(())
            } else {
                Err("The autonomous learning question is no longer active".to_owned())
            }
        })
    }

    pub fn delete_knowledge(
        &self,
        pet_id: &str,
        knowledge_id: &str,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            if life.delete_knowledge(now, knowledge_id) {
                Ok(())
            } else {
                Err("The selected knowledge entry was not found".to_owned())
            }
        })
    }

    pub fn settle_day(&self, pet_id: &str, reflection: &str) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, now, _, _| {
            life.settle_day(now, reflection);
            Ok(())
        })
    }

    pub fn update_life_settings(
        &self,
        pet_id: &str,
        settings: PetLifeSettings,
    ) -> Result<PetDashboard, String> {
        self.mutate_life(pet_id, |life, _, _, _| {
            life.update_settings(settings);
            Ok(())
        })
    }

    pub fn set_window_position(&self, pet_id: &str, x: f64, y: f64) -> Result<(), String> {
        self.mutate_life(pet_id, |life, _, _, _| {
            if life.set_window_position(x, y) {
                Ok(())
            } else {
                Err("Starlight Echo window position must be finite".to_owned())
            }
        })?;
        Ok(())
    }

    pub fn export_backup(
        &self,
        pet_id: &str,
        destination: &Path,
    ) -> Result<PetBackupResult, String> {
        validate_pet_id(pet_id)?;
        let package = self.root.join(pet_id);
        let (manifest, manifest_bytes, spritesheet) = validate_package(&package)?;
        if manifest.id != pet_id {
            return Err("The selected echo package ID does not match its directory".to_owned());
        }
        let now = now_millis();
        let backup = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Could not lock Starlight Echo state".to_owned())?;
            let memories = state.memories.get(pet_id).cloned().unwrap_or_default();
            let life = state
                .life
                .entry(pet_id.to_owned())
                .or_insert_with(|| StoredPetLife::new(now));
            life.normalize(now);
            PetBackupData {
                version: PET_BACKUP_VERSION,
                exported_at: now,
                pet_id: pet_id.to_owned(),
                progress: state.progress.get(pet_id).cloned().unwrap_or_default(),
                memories,
                scale: scale_for(&state, pet_id),
                life: state
                    .life
                    .get(pet_id)
                    .cloned()
                    .unwrap_or_else(|| StoredPetLife::new(now)),
            }
        };
        write_pet_backup(
            destination,
            &backup,
            &manifest.spritesheet_path,
            &manifest_bytes,
            &spritesheet,
        )?;
        let bytes = std::fs::metadata(destination)
            .map(|metadata| metadata.len())
            .unwrap_or_default();
        Ok(PetBackupResult {
            pet_id: pet_id.to_owned(),
            destination: destination.display().to_string(),
            exported_at: now,
            bytes,
        })
    }

    pub fn import_backup(&self, source: &Path) -> Result<PetProfile, String> {
        let extracted = read_pet_backup(source)?;
        if extracted.backup.pet_id != extracted.manifest.id {
            return Err("The backup data and package IDs do not match".to_owned());
        }
        validate_pet_id(&extracted.backup.pet_id)?;
        let profile = if extracted.manifest.id == DEFAULT_PET_ID {
            let package = self.root.join(DEFAULT_PET_ID);
            let (manifest, _, _) = validate_package(&package)?;
            profile_from_manifest(&package, manifest, false)?
        } else {
            let transaction = uuid::Uuid::new_v4().simple().to_string();
            let staging = self.root.join(format!(".import-{transaction}.tmp"));
            std::fs::create_dir(&staging)
                .map_err(|error| format!("Could not stage Starlight Echo backup: {error}"))?;
            crate::filesystem::restrict_directory(&staging)?;
            let staged_manifest = staging.join("pet.json");
            let staged_sheet = staging.join(&extracted.manifest.spritesheet_path);
            let stage_result = (|| {
                std::fs::write(&staged_manifest, &extracted.manifest_bytes)
                    .map_err(|error| format!("Could not stage backup manifest: {error}"))?;
                std::fs::write(&staged_sheet, &extracted.spritesheet_bytes)
                    .map_err(|error| format!("Could not stage backup spritesheet: {error}"))?;
                crate::filesystem::restrict_file(&staged_manifest)?;
                crate::filesystem::restrict_file(&staged_sheet)?;
                self.install_package(&staging, true)
            })();
            let _ = std::fs::remove_dir_all(&staging);
            stage_result?
        };
        {
            let mut life = extracted.backup.life;
            life.normalize(now_millis());
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Could not lock Starlight Echo state".to_owned())?;
            let pet_id = extracted.backup.pet_id;
            state
                .progress
                .insert(pet_id.clone(), extracted.backup.progress);
            state
                .memories
                .insert(pet_id.clone(), extracted.backup.memories);
            state.scales.insert(
                pet_id.clone(),
                extracted.backup.scale.clamp(MIN_PET_SCALE, MAX_PET_SCALE),
            );
            state.life.insert(pet_id.clone(), life);
            state.active_pet_id = pet_id;
            save_state(&self.state_path, &state)?;
        }
        Ok(profile)
    }

    fn mutate_life<F>(&self, pet_id: &str, mutation: F) -> Result<PetDashboard, String>
    where
        F: FnOnce(&mut StoredPetLife, i64, &str, &[PetMemory]) -> Result<(), String>,
    {
        validate_pet_id(pet_id)?;
        let pets = self.list_profiles()?;
        let profile = pets
            .iter()
            .find(|pet| pet.id == pet_id)
            .ok_or_else(|| "The selected Starlight Echo is not installed".to_owned())?;
        let now = now_millis();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Could not lock Starlight Echo state".to_owned())?;
            let memories = state.memories.get(pet_id).cloned().unwrap_or_default();
            let life = state
                .life
                .entry(pet_id.to_owned())
                .or_insert_with(|| StoredPetLife::new(now));
            life.tick(now, &profile.display_name, &memories);
            mutation(life, now, &profile.display_name, &memories)?;
            life.tick(now, &profile.display_name, &memories);
            save_state(&self.state_path, &state)?;
        }
        self.dashboard()
    }

    pub fn record_usage(
        &self,
        pet_id: &str,
        usage_id: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<PetProgress, String> {
        validate_pet_id(pet_id)?;
        let usage_id = usage_id.trim();
        if usage_id.is_empty() || usage_id.chars().count() > 240 {
            return Err("Desktop pet usage IDs must be between 1 and 240 characters".to_owned());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Could not lock desktop pet state".to_owned())?;
        if state.seen_usage_ids.iter().any(|item| item == usage_id) {
            return Ok(progress_for(
                pet_id,
                state.progress.get(pet_id).cloned().unwrap_or_default(),
            ));
        }
        state.seen_usage_ids.push(usage_id.to_owned());
        if state.seen_usage_ids.len() > MAX_SEEN_USAGE_IDS {
            let remove = state.seen_usage_ids.len() - MAX_SEEN_USAGE_IDS;
            state.seen_usage_ids.drain(0..remove);
        }
        let progress = state.progress.entry(pet_id.to_owned()).or_default();
        progress.total_tokens = progress
            .total_tokens
            .saturating_add(input_tokens)
            .saturating_add(output_tokens);
        progress.requests = progress.requests.saturating_add(1);
        let output = progress_for(pet_id, progress.clone());
        save_state(&self.state_path, &state)?;
        Ok(output)
    }

    pub fn learn_from_message(&self, pet_id: &str, text: &str) -> Result<Vec<PetMemory>, String> {
        validate_pet_id(pet_id)?;
        let Some((memory_text, kind, confidence)) = memory_candidate(text) else {
            return self.memories(pet_id);
        };
        let canonical = canonical_memory(&memory_text);
        let now = now_millis();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Could not lock desktop pet state".to_owned())?;
        let memories = state.memories.entry(pet_id.to_owned()).or_default();
        if let Some(existing) = memories
            .iter_mut()
            .find(|memory| canonical_memory(&memory.text) == canonical)
        {
            existing.evidence_count = existing.evidence_count.saturating_add(1);
            existing.confidence = (existing.confidence + 0.12).min(1.0);
            existing.updated_at = now;
        } else {
            memories.push(PetMemory {
                id: uuid::Uuid::new_v4().to_string(),
                text: memory_text,
                kind,
                confidence,
                evidence_count: 1,
                created_at: now,
                updated_at: now,
            });
        }
        if memories.len() > MAX_MEMORIES_PER_PET {
            let remove = memories.len() - MAX_MEMORIES_PER_PET;
            memories.drain(0..remove);
        }
        let output = memories.clone();
        save_state(&self.state_path, &state)?;
        Ok(output)
    }

    pub fn memories(&self, pet_id: &str) -> Result<Vec<PetMemory>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Could not lock desktop pet state".to_owned())?;
        Ok(state.memories.get(pet_id).cloned().unwrap_or_default())
    }

    pub fn delete_memory(&self, pet_id: &str, memory_id: &str) -> Result<bool, String> {
        validate_pet_id(pet_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Could not lock desktop pet state".to_owned())?;
        let Some(memories) = state.memories.get_mut(pet_id) else {
            return Ok(false);
        };
        let previous = memories.len();
        memories.retain(|memory| memory.id != memory_id);
        let removed = memories.len() != previous;
        if removed {
            save_state(&self.state_path, &state)?;
        }
        Ok(removed)
    }

    pub fn install_package(&self, source: &Path, replace: bool) -> Result<PetProfile, String> {
        let package_directory = package_directory(source)?;
        let (manifest, manifest_bytes, spritesheet) = validate_package(&package_directory)?;
        if manifest.id == DEFAULT_PET_ID {
            return Err("The built-in Yui package cannot be replaced".to_owned());
        }
        let destination = self.root.join(&manifest.id);
        if let Ok(metadata) = std::fs::symlink_metadata(&destination)
            && (!metadata.is_dir() || metadata.file_type().is_symlink())
        {
            return Err("Installed desktop pet storage is not a regular directory".to_owned());
        }
        if destination.exists() && !replace {
            return Err(format!(
                "A Starlight Echo named {} is already installed",
                manifest.id
            ));
        }

        let transaction = uuid::Uuid::new_v4().simple().to_string();
        let temporary = self
            .root
            .join(format!(".{}.{}.tmp", manifest.id, transaction));
        std::fs::create_dir(&temporary)
            .map_err(|error| format!("Could not stage desktop pet package: {error}"))?;
        crate::filesystem::restrict_directory(&temporary)?;
        let stage_result = (|| {
            let manifest_target = temporary.join("pet.json");
            std::fs::write(&manifest_target, manifest_bytes)
                .map_err(|error| format!("Could not stage pet.json: {error}"))?;
            crate::filesystem::restrict_file(&manifest_target)?;
            let sheet_target = temporary.join(&manifest.spritesheet_path);
            std::fs::copy(&spritesheet, &sheet_target)
                .map_err(|error| format!("Could not stage desktop pet spritesheet: {error}"))?;
            crate::filesystem::restrict_file(&sheet_target)?;
            Ok::<(), String>(())
        })();
        if let Err(error) = stage_result {
            let _ = std::fs::remove_dir_all(&temporary);
            return Err(error);
        }

        let backup = self
            .root
            .join(format!(".{}.{}.old", manifest.id, transaction));
        let had_previous = destination.is_dir();
        if had_previous {
            std::fs::rename(&destination, &backup)
                .map_err(|error| format!("Could not prepare desktop pet update: {error}"))?;
        }
        if let Err(error) = std::fs::rename(&temporary, &destination) {
            if had_previous {
                let _ = std::fs::rename(&backup, &destination);
            }
            let _ = std::fs::remove_dir_all(&temporary);
            return Err(format!("Could not install Starlight Echo package: {error}"));
        }
        if had_previous {
            let _ = std::fs::remove_dir_all(&backup);
        }
        profile_from_manifest(&destination, manifest, true)
    }

    pub fn remove_package(&self, pet_id: &str) -> Result<bool, String> {
        validate_pet_id(pet_id)?;
        if pet_id == DEFAULT_PET_ID {
            return Err("The built-in Yui pet cannot be removed".to_owned());
        }
        let destination = self.root.join(pet_id);
        let metadata = match std::fs::symlink_metadata(&destination) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("Could not inspect desktop pet package: {error}")),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Starlight Echo package storage is not a regular directory".to_owned());
        }
        std::fs::remove_dir_all(&destination)
            .map_err(|error| format!("Could not remove desktop pet package: {error}"))?;
        let should_reset = self
            .state
            .lock()
            .map_err(|_| "Could not lock desktop pet state".to_owned())?
            .active_pet_id
            == pet_id;
        if should_reset {
            let _ = self.set_active(DEFAULT_PET_ID)?;
        }
        Ok(true)
    }

    pub fn hatch_environment(&self) -> HatchEnvironment {
        let hatch_skill_path = self
            .built_in_skills
            .as_ref()
            .map(|root| root.join("hatch-pet"))
            .filter(|path| path.join("SKILL.md").is_file());
        let imagegen_skill_path = self
            .built_in_skills
            .as_ref()
            .map(|root| root.join("imagegen"))
            .filter(|path| path.join("SKILL.md").is_file());
        let python_command = detect_python();
        let mut missing = Vec::new();
        if hatch_skill_path.is_none() {
            missing.push(HatchRequirement {
                id: "hatch_skill".to_owned(),
                detail: self
                    .built_in_skills
                    .as_deref()
                    .unwrap_or_else(|| Path::new("resources/skills"))
                    .join("hatch-pet")
                    .display()
                    .to_string(),
            });
        }
        if imagegen_skill_path.is_none() {
            missing.push(HatchRequirement {
                id: "imagegen_skill".to_owned(),
                detail: self
                    .built_in_skills
                    .as_deref()
                    .unwrap_or_else(|| Path::new("resources/skills"))
                    .join("imagegen")
                    .display()
                    .to_string(),
            });
        }
        if python_command.is_none() {
            missing.push(HatchRequirement {
                id: "python".to_owned(),
                detail: "Python 3.10 or newer".to_owned(),
            });
        }
        HatchEnvironment {
            configured: missing.is_empty(),
            bundled: self.built_in_skills.as_ref().is_some_and(|root| {
                root.join("hatch-pet").join("SKILL.md").is_file()
                    && root.join("imagegen").join("SKILL.md").is_file()
            }),
            codex_home: self.codex_home.display().to_string(),
            hatch_skill_path: hatch_skill_path.map(|path| path.display().to_string()),
            imagegen_skill_path: imagegen_skill_path.map(|path| path.display().to_string()),
            python_command,
            work_directory: self.work_directory.display().to_string(),
            package_directory: self.codex_home.join("pets").display().to_string(),
            missing,
        }
    }

    pub fn configure_hatch(&self) -> Result<HatchEnvironment, String> {
        std::fs::create_dir_all(&self.work_directory)
            .map_err(|error| format!("Could not create pet generation workspace: {error}"))?;
        crate::filesystem::restrict_directory(&self.work_directory)?;
        let package_directory = self.codex_home.join("pets");
        std::fs::create_dir_all(&package_directory)
            .map_err(|error| format!("Could not create Codex pet package directory: {error}"))?;
        let environment = self.hatch_environment();
        let config_path = self.work_directory.join("levelup-pet-hatch.json");
        let bytes = serde_json::to_vec_pretty(&environment).map_err(|error| {
            format!("Could not serialize pet generation configuration: {error}")
        })?;
        std::fs::write(&config_path, bytes)
            .map_err(|error| format!("Could not save pet generation configuration: {error}"))?;
        crate::filesystem::restrict_file(&config_path)?;
        Ok(environment)
    }

    pub fn import_discovered(&self, after_ms: i64) -> Result<Vec<PetProfile>, String> {
        let package_root = self.codex_home.join("pets");
        let entries = match std::fs::read_dir(&package_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("Could not scan Codex pet packages: {error}")),
        };
        let mut installed = Vec::new();
        for entry in entries.flatten() {
            let source = entry.path();
            if !source.is_dir() {
                continue;
            }
            let Ok((manifest, _, spritesheet)) = validate_package(&source) else {
                continue;
            };
            if manifest.id == DEFAULT_PET_ID {
                continue;
            }
            let destination_exists = self.root.join(&manifest.id).is_dir();
            if after_ms <= 0 && destination_exists {
                continue;
            }
            if after_ms > 0 {
                let modified = package_modified_ms(&source.join("pet.json"), &spritesheet);
                if modified.saturating_add(120_000) < after_ms {
                    continue;
                }
            }
            if let Ok(profile) = self.install_package(&source, destination_exists) {
                installed.push(profile);
            }
        }
        installed.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        Ok(installed)
    }

    fn list_profiles(&self) -> Result<Vec<PetProfile>, String> {
        let entries = std::fs::read_dir(&self.root)
            .map_err(|error| format!("Could not list desktop pets: {error}"))?;
        let mut pets = Vec::new();
        for entry in entries.flatten() {
            let directory = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&directory) else {
                continue;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            let Ok((manifest, _, _)) = validate_package(&directory) else {
                continue;
            };
            pets.push(profile_from_manifest(
                &directory,
                manifest.clone(),
                manifest.id != DEFAULT_PET_ID,
            )?);
        }
        pets.sort_by(|left, right| {
            (left.id != DEFAULT_PET_ID)
                .cmp(&(right.id != DEFAULT_PET_ID))
                .then_with(|| left.display_name.cmp(&right.display_name))
        });
        if pets.iter().all(|pet| pet.id != DEFAULT_PET_ID) {
            return Err("The built-in Yui Starlight Echo is unavailable".to_owned());
        }
        Ok(pets)
    }
}

pub fn create_window(app: &tauri::AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("pet") {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("LevelUpAgent Starlight Echo")
        .inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(visible)
        .build()
        .map_err(|error| format!("Could not create Starlight Echo window: {error}"))?;
    if let Ok(Some(monitor)) = window.current_monitor()
        && let Ok(size) = window.outer_size()
    {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let x = monitor_position.x
            + monitor_size
                .width
                .saturating_sub(size.width)
                .saturating_sub(24) as i32;
        let y = monitor_position.y
            + monitor_size
                .height
                .saturating_sub(size.height)
                .saturating_sub(52) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    install_mouse_passthrough(&window)?;
    Ok(window)
}

#[cfg(windows)]
fn install_mouse_passthrough(window: &WebviewWindow) -> Result<(), String> {
    use std::time::Duration;
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, IsWindow};

    let native_handle = window
        .hwnd()
        .map_err(|error| format!("Could not access the desktop pet window handle: {error}"))?
        .0 as isize;
    let window = window.clone();
    std::thread::Builder::new()
        .name("levelup-pet-mouse-passthrough".to_owned())
        .spawn(move || {
            let hwnd = HWND(native_handle as *mut std::ffi::c_void);
            let mut ignored = None;
            loop {
                if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
                    break;
                }
                let mut point = POINT::default();
                let mut bounds = RECT::default();
                let readable = unsafe {
                    GetCursorPos(&mut point).is_ok() && GetWindowRect(hwnd, &mut bounds).is_ok()
                };
                if readable {
                    let width = (bounds.right - bounds.left).max(1) as f64;
                    let height = (bounds.bottom - bounds.top).max(1) as f64;
                    let x = (point.x - bounds.left) as f64 * PET_WINDOW_WIDTH / width;
                    let y = (point.y - bounds.top) as f64 * PET_WINDOW_HEIGHT / height;
                    let scale = runtime_pet_scale();
                    let character_half_width = 96.0 * scale + 12.0;
                    let character_top = PET_WINDOW_HEIGHT - 42.0 - 208.0 * scale - 12.0;
                    let over_character = ((PET_WINDOW_WIDTH / 2.0 - character_half_width)
                        ..=(PET_WINDOW_WIDTH / 2.0 + character_half_width))
                        .contains(&x)
                        && (character_top..=(PET_WINDOW_HEIGHT - 28.0)).contains(&y);
                    let over_prompt = PET_PROMPT_VISIBLE.load(Ordering::Relaxed)
                        && (55.0..=(PET_WINDOW_WIDTH - 55.0)).contains(&x)
                        && ((character_top - 128.0).max(24.0)..=(character_top + 24.0).max(152.0))
                            .contains(&y);
                    let next_ignored = !(over_character || over_prompt);
                    if ignored != Some(next_ignored) {
                        if window.set_ignore_cursor_events(next_ignored).is_err() {
                            break;
                        }
                        ignored = Some(next_ignored);
                    }
                }
                std::thread::sleep(Duration::from_millis(16));
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Could not start desktop pet mouse passthrough: {error}"))
}

#[cfg(not(windows))]
fn install_mouse_passthrough(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

fn ensure_default_pet(root: &Path) -> Result<(), String> {
    let directory = root.join(DEFAULT_PET_ID);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create built-in desktop pet directory: {error}"))?;
    crate::filesystem::restrict_directory(&directory)?;
    let manifest = directory.join("pet.json");
    let spritesheet = directory.join("spritesheet.webp");
    if validate_package(&directory).is_err() {
        std::fs::write(&manifest, DEFAULT_MANIFEST)
            .map_err(|error| format!("Could not install built-in desktop pet metadata: {error}"))?;
        crate::filesystem::restrict_file(&manifest)?;
        std::fs::write(&spritesheet, DEFAULT_SPRITESHEET).map_err(|error| {
            format!("Could not install built-in desktop pet spritesheet: {error}")
        })?;
        crate::filesystem::restrict_file(&spritesheet)?;
    }
    let _ = validate_package(&directory)?;
    Ok(())
}

fn load_state(path: &Path) -> Result<StoredPetState, String> {
    if !path.is_file() {
        let state = StoredPetState::default();
        save_state(path, &state)?;
        return Ok(state);
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Could not read desktop pet state: {error}"))?;
    let mut state: StoredPetState = serde_json::from_slice(&bytes).unwrap_or_default();
    state.version = STATE_VERSION;
    if validate_pet_id(&state.active_pet_id).is_err() {
        state.active_pet_id = DEFAULT_PET_ID.to_owned();
    }
    if state.seen_usage_ids.len() > MAX_SEEN_USAGE_IDS {
        let remove = state.seen_usage_ids.len() - MAX_SEEN_USAGE_IDS;
        state.seen_usage_ids.drain(0..remove);
    }
    for memories in state.memories.values_mut() {
        memories.retain(|memory| !memory.text.trim().is_empty());
        if memories.len() > MAX_MEMORIES_PER_PET {
            let remove = memories.len() - MAX_MEMORIES_PER_PET;
            memories.drain(0..remove);
        }
    }
    state
        .scales
        .retain(|pet_id, scale| validate_pet_id(pet_id).is_ok() && scale.is_finite());
    for scale in state.scales.values_mut() {
        *scale = scale.clamp(MIN_PET_SCALE, MAX_PET_SCALE);
    }
    let now = now_millis();
    state
        .life
        .retain(|pet_id, _| validate_pet_id(pet_id).is_ok());
    for life in state.life.values_mut() {
        life.normalize(now);
    }
    Ok(state)
}

fn save_state(path: &Path, state: &StoredPetState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Could not serialize desktop pet state: {error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "Desktop pet state has no parent directory".to_owned())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create desktop pet state directory: {error}"))?;
    let transaction = uuid::Uuid::new_v4().simple().to_string();
    let temporary = parent.join(format!(".pet-state.{transaction}.tmp"));
    let backup = parent.join(format!(".pet-state.{transaction}.old"));
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not stage desktop pet state: {error}"))?;
    crate::filesystem::restrict_file(&temporary)?;
    let had_previous = path.is_file();
    if had_previous && let Err(error) = std::fs::rename(path, &backup) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "Could not prepare desktop pet state update: {error}"
        ));
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        if had_previous {
            let _ = std::fs::rename(&backup, path);
        }
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Could not commit desktop pet state: {error}"));
    }
    if had_previous {
        let _ = std::fs::remove_file(&backup);
    }
    crate::filesystem::restrict_file(path)
}

struct ExtractedPetBackup {
    backup: PetBackupData,
    manifest: PetManifest,
    manifest_bytes: Vec<u8>,
    spritesheet_bytes: Vec<u8>,
}

fn write_pet_backup(
    destination: &Path,
    backup: &PetBackupData,
    spritesheet_name: &str,
    manifest_bytes: &[u8],
    spritesheet: &Path,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "The Starlight Echo backup needs a destination directory".to_owned())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create backup destination: {error}"))?;
    let transaction = uuid::Uuid::new_v4().simple().to_string();
    let temporary = parent.join(format!(".levelup-echo.{transaction}.tmp"));
    let backup_path = parent.join(format!(".levelup-echo.{transaction}.old"));
    let backup_json = serde_json::to_vec_pretty(backup)
        .map_err(|error| format!("Could not serialize Starlight Echo backup: {error}"))?;
    let source_bytes = std::fs::read(spritesheet)
        .map_err(|error| format!("Could not read Starlight Echo spritesheet: {error}"))?;
    if source_bytes.len() as u64 > MAX_SPRITESHEET_BYTES {
        return Err("The Starlight Echo spritesheet exceeds the backup size limit".to_owned());
    }
    let write_result = (|| {
        let file = std::fs::File::create(&temporary)
            .map_err(|error| format!("Could not create Starlight Echo backup: {error}"))?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        for (name, bytes) in [
            ("backup.json", backup_json.as_slice()),
            ("pet.json", manifest_bytes),
            ("spritesheet.bin", source_bytes.as_slice()),
        ] {
            writer.start_file(name, options).map_err(|error| {
                format!("Could not add {name} to Starlight Echo backup: {error}")
            })?;
            writer.write_all(bytes).map_err(|error| {
                format!("Could not write {name} to Starlight Echo backup: {error}")
            })?;
        }
        writer.set_comment(format!(
            "LevelUpAgent Starlight Echo backup: {spritesheet_name}"
        ));
        writer
            .finish()
            .map_err(|error| format!("Could not finalize Starlight Echo backup: {error}"))?;
        crate::filesystem::restrict_file(&temporary)
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    let had_previous = destination.is_file();
    if had_previous && let Err(error) = std::fs::rename(destination, &backup_path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "Could not prepare existing backup for replacement: {error}"
        ));
    }
    if let Err(error) = std::fs::rename(&temporary, destination) {
        if had_previous {
            let _ = std::fs::rename(&backup_path, destination);
        }
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Could not commit Starlight Echo backup: {error}"));
    }
    if had_previous {
        let _ = std::fs::remove_file(&backup_path);
    }
    crate::filesystem::restrict_file(destination)
}

fn read_pet_backup(source: &Path) -> Result<ExtractedPetBackup, String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect Starlight Echo backup: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Starlight Echo backups must be regular files".to_owned());
    }
    let file = std::fs::File::open(source)
        .map_err(|error| format!("Could not open Starlight Echo backup: {error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        format!("The selected file is not a valid Starlight Echo backup: {error}")
    })?;
    if archive.len() != 3 {
        return Err("Starlight Echo backups must contain exactly three files".to_owned());
    }
    let mut names = BTreeMap::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Could not inspect backup entry: {error}"))?;
        if entry.is_dir() || entry.enclosed_name().is_none() {
            return Err(
                "Starlight Echo backups cannot contain directories or unsafe paths".to_owned(),
            );
        }
        let name = entry.name().to_owned();
        if !matches!(
            name.as_str(),
            "backup.json" | "pet.json" | "spritesheet.bin"
        ) || names.insert(name, index).is_some()
        {
            return Err("Starlight Echo backup contains unexpected or duplicate files".to_owned());
        }
    }
    let backup_bytes = read_zip_entry(&mut archive, "backup.json", MAX_BACKUP_JSON_BYTES)?;
    let manifest_bytes = read_zip_entry(&mut archive, "pet.json", 64 * 1024)?;
    let spritesheet_bytes = read_zip_entry(&mut archive, "spritesheet.bin", MAX_SPRITESHEET_BYTES)?;
    let backup: PetBackupData = serde_json::from_slice(&backup_bytes)
        .map_err(|error| format!("Starlight Echo backup state is invalid: {error}"))?;
    if backup.version != PET_BACKUP_VERSION {
        return Err(format!(
            "Unsupported Starlight Echo backup version {}; expected {PET_BACKUP_VERSION}",
            backup.version
        ));
    }
    let manifest: PetManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Starlight Echo backup pet.json is invalid: {error}"))?;
    validate_manifest(&manifest)?;
    if spritesheet_bytes.is_empty() {
        return Err("Starlight Echo backup spritesheet is empty".to_owned());
    }
    let temporary_root = std::env::temp_dir().join(format!(
        "levelup-echo-backup-validation-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir(&temporary_root)
        .map_err(|error| format!("Could not stage backup validation: {error}"))?;
    let temporary_sheet = temporary_root.join(&manifest.spritesheet_path);
    let validation = (|| {
        std::fs::write(&temporary_sheet, &spritesheet_bytes)
            .map_err(|error| format!("Could not stage backup spritesheet validation: {error}"))?;
        let size = imagesize::size(&temporary_sheet)
            .map_err(|error| format!("Could not read backup spritesheet dimensions: {error}"))?;
        if size.width != SPRITESHEET_WIDTH || size.height != SPRITESHEET_HEIGHT {
            return Err(format!(
                "Backup spritesheet must be {SPRITESHEET_WIDTH}x{SPRITESHEET_HEIGHT}; found {}x{}",
                size.width, size.height
            ));
        }
        Ok::<(), String>(())
    })();
    let _ = std::fs::remove_dir_all(&temporary_root);
    validation?;
    Ok(ExtractedPetBackup {
        backup,
        manifest,
        manifest_bytes,
        spritesheet_bytes,
    })
}

fn read_zip_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let entry = archive
        .by_name(name)
        .map_err(|error| format!("Starlight Echo backup is missing {name}: {error}"))?;
    if entry.size() > max_bytes {
        return Err(format!(
            "Starlight Echo backup entry {name} exceeds its size limit"
        ));
    }
    let mut bytes = Vec::with_capacity(entry.size().min(max_bytes) as usize);
    entry
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read Starlight Echo backup entry {name}: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "Starlight Echo backup entry {name} exceeds its size limit"
        ));
    }
    Ok(bytes)
}

fn package_directory(source: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect desktop pet package: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Desktop pet packages cannot be symbolic links".to_owned());
    }
    if metadata.is_dir() {
        return Ok(source.to_path_buf());
    }
    if metadata.is_file()
        && source
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("pet.json"))
    {
        return source
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "pet.json has no package directory".to_owned());
    }
    Err("Choose a pet package directory or its pet.json file".to_owned())
}

fn validate_package(directory: &Path) -> Result<(PetManifest, Vec<u8>, PathBuf), String> {
    let metadata = std::fs::symlink_metadata(directory)
        .map_err(|error| format!("Could not inspect desktop pet directory: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Desktop pet package must be a regular directory".to_owned());
    }
    let manifest_path = directory.join("pet.json");
    let manifest_metadata = std::fs::symlink_metadata(&manifest_path)
        .map_err(|error| format!("Desktop pet package is missing pet.json: {error}"))?;
    if !manifest_metadata.is_file()
        || manifest_metadata.file_type().is_symlink()
        || manifest_metadata.len() == 0
        || manifest_metadata.len() > 32 * 1024
    {
        return Err("pet.json must be a regular UTF-8 JSON file smaller than 32 KiB".to_owned());
    }
    let manifest_bytes = std::fs::read(&manifest_path)
        .map_err(|error| format!("Could not read pet.json: {error}"))?;
    let manifest: PetManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("pet.json is invalid: {error}"))?;
    validate_manifest(&manifest)?;
    let spritesheet = directory.join(&manifest.spritesheet_path);
    let sheet_metadata = std::fs::symlink_metadata(&spritesheet)
        .map_err(|error| format!("Desktop pet package is missing its spritesheet: {error}"))?;
    if !sheet_metadata.is_file()
        || sheet_metadata.file_type().is_symlink()
        || sheet_metadata.len() == 0
        || sheet_metadata.len() > MAX_SPRITESHEET_BYTES
    {
        return Err(
            "Desktop pet spritesheet must be a regular image smaller than 24 MiB".to_owned(),
        );
    }
    let size = imagesize::size(&spritesheet)
        .map_err(|error| format!("Could not read desktop pet spritesheet dimensions: {error}"))?;
    if size.width != SPRITESHEET_WIDTH || size.height != SPRITESHEET_HEIGHT {
        return Err(format!(
            "Desktop pet spritesheet must be {SPRITESHEET_WIDTH}x{SPRITESHEET_HEIGHT}; found {}x{}",
            size.width, size.height
        ));
    }
    Ok((manifest, manifest_bytes, spritesheet))
}

fn validate_manifest(manifest: &PetManifest) -> Result<(), String> {
    validate_pet_id(&manifest.id)?;
    let display_name = manifest.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 80 {
        return Err("Desktop pet displayName must be between 1 and 80 characters".to_owned());
    }
    if manifest.description.chars().count() > 500 {
        return Err("Desktop pet description cannot exceed 500 characters".to_owned());
    }
    if manifest
        .personality
        .as_deref()
        .is_some_and(|value| value.chars().count() > 4_000)
    {
        return Err("Desktop pet personality cannot exceed 4,000 characters".to_owned());
    }
    let path = Path::new(&manifest.spritesheet_path);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err("spritesheetPath must be a package-local file name".to_owned());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("webp") && !extension.eq_ignore_ascii_case("png") {
        return Err("Desktop pet spritesheets must use WebP or PNG".to_owned());
    }
    Ok(())
}

fn validate_pet_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(
            "Desktop pet IDs may only contain ASCII letters, numbers, dashes, and underscores"
                .to_owned(),
        );
    }
    Ok(())
}

fn profile_from_manifest(
    directory: &Path,
    manifest: PetManifest,
    removable: bool,
) -> Result<PetProfile, String> {
    let spritesheet_path = directory.join(&manifest.spritesheet_path);
    Ok(PetProfile {
        id: manifest.id,
        display_name: manifest.display_name.trim().to_owned(),
        description: manifest.description.trim().to_owned(),
        spritesheet_path: spritesheet_path.display().to_string(),
        personality: manifest.personality,
        removable,
    })
}

fn progress_for(pet_id: &str, stored: StoredPetProgress) -> PetProgress {
    let total_xp = stored.total_tokens / 100;
    let mut completed_levels = ((-165.0 + (27_225.0 + 280.0 * total_xp as f64).sqrt()) / 70.0)
        .floor()
        .max(0.0) as u64;
    while xp_to_complete_levels(completed_levels.saturating_add(1)) <= total_xp as u128 {
        completed_levels = completed_levels.saturating_add(1);
    }
    while completed_levels > 0 && xp_to_complete_levels(completed_levels) > total_xp as u128 {
        completed_levels -= 1;
    }
    let spent = xp_to_complete_levels(completed_levels) as u64;
    let required_xp = 100_u64.saturating_add(35_u64.saturating_mul(completed_levels));
    let current_xp = total_xp.saturating_sub(spent);
    PetProgress {
        pet_id: pet_id.to_owned(),
        level: completed_levels.saturating_add(1),
        total_xp,
        current_xp,
        required_xp,
        progress: if required_xp == 0 {
            0.0
        } else {
            current_xp as f64 / required_xp as f64
        },
        total_tokens: stored.total_tokens,
        requests: stored.requests,
    }
}

fn scale_for(state: &StoredPetState, pet_id: &str) -> f64 {
    state
        .scales
        .get(pet_id)
        .copied()
        .filter(|scale| scale.is_finite())
        .unwrap_or(DEFAULT_PET_SCALE)
        .clamp(MIN_PET_SCALE, MAX_PET_SCALE)
}

fn update_runtime_pet_scale(scale: f64) {
    ACTIVE_PET_SCALE.store(
        (scale.clamp(MIN_PET_SCALE, MAX_PET_SCALE) * PET_SCALE_UNITS).round() as u32,
        Ordering::Relaxed,
    );
}

#[cfg(windows)]
fn runtime_pet_scale() -> f64 {
    ACTIVE_PET_SCALE.load(Ordering::Relaxed) as f64 / PET_SCALE_UNITS
}

fn xp_to_complete_levels(levels: u64) -> u128 {
    let levels = levels as u128;
    (35 * levels * levels + 165 * levels) / 2
}

fn memory_candidate(text: &str) -> Option<(String, String, f64)> {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() < 3 || clean.chars().count() > 240 || memory_is_sensitive(&clean) {
        return None;
    }
    for prefix in ["请记住", "帮我记住", "记住", "remember", "Remember"] {
        if let Some(value) = clean.strip_prefix(prefix) {
            let value = trim_memory_value(value);
            if value.chars().count() >= 2 && !memory_is_sensitive(value) {
                return Some((value.to_owned(), "explicit".to_owned(), 1.0));
            }
        }
    }
    for prefix in ["我的名字是", "我的名字叫", "我叫"] {
        if let Some(value) = clean.strip_prefix(prefix) {
            let value = trim_memory_value(value);
            if value.chars().count() >= 1 {
                return Some((format!("用户叫{value}"), "identity".to_owned(), 0.9));
            }
        }
    }
    for (prefix, label) in [
        ("我喜欢", "用户喜欢"),
        ("我偏好", "用户偏好"),
        ("我不喜欢", "用户不喜欢"),
        ("我讨厌", "用户讨厌"),
        ("我的目标是", "用户当前目标是"),
        ("我正在", "用户正在"),
    ] {
        if let Some(value) = clean.strip_prefix(prefix) {
            let value = trim_memory_value(value);
            if value.chars().count() >= 2 {
                return Some((format!("{label}{value}"), "preference".to_owned(), 0.72));
            }
        }
    }
    let lower = clean.to_ascii_lowercase();
    for (prefix, label) in [
        ("my name is ", "User is called "),
        ("i like ", "User likes "),
        ("i prefer ", "User prefers "),
        ("i dislike ", "User dislikes "),
        ("my goal is ", "User's current goal is "),
    ] {
        if let Some(value) = lower.strip_prefix(prefix) {
            let value = trim_memory_value(value);
            if value.chars().count() >= 2 {
                return Some((format!("{label}{value}"), "preference".to_owned(), 0.72));
            }
        }
    }
    None
}

fn trim_memory_value(value: &str) -> &str {
    value.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                ':' | '：' | ',' | '，' | '.' | '。' | '!' | '！' | '?' | '？' | ';' | '；'
            )
    })
}

fn memory_is_sensitive(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "api key",
        "apikey",
        "access token",
        "password",
        "passwd",
        "secret",
        "bearer ",
        "http://",
        "https://",
        "密钥",
        "密码",
        "令牌",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
        || lower.contains(":\\")
}

fn canonical_memory(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn normalize_activity(activity: PetActivity) -> Option<PetActivity> {
    let id = activity.id.trim().chars().take(120).collect::<String>();
    let title = activity.title.trim().chars().take(80).collect::<String>();
    if id.is_empty() || title.is_empty() {
        return None;
    }
    let state = match activity.state.as_str() {
        "generating" | "waiting" | "working" => activity.state,
        _ => "working".to_owned(),
    };
    Some(PetActivity {
        id,
        title,
        detail: activity.detail.trim().chars().take(120).collect(),
        state,
    })
}

fn detect_python() -> Option<String> {
    for (command, arguments) in [
        ("python", vec!["--version"]),
        ("py", vec!["-3", "--version"]),
    ] {
        let mut process = Command::new(command);
        process.args(arguments);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            process.creation_flags(0x0800_0000);
        }
        let Ok(output) = process.output() else {
            continue;
        };
        let version = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if output.status.success() && version.to_ascii_lowercase().contains("python 3") {
            return Some(if command == "py" {
                "py -3".to_owned()
            } else {
                command.to_owned()
            });
        }
    }
    None
}

fn package_modified_ms(manifest: &Path, spritesheet: &Path) -> i64 {
    [manifest, spritesheet]
        .into_iter()
        .filter_map(|path| std::fs::metadata(path).ok()?.modified().ok())
        .filter_map(system_time_millis)
        .max()
        .unwrap_or_default()
}

fn system_time_millis(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
}

fn now_millis() -> i64 {
    system_time_millis(SystemTime::now()).unwrap_or_default()
}

fn state_version() -> u32 {
    STATE_VERSION
}

fn default_pet_id() -> String {
    DEFAULT_PET_ID.to_owned()
}

fn default_overlay_visible() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_progress_preserves_remainders_across_levels() {
        let progress = progress_for(
            "test",
            StoredPetProgress {
                total_tokens: 23_500,
                requests: 3,
            },
        );
        assert_eq!(progress.total_xp, 235);
        assert_eq!(progress.level, 3);
        assert_eq!(progress.current_xp, 0);
        assert_eq!(progress.required_xp, 170);
    }

    #[test]
    fn memory_learning_is_conservative_and_filters_secrets() {
        assert_eq!(
            memory_candidate("我喜欢安静的工作环境").map(|item| item.0),
            Some("用户喜欢安静的工作环境".to_owned())
        );
        assert!(memory_candidate("记住 API key 是 sk-test-secret-value").is_none());
        assert!(memory_candidate("今天下雨了").is_none());
    }

    #[test]
    fn activity_updates_are_bounded_and_normalized() {
        let activities = (0..14)
            .map(|index| PetActivity {
                id: format!(" activity-{index} "),
                title: " Working title ".to_owned(),
                detail: " detail ".to_owned(),
                state: if index == 0 {
                    "unexpected".to_owned()
                } else {
                    "generating".to_owned()
                },
            })
            .collect();
        let normalized = PetRuntime::default().replace(activities).unwrap();
        assert_eq!(normalized.len(), 12);
        assert_eq!(normalized[0].id, "activity-0");
        assert_eq!(normalized[0].title, "Working title");
        assert_eq!(normalized[0].detail, "detail");
        assert_eq!(normalized[0].state, "working");
        assert_eq!(normalized[1].state, "generating");
    }

    #[test]
    fn validates_bundled_yui_package() {
        let root = std::env::temp_dir().join(format!("levelup-pet-test-{}", uuid::Uuid::new_v4()));
        let yui = root.join("yui");
        std::fs::create_dir_all(&yui).unwrap();
        std::fs::write(yui.join("pet.json"), DEFAULT_MANIFEST).unwrap();
        std::fs::write(yui.join("spritesheet.webp"), DEFAULT_SPRITESHEET).unwrap();
        let package = validate_package(&yui).unwrap();
        assert_eq!(package.0.id, "yui");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn new_pet_state_uses_seventy_five_percent_scale() {
        assert_eq!(scale_for(&StoredPetState::default(), DEFAULT_PET_ID), 0.75);
    }

    #[test]
    fn bundled_hatch_environment_uses_packaged_skills_without_user_paths() {
        let root = std::env::temp_dir().join(format!(
            "levelup-pet-bundled-hatch-test-{}",
            uuid::Uuid::new_v4()
        ));
        let app_data = root.join("app");
        let home = root.join("home");
        let skills = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("skills");
        let manager = PetManager::open_with_skills(&app_data, &home, Some(&skills)).unwrap();
        let environment = manager.configure_hatch().unwrap();
        let expected_hatch = skills.join("hatch-pet").display().to_string();
        let expected_imagegen = skills.join("imagegen").display().to_string();
        assert!(environment.bundled);
        assert_eq!(
            environment.hatch_skill_path.as_deref(),
            Some(expected_hatch.as_str())
        );
        assert_eq!(
            environment.imagegen_skill_path.as_deref(),
            Some(expected_imagegen.as_str())
        );
        assert!(
            environment
                .missing
                .iter()
                .all(|item| !matches!(item.id.as_str(), "hatch_skill" | "imagegen_skill"))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn hatch_environment_never_falls_back_to_user_codex_skills() {
        let root = std::env::temp_dir().join(format!(
            "levelup-pet-no-user-skill-fallback-test-{}",
            uuid::Uuid::new_v4()
        ));
        let app_data = root.join("app");
        let home = root.join("home");
        let mut manager = PetManager::open_with_skills(&app_data, &home, None).unwrap();
        manager.codex_home = root.join("user-codex");
        for skill in [
            manager.codex_home.join("skills").join("hatch-pet"),
            manager
                .codex_home
                .join("skills")
                .join(".system")
                .join("imagegen"),
        ] {
            std::fs::create_dir_all(&skill).unwrap();
            std::fs::write(
                skill.join("SKILL.md"),
                "---\nname: ignored\ndescription: user skill\n---\n\n# Ignore\n",
            )
            .unwrap();
        }

        let environment = manager.hatch_environment();
        assert!(!environment.configured);
        assert!(!environment.bundled);
        assert!(environment.hatch_skill_path.is_none());
        assert!(environment.imagegen_skill_path.is_none());
        assert!(
            environment
                .missing
                .iter()
                .any(|item| item.id == "hatch_skill")
        );
        assert!(
            environment
                .missing
                .iter()
                .any(|item| item.id == "imagegen_skill")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn usage_and_memory_survive_restart_without_double_counting() {
        let root =
            std::env::temp_dir().join(format!("levelup-pet-state-test-{}", uuid::Uuid::new_v4()));
        let app_data = root.join("app");
        let home = root.join("home");
        let manager = PetManager::open(&app_data, &home).unwrap();
        let first = manager
            .record_usage("yui", "request-1", 8_000, 2_000)
            .unwrap();
        assert_eq!(first.total_tokens, 10_000);
        assert_eq!(first.total_xp, 100);
        assert_eq!(first.level, 2);
        let duplicate = manager
            .record_usage("yui", "request-1", 8_000, 2_000)
            .unwrap();
        assert_eq!(duplicate.requests, 1);
        manager
            .learn_from_message("yui", "请记住我喜欢安静的工作环境")
            .unwrap();
        manager.set_scale("yui", 1.25).unwrap();
        drop(manager);

        let restored = PetManager::open(&app_data, &home)
            .unwrap()
            .dashboard()
            .unwrap();
        assert_eq!(restored.progress.total_tokens, 10_000);
        assert_eq!(restored.progress.requests, 1);
        assert_eq!(restored.memories.len(), 1);
        assert_eq!(restored.memories[0].text, "我喜欢安静的工作环境");
        assert_eq!(restored.scale, 1.25);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn installs_switches_and_removes_a_custom_pet_package() {
        let root =
            std::env::temp_dir().join(format!("levelup-pet-package-test-{}", uuid::Uuid::new_v4()));
        let app_data = root.join("app");
        let home = root.join("home");
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("pet.json"),
            br#"{
              "id": "test-companion",
              "displayName": "Test Companion",
              "description": "A package lifecycle fixture.",
              "spritesheetPath": "spritesheet.webp"
            }"#,
        )
        .unwrap();
        std::fs::write(source.join("spritesheet.webp"), DEFAULT_SPRITESHEET).unwrap();

        let manager = PetManager::open(&app_data, &home).unwrap();
        let installed = manager.install_package(&source, false).unwrap();
        assert_eq!(installed.display_name, "Test Companion");
        manager
            .learn_from_message("yui", "请记住这是 Yui 的记忆")
            .unwrap();
        manager
            .learn_from_message("test-companion", "请记住这是测试残影的记忆")
            .unwrap();
        manager.set_scale("yui", 0.65).unwrap();
        manager.set_scale("test-companion", 1.35).unwrap();
        let selected = manager.set_active("test-companion").unwrap();
        assert_eq!(selected.active_pet_id, "test-companion");
        assert_eq!(selected.pets.len(), 2);
        assert_eq!(selected.memories.len(), 1);
        assert_eq!(selected.memories[0].text, "这是测试残影的记忆");
        assert_eq!(selected.scale, 1.35);
        let yui = manager.set_active("yui").unwrap();
        assert_eq!(yui.memories.len(), 1);
        assert_eq!(yui.memories[0].text, "这是 Yui 的记忆");
        assert_eq!(yui.scale, 0.65);
        manager.set_active("test-companion").unwrap();
        assert!(manager.remove_package("test-companion").unwrap());
        assert_eq!(manager.dashboard().unwrap().active_pet_id, "yui");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn full_echo_backup_restores_package_progress_memory_and_life() {
        let root =
            std::env::temp_dir().join(format!("levelup-pet-backup-test-{}", uuid::Uuid::new_v4()));
        let app_data = root.join("app");
        let home = root.join("home");
        let source = root.join("source");
        let backup = root.join("my-echo.levelup-echo");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("pet.json"),
            br#"{
              "id": "my-echo",
              "displayName": "My Echo",
              "description": "A backup lifecycle fixture.",
              "spritesheetPath": "spritesheet.webp"
            }"#,
        )
        .unwrap();
        std::fs::write(source.join("spritesheet.webp"), DEFAULT_SPRITESHEET).unwrap();

        let manager = PetManager::open(&app_data, &home).unwrap();
        manager.install_package(&source, false).unwrap();
        manager.set_active("my-echo").unwrap();
        manager
            .record_usage("my-echo", "backup-usage", 12_000, 3_000)
            .unwrap();
        manager
            .learn_from_message("my-echo", "请记住这是不可替代的共同记忆")
            .unwrap();
        manager
            .add_task("my-echo", "Keep the promise", "", None, Some("daily"), 3)
            .unwrap();
        manager
            .record_knowledge(
                "my-echo",
                PetKnowledgeInput {
                    title: "A durable lesson",
                    summary: "Backups should preserve identity and experience together.",
                    source: "Test fixture",
                    source_kind: "document",
                    source_ref: Some("fixture:backup"),
                    tags: vec!["backup".to_owned()],
                    confidence: 0.95,
                },
            )
            .unwrap();
        manager
            .record_knowledge(
                "my-echo",
                PetKnowledgeInput {
                    title: "A private constellation",
                    summary: "Two remembered ideas may belong together; this remains a tentative discovery.",
                    source: "Autonomous reflection",
                    source_kind: "discovery",
                    source_ref: Some("discovery:backup-fixture"),
                    tags: vec!["self-discovery".to_owned()],
                    confidence: 0.62,
                },
            )
            .unwrap();
        manager.set_scale("my-echo", 1.2).unwrap();
        let reminder_at = now_millis();
        let reminder_date = crate::pet_life::local_date_key(reminder_at);
        let original_born_at = reminder_at.saturating_sub(42 * 86_400_000);
        {
            let mut state = manager.state.lock().unwrap();
            let life = state.life.get_mut("my-echo").unwrap();
            life.born_at = original_born_at;
            assert!(life.set_window_position(0.37, 0.64));
            life.activity_log
                .push(crate::pet_life::PetActivityLogEntry {
                    id: "dream:backup-fixture".to_owned(),
                    kind: "dream".to_owned(),
                    message: "I kept a small dream for tomorrow.".to_owned(),
                    created_at: reminder_at,
                });
            life.days
                .get_mut(&reminder_date)
                .unwrap()
                .study_launches
                .insert(
                    "morning".to_owned(),
                    crate::pet_life::PetStudyLaunch {
                        period: "morning".to_owned(),
                        available_at: reminder_at.saturating_sub(10 * 60_000),
                        prompted_at: Some(reminder_at),
                        snoozed_until: Some(reminder_at.saturating_add(10 * 60_000)),
                        last_reminder_at: Some(reminder_at),
                        reminder_count: 2,
                        completed_at: None,
                        skipped_at: None,
                        source: None,
                        supervision_tier: "firm".to_owned(),
                    },
                );
            save_state(&manager.state_path, &state).unwrap();
        }

        let exported = manager.export_backup("my-echo", &backup).unwrap();
        assert_eq!(exported.pet_id, "my-echo");
        assert!(exported.bytes > DEFAULT_SPRITESHEET.len() as u64 / 2);
        assert!(backup.is_file());

        manager.remove_package("my-echo").unwrap();
        {
            let mut state = manager.state.lock().unwrap();
            state.progress.remove("my-echo");
            state.memories.remove("my-echo");
            state.scales.remove("my-echo");
            state.life.remove("my-echo");
            save_state(&manager.state_path, &state).unwrap();
        }
        let restored_profile = manager.import_backup(&backup).unwrap();
        assert_eq!(restored_profile.id, "my-echo");
        let restored = manager.dashboard().unwrap();
        assert_eq!(restored.active_pet_id, "my-echo");
        assert_eq!(restored.progress.total_tokens, 15_000);
        assert_eq!(restored.memories.len(), 1);
        assert_eq!(restored.scale, 1.2);
        assert_eq!(restored.life.born_at, original_born_at);
        let restored_position = restored.life.window_position.as_ref().unwrap();
        assert!((restored_position.x - 0.37).abs() < f64::EPSILON);
        assert!((restored_position.y - 0.64).abs() < f64::EPSILON);
        assert!(
            restored
                .life
                .activity_log
                .iter()
                .any(|entry| entry.id == "dream:backup-fixture" && entry.kind == "dream")
        );
        let recurring = restored
            .life
            .tasks
            .iter()
            .find(|task| task.title == "Keep the promise")
            .unwrap();
        assert_eq!(recurring.recurrence.as_deref(), Some("daily"));
        assert!(
            recurring
                .series_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
        );
        let restored_launch = &restored.life.today.study_launches["morning"];
        assert_eq!(restored_launch.prompted_at, Some(reminder_at));
        assert_eq!(
            restored_launch.snoozed_until,
            Some(reminder_at.saturating_add(10 * 60_000))
        );
        assert_eq!(restored_launch.reminder_count, 2);
        assert_eq!(restored_launch.supervision_tier, "firm");
        assert!(
            restored
                .life
                .knowledge
                .iter()
                .any(|item| item.title == "A durable lesson")
        );
        assert!(restored.life.knowledge.iter().any(|item| {
            item.title == "A private constellation"
                && item.source_kind == "discovery"
                && (item.confidence - 0.62).abs() < f64::EPSILON
        }));
        assert!(validate_package(&manager.root.join("my-echo")).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }
}
