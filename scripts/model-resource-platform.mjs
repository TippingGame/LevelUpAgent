import fs from "node:fs";
import path from "node:path";

// Publishing is explicit: it may run on a different host from the target.
// Keep the historical Linux default for the existing self-hosted workflow.
export function modelResourcePlatform(root, platform = "linux") {
  const targets = {
    linux: { spec: "resources.json", target: "linux-x64-cu118", archive: "tar" },
    windows: { spec: "resources-windows.json", target: "windows-x64-cu118", archive: "zip" },
  };
  if (!Object.hasOwn(targets, platform)) throw new Error(`Unsupported 3D resource platform: ${platform}`);
  const target = targets[platform];
  const spec = JSON.parse(fs.readFileSync(path.join(root, "modules/model_workbench", target.spec), "utf8"));
  if (spec.target !== target.target) throw new Error(`Resource target mismatch for ${platform}`);
  return { spec, archive: target.archive };
}
