import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const levelUpApi = resolve(process.argv[2] ?? resolve(root, "..", "..", "levelup2api", "LevelUpAPI"));
const backend = resolve(levelUpApi, "backend");

if (!existsSync(resolve(backend, "go.mod"))) {
  throw new Error(`LevelUpAPI backend was not found at ${backend}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

console.log(`Verifying LevelUpAPI gateway contracts at ${levelUpApi}`);
run("go", ["test", "-tags", "unit", "./internal/handler", "./internal/server/routes"], backend);
run(
  "cargo",
  ["test", "levelup_api_four_protocol_request_contracts"],
  resolve(root, "src-tauri"),
);
console.log("LevelUpAPI Responses, Chat Completions, Messages, and Gemini contracts passed.");

