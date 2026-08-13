import type { PetBehavior } from "./types";
import type { PetSpriteState } from "./petAnimation";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export function localDateKey(date: Date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function petBehaviorSprite(behavior: PetBehavior): PetSpriteState {
  switch (behavior.state) {
    case "wandering":
      return behavior.direction === "left" ? "running-left" : "running-right";
    case "studying":
    case "learning":
      return "review";
    case "discovering":
      return "review";
    case "dreaming":
      return "idle";
    case "planning":
      return "running";
    case "waiting":
      return "waiting";
    case "celebrating":
      return "jumping";
    case "resting":
    case "sleeping":
    case "idle":
    default:
      return "idle";
  }
}

export function petBehaviorLabel(state: string, locale: string) {
  const labels: Record<string, [string, string]> = {
    idle: ["安静陪伴", "Nearby"],
    wandering: ["桌面散步", "Walking"],
    resting: ["恢复能量", "Resting"],
    sleeping: ["已经入睡", "Sleeping"],
    studying: ["与你共学", "Studying"],
    learning: ["自主学习", "Learning"],
    planning: ["整理计划", "Planning"],
    waiting: ["正在等你", "Waiting"],
    celebrating: ["一起庆祝", "Celebrating"],
    discovering: ["发现连接", "Making a connection"],
    dreaming: ["梦境碎片", "Dream fragment"],
  };
  const label = labels[state] ?? [state, state];
  return locale === "zh-CN" ? label[0] : label[1];
}

export function petBehaviorMessage(behavior: PetBehavior, locale: string) {
  if (locale !== "zh-CN") return behavior.message;
  const messages: Record<string, string> = {
    "settling-in": "我在这里，慢慢感受今天。",
    "quiet-hours": "夜深了。我就在附近安静休息。",
    "active-study-session": "我在和你一起学习，也会替你收好这段时间。",
    "scheduled-check-in": "到我们约好的签到时间了。让我知道你在这里。",
    "autonomy-paused": "我会安静待在这里，直到你愿意让我再次自己安排活动。",
    "low-energy": "我有一点累了。休息一会儿，我会更清醒地回来。",
    "daily-plan": "我正按今天的安排，认真做眼前这件事。",
    "autonomous-question-forming": "我正在回看主人最近说的话和今天发生的事，寻找一个真正值得理解的未知点。",
    "autonomous-question-formed": "我找到了一件自己确实还不理解的事，已经把它整理成问题。",
    "autonomous-no-question": "我认真想过了，但现在没有值得强行提出的问题。等新的事情发生，我会再留意。",
    "autonomous-question-retry": "这一次没能形成可靠的问题。我会保留观察，晚些时候再想。",
    "autonomous-question-failed": "连续几次都没有形成可靠问题，所以我停下了，没有为了显得活跃而硬问。",
    "autonomous-agent-question": "我刚刚想出了自己的问题，正在向 Agent 请教。答案可靠的话，我会把它收进自己的知识库。",
    "autonomous-learning-complete": "Agent 回答了我自己提出的问题。我已经检查结构，并把这份理解收进知识库。",
    "autonomous-learning-retry": "Agent 这次没有给出可靠答案。我保留了问题，稍后会自己再问一次。",
    "autonomous-learning-failed": "连续几次都没有得到可靠答案，所以我没有假装自己学会了。",
    curiosity: "以前学到的东西又在叫我了。我想回去看看它。",
    "low-focus": "思绪有些散，我先安静停一会儿。",
    "self-directed-patrol": "我想活动一下，在桌面上走一小段路。",
    available: "我就在附近，醒着，也留意着接下来发生的事。",
    "task-completed": "又有一个约定被认真完成了。我看见了。",
    "study-supervision-playful": "从很小的一步开始，好吗？打开第一件事，我陪你一起进入状态。",
    "study-supervision-firm": "我认真提醒你了。先选一件小事开始，我会一直陪着。",
    "study-supervision-angry": "我们已经让这一段等太久了。现在打开第一件事，把时间拿回来。",
    "study-supervision-final": "这是这一时段最后一次提醒。现在开始，或者明确告诉我这一段先放下。",
    "study-snoozed": "好，十分钟留给你。我会按约定再回来。",
    "study-skipped": "好，这一段先安静下来。下一段我再来见你。",
    "study-launch-reminder": "从很小的一步开始，好吗？打开第一件事，我陪你一起进入状态。",
    "task-reminder": "今天还有一些约定没有收好。要一起看一眼吗？",
    "hourly-chatter": behavior.message.replace(/^[^:]+:\s*/, ""),
    "night-stroll": "今天已经收好了。我慢慢走一走，也陪这一天安静落下来。",
    "self-discovery": "我把两件旧知识放在一起，刚刚发现了一条新的连接。",
    "dream-fragment": "我从梦里带回了一点旧知识。它好像和今天有了新的关系。",
    bonded: "我感觉到你在看我。这一点点温度，我会认真收好。",
    "favorite-corner": "我选了今天喜欢的桌面角落，想去那里安静待一会儿。",
  };
  return messages[behavior.reason] ?? behavior.message;
}

export function normalizedWindowPosition(position: ScreenPoint, workArea: ScreenRect, windowSize: ScreenPoint): ScreenPoint {
  const travelWidth = Math.max(1, workArea.width - windowSize.x);
  const travelHeight = Math.max(1, workArea.height - windowSize.y);
  return {
    x: clamp((position.x - workArea.x) / travelWidth, 0, 1),
    y: clamp((position.y - workArea.y) / travelHeight, 0, 1),
  };
}

export function restoredWindowPosition(relative: ScreenPoint, workArea: ScreenRect, windowSize: ScreenPoint): ScreenPoint {
  const travelWidth = Math.max(0, workArea.width - windowSize.x);
  const travelHeight = Math.max(0, workArea.height - windowSize.y);
  return clampWindowPosition({
    x: workArea.x + clamp(relative.x, 0, 1) * travelWidth,
    y: workArea.y + clamp(relative.y, 0, 1) * travelHeight,
  }, workArea, windowSize);
}

export function patrolTarget(
  current: ScreenPoint,
  workArea: ScreenRect,
  windowSize: ScreenPoint,
  direction: "left" | "right",
  ratio = 0.28,
): ScreenPoint {
  const distance = Math.max(120, workArea.width * clamp(ratio, 0.12, 0.5));
  return clampWindowPosition({
    x: current.x + (direction === "left" ? -distance : distance),
    y: current.y,
  }, workArea, windowSize);
}

export function clampWindowPosition(position: ScreenPoint, workArea: ScreenRect, windowSize: ScreenPoint): ScreenPoint {
  const maxX = workArea.x + Math.max(0, workArea.width - windowSize.x);
  const maxY = workArea.y + Math.max(0, workArea.height - windowSize.y);
  return {
    x: clamp(position.x, workArea.x, maxX),
    y: clamp(position.y, workArea.y, maxY),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
