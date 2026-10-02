import assert from "node:assert/strict";
import test from "node:test";
import { imageGenerationSize, imageModelCapabilities, isMiniMaxImageModel, mediaModelBaseId, mediaModelSupportsExplicitImageMask, selectStudioMediaModel, sortStudioMediaModels, videoModelCapabilities, videoOutputOptions } from "../src/lib/mediaCapabilities.ts";

test("image sizes match the studio and discard incompatible saved values", () => {
  assert.equal(imageGenerationSize("gpt-image-2", "3840x2160"), "3840x2160");
  assert.equal(imageGenerationSize("gpt-image-2", "9:21"), "9:21");
  assert.equal(imageGenerationSize("image-01-2K", "2048x2048"), "2048x2048");
  assert.equal(imageGenerationSize("image-01-2K", "3840x2160"), "auto");
  assert.equal(imageGenerationSize("image-01-live", "1024x1024"), "auto");
  assert.equal(imageGenerationSize("image-01-live", "21:9"), "auto");
  assert.equal(imageGenerationSize("image-01-live", "16:9"), "16:9");
  assert.equal(imageModelCapabilities("image-01-live-2K").dimensions.length, 0);
});

test("video output controls normalize saved options while retaining supported choices", () => {
  const h3 = videoOutputOptions("MiniMax-H3", "text", { videoResolution: "720p", videoAspectRatio: "invalid", seconds: 30 });
  assert.equal(h3.resolution, "768p");
  assert.equal(h3.aspectRatio, "16:9");
  assert.equal(h3.seconds, 4);
  assert.equal(videoOutputOptions("MiniMax-H3", "image", {}).aspectRatio, "adaptive");
  const seedance = videoOutputOptions("Seedance-2.5", "text", { videoResolution: "1080p", videoAspectRatio: "21:9", seconds: 30 });
  assert.equal(seedance.seconds, 30);
  assert.equal(seedance.resolution, "1080p");
  assert.equal(seedance.aspectRatio, "21:9");
  assert.equal(videoOutputOptions("grok-imagine-video", "reference", { seconds: 15 }).seconds, 4);
  const sora = videoOutputOptions("sora-2", "text", { size: "720x1280", seconds: 10 });
  assert.equal(sora.hasControls, false);
  assert.equal(sora.size, "720x1280");
  assert.equal(sora.seconds, 4);
});

test("suffixed aliases inherit the most specific base capabilities", () => {
  for (const base of ["MiniMax-H3", "MiniMax-H3-Max", "Seedance-2", "Seedance-2.0", "Seedance-2.5", "grok-imagine-video-1.5"]) {
    for (const mode of ["text", "image", "first_last", "reference", "video"]) {
      assert.deepEqual(videoModelCapabilities(`${base}-2K`, mode), videoModelCapabilities(base, mode));
    }
  }
  assert.equal(mediaModelBaseId("models/IMAGE-01-LIVE-2K"), "image-01-live");
  assert.ok(isMiniMaxImageModel("image-01-2K"));
  for (const id of ["image-01-live-2K", "grok-imagine-2K", "grok-imagine-edit-2K"]) {
    assert.equal(mediaModelSupportsExplicitImageMask({ id, protocol: "openai_chat" }), false);
  }
  assert.equal(videoModelCapabilities("MiniMax-H30-2K").native, false);
  assert.equal(videoModelCapabilities("Seedance-20-2K").native, false);
  assert.equal(isMiniMaxImageModel("image-010-2K"), false);
  const alias = { id: "MiniMax-H3-2K", profileId: "minimax" };
  assert.equal(selectStudioMediaModel([alias], "minimax::MiniMax-H3-2K"), alias);
});

test("studio follows list order and preserves explicit model choice without recommendation bias", () => {
  const live = { id: "image-01-live", profileId: "minimax", recommended: false };
  const image = { id: "image-01", profileId: "minimax", recommended: true };
  assert.equal(selectStudioMediaModel([live, image]), live);
  assert.equal(selectStudioMediaModel([live, image], "missing::model"), live);
  assert.equal(selectStudioMediaModel([live, image], "minimax::image-01"), image);
  assert.equal(selectStudioMediaModel([live, image], "minimax::image-01-live"), live);
  assert.equal(selectStudioMediaModel([image], "minimax::image-01-live"), image);
  assert.equal(selectStudioMediaModel([live, image], "minimax::image-01-live"), live);
  assert.equal(selectStudioMediaModel([]), undefined);
  const seedance2 = { id: "Seedance-2", profileId: "seedance", recommended: false };
  const seedance25 = { id: "Seedance-2.5", profileId: "seedance", recommended: true };
  assert.equal(selectStudioMediaModel([seedance2, seedance25]), seedance2);
  assert.equal(selectStudioMediaModel([seedance2, seedance25], "seedance::Seedance-2"), seedance2);
});

test("studio sorts model names naturally without recommendation or rank priority", () => {
  const models = [
    { id: "model-10", profileName: "A", profileId: "a", recommended: true, rank: 100 },
    { id: "model-2", profileName: "B", profileId: "b", recommended: false, rank: 1 },
    { id: "model-2", profileName: "A", profileId: "a", recommended: false, rank: 1 },
  ];
  const sorted = sortStudioMediaModels(models);
  assert.deepEqual(sorted, [models[2], models[1], models[0]]);
  assert.equal(models[0].id, "model-10");
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
  assert.deepEqual(v25.resolutions, ["480p", "720p", "1080p"]);
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
