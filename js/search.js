// Search + date filtering. Pure functions, no DOM, no storage.

export const RANGES = ["all", "today", "7d", "30d", "month", "custom"];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();

/**
 * Time window for a preset.
 * @returns {{from: number, to: number} | null} null means "no limit"
 */
export function dateBounds(range, now = new Date()) {
  const today = startOfDay(now);
  switch (range) {
    case "today":
      return { from: today, to: addDays(now, 1) };
    case "7d":
      return { from: addDays(now, -6), to: addDays(now, 1) };
    case "30d":
      return { from: addDays(now, -29), to: addDays(now, 1) };
    case "month":
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
        to: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
      };
    default:
      return null;
  }
}

/**
 * Window for two `type="date"` values (`YYYY-MM-DD`). The end date is inclusive.
 * Missing values leave that side open.
 */
export function customBounds(fromStr, toStr) {
  const parse = (s, endOfDay) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) return null;
    return endOfDay ? addDays(d, 1) : startOfDay(d);
  };
  const from = parse(fromStr, false);
  const to = parse(toStr, true);
  if (from === null && to === null) return null;
  return { from: from ?? 0, to: to ?? Number.POSITIVE_INFINITY };
}

/** Lowercase, strip accents, collapse whitespace. */
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a raw query into normalized tokens. Empty query -> no tokens. */
export function tokenize(query) {
  const n = normalize(query);
  return n ? n.split(" ").filter(Boolean) : [];
}

/** Every token must appear somewhere in the text (AND semantics). */
export function matchesQuery(text, tokens) {
  if (!tokens || tokens.length === 0) return true;
  const haystack = normalize(text);
  return tokens.every((t) => haystack.includes(t));
}

export function inWindow(timestamp, bounds) {
  if (!bounds) return true;
  return timestamp >= bounds.from && timestamp < bounds.to;
}

/**
 * Filter entries shaped like `{ text, createdAt }`.
 * @param {{tokens?: string[], bounds?: {from:number,to:number}|null}} filters
 */
export function filterEntries(entries, { tokens = [], bounds = null } = {}) {
  return entries.filter(
    (e) => inWindow(e.createdAt, bounds) && matchesQuery(e.text, tokens),
  );
}
