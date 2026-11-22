// App wiring: hash routing, views, capture, processing, search, import/export.

import {
  buildDocument,
  uniqueNoteId,
  noteTitle,
  titlesFor,
  noteSummary,
  rawDump,
  documentTitle,
  setProcessed,
  hasProcessed,
  extractTasks,
  taskStats,
  setTaskState,
  referenceNotes,
} from "./note.js";
import * as store from "./store.js";
import { renderDocument, renderTaskRow, escapeHtml, highlightHtml } from "./render.js";
import { loadSettings, saveSettings, hasApiKey } from "./settings.js";
import { processDump, chatEndpoint, normalizeBaseUrl, DEFAULT_MODEL, SYSTEM_PROMPT } from "./llm.js";
import { createZip, exportFilename, readZip } from "./zip.js";
import { planImport, describePlan } from "./importer.js";
import { tokenize, dateBounds, customBounds, matchesQuery, inWindow } from "./search.js";

const DRAFT_KEY = "brain-dump:draft";

const el = (id) => document.getElementById(id);

const dom = {
  views: {
    home: el("view-home"),
    notes: el("view-notes"),
    note: el("view-note"),
    tasks: el("view-tasks"),
    settings: el("view-settings"),
  },
  input: el("dump-input"),
  saveBtn: el("save-btn"),
  notesList: el("notes-list"),
  notesEmpty: el("notes-empty"),
  noteCount: el("note-count"),
  batchBtn: el("batch-btn"),
  noteTitle: el("note-title"),
  noteBody: el("note-body"),
  noteStatus: el("note-status"),
  processBtn: el("process-btn"),
  deleteBtn: el("delete-btn"),
  noteBack: el("note-back"),
  tasksEmpty: el("tasks-empty"),
  tasksMeta: el("tasks-meta"),
  tasksDone: el("tasks-done"),
  doneWrap: el("done-wrap"),
  doneCount: el("done-count"),
  toastText: el("toast-text"),
  toastAction: el("toast-action"),
  tasksGroups: el("tasks-groups"),
  taskCount: el("task-count"),
  notesSearch: el("notes-search"),
  notesRange: el("notes-range"),
  customRange: el("custom-range"),
  rangeFrom: el("range-from"),
  rangeTo: el("range-to"),
  modeNotes: el("mode-notes"),
  modeRaw: el("mode-raw"),
  notesMeta: el("notes-meta"),
  notesGroups: el("notes-groups"),
  notesViewEmpty: el("notes-view-empty"),
  settingsForm: el("settings-form"),
  baseUrl: el("base-url"),
  model: el("model"),
  apiKey: el("api-key"),
  toggleKey: el("toggle-key"),
  settingsStatus: el("settings-status"),
  testBtn: el("test-btn"),
  promptText: el("prompt-text"),
  savePrompt: el("save-prompt"),
  resetPrompt: el("reset-prompt"),
  promptStatus: el("prompt-status"),
  defaultPrompt: el("default-prompt"),
  exportBtn: el("export-btn"),
  importBtn: el("import-btn"),
  importFile: el("import-file"),
  dataStatus: el("data-status"),
  toast: el("toast"),
  modal: el("preview-modal"),
  previewText: el("preview-text"),
  previewProgress: el("preview-progress"),
  previewAccept: el("preview-accept"),
  previewCancel: el("preview-cancel"),
};

const state = {
  notes: [],
  currentId: null,
  busy: false,
  batch: null,
  notesMode: "notes", // "notes" | "raw"
  search: "",
  range: "all",
  customFrom: "",
  customTo: "",
};

// ---------- utils ----------

let toastTimer = null;
let toastActionRun = null;

function toast(message, opts = {}) {
  const { ms = 2200, action = null } = typeof opts === "number" ? { ms: opts } : opts;
  dom.toastText.textContent = message;
  dom.toast.hidden = false;
  toastActionRun = action ? action.run : null;
  dom.toastAction.textContent = action ? action.label : "";
  dom.toastAction.hidden = !action;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  dom.toast.hidden = true;
  dom.toastAction.hidden = true;
  toastActionRun = null;
}

dom.toastAction.addEventListener("click", () => {
  const run = toastActionRun;
  hideToast();
  if (run) run();
});

function setStatus(node, message, kind = "") {
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    node.className = "status";
    return;
  }
  node.hidden = false;
  node.textContent = message;
  node.className = `status ${kind}`.trim();
}

function download(bytes, filename, type = "application/zip") {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ---------- data ----------

async function refreshNotes() {
  state.notes = await store.listNotes();
  renderNotesList();
  updateTaskCount();
  updateBatchButton();
  if (!dom.views.notes.hidden) renderNotesView();
}

async function updateTaskCount() {
  let open = 0;
  for (const note of state.notes) open += taskStats(note.doc).todo;
  dom.taskCount.textContent = String(open);
  dom.taskCount.hidden = open === 0;
}

function unprocessedNotes() {
  return state.notes.filter((n) => !hasProcessed(n.doc));
}

function updateBatchButton() {
  const count = unprocessedNotes().length;
  dom.batchBtn.hidden = count === 0;
  dom.batchBtn.textContent = count === 1 ? "Process 1 dump" : `Process ${count} dumps`;
}

function getNote(id) {
  return state.notes.find((n) => n.id === id) || null;
}

// ---------- routing ----------

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (raw.startsWith("note/")) return { view: "note", id: decodeURIComponent(raw.slice(5)) };
  if (raw === "notes") return { view: "notes" };
  if (raw === "tasks") return { view: "tasks" };
  if (raw === "settings") return { view: "settings" };
  return { view: "home" };
}

async function route() {
  const r = parseRoute();
  for (const [name, node] of Object.entries(dom.views)) {
    node.hidden = name !== r.view;
  }

  document.querySelectorAll(".topnav button").forEach((b) => {
    const target = b.dataset.nav;
    if (target === r.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });

  window.scrollTo(0, 0);

  if (r.view === "note") {
    state.currentId = r.id;
    renderNote();
  } else if (r.view === "notes") {
    renderNotesView();
  } else if (r.view === "tasks") {
    renderTasks();
  } else if (r.view === "settings") {
    fillSettingsForm();
  } else {
    renderNotesList();
    const fine = window.matchMedia?.("(pointer: fine)")?.matches;
    if (fine) dom.input.focus();
  }
}

// ---------- home ----------

function renderNotesList() {
  dom.notesList.innerHTML = "";
  dom.noteCount.textContent = state.notes.length ? `${state.notes.length} total` : "";
  dom.notesEmpty.hidden = state.notes.length > 0;
  const titles = titlesFor(state.notes.map((n) => n.id));

  for (const note of state.notes) {
    const stats = taskStats(note.doc);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.id = note.id;
    const badge = stats.total
      ? `<span class="badge${stats.todo === 0 ? " done" : ""}">${
          stats.todo === 0 ? "all done" : `${stats.todo} open`
        }</span>`
      : `<span class="badge">${hasProcessed(note.doc) ? "no tasks" : "unprocessed"}</span>`;
    btn.innerHTML =
      `<span class="meta"><span>${escapeHtml(titles.get(note.id))}</span>${badge}</span>` +
      `<span class="preview">${escapeHtml(noteSummary(note.doc))}</span>`;
    li.appendChild(btn);
    dom.notesList.appendChild(li);
  }
}

dom.notesList.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-id]");
  if (!btn) return;
  navigate(`#/note/${encodeURIComponent(btn.dataset.id)}`);
});

function syncSaveButton() {
  dom.saveBtn.disabled = dom.input.value.trim() === "";
}

dom.input.addEventListener("input", () => {
  syncSaveButton();
  try {
    localStorage.setItem(DRAFT_KEY, dom.input.value);
  } catch {
    /* storage full or blocked — draft saving is best-effort */
  }
});

async function saveDump() {
  const text = dom.input.value.trim();
  if (!text) return;
  const taken = new Set(state.notes.map((n) => n.id));
  const id = uniqueNoteId(taken);
  const doc = buildDocument(id, text);
  await store.saveNote({ id, doc });
  dom.input.value = "";
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
  syncSaveButton();
  await refreshNotes();
  toast("Saved");
}

dom.saveBtn.addEventListener("click", () => {
  saveDump().catch((err) => toast(`Save failed: ${err.message}`, 4000));
});

dom.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    saveDump().catch((err) => toast(`Save failed: ${err.message}`, 4000));
  }
});

// ---------- note detail ----------

function renderNote() {
  const note = getNote(state.currentId);
  if (!note) {
    navigate("#/home");
    return;
  }
  dom.noteTitle.textContent = noteTitle(note.id);
  dom.noteBody.innerHTML = renderDocument(note.doc, { linkTasks: true, skipTitle: true });
  dom.processBtn.textContent = hasProcessed(note.doc) ? "Re-process" : "Process";
  dom.processBtn.disabled = state.busy;
  setStatus(dom.noteStatus, "");
  const stats = taskStats(note.doc);
  if (stats.total) {
    const parts = [];
    if (stats.todo) parts.push(`${stats.todo} open`);
    if (stats.later) parts.push(`${stats.later} later`);
    if (stats.done) parts.push(`${stats.done} done`);
    setStatus(dom.noteStatus, parts.join(" · "));
  }
}

async function saveNoteDoc(note, doc) {
  note.doc = doc;
  await store.saveNote({ id: note.id, doc, createdAt: note.createdAt });
  await refreshNotes();
}

dom.noteBody.addEventListener("change", async (event) => {
  const box = event.target.closest('input[type="checkbox"][data-line]');
  if (!box) return;
  const note = getNote(state.currentId);
  if (!note) return;
  const line = Number(box.dataset.line);
  const task = extractTasks(note.doc).find((t) => t.lineIndex === line);
  if (!task) return;
  await setChecked(note, line, task.done ? "todo" : "done");
  renderNote();
});

dom.noteBody.addEventListener("click", async (event) => {
  const btn = event.target.closest(".later-btn[data-line]");
  if (!btn) return;
  const note = getNote(state.currentId);
  if (!note) return;
  const line = Number(btn.dataset.line);
  const task = extractTasks(note.doc).find((t) => t.lineIndex === line);
  if (!task) return;
  await saveNoteDoc(note, setTaskState(note.doc, line, task.later ? "todo" : "later"));
  renderNote();
});

dom.noteBack.addEventListener("click", () => navigate("#/home"));

dom.deleteBtn.addEventListener("click", async () => {
  const note = getNote(state.currentId);
  if (!note) return;
  if (!confirm(`Delete "${noteTitle(note.id)}"? This cannot be undone.`)) return;
  await store.deleteNote(note.id);
  await refreshNotes();
  navigate("#/home");
  toast("Deleted");
});

// ---------- processing ----------

function preflight(settings) {
  if (!hasApiKey(settings)) {
    return "Add your API key in Settings first.";
  }
  if (navigator.onLine === false) {
    return "You're offline. Processing needs a connection.";
  }
  return null;
}

async function requestOutput(note) {
  const settings = loadSettings();
  return processDump({
    raw: rawDump(note.doc),
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model || DEFAULT_MODEL,
    prompt: settings.prompt,
  });
}

function showPreview(output) {
  dom.previewText.value = output;
  dom.modal.hidden = false;
  dom.previewText.focus();
}

function hideModal() {
  dom.modal.hidden = true;
  dom.previewProgress.hidden = true;
  dom.previewProgress.textContent = "";
  dom.previewAccept.textContent = "Accept";
}

dom.processBtn.addEventListener("click", async () => {
  const note = getNote(state.currentId);
  if (!note) return;

  const problem = preflight(loadSettings());
  if (problem) {
    setStatus(dom.noteStatus, problem, "err");
    return;
  }

  state.batch = null;
  state.busy = true;
  dom.processBtn.disabled = true;
  const original = dom.processBtn.textContent;
  dom.processBtn.textContent = "Processing…";
  setStatus(dom.noteStatus, `Sending to ${normalizeBaseUrl(loadSettings().baseUrl)}…`);

  try {
    showPreview(await requestOutput(note));
    setStatus(dom.noteStatus, "");
  } catch (err) {
    setStatus(dom.noteStatus, readableError(err), "err");
  } finally {
    state.busy = false;
    dom.processBtn.disabled = false;
    const current = getNote(state.currentId);
    dom.processBtn.textContent = current && hasProcessed(current.doc) ? "Re-process" : original;
  }
});

function readableError(err) {
  return (
    (err && typeof err.message === "string" && err.message.trim()) ||
    "Processing failed. Check your connection and your provider settings."
  );
}

// ---------- batch processing ----------

dom.batchBtn.addEventListener("click", async () => {
  const problem = preflight(loadSettings());
  if (problem) {
    toast(problem, 3500);
    return;
  }
  const ids = unprocessedNotes().map((n) => n.id);
  if (!ids.length) return;
  state.batch = { ids, index: 0, accepted: 0 };
  await runBatchStep();
});

async function runBatchStep() {
  if (!state.batch) return;
  const { ids, index } = state.batch;

  if (index >= ids.length) {
    finishBatch();
    return;
  }

  const note = getNote(ids[index]);
  if (!note) {
    state.batch.index += 1;
    await runBatchStep();
    return;
  }

  dom.batchBtn.disabled = true;
  dom.batchBtn.textContent = `Processing ${index + 1}/${ids.length}…`;

  try {
    const output = await requestOutput(note);
    dom.previewProgress.hidden = false;
    dom.previewProgress.textContent = `${index + 1} of ${ids.length} · ${noteTitle(note.id)}`;
    dom.previewAccept.textContent = index + 1 < ids.length ? "Accept & next" : "Accept";
    showPreview(output);
  } catch (err) {
    toast(readableError(err), 4000);
    state.batch = null;
  } finally {
    dom.batchBtn.disabled = false;
    updateBatchButton();
  }
}

async function finishBatch() {
  const accepted = state.batch?.accepted ?? 0;
  state.batch = null;
  hideModal();
  await refreshNotes();
  toast(accepted ? `Processed ${accepted} dump${accepted === 1 ? "" : "s"}` : "Nothing processed");
}

function stopBatch() {
  const accepted = state.batch?.accepted ?? 0;
  state.batch = null;
  hideModal();
  if (accepted) {
    refreshNotes().catch(() => {});
    toast(`Stopped after ${accepted}`);
  }
}

dom.previewCancel.addEventListener("click", () => {
  if (state.batch) stopBatch();
  else hideModal();
});

dom.modal.addEventListener("click", (event) => {
  if (event.target !== dom.modal) return;
  if (state.batch) stopBatch();
  else hideModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || dom.modal.hidden) return;
  if (state.batch) stopBatch();
  else hideModal();
});

dom.previewAccept.addEventListener("click", async () => {
  const noteId = state.batch ? state.batch.ids[state.batch.index] : state.currentId;
  const note = getNote(noteId);
  if (!note) {
    hideModal();
    return;
  }
  const output = dom.previewText.value;
  if (!output.trim()) {
    toast("Nothing to save");
    return;
  }

  const updated = setProcessed(note.doc, output);
  await store.saveNote({ id: note.id, doc: updated, createdAt: note.createdAt });
  note.doc = updated;

  if (state.batch) {
    state.batch.accepted += 1;
    state.batch.index += 1;
    if (state.batch.index < state.batch.ids.length) await runBatchStep();
    else await finishBatch();
    return;
  }

  hideModal();
  renderNote();
  await refreshNotes();
  toast("Applied");
});

/** Re-render whichever view is on screen after a doc change. */
function rerenderVisible() {
  if (!dom.views.note.hidden) renderNote();
  if (!dom.views.tasks.hidden) renderTasks();
  if (!dom.views.notes.hidden) renderNotesView();
}

/**
 * Flip one checkbox and offer an undo. The task line is never removed from the
 * note - a completed task is `- [x]`, still there to be reopened.
 */
async function setChecked(note, line, stateName) {
  const task = extractTasks(note.doc).find((t) => t.lineIndex === line);
  if (!task) return false;
  await saveNoteDoc(note, setTaskState(note.doc, line, stateName));
  const text = task.text;

  if (stateName === "done") {
    toast("Task done", {
      ms: 6000,
      action: {
        label: "Undo",
        run: () => reopen(note.id, line, text),
      },
    });
  } else {
    toast("Task reopened");
  }
  return true;
}

async function reopen(noteId, line, text) {
  const fresh = getNote(noteId);
  if (!fresh) return;
  const task = extractTasks(fresh.doc).find((t) => t.lineIndex === line);
  if (!task || task.text !== text) {
    toast("Could not undo — that line changed");
    return;
  }
  await saveNoteDoc(fresh, setTaskState(fresh.doc, line, "todo"));
  rerenderVisible();
}

/** Wire checkbox + later-button handling for a task container. */
function wireTaskContainer(container, after) {
  container.addEventListener("change", async (event) => {
    const box = event.target.closest('input[type="checkbox"][data-note]');
    if (!box) return;
    const note = getNote(box.dataset.note);
    if (!note) return;
    const line = Number(box.dataset.line);
    const task = extractTasks(note.doc).find((t) => t.lineIndex === line);
    if (!task) return;
    await setChecked(note, line, task.done ? "todo" : "done");
    after();
  });

  container.addEventListener("click", async (event) => {
    const btn = event.target.closest(".later-btn[data-note]");
    if (!btn) return;
    const note = getNote(btn.dataset.note);
    if (!note) return;
    const line = Number(btn.dataset.line);
    const task = extractTasks(note.doc).find((t) => t.lineIndex === line);
    if (!task) return;
    await saveNoteDoc(note, setTaskState(note.doc, line, task.later ? "todo" : "later"));
    after();
  });
}

// ---------- tasks view ----------

function renderTasks() {
  dom.tasksGroups.innerHTML = "";
  let groups = 0;
  let todo = 0;
  let later = 0;
  const titles = titlesFor(state.notes.map((n) => n.id));

  for (const note of state.notes) {
    const tasks = extractTasks(note.doc).filter((t) => !t.done);
    if (!tasks.length) continue;
    groups += 1;
    todo += tasks.filter((t) => !t.later).length;
    later += tasks.filter((t) => t.later).length;

    const group = document.createElement("section");
    group.className = "group";
    const heading = document.createElement("h2");
    heading.textContent = titles.get(note.id);
    heading.title = documentTitle(note.doc);
    group.appendChild(heading);

    for (const task of tasks) {
      const holder = document.createElement("div");
      holder.innerHTML = renderTaskRow({
        noteId: note.id,
        lineIndex: task.lineIndex,
        text: task.text,
        done: task.done,
        later: task.later,
      });
      group.appendChild(holder.firstElementChild);
    }
    dom.tasksGroups.appendChild(group);
  }

  dom.tasksEmpty.hidden = groups > 0;
  const parts = [`${todo} to do`];
  if (later) parts.push(`${later} later`);
  dom.tasksMeta.textContent = groups ? parts.join(" · ") : "";

  // Done bucket: completed tasks are never removed from the note, so show them
  // here where they can be unchecked back onto the list.
  dom.tasksDone.innerHTML = "";
  let done = 0;

  for (const note of state.notes) {
    const tasks = extractTasks(note.doc).filter((t) => t.done);
    if (!tasks.length) continue;
    done += tasks.length;

    const group = document.createElement("section");
    group.className = "group done-group";
    const heading = document.createElement("h3");
    heading.textContent = titles.get(note.id);
    group.appendChild(heading);

    for (const task of tasks) {
      const holder = document.createElement("div");
      holder.innerHTML = renderTaskRow({
        noteId: note.id,
        lineIndex: task.lineIndex,
        text: task.text,
        done: true,
        later: task.later,
        showLater: false,
      });
      group.appendChild(holder.firstElementChild);
    }
    dom.tasksDone.appendChild(group);
  }

  dom.doneCount.textContent = String(done);
  dom.doneWrap.hidden = done === 0;
  dom.tasksEmpty.textContent = done
    ? "Nothing open right now."
    : "No open tasks. Process a note to extract some.";
}

wireTaskContainer(dom.tasksGroups, renderTasks);
wireTaskContainer(dom.tasksDone, renderTasks);

// ---------- notes view (reference notes + raw dumps) ----------

/** Matching entries grouped by the dump they came from. */
function gatherEntries() {
  const tokens = tokenize(state.search);
  const bounds =
    state.range === "custom"
      ? customBounds(state.customFrom, state.customTo)
      : dateBounds(state.range, new Date());

  const groups = [];
  for (const note of state.notes) {
    if (!inWindow(note.createdAt || 0, bounds)) continue;

    const texts =
      state.notesMode === "raw" ? [rawDump(note.doc)] : referenceNotes(note.doc);
    const items = texts.filter((t) => t && matchesQuery(t, tokens));
    if (items.length) groups.push({ note, items });
  }
  return groups;
}

function renderNotesView() {
  const groups = gatherEntries();
  const noun = state.notesMode === "raw" ? "dump" : "note";
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  const titles = titlesFor(state.notes.map((n) => n.id));
  const tokens = tokenize(state.search);

  dom.notesGroups.innerHTML = "";
  dom.notesViewEmpty.hidden = total > 0;
  dom.notesMeta.textContent = total
    ? `${total} ${noun}${total === 1 ? "" : "s"} in ${groups.length} dump${groups.length === 1 ? "" : "s"}`
    : "";

  for (const { note, items } of groups) {
    const section = document.createElement("section");
    section.className = "group entry-group";

    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.textContent = titles.get(note.id);
    const open = document.createElement("button");
    open.type = "button";
    open.dataset.id = note.id;
    open.textContent = "Open dump";
    header.append(title, open);
    section.appendChild(header);

    const list = document.createElement("ul");
    for (const text of items) {
      const li = document.createElement("li");
      if (state.notesMode === "raw") li.className = "entry-raw";
      li.innerHTML = highlightHtml(text, tokens);
      list.appendChild(li);
    }
    section.appendChild(list);
    dom.notesGroups.appendChild(section);
  }
}

let searchTimer = null;

dom.notesSearch.addEventListener("input", () => {
  state.search = dom.notesSearch.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderNotesView, 120);
});

dom.notesRange.addEventListener("change", () => {
  state.range = dom.notesRange.value;
  dom.customRange.hidden = state.range !== "custom";
  renderNotesView();
});

for (const input of [dom.rangeFrom, dom.rangeTo]) {
  input.addEventListener("change", () => {
    state.customFrom = dom.rangeFrom.value;
    state.customTo = dom.rangeTo.value;
    renderNotesView();
  });
}

for (const [button, mode] of [
  [dom.modeNotes, "notes"],
  [dom.modeRaw, "raw"],
]) {
  button.addEventListener("click", () => {
    state.notesMode = mode;
    dom.modeNotes.setAttribute("aria-pressed", String(mode === "notes"));
    dom.modeRaw.setAttribute("aria-pressed", String(mode === "raw"));
    renderNotesView();
  });
}

dom.notesGroups.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  navigate(`#/note/${button.dataset.id}`);
});

// ---------- settings ----------

function fillSettingsForm() {
  const s = loadSettings();
  dom.baseUrl.value = s.baseUrl;
  dom.model.value = s.model;
  dom.apiKey.value = s.apiKey;
  dom.apiKey.type = "password";
  dom.toggleKey.textContent = "Show";
  dom.promptText.value = s.prompt || "";
  dom.defaultPrompt.textContent = SYSTEM_PROMPT;
  setStatus(dom.settingsStatus, "");
  setStatus(dom.promptStatus, "");
  setStatus(dom.dataStatus, "");
}

dom.toggleKey.addEventListener("click", () => {
  const showing = dom.apiKey.type === "text";
  dom.apiKey.type = showing ? "password" : "text";
  dom.toggleKey.textContent = showing ? "Show" : "Hide";
});

dom.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const s = saveSettings({
    baseUrl: normalizeBaseUrl(dom.baseUrl.value),
    model: dom.model.value.trim() || DEFAULT_MODEL,
    apiKey: dom.apiKey.value.trim(),
  });
  dom.baseUrl.value = s.baseUrl;
  dom.model.value = s.model;
  setStatus(dom.settingsStatus, "Saved.", "ok");
});

dom.savePrompt.addEventListener("click", () => {
  saveSettings({ prompt: dom.promptText.value.trim() });
  setStatus(
    dom.promptStatus,
    dom.promptText.value.trim() ? "Saved. Used from the next processing run." : "Using the built-in prompt.",
    "ok",
  );
});

dom.resetPrompt.addEventListener("click", () => {
  dom.promptText.value = "";
  saveSettings({ prompt: "" });
  setStatus(dom.promptStatus, "Using the built-in prompt.", "ok");
});

dom.testBtn.addEventListener("click", async () => {
  const settings = {
    baseUrl: normalizeBaseUrl(dom.baseUrl.value),
    model: dom.model.value.trim() || DEFAULT_MODEL,
    apiKey: dom.apiKey.value.trim(),
  };
  if (!settings.apiKey) {
    setStatus(dom.settingsStatus, "Enter an API key first.", "err");
    return;
  }
  dom.testBtn.disabled = true;
  setStatus(dom.settingsStatus, "Testing…");
  try {
    const res = await fetch(chatEndpoint(settings.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.text();
        detail = body.slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
    }
    setStatus(dom.settingsStatus, `Connected. ${settings.model} responded.`, "ok");
  } catch (err) {
    setStatus(
      dom.settingsStatus,
      `${err.message} — if this is a CORS error, the provider may block browser requests.`,
      "err",
    );
  } finally {
    dom.testBtn.disabled = false;
  }
});

// ---------- export / import ----------

dom.exportBtn.addEventListener("click", async () => {
  dom.exportBtn.disabled = true;
  try {
    const notes = await store.listNotes();
    if (!notes.length) {
      toast("No notes to export");
      return;
    }
    const files = notes.map((n) => ({ name: `notes/${n.id}.md`, data: n.doc }));
    download(createZip(files), exportFilename());
    setStatus(dom.dataStatus, `Exported ${notes.length} note${notes.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    setStatus(dom.dataStatus, `Export failed: ${err.message}`, "err");
  } finally {
    dom.exportBtn.disabled = false;
  }
});

dom.importBtn.addEventListener("click", () => dom.importFile.click());

dom.importFile.addEventListener("change", async () => {
  const file = dom.importFile.files?.[0];
  if (!file) return;
  dom.importBtn.disabled = true;
  setStatus(dom.dataStatus, "Reading archive…");
  try {
    const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
    const existing = await store.listNotes();
    const plan = planImport(entries, existing);

    for (const add of plan.adds) {
      await store.saveNote({ id: add.id, doc: add.doc, createdAt: add.createdAt });
    }

    const nothingFound = plan.adds.length === 0 && plan.skipped === 0;
    setStatus(
      dom.dataStatus,
      nothingFound && plan.ignored === entries.length
        ? "No Markdown notes found in that archive."
        : describePlan(plan),
      nothingFound && plan.ignored === entries.length ? "err" : "ok",
    );
    await refreshNotes();
  } catch (err) {
    setStatus(dom.dataStatus, `Import failed: ${err.message}`, "err");
  } finally {
    dom.importBtn.disabled = false;
    dom.importFile.value = "";
  }
});

// ---------- nav ----------

el("nav-home").addEventListener("click", () => navigate("#/home"));
el("nav-notes").addEventListener("click", () => navigate("#/notes"));
el("nav-tasks").addEventListener("click", () => navigate("#/tasks"));
el("nav-settings").addEventListener("click", () => navigate("#/settings"));

window.addEventListener("hashchange", () => {
  route().catch((err) => toast(err.message, 4000));
});

// ---------- boot ----------

async function boot() {
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) dom.input.value = draft;
  } catch {
    /* ignore */
  }
  syncSaveButton();
  await refreshNotes();
  await route();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* offline support is optional; app still works online */
    });
  }
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:16px;white-space:pre-wrap">Startup error: ${escapeHtml(
    err.message,
  )}</pre>`;
});
