// Real browser regression for embedded GLB textures under the packaged app CSP.
// MODEL_PLAYWRIGHT_PACKAGE: optional absolute path to playwright/package.json.
// MODEL_BROWSER_EXECUTABLE: optional Chromium/Edge executable path.
// No model downloads, GPU inference, or private project files are required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(process.env.MODEL_PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require("playwright");
const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
const viewer = readFileSync(new URL("../public/model-viewer.min.js", import.meta.url));
// An embedded PNG and a UV-mapped triangle exercise GLTFLoader -> blob ->
// ImageBitmapLoader.fetch, which img-src alone does not authorize.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4r9Bg4PCAAYiBLAAovgXfoOvnvAAAAABJRU5ErkJggg==", "base64");
const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(uvs.buffer), png]);
const gltf = {
  asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
  buffers: [{ byteLength: binary.length }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: png.length }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" }],
  images: [{ bufferView: 2, mimeType: "image/png" }], textures: [{ source: 0 }],
  materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 }, doubleSided: true }],
};
function chunk(data, type, padding = 0) {
  const length = Math.ceil(data.length / 4) * 4;
  const result = Buffer.alloc(8 + length, padding);
  result.writeUInt32LE(length, 0); result.writeUInt32LE(type, 4); data.copy(result, 8);
  return result;
}
const chunks = Buffer.concat([chunk(Buffer.from(JSON.stringify(gltf)), 0x4e4f534a, 0x20), chunk(binary, 0x004e4942)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(chunks.length + 12, 8);
const model = Buffer.concat([header, chunks]);
const html = '<!doctype html><html><head><script type="module" src="/viewer.js"></script></head><body><model-viewer src="http://asset.localhost/model.glb" loading="eager"></model-viewer></body></html>';
const server = createServer((request, response) => {
  if (request.url === "/viewer.js") { response.setHeader("Content-Type", "text/javascript"); response.end(viewer); return; }
  const policy = request.url === "/blocked"
    ? config.app.security.csp.replace(/connect-src ([^;]+)/, (_, sources) => `connect-src ${sources.replace(/\bblob:/g, "")}`)
    : config.app.security.csp;
  response.setHeader("Content-Security-Policy", policy);
  response.setHeader("Content-Type", "text/html"); response.end(html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.MODEL_BROWSER_EXECUTABLE ? { executablePath: process.env.MODEL_BROWSER_EXECUTABLE } : {}) });
  for (const blocked of [true, false]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    // Serve the app-authorized asset host without changing the tested CSP.
    await page.route("http://asset.localhost/model.glb", route => route.fulfill({ body: model, contentType: "model/gltf-binary", headers: { "Access-Control-Allow-Origin": "*" } }));
    await page.goto(`http://127.0.0.1:${server.address().port}/${blocked ? "blocked" : "fixed"}`);
    await page.waitForFunction(() => document.querySelector("model-viewer")?.loaded);
    const hasTexture = await page.locator("model-viewer").evaluate(element => Boolean(element.model.materials[0].pbrMetallicRoughness.baseColorTexture.texture));
    assert.equal(hasTexture, !blocked, JSON.stringify(errors));
    if (blocked) assert.ok(errors.some(error => error.includes("connect-src") && error.includes("blob:")));
    else assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS: packaged CSP loads embedded GLB textures; missing blob permission reproduces white mesh.");
} finally { await browser?.close(); server.close(); }
