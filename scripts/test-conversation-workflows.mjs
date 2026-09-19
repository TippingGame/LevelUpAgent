import assert from "node:assert/strict";
import test from "node:test";
import { ComposerDraftStore, parseComposerDraft } from "../src/lib/composerDrafts.ts";
import { mergeThreadCatalog, threadMatchesQuery } from "../src/lib/conversationCatalog.ts";

const empty = () => ({ content: "", attachments: [] });
const fixture = (id, content = "") => ({ id, title: id, messages: [{ role: "user", content }], updatedAt: 1 });

test("catalog pages never overwrite loaded or running messages", () => {
  const live = fixture("live", "streaming delta");
  const result = mergeThreadCatalog([live], [{ ...live, messages: [], historyLoaded: false }, fixture("older")]);
  assert.equal(result.length, 2);
  assert.equal(result[0], live);
  assert.equal(result[0].messages[0].content, "streaming delta");
});

test("conversation search matches visible message content without internal or tool noise", () => {
  const thread = fixture("task", "中文修复 and RUST");
  thread.messages.push({ role: "tool", content: "hidden tool" }, { role: "user", internal: true, content: "private continuation" });
  assert.equal(threadMatchesQuery(thread, "中文", "zh-CN"), true);
  assert.equal(threadMatchesQuery(thread, "rust", "en-US"), true);
  assert.equal(threadMatchesQuery(thread, "hidden tool", "en-US"), false);
  assert.equal(threadMatchesQuery(thread, "private continuation", "en-US"), false);
});

test("drafts keep text and attachments isolated across conversations and reloads", async () => {
  const rows = new Map();
  const persistence = { read: async (id) => rows.get(id) ?? empty(), write: async (id, draft) => { rows.set(id, draft); } };
  const store = new ComposerDraftStore(persistence);
  await store.load("one");
  await store.load("two");
  const attachment = { id: "managed-file", name: "notes.txt", kind: "text", mimeType: "text/plain", sizeBytes: 4 };
  const folder = { id: "referenced-folder", name: "资料", kind: "folder", mimeType: "inode/directory", sizeBytes: 0 };
  store.update("one", () => ({ content: "  first\n", attachments: [attachment, folder] }));
  store.update("two", () => ({ content: "second", attachments: [] }));
  await store.flush();
  const restored = new ComposerDraftStore(persistence);
  await restored.load("one");
  assert.equal(restored.get("one").content, "  first\n");
  assert.deepEqual(restored.get("one").attachments, [attachment, folder]);
  store.clear("two");
  await store.flush();
  assert.equal(rows.get("one").content, "  first\n");
  assert.equal(rows.get("two").content, "");
});

test("a delayed draft read cannot revive a cleared or edited draft", async () => {
  let finish;
  const store = new ComposerDraftStore({ read: () => new Promise((resolve) => { finish = resolve; }), write: async () => {} });
  const loading = store.load("one");
  store.update("one", () => ({ content: "new text", attachments: [] }));
  finish({ content: "old text", attachments: [] });
  await loading;
  assert.equal(store.get("one").content, "new text");
  await store.flush();
});

test("draft writes coalesce and retry after a storage failure without losing newer text", async () => {
  const writes = [];
  let fail = true;
  const store = new ComposerDraftStore({
    read: async () => empty(),
    write: async (id, draft) => { if (fail) throw new Error("disk full"); writes.push([id, draft.content]); },
  });
  await store.load("one");
  for (let index = 0; index < 20; index++) store.update("one", () => ({ content: `version ${index}`, attachments: [] }));
  await assert.rejects(store.flush(), /disk full/);
  assert.equal(store.get("one").content, "version 19");
  assert.match(store.getError(), /disk full/);
  fail = false;
  await store.flush();
  assert.deepEqual(writes, [["one", "version 19"]]);
  assert.equal(store.getError(), undefined);
});

test("a close-time flush waits for in-flight persistence and retries retained data", async () => {
  let finish;
  let attempts = 0;
  const store = new ComposerDraftStore({
    read: async () => empty(),
    write: async () => { if (++attempts === 1) await new Promise((_, reject) => { finish = reject; }); },
  });
  store.update("one", () => ({ content: "retain", attachments: [] }));
  const first = store.flush();
  await new Promise((resolve) => setImmediate(resolve));
  const close = store.flush();
  finish(new Error("transient failure"));
  await assert.rejects(first, /transient failure/);
  await close;
  assert.equal(attempts, 2);
  assert.equal(store.getError(), undefined);
});

test("late imports and send completion stay with their originating draft", async () => {
  const store = new ComposerDraftStore({ read: async () => empty(), write: async () => {} });
  const file = { id: "first", name: "first.txt", kind: "text", mimeType: "text/plain", sizeBytes: 1 };
  store.update("one", () => ({ content: "sent", attachments: [file] }));
  const submitted = store.get("one");
  store.update("two", () => ({ content: "different task", attachments: [] }));
  store.update("one", (draft) => ({ ...draft, content: "new follow-up" }));
  store.appendAttachments("one", [{ ...file, id: "late-import" }]);
  store.consume("one", submitted);
  assert.equal(store.get("one").content, "new follow-up");
  assert.deepEqual(store.get("one").attachments.map((item) => item.id), ["late-import"]);
  assert.deepEqual(store.get("two").attachments, []);
  assert.equal(store.get("two").content, "different task");
  const excess = store.appendAttachments("one", Array.from({ length: 70 }, (_, index) => ({ ...file, id: `file-${index}` })));
  assert.equal(excess.length, 0);
  assert.equal(store.get("one").attachments.length, 71);
  assert.equal(parseComposerDraft(JSON.parse(JSON.stringify(store.get("one")))).attachments.length, 71);
  await store.flush();
});

test("saved draft validation rejects malformed attachment metadata", () => {
  assert.deepEqual(parseComposerDraft(empty()), empty());
  for (const attachment of [null, {}, { id: "x" }, { id: "x", name: "file", kind: "image", mimeType: "image/png", sizeBytes: -1 }]) {
    assert.throws(() => parseComposerDraft({ content: "keep", attachments: [attachment] }), /Invalid saved draft/);
  }
});

test("retry also reloads a failed draft in an inactive conversation", async () => {
  let failed = true;
  const store = new ComposerDraftStore({
    read: async () => { if (failed) throw new Error("temporary read failure"); return { content: "recovered", attachments: [] }; },
    write: async () => {},
  });
  await store.load("inactive");
  assert.equal(store.get("inactive").ready, false);
  failed = false;
  await store.retry();
  assert.equal(store.get("inactive").content, "recovered");
  assert.equal(store.getError(), undefined);
});

test("a close-time flush includes edits made while its first write is in flight", async () => {
  let finish;
  const written = [];
  const store = new ComposerDraftStore({
    read: async () => empty(),
    write: async (_id, draft) => {
      written.push(draft.content);
      if (written.length === 1) await new Promise((resolve) => { finish = resolve; });
    },
  });
  store.update("one", () => ({ content: "first", attachments: [] }));
  const closing = store.flush();
  await new Promise((resolve) => setImmediate(resolve));
  store.update("one", () => ({ content: "last edit", attachments: [] }));
  finish();
  await closing;
  assert.deepEqual(written, ["first", "last edit"]);
  await store.flush();
});
