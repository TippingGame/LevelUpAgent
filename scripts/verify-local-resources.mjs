import assert from "node:assert/strict";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

// Runs inside the isolated Tauri fixture used by verify-desktop.mjs. Dialog
// results are supplied deterministically; import, clipboard, drafts and tools
// still cross the real IPC boundary and use the real filesystem/database.
export async function verifyLocalResources({ page, invoke, output, workspace, until, search, openResult }) {
  const selected = resolve(output, "selected resources");
  const folder = resolve(selected, "selected folder");
  const clipboardFolder = resolve(selected, "pasted folder");
  const referencedFolder = resolve(workspace, "referenced-folder");
  await Promise.all([folder, clipboardFolder, referencedFolder].map((path) => mkdir(path, { recursive: true })));
  await mkdir(resolve(folder, "nested"), { recursive: true });
  await writeFile(resolve(folder, "nested", "Dockerfile"), "local-resource-secret-content\n");
  const files = [resolve(selected, "opaque.unrecognized"), resolve(selected, "NO_EXTENSION"), resolve(selected, "large.unknown")];
  await writeFile(files[0], Buffer.from([0, 255, 1, 2]));
  await writeFile(files[1], "");
  const large = await open(files[2], "w");
  try { await large.truncate(64 * 1024 * 1024 + 1); } finally { await large.close(); }
  const dropped = resolve(selected, "dropped.custom");
  const typed = resolve(selected, "typed.custom");
  await Promise.all([dropped, typed].map((path) => writeFile(path, "path resource")));

  const chips = page.locator(".composer-attachments .attachment-chip");
  const input = page.locator(".composer textarea");
  const count = async (number) => until(async () => await chips.count() === number && !await input.isDisabled());
  await page.evaluate(({ files, folder }) => {
    const original = window.fetch;
    const dialogUrl = window.__TAURI_INTERNALS__.convertFileSrc("plugin:dialog|open", "ipc");
    const clipboardUrl = window.__TAURI_INTERNALS__.convertFileSrc("read_clipboard_resource_paths", "ipc");
    window.__resourceQA = { original, dialogs: [], files, folder, completeDialog: null, clipboardOverride: false };
    const reply = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } });
    window.fetch = (url, options) => {
      const state = window.__resourceQA;
      if (String(url) === dialogUrl) {
        const args = JSON.parse(options.body);
        state.dialogs.push(args.options);
        if (args.options.directory) return Promise.resolve(reply([state.folder]));
        return new Promise((resolve) => { state.completeDialog = () => resolve(reply(state.files)); });
      }
      if (String(url) === clipboardUrl && state.clipboardOverride) return Promise.resolve(reply([]));
      return original(url, options);
    };
  }, { files, folder });
  try {
    await page.getByRole("button", { name: "Add files", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__resourceQA.completeDialog));
    await search("QA catalog 204");
    await page.getByRole("option").filter({ has: page.getByText("QA catalog 204", { exact: true }) }).click();
    await page.getByRole("dialog", { name: "Search and commands" }).waitFor({ state: "hidden" });
    await page.evaluate(() => window.__resourceQA.completeDialog());
    await count(0);
    const draft = await until(async () => {
      const draft = await invoke("get_composer_draft", { threadId: "qa-catalog-000" });
      return draft.attachments.length === 3 && draft;
    });
    assert.deepEqual(draft.attachments.map((item) => item.kind), ["file", "file", "file"]);
    assert.ok(draft.attachments.some((item) => item.sizeBytes > 64 * 1024 * 1024));
    await search("native-search-hidden-token");
    await openResult("QA catalog 0");
    await count(3);
    await page.getByRole("button", { name: "Add folder", exact: true }).click();
    await count(4);
    const dialogs = await page.evaluate(() => window.__resourceQA.dialogs);
    assert.equal(dialogs[0].directory, false);
    assert.equal(dialogs[0].multiple, true);
    assert.equal(dialogs[0].filters, undefined, "All Files has no extension whitelist");
    assert.equal(dialogs[1].directory, true);
    await chips.filter({ hasText: "selected folder" }).hover();
    await page.getByRole("tooltip").getByText(/nested\//).waitFor();
    await input.click();
    await writeFile(resolve(folder, "fresh-entry.custom"), "new entry");
    await chips.filter({ hasText: "selected folder" }).hover();
    await page.getByRole("tooltip").getByText(/fresh-entry\.custom/).waitFor();
    await input.click();

    await withClipboardFolder(clipboardFolder, async () => {
      const paths = await invoke("read_clipboard_resource_paths");
      assert.ok(paths.includes(clipboardFolder));
      await input.press("Control+v");
      await count(5);
      assert.equal(await input.evaluate((element) => document.activeElement === element), true, "Pasting resources keeps the composer ready for typing");
    });
    await input.fill("@referenced");
    await page.getByRole("option").filter({ hasText: "referenced-folder" }).click();
    await count(6);
    assert.match(await input.inputValue(), /levelup-file:referenced-folder/);
    await invoke("plugin:event|emit", { event: "tauri://drag-drop", payload: { paths: [dropped, folder], position: { x: 800, y: 700 } } });
    await count(7);

    await page.evaluate(() => { window.__resourceQA.clipboardOverride = true; });
    await input.evaluate((element) => {
      const data = new DataTransfer();
      for (let index = 0; index < 13; index++) data.items.add(new File([new Uint8Array([0, 255, 42])], `pasted-${index}.unknown`, { type: "application/octet-stream" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await count(20);
    await page.evaluate(() => { window.__resourceQA.clipboardOverride = false; });

    const capacityFiles = Array.from({ length: 80 }, (_, index) => resolve(selected, `capacity-${index}.${index < 70 ? "custom" : "png"}`));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==", "base64");
    await Promise.all(capacityFiles.map((path, index) => writeFile(path, index < 70 ? "capacity fixture" : png)));
    await invoke("plugin:event|emit", { event: "tauri://drag-drop", payload: { paths: capacityFiles.slice(0, 3), position: { x: 800, y: 700 } } });
    await count(23);
    await page.evaluate((paths) => { window.__resourceQA.files = paths; window.__resourceQA.completeDialog = null; }, [files[1], ...capacityFiles.slice(3)]);
    await page.getByRole("button", { name: "Add files", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__resourceQA.completeDialog));
    await page.evaluate(() => window.__resourceQA.completeDialog());
    await count(100);

    const clipboardFiles = Array.from({ length: 13 }, (_, index) => resolve(selected, `clipboard-${index}.custom`));
    await Promise.all(clipboardFiles.map((path) => writeFile(path, "clipboard fixture")));
    await withClipboardFolder([folder, ...clipboardFiles], async () => {
      assert.equal((await invoke("read_clipboard_resource_paths")).length, 14);
      await input.click();
      await input.press("Control+v");
      await count(113);
    });

    await page.getByRole("button", { name: "Remove opaque.unrecognized", exact: true }).click();
    await count(112);
    assert.equal((await stat(files[0])).size, 4, "Removing a reference preserves the original");
    await until(async () => (await invoke("get_composer_draft", { threadId: "qa-catalog-000" })).attachments.length === 112);
  } finally {
    await page.evaluate(() => {
      if (window.__resourceQA) window.fetch = window.__resourceQA.original;
      delete window.__resourceQA;
    });
  }
  await page.reload();
  await count(112);
  await page.screenshot({ path: resolve(output, "native-local-resources.png") });
  await input.fill(`LOCAL_RESOURCE_QA: Read the Dockerfile inside the attached selected folder. Also reference "${typed}".`);
  await input.press("Enter");
  await page.locator(".assistant-message-content").getByText("Local resource read complete.", { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
  const saved = await until(async () => {
    const thread = await invoke("get_thread", { threadId: "qa-catalog-000" });
    return thread.messages.some((item) => item.role === "tool" && item.content.includes("local-resource-secret-content")) && thread;
  });
  const user = saved.messages.filter((item) => item.role === "user").at(-1);
  assert.equal(user.attachments.length, 113);
  assert.equal(user.attachments.filter((item) => item.kind === "folder").length, 3);
  assert.equal(user.attachments.filter((item) => item.kind === "image").length, 10);
  const denied = await invoke("execute_tool", { request: {
    name: "read_file", arguments: { path: typed }, workspace, threadId: "qa-catalog-204", mode: "agent", permissionLevel: "agent",
  } });
  assert.equal(denied.isError, true, "Another conversation cannot use this resource grant");
  return ["All Files and folder selection", "picker result stays in original conversation", "native Explorer folder paste and composer focus", "@ directory reference", "file and folder drag with deduplication", "generic clipboard bytes", "reference deletion preserves source", "resource drafts survive reload", "typed file path becomes a reference", "real agent reads an attached external folder with scoped access", "live folder previews refresh", "113 attachments including 10 images survive import, draft reload and sending", "native Explorer paste accepts more than 12 files", "clipboard reads retry temporary contention"];
}

async function withClipboardFolder(path, run) {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ResourceQaClipboardLock {
  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
}
'@
$resourceQaPrevious = [System.Windows.Forms.Clipboard]::GetDataObject()
$resourceQaLocked = $false
try {
  $resourceQaPaths = New-Object System.Collections.Specialized.StringCollection
  foreach ($resourceQaPath in (ConvertFrom-Json $env:LEVELUP_RESOURCE_QA_CLIPBOARD)) { [void]$resourceQaPaths.Add($resourceQaPath) }
  [System.Windows.Forms.Clipboard]::SetFileDropList($resourceQaPaths)
  $resourceQaLocked = [ResourceQaClipboardLock]::OpenClipboard([IntPtr]::Zero)
  if (-not $resourceQaLocked) { throw 'Could not create clipboard contention fixture' }
  [Console]::WriteLine('READY')
  Start-Sleep -Milliseconds 200
  [void][ResourceQaClipboardLock]::CloseClipboard()
  $resourceQaLocked = $false
  [void][Console]::ReadLine()
} finally {
  if ($resourceQaLocked) { [void][ResourceQaClipboardLock]::CloseClipboard() }
  if ($null -ne $resourceQaPrevious) { [System.Windows.Forms.Clipboard]::SetDataObject($resourceQaPrevious, $true) }
  else { [System.Windows.Forms.Clipboard]::Clear() }
}`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
    windowsHide: true, env: { ...process.env, LEVELUP_RESOURCE_QA_CLIPBOARD: JSON.stringify(Array.isArray(path) ? path : [path]) }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Clipboard fixture exited ${code}`)));
  });
  try {
    await Promise.race([new Promise((resolve) => child.stdout.on("data", (chunk) => { if (String(chunk).includes("READY")) resolve(); })), exited.then(() => { throw new Error("Clipboard fixture exited before ready"); })]);
    await run();
  } finally {
    child.stdin.end("\n");
    await exited;
  }
}
