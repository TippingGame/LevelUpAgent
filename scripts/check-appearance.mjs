import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import ts from "typescript";

const colorProperties = /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|--[\w-]+)$/i;

// Neutral UI ink/paper is the common source of light-only interfaces. Brand
// colors, translucent decoration and image/canvas data are a separate review.
function isNeutral(channels, alpha = 1) {
  return alpha > .35 && Math.max(...channels) - Math.min(...channels) <= 65;
}

export function fixedNeutrals(value) {
  const found = [];
  valueParser(value).walk(node => {
    if (node.type === "function") {
      if (/^(?:url|var)$/i.test(node.value)) return false;
      if (/^rgba?$/i.test(node.value)) {
        const values = valueParser.stringify(node.nodes).match(/[\d.]+%?/g) ?? [];
        const channels = values.slice(0, 3).map(v => parseFloat(v) * (v.endsWith("%") ? 2.55 : 1));
        const alpha = values[3] ? parseFloat(values[3]) / (values[3].endsWith("%") ? 100 : 1) : 1;
        if (channels.length === 3 && isNeutral(channels, alpha)) found.push(valueParser.stringify(node));
        return false;
      }
      if (/^hsla?$/i.test(node.value)) {
        const values = valueParser.stringify(node.nodes).match(/[\d.]+%?/g) ?? [];
        const alpha = values[3] ? parseFloat(values[3]) / (values[3].endsWith("%") ? 100 : 1) : 1;
        if (parseFloat(values[1]) <= 25 && alpha > .35) found.push(valueParser.stringify(node));
        return false;
      }
    }
    if (node.type !== "word") return;
    if (/^(?:white|black|gray|grey|silver|gainsboro|whitesmoke|slategray|slategrey|lightslategray|lightslategrey|darkgray|darkgrey|lightgray|lightgrey|dimgray|dimgrey)$/i.test(node.value)) found.push(node.value);
    if (!/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(node.value)) return;
    let hex = node.value.slice(1);
    if (hex.length <= 4) hex = [...hex].map(c => c + c).join("");
    const channels = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    if (isNeutral(channels, alpha)) found.push(node.value);
  });
  return found;
}

function explicitTheme(rule) {
  for (let node = rule; node; node = node.parent) {
    if (node.type === "atrule" && node.name === "media" && /prefers-color-scheme:\s*dark/.test(node.params)) return true;
  }
  return rule.type === "rule" && rule.selectors.every(selector => /:root|\.armor-mode\b|\[data-levelup-theme[=\]]/.test(selector));
}

function reviewed(node) {
  const previous = node.prev();
  return previous?.type === "comment" && /^appearance-allow:\s*\S.{12,}/.test(previous.text);
}

export function inspectCss(source, filename = "fixture.css") {
  const issues = [];
  postcss.parse(source, { from: filename }).walkDecls(decl => {
    if (explicitTheme(decl.parent) || reviewed(decl) || reviewed(decl.parent)) return;
    if (decl.prop === "color-scheme" && decl.value === "light") {
      issues.push({ line: decl.source.start.line, message: `${decl.parent.selector}: color-scheme: light` });
    } else if (colorProperties.test(decl.prop) && fixedNeutrals(decl.value).length) {
      issues.push({ line: decl.source.start.line, message: `${decl.parent.selector}: ${decl.prop}: ${decl.value}` });
    }
  });
  return issues;
}

export function inspectTsx(source, filename = "fixture.tsx") {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const issues = [];
  function visit(node) {
    let value;
    if (ts.isJsxAttribute(node) && /^(?:color|fill|stroke|bgcolor)$/.test(node.name.getText(file))) value = node.initializer;
    if (ts.isPropertyAssignment(node) && /^(?:color|background|backgroundColor|borderColor|fill|stroke)$/.test(node.name.getText(file).replace(/["']/g, ""))) value = node.initializer;
    if (value && ts.isJsxExpression(value)) value = value.expression;
    if (value && ts.isStringLiteralLike(value) && fixedNeutrals(value.text).length) {
      const preceding = source.slice(Math.max(0, node.getFullStart() - 180), node.getStart(file));
      if (!/appearance-allow:\s*[^\n]{13,}/.test(preceding)) issues.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, message: `Fixed inline color: ${value.text}` });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return issues;
}

export function appearanceFindings(root) {
  const issues = [];
  for (const name of readdirSync(path.join(root, "src"), { recursive: true }).filter(f => /\.(?:css|tsx)$/.test(f)).sort()) {
    const file = `src/${name.replaceAll("\\", "/")}`;
    // The fixed cyber skin and its preview screen intentionally own a palette.
    if (file === "src/ArmorStudio.css") continue;
    const source = readFileSync(path.join(root, file), "utf8");
    const problems = file.endsWith(".css") ? inspectCss(source, file) : inspectTsx(source, file);
    for (const issue of problems) issues.push({ file, ...issue, key: issue.message.replace(/\s+/g, " ") });
  }
  return issues;
}

export function compareBaseline(issues, baseline) {
  const remaining = structuredClone(baseline);
  const unexpected = issues.filter(issue => {
    if (remaining[issue.file]?.[issue.key] > 0) {
      remaining[issue.file][issue.key]--;
      return false;
    }
    return true;
  });
  // Removing a legacy declaration must remove its exemption too, so it cannot
  // silently return later. Exemptions match content, never shifting line numbers.
  for (const [file, keys] of Object.entries(remaining)) {
    for (const [key, count] of Object.entries(keys)) if (count > 0) unexpected.push({ file, line: 1, message: `Remove obsolete appearance baseline entry: ${key}` });
  }
  return unexpected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = JSON.parse(readFileSync(new URL("./appearance-baseline.json", import.meta.url), "utf8"));
  const issues = compareBaseline(appearanceFindings(fileURLToPath(new URL("../", import.meta.url))), baseline);
  for (const issue of issues) console.error(`${issue.file}:${issue.line} ${issue.message}`);
  if (issues.length) {
    console.error(`${issues.length} appearance issue(s). Use semantic tokens; document deliberate asset/brand colors with appearance-allow: <reason>. See docs/UI_APPEARANCE.md.`);
    process.exitCode = 1;
  } else console.log("Appearance guard passed: no new fixed neutral UI colors or light-only schemes.");
}
