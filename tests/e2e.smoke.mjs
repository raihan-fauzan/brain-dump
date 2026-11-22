// End-to-end smoke test (optional). Drives the real app in a real browser.
//
//   node tests/e2e.smoke.mjs
//
// Requires Playwright:  npm i -D playwright && npx playwright install chromium
// The LLM provider is mocked, so no API key or network access is needed.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("Skipping: playwright is not installed (npm i -D playwright).");
  process.exit(0);
}

const PORT = 8123;
const BASE = `http://localhost:${PORT}/`;
const MOCK = "**/mock/v1/chat/completions";

const server = spawn(process.execPath, ["scripts/serve.js", String(PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
});
await sleep(700);

const failures = [];
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failures.push(name);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  // Chromium logs unreachable requests itself; that is expected when we go offline.
  if (/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(text)) return;
  errors.push(`console: ${text}`);
});

let llmCalls = 0;
let lastBody = null;
await page.route(MOCK, async (route) => {
  llmCalls += 1;
  lastBody = route.request().postDataJSON();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      choices: [
        {
          message: {
            content:
              "## Tasks\n- [ ] Email Sam about the invoice\n- [ ] Book dentist\n\n## Notes\n- Sam mentioned the deadline is Friday",
          },
        },
      ],
    }),
  });
});

const PROPOSED = "- [ ] Email Sam about the invoice";
const noteCount = () => page.locator("#notes-list li").count();
const toastText = async () =>
  (await page.locator("#toast").isHidden()) ? "" : (await page.locator("#toast").textContent()).trim();
const openNote = async () => {
  await page.click("#nav-home");
  await page.waitForSelector("#view-home:not([hidden])");
};

await page.goto(BASE, { waitUntil: "networkidle" });
check("app loads", (await page.title()) === "Brain Dump");

// ---------- capture ----------
await page.fill("#dump-input", "email sam about invoice\nbook dentist friday\nsam said deadline is friday");
await page.click("#save-btn");
await page.waitForSelector("#notes-list li");
check("note saved and listed", (await noteCount()) === 1);
check("capture box cleared", (await page.inputValue("#dump-input")) === "");
check("draft cleared", (await page.evaluate(() => localStorage.getItem("brain-dump:draft"))) === null);
check(
  "unprocessed badge shown",
  (await page.locator("#notes-list .badge").first().textContent()).includes("unprocessed"),
);
check("batch button offers the unprocessed dump", (await page.locator("#batch-btn").textContent()) === "Process 1 dump");

// ---------- settings ----------
await page.waitForSelector("#toast[hidden]", { state: "attached", timeout: 5000 });
await page.click("#nav-settings");
await page.waitForSelector("#view-settings:not([hidden])");
check("settings opens without an error toast", (await toastText()) === "", await toastText());
check("built-in prompt is shown", (await page.locator("#default-prompt").textContent()).includes("## Tasks"));
await page.fill("#base-url", `${BASE}mock/v1/`);
await page.fill("#model", "test-model");
await page.fill("#api-key", "sk-test-key");
await page.click("#save-settings");
check("settings saved", (await page.locator("#settings-status").textContent()).includes("Saved"));
check(
  "base url normalized on save",
  (await page.evaluate(() => JSON.parse(localStorage.getItem("brain-dump:settings")).baseUrl)).endsWith(
    "/mock/v1",
  ),
);

await page.click("#test-btn");
await page.waitForFunction(
  () => document.getElementById("settings-status").textContent.includes("Connected"),
  null,
  { timeout: 10000 },
);
check("connection test succeeds", (await page.locator("#settings-status").textContent()).includes("Connected"));

// ---------- process a note ----------
await openNote();
await page.click("#notes-list li button");
await page.waitForSelector("#view-note:not([hidden])");
check("note title rendered", (await page.locator("#note-title").textContent()).includes("·"));
check(
  "raw text visible",
  (await page.locator("#note-body").textContent()).includes("email sam about invoice"),
);

await page.click("#process-btn");
await page.waitForSelector("#preview-modal:not([hidden])", { timeout: 10000 });
check("LLM endpoint called", llmCalls >= 2);
check("model sent", lastBody?.model === "test-model", JSON.stringify(lastBody?.model));
check(
  "raw dump sent, not the title",
  String(lastBody?.messages?.[1]?.content).startsWith("email sam"),
  String(lastBody?.messages?.[1]?.content),
);

const preview = await page.inputValue("#preview-text");
check("preview shows proposed output", preview.includes(PROPOSED));

await page.fill("#preview-text", preview.replace("- [ ] Book dentist", "- [ ] Book dentist appointment"));
await page.click("#preview-accept");
await page.waitForSelector("#preview-modal[hidden]", { state: "attached" });
await sleep(300);

const bodyText = await page.locator("#note-body").textContent();
check("raw text still present after processing", bodyText.includes("sam said deadline is friday"));
check("edited output applied", bodyText.includes("Book dentist appointment"));
check("reference notes appended", bodyText.includes("deadline is Friday"));
check("two interactive checkboxes", (await page.locator("#note-body input[type=checkbox]").count()) === 2);
check("one processed divider", (await page.locator("#note-body hr.processed-divider").count()) === 1);
check("status shows open count", (await page.locator("#note-status").textContent()).includes("2 open"));

// ---------- maybe-later ----------
check("later buttons exist on tasks", (await page.locator("#note-body .later-btn").count()) === 2);
await page.locator("#note-body .later-btn").last().click();
await sleep(300);
check("task marked later", (await page.locator("#note-body .task-row.later").count()) === 1);
check(
  "later task leaves the open count",
  (await page.locator("#note-status").textContent()).includes("1 open") &&
    (await page.locator("#note-status").textContent()).includes("1 later"),
  await page.locator("#note-status").textContent(),
);
check("badge counts todo only", (await page.locator("#task-count").textContent()) === "1");

await page.click("#nav-tasks");
await page.waitForSelector("#view-tasks:not([hidden])");
check("tasks view still lists later tasks", (await page.locator("#tasks-groups .task-row").count()) === 2);
check("later task is visually marked", (await page.locator("#tasks-groups .task-row.later").count()) === 1);
check("tasks meta explains the split", (await page.locator("#tasks-meta").textContent()).includes("1 later"));

await page.locator("#tasks-groups .later-btn[aria-pressed='true']").first().click();
await sleep(300);
check("later can be moved back to todo", (await page.locator("#tasks-groups .task-row.later").count()) === 0);

// ---------- toggle a task in the note ----------
await openNote();
await page.click("#notes-list li button");
await page.waitForSelector("#view-note:not([hidden])");
await page.locator("#note-body input[type=checkbox]").first().click();
await sleep(300);
check("toggled task is struck through", (await page.locator("#note-body .task-row.checked").count()) === 1);
check("task count badge = 1", (await page.locator("#task-count").textContent()) === "1");

await page.click("#nav-tasks");
await page.waitForSelector("#view-tasks:not([hidden])");
check("tasks view lists open tasks only", (await page.locator("#tasks-groups .task-row").count()) === 1);
check("tasks view labels the note", (await page.locator("#tasks-groups h2").first().textContent()).includes("·"));

await page.locator("#tasks-groups input[type=checkbox]").first().click();
await sleep(300);
check("completed task leaves the open list", (await page.locator("#tasks-groups .task-row").count()) === 0);
check("empty state shown", !(await page.locator("#tasks-empty").isHidden()));
check("badge hidden at zero", await page.locator("#task-count").isHidden());

// ---------- done bucket + undo ----------
// The note has two tasks; both are done at this point.
check("done bucket appears", !(await page.locator("#done-wrap").isHidden()));
check("done bucket counts both tasks", (await page.locator("#done-count").textContent()) === "2");
check("done tasks are listed, not deleted", (await page.locator("#tasks-done .task-row").count()) === 2);
check(
  "done rows are struck through",
  (await page.locator("#tasks-done .task-row.checked").count()) === 2,
);
check("done rows skip the later toggle", (await page.locator("#tasks-done .later-btn").count()) === 0);
check("toast offers undo", !(await page.locator("#toast-action").isHidden()));
check("toast undo is labelled", (await page.locator("#toast-action").textContent()) === "Undo");

await page.click("#toast-action");
await sleep(500);
check("undo restores the task", (await page.locator("#tasks-groups .task-row").count()) === 1);
check("undo leaves the other task done", (await page.locator("#done-count").textContent()) === "1");
check("undo restores the badge", (await page.locator("#task-count").textContent()) === "1");

// complete again, then reopen it from the done bucket
await page.locator("#tasks-groups input[type=checkbox]").first().click();
await sleep(500);
check("second completion lands in done", (await page.locator("#done-count").textContent()) === "2");
await page.locator("#done-wrap summary").click();
await sleep(200);
check("done bucket opens on demand", await page.locator("#done-wrap").evaluate((el) => el.open));
await page.locator("#tasks-done input[type=checkbox]").first().click();
await sleep(500);
check(
  "reopening from the done bucket puts the task back",
  (await page.locator("#tasks-groups .task-row").count()) === 1,
);
check("done bucket still holds the other task", (await page.locator("#done-count").textContent()) === "1");

// finish the last one so the reload checks below see an all-done note
await page.locator("#tasks-groups input[type=checkbox]").first().click();
await sleep(500);
check("no open tasks left", (await page.locator("#tasks-groups .task-row").count()) === 0);

// ---------- persistence across reload ----------
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#notes-list li", { state: "attached" });
check("note survives reload", (await noteCount()) === 1);
check(
  "processed state survives reload",
  (await page.locator("#notes-list .badge").first().textContent()).includes("all done"),
);
check(
  "settings survive reload",
  (await page.evaluate(() => JSON.parse(localStorage.getItem("brain-dump:settings")).model)) === "test-model",
);

// ---------- notes view: search, date filter, raw dumps ----------
await page.click("#nav-notes");
await page.waitForSelector("#view-notes:not([hidden])");
check("reference notes listed", (await page.locator("#notes-groups li").count()) === 1);
check(
  "reference note text shown",
  (await page.locator("#notes-groups li").first().textContent()).includes("deadline is Friday"),
);

await page.fill("#notes-search", "deadline");
await sleep(250);
check("search keeps the match", (await page.locator("#notes-groups li").count()) === 1);
check("search highlights the hit", (await page.locator("#notes-groups mark.hit").count()) >= 1);

await page.fill("#notes-search", "zzzz");
await sleep(250);
check("search hides non-matches", (await page.locator("#notes-groups li").count()) === 0);
check("empty state appears", !(await page.locator("#notes-view-empty").isHidden()));

await page.fill("#notes-search", "");
await sleep(250);
await page.selectOption("#notes-range", "today");
await sleep(200);
check("today filter keeps a fresh note", (await page.locator("#notes-groups li").count()) === 1);

await page.selectOption("#notes-range", "custom");
await sleep(200);
check("custom range reveals date inputs", !(await page.locator("#custom-range").isHidden()));
await page.fill("#range-from", "2020-01-01");
await page.dispatchEvent("#range-from", "change");
await page.fill("#range-to", "2020-01-02");
await page.dispatchEvent("#range-to", "change");
await sleep(250);
check("custom range excludes everything", (await page.locator("#notes-groups li").count()) === 0);

await page.selectOption("#notes-range", "all");
await sleep(250);
check("clearing the range restores results", (await page.locator("#notes-groups li").count()) === 1);

await page.click("#mode-raw");
await sleep(250);
check("raw dumps mode switches content", (await page.locator("#notes-groups .entry-raw").count()) === 1);
check(
  "raw dump shows the original words",
  (await page.locator("#notes-groups .entry-raw").textContent()).includes("book dentist friday"),
);
await page.click("#mode-notes");
await sleep(200);

await page.locator("#notes-groups button[data-id]").first().click();
await page.waitForSelector("#view-note:not([hidden])");
check("open dump navigates to the note", (await page.locator("#note-title").textContent()).includes("·"));

// ---------- second note, processing, and re-processing ----------
await openNote();
await page.fill("#dump-input", "second dump");
await page.click("#save-btn");
await sleep(400);
check("two notes listed", (await noteCount()) === 2);

await page.locator("#notes-list li button", { hasText: "second dump" }).click();
await page.waitForSelector("#view-note:not([hidden])");
await page.click("#process-btn");
await page.waitForSelector("#preview-modal:not([hidden])", { timeout: 10000 });
await page.click("#preview-accept");
await sleep(400);
check(
  "second note processed",
  (await page.locator("#note-body").textContent()).includes("Email Sam about the invoice"),
);
check("second note has one divider", (await page.locator("#note-body hr.processed-divider").count()) === 1);
check("button becomes Re-process", (await page.locator("#process-btn").textContent()) === "Re-process");

await page.click("#process-btn");
await page.waitForSelector("#preview-modal:not([hidden])", { timeout: 10000 });
await page.click("#preview-accept");
await sleep(400);
check(
  "re-processing does not duplicate tasks",
  (await page.locator("#note-body input[type=checkbox]").count()) === 2,
);
check(
  "raw text not duplicated",
  (await page.locator("#note-body").textContent()).match(/second dump/g)?.length === 1,
);

// ---------- batch processing ----------
await openNote();
for (const text of ["batch one", "batch two"]) {
  await page.fill("#dump-input", text);
  await page.click("#save-btn");
  await sleep(250);
}
check("batch button counts unprocessed", (await page.locator("#batch-btn").textContent()) === "Process 2 dumps");

await page.click("#batch-btn");
await page.waitForSelector("#preview-modal:not([hidden])", { timeout: 10000 });
check("batch shows progress", (await page.locator("#preview-progress").textContent()).includes("1 of 2"));
check("batch offers next", (await page.locator("#preview-accept").textContent()) === "Accept & next");

await page.click("#preview-accept");
await page.waitForFunction(
  () => document.getElementById("preview-progress").textContent.includes("2 of 2"),
  null,
  { timeout: 10000 },
);
check("batch advances to the second note", (await page.locator("#preview-accept").textContent()) === "Accept");
await page.click("#preview-accept");
await page.waitForSelector("#preview-modal[hidden]", { state: "attached", timeout: 10000 });
await sleep(500);
check("batch processed both", llmCalls >= 6);
check("batch button hidden when nothing is pending", await page.locator("#batch-btn").isHidden());
check(
  "no note left unprocessed",
  (await page.locator("#notes-list .badge", { hasText: "unprocessed" }).count()) === 0,
);
const listTitles = await page.locator("#notes-list .meta > span:first-child").allTextContents();
check(
  "list titles stay unique when several dumps share a minute",
  new Set(listTitles).size === listTitles.length,
  JSON.stringify(listTitles),
);

// ---------- custom prompt ----------
await page.click("#nav-settings");
await page.fill("#prompt-text", "CUSTOM PROMPT SENTINEL");
await page.click("#save-prompt");
check("prompt saved", (await page.locator("#prompt-status").textContent()).includes("Saved"));

await openNote();
await page.click("#notes-list li button");
await page.waitForSelector("#view-note:not([hidden])");
await page.click("#process-btn");
await page.waitForSelector("#preview-modal:not([hidden])", { timeout: 10000 });
check("custom prompt reaches the provider", lastBody?.messages?.[0]?.content === "CUSTOM PROMPT SENTINEL");
await page.click("#preview-accept");
await sleep(300);

await page.click("#nav-settings");
await page.click("#reset-prompt");
check("prompt reset", (await page.inputValue("#prompt-text")) === "");
check(
  "reset clears the stored prompt",
  (await page.evaluate(() => JSON.parse(localStorage.getItem("brain-dump:settings")).prompt)) === "",
);

// ---------- export ----------
const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
await page.click("#export-btn");
const download = await downloadPromise;
const zipPath = await download.path();
check(
  "zip filename stamped",
  /^brain-dump-\d{8}-\d{4}\.zip$/.test(download.suggestedFilename()),
  download.suggestedFilename(),
);
check("zip is non-trivial", statSync(zipPath).size > 200);

// ---------- import ----------
const fixture = await mkdtemp(join(tmpdir(), "brain-dump-e2e-"));
const makeZip = async (path, entries) => {
  const script = `
import json, sys, zipfile
path, entries = sys.argv[1], json.loads(sys.argv[2])
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
    for name, text in entries.items():
        z.writestr(name, text)
`;
  await writeFile(path, "");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("python", ["-c", script, path, JSON.stringify(entries)]);
};

const importedId = "2024-03-04-101010";
const zipNew = join(fixture, "new.zip");
await makeZip(zipNew, {
  [`notes/${importedId}.md`]: "# 4 Mar 2024 · 10:10\n\nimported from another device\n",
  "notes/notes.txt": "ignored",
});

const before = await noteCount();
await page.setInputFiles("#import-file", zipNew);
await page.waitForFunction(
  () => document.getElementById("data-status").textContent.includes("Imported"),
  null,
  { timeout: 10000 },
);
check("import reports a result", (await page.locator("#data-status").textContent()).includes("Imported 1"));
await openNote();
check("import added the note", (await noteCount()) === before + 1);
check(
  "imported note keeps its content",
  (await page.locator("#notes-list li", { hasText: "imported from another device" }).count()) === 1,
);

await page.click("#nav-settings");
await page.setInputFiles("#import-file", zipNew);
await page.waitForFunction(
  () => document.getElementById("data-status").textContent.includes("already there"),
  null,
  { timeout: 10000 },
);
check(
  "re-importing skips duplicates",
  (await page.locator("#data-status").textContent()).includes("Imported 0"),
  await page.locator("#data-status").textContent(),
);

const zipConflict = join(fixture, "conflict.zip");
await makeZip(zipConflict, {
  [`notes/${importedId}.md`]: "# 4 Mar 2024 · 10:10\n\nthis one is different\n",
});
await page.setInputFiles("#import-file", zipConflict);
await page.waitForFunction(
  () => document.getElementById("data-status").textContent.includes("kept as a copy"),
  null,
  { timeout: 10000 },
);
await openNote();
check("conflicting import keeps a copy", (await noteCount()) === before + 2);

// ---------- offline behaviour ----------
await page.unroute(MOCK); // so the request really hits the (offline) network
await context.setOffline(true);
await page.fill("#dump-input", "captured while offline");
await page.click("#save-btn");
await sleep(500);
check("offline capture works", (await noteCount()) === before + 3);

await page.reload({ waitUntil: "domcontentloaded" });
await sleep(800);
check("app shell loads offline", (await page.locator(".topbar").count()) === 1);
await page.click("#notes-list li button");
await page.waitForSelector("#view-note:not([hidden])");
await page.click("#process-btn");
await sleep(1500);
check(
  "offline processing reports a readable error",
  /offline|interrupted|reach the provider/i.test(await page.locator("#note-status").textContent()),
  `status=${JSON.stringify(await page.locator("#note-status").textContent())}`,
);
await context.setOffline(false);

// ---------- missing key ----------
await page.click("#nav-settings");
await page.fill("#api-key", "");
await page.click("#save-settings");
await openNote();
await page.click("#notes-list li button");
await page.waitForSelector("#view-note:not([hidden])");
await page.click("#process-btn");
await sleep(300);
check("missing key reports a readable error", (await page.locator("#note-status").textContent()).includes("API key"));

check("no console or page errors", errors.length === 0, JSON.stringify(errors));

await browser.close();
server.kill();
console.log(`\n${failures.length ? `FAILED: ${failures.join(", ")}` : "ALL CHECKS PASSED"}`);
process.exit(failures.length ? 1 : 0);
