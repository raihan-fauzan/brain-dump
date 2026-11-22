import test from "node:test";
import assert from "node:assert/strict";

import {
  RANGES,
  dateBounds,
  customBounds,
  normalize,
  tokenize,
  matchesQuery,
  inWindow,
  filterEntries,
} from "../js/search.js";

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);

test("dateBounds: today covers exactly one day", () => {
  const b = dateBounds("today", at(2026, 11, 22, 15));
  assert.equal(new Date(b.from).getDate(), 22);
  assert.equal(new Date(b.from).getHours(), 0);
  assert.equal(new Date(b.to).getDate(), 23);
});

test("dateBounds: 7d includes today plus six days back", () => {
  const now = at(2026, 11, 22);
  const b = dateBounds("7d", now);
  assert.equal(new Date(b.from).getDate(), 16);
  assert.equal(new Date(b.to).getDate(), 23);
});

test("dateBounds: 30d spans 30 days", () => {
  const b = dateBounds("30d", at(2026, 11, 22));
  const days = Math.round((b.to - b.from) / 86400000);
  assert.equal(days, 30);
});

test("dateBounds: month covers the calendar month", () => {
  const b = dateBounds("month", at(2026, 11, 22));
  assert.equal(new Date(b.from).getMonth(), 10);
  assert.equal(new Date(b.from).getDate(), 1);
  assert.equal(new Date(b.to).getMonth(), 11);
  assert.equal(new Date(b.to).getDate(), 1);
});

test("dateBounds: all time has no window", () => {
  assert.equal(dateBounds("all"), null);
  assert.ok(RANGES.includes("all"));
});

test("customBounds is inclusive of the end date", () => {
  const b = customBounds("2026-11-01", "2026-11-22");
  assert.equal(b.from, new Date(2026, 10, 1).getTime());
  assert.equal(b.to, new Date(2026, 10, 23).getTime(), "end date + 1 day");
  assert.ok(inWindow(new Date(2026, 10, 22, 23, 59).getTime(), b));
  assert.ok(!inWindow(new Date(2026, 10, 23, 0, 1).getTime(), b));
});

test("customBounds tolerates open sides", () => {
  const onlyFrom = customBounds("2026-11-01", "");
  assert.equal(onlyFrom.from, new Date(2026, 10, 1).getTime());
  assert.ok(inWindow(Date.now(), onlyFrom));

  const onlyTo = customBounds("", "2026-11-01");
  assert.equal(onlyTo.to, new Date(2026, 10, 2).getTime());

  assert.equal(customBounds("", ""), null);
  assert.equal(customBounds("not-a-date", ""), null);
});

test("normalize strips accents, case, and extra whitespace", () => {
  assert.equal(normalize("  Café   Au Lait "), "cafe au lait");
  assert.equal(normalize("Email  SAM"), "email sam");
  assert.equal(normalize(null), "");
});

test("tokenize splits into normalized tokens", () => {
  assert.deepEqual(tokenize("  Dentist   FRIDAY "), ["dentist", "friday"]);
  assert.deepEqual(tokenize(""), []);
});

test("matchesQuery uses AND semantics across tokens", () => {
  const tokens = tokenize("sam invoice");
  assert.ok(matchesQuery("Email Sam about the invoice", tokens));
  assert.ok(!matchesQuery("Email Sam about the budget", tokens));
  assert.ok(matchesQuery("anything", []), "empty query matches everything");
});

test("matchesQuery is accent-insensitive both ways", () => {
  assert.ok(matchesQuery("café run", tokenize("cafe")));
  assert.ok(matchesQuery("cafe run", tokenize("café")));
});

test("filterEntries applies window and query together", () => {
  const entries = [
    { text: "sam invoice", createdAt: new Date(2026, 10, 20).getTime() },
    { text: "sam budget", createdAt: new Date(2026, 10, 20).getTime() },
    { text: "sam invoice old", createdAt: new Date(2026, 9, 1).getTime() },
  ];
  const bounds = customBounds("2026-11-01", "2026-11-30");

  assert.equal(filterEntries(entries, { tokens: tokenize("sam"), bounds }).length, 2);
  assert.equal(filterEntries(entries, { tokens: tokenize("invoice"), bounds }).length, 1);
  assert.equal(filterEntries(entries, {}).length, 3);
  assert.equal(filterEntries(entries, { tokens: tokenize("nothing") }).length, 0);
});
