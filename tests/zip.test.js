import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { crc32, createZip, exportFilename } from "../js/zip.js";

const run = promisify(execFile);

test("crc32 matches the standard test vector", () => {
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(crc32(bytes), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("createZip produces a local file header and end-of-central-directory record", () => {
  const zip = createZip([{ name: "notes/a.md", data: "# A\n" }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50, "local header signature");
  const eocdOffset = zip.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50, "EOCD signature");
  assert.equal(view.getUint16(eocdOffset + 10, true), 1, "one entry");
});

test("createZip handles empty payloads and multiple files", () => {
  const zip = createZip([
    { name: "a.md", data: "" },
    { name: "b.md", data: "hello" },
  ]);
  const view = new DataView(zip.buffer);
  const eocdOffset = zip.length - 22;
  assert.equal(view.getUint16(eocdOffset + 8, true), 2, "two entries on disk");
  assert.equal(view.getUint16(eocdOffset + 10, true), 2, "two total entries");
});

test("exportFilename is filesystem-safe", () => {
  const name = exportFilename(new Date(2026, 10, 22, 10, 41));
  assert.equal(name, "brain-dump-20261122-1041.zip");
  assert.doesNotMatch(name, /[:\\/\s]/);
});

test("archive is readable by a real unzip implementation (python zipfile)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brain-dump-"));
  const path = join(dir, "out.zip");
  const files = [
    { name: "notes/2026-11-22-104107.md", data: "# 22 Nov 2026 · 10:41\n\nbuy milk\n\n## Tasks\n- [ ] buy milk\n" },
    { name: "notes/2026-11-22-104200.md", data: "# a second note\n\nunicode: café ☕ 中文\n" },
    { name: "notes/empty.md", data: "" },
  ];
  await writeFile(path, createZip(files));

  const script = `
import json, sys, zipfile, hashlib
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
names = z.namelist()
print(json.dumps({
  "bad": bad,
  "names": names,
  "contents": {n: z.read(n).decode("utf-8") for n in names},
}))
`;
  const { stdout } = await run("python", ["-c", script, path]);
  const result = JSON.parse(stdout.trim());

  assert.equal(result.bad, null, "no CRC failures");
  assert.deepEqual(result.names, files.map((f) => f.name));
  for (const f of files) assert.equal(result.contents[f.name], f.data);
});

test("archive survives a full round trip through disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brain-dump-"));
  const path = join(dir, "rt.zip");
  const zip = createZip([{ name: "notes/n.md", data: "line one\nline two\n" }]);
  await writeFile(path, zip);
  assert.deepEqual(new Uint8Array(await readFile(path)), zip);
});
