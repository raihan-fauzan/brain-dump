// OpenAI-compatible chat client. Calls the provider directly from the browser
// using the key the user supplied. No proxy, no middleman.

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";

export const SYSTEM_PROMPT = `You organize a person's brain dump. You separate what is actionable from what is only reference.

Rules:
- Use only content from the dump. Never invent tasks, facts, advice, or deadlines.
- Preserve every distinct idea, fact, worry, question, and reminder somewhere in the output. If unsure whether something is actionable, put it in Notes.
- A task is a concrete action the person could do. Write tasks as short imperative phrases in the person's own words where possible.
- Output exactly two sections, in this order, with these exact headings:

## Tasks
- [ ] first task
- [ ] second task

## Notes
- a reference note
- another reference note

- Every task line must start with "- [ ] ". Nothing else belongs in the Tasks section.
- If there are no tasks, still output the "## Tasks" heading with nothing under it.
- Never use "- [x]".
- Keep the language the dump was written in.
- Output Markdown only: no code fences, no preamble, no closing remarks, no commentary about your process.`;

export function normalizeBaseUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return DEFAULT_BASE_URL;
  return v.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

export function chatEndpoint(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

/** Strip a wrapping ```markdown fence if the model added one anyway. */
export function stripCodeFence(text) {
  const t = text.trim();
  const m = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

/** Coerce arbitrary model output into our two-section format without losing text. */
export function normalizeOutput(text) {
  const clean = stripCodeFence(text);
  const tasksIdx = clean.search(/^##\s*Tasks\s*$/im);
  const notesIdx = clean.search(/^##\s*Notes\s*$/im);

  if (tasksIdx === -1 && notesIdx === -1) {
    // Model ignored the format: keep everything, but demote it to Notes so nothing is lost.
    const bullets = clean
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (l.startsWith("- ") ? l : `- ${l.replace(/^[*•]\s*/, "")}`));
    return assemble([], bullets);
  }

  const sections = { tasks: [], notes: [] };
  const lines = clean.split("\n");
  let current = null;

  for (const line of lines) {
    if (/^##\s*Tasks\s*$/i.test(line)) {
      current = "tasks";
      continue;
    }
    if (/^##\s*Notes\s*$/i.test(line)) {
      current = "notes";
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue; // drop stray headings
    if (current) sections[current].push(line);
  }

  const tasks = sections.tasks
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^[-*]\s*\[[ xX/]?\]\s*(.+)$/.exec(l) || /^[-*]\s*(.+)$/.exec(l);
      const text = (m ? m[1] : l).trim();
      return text ? `- [ ] ${text}` : null;
    })
    .filter(Boolean);

  const notes = sections.notes
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^[-*]\s*(.+)$/.exec(l);
      const text = (m ? m[1] : l).trim();
      return text ? `- ${text}` : null;
    })
    .filter(Boolean);

  return assemble(tasks, notes);
}

/** Join the two sections with exactly the blank lines we want. */
function assemble(tasks, notes) {
  const parts = ["## Tasks"];
  if (tasks.length) parts.push(tasks.join("\n"));
  parts.push("", "## Notes");
  if (notes.length) parts.push(notes.join("\n"));
  return `${parts.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Send a brain dump to the model and return normalized Markdown.
 * @param {{raw: string, baseUrl: string, apiKey: string, model: string, prompt?: string, signal?: AbortSignal, fetchImpl?: typeof fetch}} opts
 */
export async function processDump({ raw, baseUrl, apiKey, model, prompt, signal, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const key = (apiKey || "").trim();
  if (!key) throw new Error("No API key set. Add one in Settings.");

  const systemPrompt = (prompt || "").trim() || SYSTEM_PROMPT;

  const res = await doFetch(chatEndpoint(baseUrl), {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: (model || "").trim() || DEFAULT_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: raw },
      ],
    }),
  }).catch((err) => {
    // A dropped connection can surface as AbortError with an empty message, so
    // never rethrow a blank error — the UI must always have something to show.
    if (err?.name === "AbortError" && !String(err.message || "").trim()) {
      throw new Error(
        "The request was interrupted. You may be offline — processing needs a connection.",
      );
    }
    if (err?.name === "AbortError") throw err;
    // Network-level failure: offline, DNS, CORS preflight, bad base URL.
    throw new Error(
      "Couldn't reach the provider. You may be offline, or the base URL is wrong.",
    );
  });

  if (!res.ok) {
    throw new Error(await describeError(res));
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The model returned an empty response. Try again or check the model name.");
  }
  return normalizeOutput(content);
}

async function describeError(res) {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.message || text;
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  const trimmed = String(detail || "").slice(0, 300).trim();
  const hint =
    res.status === 401
      ? " (check your API key)"
      : res.status === 404
        ? " (check the base URL and model name)"
        : res.status === 429
          ? " (rate limited or out of quota)"
          : "";
  return `Provider error ${res.status}${hint}${trimmed ? `: ${trimmed}` : ""}`;
}
