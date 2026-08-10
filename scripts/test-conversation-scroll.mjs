import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVERSATION_BOTTOM_THRESHOLD,
  isConversationNearBottom,
  shouldFollowConversationUpdate,
} from "../src/lib/conversationScroll.ts";

test("conversation follows updates only while the reader remains near the bottom", () => {
  assert.equal(isConversationNearBottom({ scrollHeight: 1_000, scrollTop: 304, clientHeight: 600 }), true);
  assert.equal(isConversationNearBottom({ scrollHeight: 1_000, scrollTop: 303, clientHeight: 600 }), false);
  assert.equal(CONVERSATION_BOTTOM_THRESHOLD, 96);
  assert.equal(shouldFollowConversationUpdate(true, false), true);
  assert.equal(shouldFollowConversationUpdate(false, false), false);
});

test("a newly submitted user message resumes conversation following", () => {
  assert.equal(shouldFollowConversationUpdate(false, true), true);
});
