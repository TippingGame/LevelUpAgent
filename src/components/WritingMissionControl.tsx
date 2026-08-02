import {
  Bot,
  Check,
  CircleAlert,
  CircleCheck,
  FileSearch,
  FileText,
  LibraryBig,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  SkipForward,
  Sparkles,
  Target,
  Trash2,
  Upload,
} from "lucide-react";
import { tr } from "../lib/i18n";
import {
  goalDeliverableLabel,
  goalStepKindLabel,
  referenceKindLabel,
  type WritingGoal,
  type WritingGoalDeliverable,
  type WritingGoalStep,
  type WritingProject,
  type WritingReference,
  type WritingReferenceKind,
} from "../lib/writing";

const REFERENCE_KINDS: WritingReferenceKind[] = ["source", "research", "style", "inspiration"];
const GOAL_DELIVERABLES: WritingGoalDeliverable[] = ["draft", "outline", "revision", "continuity", "worldbuilding"];

export interface GoalRunView {
  goalId: string;
  stepId?: string;
  phase: "planning" | "executing";
  message: string;
  preview: string;
  automatic: boolean;
}

export function GoalNavigator({ goals, selectedId, onSelect, onAdd }: {
  goals: WritingGoal[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return <div className="writing-nav-content goal-nav">
    <div className="writing-nav-heading"><span><Target size={14} />{tr("创作目标", "Writing goals")}<small>{goals.length}</small></span><button type="button" onClick={onAdd} title={tr("新建目标", "New goal")}><Plus size={13} /></button></div>
    <div className="goal-nav-list">
      {goals.map((goal) => {
        const completed = goal.plan.filter((step) => step.status === "completed" || step.status === "skipped").length;
        return <button type="button" className={goal.id === selectedId ? "active" : ""} onClick={() => onSelect(goal.id)} key={goal.id}>
          <GoalStatusIcon goal={goal} />
          <span><strong>{goal.title}</strong><small>{goalDeliverableLabel(goal.deliverable)} · {completed}/{goal.plan.length || "—"}</small></span>
        </button>;
      })}
      {goals.length === 0 && <p>{tr("给 AI 一个交付目标，它会先规划，再逐步执行。", "Give AI a deliverable; it will plan first, then execute step by step.")}</p>}
    </div>
    <button type="button" className="goal-nav-create" onClick={onAdd}><Plus size={14} />{tr("新建创作目标", "New writing goal")}</button>
  </div>;
}

export function ReferenceNavigator({ references, selectedId, onSelect, onAdd, onImport }: {
  references: WritingReference[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onImport: () => void;
}) {
  return <div className="writing-nav-content reference-nav">
    <div className="writing-nav-heading"><span><LibraryBig size={14} />{tr("参考资料", "References")}<small>{references.length}</small></span><button type="button" onClick={onAdd} title={tr("新建参考资料", "New reference")}><Plus size={13} /></button></div>
    <div className="reference-nav-list">
      {references.map((reference) => <button type="button" className={reference.id === selectedId ? "active" : ""} onClick={() => onSelect(reference.id)} key={reference.id}>
        <FileSearch size={14} />
        <span><strong>{reference.title}</strong><small>{referenceKindLabel(reference.kind)} · {reference.enabled ? tr("参与召回", "Active") : tr("已停用", "Disabled")}</small></span>
      </button>)}
      {references.length === 0 && <p>{tr("导入资料、风格样本或研究笔记，作为 AI 的长期事实源。", "Import sources, style samples, or research notes as durable AI context.")}</p>}
    </div>
    <div className="reference-nav-actions"><button type="button" onClick={onAdd}><Plus size={13} />{tr("新建", "New")}</button><button type="button" onClick={onImport}><Upload size={13} />{tr("导入文件", "Import files")}</button></div>
  </div>;
}

export function ReferenceWorkspace({ reference, onChange, onDelete, onAdd, onImport }: {
  reference?: WritingReference;
  onChange: (patch: Partial<WritingReference>) => void;
  onDelete: () => void;
  onAdd: () => void;
  onImport: () => void;
}) {
  if (!reference) return <div className="reference-empty">
    <LibraryBig size={34} />
    <h2>{tr("建立创作资料库", "Build a creative reference library")}</h2>
    <p>{tr("资料会与设定集一起进入智能上下文。可随时停用单项，避免污染当前创作。", "References join the Codex in smart context. Disable any item whenever it should not influence the current work.")}</p>
    <div><button type="button" onClick={onAdd}><Plus size={14} />{tr("新建资料", "New reference")}</button><button type="button" onClick={onImport}><Upload size={14} />{tr("导入文本文件", "Import text files")}</button></div>
  </div>;
  return <div className="reference-workspace">
    <header>
      <div><LibraryBig size={17} /><span><strong>{tr("参考资料", "Reference")}</strong><small>{reference.content.length.toLocaleString()} {tr("字符", "characters")}</small></span></div>
      <div><label className="reference-enabled"><span>{tr("参与 AI 召回", "Use in AI context")}</span><input type="checkbox" checked={reference.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} /></label><button type="button" onClick={onDelete} title={tr("删除资料", "Delete reference")}><Trash2 size={14} /></button></div>
    </header>
    <div className="reference-form">
      <div className="reference-form-grid">
        <label><span>{tr("标题", "Title")}</span><input value={reference.title} maxLength={200} onChange={(event) => onChange({ title: event.target.value })} /></label>
        <label><span>{tr("类型", "Type")}</span><select value={reference.kind} onChange={(event) => onChange({ kind: event.target.value as WritingReferenceKind })}>{REFERENCE_KINDS.map((kind) => <option value={kind} key={kind}>{referenceKindLabel(kind)}</option>)}</select></label>
        <label className="wide"><span>{tr("来源网址（可选）", "Source URL (optional)")}</span><input type="url" value={reference.sourceUrl} maxLength={2_000} onChange={(event) => onChange({ sourceUrl: event.target.value })} placeholder="https://" /></label>
        <label className="wide"><span>{tr("标签", "Tags")}</span><input value={reference.tags.join("，")} onChange={(event) => onChange({ tags: splitList(event.target.value) })} placeholder={tr("历史，服装，第一幕…", "history, clothing, act one…")} /></label>
      </div>
      <label><span>{tr("使用说明 / 摘要", "Usage notes / summary")}</span><textarea className="reference-notes" value={reference.notes} maxLength={20_000} onChange={(event) => onChange({ notes: event.target.value })} placeholder={tr("告诉 AI 哪些内容是事实、哪些只是语气参考，以及不能直接照抄的部分。", "Tell AI what is factual, what is style-only, and what must not be copied verbatim.")} /></label>
      <label className="reference-content-label"><span>{tr("资料正文", "Reference content")}</span><textarea className="reference-content" value={reference.content} maxLength={500_000} onChange={(event) => onChange({ content: event.target.value })} placeholder={tr("粘贴研究材料、访谈、术语表、风格样本或其他上下文…", "Paste research, interviews, glossaries, style samples, or other context…")} /></label>
    </div>
  </div>;
}

export function WritingGoalWorkspace({
  project,
  goal,
  run,
  connectionReady,
  onChange,
  onDelete,
  onAdd,
  onPlan,
  onRunNext,
  onRunAll,
  onStop,
  onApplyStep,
  onRetryStep,
  onSkipStep,
  onResetPlan,
}: {
  project: WritingProject;
  goal?: WritingGoal;
  run?: GoalRunView;
  connectionReady: boolean;
  onChange: (patch: Partial<WritingGoal>) => void;
  onDelete: () => void;
  onAdd: () => void;
  onPlan: () => void;
  onRunNext: () => void;
  onRunAll: () => void;
  onStop: () => void;
  onApplyStep: (stepId: string) => void;
  onRetryStep: (stepId: string) => void;
  onSkipStep: (stepId: string) => void;
  onResetPlan: () => void;
}) {
  if (!goal) return <div className="goal-empty">
    <Target size={38} />
    <h2>{tr("让 AI 对交付结果负责", "Give AI ownership of a deliverable")}</h2>
    <p>{tr("目标模式会把意图变成计划，连续执行研究、规划、起草、修订和验收；每次改稿前都自动留快照。", "Goal mode turns intent into a plan and executes research, outlining, drafting, revision, and QA—with a snapshot before every manuscript change.")}</p>
    <button type="button" onClick={onAdd}><Plus size={14} />{tr("创建第一个目标", "Create first goal")}</button>
  </div>;
  const running = run?.goalId === goal.id;
  const awaitingReview = goal.plan.some((step) => step.status === "review");
  const completedCount = goal.plan.filter((step) => step.status === "completed" || step.status === "skipped").length;
  const progress = goal.plan.length > 0 ? completedCount / goal.plan.length * 100 : 0;
  return <div className="goal-workspace">
    <header className="goal-hero">
      <div className="goal-hero-title"><Target size={19} /><span><input value={goal.title} maxLength={200} onChange={(event) => onChange({ title: event.target.value })} aria-label={tr("目标名称", "Goal name")} /><small>{tr("写作目标模式", "Writing goal mode")} · {goalDeliverableLabel(goal.deliverable)}</small></span></div>
      <div className="goal-hero-actions">
        {running ? <button type="button" className="danger" onClick={onStop}><Pause size={14} />{tr("暂停", "Pause")}</button> : <>
          <button type="button" onClick={onPlan} disabled={!connectionReady || !goal.brief.trim()}><Sparkles size={14} />{goal.plan.length > 0 ? tr("重新规划", "Replan") : tr("AI 规划", "AI plan")}</button>
          <button type="button" onClick={onRunNext} disabled={!connectionReady || !goal.brief.trim() || awaitingReview} title={awaitingReview ? tr("请先审阅当前产物", "Review the current output first") : undefined}><Play size={14} />{awaitingReview ? tr("等待审阅", "Awaiting review") : tr("运行下一步", "Run next")}</button>
          <button type="button" className="primary" onClick={onRunAll} disabled={!connectionReady || !goal.brief.trim()}><Rocket size={14} />{tr("AI 全权推进", "Run autonomously")}</button>
        </>}
        <button type="button" onClick={onDelete} disabled={running} title={tr("删除目标", "Delete goal")}><Trash2 size={14} /></button>
      </div>
    </header>

    <div className="goal-body">
      <section className="goal-brief-card">
        <div className="goal-card-heading"><span><FileText size={15} />{tr("目标契约", "Goal contract")}</span><small>{tr("AI 会把这里当作最终验收依据", "AI treats this as the acceptance contract")}</small></div>
        <label className="goal-brief"><span>{tr("要完成什么", "What should be completed")}</span><textarea value={goal.brief} maxLength={40_000} onChange={(event) => onChange({ brief: event.target.value, status: goal.plan.length > 0 ? "ready" : "draft" })} placeholder={tr("例如：为第一章写出约 2500 字的可编辑草稿。建立主角的欲望和代价，在结尾让她主动进入禁区；不要解释世界观，用行动揭示。", "Example: Produce an editable 2,500-word first chapter. Establish the protagonist's desire and cost, and end with her choosing to enter the forbidden zone. Reveal the world through action, not exposition.")} /></label>
        <div className="goal-contract-grid">
          <label><span>{tr("交付物", "Deliverable")}</span><select value={goal.deliverable} onChange={(event) => onChange({ deliverable: event.target.value as WritingGoalDeliverable })}>{GOAL_DELIVERABLES.map((deliverable) => <option value={deliverable} key={deliverable}>{goalDeliverableLabel(deliverable)}</option>)}</select></label>
          <label><span>{tr("协作方式", "Collaboration")}</span><select value={goal.mode} onChange={(event) => onChange({ mode: event.target.value as WritingGoal["mode"] })}><option value="partner">{tr("合作者 · 每步审阅", "Partner · review each step")}</option><option value="director">{tr("AI 主笔 · 自动应用", "AI lead · auto-apply")}</option></select></label>
          <label><span>{tr("目标文稿", "Target manuscript")}</span><select value={goal.targetDocumentId ?? ""} onChange={(event) => onChange({ targetDocumentId: event.target.value || undefined })}>{project.documents.map((document) => <option value={document.id} key={document.id}>{document.title}</option>)}</select></label>
          <label><span>{tr("目标字数", "Target words")}</span><input type="number" min="0" max="500000" step="100" value={goal.targetWords} onChange={(event) => onChange({ targetWords: Math.max(0, Number(event.target.value) || 0) })} /></label>
          <label className="wide"><span>{tr("目标读者", "Audience")}</span><input value={goal.audience} maxLength={4_000} onChange={(event) => onChange({ audience: event.target.value })} placeholder={tr("类型读者、年龄层、发行平台或使用场景", "Genre readers, age group, platform, or use case")} /></label>
          <label className="wide"><span>{tr("边界与禁区", "Constraints and boundaries")}</span><textarea value={goal.constraints} maxLength={20_000} onChange={(event) => onChange({ constraints: event.target.value })} placeholder={tr("不能改变的事实、禁用套路、内容分级、必须保留的段落…", "Immutable facts, banned tropes, rating, passages that must remain…")} /></label>
          <label className="wide"><span>{tr("验收标准（每行一条）", "Acceptance criteria (one per line)")}</span><textarea value={goal.successCriteria.join("\n")} onChange={(event) => onChange({ successCriteria: splitLines(event.target.value) })} placeholder={tr("每个场景都改变局势\n主角的关键决定由可见动机支撑\n不重复解释已经呈现的信息", "Every scene changes the situation\nThe protagonist's key choice has visible motivation\nNo repeated explanation of shown information")} /></label>
        </div>
      </section>

      <section className="goal-plan-card">
        <div className="goal-card-heading"><span><Bot size={15} />{tr("执行计划", "Execution plan")}</span><div>{goal.plan.length > 0 && <><span>{completedCount}/{goal.plan.length}</span><button type="button" onClick={onResetPlan} disabled={running}><RefreshCw size={12} />{tr("清空", "Reset")}</button></>}</div></div>
        <div className="goal-progress"><i style={{ width: `${progress}%` }} /></div>
        {running && <div className="goal-live-run" aria-live="polite"><header><LoaderCircle className="spin" size={14} /><strong>{run.message}</strong></header>{run.preview && <pre>{run.preview.slice(-5_000)}</pre>}</div>}
        <div className="goal-step-list">
          {goal.plan.map((step, index) => <GoalStepRow
            step={step}
            index={index}
            active={goal.activeStepId === step.id || run?.stepId === step.id}
            running={running}
            onApply={() => onApplyStep(step.id)}
            onRetry={() => onRetryStep(step.id)}
            onSkip={() => onSkipStep(step.id)}
            key={step.id}
          />)}
          {goal.plan.length === 0 && <div className="goal-plan-empty"><Sparkles size={23} /><strong>{tr("还没有执行计划", "No execution plan yet")}</strong><p>{tr("填写目标后让 AI 规划；如果直接选择“AI 全权推进”，它会先规划再连续执行。", "Ask AI to plan after filling the goal, or choose autonomous run to plan and execute continuously.")}</p></div>}
        </div>
        {goal.runSummary && <div className="goal-run-summary"><CircleCheck size={14} /><span>{goal.runSummary}</span></div>}
      </section>
    </div>
  </div>;
}

function GoalStepRow({ step, index, active, running, onApply, onRetry, onSkip }: {
  step: WritingGoalStep;
  index: number;
  active: boolean;
  running: boolean;
  onApply: () => void;
  onRetry: () => void;
  onSkip: () => void;
}) {
  const icon = step.status === "completed" ? <Check size={13} />
    : step.status === "failed" ? <CircleAlert size={13} />
      : step.status === "running" ? <LoaderCircle className="spin" size={13} />
        : <span>{index + 1}</span>;
  return <article className={`goal-step ${step.status}${active ? " active" : ""}`}>
    <div className="goal-step-index">{icon}</div>
    <div className="goal-step-copy"><header><strong>{step.title}</strong><span>{goalStepKindLabel(step.kind)} · {operationLabel(step.operation)}</span></header><p>{step.instruction}</p>
      {step.error && <div className="goal-step-error"><CircleAlert size={12} />{step.error}</div>}
      {step.output && (step.status === "review" || step.kind === "audit" || step.kind === "research") && <details open={step.status === "review"}><summary>{tr("查看产物", "View output")}</summary><pre>{step.output}</pre></details>}
      {(step.status === "review" || step.status === "failed" || step.status === "pending") && !running && <footer>
        {step.status === "review" && <button type="button" className="apply" onClick={onApply}><Check size={12} />{step.operation === "note" ? tr("确认完成", "Mark complete") : tr("应用到文稿", "Apply to manuscript")}</button>}
        {step.status === "failed" && <button type="button" onClick={onRetry}><RefreshCw size={12} />{tr("重试", "Retry")}</button>}
        <button type="button" onClick={onSkip}><SkipForward size={12} />{tr("跳过", "Skip")}</button>
      </footer>}
    </div>
  </article>;
}

function GoalStatusIcon({ goal }: { goal: WritingGoal }) {
  if (goal.status === "completed") return <CircleCheck size={14} />;
  if (goal.status === "failed") return <CircleAlert size={14} />;
  if (goal.status === "running") return <LoaderCircle className="spin" size={14} />;
  if (goal.status === "paused") return <Pause size={14} />;
  return <Target size={14} />;
}

function operationLabel(operation: WritingGoalStep["operation"]) {
  return ({ note: tr("工作记录", "Work note"), new_document: tr("新建文档", "New document"), append: tr("追加正文", "Append"), replace: tr("替换全文", "Replace") } as const)[operation];
}

function splitList(value: string) {
  return [...new Set(value.split(/[，,;；\n]/).map((item) => item.trim()).filter(Boolean))];
}

function splitLines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].slice(0, 30);
}
