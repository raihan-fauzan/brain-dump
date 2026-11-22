import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createZip, readZip } from "../js/zip.js";
import { planImport, describePlan, sanitizeId, ensureTitle } from "../js/importer.js";
import { buildDocument, setProcessed, rawDump } from "../js/note.js";

const run = promisify(execFile);
const enc = new TextEncoder();
const dec = new TextDecoder();

test("readZip round-trips our own export", async () => {
  const files = [
    { name: "notes/2026-11-22-104107.md", data: "# title\n\nhello\n" },
    { name: "notes/second.md", data: "unicode ☕ 中文\n" },
    { name: "notes/empty.md", data: "" },
  ];
  const zip = createZip(files);
  const read = await readZip(zip);

  assert.deepEqual(read.map((f) => f.name), files.map((f) => f.name));
  for (const [i, f] of files.entries()) {
    assert.equal(dec.decode(read[i].data), f.data);
  }
});

test("readZip rejects non-archives", async () => {
  await assert.rejects(() => readZip(new Uint8Array([1, 2, 3])), /not a ZIP/);
  await assert.rejects(() => readZip(enc.encode("plain text that is long enough")), /not a ZIP/);
});

test("readZip handles deflated entries written by another tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brain-dump-"));
  const path = join(dir, "deflated.zip");
  const script = `
import zipfile
with zipfile.ZipFile(${JSON.stringify(path)}, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("notes/deflated.md", "# import me\\n\\n" + ("line of text\\n" * 200))
`;
  await run("python", ["-c", script]);

  const { readFile } = await import("node:fs/promises");
  const bytes = new Uint8Array(await readFile(path));
  const files = await readZip(bytes);

  assert.equal(files.length, 1);
  const text = dec.decode(files[0].data);
  assert.ok(text.startsWith("# import me"));
  assert.equal(text.split("\n").length > 200, true);
});

test("sanitizeId makes filesystem-safe ids", () => {
  assert.equal(sanitizeId("2026-11-22-104107.md"), "2026-11-22-104107");
  assert.equal(sanitizeId("my note (1).md"), "my-note-1");
  assert.equal(sanitizeId("../../etc/passwd.md"), "etc-passwd");
  assert.equal(sanitizeId("....md"), "");
});

test("ensureTitle only adds a heading when missing", () => {
  assert.equal(ensureTitle("# already\n\nbody", "id"), "# already\n\nbody\n");
  assert.equal(ensureTitle("body only", "2026-11-22-104107"), "# 22 Nov 2026 · 10:41\n\nbody only\n");
  assert.equal(ensureTitle("\uFEFF# bom\n\nx", "id"), "# bom\n\nx\n");
});

test("planImport adds new notes, skips identical, copies conflicts", () => {
  const docA = buildDocument("2026-11-22-104107", "keep me");
  const existing = [{ id: "2026-11-22-104107", doc: docA }];

  const entries = [
    { name: "notes/2026-11-22-104107.md", data: enc.encode(docA) }, // identical
    { name: "notes/2026-11-22-105000.md", data: enc.encode(buildDocument("2026-11-22-105000", "new")) },
    { name: "notes/2026-11-22-104107.md", data: enc.encode(buildDocument("2026-11-22-104107", "different")) },
    { name: "notes/readme.txt", data: enc.encode("ignore me") },
  ];

  const plan = planImport(entries, existing);
  assert.equal(plan.adds.length, 2);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.renamed, 1);
  assert.equal(plan.ignored, 1);

  assert.deepEqual(plan.adds.map((a) => a.id), [
    "2026-11-22-105000",
    "2026-11-22-104107-imported",
  ]);
  assert.equal(rawDump(plan.adds[1].doc), "different");
});

test("planImport restores the dump timestamp from the filename", () => {
  const doc = buildDocument("2026-01-05-091500", "hello");
  const plan = planImport([{ name: "notes/2026-01-05-091500.md", data: enc.encode(doc) }], []);
  assert.equal(plan.adds[0].createdAt, new Date(2026, 0, 5, 9, 15, 0).getTime());
});

test("planImport falls back to now for unparseable names", () => {
  const now = new Date(2026, 10, 22).getTime();
  const plan = planImport([{ name: "my-backup.md", data: enc.encode("plain text") }], [], now);
  assert.equal(plan.adds[0].createdAt, now);
  assert.match(plan.adds[0].doc, /^# /);
  assert.ok(plan.adds[0].doc.includes("plain text"));
});

test("planImport keeps processed sections intact", () => {
  let doc = buildDocument("2026-11-22-104107", "raw words");
  doc = setProcessed(doc, "## Tasks\n- [x] done already\n\n## Notes\n- a note");
  const plan = planImport([{ name: "notes/2026-11-22-104107.md", data: enc.encode(doc) }], []);
  assert.equal(plan.adds[0].doc, doc);
});

test("planImport never produces duplicate ids in one archive", () => {
  const entries = [
    { name: "a.md", data: enc.encode("one") },
    { name: "a.md", data: enc.encode("two") },
    { name: "a.md", data: enc.encode("three") },
  ];
  const plan = planImport(entries, []);
  const ids = plan.adds.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("describePlan summarises the result", () => {
  assert.equal(describePlan({ adds: [{}], skipped: 0, renamed: 0, ignored: 0 }), "Imported 1.");
  assert.equal(
    describePlan({ adds: [{}], skipped: 2, renamed: 1, ignored: 3 }),
    "Imported 1, 2 already there, 1 kept as a copy, 3 skipped.",
  );
});

test("full import path: export -> readZip -> planImport", async () => {
  let doc = buildDocument("2026-11-22-104107", "email sam");
  doc = setProcessed(doc, "## Tasks\n- [ ] email sam\n\n## Notes\n- friday deadline");

  const zip = createZip([{ name: "notes/2026-11-22-104107.md", data: doc }]);
  const files = await readZip(zip);
  const plan = planImport(files, []);

  assert.equal(plan.adds.length, 1);
  assert.equal(plan.adds[0].doc, doc);
  assert.equal(rawDump(plan.adds[0].doc), "email sam");
});
