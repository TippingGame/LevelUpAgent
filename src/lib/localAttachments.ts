const PATH_START = String.raw`(?:file://|[a-z]:[\\/]|\\\\|/(?!/)|\.{1,2}[\\/])`;
const PATH_PREFIX = new RegExp(`^${PATH_START}`, "i");

export interface LocalAttachmentPath {
  path: string;
  exact: boolean;
}

export function localAttachmentPaths(text: string): LocalAttachmentPath[] {
  const paths: Array<LocalAttachmentPath & { index: number }> = [];
  const excludedRanges: Array<[number, number]> = [];
  const quoted = /"([^"\r\n]+)"|(?<!\w)'([^'\r\n]+)'|`([^`\r\n]+)`|\u201c([^\u201d\r\n]+)\u201d|\u2018([^\u2019\r\n]+)\u2019/g;
  for (const match of text.matchAll(quoted)) {
    const path = match.slice(1).find((value) => value !== undefined)!.trim();
    excludedRanges.push([match.index!, match.index! + match[0].length]);
    if (PATH_PREFIX.test(path)) paths.push({ path, exact: true, index: match.index! });
  }
  for (const match of text.matchAll(/\b(?!file:)[a-z][a-z\d+.-]*:\/\/[^\s<>"`]+/gi)) {
    excludedRanges.push([match.index!, match.index! + match[0].length]);
  }
  const fileUrlRanges = [...text.matchAll(/\bfile:\/\/[^\s<>"`]+/gi)]
    .map((match) => [match.index!, match.index! + match[0].length]);
  const starts = [...text.matchAll(new RegExp(`(?:^|[\\s("'\x60<\\[:\u201c\u2018\uFF1A])(${PATH_START})`, "gim"))]
    .map((match) => match.index! + match[0].length - match[1].length)
    .filter((index) => !excludedRanges.some(([start, end]) => index >= start && index < end)
      && !fileUrlRanges.some(([start, end]) => index > start && index < end));
  for (const [offset, start] of starts.entries()) {
    let end = starts[offset + 1] ?? text.length;
    for (const [excludedStart] of excludedRanges) {
      if (excludedStart > start) end = Math.min(end, excludedStart);
    }
    const remainder = text.slice(start, end);
    const delimiter = remainder.search(/[\r\n"`<>|,;!?\u201c\u201d\u2018\u2019\uFF0C\u3002\uFF1B\uFF01\uFF1F]/);
    let path = (delimiter < 0 ? remainder : remainder.slice(0, delimiter)).trim();
    // Keep balanced parentheses in filenames, but remove Markdown wrappers.
    for (const [open, close] of [["(", ")"], ["[", "]"]]) {
      let depth = 0;
      for (let index = 0; index < path.length; index += 1) {
        if (path[index] === open) depth += 1;
        if (path[index] === close && --depth < 0) { path = path.slice(0, index).trim(); break; }
      }
    }
    if (path) paths.push({ path, exact: false, index: start });
  }
  const unique = new Map<string, LocalAttachmentPath>();
  for (const { path, exact } of paths.sort((left, right) => left.index - right.index)) {
    const previous = unique.get(path);
    unique.set(path, { path, exact: exact || previous?.exact === true });
  }
  return [...unique.values()];
}
