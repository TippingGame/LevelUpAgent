import assert from "node:assert/strict";
import test from "node:test";

import {
  animationDuration,
  animationFrameAtTime,
  animationFrameSequence,
  PET_ANIMATIONS,
} from "../src/lib/petAnimation.ts";

test("directional running matches XiaoLu's even 720 ms gait", () => {
  for (const state of ["running-right", "running-left"]) {
    const animation = PET_ANIMATIONS[state];
    assert.deepEqual(animation.frameDurations, [90, 90, 90, 90, 90, 90, 90, 90]);
    assert.equal(animationDuration(animation.frameDurations), 720);
  }
});

test("absolute phase skips delayed frames without changing the gait clock", () => {
  const durations = PET_ANIMATIONS["running-right"].frameDurations;
  assert.equal(animationFrameAtTime(durations, 0), 0);
  assert.equal(animationFrameAtTime(durations, 89.99), 0);
  assert.equal(animationFrameAtTime(durations, 90), 1);
  assert.equal(animationFrameAtTime(durations, 451), 5);
  assert.equal(animationFrameAtTime(durations, 719), 7);
  assert.equal(animationFrameAtTime(durations, 720), 0);
  assert.equal(animationFrameAtTime(durations, 1_441), 0);
});

test("state-specific holds remain intact for non-locomotion reactions", () => {
  assert.equal(animationFrameAtTime(PET_ANIMATIONS.waving.frameDurations, 500), 3);
  assert.equal(animationDuration(PET_ANIMATIONS.idle.frameDurations), 1_100);
});

test("every atlas row starts at column zero and advances in column order", () => {
  for (const [state, animation] of Object.entries(PET_ANIMATIONS)) {
    const durations = animation.frameDurations;
    assert.ok(durations.length > 0, `${state} must have at least one frame`);
    assert.ok(durations.every((duration) => duration > 0), `${state} durations must be positive`);
    assert.deepEqual(animationFrameSequence(durations), durations.map((_, index) => index));

    const total = animationDuration(durations);
    assert.equal(animationFrameAtTime(durations, 0), 0, `${state} must begin at column zero`);
    assert.equal(animationFrameAtTime(durations, total), 0, `${state} must loop to column zero`);
    assert.equal(
      animationFrameAtTime(durations, total - 0.001),
      durations.length - 1,
      `${state} must end on its final used column`,
    );

    let previous = 0;
    for (let elapsed = 1; elapsed < total; elapsed += 1) {
      const current = animationFrameAtTime(durations, elapsed);
      if (current < previous) {
        assert.equal(previous, durations.length - 1, `${state} wrapped before its final column`);
        assert.equal(current, 0, `${state} may only wrap from the final column to zero`);
      }
      previous = current;
    }
  }
});
