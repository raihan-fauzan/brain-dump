// Note document format + Markdown checklist parsing.
// The stored artifact IS the .md file: one string, portable, human-readable.

export const PROCESSED_MARKER = "<!-- brain-dump:processed -->";

/** `2026-11-22-1041` — sortable, filesystem-safe, human-readable. */
export function makeNoteId(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function uniqueNoteId(taken, date = new Date()) {
  const base = makeNoteId(date);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** `2026-11-22-1041` -> `22 Nov 2026 · 10:41` */
export function noteTitle(id, opts = {}) {
  return formatTitle(id, Boolean(opts.seconds));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatTitle(id, withSeconds) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})?/.exec(id);
  if (!m) return id;
  const [, y, mo, d, h, mi, s] = m;
  const month = MONTHS[Number(mo) - 1] || mo;
  const base = `${Number(d)} ${month} ${y} · ${h}:${mi}`;
  return withSeconds && s ? `${base}:${s}` : base;
}

/**
 * Titles for a set of notes, with seconds added only where two notes share a
 * minute (so "two dumps in one minute" stays distinguishable in lists).
 * @param {string[]} ids
 * @returns {Map<string, string>}
 */
export function titlesFor(ids) {
  const minutes = new Map();
  const keyOf = (id) => /^(\d{4}-\d{2}-\d{2}-\d{4})/.exec(id)?.[1] ?? id;

  for (const id of ids) {
    const key = keyOf(id);
    minutes.set(key, (minutes.get(key) || 0) + 1);
  }

  const out = new Map();
  const seen = new Map();

  // Sorted so the "(2)" numbering is stable however the caller orders them.
  for (const id of [...ids].sort()) {
    let title = formatTitle(id, minutes.get(keyOf(id)) > 1);
    const n = (seen.get(title) || 0) + 1;
    seen.set(title, n);
    if (n > 1) title = `${title} (${n})`;
    out.set(id, title);
  }
  return out;
}

export function noteTimestamp(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})?/.exec(id);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).getTime();
}

// ---------- document assembly ----------

export function buildDocument(id, raw) {
  return `# ${noteTitle(id)}\n\n${raw.trim()}\n`;
}

/** Split a document into its immutable raw part and its replaceable processed part. */
export function splitDocument(doc) {
  const idx = doc.indexOf(PROCESSED_MARKER);
  if (idx === -1) {
    return { head: doc.replace(/\s+$/, ""), processed: null };
  }
  return {
    head: doc.slice(0, idx).replace(/\s+$/, ""),
    processed: doc.slice(idx + PROCESSED_MARKER.length).replace(/^\s*\n/, "").replace(/\s+$/, ""),
  };
}

/** Replace (or add) the processed section. Raw text is never touched. */
export function setProcessed(doc, output) {
  const { head } = splitDocument(doc);
  const body = output.trim();
  return `${head}\n\n${PROCESSED_MARKER}\n${body}\n`;
}

/** The raw dump text only — what gets sent to the LLM. */
export function rawDump(doc) {
  const head = splitDocument(doc).head;
  const lines = head.split("\n");
  // drop the leading "# Title" heading and following blank line
  if (lines[0]?.startsWith("# ")) lines.shift();
  while (lines.length && lines[0].trim() === "") lines.shift();
  return lines.join("\n").trim();
}

export function hasProcessed(doc) {
  return splitDocument(doc).processed !== null;
}

// ---------- checklist parsing ----------

const TASK_RE = /^(\s*)- \[([ xX/])\]\s+(.*)$/;

export function parseTaskLine(line) {
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const mark = m[2].toLowerCase();
  return {
    indent: m[1].length,
    done: mark === "x",
    later: mark === "/",
    text: m[3],
  };
}

/** All tasks in a document, with their line index for in-place toggling. */
export function extractTasks(doc) {
  const out = [];
  doc.split("\n").forEach((line, i) => {
    const t = parseTaskLine(line);
    if (t) out.push({ lineIndex: i, ...t });
  });
  return out;
}

export function taskStats(doc) {
  const tasks = extractTasks(doc);
  const done = tasks.filter((t) => t.done).length;
  const later = tasks.filter((t) => t.later && !t.done).length;
  const todo = tasks.length - done - later;
  // `open` is kept as an alias for "still to do" so the UI badge stays simple.
  return { total: tasks.length, todo, done, later, open: todo };
}

/** Set a task to todo / done / later. Returns the new document. */
export function setTaskState(doc, lineIndex, state) {
  const lines = doc.split("\n");
  const t = parseTaskLine(lines[lineIndex] ?? "");
  if (!t) return doc;
  const mark = state === "done" ? "x" : state === "later" ? "/" : " ";
  lines[lineIndex] = `${" ".repeat(t.indent)}- [${mark}] ${t.text}`;
  return lines.join("\n");
}

/** Flip `- [ ]` <-> `- [x]` on the given line. Returns the new document. */
export function toggleTask(doc, lineIndex) {
  const t = parseTaskLine(doc.split("\n")[lineIndex] ?? "");
  if (!t) return doc;
  return setTaskState(doc, lineIndex, t.done ? "todo" : "done");
}

/** Bullet lines under a `## <heading>` inside the processed part of a note. */
export function processedBullets(doc, heading) {
  const { processed } = splitDocument(doc);
  if (!processed) return [];
  const wanted = heading.trim().toLowerCase();
  const out = [];
  let inSection = false;

  for (const line of processed.split("\n")) {
    const h = /^##\s+(.*)$/.exec(line.trim());
    if (h) {
      inSection = h[1].trim().toLowerCase() === wanted;
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    out.push((bullet ? bullet[1] : trimmed).trim());
  }
  return out;
}

/** The extracted reference notes for a dump. */
export function referenceNotes(doc) {
  return processedBullets(doc, "Notes");
}

/** Strip a trailing processed section so a note can be re-processed cleanly. */
export function stripProcessed(doc) {
  return splitDocument(doc).head + "\n";
}

// ---------- summary for list rows ----------

export function noteSummary(doc, maxLen = 140) {
  const raw = rawDump(doc).replace(/\s+/g, " ").trim();
  if (!raw) return "(empty)";
  return raw.length > maxLen ? `${raw.slice(0, maxLen - 1)}…` : raw;
}

/** Leading title text used for grouping in the tasks view. */
export function documentTitle(doc) {
  const first = doc.split("\n", 1)[0] ?? "";
  return first.startsWith("# ") ? first.slice(2).trim() : "Untitled";
}
