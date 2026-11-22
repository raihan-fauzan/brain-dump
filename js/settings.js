// Settings live in localStorage: the same browser holds the notes and the key.

import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./llm.js";

const KEY = "brain-dump:settings";

const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  apiKey: "",
  prompt: "",
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function hasApiKey(settings = loadSettings()) {
  return Boolean(String(settings.apiKey || "").trim());
}
