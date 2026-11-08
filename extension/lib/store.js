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

export const DEFAULT_SETTINGS = {
  theme: "auto",
  font: "system",          // system | serif | mono
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

export async function getState() {
  const s = await api.storage.local.get({ providers: [], settings: {}, graph: null, raindropToken: "", cache: {}, usage: {} });
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
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

export async function addUsage(providerName, model, input, output) {
  const { usage = {} } = await api.storage.local.get("usage");
  const key = `${providerName}::${model}`;
  const u = usage[key] || { requests: 0, input: 0, output: 0 };
  u.requests += 1; u.input += input || 0; u.output += output || 0; u.last = Date.now();
  usage[key] = u;
  await api.storage.local.set({ usage });
}

export function applyTheme(theme, font) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme); else root.removeAttribute("data-theme");
  root.setAttribute("data-font", font || "system");
  try { localStorage.setItem("hamsa-theme", theme === "light" || theme === "dark" ? theme : "auto"); } catch { /* storage unavailable */ }
}
