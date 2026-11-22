// Tiny renderer for our own Markdown subset. Everything is escaped; no HTML
// from notes is ever trusted or injected.

import { parseTaskLine, PROCESSED_MARKER } from "./note.js";

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function checkbox(checked, attrs = "") {
  return `<input type="checkbox"${checked ? " checked" : ""} ${attrs}>`;
}

/** Escape text, then wrap search matches in <mark>. */
export function highlightHtml(text, tokens = []) {
  const source = String(text ?? "");
  const escapedTokens = tokens
    .filter((t) => t && t.trim())
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escapedTokens.length) return escapeHtml(source);

  const re = new RegExp(`(${escapedTokens.join("|")})`, "gi");
  return source
    .split(re)
    .map((part, i) => (i % 2 ? `<mark class="hit">${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join("");
}

/**
 * Render a note document to HTML.
 * @param {string} doc
 * @param {{linkTasks?: boolean, skipTitle?: boolean}} opts
 *   linkTasks: checkboxes carry data-line so they can be toggled
 *   skipTitle: drop the leading "# title" heading (the page already shows it)
 */
export function renderDocument(doc, opts = {}) {
  const lines = doc.split("\n");
  const out = [];
  let listOpen = false;
  let paragraph = [];
  let seenFirstLine = false;

  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(escapeHtml).join("\n")}</p>`);
      paragraph = [];
    }
  };

  lines.forEach((line, index) => {
    if (line.includes(PROCESSED_MARKER)) {
      flushParagraph();
      closeList();
      if (opts.showDivider !== false) {
        out.push('<hr class="processed-divider">');
      }
      return;
    }

    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      closeList();
      return;
    }

    const isFirstLine = !seenFirstLine;
    seenFirstLine = true;

    if (isFirstLine && opts.skipTitle && /^#\s/.test(trimmed)) {
      return;
    }

    if (/^###\s/.test(trimmed)) {
      flushParagraph();
      closeList();
      out.push(`<h3>${escapeHtml(trimmed.replace(/^###\s*/, ""))}</h3>`);
      return;
    }
    if (/^##\s/.test(trimmed)) {
      flushParagraph();
      closeList();
      out.push(`<h2>${escapeHtml(trimmed.replace(/^##\s*/, ""))}</h2>`);
      return;
    }
    if (/^#\s/.test(trimmed)) {
      flushParagraph();
      closeList();
      out.push(`<h1>${escapeHtml(trimmed.replace(/^#\s*/, ""))}</h1>`);
      return;
    }

    const task = parseTaskLine(line);
    if (task) {
      flushParagraph();
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      const attrs = opts.linkTasks ? `data-line="${index}"` : "disabled";
      const laterBtn = opts.linkTasks
        ? `<button type="button" class="later-btn" data-line="${index}" aria-pressed="${
            task.later ? "true" : "false"
          }" title="${task.later ? "Move back to todo" : "Move to maybe later"}">${
            task.later ? "To do" : "Later"
          }</button>`
        : "";
      out.push(
        `<li class="task-row${task.done ? " checked" : ""}${task.later ? " later" : ""}">` +
          checkbox(task.done, attrs) +
          `<span class="task-text">${escapeHtml(task.text)}</span>` +
          laterBtn +
          "</li>",
      );
      return;
    }

    if (/^[-*]\s/.test(trimmed)) {
      flushParagraph();
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li class="task-row plain"><span class="task-text">${escapeHtml(trimmed.replace(/^[-*]\s*/, ""))}</span></li>`);
      return;
    }

    paragraph.push(line);
  });

  flushParagraph();
  closeList();
  return out.join("\n");
}

/** A single task row used by the cross-note tasks view. */
export function renderTaskRow({ noteId, lineIndex, text, done, later, showLater = true }) {
  return (
    `<div class="task-row${done ? " checked" : ""}${later ? " later" : ""}">` +
    `<input type="checkbox"${done ? " checked" : ""} data-note="${escapeHtml(noteId)}" data-line="${lineIndex}">` +
    `<span class="task-text">${escapeHtml(text)}</span>` +
    (showLater
      ? `<button type="button" class="later-btn" data-note="${escapeHtml(noteId)}" data-line="${lineIndex}" aria-pressed="${
          later ? "true" : "false"
        }">${later ? "To do" : "Later"}</button>`
      : "") +
    "</div>"
  );
}
