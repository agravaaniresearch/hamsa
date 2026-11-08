// Provider adapters. Three wire formats cover every provider:
//   "openai"    any OpenAI-compatible /chat/completions endpoint (OpenAI, DeepSeek, xAI, Qwen, Mistral,
//               Groq, OpenRouter, Together, Fireworks, Ollama, LM Studio, custom)
//   "anthropic" Anthropic's native /v1/messages endpoint
//   "gemini"    Google's native generateContent endpoint
// One non-streaming call returns structured JSON. If a provider rejects its structured-output mode,
// the call falls back one step at a time and the result is checked by the caller either way.
import { parseModelJson } from "./summarise.js";

const ANTHROPIC_VERSION = "2023-06-01";

export function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}
export function originPattern(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.host}/*`;
}
const anthropicBase = (b) => trimSlash(b).replace(/\/v1$/, "");
const geminiBase = (b) => trimSlash(b).replace(/\/v1(beta)?$/, "");

export function authHeaders(p) {
  if (p.kind === "anthropic") {
    return { "x-api-key": p.apiKey || "", "anthropic-version": ANTHROPIC_VERSION, "anthropic-dangerous-direct-browser-access": "true" };
  }
  if (p.kind === "gemini") return { "x-goog-api-key": p.apiKey || "" };
  return p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
}

// JSON Schema (lowercase) -> Gemini's OpenAPI subset (uppercase types, no additionalProperties).
export function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "additionalProperties") continue;
    out[k] = k === "type" ? String(v).toUpperCase() : toGeminiSchema(v);
  }
  return out;
}

const SCHEMA_NAME = "hamsa_summary";

// Requests in order of preference. Each is { id, url, headers, body } and parseReply(kind, json) reads it.
export function buildRequests(provider, { model, system, user, schema, maxTokens = 1500 }) {
  const headers = { ...authHeaders(provider), "content-type": "application/json" };
  if (provider.kind === "anthropic") {
    return [{
      id: "tool",
      url: `${anthropicBase(provider.baseUrl)}/v1/messages`,
      headers,
      body: {
        model, max_tokens: maxTokens, temperature: 0.3, system,
        messages: [{ role: "user", content: user }],
        tools: [{ name: SCHEMA_NAME, description: "Return the thread summary.", input_schema: schema }],
        tool_choice: { type: "tool", name: SCHEMA_NAME },
      },
    }];
  }
  if (provider.kind === "gemini") {
    const gen = { temperature: 0.3, maxOutputTokens: maxTokens, responseMimeType: "application/json" };
    const base = {
      url: `${geminiBase(provider.baseUrl)}/v1beta/models/${model.replace(/^models\//, "")}:generateContent`,
      headers,
    };
    const body = (g) => ({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: g });
    return [
      { id: "schema", ...base, body: body({ ...gen, responseSchema: toGeminiSchema(schema) }) },
      { id: "json", ...base, body: body(gen) },
    ];
  }
  const msgs = [{ role: "system", content: system }, { role: "user", content: user }];
  const url = `${trimSlash(provider.baseUrl)}/chat/completions`;
  return [
    { id: "json_schema", url, headers, body: { model, messages: msgs, temperature: 0.3, max_tokens: maxTokens, response_format: { type: "json_schema", json_schema: { name: SCHEMA_NAME, schema, strict: false } } } },
    { id: "json_object", url, headers, body: { model, messages: msgs, temperature: 0.3, max_tokens: maxTokens, response_format: { type: "json_object" } } },
    { id: "plain", url, headers, body: { model, messages: [...msgs.slice(0, 1), { role: "user", content: `${user}\n\nReturn only a JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}` }], temperature: 0.3, max_tokens: maxTokens } },
  ];
}

// -> { text | object, usage: { input, output } }
export function parseReply(kind, j) {
  if (kind === "anthropic") {
    const tool = (j.content || []).find((b) => b.type === "tool_use");
    const u = j.usage || {};
    const usage = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0 };
    if (tool) return { object: tool.input, usage };
    return { text: (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""), usage };
  }
  if (kind === "gemini") {
    const cand = j.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) throw new Error(`Gemini returned no text${cand?.finishReason ? ` (${cand.finishReason})` : ""}.`);
    const u = j.usageMetadata || {};
    return { text, usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
  }
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const text = j.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text) throw new Error("The provider returned no text.");
  const u = j.usage || {};
  return { text, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 } };
}

export async function describeError(res) {
  let text = "";
  try { text = await res.text(); } catch { /* ignore */ }
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.message || (typeof j.error === "string" ? j.error : text);
  } catch { /* not JSON */ }
  msg = String(msg || "").slice(0, 300);
  return `${res.status} ${res.statusText}${msg ? `: ${msg}` : ""}`;
}

// A 400 or 422 that names the structured-output feature means "try the next mode".
const unsupported = (status, text) => (status === 400 || status === 422 || status === 404) && /response_format|json_schema|json_object|responseSchema|responseMimeType|schema|tool_choice|not support|unsupported/i.test(text);

export async function completeJSON({ provider, model, system, user, schema, maxTokens, signal, fetchImpl = fetch }) {
  const reqs = buildRequests(provider, { model, system, user, schema, maxTokens });
  let last = null;
  for (const req of reqs) {
    const res = await fetchImpl(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal });
    if (!res.ok) {
      const text = await res.clone().text().catch(() => "");
      if (reqs.indexOf(req) < reqs.length - 1 && unsupported(res.status, text)) { last = await describeError(res); continue; }
      throw new Error(await describeError(res));
    }
    const out = parseReply(provider.kind, await res.json());
    return { object: out.object ?? parseModelJson(out.text), usage: out.usage, mode: req.id };
  }
  throw new Error(last || "No structured-output mode worked for this provider.");
}

export function estimateTokens(text) {
  let ascii = 0, other = 0;
  for (const ch of String(text || "")) (ch.charCodeAt(0) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other / 1.5);
}

export async function listModels(provider, fetchImpl = fetch) {
  let url;
  if (provider.kind === "anthropic") url = `${anthropicBase(provider.baseUrl)}/v1/models?limit=100`;
  else if (provider.kind === "gemini") url = `${geminiBase(provider.baseUrl)}/v1beta/models?pageSize=200`;
  else url = `${trimSlash(provider.baseUrl)}/models`;
  const res = await fetchImpl(url, { headers: authHeaders(provider) });
  if (!res.ok) throw new Error(await describeError(res));
  const j = await res.json();
  const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  return list.map((m) => (typeof m === "string" ? m : (m.id || m.name || "").replace(/^models\//, ""))).filter(Boolean).sort();
}

export function keySig(p) {
  const str = `${p.kind}|${trimSlash(p.baseUrl || "")}|${p.apiKey || ""}`;
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// { state: ok | invalid | unverified | network | error, message }
export async function testKey(provider, fetchImpl = fetch) {
  let url;
  if (provider.kind === "anthropic") url = `${anthropicBase(provider.baseUrl)}/v1/models?limit=1`;
  else if (provider.kind === "gemini") url = `${geminiBase(provider.baseUrl)}/v1beta/models?pageSize=1`;
  else url = `${trimSlash(provider.baseUrl)}/models`;
  let res;
  try { res = await fetchImpl(url, { headers: authHeaders(provider) }); }
  catch { return { state: "network", message: "Could not reach the server. Check the base URL and your connection." }; }
  if (res.ok) return { state: "ok", message: "Key accepted." };
  const detail = await describeError(res);
  if (res.status === 401 || res.status === 403 || (provider.kind === "gemini" && res.status === 400 && /API key/i.test(detail))) return { state: "invalid", message: `Key rejected (${detail})` };
  if (res.status === 404 || res.status === 405) return { state: "unverified", message: "This server has no model-list endpoint, so the key could not be checked." };
  if (res.status === 429) return { state: "ok", message: "Key accepted, but the provider is rate limiting right now." };
  return { state: "error", message: detail };
}

export function isUsable(p) {
  const k = p.keyStatus;
  return !!k && (k.state === "ok" || k.state === "unverified") && k.sig === keySig(p);
}
