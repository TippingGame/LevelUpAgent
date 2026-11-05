import assert from "node:assert/strict";
import test from "node:test";
import { mediaHistoryFilter } from "../src/lib/mediaHistory.ts";

test("custom dates include the whole end day and support open boundaries", () => {
  const result = mediaHistoryFilter("  橘猫  ", "custom", "2026-11-01", "2026-11-05");
  assert.deepEqual(result, { keyword: "橘猫", createdAfter: new Date(2026, 10, 1).getTime(), createdBefore: new Date(2026, 10, 6).getTime() });
  assert.ok(mediaHistoryFilter("", "custom", "2026-11-05", "2026-11-05"));
  assert.equal(mediaHistoryFilter("", "custom", "2026-11-06", "2026-11-05"), null);
  assert.equal(mediaHistoryFilter("", "custom", "bad", ""), null);
  assert.equal(mediaHistoryFilter("", "custom", "", "2026-11-05").createdAfter, undefined);
  assert.equal(mediaHistoryFilter("", "custom", "2026-11-05", "").createdBefore, undefined);
});

test("quick ranges use local calendar days and all time ignores custom dates", () => {
  const now = new Date(2026, 10, 5, 14, 30);
  assert.equal(mediaHistoryFilter("", "today", "", "", now).createdAfter, new Date(2026, 10, 5).getTime());
  assert.equal(mediaHistoryFilter("", "7", "", "", now).createdAfter, new Date(2026, 9, 30).getTime());
  assert.equal(mediaHistoryFilter("", "30", "", "", now).createdAfter, new Date(2026, 9, 7).getTime());
  assert.deepEqual(mediaHistoryFilter("", "all", "bad", "bad", now), { keyword: undefined });
});
