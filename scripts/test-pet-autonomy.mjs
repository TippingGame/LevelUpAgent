import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  clampWindowPosition,
  localDateKey,
  normalizedWindowPosition,
  patrolTarget,
  petBehaviorLabel,
  petBehaviorMessage,
  petBehaviorSprite,
  restoredWindowPosition,
} from "../src/lib/petAutonomy.ts";

test("browser preview uses the pet's local calendar date", () => {
  const localAfterMidnight = {
    getFullYear: () => 2026,
    getMonth: () => 7,
    getDate: () => 13,
    toISOString: () => "2026-08-12T16:05:00.000Z",
  };
  assert.equal(localDateKey(localAfterMidnight), "2026-08-13");
});

test("life behaviors map to intentional sprite states", () => {
  const behavior = (state, direction) => ({ state, direction, reason: "test", message: "", since: 0, nextDecisionAt: 0 });
  assert.equal(petBehaviorSprite(behavior("wandering", "left")), "running-left");
  assert.equal(petBehaviorSprite(behavior("wandering", "right")), "running-right");
  assert.equal(petBehaviorSprite(behavior("studying")), "review");
  assert.equal(petBehaviorSprite(behavior("learning")), "review");
  assert.equal(petBehaviorSprite(behavior("discovering")), "review");
  assert.equal(petBehaviorSprite(behavior("dreaming")), "idle");
  assert.equal(petBehaviorSprite(behavior("planning")), "running");
  assert.equal(petBehaviorSprite(behavior("resting")), "idle");
});

test("behavior copy is localized for meaningful transitions", () => {
  const behavior = { state: "waiting", reason: "scheduled-check-in", message: "Check in.", since: 0, nextDecisionAt: 0 };
  assert.equal(petBehaviorLabel("waiting", "zh-CN"), "正在等你");
  assert.match(petBehaviorMessage(behavior, "zh-CN"), /签到/);
  const supervision = { ...behavior, reason: "study-supervision-final" };
  assert.match(petBehaviorMessage(supervision, "zh-CN"), /最后一次提醒/);
  const discovery = { ...behavior, state: "discovering", reason: "self-discovery" };
  assert.equal(petBehaviorLabel("discovering", "zh-CN"), "发现连接");
  assert.match(petBehaviorMessage(discovery, "zh-CN"), /连接/);
});

test("autonomy switches cannot programmatically scroll the studio root", () => {
  const css = readFileSync(new URL("../src/components/PetStudio.css", import.meta.url), "utf8");
  const component = readFileSync(new URL("../src/components/PetLifeWorkspace.tsx", import.meta.url), "utf8");
  assert.match(css, /\.pet-studio\s*\{[^}]*overflow:\s*clip;/);
  assert.match(component, /className="pet-toggle"[^>]*role="switch"[^>]*aria-checked=\{checked\}/);
  assert.doesNotMatch(component, /className="pet-toggle"[^\n]*type="checkbox"/);
});

test("patrol targets stay inside a negative-origin monitor work area", () => {
  const area = { x: -1920, y: 24, width: 1920, height: 1040 };
  const windowSize = { x: 430, y: 580 };
  assert.deepEqual(patrolTarget({ x: -1800, y: 500 }, area, windowSize, "left"), { x: -1920, y: 484 });
  assert.deepEqual(patrolTarget({ x: -500, y: 500 }, area, windowSize, "right"), { x: -430, y: 484 });
});

test("relative positions round-trip across monitor sizes", () => {
  const source = { x: 0, y: 0, width: 1920, height: 1040 };
  const target = { x: 1920, y: 0, width: 2560, height: 1400 };
  const windowSize = { x: 430, y: 580 };
  const relative = normalizedWindowPosition({ x: 1192, y: 322 }, source, windowSize);
  assert.ok(Math.abs(relative.x - 0.8) < 0.001);
  assert.ok(Math.abs(relative.y - 0.7) < 0.001);
  assert.deepEqual(restoredWindowPosition(relative, target, windowSize), { x: 3624, y: 574 });
});

test("window clamping accounts for the full window size", () => {
  assert.deepEqual(
    clampWindowPosition({ x: 2000, y: -100 }, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 430, y: 580 }),
    { x: 1490, y: 0 },
  );
});
