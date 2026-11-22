# Brain Dump

A low-friction brain dump box with LLM-assisted task extraction. Type the mess,
save, and when you want, let a model split it into tasks and reference notes.
Your original words are never changed.

Built as a static PWA: no accounts, no server of ours, no build step. Notes live
in your browser on your device as plain Markdown, and the LLM call goes straight
from your browser to the provider you choose, with your own API key.

See [SPEC.md](SPEC.md) for the full locked design decisions, and
[DEPLOY.md](DEPLOY.md) for putting it on a phone or tablet.

## Run it

```bash
node scripts/serve.js          # http://localhost:8080
node scripts/serve.js 5173     # custom port
```

The script prints a Network URL you can open on your tablet over Wi-Fi.

> **Secure-context note:** service workers and "install to home screen" require
> `https://` or `localhost`. A `http://192.168.x.x` LAN address is not a secure
> context, so offline caching won't work there. For tablet use, either deploy the
> folder to any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages — it's
> just static files) or accept online-only behaviour over LAN.

## Use

1. **Dump.** Type anything into the box. `Ctrl+Enter` (or `⌘+Enter`) saves.
   Unfinished text is kept as a draft if you close the app.
2. **Process.** Open a note and press **Process**. You get a preview you can edit,
   then **Accept** to append it below your original dump. **Process N dumps** on
   the home screen does the same for a backlog, one preview at a time.
3. **Tasks.** Toggle checkboxes in a note, or use the **Tasks** view for a flat
   list of everything still open across all notes. The small **Later** button on a
   task marks it maybe-later (`- [/]`); it drops out of the open count but stays
   visible in Tasks. Completing a task offers **Undo** in the toast, and completed
   tasks collect in the collapsed **Done (N)** bucket below the list — uncheck one
   there to put it back.
4. **Notes.** The **Notes** view browses everything that *isn't* a task: the
   extracted reference notes, or the raw dumps themselves. Search
   (case/accent-insensitive, highlights matches) and filter by date — all time,
   today, 7 days, 30 days, this month, or a custom range.
5. **Export / import.** Settings → **Export ZIP** writes `notes/<timestamp>.md`.
   **Import ZIP** reads such archives back (stored or deflated), skipping
   duplicates and keeping a copy when a name collides.

## LLM setup

Settings → provider. Any OpenAI-compatible endpoint works:

| Provider | Base URL | Model example |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-3.5-haiku` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.2` |
| LM Studio (local) | `http://localhost:1234/v1` | any loaded model |

Paste the base URL, the model name, and your key, then hit **Test connection**.

Local servers usually ignore the key, but some value is required by the form; `local`
is fine. If your local server runs on another machine, give the browser its LAN
address. The key is stored in this browser's `localStorage` in plain text and is
only ever sent to the base URL you configure.

### Custom prompt

Settings → **Extraction prompt** (advanced). Empty uses the built-in prompt, which
you can read in place. A custom prompt must still ask for a `## Tasks` section of
`- [ ]` lines and a `## Notes` section — the app normalises what it gets, but it
can't invent structure the model never produced.

## File format

One Markdown file per note. Toggling a checkbox rewrites that one line.

```markdown
# 22 Nov 2026 · 11:12

email sam about the invoice
book dentist friday

<!-- brain-dump:processed -->
## Tasks
- [ ] Email Sam about the invoice
- [x] Book dentist Friday
- [/] Renew the domain

## Notes
- Sam said the deadline is Friday
```

- Everything above `<!-- brain-dump:processed -->` is your dump, untouched forever.
- Everything below is LLM output. **Re-process** replaces only that part, so you
  can iterate without losing the original.
- `- [ ]` todo, `- [x]` done, `- [/]` maybe-later. A completed task stays in the
  file as `- [x]`; the Done bucket in the app is just another view of it.

Notes are stored in IndexedDB, but the note *is* this Markdown string — exports are
byte-identical to what the app reads.

## Tests

```bash
npm test          # 77 unit tests (format, checklist, search, prompt output, zip, import)
npm run test:e2e  # 99 browser checks (needs: npm i -D playwright)
```

The e2e test mocks the LLM endpoint, so it needs no API key. It covers capture,
processing, preview editing, re-processing, maybe-later, the done bucket and undo,
batch runs, search, date filters, raw-dump mode, custom prompt, export, import
(including deflated archives and conflict handling), offline behaviour, and error
paths.

## Not built yet

- **Sync between devices.** Each browser profile is its own dataset. Moving notes
  is manual: export on one device, import on the other.
- Reminders/notifications, tags, projects, recurrence.

## Layout

```
index.html               single page, five views
app.css                  all styles (light + dark)
manifest.webmanifest     PWA metadata
sw.js                    offline shell cache (network-first, cache fallback)
js/app.js                routing, views, event wiring
js/note.js               document format, checklist states, sections   (pure)
js/search.js             search tokens + date windows                 (pure)
js/llm.js                OpenAI-compatible client + normalisation     (pure)
js/render.js             Markdown-subset renderer, escaped + highlight (pure)
js/importer.js           import planning, conflict policy              (pure)
js/zip.js                ZIP writer + reader (stored + deflate)        (pure)
js/store.js              IndexedDB persistence
js/settings.js           localStorage settings
scripts/serve.js         static server for local/LAN use
tests/                   unit tests + optional browser smoke test
```
