import assert from "node:assert/strict";
import test from "node:test";
import { moveMediaReference, orderedMediaReferenceUrls } from "../src/lib/mediaReferences.ts";

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
