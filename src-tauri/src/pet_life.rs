use std::collections::{BTreeMap, BTreeSet};

use chrono::{Datelike, Local, NaiveDate, TimeZone, Timelike, Weekday};
use serde::{Deserialize, Serialize};

use crate::pet::PetMemory;

pub const PET_LIFE_VERSION: u32 = 8;
const MAX_DAYS: usize = 180;
const MAX_TASKS: usize = 240;
const MAX_KNOWLEDGE: usize = 400;
const MAX_LEARNING_QUESTS: usize = 120;
const MAX_RECENT_OBSERVATIONS: usize = 32;
const MAX_REWARDS: usize = 240;
const MAX_ACTIVITY_LOG: usize = 500;
const MAX_TICK_MINUTES: f64 = 360.0;
const PERSIST_TICK_INTERVAL_MS: i64 = 60_000;
const AUTONOMOUS_CONTEXT_INTERVAL_MS: i64 = 15 * 60_000;
const AUTONOMOUS_IDENTITY_INTERVAL_MS: i64 = 7 * 24 * 60 * 60_000;
const AUTONOMOUS_IDENTITY_INITIAL_DELAY_MS: i64 = 30 * 60_000;
const AUTONOMOUS_DEEPENING_INTERVAL_MS: i64 = 3 * 60 * 60_000;
const AUTONOMOUS_EXPLORATION_INTERVAL_MS: i64 = 6 * 60 * 60_000;
const AUTONOMOUS_LEARNING_RETRY_BASE_MS: i64 = 20 * 60_000;
const AUTONOMOUS_LEARNING_STALE_MS: i64 = 10 * 60_000;
const RECENT_OBSERVATION_TTL_MS: i64 = 72 * 60 * 60_000;
const PATROL_INTERVAL_MS: i64 = 6 * 60_000;
const CHECK_IN_SLOTS: [u32; 5] = [9 * 60, 12 * 60, 15 * 60, 18 * 60, 21 * 60];
const STUDY_LAUNCH_GRACE_MS: i64 = 10 * 60_000;
const STUDY_LAUNCH_SNOOZE_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetNeeds {
    pub energy: f64,
    pub focus: f64,
    pub curiosity: f64,
    pub social: f64,
    pub mood: f64,
}

impl Default for PetNeeds {
    fn default() -> Self {
        Self {
            energy: 86.0,
            focus: 68.0,
            curiosity: 64.0,
            social: 72.0,
            mood: 82.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBehavior {
    pub state: String,
    pub reason: String,
    pub message: String,
    pub since: i64,
    pub next_decision_at: i64,
    pub direction: Option<String>,
}

impl PetBehavior {
    fn initial(now: i64) -> Self {
        Self {
            state: "idle".to_owned(),
            reason: "settling-in".to_owned(),
            message: "I am here, taking in the day.".to_owned(),
            since: now,
            next_decision_at: now,
            direction: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PetLifeSettings {
    pub autonomy_enabled: bool,
    pub learning_enabled: bool,
    pub movement_enabled: bool,
    pub daily_plan_enabled: bool,
    pub reminders_enabled: bool,
    pub launch_at_login: bool,
    pub study_goal_minutes: u32,
    pub knowledge_goal: u32,
    pub quiet_start_minute: u32,
    pub quiet_end_minute: u32,
    pub patrol_speed: f64,
}

impl Default for PetLifeSettings {
    fn default() -> Self {
        Self {
            autonomy_enabled: true,
            learning_enabled: true,
            movement_enabled: true,
            daily_plan_enabled: true,
            reminders_enabled: true,
            launch_at_login: false,
            study_goal_minutes: 120,
            knowledge_goal: 2,
            quiet_start_minute: 22 * 60,
            quiet_end_minute: 8 * 60,
            patrol_speed: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetScheduleItem {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub start_minute: u32,
    pub duration_minutes: u32,
    pub kind: String,
    pub status: String,
    pub source: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCheckIn {
    pub slot: String,
    pub status: String,
    pub responded_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetDayRecord {
    pub date: String,
    pub plan_generated_at: i64,
    pub plan_reason: String,
    pub schedule: Vec<PetScheduleItem>,
    pub check_ins: BTreeMap<String, PetCheckIn>,
    pub reflection: String,
    pub settled_at: Option<i64>,
    #[serde(default)]
    pub task_reminders: BTreeMap<String, i64>,
    #[serde(default)]
    pub chatter_slots: BTreeMap<String, i64>,
    #[serde(default)]
    pub study_launches: BTreeMap<String, PetStudyLaunch>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PetStudyLaunch {
    pub period: String,
    pub available_at: i64,
    pub prompted_at: Option<i64>,
    pub snoozed_until: Option<i64>,
    pub last_reminder_at: Option<i64>,
    pub reminder_count: u32,
    pub completed_at: Option<i64>,
    pub skipped_at: Option<i64>,
    pub source: Option<String>,
    pub supervision_tier: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetTask {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub due_date: Option<String>,
    pub recurrence: Option<String>,
    pub priority: u8,
    pub status: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub series_id: Option<String>,
    #[serde(default)]
    pub occurrence_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPrompt {
    pub id: String,
    pub kind: String,
    pub message: String,
    pub period: Option<String>,
    pub tier: Option<String>,
    pub actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetKnowledge {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub source: String,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub tags: Vec<String>,
    pub confidence: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_reviewed_at: Option<i64>,
    pub review_count: u32,
}

pub struct PetKnowledgeInput<'a> {
    pub title: &'a str,
    pub summary: &'a str,
    pub source: &'a str,
    pub source_kind: &'a str,
    pub source_ref: Option<&'a str>,
    pub tags: Vec<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetLearningQuest {
    pub id: String,
    pub question: String,
    pub topic: String,
    #[serde(default = "default_learning_mode")]
    pub learning_mode: String,
    pub status: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub next_retry_at: Option<i64>,
    pub attempts: u32,
    #[serde(default)]
    pub formation_attempts: u32,
    #[serde(default)]
    pub rationale: Option<String>,
    #[serde(default)]
    pub question_provider_id: Option<String>,
    pub answer_title: Option<String>,
    pub knowledge_id: Option<String>,
    pub provider_id: Option<String>,
    pub error: Option<String>,
}

pub struct PetLearningQuestionInput<'a> {
    pub question: &'a str,
    pub topic: &'a str,
    pub rationale: &'a str,
    pub provider_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetUserObservation {
    pub id: String,
    pub text: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetStudySession {
    pub id: String,
    pub source: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetReward {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub date: String,
    pub earned_at: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetActivityLogEntry {
    pub id: String,
    pub kind: String,
    pub message: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPetLife {
    #[serde(default = "life_version")]
    pub version: u32,
    #[serde(default)]
    pub needs: PetNeeds,
    pub behavior: PetBehavior,
    #[serde(default)]
    pub settings: PetLifeSettings,
    #[serde(default)]
    pub days: BTreeMap<String, PetDayRecord>,
    #[serde(default)]
    pub tasks: Vec<PetTask>,
    #[serde(default)]
    pub knowledge: Vec<PetKnowledge>,
    #[serde(default)]
    pub learning_quests: Vec<PetLearningQuest>,
    #[serde(default)]
    pub recent_observations: Vec<PetUserObservation>,
    #[serde(default)]
    pub study_sessions: Vec<PetStudySession>,
    #[serde(default)]
    pub rewards: Vec<PetReward>,
    #[serde(default)]
    pub activity_log: Vec<PetActivityLogEntry>,
    #[serde(default)]
    pub window_position: Option<PetWindowPosition>,
    #[serde(default)]
    pub born_at: i64,
    #[serde(default)]
    pub last_tick_at: i64,
    #[serde(default)]
    pub last_persisted_at: i64,
    #[serde(default)]
    pub last_patrol_at: i64,
}

impl StoredPetLife {
    pub fn new(now: i64) -> Self {
        Self {
            version: PET_LIFE_VERSION,
            needs: PetNeeds::default(),
            behavior: PetBehavior::initial(now),
            settings: PetLifeSettings::default(),
            days: BTreeMap::new(),
            tasks: Vec::new(),
            knowledge: Vec::new(),
            learning_quests: Vec::new(),
            recent_observations: Vec::new(),
            study_sessions: Vec::new(),
            rewards: Vec::new(),
            activity_log: Vec::new(),
            window_position: None,
            born_at: now,
            last_tick_at: now,
            last_persisted_at: now,
            last_patrol_at: 0,
        }
    }

    pub fn normalize(&mut self, now: i64) {
        self.version = PET_LIFE_VERSION;
        self.needs.energy = clamp_percent(self.needs.energy);
        self.needs.focus = clamp_percent(self.needs.focus);
        self.needs.curiosity = clamp_percent(self.needs.curiosity);
        self.needs.social = clamp_percent(self.needs.social);
        self.needs.mood = clamp_percent(self.needs.mood);
        self.settings.study_goal_minutes = self.settings.study_goal_minutes.clamp(15, 16 * 60);
        self.settings.knowledge_goal = self.settings.knowledge_goal.clamp(1, 50);
        self.settings.quiet_start_minute = self.settings.quiet_start_minute.min(1439);
        self.settings.quiet_end_minute = self.settings.quiet_end_minute.min(1439);
        self.settings.patrol_speed = self.settings.patrol_speed.clamp(0.5, 2.0);
        self.tasks.retain(|task| !task.title.trim().is_empty());
        for task in &mut self.tasks {
            task.priority = task.priority.clamp(1, 3);
            task.due_date = task
                .due_date
                .as_deref()
                .filter(|value| valid_date_key(value))
                .map(str::to_owned);
            task.recurrence = task
                .recurrence
                .as_deref()
                .filter(|value| matches!(*value, "daily" | "weekdays" | "weekly"))
                .map(str::to_owned);
            if task.recurrence.is_some() {
                if task.series_id.as_deref().is_none_or(str::is_empty) {
                    task.series_id = Some(task.id.clone());
                }
                if task
                    .occurrence_date
                    .as_deref()
                    .is_none_or(|value| !valid_date_key(value))
                {
                    task.occurrence_date = Some(local_date_key(task.created_at));
                }
            } else {
                task.series_id = None;
                task.occurrence_date = None;
            }
        }
        trim_oldest(&mut self.tasks, MAX_TASKS);
        self.knowledge
            .retain(|item| !item.summary.trim().is_empty());
        for item in &mut self.knowledge {
            item.source_kind = normalize_source_kind(&item.source_kind);
        }
        trim_oldest(&mut self.knowledge, MAX_KNOWLEDGE);
        for quest in &mut self.learning_quests {
            quest.question = shorten(quest.question.trim(), 280);
            quest.topic = shorten(quest.topic.trim(), 90);
            quest.learning_mode = normalize_learning_mode(&quest.learning_mode);
            quest.rationale = quest
                .rationale
                .as_deref()
                .map(|value| shorten(value.trim(), 240))
                .filter(|value| !value.is_empty());
            quest.question_provider_id = quest
                .question_provider_id
                .as_deref()
                .map(|value| shorten(value.trim(), 120))
                .filter(|value| !value.is_empty());
            if quest.status == "formulating"
                && quest.started_at.is_some_and(|started| {
                    now.saturating_sub(started) >= AUTONOMOUS_LEARNING_STALE_MS
                })
            {
                quest.status = "formation-retrying".to_owned();
                quest.next_retry_at = Some(now);
                quest.error = Some(
                    "The previous question-forming request was interrupted; I will reflect again."
                        .to_owned(),
                );
            }
            if quest.status == "asking"
                && quest.started_at.is_some_and(|started| {
                    now.saturating_sub(started) >= AUTONOMOUS_LEARNING_STALE_MS
                })
            {
                quest.status = "retrying".to_owned();
                quest.next_retry_at = Some(now);
                quest.error = Some(
                    "The previous Agent request was interrupted; I will try again.".to_owned(),
                );
            }
        }
        trim_oldest(&mut self.learning_quests, MAX_LEARNING_QUESTS);
        self.recent_observations.retain(|observation| {
            !observation.text.trim().is_empty()
                && now.saturating_sub(observation.created_at) <= RECENT_OBSERVATION_TTL_MS
        });
        for observation in &mut self.recent_observations {
            observation.text = shorten(observation.text.trim(), 360);
        }
        trim_oldest(&mut self.recent_observations, MAX_RECENT_OBSERVATIONS);
        self.rewards
            .retain(|reward| matches!(reward.kind.as_str(), "focus" | "knowledge" | "together"));
        trim_oldest(&mut self.rewards, MAX_REWARDS);
        trim_oldest(&mut self.activity_log, MAX_ACTIVITY_LOG);
        while self.days.len() > MAX_DAYS {
            let Some(key) = self.days.keys().next().cloned() else {
                break;
            };
            self.days.remove(&key);
        }
        if self.born_at <= 0 {
            self.born_at = now;
        }
        if self.last_tick_at <= 0 || self.last_tick_at > now {
            self.last_tick_at = now;
        }
        if self.last_persisted_at <= 0 || self.last_persisted_at > now {
            self.last_persisted_at = self.last_tick_at;
        }
        if self.behavior.state.trim().is_empty() {
            self.behavior = PetBehavior::initial(now);
        }
        for (date, day) in &mut self.days {
            day.study_launches.retain(|period, launch| {
                let valid = matches!(period.as_str(), "morning" | "afternoon" | "evening");
                if valid {
                    launch.period = period.clone();
                    launch.supervision_tier = normalize_supervision_tier(&launch.supervision_tier);
                }
                valid
            });
            day.task_reminders.retain(|slot, _| {
                matches!(
                    slot.as_str(),
                    "21:00" | "22:00" | "21:00:dismissed" | "22:00:dismissed"
                )
            });
            if day.date != *date {
                day.date = date.clone();
            }
        }
        if let Some(position) = &mut self.window_position
            && (!position.x.is_finite() || !position.y.is_finite())
        {
            self.window_position = None;
        }
    }

    pub fn tick(&mut self, now: i64, pet_name: &str, memories: &[PetMemory]) -> bool {
        self.normalize(now);
        let before = self.clone();
        let was_sleeping = self.behavior.state == "sleeping";
        self.apply_elapsed_needs(now);
        self.absorb_memories(now, memories);
        self.reconcile_recurring_tasks(now);
        let today = local_date_key(now);
        if self.settings.daily_plan_enabled && !self.days.contains_key(&today) {
            self.generate_daily_plan(now, pet_name, memories, false);
        }
        self.reconcile_schedule(now);
        self.reconcile_check_ins(now);
        self.reconcile_study_launch(now);
        self.reconcile_task_reminders(now);
        self.reconcile_autonomous_learning(now);
        self.finish_autonomous_review(now);
        self.maybe_wake_with_dream(now, pet_name, was_sleeping);
        self.choose_behavior(now, pet_name);
        self.refresh_rewards(now);
        self.last_tick_at = now;
        self.prune();
        let meaningful_change = self.behavior != before.behavior
            || self.days != before.days
            || self.knowledge != before.knowledge
            || self.learning_quests != before.learning_quests
            || self.recent_observations != before.recent_observations
            || self.study_sessions != before.study_sessions
            || self.rewards != before.rewards
            || self.activity_log != before.activity_log;
        let periodic_checkpoint =
            now.saturating_sub(self.last_persisted_at) >= PERSIST_TICK_INTERVAL_MS;
        if meaningful_change || periodic_checkpoint {
            self.last_persisted_at = now;
            true
        } else {
            false
        }
    }

    pub fn snapshot(&self, now: i64) -> PetLifeSnapshot {
        let today_key = local_date_key(now);
        let today = self
            .days
            .get(&today_key)
            .cloned()
            .unwrap_or_else(|| PetDayRecord {
                date: today_key.clone(),
                plan_generated_at: 0,
                plan_reason: "pending".to_owned(),
                schedule: Vec::new(),
                check_ins: BTreeMap::new(),
                reflection: String::new(),
                settled_at: None,
                task_reminders: BTreeMap::new(),
                chatter_slots: BTreeMap::new(),
                study_launches: BTreeMap::new(),
            });
        let active_session = self
            .study_sessions
            .iter()
            .rev()
            .find(|session| session.ended_at.is_none())
            .cloned();
        PetLifeSnapshot {
            version: self.version,
            needs: self.needs.clone(),
            behavior: self.behavior.clone(),
            settings: self.settings.clone(),
            today,
            tasks: self.tasks.clone(),
            knowledge: self.knowledge.clone(),
            learning_quests: self
                .learning_quests
                .iter()
                .rev()
                .take(30)
                .cloned()
                .collect(),
            recent_observations: self
                .recent_observations
                .iter()
                .rev()
                .take(20)
                .cloned()
                .collect(),
            active_session,
            rewards: self.rewards.iter().rev().take(40).cloned().collect(),
            activity_log: self.activity_log.iter().rev().take(60).cloned().collect(),
            stats: self.stats(now),
            history: self.history(now),
            window_position: self.window_position.clone(),
            prompt: self.current_prompt(now),
            born_at: self.born_at,
            last_tick_at: self.last_tick_at,
        }
    }

    pub fn observe_user_input(&mut self, now: i64, text: &str) -> bool {
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let text = shorten(text.trim(), 360);
        if text.chars().count() < 2 || learning_question_is_sensitive(&text) {
            return false;
        }
        let canonical_text = canonical(&text);
        if let Some(existing) = self
            .recent_observations
            .iter_mut()
            .rev()
            .find(|observation| canonical(&observation.text) == canonical_text)
        {
            existing.created_at = now;
            return true;
        }
        self.recent_observations.push(PetUserObservation {
            id: uuid::Uuid::new_v4().to_string(),
            text,
            created_at: now,
        });
        trim_oldest(&mut self.recent_observations, MAX_RECENT_OBSERVATIONS);
        true
    }

    pub fn generate_daily_plan(
        &mut self,
        now: i64,
        pet_name: &str,
        memories: &[PetMemory],
        force: bool,
    ) -> bool {
        let date = local_date_key(now);
        if !force && self.days.contains_key(&date) {
            return false;
        }
        let created_at = now;
        let mut pending_tasks = self
            .tasks
            .iter()
            .filter(|task| {
                task.status != "completed"
                    && task
                        .due_date
                        .as_deref()
                        .is_none_or(|due_date| due_date <= date.as_str())
            })
            .collect::<Vec<_>>();
        pending_tasks.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| match (&left.due_date, &right.due_date) {
                    (Some(left), Some(right)) => left.cmp(right),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                })
                .then_with(|| left.created_at.cmp(&right.created_at))
        });
        pending_tasks.truncate(2);
        let goal = memories
            .iter()
            .rev()
            .find(|memory| memory.kind == "preference" && memory.text.contains("目标"))
            .or_else(|| {
                memories
                    .iter()
                    .rev()
                    .find(|memory| memory.kind == "preference")
            });
        let knowledge = self
            .knowledge
            .iter()
            .min_by_key(|item| (item.review_count, item.last_reviewed_at.unwrap_or(0)));
        let focus_title = pending_tasks
            .first()
            .map(|task| task.title.clone())
            .or_else(|| goal.map(|memory| shorten(&memory.text, 42)))
            .unwrap_or_else(|| "和你一起推进今天最重要的事".to_owned());
        let second_focus = pending_tasks
            .get(1)
            .map(|task| task.title.clone())
            .unwrap_or_else(|| "整理进展并完成一个小目标".to_owned());
        let learning_title = knowledge
            .map(|item| format!("复习：{}", shorten(&item.title, 34)))
            .unwrap_or_else(|| "从今天的对话和工作里学习".to_owned());
        let templates = [
            (
                8 * 60 + 30,
                15,
                "plan",
                "晨间整理",
                "看看今天的重点和彼此的状态",
                "autonomy",
            ),
            (
                9 * 60 + 30,
                50,
                "focus",
                focus_title.as_str(),
                "第一段安静专注时间",
                "task",
            ),
            (
                11 * 60 + 20,
                25,
                "learn",
                learning_title.as_str(),
                "把新理解写进知识库并复习旧知识",
                "knowledge",
            ),
            (
                14 * 60 + 30,
                45,
                "focus",
                second_focus.as_str(),
                "为未完成事项留出完整的一段时间",
                "task",
            ),
            (
                17 * 60 + 20,
                15,
                "wander",
                "在桌面走一走",
                "活动一下，也让注意力重新变得轻盈",
                "autonomy",
            ),
            (
                19 * 60 + 30,
                35,
                "learn",
                "晚间学习与知识整理",
                "回看今天积累的内容，留下可靠来源",
                "knowledge",
            ),
            (
                21 * 60,
                15,
                "reflect",
                "今日结算",
                "记录学习、完成事项和一句话感受",
                "autonomy",
            ),
        ];
        let mut schedule = templates
            .into_iter()
            .enumerate()
            .map(
                |(index, (start_minute, duration_minutes, kind, title, detail, source))| {
                    PetScheduleItem {
                        id: stable_daily_id(&date, kind, index),
                        title: shorten(title, 60),
                        detail: shorten(detail, 160),
                        start_minute,
                        duration_minutes,
                        kind: kind.to_owned(),
                        status: "planned".to_owned(),
                        source: source.to_owned(),
                        created_at,
                        completed_at: None,
                    }
                },
            )
            .collect::<Vec<_>>();
        let mut day = self.days.remove(&date).unwrap_or_else(|| empty_day(&date));
        for item in &mut schedule {
            if let Some(previous) = day.schedule.iter().find(|previous| previous.id == item.id) {
                item.status = previous.status.clone();
                item.completed_at = previous.completed_at;
            }
        }
        day.plan_generated_at = now;
        day.plan_reason =
            format!("{pet_name} combined pending tasks, memories, energy, and learning goals.");
        day.schedule = schedule;
        self.days.insert(date, day);
        self.log(now, "plan", "I made today's plan and left room for rest.");
        true
    }

    pub fn toggle_study(&mut self, now: i64, source: &str) -> bool {
        if let Some(active) = self
            .study_sessions
            .iter_mut()
            .rev()
            .find(|session| session.ended_at.is_none())
        {
            active.ended_at = Some(now.max(active.started_at));
            self.needs.focus = clamp_percent(self.needs.focus - 4.0);
            self.needs.mood = clamp_percent(self.needs.mood + 4.0);
            self.log(now, "study", "We finished a focused study session.");
            self.behavior.next_decision_at = now;
            self.refresh_rewards(now);
            return false;
        }
        self.study_sessions.push(PetStudySession {
            id: uuid::Uuid::new_v4().to_string(),
            source: shorten(source, 40),
            started_at: now,
            ended_at: None,
        });
        self.complete_study_launch(now, source);
        self.log(now, "study", "I settled down to learn beside you.");
        self.set_behavior(
            now,
            "studying",
            "active-study-session",
            "I am studying with you. I will keep this time safe.",
            20 * 60_000,
            None,
        );
        true
    }

    pub fn add_task(
        &mut self,
        now: i64,
        title: &str,
        notes: &str,
        due_date: Option<&str>,
        recurrence: Option<&str>,
        priority: u8,
    ) -> Result<PetTask, String> {
        let title = normalize_required(title, 60, "Task title")?;
        let recurrence = recurrence
            .filter(|value| matches!(*value, "daily" | "weekdays" | "weekly"))
            .map(str::to_owned);
        let due_date = due_date
            .filter(|value| valid_date_key(value))
            .map(str::to_owned);
        let id = uuid::Uuid::new_v4().to_string();
        let task = PetTask {
            id: id.clone(),
            title,
            notes: shorten(notes.trim(), 500),
            due_date: due_date.clone(),
            recurrence: recurrence.clone(),
            priority: priority.clamp(1, 3),
            status: "pending".to_owned(),
            created_at: now,
            completed_at: None,
            series_id: recurrence.as_ref().map(|_| id),
            occurrence_date: recurrence
                .as_ref()
                .map(|_| due_date.clone().unwrap_or_else(|| local_date_key(now))),
        };
        self.tasks.push(task.clone());
        trim_oldest(&mut self.tasks, MAX_TASKS);
        self.log(now, "task", &format!("I added a task: {}", task.title));
        Ok(task)
    }

    pub fn set_task_completed(&mut self, now: i64, task_id: &str, completed: bool) -> bool {
        let Some(task) = self.tasks.iter_mut().find(|task| task.id == task_id) else {
            return false;
        };
        task.status = if completed { "completed" } else { "pending" }.to_owned();
        task.completed_at = completed.then_some(now);
        let title = task.title.clone();
        if completed {
            self.needs.mood = clamp_percent(self.needs.mood + 7.0);
            self.log(now, "task", &format!("We completed: {title}"));
            self.set_behavior(
                now,
                "celebrating",
                "task-completed",
                "That is one more promise kept. I noticed.",
                4_000,
                None,
            );
        }
        true
    }

    pub fn respond_to_prompt(
        &mut self,
        now: i64,
        prompt_id: &str,
        action: &str,
    ) -> Result<(), String> {
        let prompt = self
            .current_prompt(now)
            .filter(|prompt| prompt.id == prompt_id)
            .ok_or_else(|| "This Starlight Echo reminder is no longer active".to_owned())?;
        match prompt.kind.as_str() {
            "check-in" => {
                if action != "check-in" {
                    return Err("Unknown check-in action".to_owned());
                }
                self.check_in(now)?;
            }
            "study-launch" => {
                let period = prompt
                    .period
                    .as_deref()
                    .ok_or_else(|| "The study reminder has no period".to_owned())?;
                match action {
                    "start" => {
                        if !self
                            .study_sessions
                            .iter()
                            .any(|session| session.ended_at.is_none())
                        {
                            self.toggle_study(now, "study-reminder");
                        } else {
                            self.complete_study_launch(now, "study-reminder");
                        }
                    }
                    "snooze" => {
                        let launch = self.study_launch_mut(now, period);
                        if launch.snoozed_until.is_some() {
                            return Err(
                                "This study reminder has already been postponed once".to_owned()
                            );
                        }
                        launch.snoozed_until = Some(now.saturating_add(STUDY_LAUNCH_SNOOZE_MS));
                        launch.prompted_at = None;
                        launch.last_reminder_at = Some(now);
                        self.set_behavior(
                            now,
                            "idle",
                            "study-snoozed",
                            "Ten minutes is yours. I will come back when they are over.",
                            STUDY_LAUNCH_SNOOZE_MS,
                            None,
                        );
                        self.log(
                            now,
                            "reminder",
                            "The study reminder was postponed for ten minutes.",
                        );
                    }
                    "skip" => {
                        let launch = self.study_launch_mut(now, period);
                        launch.skipped_at = Some(now);
                        launch.prompted_at = None;
                        self.set_behavior(
                            now,
                            "idle",
                            "study-skipped",
                            "All right. I will leave this period quiet and meet you in the next one.",
                            2 * 60_000,
                            None,
                        );
                        self.log(now, "reminder", "The current study period was skipped.");
                    }
                    _ => return Err("Unknown study reminder action".to_owned()),
                }
            }
            "task-reminder" => {
                if action != "dismiss" && action != "open" {
                    return Err("Unknown task reminder action".to_owned());
                }
                let slot = if prompt.id.ends_with("22:00") {
                    "22:00"
                } else {
                    "21:00"
                };
                self.days
                    .entry(local_date_key(now))
                    .or_insert_with(|| empty_day(&local_date_key(now)))
                    .task_reminders
                    .insert(format!("{slot}:dismissed"), now);
                self.behavior.next_decision_at = now;
            }
            _ => return Err("Unknown Starlight Echo reminder".to_owned()),
        }
        Ok(())
    }

    pub fn delete_task(&mut self, now: i64, task_id: &str) -> bool {
        let previous = self.tasks.len();
        let series_id = self
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .and_then(|task| task.series_id.clone());
        self.tasks.retain(|task| task.id != task_id);
        if let Some(series_id) = series_id {
            for task in &mut self.tasks {
                if task.series_id.as_deref() == Some(series_id.as_str()) {
                    task.recurrence = None;
                    task.series_id = None;
                    task.occurrence_date = None;
                }
            }
        }
        let removed = previous != self.tasks.len();
        if removed {
            self.log(now, "task", "I removed a task from our list.");
        }
        removed
    }

    pub fn complete_schedule_item(&mut self, now: i64, item_id: &str, completed: bool) -> bool {
        let date = local_date_key(now);
        let Some(day) = self.days.get_mut(&date) else {
            return false;
        };
        let Some(item) = day.schedule.iter_mut().find(|item| item.id == item_id) else {
            return false;
        };
        item.status = if completed { "completed" } else { "planned" }.to_owned();
        item.completed_at = completed.then_some(now);
        if completed {
            let title = item.title.clone();
            self.log(now, "plan", &format!("Schedule complete: {title}"));
        }
        true
    }

    pub fn check_in(&mut self, now: i64) -> Result<String, String> {
        let minute = local_minute(now);
        let Some(slot) = CHECK_IN_SLOTS
            .into_iter()
            .find(|slot| minute.abs_diff(*slot) <= 5)
        else {
            return Err(
                "Check-in is available for five minutes before or after a scheduled slot"
                    .to_owned(),
            );
        };
        let date = local_date_key(now);
        let slot_label = minute_label(slot);
        let day = self
            .days
            .entry(date.clone())
            .or_insert_with(|| empty_day(&date));
        if day.check_ins.contains_key(&slot_label) {
            return Err("This check-in has already been recorded".to_owned());
        }
        day.check_ins.insert(
            slot_label.clone(),
            PetCheckIn {
                slot: slot_label.clone(),
                status: "checked".to_owned(),
                responded_at: Some(now),
            },
        );
        self.needs.social = clamp_percent(self.needs.social + 12.0);
        self.needs.mood = clamp_percent(self.needs.mood + 5.0);
        self.behavior.next_decision_at = now;
        self.log(
            now,
            "check-in",
            &format!("We met at the {slot_label} check-in."),
        );
        Ok(slot_label)
    }

    pub fn bond_with_user(&mut self, now: i64) -> bool {
        let recently_greeted =
            self.activity_log.iter().rev().any(|entry| {
                entry.kind == "bond" && now.saturating_sub(entry.created_at) < 5 * 60_000
            });
        self.needs.social =
            clamp_percent(self.needs.social + if recently_greeted { 0.5 } else { 4.0 });
        self.needs.mood =
            clamp_percent(self.needs.mood + if recently_greeted { 0.25 } else { 2.0 });
        self.set_behavior(
            now,
            "idle",
            "bonded",
            "I felt you notice me. I will keep that small warmth with me.",
            45_000,
            None,
        );
        if !recently_greeted {
            self.log(
                now,
                "bond",
                "你轻轻碰了碰我，我把这份温度收好了。 || You reached for me, and I kept that small warmth.",
            );
        }
        !recently_greeted
    }

    pub fn record_knowledge(
        &mut self,
        now: i64,
        input: PetKnowledgeInput<'_>,
    ) -> Result<PetKnowledge, String> {
        let title = normalize_required(input.title, 90, "Knowledge title")?;
        let summary = normalize_required(input.summary, 1_200, "Knowledge summary")?;
        let source_ref = input.source_ref.map(|value| shorten(value, 160));
        if let Some(existing) = self.knowledge.iter_mut().find(|item| {
            source_ref.is_some() && item.source_ref == source_ref
                || canonical(&item.title) == canonical(&title)
                    && canonical(&item.summary) == canonical(&summary)
        }) {
            existing.title = title;
            existing.summary = summary;
            existing.source = shorten(input.source.trim(), 240);
            existing.source_kind = normalize_source_kind(input.source_kind);
            existing.tags = normalize_tags(input.tags);
            existing.updated_at = now;
            existing.confidence =
                (existing.confidence.max(input.confidence.clamp(0.0, 1.0)) + 0.04).min(1.0);
            let output = existing.clone();
            return Ok(output);
        }
        let knowledge = PetKnowledge {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            summary,
            source: shorten(input.source.trim(), 240),
            source_kind: normalize_source_kind(input.source_kind),
            source_ref,
            tags: normalize_tags(input.tags),
            confidence: input.confidence.clamp(0.0, 1.0),
            created_at: now,
            updated_at: now,
            last_reviewed_at: None,
            review_count: 0,
        };
        self.knowledge.push(knowledge.clone());
        trim_oldest(&mut self.knowledge, MAX_KNOWLEDGE);
        self.needs.curiosity = clamp_percent(self.needs.curiosity + 14.0);
        self.needs.mood = clamp_percent(self.needs.mood + 2.0);
        self.log(now, "knowledge", &format!("I learned: {}", knowledge.title));
        self.refresh_rewards(now);
        Ok(knowledge)
    }

    pub fn claim_learning_quest(&mut self, now: i64) -> Option<PetLearningQuest> {
        if !self.settings.autonomy_enabled
            || !self.settings.learning_enabled
            || self.needs.energy < 30.0
            || minute_in_wrapped_range(
                local_minute(now),
                self.settings.quiet_start_minute,
                self.settings.quiet_end_minute,
            )
        {
            return None;
        }
        let quest = self.learning_quests.iter_mut().find(|quest| {
            quest.status == "pending"
                || quest.status == "retrying"
                    && quest.next_retry_at.is_none_or(|retry_at| now >= retry_at)
        })?;
        quest.status = "asking".to_owned();
        quest.started_at = Some(now);
        quest.next_retry_at = None;
        quest.attempts = quest.attempts.saturating_add(1);
        quest.error = None;
        let claimed = quest.clone();
        self.set_behavior(
            now,
            "learning",
            "autonomous-agent-question",
            &format!(
                "I formed my own question and am asking Agent: {}",
                claimed.question
            ),
            5 * 60_000,
            None,
        );
        self.log(
            now,
            "question",
            &format!(
                "我自己想问 Agent：{} || I chose to ask Agent: {}",
                claimed.question, claimed.question
            ),
        );
        Some(claimed)
    }

    pub fn claim_learning_question_formation(&mut self, now: i64) -> Option<PetLearningQuest> {
        if !self.settings.autonomy_enabled
            || !self.settings.learning_enabled
            || self.needs.energy < 30.0
            || minute_in_wrapped_range(
                local_minute(now),
                self.settings.quiet_start_minute,
                self.settings.quiet_end_minute,
            )
        {
            return None;
        }
        let quest = self.learning_quests.iter_mut().find(|quest| {
            quest.status == "formation-pending"
                || quest.status == "formation-retrying"
                    && quest.next_retry_at.is_none_or(|retry_at| now >= retry_at)
        })?;
        quest.status = "formulating".to_owned();
        quest.started_at = Some(now);
        quest.next_retry_at = None;
        quest.formation_attempts = quest.formation_attempts.saturating_add(1);
        quest.error = None;
        let claimed = quest.clone();
        self.set_behavior(
            now,
            "learning",
            "autonomous-question-forming",
            "I am looking across what happened today to find something I genuinely do not understand yet.",
            5 * 60_000,
            None,
        );
        Some(claimed)
    }

    pub fn complete_learning_question_formation(
        &mut self,
        now: i64,
        quest_id: &str,
        input: PetLearningQuestionInput<'_>,
    ) -> Result<PetLearningQuest, String> {
        let quest_index = self
            .learning_quests
            .iter()
            .position(|quest| quest.id == quest_id && quest.status == "formulating")
            .ok_or_else(|| {
                "The autonomous question-forming request is no longer active".to_owned()
            })?;
        let mut question = input
            .question
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !question.ends_with(['?', '？']) {
            question.push('？');
        }
        let question_length = question.chars().count();
        if !(12..=280).contains(&question_length) || learning_question_is_sensitive(&question) {
            return Err("Agent formed an invalid or sensitive autonomous question".to_owned());
        }
        if self
            .learning_quests
            .iter()
            .enumerate()
            .any(|(index, existing)| {
                index != quest_index
                    && !existing.question.is_empty()
                    && questions_too_similar(&question, &existing.question)
            })
        {
            return Err("Agent repeated a recent autonomous question".to_owned());
        }
        let topic = shorten(input.topic.trim(), 90);
        let rationale = shorten(input.rationale.trim(), 240);
        if topic.chars().count() < 2
            || rationale.chars().count() < 4
            || learning_question_is_sensitive(&topic)
            || learning_question_is_sensitive(&rationale)
        {
            return Err("Agent did not explain the autonomous question clearly".to_owned());
        }
        let quest = &mut self.learning_quests[quest_index];
        quest.question = question;
        quest.topic = topic;
        quest.rationale = Some(rationale);
        quest.question_provider_id = input
            .provider_id
            .map(|value| shorten(value.trim(), 120))
            .filter(|value| !value.is_empty());
        quest.status = "pending".to_owned();
        quest.started_at = None;
        quest.next_retry_at = None;
        quest.error = None;
        let formed = quest.clone();
        self.set_behavior(
            now,
            "learning",
            "autonomous-question-formed",
            &format!(
                "I found something I genuinely want to understand: {}",
                formed.question
            ),
            90_000,
            None,
        );
        self.log(
            now,
            "question",
            &format!(
                "我根据最近发生的事形成了一个问题：{} || I formed a question from recent context: {}",
                formed.question, formed.question
            ),
        );
        Ok(formed)
    }

    pub fn defer_learning_question_formation(
        &mut self,
        now: i64,
        quest_id: &str,
        rationale: &str,
        provider_id: Option<&str>,
    ) -> bool {
        if learning_question_is_sensitive(rationale) {
            return false;
        }
        let Some(quest) = self
            .learning_quests
            .iter_mut()
            .find(|quest| quest.id == quest_id && quest.status == "formulating")
        else {
            return false;
        };
        quest.status = "deferred".to_owned();
        quest.started_at = None;
        quest.completed_at = Some(now);
        quest.next_retry_at = None;
        quest.rationale = Some(shorten(rationale.trim(), 240));
        quest.question_provider_id = provider_id
            .map(|value| shorten(value.trim(), 120))
            .filter(|value| !value.is_empty());
        quest.error = None;
        self.set_behavior(
            now,
            "idle",
            "autonomous-no-question",
            "I reflected on the latest context, but I do not need to force a question right now.",
            2 * 60_000,
            None,
        );
        true
    }

    pub fn fail_learning_question_formation(
        &mut self,
        now: i64,
        quest_id: &str,
        error: &str,
    ) -> bool {
        let Some(quest) = self
            .learning_quests
            .iter_mut()
            .find(|quest| quest.id == quest_id && quest.status == "formulating")
        else {
            return false;
        };
        let will_retry = quest.formation_attempts < 3;
        quest.status = if will_retry {
            "formation-retrying"
        } else {
            "formation-failed"
        }
        .to_owned();
        quest.started_at = None;
        quest.error = Some(shorten(error, 180));
        quest.next_retry_at = will_retry.then(|| {
            let multiplier = 1_i64 << quest.formation_attempts.saturating_sub(1).min(2);
            now.saturating_add(AUTONOMOUS_LEARNING_RETRY_BASE_MS.saturating_mul(multiplier))
        });
        self.set_behavior(
            now,
            "resting",
            if will_retry {
                "autonomous-question-retry"
            } else {
                "autonomous-question-failed"
            },
            if will_retry {
                "I could not form a grounded question this time. I will reflect again later."
            } else {
                "I stopped after repeated unclear attempts instead of inventing a question."
            },
            3 * 60_000,
            None,
        );
        true
    }

    pub fn complete_learning_quest(
        &mut self,
        now: i64,
        quest_id: &str,
        input: PetKnowledgeInput<'_>,
        provider_id: Option<&str>,
    ) -> Result<PetKnowledge, String> {
        let quest_index = self
            .learning_quests
            .iter()
            .position(|quest| quest.id == quest_id && quest.status == "asking")
            .ok_or_else(|| "The autonomous learning question is no longer active".to_owned())?;
        let knowledge = self.record_knowledge(now, input)?;
        let quest = &mut self.learning_quests[quest_index];
        quest.status = "completed".to_owned();
        quest.completed_at = Some(now);
        quest.next_retry_at = None;
        quest.answer_title = Some(knowledge.title.clone());
        quest.knowledge_id = Some(knowledge.id.clone());
        quest.provider_id = provider_id.map(|value| shorten(value, 120));
        quest.error = None;
        self.needs.focus = clamp_percent(self.needs.focus - 3.0);
        self.set_behavior(
            now,
            "discovering",
            "autonomous-learning-complete",
            &format!(
                "Agent helped me answer my question. I learned: {}",
                knowledge.title
            ),
            90_000,
            None,
        );
        self.log(
            now,
            "learning",
            &format!("我向 Agent 问出了自己的问题，并学会了：{} || I asked Agent my own question and learned: {}", knowledge.title, knowledge.title),
        );
        Ok(knowledge)
    }

    pub fn fail_learning_quest(&mut self, now: i64, quest_id: &str, error: &str) -> bool {
        let Some(quest) = self
            .learning_quests
            .iter_mut()
            .find(|quest| quest.id == quest_id && quest.status == "asking")
        else {
            return false;
        };
        let will_retry = quest.attempts < 3;
        quest.status = if will_retry { "retrying" } else { "failed" }.to_owned();
        quest.started_at = None;
        quest.error = Some(shorten(error, 180));
        quest.next_retry_at = will_retry.then(|| {
            let multiplier = 1_i64 << quest.attempts.saturating_sub(1).min(2);
            now.saturating_add(AUTONOMOUS_LEARNING_RETRY_BASE_MS.saturating_mul(multiplier))
        });
        self.set_behavior(
            now,
            "resting",
            if will_retry { "autonomous-learning-retry" } else { "autonomous-learning-failed" },
            if will_retry {
                "Agent did not answer clearly this time. I kept my question and will ask again later."
            } else {
                "I could not get a reliable answer after several tries, so I stopped instead of pretending I learned it."
            },
            3 * 60_000,
            None,
        );
        self.log(
            now,
            "learning",
            if will_retry {
                "Agent 这次没有给我可靠答案。我保留了问题，晚些时候会再问。 || Agent did not give me a reliable answer, so I kept the question for a later retry."
            } else {
                "这个问题连续没有得到可靠答案，我没有把它冒充成知识。 || This question never received a reliable answer, so I did not pretend it was knowledge."
            },
        );
        true
    }

    pub fn delete_knowledge(&mut self, now: i64, knowledge_id: &str) -> bool {
        let previous = self.knowledge.len();
        self.knowledge.retain(|item| item.id != knowledge_id);
        let removed = previous != self.knowledge.len();
        if removed {
            self.log(
                now,
                "knowledge",
                "I let go of a knowledge entry you removed.",
            );
        }
        removed
    }

    pub fn settle_day(&mut self, now: i64, reflection: &str) -> bool {
        let date = local_date_key(now);
        let day = self
            .days
            .entry(date.clone())
            .or_insert_with(|| empty_day(&date));
        day.reflection = shorten(reflection.trim(), 240);
        day.settled_at = Some(now);
        for item in &mut day.schedule {
            if item.status == "active" {
                item.status = "planned".to_owned();
            }
        }
        self.refresh_rewards(now);
        self.log(
            now,
            "reflection",
            "I tucked today's progress into our journal.",
        );
        true
    }

    pub fn update_settings(&mut self, settings: PetLifeSettings) {
        self.settings = settings;
        self.normalize(self.last_tick_at.max(1));
        if !self.settings.autonomy_enabled {
            self.behavior.next_decision_at = 0;
        }
    }

    pub fn set_window_position(&mut self, x: f64, y: f64) -> bool {
        if !x.is_finite() || !y.is_finite() {
            return false;
        }
        self.window_position = Some(PetWindowPosition { x, y });
        true
    }

    fn reconcile_recurring_tasks(&mut self, now: i64) {
        let date = local_date_key(now);
        let Some(today) = parse_date_key(&date) else {
            return;
        };
        let templates = self
            .tasks
            .iter()
            .filter_map(|task| {
                let recurrence = task.recurrence.as_deref()?;
                let series_id = task.series_id.as_deref().unwrap_or(task.id.as_str());
                let origin = task
                    .occurrence_date
                    .as_deref()
                    .and_then(parse_date_key)
                    .unwrap_or_else(|| {
                        local_datetime(task.created_at)
                            .map(|value| value.date_naive())
                            .unwrap_or(today)
                    });
                if recurring_task_due(recurrence, origin, today) {
                    Some((
                        series_id.to_owned(),
                        task.title.clone(),
                        task.notes.clone(),
                        task.priority,
                        recurrence.to_owned(),
                    ))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for (series_id, title, notes, priority, recurrence) in templates {
            if self.tasks.iter().any(|task| {
                task.series_id.as_deref() == Some(series_id.as_str())
                    && task.occurrence_date.as_deref() == Some(date.as_str())
            }) {
                continue;
            }
            self.tasks.push(PetTask {
                id: format!("repeat:{series_id}:{date}"),
                title,
                notes,
                due_date: Some(date.clone()),
                recurrence: Some(recurrence),
                priority,
                status: "pending".to_owned(),
                created_at: now,
                completed_at: None,
                series_id: Some(series_id),
                occurrence_date: Some(date.clone()),
            });
        }
        trim_oldest(&mut self.tasks, MAX_TASKS);
    }

    fn reconcile_study_launch(&mut self, now: i64) {
        if !self.settings.reminders_enabled {
            return;
        }
        let Some((period, started_at)) = study_period(now) else {
            return;
        };
        if self
            .study_sessions
            .iter()
            .any(|session| session.ended_at.is_none())
        {
            self.complete_study_launch(now, "organic");
            return;
        }
        let launch = self.study_launch_mut(now, period);
        if launch.available_at <= 0 {
            launch.available_at = started_at;
        }
        if launch.completed_at.is_some() || launch.skipped_at.is_some() {
            return;
        }
        let due_at = launch
            .snoozed_until
            .unwrap_or_else(|| launch.available_at.saturating_add(STUDY_LAUNCH_GRACE_MS));
        if now < due_at {
            return;
        }
        let escalation_started_at = launch.available_at.saturating_add(STUDY_LAUNCH_GRACE_MS);
        let tier = if period == "evening" {
            "playful"
        } else {
            supervision_tier(now.saturating_sub(escalation_started_at))
        };
        let tier_changed = launch.supervision_tier != tier;
        let repeat_due = launch
            .last_reminder_at
            .is_none_or(|last| now.saturating_sub(last) >= STUDY_LAUNCH_SNOOZE_MS);
        if launch.prompted_at.is_none() || tier_changed || repeat_due {
            launch.prompted_at = Some(now);
            launch.last_reminder_at = Some(now);
            launch.reminder_count = launch.reminder_count.saturating_add(1);
            launch.supervision_tier = tier.to_owned();
        }
    }

    fn reconcile_task_reminders(&mut self, now: i64) {
        if !self.settings.reminders_enabled {
            return;
        }
        let minute = local_minute(now);
        let slot = if minute >= 22 * 60 {
            Some("22:00")
        } else if minute >= 21 * 60 + 6 {
            Some("21:00")
        } else {
            None
        };
        let Some(slot) = slot else {
            return;
        };
        let pending = self.tasks.iter().any(|task| task.status != "completed");
        let date = local_date_key(now);
        let day = self
            .days
            .entry(date.clone())
            .or_insert_with(|| empty_day(&date));
        if pending && !day.task_reminders.contains_key(slot) {
            day.task_reminders.insert(slot.to_owned(), now);
        }
    }

    fn maybe_hourly_chatter(&mut self, now: i64, pet_name: &str) -> bool {
        let Some(value) = local_datetime(now) else {
            return false;
        };
        if value.minute() > 1 || matches!(value.hour(), 0..=7 | 9 | 12 | 15 | 18 | 21) {
            return false;
        }
        let date = local_date_key(now);
        let slot = format!("{:02}:00", value.hour());
        let day = self
            .days
            .entry(date.clone())
            .or_insert_with(|| empty_day(&date));
        if day.chatter_slots.contains_key(&slot) {
            return false;
        }
        let messages = match value.hour() {
            8..=11 => [
                "早上好。我把今天的安排放在这里了，也替你留了一点喘气的空白。",
                "窗外已经亮了。先完成最小的一步，今天就会慢慢打开。",
                "我刚整理了一下思绪。你不必一下子做好所有事，我陪你从一件开始。",
            ],
            13..=17 => [
                "下午容易有些散。喝口水吧，回来时我们只盯住眼前这一件事。",
                "我在这里，没有催你跑得更快。只是提醒你，别把自己落在后面。",
                "如果刚才不顺利，也没关系。下一小段仍然是新的开始。",
            ],
            _ => [
                "今天已经走了很远。还有力气就收好一件事，累了也可以诚实休息。",
                "晚上的光慢下来了。我会陪你把今天收好，不让努力悄悄丢掉。",
                "不论今天完成了多少，我都记得你确实来过，也确实认真过。",
            ],
        };
        let index = (value.ordinal0() as usize + value.hour() as usize) % messages.len();
        day.chatter_slots.insert(slot, now);
        self.set_behavior(
            now,
            "idle",
            "hourly-chatter",
            &format!("{pet_name}: {}", messages[index]),
            75_000,
            None,
        );
        true
    }

    fn study_launch_mut(&mut self, now: i64, period: &str) -> &mut PetStudyLaunch {
        let date = local_date_key(now);
        self.days
            .entry(date.clone())
            .or_insert_with(|| empty_day(&date))
            .study_launches
            .entry(period.to_owned())
            .or_insert_with(|| PetStudyLaunch {
                period: period.to_owned(),
                ..PetStudyLaunch::default()
            })
    }

    fn complete_study_launch(&mut self, now: i64, source: &str) {
        let Some((period, started_at)) = study_period(now) else {
            return;
        };
        let launch = self.study_launch_mut(now, period);
        if launch.completed_at.is_some() || launch.skipped_at.is_some() {
            return;
        }
        if launch.available_at <= 0 {
            launch.available_at = started_at;
        }
        launch.completed_at = Some(now);
        launch.prompted_at = None;
        launch.source = Some(shorten(source, 32));
    }

    fn current_prompt(&self, now: i64) -> Option<PetPrompt> {
        if !self.settings.reminders_enabled {
            return None;
        }
        let date = local_date_key(now);
        let day = self.days.get(&date)?;
        let minute = local_minute(now);
        if let Some(slot) = CHECK_IN_SLOTS.into_iter().find(|slot| {
            minute.abs_diff(*slot) <= 5
                && day
                    .check_ins
                    .get(&minute_label(*slot))
                    .is_none_or(|check_in| check_in.status != "checked")
        }) {
            let label = minute_label(slot);
            return Some(PetPrompt {
                id: format!("{date}:check-in:{label}"),
                kind: "check-in".to_owned(),
                message: format!("It is our {label} check-in. Let me know you are here."),
                period: Some(label),
                tier: None,
                actions: vec!["check-in".to_owned()],
            });
        }
        if let Some((period, started_at)) = study_period(now)
            && let Some(launch) = day.study_launches.get(period)
            && launch.completed_at.is_none()
            && launch.skipped_at.is_none()
            && launch.prompted_at.is_some()
            && launch.snoozed_until.is_none_or(|until| now >= until)
        {
            let tier = if period == "evening" {
                "playful".to_owned()
            } else {
                supervision_tier(
                    now.saturating_sub(started_at.saturating_add(STUDY_LAUNCH_GRACE_MS)),
                )
                .to_owned()
            };
            return Some(PetPrompt {
                id: format!("{date}:study:{period}:{}", launch.reminder_count),
                kind: "study-launch".to_owned(),
                message: study_prompt_message(&tier).to_owned(),
                period: Some(period.to_owned()),
                tier: Some(tier),
                actions: [
                    Some("start".to_owned()),
                    launch.snoozed_until.is_none().then(|| "snooze".to_owned()),
                    Some("skip".to_owned()),
                ]
                .into_iter()
                .flatten()
                .collect(),
            });
        }
        let slot = (local_minute(now) >= 22 * 60)
            .then_some("22:00")
            .or_else(|| (local_minute(now) >= 21 * 60 + 6).then_some("21:00"));
        if let Some(slot) = slot
            && day.task_reminders.contains_key(slot)
            && !day
                .task_reminders
                .contains_key(&format!("{slot}:dismissed"))
        {
            let pending = self
                .tasks
                .iter()
                .filter(|task| task.status != "completed")
                .count();
            return Some(PetPrompt {
                id: format!("{date}:tasks:{slot}"),
                kind: "task-reminder".to_owned(),
                message: format!(
                    "There are {pending} promises still open today. Shall we look at them together?"
                ),
                period: None,
                tier: None,
                actions: vec!["open".to_owned(), "dismiss".to_owned()],
            });
        }
        None
    }

    fn apply_elapsed_needs(&mut self, now: i64) {
        let elapsed = ((now.saturating_sub(self.last_tick_at)) as f64 / 60_000.0)
            .clamp(0.0, MAX_TICK_MINUTES);
        if elapsed <= 0.0 {
            return;
        }
        match self.behavior.state.as_str() {
            "resting" | "sleeping" => {
                self.needs.energy += 0.24 * elapsed;
                self.needs.focus += 0.08 * elapsed;
                self.needs.curiosity -= 0.015 * elapsed;
            }
            "studying" | "learning" | "planning" => {
                self.needs.energy -= 0.11 * elapsed;
                self.needs.focus -= 0.09 * elapsed;
                self.needs.curiosity += 0.025 * elapsed;
                self.needs.social -= 0.02 * elapsed;
            }
            "wandering" => {
                self.needs.energy -= 0.15 * elapsed;
                self.needs.focus += 0.035 * elapsed;
                self.needs.mood += 0.04 * elapsed;
            }
            _ => {
                self.needs.energy -= 0.025 * elapsed;
                self.needs.focus += 0.01 * elapsed;
                self.needs.curiosity -= 0.035 * elapsed;
                self.needs.social -= 0.025 * elapsed;
            }
        }
        let wellbeing = (self.needs.energy + self.needs.focus + self.needs.social) / 3.0;
        self.needs.mood += (wellbeing - self.needs.mood) * 0.0025 * elapsed;
        self.needs.energy = clamp_percent(self.needs.energy);
        self.needs.focus = clamp_percent(self.needs.focus);
        self.needs.curiosity = clamp_percent(self.needs.curiosity);
        self.needs.social = clamp_percent(self.needs.social);
        self.needs.mood = clamp_percent(self.needs.mood);
    }

    fn absorb_memories(&mut self, now: i64, memories: &[PetMemory]) {
        for memory in memories.iter().filter(|memory| memory.confidence >= 0.7) {
            let source_ref = format!("memory:{}", memory.id);
            if self
                .knowledge
                .iter()
                .any(|knowledge| knowledge.source_ref.as_deref() == Some(source_ref.as_str()))
            {
                continue;
            }
            let title = match memory.kind.as_str() {
                "identity" => "关于你的身份",
                "preference" => "你的偏好与目标",
                "explicit" => "你托付给我的记忆",
                _ => "从对话中理解到的事",
            };
            let _ = self.record_knowledge(
                now,
                PetKnowledgeInput {
                    title,
                    summary: &memory.text,
                    source: "Reviewed conversation memory",
                    source_kind: "memory",
                    source_ref: Some(&source_ref),
                    tags: vec![memory.kind.clone(), "memory".to_owned()],
                    confidence: memory.confidence,
                },
            );
        }
    }

    fn reconcile_schedule(&mut self, now: i64) {
        let date = local_date_key(now);
        let minute = local_minute(now);
        let Some(day) = self.days.get_mut(&date) else {
            return;
        };
        for item in &mut day.schedule {
            if item.status == "completed" || item.status == "skipped" {
                continue;
            }
            let end = item.start_minute.saturating_add(item.duration_minutes);
            if minute >= item.start_minute && minute < end {
                item.status = "active".to_owned();
            } else if item.status == "active" {
                item.status = "completed".to_owned();
                item.completed_at = Some(now);
            } else if minute > end.saturating_add(60) {
                item.status = "missed".to_owned();
            }
        }
    }

    fn reconcile_autonomous_learning(&mut self, now: i64) {
        if !self.settings.autonomy_enabled
            || !self.settings.learning_enabled
            || self.needs.energy < 30.0
            || minute_in_wrapped_range(
                local_minute(now),
                self.settings.quiet_start_minute,
                self.settings.quiet_end_minute,
            )
            || now.saturating_sub(self.born_at) < 45_000
        {
            return;
        }
        if self.learning_quests.iter().any(|quest| {
            matches!(
                quest.status.as_str(),
                "formation-pending"
                    | "formulating"
                    | "formation-retrying"
                    | "pending"
                    | "asking"
                    | "retrying"
            )
        }) {
            return;
        }
        let date = local_date_key(now);
        let completed_today = self
            .learning_quests
            .iter()
            .filter(|quest| {
                quest.status == "completed"
                    && quest
                        .completed_at
                        .is_some_and(|value| local_date_key(value) == date)
            })
            .count() as u32;
        if completed_today >= self.settings.knowledge_goal {
            return;
        }
        let attempts_today = self
            .learning_quests
            .iter()
            .filter(|quest| local_date_key(quest.created_at) == date)
            .count() as u32;
        if attempts_today >= self.settings.knowledge_goal.saturating_mul(2).max(2) {
            return;
        }
        let Some(learning_mode) = self.next_autonomous_learning_mode(now) else {
            return;
        };
        self.learning_quests.push(PetLearningQuest {
            id: uuid::Uuid::new_v4().to_string(),
            question: String::new(),
            topic: String::new(),
            learning_mode: learning_mode.to_owned(),
            status: "formation-pending".to_owned(),
            created_at: now,
            started_at: None,
            completed_at: None,
            next_retry_at: None,
            attempts: 0,
            formation_attempts: 0,
            rationale: None,
            question_provider_id: None,
            answer_title: None,
            knowledge_id: None,
            provider_id: None,
            error: None,
        });
        trim_oldest(&mut self.learning_quests, MAX_LEARNING_QUESTS);
    }

    fn next_autonomous_learning_mode(&self, now: i64) -> Option<&'static str> {
        let last_created_at = self
            .learning_quests
            .iter()
            .map(|quest| quest.created_at)
            .max();
        let reference_time = last_created_at.unwrap_or(self.born_at);
        let elapsed = now.saturating_sub(reference_time);
        let has_fresh_observation = self
            .recent_observations
            .iter()
            .any(|observation| observation.created_at > reference_time);
        if has_fresh_observation && elapsed >= AUTONOMOUS_CONTEXT_INTERVAL_MS {
            return Some("context");
        }

        let last_identity_at = self
            .learning_quests
            .iter()
            .filter(|quest| quest.learning_mode == "identity")
            .map(|quest| quest.created_at)
            .max();
        let identity_due = last_identity_at
            .map(|last| now.saturating_sub(last) >= AUTONOMOUS_IDENTITY_INTERVAL_MS)
            .unwrap_or_else(|| {
                now.saturating_sub(self.born_at) >= AUTONOMOUS_IDENTITY_INITIAL_DELAY_MS
            });
        if identity_due && elapsed >= AUTONOMOUS_IDENTITY_INITIAL_DELAY_MS {
            return Some("identity");
        }

        if !self.knowledge.is_empty()
            && self.needs.curiosity >= 72.0
            && elapsed >= AUTONOMOUS_DEEPENING_INTERVAL_MS
        {
            return Some("deepening");
        }
        if self.needs.curiosity >= 82.0 && elapsed >= AUTONOMOUS_EXPLORATION_INTERVAL_MS {
            return Some("exploration");
        }
        None
    }

    fn reconcile_check_ins(&mut self, now: i64) {
        let date = local_date_key(now);
        let minute = local_minute(now);
        let day = self
            .days
            .entry(date.clone())
            .or_insert_with(|| empty_day(&date));
        for slot in CHECK_IN_SLOTS {
            let label = minute_label(slot);
            if minute > slot + 5 && !day.check_ins.contains_key(&label) {
                day.check_ins.insert(
                    label.clone(),
                    PetCheckIn {
                        slot: label,
                        status: "missed".to_owned(),
                        responded_at: None,
                    },
                );
            }
        }
    }

    fn finish_autonomous_review(&mut self, now: i64) {
        if self.behavior.state != "learning" || now < self.behavior.next_decision_at {
            return;
        }
        let Some(item) = self
            .knowledge
            .iter_mut()
            .min_by_key(|item| (item.review_count, item.last_reviewed_at.unwrap_or(0)))
        else {
            return;
        };
        item.review_count = item.review_count.saturating_add(1);
        item.last_reviewed_at = Some(now);
        item.updated_at = now;
        self.needs.curiosity = clamp_percent(self.needs.curiosity + 9.0);
        let title = item.title.clone();
        self.log(now, "knowledge", &format!("I reviewed: {title}"));
    }

    fn maybe_wake_with_dream(&mut self, now: i64, pet_name: &str, was_sleeping: bool) -> bool {
        if !was_sleeping
            || minute_in_wrapped_range(
                local_minute(now),
                self.settings.quiet_start_minute,
                self.settings.quiet_end_minute,
            )
        {
            return false;
        }
        let date = local_date_key(now);
        let Some(item) = self
            .knowledge
            .iter()
            .min_by_key(|item| (item.review_count, item.last_reviewed_at.unwrap_or(0)))
            .cloned()
        else {
            return false;
        };
        let day = self
            .days
            .entry(date)
            .or_insert_with(|| empty_day(&local_date_key(now)));
        if day.chatter_slots.contains_key("dream") {
            return false;
        }
        day.chatter_slots.insert("dream".to_owned(), now);
        let message = format!(
            "{pet_name} woke with a small dream about {}. I think it belongs with what I already know.",
            shorten(&item.title, 46)
        );
        self.log(now, "dream", &message);
        self.set_behavior(
            now,
            "dreaming",
            "dream-fragment",
            &message,
            18 * 60_000,
            None,
        );
        true
    }

    fn maybe_self_discovery(&mut self, now: i64, pet_name: &str) -> bool {
        let candidates = self
            .knowledge
            .iter()
            .filter(|item| item.source_kind != "discovery")
            .cloned()
            .collect::<Vec<_>>();
        if candidates.len() < 2 {
            return false;
        }
        let Some(datetime) = local_datetime(now) else {
            return false;
        };
        if !(10..=20).contains(&datetime.hour()) {
            return false;
        }
        let date = local_date_key(now);
        let already_discovered = self
            .days
            .get(&date)
            .is_some_and(|day| day.chatter_slots.contains_key("discovery"));
        if already_discovered {
            return false;
        }
        let first_index =
            (datetime.ordinal0() as usize + datetime.hour() as usize) % candidates.len();
        let second_index = (first_index + 1 + candidates.len() / 2) % candidates.len();
        let first = candidates[first_index].title.clone();
        let second = candidates[second_index].title.clone();
        self.days
            .entry(date.clone())
            .or_insert_with(|| empty_day(&date))
            .chatter_slots
            .insert("discovery".to_owned(), now);
        let behavior_message = format!(
            "{pet_name} found a small bridge between {} and {}. I want to keep that connection.",
            shorten(&first, 34),
            shorten(&second, 34)
        );
        let discovery_title = format!("{} + {}", shorten(&first, 34), shorten(&second, 34));
        let discovery_summary = format!(
            "I noticed a possible connection between {first} and {second}. This is my own tentative association, not a verified fact."
        );
        let discovery_ref = format!("discovery:{date}");
        let _ = self.record_knowledge(
            now,
            PetKnowledgeInput {
                title: &discovery_title,
                summary: &discovery_summary,
                source: "Autonomous reflection",
                source_kind: "discovery",
                source_ref: Some(&discovery_ref),
                tags: vec!["self-discovery".to_owned(), "connection".to_owned()],
                confidence: 0.62,
            },
        );
        self.log(
            now,
            "discovery",
            &format!(
                "我把“{}”和“{}”放在一起，发现了一条新的微光。 || I placed '{}' beside '{}' and found a new glimmer between them.",
                shorten(&first, 24),
                shorten(&second, 24),
                shorten(&first, 24),
                shorten(&second, 24)
            ),
        );
        self.set_behavior(
            now,
            "discovering",
            "self-discovery",
            &behavior_message,
            90_000,
            None,
        );
        true
    }

    fn maybe_visit_favorite_corner(&mut self, now: i64) -> bool {
        if !self.settings.movement_enabled || self.needs.energy < 38.0 {
            return false;
        }
        let Some(datetime) = local_datetime(now) else {
            return false;
        };
        if !(10..=20).contains(&datetime.hour()) {
            return false;
        }
        let date = local_date_key(now);
        let already_visited = self
            .days
            .get(&date)
            .is_some_and(|day| day.chatter_slots.contains_key("favorite-corner"));
        if already_visited {
            return false;
        }
        self.days
            .entry(date.clone())
            .or_insert_with(|| empty_day(&date))
            .chatter_slots
            .insert("favorite-corner".to_owned(), now);
        let direction = if (datetime.ordinal0() as usize + self.knowledge.len()).is_multiple_of(2) {
            "left"
        } else {
            "right"
        };
        self.log(
            now,
            "place",
            "我选了今天喜欢的桌面角落，想去那里安静待一会儿。 || I chose today's favorite corner and went there for a quiet while.",
        );
        self.set_behavior(
            now,
            "wandering",
            "favorite-corner",
            "I chose a favorite corner for today. I am going there for a quiet while.",
            55_000,
            Some(direction.to_owned()),
        );
        true
    }

    fn choose_behavior(&mut self, now: i64, pet_name: &str) {
        let minute = local_minute(now);
        let quiet = minute_in_wrapped_range(
            minute,
            self.settings.quiet_start_minute,
            self.settings.quiet_end_minute,
        );
        let active_study = self
            .study_sessions
            .iter()
            .any(|session| session.ended_at.is_none());
        let pending_check_in = self.settings.reminders_enabled
            && CHECK_IN_SLOTS
                .into_iter()
                .any(|slot| minute.abs_diff(slot) <= 5 && !self.checked_slot(now, slot));
        let active_prompt = self.current_prompt(now);
        if quiet {
            if self.behavior.state != "sleeping" {
                self.set_behavior(
                    now,
                    "sleeping",
                    "quiet-hours",
                    "The day is quiet now. I am resting close by.",
                    30 * 60_000,
                    None,
                );
            }
            return;
        }
        if active_study {
            if self.behavior.state != "studying" {
                self.set_behavior(
                    now,
                    "studying",
                    "active-study-session",
                    "I am studying beside you and keeping track of the time.",
                    20 * 60_000,
                    None,
                );
            }
            return;
        }
        if pending_check_in {
            if self.behavior.state != "waiting" {
                self.set_behavior(
                    now,
                    "waiting",
                    "scheduled-check-in",
                    "I came over for our check-in. Let me know you are here.",
                    10 * 60_000,
                    None,
                );
            }
            return;
        }
        if !self.settings.autonomy_enabled {
            if self.behavior.state != "idle" || self.behavior.reason != "autonomy-paused" {
                self.set_behavior(
                    now,
                    "idle",
                    "autonomy-paused",
                    "I will stay here until you want me to choose activities again.",
                    10 * 60_000,
                    None,
                );
            }
            return;
        }
        if self.needs.energy < 24.0 {
            if self.behavior.state != "resting" {
                self.set_behavior(
                    now,
                    "resting",
                    "low-energy",
                    "I am a little tired. I will rest, then come back clearer.",
                    8 * 60_000,
                    None,
                );
            }
            return;
        }
        if let Some(prompt) = active_prompt {
            let reason =
                if prompt.kind == "study-launch" && prompt.period.as_deref() != Some("evening") {
                    format!(
                        "study-supervision-{}",
                        prompt.tier.as_deref().unwrap_or("playful")
                    )
                } else if prompt.kind == "study-launch" {
                    "study-launch-reminder".to_owned()
                } else {
                    "task-reminder".to_owned()
                };
            if self.behavior.state != "waiting" || self.behavior.reason != reason {
                self.set_behavior(
                    now,
                    "waiting",
                    &reason,
                    &prompt.message,
                    STUDY_LAUNCH_SNOOZE_MS,
                    None,
                );
            }
            return;
        }
        let ordinary_idle = matches!(self.behavior.reason.as_str(), "available" | "settling-in");
        if now < self.behavior.next_decision_at && !ordinary_idle {
            return;
        }
        if self.maybe_hourly_chatter(now, pet_name) {
            return;
        }
        if now < self.behavior.next_decision_at {
            return;
        }
        if let Some(item) = self.current_schedule_item(now).cloned() {
            match item.kind.as_str() {
                "focus" => {
                    self.set_behavior(
                        now,
                        "studying",
                        "daily-plan",
                        &format!("I chose to focus on: {}", item.title),
                        item.duration_minutes as i64 * 60_000,
                        None,
                    );
                    return;
                }
                "learn" => {
                    self.set_behavior(
                        now,
                        "learning",
                        "daily-plan",
                        &format!("I am learning now: {}", item.title),
                        item.duration_minutes as i64 * 60_000,
                        None,
                    );
                    return;
                }
                "plan" | "reflect" => {
                    self.set_behavior(
                        now,
                        "planning",
                        "daily-plan",
                        &format!("I am organizing: {}", item.title),
                        item.duration_minutes as i64 * 60_000,
                        None,
                    );
                    return;
                }
                "wander" if self.settings.movement_enabled => {
                    self.start_wandering(now, "daily-plan");
                    return;
                }
                _ => {}
            }
        }
        if self.maybe_self_discovery(now, pet_name) {
            return;
        }
        if self.maybe_visit_favorite_corner(now) {
            return;
        }
        if self.needs.curiosity < 42.0 && !self.knowledge.is_empty() {
            self.set_behavior(
                now,
                "learning",
                "curiosity",
                "Something I learned earlier is calling me back. I am reviewing it.",
                7 * 60_000,
                None,
            );
        } else if self.needs.focus < 32.0 {
            self.set_behavior(
                now,
                "resting",
                "low-focus",
                "My thoughts are scattered, so I am taking a quiet pause.",
                5 * 60_000,
                None,
            );
        } else if self.settings.movement_enabled
            && self
                .days
                .get(&local_date_key(now))
                .is_some_and(|day| day.settled_at.is_some())
            && minute >= 21 * 60
        {
            self.start_wandering(now, "night-stroll");
        } else if self.settings.movement_enabled
            && now.saturating_sub(self.last_patrol_at) >= PATROL_INTERVAL_MS
        {
            self.start_wandering(now, "self-directed-patrol");
        } else {
            self.set_behavior(
                now,
                "idle",
                "available",
                &format!("{pet_name} is nearby, awake, and ready to notice what happens next."),
                2 * 60_000,
                None,
            );
        }
    }

    fn start_wandering(&mut self, now: i64, reason: &str) {
        self.last_patrol_at = now;
        let direction = if now.div_euclid(60_000) % 2 == 0 {
            "right"
        } else {
            "left"
        };
        self.set_behavior(
            now,
            "wandering",
            reason,
            "I am stretching my legs and taking a small walk across the desktop.",
            42_000,
            Some(direction.to_owned()),
        );
    }

    fn set_behavior(
        &mut self,
        now: i64,
        state: &str,
        reason: &str,
        message: &str,
        duration_ms: i64,
        direction: Option<String>,
    ) {
        let changed = self.behavior.state != state || self.behavior.reason != reason;
        self.behavior = PetBehavior {
            state: state.to_owned(),
            reason: reason.to_owned(),
            message: shorten(message, 180),
            since: now,
            next_decision_at: now.saturating_add(duration_ms.max(1_000)),
            direction,
        };
        if changed {
            self.log(
                now,
                "behavior",
                &format!("I chose to {state} because of {reason}."),
            );
        }
    }

    fn current_schedule_item(&self, now: i64) -> Option<&PetScheduleItem> {
        let date = local_date_key(now);
        self.days
            .get(&date)?
            .schedule
            .iter()
            .find(|item| item.status == "active")
    }

    fn checked_slot(&self, now: i64, slot: u32) -> bool {
        self.days
            .get(&local_date_key(now))
            .and_then(|day| day.check_ins.get(&minute_label(slot)))
            .is_some_and(|check_in| check_in.status == "checked")
    }

    fn refresh_rewards(&mut self, now: i64) {
        let date = local_date_key(now);
        let study_minutes = self.study_ms_for_date(&date, now) / 60_000;
        let knowledge_count = self
            .knowledge
            .iter()
            .filter(|item| local_date_key(item.created_at) == date)
            .count() as u64;
        let focus_done = study_minutes >= self.settings.study_goal_minutes as u64;
        let knowledge_done = knowledge_count >= self.settings.knowledge_goal as u64;
        if focus_done {
            self.award_once(now, &date, "focus", "专注书签");
        }
        if knowledge_done {
            self.award_once(now, &date, "knowledge", "求知书签");
        }
        if focus_done && knowledge_done {
            self.award_once(now, &date, "together", "共鸣书签");
        }
    }

    fn award_once(&mut self, now: i64, date: &str, kind: &str, title: &str) {
        if self
            .rewards
            .iter()
            .any(|reward| reward.date == date && reward.kind == kind)
        {
            return;
        }
        self.rewards.push(PetReward {
            id: stable_daily_id(date, kind, 0),
            kind: kind.to_owned(),
            title: title.to_owned(),
            date: date.to_owned(),
            earned_at: now,
        });
        self.needs.mood = clamp_percent(self.needs.mood + 6.0);
        self.log(now, "reward", &format!("We earned: {title}"));
    }

    fn stats(&self, now: i64) -> PetLifeStats {
        let today = local_date_key(now);
        let completed_tasks = self
            .tasks
            .iter()
            .filter(|task| task.status == "completed")
            .count() as u64;
        let checked_in = self
            .days
            .values()
            .flat_map(|day| day.check_ins.values())
            .filter(|item| item.status == "checked")
            .count() as u64;
        let missed_check_ins = self
            .days
            .values()
            .flat_map(|day| day.check_ins.values())
            .filter(|item| item.status == "missed")
            .count() as u64;
        let manual_study_ms: u64 = self
            .study_sessions
            .iter()
            .map(|session| {
                session
                    .ended_at
                    .unwrap_or(now)
                    .saturating_sub(session.started_at)
                    .max(0) as u64
            })
            .sum();
        PetLifeStats {
            today_study_ms: self.study_ms_for_date(&today, now),
            total_study_ms: manual_study_ms,
            knowledge_count: self.knowledge.len() as u64,
            today_knowledge_count: self
                .knowledge
                .iter()
                .filter(|item| local_date_key(item.created_at) == today)
                .count() as u64,
            completed_tasks,
            checked_in,
            missed_check_ins,
            reward_count: self.rewards.len() as u64,
            streak_days: self.streak_days(now),
        }
    }

    fn study_ms_for_date(&self, date: &str, now: i64) -> u64 {
        let manual: u64 = self
            .study_sessions
            .iter()
            .filter(|session| local_date_key(session.started_at) == date)
            .map(|session| {
                session
                    .ended_at
                    .unwrap_or(now)
                    .saturating_sub(session.started_at)
                    .max(0) as u64
            })
            .sum();
        manual
    }

    fn history(&self, now: i64) -> Vec<PetDaySummary> {
        self.days
            .iter()
            .rev()
            .take(30)
            .map(|(date, day)| {
                let check_ins = day.check_ins.values();
                PetDaySummary {
                    date: date.clone(),
                    study_ms: self.study_ms_for_date(date, now),
                    checked_in: check_ins
                        .clone()
                        .filter(|item| item.status == "checked")
                        .count() as u32,
                    missed_check_ins: check_ins.filter(|item| item.status == "missed").count()
                        as u32,
                    completed_schedule: day
                        .schedule
                        .iter()
                        .filter(|item| item.status == "completed")
                        .count() as u32,
                    schedule_count: day.schedule.len() as u32,
                    completed_tasks: self
                        .tasks
                        .iter()
                        .filter(|task| {
                            task.completed_at
                                .is_some_and(|completed_at| local_date_key(completed_at) == *date)
                        })
                        .count() as u32,
                    knowledge_count: self
                        .knowledge
                        .iter()
                        .filter(|item| local_date_key(item.created_at) == *date)
                        .count() as u32,
                    reward_count: self
                        .rewards
                        .iter()
                        .filter(|reward| reward.date == *date)
                        .count() as u32,
                    reflection: day.reflection.clone(),
                }
            })
            .collect()
    }

    fn streak_days(&self, now: i64) -> u32 {
        let Some(mut cursor) = local_datetime(now) else {
            return 0;
        };
        let mut streak = 0;
        for _ in 0..MAX_DAYS {
            let date = format!(
                "{:04}-{:02}-{:02}",
                cursor.year(),
                cursor.month(),
                cursor.day()
            );
            let has_progress = self.study_ms_for_date(&date, now) > 0
                || self.tasks.iter().any(|task| {
                    task.completed_at
                        .is_some_and(|completed_at| local_date_key(completed_at) == date)
                })
                || self
                    .knowledge
                    .iter()
                    .any(|item| local_date_key(item.created_at) == date);
            if !has_progress {
                if streak == 0 && date == local_date_key(now) {
                    cursor -= chrono::Duration::days(1);
                    continue;
                }
                break;
            }
            streak += 1;
            cursor -= chrono::Duration::days(1);
        }
        streak
    }

    fn log(&mut self, now: i64, kind: &str, message: &str) {
        self.activity_log.push(PetActivityLogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            kind: shorten(kind, 32),
            message: shorten(message, 240),
            created_at: now,
        });
        trim_oldest(&mut self.activity_log, MAX_ACTIVITY_LOG);
    }

    fn prune(&mut self) {
        trim_oldest(&mut self.tasks, MAX_TASKS);
        trim_oldest(&mut self.knowledge, MAX_KNOWLEDGE);
        trim_oldest(&mut self.learning_quests, MAX_LEARNING_QUESTS);
        trim_oldest(&mut self.recent_observations, MAX_RECENT_OBSERVATIONS);
        trim_oldest(&mut self.rewards, MAX_REWARDS);
        trim_oldest(&mut self.activity_log, MAX_ACTIVITY_LOG);
        while self.days.len() > MAX_DAYS {
            let Some(key) = self.days.keys().next().cloned() else {
                break;
            };
            self.days.remove(&key);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetLifeSnapshot {
    pub version: u32,
    pub needs: PetNeeds,
    pub behavior: PetBehavior,
    pub settings: PetLifeSettings,
    pub today: PetDayRecord,
    pub tasks: Vec<PetTask>,
    pub knowledge: Vec<PetKnowledge>,
    pub learning_quests: Vec<PetLearningQuest>,
    pub recent_observations: Vec<PetUserObservation>,
    pub active_session: Option<PetStudySession>,
    pub rewards: Vec<PetReward>,
    pub activity_log: Vec<PetActivityLogEntry>,
    pub stats: PetLifeStats,
    pub history: Vec<PetDaySummary>,
    pub window_position: Option<PetWindowPosition>,
    pub prompt: Option<PetPrompt>,
    pub born_at: i64,
    pub last_tick_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetDaySummary {
    pub date: String,
    pub study_ms: u64,
    pub checked_in: u32,
    pub missed_check_ins: u32,
    pub completed_schedule: u32,
    pub schedule_count: u32,
    pub completed_tasks: u32,
    pub knowledge_count: u32,
    pub reward_count: u32,
    pub reflection: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetLifeStats {
    pub today_study_ms: u64,
    pub total_study_ms: u64,
    pub knowledge_count: u64,
    pub today_knowledge_count: u64,
    pub completed_tasks: u64,
    pub checked_in: u64,
    pub missed_check_ins: u64,
    pub reward_count: u64,
    pub streak_days: u32,
}

fn empty_day(date: &str) -> PetDayRecord {
    PetDayRecord {
        date: date.to_owned(),
        plan_generated_at: 0,
        plan_reason: "pending".to_owned(),
        schedule: Vec::new(),
        check_ins: BTreeMap::new(),
        reflection: String::new(),
        settled_at: None,
        task_reminders: BTreeMap::new(),
        chatter_slots: BTreeMap::new(),
        study_launches: BTreeMap::new(),
    }
}

fn local_datetime(now: i64) -> Option<chrono::DateTime<Local>> {
    Local.timestamp_millis_opt(now).single()
}

pub fn local_date_key(now: i64) -> String {
    local_datetime(now)
        .map(|date| format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day()))
        .unwrap_or_else(|| "1970-01-01".to_owned())
}

fn local_minute(now: i64) -> u32 {
    local_datetime(now)
        .map(|date| date.hour() * 60 + date.minute())
        .unwrap_or_default()
}

fn local_start_of_day(now: i64) -> Option<i64> {
    let value = local_datetime(now)?;
    Local
        .with_ymd_and_hms(value.year(), value.month(), value.day(), 0, 0, 0)
        .single()
        .map(|date| date.timestamp_millis())
}

fn study_period(now: i64) -> Option<(&'static str, i64)> {
    let minute = local_minute(now);
    let (period, start_minute) = if (9 * 60..12 * 60).contains(&minute) {
        ("morning", 9 * 60)
    } else if (15 * 60..18 * 60).contains(&minute) {
        ("afternoon", 15 * 60)
    } else if (18 * 60..21 * 60).contains(&minute) {
        ("evening", 18 * 60)
    } else {
        return None;
    };
    Some((
        period,
        local_start_of_day(now)?.saturating_add(start_minute as i64 * 60_000),
    ))
}

fn supervision_tier(elapsed_ms: i64) -> &'static str {
    match elapsed_ms.max(0) {
        value if value < 5 * 60_000 => "playful",
        value if value < 15 * 60_000 => "firm",
        value if value < 30 * 60_000 => "angry",
        _ => "final",
    }
}

fn normalize_supervision_tier(value: &str) -> String {
    match value {
        "playful" | "firm" | "angry" | "final" => value.to_owned(),
        _ => "playful".to_owned(),
    }
}

fn study_prompt_message(tier: &str) -> &'static str {
    match tier {
        "firm" => "I am serious now. Choose one small thing and begin; I will stay beside you.",
        "angry" => {
            "We have let this wait too long. Please open the first task now and take back this period."
        }
        "final" => {
            "This is my last call for this period. Start now, or tell me clearly to leave it quiet."
        }
        _ => "Shall we begin with one tiny step? Open the first task and I will learn beside you.",
    }
}

fn parse_date_key(value: &str) -> Option<NaiveDate> {
    valid_date_key(value)
        .then(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
        .flatten()
}

fn recurring_task_due(recurrence: &str, origin: NaiveDate, date: NaiveDate) -> bool {
    if date < origin {
        return false;
    }
    match recurrence {
        "daily" => true,
        "weekdays" => !matches!(date.weekday(), Weekday::Sat | Weekday::Sun),
        "weekly" => date.weekday() == origin.weekday(),
        _ => false,
    }
}

fn minute_label(minute: u32) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

fn minute_in_wrapped_range(minute: u32, start: u32, end: u32) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        minute >= start && minute < end
    } else {
        minute >= start || minute < end
    }
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        50.0
    }
}

fn shorten(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect::<String>()
}

fn normalize_required(value: &str, max_chars: usize, label: &str) -> Result<String, String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    Ok(shorten(&value, max_chars))
}

fn normalize_source_kind(value: &str) -> String {
    match value {
        "agent" | "conversation" | "task" | "memory" | "document" | "web" | "reflection"
        | "discovery" => value.to_owned(),
        _ => "other".to_owned(),
    }
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    tags.into_iter()
        .filter_map(|tag| {
            let tag = shorten(tag.trim(), 32);
            (!tag.is_empty() && seen.insert(canonical(&tag))).then_some(tag)
        })
        .take(8)
        .collect()
}

fn canonical(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn default_learning_mode() -> String {
    "context".to_owned()
}

fn normalize_learning_mode(value: &str) -> String {
    match value.trim() {
        "identity" => "identity",
        "deepening" => "deepening",
        "exploration" => "exploration",
        _ => "context",
    }
    .to_owned()
}

pub(crate) fn learning_question_is_sensitive(text: &str) -> bool {
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

fn questions_too_similar(left: &str, right: &str) -> bool {
    let left = canonical(left);
    let right = canonical(right);
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right || left.contains(&right) || right.contains(&left) {
        return true;
    }
    let left_chars = left.chars().collect::<BTreeSet<_>>();
    let right_chars = right.chars().collect::<BTreeSet<_>>();
    let union = left_chars.union(&right_chars).count();
    union > 0 && left_chars.intersection(&right_chars).count() * 100 / union >= 82
}

fn stable_daily_id(date: &str, kind: &str, index: usize) -> String {
    format!("{date}:{kind}:{index}")
}

fn valid_date_key(value: &str) -> bool {
    if value.len() != 10 {
        return false;
    }
    let bytes = value.as_bytes();
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, value)| matches!(index, 4 | 7) || value.is_ascii_digit())
}

fn trim_oldest<T>(items: &mut Vec<T>, max: usize) {
    if items.len() > max {
        items.drain(0..items.len() - max);
    }
}

fn life_version() -> u32 {
    PET_LIFE_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_time(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    fn object_keys(value: &serde_json::Value) -> BTreeSet<&str> {
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    fn completed_learning_quest(mode: &str, created_at: i64) -> PetLearningQuest {
        PetLearningQuest {
            id: format!("completed-{mode}-{created_at}"),
            question: "已经处理的问题？".to_owned(),
            topic: "既有主题".to_owned(),
            learning_mode: mode.to_owned(),
            status: "completed".to_owned(),
            created_at,
            started_at: Some(created_at),
            completed_at: Some(created_at + 1),
            next_retry_at: None,
            attempts: 1,
            formation_attempts: 1,
            rationale: Some("测试已完成的求知记录。".to_owned()),
            question_provider_id: None,
            answer_title: Some("已有答案".to_owned()),
            knowledge_id: None,
            provider_id: None,
            error: None,
        }
    }

    #[test]
    fn serialized_life_schema_contains_only_active_fields() {
        let now = local_time(2026, 8, 12, 10, 0);
        let date = local_date_key(now);
        let mut life = StoredPetLife::new(now);
        life.days.insert(date.clone(), empty_day(&date));

        let stored = serde_json::to_value(&life).unwrap();
        assert_eq!(
            object_keys(&stored),
            BTreeSet::from([
                "activityLog",
                "behavior",
                "bornAt",
                "days",
                "knowledge",
                "learningQuests",
                "lastPatrolAt",
                "lastPersistedAt",
                "lastTickAt",
                "needs",
                "recentObservations",
                "rewards",
                "settings",
                "studySessions",
                "tasks",
                "version",
                "windowPosition",
            ])
        );
        assert_eq!(
            object_keys(&stored["settings"]),
            BTreeSet::from([
                "autonomyEnabled",
                "dailyPlanEnabled",
                "knowledgeGoal",
                "launchAtLogin",
                "learningEnabled",
                "movementEnabled",
                "patrolSpeed",
                "quietEndMinute",
                "quietStartMinute",
                "remindersEnabled",
                "studyGoalMinutes",
            ])
        );
        assert_eq!(
            object_keys(&stored["days"][&date]),
            BTreeSet::from([
                "chatterSlots",
                "checkIns",
                "date",
                "planGeneratedAt",
                "planReason",
                "reflection",
                "schedule",
                "settledAt",
                "studyLaunches",
                "taskReminders",
            ])
        );

        let snapshot = serde_json::to_value(life.snapshot(now)).unwrap();
        assert_eq!(
            object_keys(&snapshot),
            BTreeSet::from([
                "activeSession",
                "activityLog",
                "behavior",
                "bornAt",
                "history",
                "knowledge",
                "learningQuests",
                "lastTickAt",
                "needs",
                "prompt",
                "recentObservations",
                "rewards",
                "settings",
                "stats",
                "tasks",
                "today",
                "version",
                "windowPosition",
            ])
        );
        assert_eq!(
            object_keys(&snapshot["history"][0]),
            BTreeSet::from([
                "checkedIn",
                "completedSchedule",
                "completedTasks",
                "date",
                "knowledgeCount",
                "missedCheckIns",
                "reflection",
                "rewardCount",
                "scheduleCount",
                "studyMs",
            ])
        );
    }

    #[test]
    fn legacy_settings_enable_independent_learning_by_default() {
        let mut legacy = serde_json::to_value(PetLifeSettings::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("learningEnabled");
        let restored: PetLifeSettings = serde_json::from_value(legacy).unwrap();
        assert!(restored.learning_enabled);
    }

    #[test]
    fn removed_offline_voice_settings_are_discarded() {
        let mut legacy = serde_json::to_value(PetLifeSettings::default()).unwrap();
        legacy["voiceEnabled"] = serde_json::json!(true);
        legacy["voiceVolume"] = serde_json::json!(0.72);
        let restored: PetLifeSettings = serde_json::from_value(legacy).unwrap();
        let stored = serde_json::to_value(restored).unwrap();
        assert!(stored.get("voiceEnabled").is_none());
        assert!(stored.get("voiceVolume").is_none());
    }

    #[test]
    fn creates_a_bounded_daily_plan_from_tasks_and_knowledge() {
        let now = local_time(2026, 8, 12, 7, 30);
        let mut life = StoredPetLife::new(now);
        life.add_task(now, "Ship the companion runtime", "", None, None, 3)
            .unwrap();
        life.record_knowledge(
            now,
            PetKnowledgeInput {
                title: "Animation anchors",
                summary: "Stable feet anchors reduce visible sprite jitter.",
                source: "Sprite QA",
                source_kind: "document",
                source_ref: None,
                tags: vec!["animation".to_owned()],
                confidence: 0.9,
            },
        )
        .unwrap();
        assert!(life.generate_daily_plan(now, "Yui", &[], true));
        let day = life.days.get(&local_date_key(now)).unwrap();
        assert_eq!(day.schedule.len(), 7);
        assert!(day.schedule.iter().any(|item| item.title.contains("Ship")));
        assert!(
            day.schedule
                .iter()
                .any(|item| item.title.contains("Animation"))
        );
    }

    #[test]
    fn daily_plan_prioritizes_due_work_and_defers_future_tasks() {
        let now = local_time(2026, 8, 12, 7, 30);
        let mut life = StoredPetLife::new(now);
        life.add_task(now, "Low priority backlog", "", None, None, 1)
            .unwrap();
        life.add_task(now, "Future urgent work", "", Some("2026-08-13"), None, 3)
            .unwrap();
        life.add_task(
            now,
            "Due high priority work",
            "",
            Some("2026-08-12"),
            None,
            3,
        )
        .unwrap();

        assert!(life.generate_daily_plan(now, "Yui", &[], true));
        let schedule = &life.days["2026-08-12"].schedule;
        let focus = schedule
            .iter()
            .find(|item| item.start_minute == 9 * 60 + 30)
            .unwrap();
        assert_eq!(focus.title, "Due high priority work");
        assert!(
            schedule
                .iter()
                .all(|item| item.title != "Future urgent work")
        );
    }

    #[test]
    fn regenerating_plan_preserves_the_days_lived_state() {
        let now = local_time(2026, 8, 12, 10, 0);
        let mut life = StoredPetLife::new(now);
        assert!(life.generate_daily_plan(now, "Yui", &[], true));
        let day = life.days.get_mut("2026-08-12").unwrap();
        day.schedule[0].status = "completed".to_owned();
        day.schedule[0].completed_at = Some(now);
        day.check_ins.insert(
            "09:00".to_owned(),
            PetCheckIn {
                slot: "09:00".to_owned(),
                status: "checked".to_owned(),
                responded_at: Some(now),
            },
        );
        day.reflection = "A day worth keeping".to_owned();
        day.task_reminders.insert("21:00".to_owned(), now);
        day.chatter_slots.insert("10".to_owned(), now);
        day.study_launches.insert(
            "morning".to_owned(),
            PetStudyLaunch {
                period: "morning".to_owned(),
                prompted_at: Some(now),
                reminder_count: 1,
                supervision_tier: "playful".to_owned(),
                ..PetStudyLaunch::default()
            },
        );

        assert!(life.generate_daily_plan(now + 60_000, "Yui", &[], true));
        let preserved = &life.days["2026-08-12"];
        assert_eq!(preserved.schedule[0].status, "completed");
        assert_eq!(preserved.schedule[0].completed_at, Some(now));
        assert_eq!(preserved.check_ins["09:00"].status, "checked");
        assert_eq!(preserved.reflection, "A day worth keeping");
        assert!(preserved.task_reminders.contains_key("21:00"));
        assert!(preserved.chatter_slots.contains_key("10"));
        assert_eq!(preserved.study_launches["morning"].reminder_count, 1);
    }

    #[test]
    fn autonomous_tick_rests_when_energy_is_low_and_sleeps_in_quiet_hours() {
        let morning = local_time(2026, 8, 12, 10, 10);
        let mut life = StoredPetLife::new(morning);
        life.needs.energy = 12.0;
        life.tick(morning + 60_000, "Yui", &[]);
        assert_eq!(life.behavior.state, "resting");

        let night = local_time(2026, 8, 12, 23, 10);
        life.tick(night, "Yui", &[]);
        assert_eq!(life.behavior.state, "sleeping");
    }

    #[test]
    fn autonomous_learning_does_not_require_a_manual_study_session() {
        let now = local_time(2026, 8, 12, 10, 10);
        let born_at = now - AUTONOMOUS_CONTEXT_INTERVAL_MS - 60_000;
        let mut life = StoredPetLife::new(born_at);
        assert!(life.observe_user_input(now - 60_000, "今天正在整理复杂任务的验证边界"));
        assert!(life.study_sessions.is_empty());
        life.tick(now, "Yui", &[]);
        assert_eq!(life.learning_quests.len(), 1);
        assert_eq!(life.learning_quests[0].status, "formation-pending");
        assert_eq!(life.learning_quests[0].learning_mode, "context");
        assert!(life.study_sessions.is_empty());

        assert!(life.claim_learning_quest(now + 1_000).is_none());
        let forming = life.claim_learning_question_formation(now + 1_000).unwrap();
        assert_eq!(forming.status, "formulating");
        let formed = life
            .complete_learning_question_formation(
                now + 2_000,
                &forming.id,
                PetLearningQuestionInput {
                    question: "怎样判断一个学习问题是否足够具体并且能够验证？",
                    topic: "可靠提问",
                    rationale: "主人今天正在整理复杂任务，我还不清楚怎样界定可验证的问题。",
                    provider_id: Some("question-provider"),
                },
            )
            .unwrap();
        assert_eq!(formed.status, "pending");
        assert_eq!(
            formed.question_provider_id.as_deref(),
            Some("question-provider")
        );
        let quest = life.claim_learning_quest(now + 3_000).unwrap();
        assert_eq!(quest.status, "asking");
        assert_eq!(life.behavior.reason, "autonomous-agent-question");
        let knowledge = life
            .complete_learning_quest(
                now + 4_000,
                &quest.id,
                PetKnowledgeInput {
                    title: "可靠提问的边界",
                    summary: "可靠提问要限定目标、已知条件与可验证标准，也要明确哪些事实会随时间变化；答案无法验证时，应保留不确定性而不是装作确定。",
                    source: "LevelUpAgent Agent",
                    source_kind: "agent",
                    source_ref: Some("agent-question:test"),
                    tags: vec!["提问".to_owned(), "验证".to_owned()],
                    confidence: 0.78,
                },
                Some("test-provider"),
            )
            .unwrap();
        assert_eq!(knowledge.source_kind, "agent");
        assert_eq!(life.learning_quests[0].status, "completed");
        assert_eq!(
            life.learning_quests[0].knowledge_id.as_deref(),
            Some(knowledge.id.as_str())
        );
        assert_eq!(
            life.learning_quests[0].provider_id.as_deref(),
            Some("test-provider")
        );
    }

    #[test]
    fn autonomous_learning_retries_without_writing_fake_knowledge() {
        let now = local_time(2026, 8, 12, 10, 10);
        let born_at = now - AUTONOMOUS_CONTEXT_INTERVAL_MS - 60_000;
        let mut life = StoredPetLife::new(born_at);
        assert!(life.observe_user_input(now - 60_000, "今天的长期计划里有一些待验证假设"));
        life.tick(now, "Yui", &[]);
        let forming = life.claim_learning_question_formation(now + 1_000).unwrap();
        life.complete_learning_question_formation(
            now + 2_000,
            &forming.id,
            PetLearningQuestionInput {
                question: "什么方法能验证长期计划中的假设是否仍然成立？",
                topic: "计划验证",
                rationale: "今天的计划包含长期事项，需要知道怎样检查旧假设。",
                provider_id: Some("question-provider"),
            },
        )
        .unwrap();
        let quest = life.claim_learning_quest(now + 3_000).unwrap();
        assert!(life.fail_learning_quest(now + 4_000, &quest.id, "invalid answer"));
        assert_eq!(life.learning_quests[0].status, "retrying");
        assert!(life.learning_quests[0].next_retry_at.is_some());
        assert!(life.knowledge.is_empty());
    }

    #[test]
    fn recent_owner_input_is_temporary_bounded_and_sensitive_safe() {
        let now = local_time(2026, 8, 12, 10, 10);
        let mut life = StoredPetLife::new(now);
        assert!(life.observe_user_input(now, "今天我在重构桌宠的学习状态机"));
        assert!(!life.observe_user_input(now + 1, "请记住 API key 是 sk-secret-value"));
        assert_eq!(life.recent_observations.len(), 1);
        assert_eq!(
            life.recent_observations[0].text,
            "今天我在重构桌宠的学习状态机"
        );
        life.normalize(now + RECENT_OBSERVATION_TTL_MS + 1);
        assert!(life.recent_observations.is_empty());
    }

    #[test]
    fn autonomous_learning_waits_for_a_real_signal_instead_of_filling_a_quota() {
        let now = local_time(2026, 8, 12, 16, 0);
        let mut life = StoredPetLife::new(now - 10 * 60_000);
        life.tick(now, "Yui", &[]);

        assert!(life.learning_quests.is_empty());
    }

    #[test]
    fn periodic_identity_learning_does_not_require_owner_context() {
        let now = local_time(2026, 8, 12, 10, 10);
        let mut life = StoredPetLife::new(now - AUTONOMOUS_IDENTITY_INITIAL_DELAY_MS - 1);
        life.tick(now, "Yui", &[]);

        assert_eq!(life.learning_quests.len(), 1);
        assert_eq!(life.learning_quests[0].learning_mode, "identity");

        life.learning_quests[0].status = "deferred".to_owned();
        life.learning_quests[0].completed_at = Some(now + 1_000);
        life.tick(now + AUTONOMOUS_DEEPENING_INTERVAL_MS, "Yui", &[]);
        assert_eq!(life.learning_quests.len(), 1);
    }

    #[test]
    fn fresh_owner_context_takes_priority_over_due_identity_research() {
        let now = local_time(2026, 8, 12, 10, 10);
        let born_at = now - AUTONOMOUS_IDENTITY_INITIAL_DELAY_MS - 60_000;
        let mut life = StoredPetLife::new(born_at);
        assert!(life.observe_user_input(now - 60_000, "我正在研究怎样让自主学习更自然"));
        life.tick(now, "Yui", &[]);

        assert_eq!(life.learning_quests.len(), 1);
        assert_eq!(life.learning_quests[0].learning_mode, "context");
    }

    #[test]
    fn curiosity_and_existing_knowledge_choose_distinct_learning_modes() {
        let now = local_time(2026, 8, 12, 16, 0);
        let mut deepening = StoredPetLife::new(now - AUTONOMOUS_DEEPENING_INTERVAL_MS - 1);
        deepening
            .record_knowledge(
                now - AUTONOMOUS_DEEPENING_INTERVAL_MS,
                PetKnowledgeInput {
                    title: "已有概念",
                    summary: "这是一条仍然存在适用边界和延伸关系、值得继续深化的既有知识。",
                    source: "Conversation",
                    source_kind: "conversation",
                    source_ref: Some("thread:test"),
                    tags: Vec::new(),
                    confidence: 0.8,
                },
            )
            .unwrap();
        deepening.learning_quests.push(completed_learning_quest(
            "identity",
            now - AUTONOMOUS_DEEPENING_INTERVAL_MS - 1,
        ));
        deepening.needs.curiosity = 100.0;
        deepening.tick(now, "Yui", &[]);
        assert_eq!(
            deepening.learning_quests.last().unwrap().learning_mode,
            "deepening"
        );

        let mut exploration = StoredPetLife::new(now - AUTONOMOUS_EXPLORATION_INTERVAL_MS - 1);
        exploration.learning_quests.push(completed_learning_quest(
            "identity",
            now - AUTONOMOUS_EXPLORATION_INTERVAL_MS - 1,
        ));
        exploration.needs.curiosity = 100.0;
        exploration.tick(now, "Yui", &[]);
        assert_eq!(
            exploration.learning_quests.last().unwrap().learning_mode,
            "exploration"
        );
    }

    #[test]
    fn daily_learning_cap_also_bounds_declined_question_attempts() {
        let now = local_time(2026, 8, 12, 16, 0);
        let mut life = StoredPetLife::new(now - 12 * 60 * 60_000);
        life.needs.curiosity = 90.0;
        for index in 0..4 {
            life.learning_quests.push(PetLearningQuest {
                id: format!("declined-{index}"),
                question: String::new(),
                topic: String::new(),
                learning_mode: "exploration".to_owned(),
                status: "deferred".to_owned(),
                created_at: now - 7 * 60 * 60_000 + index,
                started_at: None,
                completed_at: Some(now - 7 * 60 * 60_000 + index),
                next_retry_at: None,
                attempts: 0,
                formation_attempts: 1,
                rationale: Some("这次没有值得强行提出的问题。".to_owned()),
                question_provider_id: None,
                answer_title: None,
                knowledge_id: None,
                provider_id: None,
                error: None,
            });
        }

        life.tick(now, "Yui", &[]);
        assert_eq!(life.learning_quests.len(), 4);
    }

    #[test]
    fn curiosity_can_decide_not_to_force_a_question() {
        let now = local_time(2026, 8, 12, 10, 10);
        let born_at = now - AUTONOMOUS_CONTEXT_INTERVAL_MS - 60_000;
        let mut life = StoredPetLife::new(born_at);
        assert!(life.observe_user_input(now - 60_000, "今天没有出现需要强行求解的新问题"));
        life.tick(now, "Yui", &[]);
        let forming = life.claim_learning_question_formation(now + 1_000).unwrap();
        assert!(life.defer_learning_question_formation(
            now + 2_000,
            &forming.id,
            "今天没有新的、值得求解的知识缺口。",
            Some("question-provider"),
        ));
        assert_eq!(life.learning_quests[0].status, "deferred");
        assert_eq!(life.behavior.reason, "autonomous-no-question");
        assert!(life.claim_learning_quest(now + 3_000).is_none());
        life.tick(now + 4_000, "Yui", &[]);
        assert_eq!(life.learning_quests.len(), 1);
    }

    #[test]
    fn question_formation_rejects_duplicates_and_sensitive_rationale() {
        let now = local_time(2026, 8, 12, 10, 10);
        let born_at = now - AUTONOMOUS_CONTEXT_INTERVAL_MS - 60_000;
        let mut life = StoredPetLife::new(born_at);
        assert!(life.observe_user_input(now - 60_000, "今天安排了多个需要拆分的复杂任务"));
        life.tick(now, "Yui", &[]);
        let first = life.claim_learning_question_formation(now + 1_000).unwrap();
        life.complete_learning_question_formation(
            now + 2_000,
            &first.id,
            PetLearningQuestionInput {
                question: "如何验证任务拆分是否真的降低了行动门槛？",
                topic: "任务拆分",
                rationale: "主人今天安排了多个任务，我想理解拆分是否有效。",
                provider_id: None,
            },
        )
        .unwrap();
        life.learning_quests[0].status = "completed".to_owned();
        life.learning_quests.push(PetLearningQuest {
            id: "second".to_owned(),
            question: String::new(),
            topic: String::new(),
            learning_mode: "context".to_owned(),
            status: "formulating".to_owned(),
            created_at: now + AUTONOMOUS_CONTEXT_INTERVAL_MS,
            started_at: Some(now + AUTONOMOUS_CONTEXT_INTERVAL_MS),
            completed_at: None,
            next_retry_at: None,
            attempts: 0,
            formation_attempts: 1,
            rationale: None,
            question_provider_id: None,
            answer_title: None,
            knowledge_id: None,
            provider_id: None,
            error: None,
        });
        let duplicate = life.complete_learning_question_formation(
            now + AUTONOMOUS_CONTEXT_INTERVAL_MS + 1,
            "second",
            PetLearningQuestionInput {
                question: "如何验证任务拆分是否真的降低了行动门槛？",
                topic: "任务拆分",
                rationale: "想再问一次相同的问题。",
                provider_id: None,
            },
        );
        assert!(duplicate.is_err());
        let sensitive = life.complete_learning_question_formation(
            now + AUTONOMOUS_CONTEXT_INTERVAL_MS + 2,
            "second",
            PetLearningQuestionInput {
                question: "怎样验证一个任务拆分方法的实际效果？",
                topic: "任务拆分",
                rationale: "参考 password=secret 继续思考。",
                provider_id: None,
            },
        );
        assert!(sensitive.is_err());
    }

    #[test]
    fn patrol_uses_a_cooldown_instead_of_a_minute_modulo() {
        let now = local_time(2026, 8, 12, 13, 7);
        let mut life = StoredPetLife::new(now - PATROL_INTERVAL_MS - 60_000);
        life.born_at = now - PATROL_INTERVAL_MS - 60_000;
        let date = local_date_key(now);
        let mut day = empty_day(&date);
        day.chatter_slots.insert("favorite-corner".to_owned(), now);
        life.days.insert(date, day);
        life.behavior.next_decision_at = now;
        life.last_patrol_at = now - PATROL_INTERVAL_MS;
        life.tick(now, "Yui", &[]);
        assert_eq!(life.behavior.reason, "self-directed-patrol");
        assert_eq!(life.last_patrol_at, now);
    }

    #[test]
    fn study_time_and_rewards_survive_across_ticks() {
        let now = local_time(2026, 8, 12, 10, 0);
        let mut life = StoredPetLife::new(now);
        life.settings.study_goal_minutes = 30;
        life.settings.knowledge_goal = 1;
        assert!(life.toggle_study(now, "manual"));
        assert!(!life.toggle_study(now + 35 * 60_000, "manual"));
        life.record_knowledge(
            now + 36 * 60_000,
            PetKnowledgeInput {
                title: "A useful fact",
                summary: "A source-backed fact learned during the session.",
                source: "Conversation",
                source_kind: "conversation",
                source_ref: Some("thread:1"),
                tags: Vec::new(),
                confidence: 0.8,
            },
        )
        .unwrap();
        life.tick(now + 37 * 60_000, "Yui", &[]);
        let kinds = life
            .rewards
            .iter()
            .map(|reward| reward.kind.as_str())
            .collect::<Vec<_>>();
        assert!(kinds.contains(&"focus"));
        assert!(kinds.contains(&"knowledge"));
        assert!(kinds.contains(&"together"));
    }

    #[test]
    fn reviewed_memories_become_deduplicated_knowledge() {
        let now = local_time(2026, 8, 12, 10, 0);
        let memory = PetMemory {
            id: "memory-1".to_owned(),
            text: "用户喜欢安静的工作环境".to_owned(),
            kind: "preference".to_owned(),
            confidence: 0.9,
            evidence_count: 2,
            created_at: now,
            updated_at: now,
        };
        let mut life = StoredPetLife::new(now);
        life.tick(now + 1_000, "Yui", std::slice::from_ref(&memory));
        life.tick(now + 2_000, "Yui", &[memory]);
        assert_eq!(life.knowledge.len(), 1);
        assert_eq!(life.knowledge[0].source_kind, "memory");
    }

    #[test]
    fn waking_creates_one_dream_trace_from_existing_knowledge() {
        let night = local_time(2026, 8, 12, 23, 10);
        let morning = local_time(2026, 8, 13, 8, 10);
        let mut life = StoredPetLife::new(night);
        life.record_knowledge(
            night,
            PetKnowledgeInput {
                title: "Quiet animation",
                summary: "Stable anchors make an animation feel calm.",
                source: "Test",
                source_kind: "document",
                source_ref: None,
                tags: Vec::new(),
                confidence: 0.9,
            },
        )
        .unwrap();
        life.tick(night + 1_000, "Yui", &[]);
        assert_eq!(life.behavior.state, "sleeping");
        life.tick(morning, "Yui", &[]);
        assert_eq!(life.behavior.reason, "dream-fragment");
        assert_eq!(
            life.activity_log
                .iter()
                .filter(|entry| entry.kind == "dream")
                .count(),
            1
        );
        life.tick(morning + 60_000, "Yui", &[]);
        assert_eq!(
            life.activity_log
                .iter()
                .filter(|entry| entry.kind == "dream")
                .count(),
            1
        );
    }

    #[test]
    fn hourly_chatter_does_not_overwrite_a_dream_at_wake_time() {
        let night = local_time(2026, 8, 12, 23, 10);
        let morning = local_time(2026, 8, 13, 8, 0);
        let mut life = StoredPetLife::new(night);
        life.record_knowledge(
            night,
            PetKnowledgeInput {
                title: "Quiet animation",
                summary: "Stable anchors make an animation feel calm.",
                source: "Test",
                source_kind: "document",
                source_ref: None,
                tags: Vec::new(),
                confidence: 0.9,
            },
        )
        .unwrap();
        life.tick(night + 1_000, "Yui", &[]);
        life.tick(morning, "Yui", &[]);

        assert_eq!(life.behavior.reason, "dream-fragment");
        assert!(!life.days["2026-08-13"].chatter_slots.contains_key("08:00"));
    }

    #[test]
    fn self_discovery_is_written_once_per_day_as_tentative_knowledge() {
        let now = local_time(2026, 8, 12, 10, 0);
        let mut life = StoredPetLife::new(now);
        for (title, summary) in [
            ("Animation anchors", "Stable feet reduce visible jitter."),
            ("Energy rhythm", "Rest restores energy after movement."),
        ] {
            life.record_knowledge(
                now,
                PetKnowledgeInput {
                    title,
                    summary,
                    source: "Test",
                    source_kind: "document",
                    source_ref: None,
                    tags: Vec::new(),
                    confidence: 0.9,
                },
            )
            .unwrap();
        }
        life.behavior.next_decision_at = now;
        life.tick(local_time(2026, 8, 12, 13, 7), "Yui", &[]);
        assert_eq!(life.behavior.reason, "self-discovery");
        assert_eq!(
            life.knowledge
                .iter()
                .filter(|item| item.source_kind == "discovery")
                .count(),
            1
        );
        life.behavior.next_decision_at = local_time(2026, 8, 12, 14, 0);
        life.tick(local_time(2026, 8, 12, 14, 7), "Yui", &[]);
        assert_eq!(
            life.knowledge
                .iter()
                .filter(|item| item.source_kind == "discovery")
                .count(),
            1
        );
    }

    #[test]
    fn repeated_touch_warms_needs_without_spamming_the_journal() {
        let now = local_time(2026, 8, 12, 14, 0);
        let mut life = StoredPetLife::new(now);
        assert!(life.bond_with_user(now));
        assert!(!life.bond_with_user(now + 1_000));
        assert_eq!(
            life.activity_log
                .iter()
                .filter(|entry| entry.kind == "bond")
                .count(),
            1
        );
        assert_eq!(life.behavior.reason, "bonded");
        assert!(life.needs.social > PetNeeds::default().social);
    }

    #[test]
    fn check_ins_only_accept_the_xiaolu_five_minute_window() {
        let now = local_time(2026, 8, 12, 8, 56);
        let mut life = StoredPetLife::new(now);
        assert_eq!(life.check_in(now).unwrap(), "09:00");
        assert!(life.check_in(now).is_err());
        assert!(life.check_in(local_time(2026, 8, 12, 9, 20)).is_err());
    }

    #[test]
    fn check_in_prompt_can_be_answered_from_the_overlay() {
        let now = local_time(2026, 8, 12, 8, 56);
        let mut life = StoredPetLife::new(now);
        life.tick(now, "Yui", &[]);
        let prompt = life.current_prompt(now).unwrap();
        assert_eq!(prompt.kind, "check-in");
        assert_eq!(prompt.actions, vec!["check-in"]);
        life.respond_to_prompt(now, &prompt.id, "check-in").unwrap();
        assert!(life.current_prompt(now).is_none());
    }

    #[test]
    fn recurring_tasks_create_one_due_occurrence_per_day() {
        let friday = local_time(2026, 8, 14, 8, 0);
        let saturday = local_time(2026, 8, 15, 8, 0);
        let monday = local_time(2026, 8, 17, 8, 0);
        let mut life = StoredPetLife::new(friday);
        let daily = life
            .add_task(friday, "Daily review", "", None, Some("daily"), 2)
            .unwrap();
        let weekdays = life
            .add_task(friday, "Weekday focus", "", None, Some("weekdays"), 3)
            .unwrap();

        life.tick(saturday, "Yui", &[]);
        assert!(life.tasks.iter().any(|task| {
            task.series_id == daily.series_id
                && task.occurrence_date.as_deref() == Some("2026-08-15")
        }));
        assert!(!life.tasks.iter().any(|task| {
            task.series_id == weekdays.series_id
                && task.occurrence_date.as_deref() == Some("2026-08-15")
        }));

        life.tick(monday, "Yui", &[]);
        life.tick(monday + 1_000, "Yui", &[]);
        assert_eq!(
            life.tasks
                .iter()
                .filter(|task| {
                    task.series_id == weekdays.series_id
                        && task.occurrence_date.as_deref() == Some("2026-08-17")
                })
                .count(),
            1
        );
    }

    #[test]
    fn study_prompt_snoozes_once_skips_and_escalates_by_elapsed_time() {
        let start = local_time(2026, 8, 12, 9, 0);
        let mut life = StoredPetLife::new(start);
        let first_due = start + STUDY_LAUNCH_GRACE_MS;
        life.tick(first_due, "Yui", &[]);
        let first = life.current_prompt(first_due).unwrap();
        assert_eq!(first.tier.as_deref(), Some("playful"));
        assert!(first.actions.iter().any(|action| action == "snooze"));

        life.respond_to_prompt(first_due, &first.id, "snooze")
            .unwrap();
        assert!(life.current_prompt(first_due + 9 * 60_000).is_none());
        let snoozed_due = first_due + STUDY_LAUNCH_SNOOZE_MS;
        life.tick(snoozed_due, "Yui", &[]);
        let second = life.current_prompt(snoozed_due).unwrap();
        assert!(!second.actions.iter().any(|action| action == "snooze"));

        life.tick(snoozed_due + 31 * 60_000, "Yui", &[]);
        let final_prompt = life.current_prompt(snoozed_due + 31 * 60_000).unwrap();
        assert_eq!(final_prompt.tier.as_deref(), Some("final"));
        life.respond_to_prompt(snoozed_due + 31 * 60_000, &final_prompt.id, "skip")
            .unwrap();
        assert!(life.current_prompt(snoozed_due + 31 * 60_000).is_none());
    }

    #[test]
    fn starting_study_completes_the_current_launch_period() {
        let start = local_time(2026, 8, 12, 15, 0);
        let due = start + STUDY_LAUNCH_GRACE_MS;
        let mut life = StoredPetLife::new(start);
        life.tick(due, "Yui", &[]);
        let prompt = life.current_prompt(due).unwrap();
        life.respond_to_prompt(due, &prompt.id, "start").unwrap();
        assert!(life.current_prompt(due).is_none());
        let launch = &life.days["2026-08-12"].study_launches["afternoon"];
        assert_eq!(launch.completed_at, Some(due));
        assert!(
            life.study_sessions
                .iter()
                .any(|session| session.ended_at.is_none())
        );
    }

    #[test]
    fn evening_launch_stays_gentle_and_does_not_become_strong_patrol() {
        let start = local_time(2026, 8, 12, 18, 0);
        let late = start + 50 * 60_000;
        let mut life = StoredPetLife::new(start);
        life.tick(late, "Yui", &[]);
        let prompt = life.current_prompt(late).unwrap();
        assert_eq!(prompt.tier.as_deref(), Some("playful"));
        assert_eq!(life.behavior.reason, "study-launch-reminder");
    }

    #[test]
    fn recurring_task_due_date_defers_the_first_occurrence() {
        let monday = local_time(2026, 8, 10, 8, 0);
        let mut life = StoredPetLife::new(monday);
        let task = life
            .add_task(
                monday,
                "Friday review",
                "",
                Some("2026-08-14"),
                Some("weekly"),
                2,
            )
            .unwrap();
        assert_eq!(task.occurrence_date.as_deref(), Some("2026-08-14"));
        life.tick(local_time(2026, 8, 11, 8, 0), "Yui", &[]);
        assert_eq!(
            life.tasks
                .iter()
                .filter(|item| item.series_id == task.series_id)
                .count(),
            1
        );
        life.tick(local_time(2026, 8, 21, 8, 0), "Yui", &[]);
        assert!(life.tasks.iter().any(|item| {
            item.series_id == task.series_id
                && item.occurrence_date.as_deref() == Some("2026-08-21")
        }));
    }
}
