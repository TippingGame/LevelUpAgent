import assert from "node:assert/strict";
import test from "node:test";
import { composerTrigger, fileReference, matchingSkills, replaceComposerTrigger, skillReference } from "../src/lib/composerReferences.ts";
import { DEFAULT_CHAT_APPEARANCE, loadChatAppearance, normalizeChatAppearance, saveChatAppearance } from "../src/lib/chatAppearance.ts";
import { localAttachmentPaths } from "../src/lib/localAttachments.ts";

test("composer triggers match caret tokens without hijacking emails, URLs or paths", () => {
  for (const value of ["mail@example.com", "https://example.com/skill", "src/code.ts", "/usr/local", "C:\\files", "hello", "[@file](levelup-file:source)"]) assert.equal(composerTrigger(value, value.length), null, value);
  assert.deepEqual(composerTrigger("请使用 /writ", 9), { kind: "skill", start: 4, end: 9, query: "writ" });
  assert.deepEqual(composerTrigger("read @src/App.tsx", 17), { kind: "file", start: 5, end: 17, query: "src/App.tsx" });
  assert.equal(composerTrigger("/skill\n@", 8)?.kind, "file");
});

test("reference insertion replaces only the active query and preserves trailing text", () => {
  const text = "Use /wri for this document";
  const trigger = composerTrigger(text, 8);
  const result = replaceComposerTrigger(text, trigger, skillReference({ id: "skill-123", name: "writing" }));
  assert.equal(result.text, "Use [$writing](levelup-skill:skill-123) for this document");
  assert.equal(result.text.slice(result.caret), " for this document");
  assert.equal(skillReference({ id: "skill-456", name: "draft [v2]" }), "[$draft \\[v2\\]](levelup-skill:skill-456)");
});

test("project references preserve spaces, Unicode and punctuation without duplicate auto-imports", () => {
  const reference = fileReference("src/计划 [final] (1)#%.md");
  const encoded = reference.split("levelup-file:")[1].slice(0, -1);
  assert.equal(decodeURIComponent(encoded), "src/计划 [final] (1)#%.md");
  assert.deepEqual(localAttachmentPaths(reference), []);
  assert.deepEqual(localAttachmentPaths(skillReference({ id: "skill-123", name: "writing" })), []);
});

test("Skill choices include only valid enabled matches and prefer name prefixes", () => {
  const base = { id: "one", name: "writer", description: "edit text", source: "Workspace", enabled: true, valid: true };
  const choices = matchingSkills([{ ...base, id: "two", name: "notes", description: "writer notes" }, base, { ...base, enabled: false }, { ...base, valid: false }], "WRIT");
  assert.deepEqual(choices.map((item) => item.id), ["one", "two"]);
});

test("reading preferences clamp invalid saved values and survive reloading", () => {
  const data = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } });
  try {
    assert.deepEqual(loadChatAppearance(), DEFAULT_CHAT_APPEARANCE);
    saveChatAppearance({ fontSize: 20, lineHeight: 1.4, paragraphSpacing: 0 });
    assert.deepEqual(loadChatAppearance(), { fontSize: 20, lineHeight: 1.4, paragraphSpacing: 0 });
    assert.deepEqual(normalizeChatAppearance({ fontSize: Infinity, lineHeight: -4, paragraphSpacing: 90 }), { fontSize: 15, lineHeight: 1.2, paragraphSpacing: 24 });
    assert.deepEqual(normalizeChatAppearance({ fontSize: "20" }), DEFAULT_CHAT_APPEARANCE);
    data.set("levelup-agent.chat-appearance.v1", "broken");
    assert.deepEqual(loadChatAppearance(), DEFAULT_CHAT_APPEARANCE);
  } finally { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; }
});
