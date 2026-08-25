import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVERSATION_EXPORT_FORMAT,
  parseConversationExport,
  serializeConversationExport,
} from "../src/lib/conversationExport.ts";

const thread = {
  id: "thread-1",
  title: "Export me",
  workspace: "C:/workspace",
  messages: [
    {
      id: "message-1",
      role: "user",
      content: "Inspect this image",
      toolCalls: [],
      createdAt: 1_700_000_000_000,
      attachments: [{ id: "attachment-1", name: "screen.png", mimeType: "image/png", sizeBytes: 6_000_000, kind: "image" }],
    },
    {
      id: "message-2",
      role: "assistant",
      content: "I can inspect it.",
      toolCalls: [],
      createdAt: 1_700_000_000_100,
      attachments: [],
    },
  ],
  updatedAt: 1_700_000_000_100,
  inputTokens: 12,
  outputTokens: 8,
};

test("conversation export carries structured messages and readable transcript", () => {
  const parsed = JSON.parse(serializeConversationExport(thread));
  assert.equal(parsed.format, CONVERSATION_EXPORT_FORMAT);
  assert.equal(parsed.messages.length, 2);
  assert.match(parsed.transcript, /Inspect this image/);
  assert.match(parsed.transcript, /screen\.png/);
});

test("conversation import accepts exported JSON and does not require attachment bytes", () => {
  const imported = parseConversationExport(serializeConversationExport(thread));
  assert.equal(imported.title, "Export me");
  assert.equal(imported.messages.length, 2);
  assert.match(imported.messages[0].content, /Attachment: screen\.png/);
  assert.deepEqual(imported.messages[0].toolCalls, []);
});

test("conversation import accepts OpenAI-style content arrays", () => {
  const imported = parseConversationExport(JSON.stringify({
    title: "OpenAI export",
    messages: [{
      role: "user",
      content: [{ type: "input_text", text: "Hello" }, { type: "input_image", image_url: "data:image/png;base64,abc" }],
    }],
  }));
  assert.match(imported.messages[0].content, /Hello/);
  assert.match(imported.messages[0].content, /Image attachment/);
});
