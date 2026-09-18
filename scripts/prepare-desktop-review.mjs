import { cp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("artifacts");
const frontend = resolve(output, "native-dist");
await mkdir(frontend, { recursive: true });
await cp(resolve("dist"), frontend, { recursive: true });
await writeFile(resolve(frontend, "review.html"), '<!doctype html><html><head><meta charset="utf-8"><title>LevelUpAgent Review</title></head><body><script src="review-init.js"></script></body></html>');
await writeFile(resolve(frontend, "review-init.js"), `
if (!localStorage.getItem("review-native-initialized")) {
  const profile = { id: "review-no-credential-20260918", name: "Local QA", baseUrl: "http://127.0.0.1:1450", model: "qa-model", protocol: "openai_chat", allowUnauthenticated: true, priority: 0, failoverEnabled: false };
  localStorage.setItem("levelup-agent.profiles.v1", JSON.stringify([profile]));
  localStorage.setItem("levelup-agent.active-profile.v1", profile.id);
  localStorage.setItem("levelup-agent-locale", "en-US");
  localStorage.setItem("review-native-initialized", "1");
}
location.replace("index.html");
`);
await writeFile(resolve(output, "tauri.review.json"), JSON.stringify({
  productName: "LevelUpAgent Review",
  identifier: "com.levelup.agent.review20260918",
  build: { beforeBuildCommand: "", frontendDist: "../artifacts/native-dist" },
  app: { windows: [{ label: "main", title: "LevelUpAgent Review", url: "review.html", width: 1440, height: 920, minWidth: 720, minHeight: 560 }] },
  bundle: { active: false },
}, null, 2));
console.log("Prepared isolated desktop fixture: artifacts/tauri.review.json");
