import { SCORING_DEFAULTS } from "./score.js";
import { emptyBlocklist } from "./blocklist.js";
import { bigGet, bigSet } from "./idb.js";

export const api = globalThis.browser ?? globalThis.chrome;

// Base URLs are provider defaults; verify against the provider's docs if one stops working.
export const PRESETS = [
  { name: "Claude (Anthropic)", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { name: "Gemini (Google)", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
  { name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1" },
  { name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com" },
  { name: "Grok (xAI)", kind: "openai", baseUrl: "https://api.x.ai/v1" },
  { name: "Qwen (DashScope Intl)", kind: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "Together", kind: "openai", baseUrl: "https://api.together.xyz/v1" },
  { name: "Fireworks", kind: "openai", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1" },
  { name: "LM Studio (local)", kind: "openai", baseUrl: "http://localhost:1234/v1" },
  { name: "Custom (OpenAI-compatible)", kind: "openai", baseUrl: "" },
];

export const DEFAULT_SOURCES = { raindrop: true, highlights: true, bookmarks: false, hnfav: false };

export const DEFAULT_SETTINGS = {
  theme: "auto",
  layer: true,             // the in-page layer on Hacker News; off shows plain HN
  order: "hamsa",          // hamsa | hn: order of the merged front page
  scoring: { ...SCORING_DEFAULTS },
  sources: { ...DEFAULT_SOURCES },
  hnUser: "",              // read from the page when you are logged in
  gate: true,              // comments below the interest floor do not reach the model
  karma: true,             // read author karma from HN's public API (threads only; never on the front page)
  hnHistory: false,        // "Before this thread" through the Algolia HN API (needs its own permission)
  mutedKinds: [],          // strand kinds hidden in every thread: debate | experience | explainer | alternatives | stance | meta | discussion
  readingLog: true,        // remember what you open (stays in this browser) and use it as a signal
  linkTarget: "same",      // same | new | background: where story links open
  threadView: "survivors", // survivors | tree
  threadSort: "best",      // best | relevance | thread
  collapseTossed: false,   // tree view: hide the folds of tossed and removed comments entirely
  titleFont: "system",     // system | inter | literata | source-serif | atkinson | plex-mono
  textSize: "m",           // s | m | l | xl
  width: "normal",         // narrow | normal | wide | full
  justify: false,
  density: "comfortable",  // comfortable | compact
  darkStyle: "warm",       // warm | neutral | black
  syncFirefox: false,      // keep settings, likes and blocklist in step through Firefox Sync
  previews: true,          // link preview cards (needs the optional all-sites permission)
  previewImages: true,     // show the image a page declares in its preview
  quoteColours: "bright",  // colours for quotes and names in threads
  skin: true,              // theme the plain HN pages Hamsa does not redraw (profiles, replies, Original view)
  font: "system",          // body font: system | inter | literata | source-serif | atkinson | plex-mono
  budgetTokens: 30000,
  maxOutputTokens: 1500,
  fx: 95,                  // INR per USD
  priceOverrides: {},      // model id -> { in, out } USD per million tokens
  extraInterests: "",      // free text added to the interests the model sees
  excludedTags: [],        // tags treated as not-a-topic, on top of the built-in list
  learning: "implicit",    // implicit | thumbs | off
  raindropSave: true,
  active: { providerId: null, model: null },
  thumbsDefault: false,
};

// Settings and the small state. The tag graph, caches and logs live in IndexedDB (idb.js). The
// interest profile can run to hundreds of KB, so the background asks for it separately and keeps it
// in memory (withProfile: false).
export async function getState({ withProfile = true } = {}) {
  const want = { providers: [], settings: {}, blocklist: null, dismissed: [], raindropToken: "", usage: {}, usageDaily: {} };
  if (withProfile) want.profile = null;
  const s = await api.storage.local.get(want);
  const raw = { ...(s.settings || {}) };
  if (raw.font === "serif") raw.font = "source-serif"; // 0.2 values
  if (raw.font === "mono") raw.font = "plex-mono";
  s.settings = { ...DEFAULT_SETTINGS, ...raw, scoring: { ...SCORING_DEFAULTS, ...(raw.scoring || {}) }, sources: { ...DEFAULT_SOURCES, ...(raw.sources || {}) } };
  s.blocklist = s.blocklist || emptyBlocklist();
  return s;
}
export const save = (obj) => api.storage.local.set(obj);

// Settings are read, changed and written back, so two changes at once could lose one. Every change made
// on this page or in the background goes through one queue.
let settingsQueue = Promise.resolve();
export function patchSettings(patch) {
  const run = settingsQueue.then(async () => {
    const { settings = {} } = await api.storage.local.get("settings");
    await api.storage.local.set({ settings: { ...settings, ...patch } });
  });
  settingsQueue = run.catch(() => {});
  return run;
}

export function newProvider(preset) {
  return { id: crypto.randomUUID(), name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, apiKey: "", models: [] };
}

// Cached summaries by thread id, so re-opening a thread costs nothing. Oldest entries go first.
const CACHE_MAX = 60;
export async function cacheGet(id) {
  const cache = await bigGet("cache", {});
  return cache[id] || null;
}
export async function cachePut(id, entry) {
  const cache = { ...(await bigGet("cache", {})) };
  cache[id] = { ...entry, at: Date.now() };
  for (const k of Object.keys(cache).sort((a, b) => cache[a].at - cache[b].at).slice(0, Math.max(0, Object.keys(cache).length - CACHE_MAX))) delete cache[k];
  await bigSet("cache", cache);
}

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function addUsage(providerName, model, input, output, usd = 0) {
  const { usage = {}, usageDaily = {} } = await api.storage.local.get(["usage", "usageDaily"]);
  const key = `${providerName}::${model}`;
  const u = usage[key] || { requests: 0, input: 0, output: 0 };
  u.requests += 1; u.input += input || 0; u.output += output || 0; u.last = Date.now();
  usage[key] = u;
  const day = today();
  const d = usageDaily[day] || { runs: 0, input: 0, output: 0, usd: 0 };
  d.runs += 1; d.input += input || 0; d.output += output || 0; d.usd += usd || 0;
  usageDaily[day] = d;
  for (const k of Object.keys(usageDaily).sort().slice(0, -60)) delete usageDaily[k]; // keep two months
  await api.storage.local.set({ usage, usageDaily });
}

export async function todayUsage() {
  const { usageDaily = {} } = await api.storage.local.get("usageDaily");
  return usageDaily[today()] || { runs: 0, input: 0, output: 0, usd: 0 };
}

export function applyTheme(theme, font) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme); else root.removeAttribute("data-theme");
  root.setAttribute("data-font", font || "system");
  try { localStorage.setItem("hamsa-theme", theme === "light" || theme === "dark" ? theme : "auto"); } catch { /* storage unavailable */ }
}
