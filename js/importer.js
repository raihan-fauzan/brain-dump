// Import planning: decide what a ZIP's files become, without touching storage.
// Pure so it can be tested and previewed before anything is written.

import { noteTitle, noteTimestamp } from "./note.js";

const decoder = new TextDecoder();

export function sanitizeId(name) {
  return String(name)
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
}

function uniqueId(taken, base) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Give a plain Markdown file the `# title` heading the app expects. */
export function ensureTitle(doc, id) {
  const trimmed = String(doc).replace(/^\uFEFF/, "").trim();
  if (/^#\s+\S/.test(trimmed)) return `${trimmed}\n`;
  return `# ${noteTitle(id)}\n\n${trimmed}\n`;
}

/**
 * Decide what an imported archive becomes.
 * @param {{name: string, data: Uint8Array}[]} entries files from readZip
 * @param {{id: string, doc: string}[]} existing notes already in storage
 * @param {number} [now] fallback timestamp
 * @returns {{adds: {id: string, doc: string, createdAt: number}[], skipped: number, renamed: number, ignored: number}}
 */
export function planImport(entries, existing = [], now = Date.now()) {
  const byId = new Map(existing.map((n) => [n.id, n]));
  const taken = new Set(byId.keys());
  // `known` also tracks what this archive has already planned, so two files with
  // the same name never collide with each other either.
  const known = new Map();
  for (const [id, note] of byId) known.set(id, { doc: note.doc });
  const adds = [];
  let skipped = 0;
  let renamed = 0;
  let ignored = 0;

  for (const entry of entries) {
    const fileName = String(entry.name || "").replace(/\\/g, "/").split("/").pop() || "";
    if (!/\.md$/i.test(fileName)) {
      ignored += 1;
      continue;
    }

    const baseId = sanitizeId(fileName);
    const text = decoder.decode(entry.data);
    if (!baseId || !text.trim()) {
      ignored += 1;
      continue;
    }

    const doc = ensureTitle(text, baseId);
    const createdAt = noteTimestamp(baseId) || now;
    const existingNote = known.get(baseId);

    if (!existingNote) {
      adds.push({ id: baseId, doc, createdAt });
      taken.add(baseId);
      known.set(baseId, { doc });
      continue;
    }

    if (existingNote.doc.trim() === doc.trim()) {
      skipped += 1;
      continue;
    }

    // Same name, different content: keep both rather than overwrite.
    const newId = uniqueId(taken, `${baseId}-imported`);
    const copyDoc = ensureTitle(text, newId);
    adds.push({ id: newId, doc: copyDoc, createdAt });
    taken.add(newId);
    known.set(newId, { doc: copyDoc });
    renamed += 1;
  }

  return { adds, skipped, renamed, ignored };
}

/** One-line summary for the settings screen. */
export function describePlan(result) {
  const parts = [`Imported ${result.adds.length}`];
  if (result.skipped) parts.push(`${result.skipped} already there`);
  if (result.renamed) parts.push(`${result.renamed} kept as a copy`);
  if (result.ignored) parts.push(`${result.ignored} skipped`);
  return `${parts.join(", ")}.`;
}
