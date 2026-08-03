import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../src/lib/modelSelection.ts", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "modelSelection.ts",
}).outputText;
const selection = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const geminiProfile = {
  id: "gemini",
  name: "Gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  model: "",
  protocol: "gemini_generate_content",
};
const models = (...ids) => ids.map((id) => ({ id }));

test("Gemini discovery recommends 3.6 Flash over older general models", () => {
  const selected = selection.preferredDetectedModel(geminiProfile, models(
    "gemini-2.5-pro",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
  ));

  assert.equal(selected?.id, "gemini-3.6-flash");
});

test("Gemini Flash-Lite models remain ordered fallbacks", () => {
  const selected = selection.preferredDetectedModel(geminiProfile, models(
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
  ));

  assert.equal(selected?.id, "gemini-3.5-flash-lite");
});

test("Nano Banana image models are never selected as the default text model", () => {
  const selected = selection.preferredDetectedModel(geminiProfile, models(
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-flash-lite",
  ));

  assert.equal(selected?.id, "gemini-3.1-flash-lite");
  assert.equal(
    selection.preferredDetectedModel(geminiProfile, models("gemini-3.1-flash-lite-image")),
    undefined,
  );
  assert.equal(selection.isTextGenerationModel({ id: "gemini-3.1-flash-lite-image" }), false);
  assert.equal(selection.isTextGenerationModel({ id: "gemini-3.5-flash-lite" }), true);
  assert.equal(selection.isTextGenerationModel({ id: "provider-model", outputModalities: ["IMAGE"] }), false);
});
