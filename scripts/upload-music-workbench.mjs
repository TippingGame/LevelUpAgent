// Reuse one Release for immutable audio resource revisions, independent of apps.
// A newly created resource Release stays draft until explicitly published.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.resolve(process.argv[2] ?? "artifacts/music-workbench/release");
const spec = JSON.parse(fs.readFileSync(path.join(root, "modules/music_workbench/resources.json"), "utf8"));
const manifestPath = path.join(directory, `music-workbench-${spec.resourceVersion}-${spec.target}.json`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const key of ["schemaVersion", "resourceVersion", "releaseTag", "target", "repository", "modelRevision"]) {
  if (manifest[key] !== spec[key]) throw new Error(`Resource specification mismatch: ${key}`);
}
const components = ["runtime", "musicgen-small"];
if (Object.keys(manifest.components).sort().join() !== components.sort().join()) throw new Error("Invalid component set");
const files = [], names = new Set();
for (const [name, component] of Object.entries(manifest.components)) {
  if (!component.license || !component.sources?.length || !Number.isSafeInteger(component.unpackedBytes) || component.unpackedBytes <= 0 || !component.parts?.length) throw new Error(`Incomplete component: ${name}`);
  const archiveHash = crypto.createHash("sha256");
  for (const part of component.parts) {
    const prefix = `music-workbench-${spec.resourceVersion}-${spec.target}-${name}.zip.part`;
    if (!part.name.startsWith(prefix) || !/^\d{3}$/.test(part.name.slice(prefix.length)) || names.has(part.name)) throw new Error("Invalid or duplicate asset name");
    names.add(part.name);
    const file = path.join(directory, part.name);
    if (!Number.isSafeInteger(part.bytes) || part.bytes <= 0 || fs.statSync(file).size !== part.bytes || part.bytes >= 2_000_000_000) throw new Error(`Invalid size: ${part.name}`);
    const digest = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) { digest.update(chunk); archiveHash.update(chunk); }
    if (digest.digest("hex") !== part.sha256) throw new Error(`Hash mismatch: ${part.name}`);
    files.push({ file, name: part.name, size: part.bytes, digest: `sha256:${part.sha256}` });
    console.log(`Verified ${part.name}`);
  }
  if (archiveHash.digest("hex") !== component.sha256) throw new Error(`Archive hash mismatch: ${name}`);
}
const manifestBytes = fs.readFileSync(manifestPath);
const index = { file: manifestPath, name: path.basename(manifestPath), size: manifestBytes.length, digest: `sha256:${crypto.createHash("sha256").update(manifestBytes).digest("hex")}` };
const repo = "TippingGame/LevelUpAgent", tag = spec.releaseTag;
const gh = args => execFileSync("gh", args, { encoding: "utf8" });
// A failed API/auth request must not be mistaken for a missing Release.
const releases = JSON.parse(gh(["release", "list", "--repo", repo, "--limit", "1000", "--json", "tagName"]));
if (!releases.some(release => release.tagName === tag)) {
  gh(["release", "create", tag, "--repo", repo, "--target", "main", "--draft", "--prerelease", "--latest=false", "--title", "Audio Workbench Shared Resources", "--notes", "Shared portable Python, CUDA and MusicGen Small resources. MusicGen weights are CC-BY-NC-4.0 for non-commercial use. Resource versions are independent of application versions. Existing assets are immutable; this release is excluded from Latest."]);
}
// The REST tag endpoint can return 404 for a draft whose tag is not pushed yet.
const releaseId = Number(gh(["api", `repos/${repo}/releases?per_page=100`, "--paginate", "--jq", `.[] | select(.tag_name == "${tag}") | .id`]).trim());
if (!releaseId) throw new Error("Shared resource Release was not found after creation");
const release = JSON.parse(gh(["api", `repos/${repo}/releases/${releaseId}`]));
if (!release.prerelease) throw new Error("Shared resources must use prerelease to stay excluded from application Latest");
function remoteAssets() {
  return JSON.parse(gh(["api", `repos/${repo}/releases/${release.id}/assets?per_page=100`, "--paginate", "--slurp"])).flat();
}
function matches(asset, file) {
  if (asset.state !== "uploaded" || asset.size !== file.size || asset.digest !== file.digest) throw new Error(`Immutable asset differs: ${file.name}. Use a new resourceVersion; never overwrite published bytes.`);
}
const existing = new Map(remoteAssets().map(asset => [asset.name, asset]));
for (const file of [...files, index]) if (existing.has(file.name)) matches(existing.get(file.name), file);
async function upload(file) {
  if (existing.has(file.name)) { console.log(`Reusing ${file.name}`); return; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Uploading ${file.name} (${file.size} bytes), attempt ${attempt}`);
    const code = await new Promise((resolve, reject) => {
      const child = spawn("gh", ["release", "upload", tag, file.file, "--repo", repo], { stdio: "inherit", windowsHide: true });
      child.on("error", reject); child.on("close", resolve);
    });
    const asset = remoteAssets().find(asset => asset.name === file.name);
    if (asset) { matches(asset, file); console.log(`Uploaded and verified ${file.name}`); return; }
    if (attempt === 3) throw new Error(`Upload failed (${code}): ${file.name}; rerun to reuse completed assets`);
  }
}
for (let i = 0; i < files.length; i += 2) {
  const results = await Promise.allSettled(files.slice(i, i + 2).map(upload));
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
// Publish the index only after all immutable parts have been verified.
await upload(index);
console.log(`Verified resources uploaded to ${tag}; draft=${release.draft}. Publication state unchanged.`);
