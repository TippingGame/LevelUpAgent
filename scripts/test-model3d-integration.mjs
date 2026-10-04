import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const project = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(new URL("../src/lib/constellation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: "constellation.ts" }).outputText;
const constellation = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("3D diagnostic blueprint survives the real graph importer and runs its command", () => {
  const directory = mkdtempSync(join(tmpdir(), "levelup model3d 'quoted' "));
  try {
    const generated = spawnSync(process.env.MODEL3D_TEST_PYTHON || "python", [join(project, "scripts", "model3d_lab.py"), "blueprint", "--root", join(directory, "missing module")], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.equal(generated.status, 0, generated.stderr);
    const envelope = JSON.parse(generated.stdout);
    assert.equal(envelope.kind, "levelup-constellation");
    const graph = constellation.normalizeConstellationGraph(envelope.graph);
    assert.ok(graph);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].targetHandle, "media");
    assert.equal(graph.nodes[0].data.toolTemplate.outputSchema[0].type, "json");
    const template = graph.nodes[0].data.toolTemplate;
    const command = constellation.renderConstellationTemplate(template.command, {}, "");
    const result = process.platform === "win32"
      ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, timeout: 25000 })
      : spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 25000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.kind, "model3d-preflight");
    assert.equal(report.status, "blocked");
    assert.equal(report.generationExecuted, false);
    assert.equal(report.moduleRoot, resolve(directory, "missing module"));
  } finally {
    // Verify the resolved target stays in the intended temp directory before recursive cleanup.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("levelup model3d 'quoted' "));
    assert.equal(lstatSync(directory).isSymbolicLink(), false);
    rmSync(directory, { recursive: true, force: true });
  }
});
