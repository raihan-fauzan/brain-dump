import test from "node:test";
import assert from "node:assert/strict";

import {
  makeNoteId,
  uniqueNoteId,
  noteTitle,
  titlesFor,
  noteTimestamp,
  buildDocument,
  splitDocument,
  setProcessed,
  rawDump,
  hasProcessed,
  parseTaskLine,
  extractTasks,
  taskStats,
  toggleTask,
  stripProcessed,
  noteSummary,
  documentTitle,
  PROCESSED_MARKER,
  setTaskState,
  processedBullets,
  referenceNotes,
} from "../js/note.js";

const fixed = new Date(2026, 10, 22, 10, 41, 7);

test("makeNoteId is sortable and filesystem-safe", () => {
  assert.equal(makeNoteId(fixed), "2026-11-22-104107");
  assert.match(makeNoteId(fixed), /^\d{4}-\d{2}-\d{2}-\d{6}$/);
});

test("uniqueNoteId avoids collisions", () => {
  assert.equal(uniqueNoteId(new Set(), fixed), "2026-11-22-104107");
  assert.equal(uniqueNoteId(new Set(["2026-11-22-104107"]), fixed), "2026-11-22-104107-2");
  assert.equal(
    uniqueNoteId(new Set(["2026-11-22-104107", "2026-11-22-104107-2"]), fixed),
    "2026-11-22-104107-3",
  );
});

test("noteTitle and noteTimestamp round-trip", () => {
  assert.equal(noteTitle("2026-11-22-104107"), "22 Nov 2026 · 10:41");
  assert.equal(noteTimestamp("2026-11-22-104107"), fixed.getTime());
});

test("noteTitle can include seconds on request", () => {
  assert.equal(noteTitle("2026-11-22-104107", { seconds: true }), "22 Nov 2026 · 10:41:07");
  assert.equal(noteTitle("not-a-date"), "not-a-date");
});

test("titlesFor only adds seconds when a minute is shared", () => {
  const titles = titlesFor(["2026-11-22-104107", "2026-11-22-104115", "2026-11-22-123000"]);
  assert.equal(titles.get("2026-11-22-104107"), "22 Nov 2026 · 10:41:07");
  assert.equal(titles.get("2026-11-22-104115"), "22 Nov 2026 · 10:41:15");
  assert.equal(titles.get("2026-11-22-123000"), "22 Nov 2026 · 12:30", "lone note stays short");
});

test("titlesFor keeps distinct minutes short", () => {
  const titles = titlesFor(["2026-11-22-104107", "2026-11-22-104207"]);
  assert.equal(new Set(titles.values()).size, 2);
  assert.ok(!titles.get("2026-11-22-104107").endsWith(":07"));
});

test("titlesFor disambiguates dumps in the same second", () => {
  const titles = titlesFor(["2026-11-22-104107-2", "2026-11-22-104107"]);
  assert.equal(titles.get("2026-11-22-104107"), "22 Nov 2026 · 10:41:07");
  assert.equal(titles.get("2026-11-22-104107-2"), "22 Nov 2026 · 10:41:07 (2)");
  // numbering is stable regardless of input order
  const reversed = titlesFor(["2026-11-22-104107", "2026-11-22-104107-2"]);
  assert.equal(reversed.get("2026-11-22-104107-2"), "22 Nov 2026 · 10:41:07 (2)");
});

test("buildDocument puts raw text under a title", () => {
  const doc = buildDocument("2026-11-22-104107", "  call the dentist  ");
  assert.equal(doc, "# 22 Nov 2026 · 10:41\n\ncall the dentist\n");
});

test("rawDump returns only the original text", () => {
  const doc = buildDocument("2026-11-22-104107", "line one\nline two");
  assert.equal(rawDump(doc), "line one\nline two");
});

test("hasProcessed is false for a fresh note", () => {
  const doc = buildDocument("2026-11-22-104107", "dump");
  assert.equal(hasProcessed(doc), false);
  assert.equal(splitDocument(doc).processed, null);
});

test("setProcessed appends without touching the raw text", () => {
  const doc = buildDocument("2026-11-22-104107", "buy milk\ncall mum");
  const out = "## Tasks\n- [ ] buy milk\n\n## Notes\n- call mum";
  const next = setProcessed(doc, out);

  assert.equal(hasProcessed(next), true);
  assert.equal(rawDump(next), "buy milk\ncall mum");
  assert.equal(splitDocument(next).processed, out);
  assert.ok(next.includes(PROCESSED_MARKER));
});

test("setProcessed replaces an existing processed section", () => {
  const doc = setProcessed(buildDocument("2026-11-22-104107", "raw text"), "## Tasks\n- [ ] old");
  const next = setProcessed(doc, "## Tasks\n- [ ] new");
  assert.equal(splitDocument(next).processed, "## Tasks\n- [ ] new");
  assert.equal(rawDump(next), "raw text");
  assert.equal(next.split(PROCESSED_MARKER).length, 2, "only one marker");
});

test("repeated processing never duplicates raw text", () => {
  let doc = buildDocument("2026-11-22-104107", "unique raw payload");
  for (let i = 0; i < 5; i += 1) doc = setProcessed(doc, `## Tasks\n- [ ] task ${i}`);
  assert.equal(rawDump(doc), "unique raw payload");
  assert.equal(doc.match(/unique raw payload/g).length, 1);
});

test("stripProcessed keeps the raw text", () => {
  const doc = setProcessed(buildDocument("2026-11-22-104107", "keep me"), "## Tasks\n- [ ] x");
  assert.equal(rawDump(stripProcessed(doc)), "keep me");
  assert.equal(hasProcessed(stripProcessed(doc)), false);
});

test("parseTaskLine understands the three states", () => {
  assert.deepEqual(parseTaskLine("- [ ] todo"), { indent: 0, done: false, later: false, text: "todo" });
  assert.deepEqual(parseTaskLine("- [x] done"), { indent: 0, done: true, later: false, text: "done" });
  assert.deepEqual(parseTaskLine("- [/] later"), { indent: 0, done: false, later: true, text: "later" });
  assert.deepEqual(parseTaskLine("  - [X] upper"), { indent: 2, done: true, later: false, text: "upper" });
  assert.equal(parseTaskLine("- plain bullet"), null);
  assert.equal(parseTaskLine("just text"), null);
});

test("extractTasks reports line indices", () => {
  const doc = "# Title\n\nraw\n\n## Tasks\n- [ ] one\n- [x] two\n";
  const tasks = extractTasks(doc);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].text, "one");
  assert.equal(tasks[0].lineIndex, 5);
  assert.equal(tasks[1].done, true);
  assert.equal(doc.split("\n")[tasks[0].lineIndex], "- [ ] one");
});

test("toggleTask flips a task in place and leaves everything else alone", () => {
  const doc = "# T\n\nraw\n- [ ] one\n- [ ] two\n";
  const next = toggleTask(doc, 3);
  assert.equal(next, "# T\n\nraw\n- [x] one\n- [ ] two\n");
  assert.equal(toggleTask(next, 3), doc);
});

test("toggleTask preserves indentation", () => {
  const doc = "  - [ ] nested\n";
  assert.equal(toggleTask(doc, 0), "  - [x] nested\n");
});

test("toggleTask is a no-op on non-task lines", () => {
  const doc = "just a line\n";
  assert.equal(toggleTask(doc, 0), doc);
  assert.equal(toggleTask(doc, 99), doc);
});

test("taskStats counts todo, done and later", () => {
  const doc = "- [ ] a\n- [x] b\n- [ ] c\n";
  assert.deepEqual(taskStats(doc), { total: 3, todo: 2, done: 1, later: 0, open: 2 });
  assert.deepEqual(taskStats("no tasks"), { total: 0, todo: 0, done: 0, later: 0, open: 0 });
});

test("taskStats treats maybe-later as neither open nor done", () => {
  const doc = "- [ ] a\n- [/] b\n- [x] c\n";
  const stats = taskStats(doc);
  assert.equal(stats.total, 3);
  assert.equal(stats.todo, 1);
  assert.equal(stats.later, 1);
  assert.equal(stats.done, 1);
  assert.equal(stats.todo + stats.later + stats.done, stats.total);
  assert.equal(stats.open, 1, "the badge count excludes maybe-later");
});

test("setTaskState moves a task between all three states", () => {
  const doc = "- [ ] one\n";
  const later = setTaskState(doc, 0, "later");
  assert.equal(later, "- [/] one\n");
  assert.equal(setTaskState(later, 0, "done"), "- [x] one\n");
  assert.equal(setTaskState(later, 0, "todo"), "- [ ] one\n");
  assert.equal(setTaskState(doc, 9, "done"), doc, "out-of-range is a no-op");
});

test("processedBullets reads a section of the LLM output", () => {
  const doc = setProcessed(
    buildDocument("2026-11-22-104107", "raw"),
    "## Tasks\n- [ ] a task\n\n## Notes\n- first note\n- second note\n",
  );
  assert.deepEqual(processedBullets(doc, "Notes"), ["first note", "second note"]);
  assert.deepEqual(processedBullets(doc, "notes"), ["first note", "second note"], "case-insensitive");
  assert.deepEqual(processedBullets(doc, "Missing"), []);
  assert.deepEqual(processedBullets(buildDocument("2026-11-22-104107", "raw"), "Notes"), []);
});

test("processedBullets keeps non-bullet lines instead of dropping them", () => {
  const doc = setProcessed(buildDocument("2026-11-22-104107", "raw"), "## Notes\nplain line\n- bullet");
  assert.deepEqual(processedBullets(doc, "Notes"), ["plain line", "bullet"]);
});

test("referenceNotes never picks up tasks", () => {
  const doc = setProcessed(
    buildDocument("2026-11-22-104107", "raw"),
    "## Tasks\n- [ ] buy milk\n- [/] someday\n\n## Notes\n- shop closes at six",
  );
  assert.deepEqual(referenceNotes(doc), ["shop closes at six"]);
});

test("noteSummary trims and collapses whitespace", () => {
  const doc = buildDocument("2026-11-22-104107", "  lots   of\n\nspace  ");
  assert.equal(noteSummary(doc), "lots of space");
  assert.ok(noteSummary(doc, 5).endsWith("…"));
});

test("documentTitle reads the heading", () => {
  assert.equal(documentTitle("# Hello\n\ntext"), "Hello");
  assert.equal(documentTitle("no heading"), "Untitled");
});

test("round trip: process, toggle, re-process keeps raw text stable", () => {
  let doc = buildDocument("2026-11-22-104107", "I should email Sam about the invoice");
  doc = setProcessed(doc, "## Tasks\n- [ ] Email Sam about the invoice\n\n## Notes");
  const task = extractTasks(doc)[0];
  doc = toggleTask(doc, task.lineIndex);
  assert.equal(extractTasks(doc)[0].done, true);
  doc = setProcessed(doc, "## Tasks\n- [ ] Email Sam about the invoice\n\n## Notes");
  assert.equal(rawDump(doc), "I should email Sam about the invoice");
  assert.equal(extractTasks(doc)[0].done, false, "re-processing resets task state");
});
