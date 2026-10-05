import test from "node:test";
import assert from "node:assert/strict";
import { fixedNeutrals, inspectCss, inspectTsx, compareBaseline } from "./check-appearance.mjs";

test("appearance guard catches neutral surfaces in CSS functions and schemes", () => {
  for (const color of ["#fff", "#FFFFFF", "rgb(255 255 255)", "rgba(15, 23, 42, .9)", "hsl(0 0% 100%)", "white", "slategray"]) assert.equal(fixedNeutrals(color).length, 1, color);
  assert.equal(inspectCss(".new { background: linear-gradient(90deg, #fff, #f8fafc); color-scheme: light; }").length, 2);
  assert.equal(inspectCss(".new { color: var(--text); background: var(--surface); }").length, 0);
  assert.equal(fixedNeutrals('url("white.png")').length, 0);
  assert.equal(fixedNeutrals("rgba(0,0,0,.12)").length, 0);
});

test("palette owners and reviewed asset contrast pairs are explicit", () => {
  assert.equal(inspectCss(":root { --surface: #fff; } .armor-mode .panel { background: #111; }").length, 0);
  assert.equal(inspectCss("/* appearance-allow: fixed white paper is part of the rendered document */\n.paper { background: white; }").length, 0);
  assert.equal(inspectCss("/* appearance-allow: */ .panel { background: white; }").length, 1);
});

test("inline JSX colors are checked without treating strings or assets as CSS", () => {
  assert.equal(inspectTsx('const x = <div style={{ background: "white", color: "#111" }} />;').length, 2);
  assert.equal(inspectTsx('const x = <svg><path fill="#fff" stroke={"gray"} /></svg>;').length, 2);
  assert.equal(inspectTsx('const x = <div style={{ background: "var(--surface)" }} title="white" />;').length, 0);
});

test("legacy exemptions cannot spread to new files, new selectors or copies", () => {
  const issue = { file: "src/old.css", key: ".old: background: white", line: 2, message: "fixed color" };
  const baseline = { "src/old.css": { [issue.key]: 1 } };
  assert.deepEqual(compareBaseline([issue], baseline), []);
  assert.equal(compareBaseline([issue, issue], baseline).length, 1);
  assert.equal(compareBaseline([issue, { ...issue, file: "src/new.css" }], baseline).length, 1);
  assert.equal(compareBaseline([issue, { ...issue, key: ".new: background: white" }], baseline).length, 1);
  assert.equal(compareBaseline([], baseline).length, 1);
});
