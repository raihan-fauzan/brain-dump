import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBaseUrl,
  chatEndpoint,
  stripCodeFence,
  normalizeOutput,
  processDump,
  DEFAULT_BASE_URL,
} from "../js/llm.js";

test("normalizeBaseUrl handles empty, trailing slashes, and pasted endpoints", () => {
  assert.equal(normalizeBaseUrl(""), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl("  "), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1/"), "http://localhost:11434/v1");
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("http://localhost:1234/v1/chat/completions/"), "http://localhost:1234/v1");
});

test("chatEndpoint builds the standard path", () => {
  assert.equal(chatEndpoint("https://api.groq.com/openai/v1"), "https://api.groq.com/openai/v1/chat/completions");
});

test("stripCodeFence removes wrapping fences", () => {
  assert.equal(stripCodeFence("```markdown\n## Tasks\n```"), "## Tasks");
  assert.equal(stripCodeFence("```\nhello\n```"), "hello");
  assert.equal(stripCodeFence("## Tasks"), "## Tasks");
});

test("normalizeOutput keeps a well-formed answer intact", () => {
  const out = normalizeOutput("## Tasks\n- [ ] buy milk\n\n## Notes\n- shop closes at 6");
  assert.equal(out, "## Tasks\n- [ ] buy milk\n\n## Notes\n- shop closes at 6\n");
});

test("normalizeOutput converts plain bullets into checkboxes", () => {
  const out = normalizeOutput("## Tasks\n- buy milk\n* call mum\n\n## Notes\n- some note");
  assert.match(out, /- \[ \] buy milk/);
  assert.match(out, /- \[ \] call mum/);
  assert.match(out, /- some note/);
});

test("normalizeOutput resets checked tasks to open", () => {
  const out = normalizeOutput("## Tasks\n- [x] already done\n\n## Notes");
  assert.match(out, /- \[ \] already done/);
  assert.doesNotMatch(out, /\[x\]/);
});

test("normalizeOutput never loses content when headings are missing", () => {
  const raw = "The model just rambled about three things.\nSecond point.";
  const out = normalizeOutput(raw);
  assert.match(out, /^## Tasks/);
  assert.match(out, /## Notes/);
  assert.ok(out.includes("The model just rambled about three things."), "first line preserved");
  assert.ok(out.includes("Second point."), "second line preserved");
});

test("normalizeOutput strips the model's own preamble headings", () => {
  const out = normalizeOutput("### Brain dump processed\n## Tasks\n- [ ] x\n## Notes\n- y");
  assert.doesNotMatch(out, /Brain dump processed/);
  assert.match(out, /- \[ \] x/);
});

test("normalizeOutput tolerates an empty task section", () => {
  const out = normalizeOutput("## Tasks\n\n## Notes\n- only reference");
  assert.equal(out, "## Tasks\n\n## Notes\n- only reference\n");
});

test("normalizeOutput strips fences before parsing", () => {
  const out = normalizeOutput("```markdown\n## Tasks\n- [ ] fenced\n\n## Notes\n```");
  assert.equal(out, "## Tasks\n- [ ] fenced\n\n## Notes\n");
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("processDump posts an OpenAI-compatible request and returns normalized markdown", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse({
      choices: [{ message: { content: "## Tasks\n- [ ] do the thing\n\n## Notes\n- context" } }],
    });
  };

  const out = await processDump({
    raw: "I need to do the thing",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    fetchImpl,
  });

  assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content, "I need to do the thing");
  assert.match(out, /- \[ \] do the thing/);
});

test("processDump refuses to run without a key", async () => {
  await assert.rejects(
    () => processDump({ raw: "x", baseUrl: "", apiKey: "  ", model: "m", fetchImpl: async () => jsonResponse({}) }),
    /No API key/,
  );
});

test("processDump surfaces provider errors with a hint", async () => {
  const fetchImpl = async () =>
    jsonResponse({ error: { message: "Invalid API key provided" } }, 401);
  await assert.rejects(
    () => processDump({ raw: "x", baseUrl: "", apiKey: "k", model: "m", fetchImpl }),
    /401.*API key.*Invalid API key provided/,
  );
});

test("processDump errors on an empty completion", async () => {
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: "   " } }] });
  await assert.rejects(
    () => processDump({ raw: "x", baseUrl: "", apiKey: "k", model: "m", fetchImpl }),
    /empty response/,
  );
});

test("processDump uses a custom prompt when one is provided", async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: "## Tasks\n\n## Notes" } }] });
  };
  await processDump({
    raw: "x",
    baseUrl: "",
    apiKey: "k",
    model: "m",
    prompt: "  Extract only people.  ",
    fetchImpl,
  });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "Extract only people.");
});

test("processDump falls back to the built-in prompt when the custom one is blank", async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: "## Tasks\n\n## Notes" } }] });
  };
  await processDump({ raw: "x", baseUrl: "", apiKey: "k", model: "m", prompt: "   ", fetchImpl });
  assert.ok(body.messages[0].content.includes("## Tasks"));
  assert.ok(body.messages[0].content.includes("Never invent tasks"));
});

test("processDump turns network failures into a readable message", async () => {
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    () => processDump({ raw: "x", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", fetchImpl }),
    /offline|reach the provider/,
  );
});

test("processDump passes aborts through untouched", async () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  await assert.rejects(
    () =>
      processDump({
        raw: "x",
        baseUrl: "",
        apiKey: "k",
        model: "m",
        fetchImpl: async () => {
          throw abort;
        },
      }),
    /aborted/,
  );
});

test("processDump falls back to the default model when blank", async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: "## Tasks\n## Notes" } }] });
  };
  await processDump({ raw: "x", baseUrl: "", apiKey: "k", model: "", fetchImpl });
  assert.equal(body.model, "gpt-4o-mini");
});
