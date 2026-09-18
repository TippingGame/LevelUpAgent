import assert from "node:assert/strict";
import test from "node:test";
import { imageEditInputs, moveMediaReference, orderedMediaReferenceUrls } from "../src/lib/mediaReferences.ts";
import { restoreCanvasEditorState } from "../src/lib/canvasEditorState.ts";

test("moving references keeps their payloads and IDs together without changing an in-flight list", () => {
  const original = [
    { id: "portrait", name: "same.png", url: "https://example.test/portrait.png" },
    { id: "scene", name: "same.png", url: "https://example.test/scene.png" },
    { id: "style", name: "style.png", url: "https://example.test/style.png" },
  ];
  const reordered = moveMediaReference(original, 1, -1);
  assert.deepEqual(reordered.map((item) => item.id), ["scene", "portrait", "style"]);
  assert.deepEqual(orderedMediaReferenceUrls(reordered), [
    "https://example.test/scene.png", "https://example.test/portrait.png", "https://example.test/style.png",
  ]);
  assert.equal(reordered[0], original[1]);
  assert.deepEqual(original.map((item) => item.id), ["portrait", "scene", "style"]);
  assert.deepEqual(moveMediaReference(reordered, 0, 1), original);
  assert.equal(moveMediaReference(original, 0, -1), original);
  assert.equal(moveMediaReference(original, 2, 1), original);
  assert.equal(moveMediaReference(original, -1, 1), original);
});

test("batch edits isolate each source and its mask while sharing the ordered reference list", () => {
  const entries = [
    { id: "one", source: { id: "annotated-one" }, mask: { id: "mask-one" }, meta: { expanded: true, labels: ["sky"] } },
    { id: "two", source: { id: "annotated-two" }, mask: { id: "mask-two" }, meta: { expanded: false, labels: ["coat"] } },
    { id: "three", source: { id: "original-three" } },
  ];
  const references = [{ id: "style" }, { id: "pose" }];
  const batch = imageEditInputs(entries, references);
  assert.deepEqual(batch.map((input) => input.editSourceImageNumber), [1, 2, 3]);
  assert.deepEqual(batch.map((input) => input.maskAttachmentId), ["mask-one", "mask-two", undefined]);
  for (const [index, input] of batch.entries()) {
    assert.equal(input.entry, entries[index]);
    assert.deepEqual(input.referenceAttachmentIds, [entries[index].source.id, "style", "pose"]);
    assert.equal(input.referenceAttachmentIds.filter((id) => entries.some((entry) => entry.source.id === id)).length, 1);
  }
  const removed = imageEditInputs(entries.slice(1), references.toReversed());
  assert.equal(removed[0].editSourceImageNumber, 1);
  assert.equal(removed[0].maskAttachmentId, "mask-two");
  assert.deepEqual(removed[0].referenceAttachmentIds, ["annotated-two", "pose", "style"]);
  assert.deepEqual(batch[0].referenceAttachmentIds, ["annotated-one", "style", "pose"]);
  assert.deepEqual(imageEditInputs(entries, [])[0].referenceAttachmentIds, ["annotated-one"]);
  assert.deepEqual(imageEditInputs([], references), []);
});

test("reopening an image restores independent masks, erased strokes, labels and expansion without rebaking", () => {
  const saved = {
    sourceId: "original-one", padding: 0.25,
    strokes: [
      { id: "paint", tool: "mask", width: 42, points: [{ x: 90, y: 110 }] },
      { id: "erase", tool: "erase", width: 20, points: [{ x: 100, y: 110 }] },
    ],
    labels: [{ id: "label", x: 150, y: 200, text: "coat", color: "#fb7185" }],
  };
  const reopened = restoreCanvasEditorState("original-one", saved);
  assert.equal(reopened.padding, 0.25);
  assert.deepEqual(reopened.strokes, saved.strokes);
  assert.deepEqual(reopened.labels, saved.labels);
  reopened.strokes[0].points[0].x = 900;
  reopened.labels[0].text = "changed";
  reopened.padding = 0.5;
  const reopenedAgain = restoreCanvasEditorState("original-one", saved);
  assert.equal(reopenedAgain.strokes[0].points[0].x, 90);
  assert.equal(reopenedAgain.labels[0].text, "coat");
  assert.equal(reopenedAgain.padding, 0.25);
  assert.deepEqual(restoreCanvasEditorState("original-two", saved), { strokes: [], labels: [], padding: 0 });
  assert.deepEqual(restoreCanvasEditorState("original-one"), { strokes: [], labels: [], padding: 0 });
});

test("blank URL slots cannot silently change image numbers or first/last frame roles", () => {
  const references = [
    { id: "first", url: "  " },
    { id: "last", url: " https://example.test/last.png " },
  ];
  assert.deepEqual(orderedMediaReferenceUrls(references), ["", "https://example.test/last.png"]);
  assert.equal(orderedMediaReferenceUrls(references).every(Boolean), false);
  references[0].url = "https://example.test/first.png";
  assert.equal(orderedMediaReferenceUrls(references).every(Boolean), true);
  assert.deepEqual(orderedMediaReferenceUrls(moveMediaReference(references, 1, -1)), [
    "https://example.test/last.png", "https://example.test/first.png",
  ]);
});
