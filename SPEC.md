# Brain Dump Processor — Spec

LLM-assisted brain-dump processor + lightweight task manager. Personal,
neurodivergent-friendly, minimal friction.

## Platform & architecture

- **PWA** — one codebase, runs in any browser, installable on Android tablet and
  desktop, offline-capable.
- **v1: per-device local storage.** North star: serve from one machine over LAN
  (option 1) — no rearchitecture needed to reach it later.
- Storage: browser-local, **one Markdown file per note, flat folder**,
  timestamped filename (e.g. `2025-01-15-0923.md`).

## Data format

- **Markdown, checklist convention.** GitHub-style checkbox states:
  - `- [ ]` todo
  - `- [x]` done
  - `- [/]` maybe-later (v1.1)
- **Raw dump always preserved** at the top of the note; LLM output appended
  below. Nothing is ever destroyed.

## LLM processing

- Provider: **OpenAI-compatible endpoint** (base URL + key + model) — works with
  OpenAI, OpenRouter, Groq, Ollama/LM Studio.
- Behavior: **split into tasks (checklist items) + reference notes.** Minimal,
  non-lossy.
- Trigger: **explicit "Process" button per note.** Batch deferred to v1.1.
- Flow: **preview → edit → accept**, then append.
- Prompt: **fixed default**; editable in advanced settings in v1.1.
- API key: stored plaintext in browser, shown masked.

## Tasks

- v1: todo/done checkboxes, toggle in place.
- Flat "open tasks" view across all notes.
- maybe-later bucket (`- [/]`) → v1.1.

## Offline

- Capture + read fully offline. Only "Process" needs internet.

## Portability

- Export **ZIP of all `.md` files**. (Import → v1.1.)

## Scope

### v1

- Quick-capture bar + recent notes list
- Markdown notes (one file per note, flat folder)
- todo/done checkboxes
- Open-tasks view
- Offline capture/read
- ZIP export
- Per-note LLM processing with preview/accept
- OpenAI-compatible + key settings

### v1.1+

- Batch processing
- maybe-later bucket (`- [/]`)
- Advanced prompt editor
- ZIP import
- LAN serve (option 1)

## Micro-decisions (locked)

1. Open-tasks view ships in v1.
2. ZIP import is v1.1 (export first).
3. v1 files only use `- [ ]` / `- [x]`; `- [/]` is reserved so nothing breaks later.

## v1.1 — shipped

### Notes section (new requirement from use)

A fourth view listing **reference notes** (the `## Notes` output) or **raw dumps**
(toggle between the two), across all dumps, with:

- **Search** — case- and accent-insensitive, all tokens must match, hits
  highlighted, 120 ms debounce.
- **Date filter** on the dump's own date: all time / today / last 7 days / last
  30 days / this month / custom range (end date inclusive).
- Each group links back to its dump with **Open dump**.

Rationale: tasks were browsable, but the material the model *deliberately did not*
turn into tasks — and the original words — only existed inside each note.

### Maybe-later tasks

`- [/]` is a real state, not just reserved. Each task row has a small **Later**
toggle. Semantics:

- `open` (badge count) = todo only, so later tasks never inflate "what's left".
- The Tasks view still lists later tasks — dimmed, italic, with a **To do** button.

### Done bucket + undo

Completing a task must never feel like deleting it. Two escapes hatch:

- The toast for a completion says **Task done** with an **Undo** action, live for
  six seconds. Undo re-checks the line it came from, refuses if that line changed,
  and works from either the note or the Tasks view.
- The Tasks view ends with a collapsed **Done (N)** bucket, grouped by dump. Every
  row is a live checked box: unchecking it puts the task back on the open list.

Completed tasks are stored as `- [x]` and never removed from the note, so the
bucket is just a second view of the same Markdown. The open list stays the default
because a flat "everything you have not done" view is the whole point of it.

### Batch processing

**Process N dumps** on the home screen. Processes unprocessed dumps one at a time
and still shows a preview for each (`Accept & next`), so the "review before commit"
guarantee holds. Cancelling stops the run; already-accepted notes stay.

### Prompt editor

Settings → Extraction prompt. Empty means the built-in default; the default is
viewable in place. Stored in `localStorage` with the other settings.

### ZIP import

Reads stored **and** deflated archives (via `DecompressionStream`), so ZIPs from
other tools work. Non-destructive conflict policy:

- new file name → added;
- identical content → skipped;
- same name, different content → added as `<id>-imported`;
- non-Markdown entries → ignored;
- duplicate names inside one archive are de-duplicated.

### Titles

Dumps in the same minute get seconds in their title (`11:41:07` vs `11:41:15`) so
list rows stay distinguishable without lengthening every title.

## Known limits

- No sync: each browser profile is its own dataset (deliberate, for now).
- In reference-notes mode, search matches the note text only. Switch to **Raw
dumps** to search the original words.
