import assert from "node:assert/strict";
import test from "node:test";
import { isMiniMaxImageModel, mediaModelSupportsExplicitImageMask, selectStudioMediaModel, videoModelCapabilities } from "../src/lib/mediaCapabilities.ts";

test("studio uses an available recommendation and preserves explicit model choice", () => {
  const live = { id: "image-01-live", profileId: "minimax", recommended: false };
  const image = { id: "image-01", profileId: "minimax", recommended: true };
  assert.equal(selectStudioMediaModel([live, image]), image);
  assert.equal(selectStudioMediaModel([live, image], "minimax::image-01-live"), live);
  assert.equal(selectStudioMediaModel([image], "minimax::image-01-live"), image);
  assert.equal(selectStudioMediaModel([live, image], "minimax::image-01-live"), live);
  assert.equal(selectStudioMediaModel([]), undefined);
  const seedance2 = { id: "Seedance-2", profileId: "seedance", recommended: false };
  const seedance25 = { id: "Seedance-2.5", profileId: "seedance", recommended: true };
  assert.equal(selectStudioMediaModel([seedance2, seedance25]), seedance25);
  assert.equal(selectStudioMediaModel([seedance2, seedance25], "seedance::Seedance-2"), seedance2);
});

test("MiniMax image families use character references without mask controls", () => {
  assert.equal(isMiniMaxImageModel("image-01"), true);
  assert.equal(isMiniMaxImageModel("image-01-live"), true);
  assert.equal(isMiniMaxImageModel("gpt-image-2.5-sunburst"), false);
  assert.equal(mediaModelSupportsExplicitImageMask({ id: "image-01", protocol: "openai_chat" }), false);
  assert.equal(mediaModelSupportsExplicitImageMask({ id: "gpt-image-2.5-sunburst", protocol: "openai_chat" }), true);
});

test("H3 frame modes and resolutions follow official capabilities", () => {
  const h3 = videoModelCapabilities("MiniMax-H3", "first_last");
  assert.deepEqual(h3.resolutions, ["768p", "2K"]);
  assert.equal(h3.referenceLimit, 2);
  assert.ok(h3.durations.includes(10));
  assert.ok(h3.durations.includes(15));
  assert.ok(!h3.durations.includes(30));
  assert.ok(h3.ratios.includes("21:9"));
  const max = videoModelCapabilities("MiniMax-H3-Max");
  assert.deepEqual(max.resolutions, ["480p", "768p"]);
  assert.ok(!max.modes.includes("reference"));
  assert.ok(!max.durations.includes(4));
});

test("only Seedance 2.5 exposes 30 seconds and 30 image references", () => {
  const v2 = videoModelCapabilities("Seedance-2", "reference");
  const v25 = videoModelCapabilities("Seedance-2.5", "reference");
  assert.ok(v2.modes.includes("first_last"));
  assert.deepEqual(v2.resolutions, ["480p", "720p", "1080p", "4K"]);
  assert.equal(v2.referenceLimit, 9);
  assert.ok(!v2.durations.includes(30));
  assert.deepEqual(v25.resolutions, ["480p", "720p"]);
  assert.equal(v25.referenceLimit, 30);
  assert.ok(v25.durations.includes(30));
});

test("existing Grok reference mode retains its shorter duration and image limit", () => {
  const grok = videoModelCapabilities("grok-imagine-video", "reference");
  assert.equal(grok.referenceLimit, 7);
  assert.deepEqual(grok.durations, [4, 8, 10]);
  assert.ok(!grok.modes.includes("first_last"));
  assert.deepEqual(videoModelCapabilities("sora-2").durations, [4, 8, 12]);
});
