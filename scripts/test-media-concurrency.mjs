import assert from "node:assert/strict";
import test from "node:test";

import {
  executeCallsWithParallelMedia,
  isMediaTool,
} from "../src/lib/mediaConcurrency.ts";

const call = (id, name) => ({ id, name, arguments: {} });
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("consecutive generation tools run concurrently and results preserve model order", async () => {
  const calls = [
    call("image", "generate_images"),
    call("video", "generate_videos"),
    call("read", "read_file"),
    call("speech", "generate_speech"),
    call("check", "check_media_jobs"),
  ];
  const delays = { image: 25, video: 5, read: 1, speech: 5, check: 1 };
  const events = [];
  let active = 0;
  let maximumActive = 0;
  let speechFinished = false;

  const results = await executeCallsWithParallelMedia(calls, async (item) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    events.push(`start:${item.id}`);
    if (item.id === "check") assert.equal(speechFinished, true, "job checks must wait for generation");
    await wait(delays[item.id]);
    if (item.id === "speech") speechFinished = true;
    events.push(`end:${item.id}`);
    active -= 1;
    return item.id;
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(results.map((item) => item.result), calls.map((item) => item.id));
  assert.ok(events.indexOf("start:video") < events.indexOf("end:image"));
  assert.ok(events.indexOf("start:check") > events.indexOf("end:speech"));
  assert.equal(isMediaTool("check_media_jobs"), true);
  assert.equal(isMediaTool("read_file"), false);
});
