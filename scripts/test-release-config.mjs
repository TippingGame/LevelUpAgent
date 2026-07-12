import assert from "node:assert/strict";
import { validateUpdaterEndpoint } from "./release-config-lib.mjs";

assert.equal(
  validateUpdaterEndpoint("https://updates.example.test/{{target}}/{{arch}}/{{current_version}}"),
  "https://updates.example.test/%7B%7Btarget%7D%7D/%7B%7Barch%7D%7D/%7B%7Bcurrent_version%7D%7D",
);
for (const invalid of [
  "http://updates.example.test/latest.json",
  "https://user:password@updates.example.test/latest.json",
  "https://updates.example.test/latest.json#unsigned-fragment",
  "not-a-url",
]) {
  assert.throws(() => validateUpdaterEndpoint(invalid), undefined, invalid);
}

console.log("Release updater endpoint validation passed.");

