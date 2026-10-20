// Unified-diff generation (zero dependencies).
// Used so users can review exactly what a proposed or direct edit changes
// before it is applied. Purely local computation - no file access here.

const DEFAULT_MAX_LINES = 1500;
const DEFAULT_CONTEXT = 3;

/** Splits text into lines, tolerating CRLF and a trailing newline. */
export function splitLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

function middleOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((l) => ({ t: '+', l }));
  if (m === 0) return a.map((l) => ({ t: '-', l }));

  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', l: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ t: '-', l: a[i] });
      i++;
    } else {
      ops.push({ t: '+', l: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', l: a[i++] });
  while (j < m) ops.push({ t: '+', l: b[j++] });
  return ops;
}

function diffOps(a, b) {
  // Trim the common prefix/suffix so the LCS table only covers changed lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', l: a[i] });
  ops.push(...middleOps(a.slice(start, endA), b.slice(start, endB)));
  for (let i = endA; i < a.length; i++) ops.push({ t: ' ', l: a[i] });
  return ops;
}

/**
 * Builds a unified diff between two strings.
 * Returns '' when the texts are identical, and a short header-only note when
 * the only difference is a trailing newline or line endings.
 */
export function unifiedDiff(oldText, newText, options = {}) {
  const {
    oldPath = 'original',
    newPath = 'updated',
    context = DEFAULT_CONTEXT,
    maxLines = DEFAULT_MAX_LINES,
  } = options;

  if (oldText === newText) return '';
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    throw new TypeError('unifiedDiff expects string inputs.');
  }

  const header = `--- a/${oldPath}\n+++ b/${newPath}\n`;
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length > maxLines || b.length > maxLines) {
    return `${header}@@ file is too large for a line-by-line diff (${a.length} -> ${b.length} lines) @@\n`;
  }

  const ops = diffOps(a, b);
  const changeIndices = [];
  ops.forEach((op, index) => {
    if (op.t !== ' ') changeIndices.push(index);
  });
  if (changeIndices.length === 0) {
    return `${header}@@ no line-level differences (trailing newline or line endings differ) @@\n`;
  }

  // Merge changed positions with their context into contiguous ranges.
  const ranges = [];
  for (const index of changeIndices) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  let out = header;
  let oldPos = 0;
  let newPos = 0;
  let scanned = 0;
  for (const range of ranges) {
    for (; scanned < range.from; scanned++) {
      const t = ops[scanned].t;
      if (t === ' ' || t === '-') oldPos++;
      if (t === ' ' || t === '+') newPos++;
    }
    const startOld = oldPos;
    const startNew = newPos;
    let oldCount = 0;
    let newCount = 0;
    const lines = [];
    for (let k = range.from; k <= range.to; k++) {
      const op = ops[k];
      lines.push(op.t + op.l);
      if (op.t === ' ' || op.t === '-') {
        oldPos++;
        oldCount++;
      }
      if (op.t === ' ' || op.t === '+') {
        newPos++;
        newCount++;
      }
    }
    scanned = range.to + 1;
    const headerOld = oldCount === 0 ? startOld : startOld + 1;
    const headerNew = newCount === 0 ? startNew : startNew + 1;
    out += `@@ -${headerOld},${oldCount} +${headerNew},${newCount} @@\n`;
    out += `${lines.join('\n')}\n`;
  }
  return out;
}
