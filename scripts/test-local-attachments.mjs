import assert from "node:assert/strict";
import test from "node:test";
import { localAttachmentPaths } from "../src/lib/localAttachments.ts";

const candidate = (path, exact = false) => ({ path, exact });

test("Chinese Windows paths and spaces are recognized as local attachment inputs", () => {
  const path = "F:\\AI\\flower\\\u84dd\u8393.png";
  assert.deepEqual(localAttachmentPaths(path), [candidate(path)]);
  assert.deepEqual(localAttachmentPaths(`\u5904\u7406\u8fd9\u5f20\u56fe\uff1a${path}\uff0c\u4fdd\u7559\u539f\u56fe`), [candidate(path)]);
  assert.deepEqual(localAttachmentPaths('Use "F:\\my images\\image.png backup.png" for the edit'), [candidate("F:\\my images\\image.png backup.png", true)]);
  assert.deepEqual(localAttachmentPaths("F:\\my images\\original picture.png"), [candidate("F:\\my images\\original picture.png")]);
  assert.deepEqual(localAttachmentPaths('Here\'s the image: "F:\\O\'Brien\\picture.png"'), [candidate("F:\\O'Brien\\picture.png", true)]);
});

test("quoted paths, file URLs, relative paths, and Unix paths keep reference order", () => {
  const paths = ["/tmp/first.png", "F:/images/second.png", "file:///C:/my%20images/third.png", "./fourth.png", "../assets/fifth.webp"];
  assert.deepEqual(localAttachmentPaths(`${paths[0]}\n\u201c${paths[1]}\u201d\n${paths[2]}\n${paths[3]}\n${paths[4]}`), paths.map((path, index) => candidate(path, index === 1)));
  assert.deepEqual(localAttachmentPaths("[reference](F:/images/second.png)"), [candidate(paths[1])]);
  assert.deepEqual(localAttachmentPaths("`F:/images/second.png`"), [candidate(paths[1], true)]);
});

test("remote URLs and plain filenames are not auto attachments", () => {
  assert.deepEqual(localAttachmentPaths("https://example.com/image.png http://localhost/image.png example.png https://example.com/?file=/tmp/local.mp4"), []);
  assert.deepEqual(localAttachmentPaths('"https://example.com/image.png"'), []);
  assert.deepEqual(localAttachmentPaths("`https://example.com/file.zip` ftp://server/file.zip"), []);
});

test("repeated references are imported once without losing distinct files", () => {
  assert.deepEqual(localAttachmentPaths('F:/one.png\n"F:/one.png"\nF:/two.png'), [candidate("F:/one.png", true), candidate("F:/two.png")]);
  assert.deepEqual(localAttachmentPaths("\\\\server\\share\\reference.png"), [candidate("\\\\server\\share\\reference.png")]);
});

test("arbitrary extensions, dotfiles and extensionless paths are candidates", () => {
  const paths = ["C:\\Tools\\python.exe", "G:\\assets\\scene.blend", "G:\\art\\layer.psd", "./archive.tar.gz", "./voice.mp3", "./clip.mp4", "./data.custom", "./Dockerfile", "./.env", "/home/project"];
  assert.deepEqual(localAttachmentPaths(paths.join("\n")), paths.map((path) => candidate(path)));
});

test("unquoted prose is resolved against real filenames while quoted paths remain exact", () => {
  assert.deepEqual(localAttachmentPaths("Use F:/my files/data.custom for analysis"), [candidate("F:/my files/data.custom for analysis")]);
  assert.deepEqual(localAttachmentPaths('Use "F:/my files/data.custom for analysis"'), [candidate("F:/my files/data.custom for analysis", true)]);
  assert.deepEqual(localAttachmentPaths("Compare F:/first.data with F:/second.data"), [candidate("F:/first.data with"), candidate("F:/second.data")]);
  assert.deepEqual(localAttachmentPaths("[archive](F:/my files/archive (2).zip)"), [candidate("F:/my files/archive (2).zip")]);
  assert.deepEqual(localAttachmentPaths('"F:/my files/a,b;[2].custom"'), [candidate("F:/my files/a,b;[2].custom", true)]);
});
