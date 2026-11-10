import { SCORING_DEFAULTS } from "./score.js";
import { emptyBlocklist } from "./blocklist.js";

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

export const DEFAULT_SOURCES = { raindrop: true, highlights: true, bookmarks: false, hnfav: false, history: false };

export const DEFAULT_SETTINGS = {
  theme: "auto",
  layer: true,             // the in-page layer on Hacker News; off shows plain HN
  order: "hamsa",          // hamsa | hn: order of the merged front page
  scoring: { ...SCORING_DEFAULTS },
  sources: { ...DEFAULT_SOURCES },
  hnUser: "",              // read from the page when you are logged in
  gate: true,              // comments below the interest floor do not reach the model
  karma: true,             // read author karma from HN's public API
  readingLog: true,        // remember what you open (stays in this browser) and use it as a signal
  linkTarget: "same",      // same | new | background: where story links open
  threadView: "survivors", // survivors | tree
  threadSort: "best",      // best | relevance | thread
  collapseTossed: false,   // tree view: hide the folds of tossed and removed comments entirely
  titleFont: "system",     // system | inter | literata | source-serif | atkinson | plex-mono
  textSize: "m",           // s | m | l | xl
  width: "normal",         // narrow | normal | wide
  justify: false,
  density: "comfortable",  // comfortable | compact
  darkStyle: "warm",       // warm | neutral | black
  syncFirefox: false,      // keep settings, likes and blocklist in step through Firefox Sync
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

// Everything except the tag graph and the summary cache, which can run to megabytes. The background
// keeps the graph in memory (see loadGraph in background.js); pages never need it.
export async function getState() {
  const s = await api.storage.local.get({ providers: [], settings: {}, profile: null, blocklist: null, dismissed: [], raindropToken: "", usage: {}, usageDaily: {} });
  const raw = { ...(s.settings || {}) };
  if (raw.font === "serif") raw.font = "source-serif"; // 0.2 values
  if (raw.font === "mono") raw.font = "plex-mono";
  s.settings = { ...DEFAULT_SETTINGS, ...raw, scoring: { ...SCORING_DEFAULTS, ...(raw.scoring || {}) }, sources: { ...DEFAULT_SOURCES, ...(raw.sources || {}) } };
  s.blocklist = s.blocklist || emptyBlocklist();
  return s;
}
export const save = (obj) => api.storage.local.set(obj);

export async function patchSettings(patch) {
  const { settings = {} } = await api.storage.local.get("settings");
  await api.storage.local.set({ settings: { ...settings, ...patch } });
}

export function newProvider(preset) {
  return { id: crypto.randomUUID(), name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, apiKey: "", models: [] };
}

// Cached summaries by thread id, so re-opening a thread costs nothing. Oldest entries go first.
const CACHE_MAX = 60;
export async function cacheGet(id) {
  const { cache = {} } = await api.storage.local.get("cache");
  return cache[id] || null;
}
export async function cachePut(id, entry) {
  const { cache = {} } = await api.storage.local.get("cache");
  cache[id] = { ...entry, at: Date.now() };
  for (const k of Object.keys(cache).sort((a, b) => cache[a].at - cache[b].at).slice(0, Math.max(0, Object.keys(cache).length - CACHE_MAX))) delete cache[k];
  await api.storage.local.set({ cache });
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
