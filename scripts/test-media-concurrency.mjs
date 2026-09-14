import assert from "node:assert/strict";
import test from "node:test";

import {
  executeCallsWithParallelMedia,
  isMediaTool,
} from "../src/lib/mediaConcurrency.ts";
import { createMediaPoller, deduplicateMediaRefresh } from "../src/lib/mediaPolling.ts";

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

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(setImmediate);

test("video polling publishes fast results while a slow download remains in flight", async () => {
  const slow = deferred(), fast = deferred();
  const calls = [], updates = [];
  const poller = createMediaPoller((id) => {
    calls.push(id);
    return id === "slow" ? slow.promise : fast.promise;
  }, (asset) => updates.push(asset), () => {});
  poller.poll(["slow", "fast"]);
  poller.poll(["slow", "fast"]);
  await flush();
  fast.resolve({ id: "fast", status: "completed" });
  await flush();
  assert.deepEqual(updates, [{ id: "fast", status: "completed" }]);
  poller.poll(["slow"]);
  await flush();
  assert.deepEqual(calls, ["slow", "fast"]);
  slow.resolve({ id: "slow", status: "completed" });
  await flush();
  assert.equal(updates.length, 2);
  poller.stop();
});

test("each video retries and recovers its own error independently", async () => {
  let recovered = false;
  const errors = new Map(), updates = [];
  const poller = createMediaPoller(async (id) => {
    if (id === "retry" && !recovered) throw new Error("temporary status failure");
    return { id };
  }, (asset) => updates.push(asset.id), (id, error) => {
    if (error === null) errors.delete(id);
    else errors.set(id, error.message);
  });
  poller.poll(["retry", "working"]);
  await flush();
  assert.equal(errors.get("retry"), "temporary status failure");
  assert.deepEqual(updates, ["working"]);
  recovered = true;
  poller.poll(["retry"]);
  await flush();
  assert.equal(errors.size, 0);
  assert.deepEqual(updates, ["working", "retry"]);
  poller.stop();
});

test("remounting shares an existing video download and ignores disposed callbacks", async () => {
  const pending = deferred();
  let calls = 0;
  const refresh = deduplicateMediaRefresh(() => { calls++; return pending.promise; });
  const oldUpdates = [], newUpdates = [];
  const old = createMediaPoller(refresh, (asset) => oldUpdates.push(asset), () => assert.fail("disposed error"));
  old.poll(["video"]);
  await flush();
  old.stop();
  old.poll(["another-video"]);
  const next = createMediaPoller(refresh, (asset) => newUpdates.push(asset), () => {});
  next.poll(["video"]);
  next.poll(["video"]);
  await flush();
  assert.equal(calls, 1);
  pending.resolve({ id: "video", status: "completed" });
  await flush();
  assert.deepEqual(oldUpdates, []);
  assert.deepEqual(newUpdates, [{ id: "video", status: "completed" }]);
  next.stop();
});

test("failed refreshes release their shared request so the same task can retry", async () => {
  let calls = 0;
  const refresh = deduplicateMediaRefresh(() => {
    calls++;
    if (calls === 1) throw new Error("download interrupted");
    return Promise.resolve({ id: "video" });
  });
  const first = refresh("video");
  assert.equal(refresh("video"), first);
  await assert.rejects(first, /download interrupted/);
  assert.deepEqual(await refresh("video"), { id: "video" });
  assert.equal(calls, 2);
});
