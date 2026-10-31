/** Larger inputs get a one-line summary instead of a line diff, to bound memory. */
const MAX_DIFF_CELLS = 4_000_000;

/** A unified line diff (`-` removed, `+` added) with `context` unchanged lines around each change. */
export function unifiedDiff(before: string, after: string, { context = 3, maxLines = 120 } = {}): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === after) return [];
  if (a.length * b.length > MAX_DIFF_CELLS) return [`(${a.length} lines → ${b.length} lines; too large to diff)`];

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const ops: Array<{ kind: " " | "-" | "+"; text: string; oldLine: number; newLine: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ kind: " ", text: a[i], oldLine: i++, newLine: j++ });
    else if (i < a.length && (j === b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) ops.push({ kind: "-", text: a[i], oldLine: i++, newLine: j });
    else ops.push({ kind: "+", text: b[j], oldLine: i, newLine: j++ });
  }

  const keep = ops.map(() => false);
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = true;
  });

  const lines: string[] = [];
  for (let start = 0; start < ops.length; start++) {
    if (!keep[start]) continue;
    let end = start;
    while (end + 1 < ops.length && keep[end + 1]) end++;
    const hunk = ops.slice(start, end + 1);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    lines.push(`@@ -${hunk[0].oldLine + 1},${oldCount} +${hunk[0].newLine + 1},${newCount} @@`);
    for (const op of hunk) lines.push(`${op.kind}${op.text}`);
    start = end;
  }

  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more diff lines`];
  return lines;
}
