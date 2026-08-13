import { useEffect, useMemo, useRef, useState } from "react";
import {
  Award,
  BatteryMedium,
  Bookmark,
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  Coffee,
  Footprints,
  Heart,
  History,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Target,
  Trash2,
  Users,
} from "lucide-react";
import {
  addPetTask,
  checkInPet,
  completePetScheduleItem,
  deletePetKnowledge,
  deletePetTask,
  recordPetKnowledge,
  regeneratePetDailyPlan,
  setPetTaskCompleted,
  settlePetDay,
  togglePetStudy,
  updatePetLifeSettings,
} from "../lib/bridge";
import type { AppLocale } from "../lib/i18n";
import { petBehaviorLabel, petBehaviorMessage } from "../lib/petAutonomy";
import type { PetDashboard, PetLifeSettings, PetScheduleItem } from "../lib/types";
import { IconButton } from "./IconButton";

export type PetLifeView = "life" | "plan" | "knowledge";

interface PetLifeWorkspaceProps {
  view: PetLifeView;
  dashboard: PetDashboard;
  locale: AppLocale;
  onDashboard: (dashboard: PetDashboard) => void;
  onNotice: (message: string) => void;
}

export function PetLifeWorkspace({
  view,
  dashboard,
  locale,
  onDashboard,
  onNotice,
}: PetLifeWorkspaceProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskRecurrence, setTaskRecurrence] = useState<"" | "daily" | "weekdays" | "weekly">("");
  const [taskPriority, setTaskPriority] = useState(2);
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeSummary, setKnowledgeSummary] = useState("");
  const [knowledgeSource, setKnowledgeSource] = useState("");
  const [knowledgeTags, setKnowledgeTags] = useState("");
  const [reflection, setReflection] = useState(dashboard.life.today.reflection);
  const [settings, setSettings] = useState<PetLifeSettings>(dashboard.life.settings);
  const settingsBaselineRef = useRef(JSON.stringify(dashboard.life.settings));
  const settingsPetRef = useRef(dashboard.activePetId);
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;

  useEffect(() => {
    const incoming = JSON.stringify(dashboard.life.settings);
    const changedPet = settingsPetRef.current !== dashboard.activePetId;
    setSettings((current) => {
      const dirty = JSON.stringify(current) !== settingsBaselineRef.current;
      return changedPet || !dirty ? dashboard.life.settings : current;
    });
    settingsPetRef.current = dashboard.activePetId;
    settingsBaselineRef.current = incoming;
    setReflection(dashboard.life.today.reflection);
  }, [dashboard.activePetId, JSON.stringify(dashboard.life.settings), dashboard.life.today.date, dashboard.life.today.reflection]);

  const run = async (key: string, action: () => Promise<PetDashboard>, success?: string) => {
    setBusy(key);
    try {
      const next = await action();
      onDashboard(next);
      if (success) onNotice(success);
      return next;
    } catch (error) {
      onNotice(formatError(error));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const checkInAvailable = useMemo(() => {
    const now = new Date();
    const minute = now.getHours() * 60 + now.getMinutes();
    return [9 * 60, 12 * 60, 15 * 60, 18 * 60, 21 * 60].some((slot) => {
      const label = `${String(Math.floor(slot / 60)).padStart(2, "0")}:00`;
      return Math.abs(minute - slot) <= 5 && dashboard.life.today.checkIns[label]?.status !== "checked";
    });
  }, [dashboard.life.today.checkIns, dashboard.life.lastTickAt]);

  const submitTask = async () => {
    const title = taskTitle.trim();
    if (!title) return;
    const next = await run("add-task", () => addPetTask({
      petId: dashboard.activePetId,
      title,
      notes: taskNotes.trim(),
      dueDate: taskDueDate || undefined,
      recurrence: taskRecurrence || undefined,
      priority: taskPriority,
    }));
    if (next) {
      setTaskTitle("");
      setTaskNotes("");
      setTaskDueDate("");
      setTaskRecurrence("");
      setTaskPriority(2);
      setTaskDetailsOpen(false);
    }
  };

  const submitKnowledge = async () => {
    const title = knowledgeTitle.trim();
    const summary = knowledgeSummary.trim();
    if (!title || !summary) return;
    const source = knowledgeSource.trim() || text("手动整理", "Manual note");
    const next = await run("add-knowledge", () => recordPetKnowledge({
      petId: dashboard.activePetId,
      title,
      summary,
      source,
      sourceKind: looksLikeUrl(source) ? "web" : "document",
      sourceRef: looksLikeUrl(source) ? source : undefined,
      tags: knowledgeTags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      confidence: 0.9,
    }));
    if (next) {
      setKnowledgeTitle("");
      setKnowledgeSummary("");
      setKnowledgeSource("");
      setKnowledgeTags("");
    }
  };

  if (view === "life") {
    const life = dashboard.life;
    const settingsChanged = JSON.stringify(settings) !== JSON.stringify(life.settings);
    const needs = [
      { key: "energy", label: text("能量", "Energy"), value: life.needs.energy, icon: <BatteryMedium size={13} /> },
      { key: "focus", label: text("专注", "Focus"), value: life.needs.focus, icon: <Brain size={13} /> },
      { key: "curiosity", label: text("好奇", "Curiosity"), value: life.needs.curiosity, icon: <Lightbulb size={13} /> },
      { key: "social", label: text("联结", "Bond"), value: life.needs.social, icon: <Users size={13} /> },
      { key: "mood", label: text("心情", "Mood"), value: life.needs.mood, icon: <Heart size={13} /> },
    ];
    return (
      <div className="pet-life-panel">
        <div className={`pet-life-current ${life.behavior.state}`}>
          <span>{behaviorIcon(life.behavior.state)}</span>
          <div><strong>{petBehaviorLabel(life.behavior.state, locale)}</strong><small>{petBehaviorMessage(life.behavior, locale)}</small></div>
        </div>
        <div className="pet-life-actions">
          <button className={life.activeSession ? "secondary-button" : "primary-button"} type="button" disabled={busy !== null} onClick={() => void run("study", () => togglePetStudy(dashboard.activePetId), life.activeSession ? text("本次共学已收好", "Study session saved") : text("开始共学", "Study started"))}>
            {busy === "study" ? <LoaderCircle className="spin" size={14} /> : life.activeSession ? <Coffee size={14} /> : <BookOpen size={14} />}
            {life.activeSession ? text("结束共学", "Finish study") : text("开始共学", "Study together")}
          </button>
          <button className="secondary-button" type="button" disabled={!checkInAvailable || busy !== null} onClick={() => void run("check-in", () => checkInPet(dashboard.activePetId), text("已签到，我看见你了", "Check-in recorded"))}>
            <CircleCheck size={14} />{text("签到", "Check in")}
          </button>
        </div>
        <p className="pet-study-note"><Sparkles size={12} /><span>{text("“开始共学”只记录我陪你学习的时间；自主求知会在后台独立向 Agent 提问，无需按下这个按钮。", "Study together only tracks time beside you. Independent learning asks the Agent in the background without this button.")}</span></p>
        <div className="pet-life-stats">
          <span><strong>{formatDuration(life.stats.todayStudyMs, locale)}</strong><small>{text("今日共学", "Today")}</small></span>
          <span><strong>{life.stats.knowledgeCount}</strong><small>{text("知识", "Knowledge")}</small></span>
          <span><strong>{life.stats.completedTasks}</strong><small>{text("已完成", "Completed")}</small></span>
          <span><strong>{life.stats.streakDays}</strong><small>{text("连续天数", "Day streak")}</small></span>
        </div>
        <section className="pet-life-section">
          <div className="pet-life-section-title"><Target size={14} /><strong>{text("今日目标", "Today's goals")}</strong></div>
          <div className="pet-goal-grid">
            <GoalProgress label={text("共学", "Study")} value={Math.floor(life.stats.todayStudyMs / 60_000)} target={life.settings.studyGoalMinutes} unit={text("分", "m")} />
            <GoalProgress label={text("求知", "Learn")} value={life.stats.todayKnowledgeCount} target={life.settings.knowledgeGoal} unit={text("条", "")} />
          </div>
          <div className="pet-bookmark-strip">
            {life.rewards.length === 0
              ? <span className="empty"><Bookmark size={13} />{text("今天的第一枚书签还在等你", "Your first bookmark is waiting")}</span>
              : life.rewards.slice(0, 6).map((reward) => <span className={reward.kind} title={`${reward.title} · ${reward.date}`} key={reward.id}><Bookmark size={12} /><b>{rewardLabel(reward.kind, locale)}</b></span>)}
          </div>
        </section>
        <section className="pet-life-section">
          <div className="pet-life-section-title"><Heart size={14} /><strong>{text("此刻状态", "Needs")}</strong></div>
          <div className="pet-needs-list">
            {needs.map((need) => (
              <div key={need.key}><span>{need.icon}{need.label}</span><i><b style={{ width: `${Math.round(need.value)}%` }} /></i><output>{Math.round(need.value)}</output></div>
            ))}
          </div>
        </section>
        <section className="pet-life-section">
          <div className="pet-life-section-title"><Sparkles size={14} /><strong>{text("心迹", "Inner traces")}</strong><small>{life.activityLog.length}</small></div>
          <div className="pet-inner-traces">
            {life.activityLog.filter((entry) => ["dream", "discovery", "place", "bond", "knowledge"].includes(entry.kind)).slice(0, 6).map((entry) => (
              <article key={entry.id}>
                <time>{formatActivityTime(entry.createdAt, locale)}</time>
                <p>{localizedActivity(entry.message, locale)}</p>
              </article>
            ))}
            {!life.activityLog.some((entry) => ["dream", "discovery", "place", "bond", "knowledge"].includes(entry.kind)) && <p className="pet-compact-empty">{text("他正在慢慢形成自己的心迹", "Inner traces will appear as life unfolds")}</p>}
          </div>
        </section>
        <section className="pet-life-section pet-settings-section">
          <div className="pet-life-section-title"><Sparkles size={14} /><strong>{text("自主节律", "Autonomy")}</strong></div>
          <div className="pet-toggle-grid">
            <Toggle label={text("自主活动", "Autonomy")} checked={settings.autonomyEnabled} onChange={(value) => setSettings({ ...settings, autonomyEnabled: value })} />
            <Toggle label={text("自主求知", "Independent learning")} checked={settings.learningEnabled} onChange={(value) => setSettings({ ...settings, learningEnabled: value })} />
            <Toggle label={text("桌面走动", "Movement")} checked={settings.movementEnabled} onChange={(value) => setSettings({ ...settings, movementEnabled: value })} />
            <Toggle label={text("每日计划", "Daily plan")} checked={settings.dailyPlanEnabled} onChange={(value) => setSettings({ ...settings, dailyPlanEnabled: value })} />
            <Toggle label={text("定时提醒", "Reminders")} checked={settings.remindersEnabled} onChange={(value) => setSettings({ ...settings, remindersEnabled: value })} />
            <Toggle label={text("开机陪伴", "Launch at login")} checked={settings.launchAtLogin} onChange={(value) => setSettings({ ...settings, launchAtLogin: value })} />
          </div>
          <label className="pet-setting-row"><span>{text("共学目标", "Study goal")}</span><input type="number" min={15} max={960} step={15} value={settings.studyGoalMinutes} onChange={(event) => setSettings({ ...settings, studyGoalMinutes: Number(event.target.value) })} /><small>{text("分钟", "min")}</small></label>
          <label className="pet-setting-row"><span>{text("求知目标", "Knowledge goal")}</span><input type="number" min={1} max={50} value={settings.knowledgeGoal} onChange={(event) => setSettings({ ...settings, knowledgeGoal: Number(event.target.value) })} /><small>{text("条", "items")}</small></label>
          <label className="pet-setting-slider"><span><Footprints size={13} />{text("走动速度", "Walking speed")}</span><input type="range" min={50} max={200} step={10} value={Math.round(settings.patrolSpeed * 100)} onChange={(event) => setSettings({ ...settings, patrolSpeed: Number(event.target.value) / 100 })} /><output>{Math.round(settings.patrolSpeed * 100)}%</output></label>
          <div className="pet-quiet-hours">
            <Moon size={13} /><span>{text("安静时段", "Quiet hours")}</span>
            <select value={settings.quietStartMinute} onChange={(event) => setSettings({ ...settings, quietStartMinute: Number(event.target.value) })}>{[21, 22, 23, 0].map((hour) => <option value={hour * 60} key={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select>
            <b>–</b>
            <select value={settings.quietEndMinute} onChange={(event) => setSettings({ ...settings, quietEndMinute: Number(event.target.value) })}>{[6, 7, 8, 9].map((hour) => <option value={hour * 60} key={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select>
          </div>
          <button className="primary-button pet-settings-save" type="button" disabled={!settingsChanged || busy !== null} onClick={() => void run("settings", () => updatePetLifeSettings(dashboard.activePetId, settings), text("自主节律已保存", "Autonomy settings saved"))}>
            {busy === "settings" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{text("保存节律", "Save")}
          </button>
        </section>
      </div>
    );
  }

  if (view === "plan") {
    const life = dashboard.life;
    const tasks = [...life.tasks].sort((left, right) => Number(left.status === "completed") - Number(right.status === "completed") || right.priority - left.priority);
    return (
      <div className="pet-plan-panel">
        <div className="pet-panel-toolbar">
          <div><CalendarDays size={16} /><span><strong>{formatDate(life.today.date, locale)}</strong><small>{life.today.schedule.filter((item) => item.status === "completed").length} / {life.today.schedule.length}</small></span></div>
          <IconButton label={text("重新生成今日计划", "Regenerate today's plan")} onClick={() => void run("regenerate", () => regeneratePetDailyPlan(dashboard.activePetId), text("今日计划已重新整理", "Today's plan was regenerated"))} disabled={busy !== null}><RefreshCw className={busy === "regenerate" ? "spin" : ""} size={14} /></IconButton>
        </div>
        <section className="pet-life-section">
          <div className="pet-life-section-title"><Clock3 size={14} /><strong>{text("今日日程", "Today's schedule")}</strong></div>
          <div className="pet-schedule-list">
            {life.today.schedule.map((item) => (
              <ScheduleRow
                item={item}
                locale={locale}
                busy={busy === `schedule:${item.id}`}
                onToggle={() => void run(`schedule:${item.id}`, () => completePetScheduleItem(dashboard.activePetId, item.id, item.status !== "completed"))}
                key={item.id}
              />
            ))}
          </div>
        </section>
        <section className="pet-life-section">
          <div className="pet-life-section-title"><ListTodo size={14} /><strong>{text("任务", "Tasks")}</strong><small>{tasks.filter((task) => task.status !== "completed").length}</small></div>
          <form className={`pet-task-form${taskDetailsOpen ? " expanded" : ""}`} onSubmit={(event) => { event.preventDefault(); void submitTask(); }}>
            <div className="pet-inline-form">
              <input value={taskTitle} maxLength={60} placeholder={text("写下一件要完成的事", "Add a task")} onChange={(event) => setTaskTitle(event.target.value)} />
              <button type="button" className="pet-task-details-toggle" aria-label={text("任务详情", "Task details")} aria-expanded={taskDetailsOpen} onClick={() => setTaskDetailsOpen((current) => !current)}><CalendarDays size={13} /></button>
              <button type="submit" aria-label={text("添加任务", "Add task")} disabled={!taskTitle.trim() || busy !== null}>{busy === "add-task" ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}</button>
            </div>
            {taskDetailsOpen && (
              <div className="pet-task-fields">
                <label><span>{text("截止", "Due")}</span><input type="date" value={taskDueDate} onChange={(event) => setTaskDueDate(event.target.value)} /></label>
                <label><span>{text("重复", "Repeat")}</span><select value={taskRecurrence} onChange={(event) => setTaskRecurrence(event.target.value as typeof taskRecurrence)}><option value="">{text("不重复", "None")}</option><option value="daily">{text("每天", "Daily")}</option><option value="weekdays">{text("工作日", "Weekdays")}</option><option value="weekly">{text("每周", "Weekly")}</option></select></label>
                <label><span>{text("优先级", "Priority")}</span><select value={taskPriority} onChange={(event) => setTaskPriority(Number(event.target.value))}><option value={1}>{text("低", "Low")}</option><option value={2}>{text("中", "Medium")}</option><option value={3}>{text("高", "High")}</option></select></label>
                <label className="pet-task-notes"><span>{text("备注", "Notes")}</span><input value={taskNotes} maxLength={500} placeholder={text("可选", "Optional")} onChange={(event) => setTaskNotes(event.target.value)} /></label>
              </div>
            )}
          </form>
          <div className="pet-task-list">
            {tasks.length === 0 ? <p className="pet-compact-empty">{text("今天没有待办", "No tasks yet")}</p> : tasks.map((task) => (
              <article className={task.status === "completed" ? "completed" : ""} key={task.id}>
                <button type="button" aria-label={task.status === "completed" ? text("恢复任务", "Reopen task") : text("完成任务", "Complete task")} onClick={() => void run(`task:${task.id}`, () => setPetTaskCompleted(dashboard.activePetId, task.id, task.status !== "completed"))}>{busy === `task:${task.id}` ? <LoaderCircle className="spin" size={13} /> : task.status === "completed" ? <CircleCheck size={14} /> : <span />}</button>
                <div><strong>{task.title}</strong><small>{taskMeta(task, locale)}</small></div>
                <IconButton label={text("删除任务", "Delete task")} onClick={() => void run(`delete-task:${task.id}`, () => deletePetTask(dashboard.activePetId, task.id))} disabled={busy !== null}><Trash2 size={12} /></IconButton>
              </article>
            ))}
          </div>
        </section>
        <section className="pet-life-section">
          <div className="pet-life-section-title"><CircleCheck size={14} /><strong>{text("今日签到", "Check-ins")}</strong></div>
          <div className="pet-checkin-strip">{["09:00", "12:00", "15:00", "18:00", "21:00"].map((slot) => <span className={life.today.checkIns[slot]?.status ?? "pending"} title={slot} key={slot}><b>{slot.slice(0, 2)}</b>{life.today.checkIns[slot]?.status === "checked" ? <Check size={11} /> : life.today.checkIns[slot]?.status === "missed" ? <i /> : <small>·</small>}</span>)}</div>
        </section>
        <section className="pet-life-section">
          <div className="pet-life-section-title"><Coffee size={14} /><strong>{text("今日一句", "Daily reflection")}</strong></div>
          <textarea className="pet-reflection-input" value={reflection} maxLength={240} placeholder={text("把今天留给明天的自己", "A sentence for tomorrow")} onChange={(event) => setReflection(event.target.value)} />
          <button className="secondary-button pet-reflection-save" type="button" disabled={busy !== null || reflection === life.today.reflection} onClick={() => void run("reflection", () => settlePetDay(dashboard.activePetId, reflection), text("今天已收好", "Today was settled"))}><Save size={13} />{text("保存今日", "Save day")}</button>
        </section>
        <section className="pet-life-section">
          <div className="pet-life-section-title"><History size={14} /><strong>{text("成长记录", "History")}</strong><small>{life.history.length}</small></div>
          <div className="pet-history-list">
            {life.history.slice(0, 14).map((day) => (
              <article key={day.date}>
                <time>{formatShortDate(day.date, locale)}</time>
                <div><strong>{formatDuration(day.studyMs, locale)}</strong><small>{day.knowledgeCount} {text("条知识", "knowledge")} · {day.completedTasks} {text("任务", "tasks")}</small></div>
                <span title={text("书签", "Bookmarks")}><Award size={12} />{day.rewardCount}</span>
                {day.reflection && <p>{day.reflection}</p>}
              </article>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="pet-knowledge-panel">
      <div className="pet-panel-toolbar">
        <div><Lightbulb size={16} /><span><strong>{text("知识库", "Knowledge")}</strong><small>{dashboard.life.stats.knowledgeCount} {text("条", "items")}</small></span></div>
      </div>
      <section className="pet-learning-quests">
        <div className="pet-life-section-title"><Brain size={14} /><strong>{text("自主求知", "Questions asked independently")}</strong><small>{dashboard.life.learningQuests.length}</small></div>
        <div className="pet-learning-quest-list">
          {dashboard.life.learningQuests.slice(0, 8).map((quest) => (
            <article className={quest.status} key={quest.id}>
              <span>{["formulating", "asking"].includes(quest.status) ? <LoaderCircle className="spin" size={13} /> : quest.status === "completed" ? <CircleCheck size={13} /> : ["failed", "formation-failed"].includes(quest.status) ? <CircleAlert size={13} /> : <Clock3 size={13} />}</span>
              <div>
                <strong>{quest.question || learningQuestPlaceholder(quest.status, locale)}</strong>
                <small>{learningQuestMeta(quest, locale)}</small>
                {quest.rationale && <p>{text("缘起：", "Why: ")}{quest.rationale}</p>}
                {quest.answerTitle && <p>{text("学会：", "Learned: ")}{quest.answerTitle}</p>}
                {quest.error && !quest.answerTitle && <p>{quest.error}</p>}
              </div>
            </article>
          ))}
          {dashboard.life.learningQuests.length === 0 && <p className="pet-compact-empty">{text("他会观察主人最近的输入、今天的计划与行为，发现真实的知识缺口后再向 Agent 求解；没有值得问的，也不会硬问。", "The echo observes recent owner input, today's plans, and behavior, then asks Agent only when it finds a real knowledge gap.")}</p>}
        </div>
      </section>
      <section className="pet-knowledge-form">
        <input value={knowledgeTitle} maxLength={90} placeholder={text("知识标题", "Knowledge title")} onChange={(event) => setKnowledgeTitle(event.target.value)} />
        <textarea value={knowledgeSummary} maxLength={1_200} placeholder={text("结论或理解", "What was learned")} onChange={(event) => setKnowledgeSummary(event.target.value)} />
        <input value={knowledgeSource} maxLength={240} placeholder={text("来源或链接", "Source or URL")} onChange={(event) => setKnowledgeSource(event.target.value)} />
        <input value={knowledgeTags} maxLength={160} placeholder={text("标签，用逗号分隔", "Comma-separated tags")} onChange={(event) => setKnowledgeTags(event.target.value)} />
        <button className="primary-button" type="button" disabled={!knowledgeTitle.trim() || !knowledgeSummary.trim() || busy !== null} onClick={() => void submitKnowledge()}>{busy === "add-knowledge" ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{text("收入知识库", "Add knowledge")}</button>
      </section>
      <div className="pet-knowledge-list">
        {[...dashboard.life.knowledge].reverse().map((item) => (
          <article key={item.id}>
            <div><strong>{item.title}</strong><small title={item.source}>{item.sourceKind} · {item.source || text("未知来源", "Unknown source")} · {Math.round(item.confidence * 100)}% · {formatTime(item.updatedAt, locale)}</small></div>
            <p>{item.summary}</p>
            {item.tags.length > 0 && <footer>{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</footer>}
            <IconButton label={text("删除知识", "Delete knowledge")} onClick={() => void run(`delete-knowledge:${item.id}`, () => deletePetKnowledge(dashboard.activePetId, item.id))} disabled={busy !== null}><Trash2 size={12} /></IconButton>
          </article>
        ))}
        {dashboard.life.knowledge.length === 0 && <p className="pet-compact-empty"><Lightbulb size={22} />{text("第一条知识会来自他自己的求问，或你们真正有内容的对话", "The first entry will come from an independent question or a substantive conversation")}</p>}
      </div>
    </div>
  );
}

function learningQuestMeta(quest: PetDashboard["life"]["learningQuests"][number], locale: AppLocale) {
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const states: Record<string, string> = {
    "formation-pending": text("等待梳理观察", "Waiting to reflect"),
    formulating: text("正在形成问题", "Forming a question"),
    "formation-retrying": text("稍后重新思考", "Will reflect again"),
    "formation-failed": text("未能形成可靠问题", "No grounded question formed"),
    deferred: text("此刻不强行提问", "No question needed now"),
    pending: text("准备提问", "Ready to ask"),
    asking: text("正在询问 Agent", "Asking Agent"),
    retrying: text("等待重试", "Waiting to retry"),
    completed: text("已经学会", "Learned"),
    failed: text("未得到可靠答案", "No reliable answer"),
  };
  const details = [states[quest.status] ?? quest.status];
  if (quest.formationAttempts > 0) details.push(`${text("成问", "formation")} ${quest.formationAttempts}`);
  if (quest.attempts > 0) details.push(`${text("求解", "answer")} ${quest.attempts}`);
  if (quest.questionProviderId) details.push(`${text("成问 Agent", "question Agent")}: ${quest.questionProviderId}`);
  if (quest.providerId) details.push(`Agent: ${quest.providerId}`);
  if (quest.nextRetryAt) details.push(`${text("重试", "retry")} ${formatTime(quest.nextRetryAt, locale)}`);
  return details.join(" · ");
}

function learningQuestPlaceholder(status: string, locale: AppLocale) {
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const messages: Record<string, string> = {
    "formation-pending": text("正在从最近的经历里寻找值得理解的未知点", "Looking for a worthwhile gap in recent context"),
    formulating: text("正在从最近的经历里寻找值得理解的未知点", "Looking for a worthwhile gap in recent context"),
    "formation-retrying": text("保留观察，稍后重新思考", "Keeping these observations to reconsider later"),
    "formation-failed": text("这次未能形成可靠问题", "No grounded question could be formed this time"),
    deferred: text("这次没有需要强行提出的问题", "There was no question worth forcing this time"),
  };
  return messages[status] ?? text("问题内容暂不可用", "Question unavailable");
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <button className="pet-toggle" type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span>{label}</span><i /></button>;
}

function GoalProgress({ label, value, target, unit }: { label: string; value: number; target: number; unit: string }) {
  const percent = target > 0 ? Math.min(100, Math.max(0, value / target * 100)) : 0;
  return <article className={percent >= 100 ? "complete" : ""}><span><b>{label}</b><small>{value}/{target}{unit}</small></span><i><b style={{ width: `${percent}%` }} /></i></article>;
}

function ScheduleRow({ item, locale, busy, onToggle }: { item: PetScheduleItem; locale: AppLocale; busy: boolean; onToggle: () => void }) {
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  return (
    <article className={`${item.status} ${item.kind}`}>
      <time>{minuteLabel(item.startMinute)}</time>
      <span>{scheduleIcon(item.kind)}</span>
      <div><strong>{item.title}</strong><small>{item.durationMinutes} {text("分钟", "min")} · {scheduleKindLabel(item.kind, locale)}</small></div>
      <button type="button" aria-label={item.status === "completed" ? text("恢复日程", "Reopen schedule item") : text("完成日程", "Complete schedule item")} onClick={onToggle}>{busy ? <LoaderCircle className="spin" size={12} /> : item.status === "completed" ? <CircleCheck size={14} /> : <span />}</button>
    </article>
  );
}

function scheduleIcon(kind: string) {
  if (kind === "focus") return <Brain size={13} />;
  if (kind === "learn") return <BookOpen size={13} />;
  if (kind === "wander") return <Footprints size={13} />;
  if (kind === "reflect") return <Coffee size={13} />;
  return <CalendarDays size={13} />;
}

function behaviorIcon(state: string) {
  if (state === "wandering") return <Footprints size={17} />;
  if (state === "studying" || state === "learning") return <BookOpen size={17} />;
  if (state === "planning") return <CalendarDays size={17} />;
  if (state === "resting") return <Coffee size={17} />;
  if (state === "sleeping") return <Moon size={17} />;
  return <Sparkles size={17} />;
}

function scheduleKindLabel(kind: string, locale: AppLocale) {
  const labels: Record<string, [string, string]> = {
    plan: ["整理", "Plan"], focus: ["专注", "Focus"], learn: ["学习", "Learn"], wander: ["活动", "Move"], reflect: ["结算", "Reflect"],
  };
  const label = labels[kind] ?? [kind, kind];
  return locale === "zh-CN" ? label[0] : label[1];
}

function minuteLabel(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function formatDuration(milliseconds: number, locale: AppLocale) {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return locale === "zh-CN" ? `${minutes} 分` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return locale === "zh-CN" ? `${hours}时${remainder}分` : `${hours}h ${remainder}m`;
}

function formatDate(date: string, locale: AppLocale) {
  const value = new Date(`${date}T00:00:00`);
  return Number.isFinite(value.getTime()) ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short" }).format(value) : date;
}

function formatShortDate(date: string, locale: AppLocale) {
  const value = new Date(`${date}T00:00:00`);
  return Number.isFinite(value.getTime()) ? new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(value) : date;
}

function rewardLabel(kind: string, locale: AppLocale) {
  const labels: Record<string, [string, string]> = {
    focus: ["专注", "Focus"], knowledge: ["求知", "Learn"], together: ["共鸣", "Together"],
  };
  const label = labels[kind] ?? [kind, kind];
  return locale === "zh-CN" ? label[0] : label[1];
}

function formatTime(timestamp: number, locale: AppLocale) {
  const value = new Date(timestamp);
  return Number.isFinite(value.getTime()) ? new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(value) : "";
}

function formatActivityTime(timestamp: number, locale: AppLocale) {
  const value = new Date(timestamp);
  return Number.isFinite(value.getTime())
    ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(value)
    : "";
}

function localizedActivity(message: string, locale: AppLocale) {
  const [zh, en] = message.split(" || ", 2);
  return locale === "zh-CN" ? zh : en ?? zh;
}

function taskMeta(task: PetDashboard["life"]["tasks"][number], locale: AppLocale) {
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const parts: string[] = [];
  if (task.dueDate) parts.push(task.dueDate);
  if (task.recurrence) {
    const label: Record<string, [string, string]> = {
      daily: ["每天", "daily"],
      weekdays: ["工作日", "weekdays"],
      weekly: ["每周", "weekly"],
    };
    const value = label[task.recurrence] ?? [task.recurrence, task.recurrence];
    parts.push(locale === "zh-CN" ? value[0] : value[1]);
  }
  parts.push(text(`优先级 ${task.priority}`, `Priority ${task.priority}`));
  return parts.join(" · ");
}

function looksLikeUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
