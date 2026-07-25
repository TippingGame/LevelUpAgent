import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../src/lib/writing.ts", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "writing.ts",
}).outputText;
const writing = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("writing context preserves ranked entries within a hard budget", () => {
  const project = writing.createWritingProject("game", "Context Test");
  const document = project.documents[0];
  const selected = writing.createWritingEntity("character", "Mara");
  const linked = writing.createWritingEntity("location", "Signal Tower");
  selected.details = "S".repeat(10_000);
  linked.details = "L".repeat(10_000);
  project.premise = "P".repeat(10_000);
  document.summary = "D".repeat(10_000);
  document.linkedEntityIds = [linked.id];
  project.entities = [selected, linked];
  project.settings.contextBudget = 4_000;

  const context = writing.buildWritingContext(project, document, 0, [selected.id]);

  assert.ok(context.usedChars <= 4_000);
  assert.equal(context.budgetChars, 4_000);
  assert.equal(context.items.find((item) => item.id === selected.id)?.reason, "selected");
  assert.equal(context.items.find((item) => item.id === linked.id)?.reason, "linked");
  assert.ok(context.text.includes("Mara"));
  assert.ok(context.text.includes("Signal Tower"));
});

test("story conditions and effects are deterministic and type safe", () => {
  const variables = { trust: 1, has_key: false, mood: "calm" };
  assert.equal(writing.evaluateCondition("trust >= 1 && !has_key", variables), true);
  assert.equal(writing.evaluateCondition("trust > 2 && has_key", variables), false);

  writing.applyEffects("trust += 2; has_key toggle; mood = angry; trust += nope; has_key = maybe", variables);

  assert.deepEqual(variables, { trust: 3, has_key: true, mood: "angry" });
  assert.equal(Number.isNaN(variables.trust), false);
  assert.equal(writing.evaluateCondition("!missing_flag", variables), false);
  assert.equal(writing.evaluateCondition("!trust == 3", variables), false);

  writing.applyEffects("has_key toggle unexpected; trust +=; mood =", variables);
  assert.deepEqual(variables, { trust: 3, has_key: true, mood: "angry" });
});

test("narrative validation reports unreachable nodes and unknown variables", () => {
  const project = writing.createWritingProject("game", "Validation Test");
  const start = project.storyNodes[0];
  const unreachable = writing.createStoryNode("ending", "Hidden Ending");
  start.choices = [{
    id: "choice-test",
    label: "Open the door",
    targetNodeId: undefined,
    condition: "missing_flag",
    effects: "",
  }];
  project.storyNodes.push(unreachable);

  const issues = writing.validateNarrative(project);

  assert.ok(issues.some((issue) => issue.id.includes("missing_flag")));
  assert.ok(issues.some((issue) => issue.id === `choice-no-target-${start.id}-choice-test`));
  assert.ok(issues.some((issue) => issue.id === `unreachable-${unreachable.id}`));
});

test("Yarn export keeps same-title nodes unique and only prefixes known variables", () => {
  const project = writing.createWritingProject("game", "Yarn Test");
  const start = project.storyNodes[0];
  const ending = writing.createStoryNode("ending", start.title);
  const variable = writing.createStoryVariable("boolean");
  variable.name = "has_key";
  variable.initialValue = true;
  project.variables = [variable];
  project.storyNodes.push(ending);
  start.choices = [{
    id: "choice-yarn",
    label: "Continue",
    targetNodeId: ending.id,
    condition: "has_key == true",
    effects: "has_key = false",
  }];

  const output = writing.projectToYarn(project);
  const titles = output.split("\n").filter((line) => line.startsWith("title: "));

  assert.equal(new Set(titles).size, 2);
  assert.match(output, /\$has_key == true/);
  assert.doesNotMatch(output, /\$true/);
  assert.match(output, /<<set \$has_key = false>>/);
});

test("Yarn export translates app DSL to valid Yarn variables and values", () => {
  const project = writing.createWritingProject("game", "Yarn DSL Test");
  const start = project.storyNodes[0];
  const ending = writing.createStoryNode("ending", "End");
  const hasKey = writing.createStoryVariable("boolean");
  hasKey.name = "has_key";
  const mood = writing.createStoryVariable("string");
  mood.name = "mood-state";
  mood.initialValue = "angry";
  const trust = writing.createStoryVariable("number");
  trust.name = "trust";
  project.variables = [hasKey, mood, trust];
  project.storyNodes.push(ending);
  start.nextNodeId = ending.id;
  start.choices = [{
    id: "choice-dsl",
    label: "Take the key",
    targetNodeId: ending.id,
    condition: "has_key && mood-state == angry",
    effects: "has_key toggle; mood-state = calm night; trust += 2",
  }];

  const output = writing.projectToYarn(project);

  assert.match(output, /<<declare \$mood_state = "angry">>/);
  assert.match(output, /<<if \$has_key and \$mood_state == "angry">>/);
  assert.match(output, /<<set \$has_key = not \$has_key>>/);
  assert.match(output, /<<set \$mood_state = "calm night">>/);
  assert.match(output, /<<set \$trust \+= 2>>/);
  assert.match(output, /^<<jump .+>>$/m);
});

test("project import repairs unsafe metadata and malformed snapshots", () => {
  const project = writing.parseImportedProject({
    schemaVersion: 1,
    id: "unsafe/project/id",
    title: "T".repeat(260),
    projectType: "game",
    premise: "",
    styleGuide: "",
    documents: [],
    entities: [],
    variables: [{ id: "v", name: "flag", type: "boolean", initialValue: "false", description: "" }],
    storyNodes: [],
    snapshots: [{ id: "s", label: "Imported", createdAt: -5, state: {} }],
    settings: {},
    createdAt: -10,
    updatedAt: -20,
  });

  assert.ok(project);
  assert.match(project.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(project.title.length, 200);
  assert.equal(project.createdAt, 0);
  assert.equal(project.updatedAt, 0);
  assert.equal(project.documents.length, 1);
  assert.equal(project.variables[0].initialValue, false);
  assert.equal(project.snapshots[0].state.documents.length, 1);
  assert.equal(project.snapshots[0].createdAt, 0);
});

test("project import repairs duplicate IDs, references, settings, and timestamps", () => {
  const project = writing.parseImportedProject({
    schemaVersion: 1,
    id: "writing-import",
    title: "Imported",
    projectType: "game",
    documents: [
      { id: "document-same", title: "One", linkedEntityIds: ["entity-one", "missing", "entity-one"], createdAt: 20, updatedAt: 10 },
      { id: "document-same", title: "Two", createdAt: -5, updatedAt: -10 },
    ],
    entities: [
      { id: "entity-one", name: "One", relations: [{ id: "relation-one", targetId: "missing" }] },
      { id: "entity-one", name: "Two" },
    ],
    variables: [],
    storyNodes: [{ id: "node-one", title: "Start", speakerEntityId: "missing", linkedEntityIds: ["missing"] }],
    settings: { autoComplete: "false" },
    snapshots: [],
    createdAt: 1,
    updatedAt: 2,
  });

  assert.ok(project);
  assert.equal(new Set(project.documents.map((document) => document.id)).size, 2);
  assert.equal(new Set(project.entities.map((entity) => entity.id)).size, 2);
  assert.deepEqual(project.documents[0].linkedEntityIds, ["entity-one"]);
  assert.deepEqual(project.entities[0].relations, []);
  assert.equal(project.storyNodes[0].speakerEntityId, undefined);
  assert.deepEqual(project.storyNodes[0].linkedEntityIds, []);
  assert.equal(project.documents[0].updatedAt, project.documents[0].createdAt);
  assert.equal(project.documents[1].createdAt, 0);
  assert.equal(project.settings.autoComplete, true);
});

test("inline completion segments preserve the cursor boundary and suffix", () => {
  assert.deepEqual(
    writing.inlineCompletionSegments("潮声逼近灯塔。", 4, 4, "林澈抬起头"),
    { before: "潮声逼近", suggestion: "林澈抬起头", after: "灯塔。" },
  );
  assert.deepEqual(
    writing.inlineCompletionSegments("旧文本", -10, 99, "新文本"),
    { before: "", suggestion: "新文本", after: "" },
  );
  assert.equal(writing.applyTextCompletion("潮声逼近灯塔。", 4, 4, "林澈抬起头"), "潮声逼近林澈抬起头灯塔。");
});

test("continuation overlap removal drops echoed prose without eating new text", () => {
  assert.equal(writing.trimCompletionPrefixOverlap("潮声越过防波堤时，林澈", "林澈抬起头，看向灯塔。"), "抬起头，看向灯塔。");
  assert.equal(writing.trimCompletionPrefixOverlap("门后响了一声。", "。她停住脚步。"), "她停住脚步。");
  assert.equal(writing.trimCompletionPrefixOverlap("He opened the", "the door and waited."), " door and waited.");
  assert.equal(writing.trimCompletionPrefixOverlap("呼吸", "吸入冰冷的空气。"), "吸入冰冷的空气。");
  assert.equal(writing.trimCompletionPrefixOverlap("林澈", "林间的风停了。"), "林间的风停了。");
});

test("completion cleanup preserves paragraph boundaries", () => {
  assert.equal(writing.cleanCompletionText("\n\n第二段开始。\n"), "\n\n第二段开始。\n");
  assert.equal(writing.cleanCompletionText("```text\n\n第二段开始。\n\n```"), "\n第二段开始。\n");
  assert.equal(writing.cleanCompletionText("正文：  第一段\n\n"), "第一段\n\n");
});

test("project records keep autosave valid while a title is temporarily blank", () => {
  const project = writing.createWritingProject("screenplay", "Draft");
  project.title = "   ";
  assert.equal(writing.projectToRecord(project).title, "剧本项目");
});

test("variable renames update condition and effect references without changing literals", () => {
  assert.equal(
    writing.renameStoryVariableReferences("trust >= 2 && mood == trust; trust += 1; note = trust", "trust", "reputation"),
    "reputation >= 2 && mood == trust; reputation += 1; note = trust",
  );
});
