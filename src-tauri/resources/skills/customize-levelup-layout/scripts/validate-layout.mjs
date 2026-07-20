#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const layoutPath = process.argv[2];
const themePath = process.argv[3];
if (!layoutPath) {
  console.error("Usage: node validate-layout.mjs <layout.json> [theme.levelup-theme]");
  process.exit(2);
}

const allowedSlots = new Set(["sidebar", "workspace", "mediaStudio", "inspector", "qq2007Titlebar", "qq2007Toolbar", "qq2007RightPanel", "qq2007Statusbar"]);
const allowedActions = new Set(["state.set", "state.toggle", "thread.new", "thread.activate", "project.open", "view.chat", "view.media", "panel.toggle", "dialog.settings", "dialog.themes", "dialog.extensions", "dialog.skills", "dialog.logs", "app.website", "app.locale.toggle", "balance.refresh", "window.minimize", "window.toggleMaximize", "window.close"]);
const nodeTypes = new Set(["container", "slot", "text", "button", "image", "icon", "input", "repeat", "spacer"]);
const icons = new Set(["activity", "bot", "check", "chevron-down", "chevron-right", "alert", "cpu", "external", "folder", "folder-open", "media", "language", "message", "panel-close", "panel-open", "plus", "search", "settings", "shield", "sparkles", "close"]);
const token = /^[A-Za-z0-9_-]+$/;

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0 || bytes.length > 512 * 1024) fail("layout must contain 1 byte to 512 KiB");
  return JSON.parse(bytes.toString("utf8"));
}

function validateCondition(condition, label) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) fail(`${label} must be an object`);
  if (typeof condition.path === "string") return;
  if (Array.isArray(condition.all) && condition.all.length) return condition.all.forEach((item) => validateCondition(item, label));
  if (Array.isArray(condition.any) && condition.any.length) return condition.any.forEach((item) => validateCondition(item, label));
  if (condition.not) return validateCondition(condition.not, label);
  fail(`${label} must use path, all, any, or not`);
}

let nodeCount = 0;
const slots = new Set();
const actions = new Set();
function validateNode(node, depth = 0, conditionalAncestor = false, repeated = false) {
  if (!node || typeof node !== "object" || Array.isArray(node)) fail("every layout node must be an object");
  if (++nodeCount > 512 || depth > 32) fail("layout exceeds node or nesting limits");
  if (!nodeTypes.has(node.type)) fail(`unknown node type: ${node.type}`);
  if (node.id && !token.test(node.id)) fail(`invalid node id: ${node.id}`);
  if (node.className && (!Array.isArray(node.className) || node.className.some((item) => typeof item !== "string" || !token.test(item)))) fail("className must contain safe class tokens");
  if (node.when) validateCondition(node.when, "when");
  const conditional = conditionalAncestor || Boolean(node.when);
  if (node.type === "container" || node.type === "repeat") {
    if (!Array.isArray(node.children)) fail(`${node.type} requires children`);
    node.children.forEach((child) => validateNode(child, depth + 1, conditional, repeated || node.type === "repeat"));
  }
  if (node.type === "repeat" && node.empty) node.empty.forEach((child) => validateNode(child, depth + 1, conditional, repeated));
  if (node.type === "slot") {
    if (!allowedSlots.has(node.slot)) fail(`unknown slot: ${node.slot}`);
    if (slots.has(node.slot)) fail(`duplicate slot: ${node.slot}`);
    slots.add(node.slot);
    if (node.slot === "workspace" && (conditional || repeated)) fail("workspace cannot be conditional or repeated");
  }
  if (node.type === "button") {
    if (!node.action || !allowedActions.has(node.action.name)) fail(`unknown button action: ${node.action?.name}`);
    actions.add(node.action.name);
    if (node.icon && !icons.has(node.icon)) fail(`unknown button icon: ${node.icon}`);
    if (node.activeWhen) validateCondition(node.activeWhen, "activeWhen");
    if (node.disabledWhen) validateCondition(node.disabledWhen, "disabledWhen");
    if (node.children) node.children.forEach((child) => validateNode(child, depth + 1, conditional, repeated));
  }
  if (node.type === "icon" && !icons.has(node.name)) fail(`unknown icon: ${node.name}`);
  if (node.type === "image" && (typeof node.source !== "string" || (!node.source.startsWith("/") && !node.source.startsWith("data:image/")))) fail("image source must be app-relative or embedded");
}

const layout = readJson(layoutPath);
if (layout.schemaVersion !== 1) fail("layout schemaVersion must be 1");
if (typeof layout.id !== "string" || !token.test(layout.id)) fail("layout id is invalid");
if (!layout.root || layout.root.type !== "container") fail("layout root must be a container");
validateNode(layout.root);
if (!slots.has("workspace")) fail("layout must include the workspace slot");
if (layout.window?.decorations === false && !slots.has("qq2007Titlebar") && !["window.minimize", "window.toggleMaximize", "window.close"].every((action) => actions.has(action))) fail("undecorated layouts require minimize, maximize, and close controls");

if (themePath) {
  const theme = JSON.parse(fs.readFileSync(themePath, "utf8"));
  if (theme.schemaVersion !== 2) fail("custom-layout theme schemaVersion must be 2");
  if (theme.layoutFile !== path.basename(layoutPath)) fail(`theme layoutFile must equal ${path.basename(layoutPath)}`);
  if (typeof theme.css !== "string" || !theme.css.includes(`[data-levelup-theme="${theme.id}"]`)) fail("theme CSS is not scoped to its id");
}

console.log(`OK ${layout.id}: ${nodeCount} nodes, ${slots.size} slots`);
