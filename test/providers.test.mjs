import test from "node:test";
import assert from "node:assert/strict";
import { buildRequests, parseReply, completeJSON, toGeminiSchema } from "../extension/lib/providers.js";
import { SUMMARY_SCHEMA } from "../extension/lib/summarise.js";

const args = { model: "m", system: "S", user: "U", schema: SUMMARY_SCHEMA, maxTokens: 100 };
const OBJ = { gist: "g", relevance_note: "r", points: [], disagreements: [], corrections: [], links: [] };
const resp = (status, body) => ({ ok: status < 400, status, statusText: "x", json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } });

test("openai kind asks for json_schema first, then json_object, then plain", () => {
  const r = buildRequests({ kind: "openai", baseUrl: "https://x/v1/", apiKey: "k" }, args);
  assert.deepEqual(r.map((x) => x.id), ["json_schema", "json_object", "plain"]);
  assert.equal(r[0].url, "https://x/v1/chat/completions");
  assert.equal(r[0].headers.Authorization, "Bearer k");
  assert.match(r[2].body.messages[1].content, /JSON Schema/);
});

test("anthropic kind forces a tool call and reads tool_use input", () => {
  const [r] = buildRequests({ kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k" }, args);
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(r.body.tool_choice, { type: "tool", name: "hamsa_summary" });
  const out = parseReply("anthropic", { content: [{ type: "tool_use", input: OBJ }], usage: { input_tokens: 5, output_tokens: 7 } });
  assert.deepEqual(out.object, OBJ);
  assert.deepEqual(out.usage, { input: 5, output: 7 });
});

test("gemini kind uses the native endpoint, a key header and an uppercase schema", () => {
  const [r] = buildRequests({ kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k" }, { ...args, model: "models/gemini-2.5-flash" });
  assert.equal(r.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(r.headers["x-goog-api-key"], "k");
  assert.equal(r.body.generationConfig.responseSchema.type, "OBJECT");
  assert.equal(toGeminiSchema({ type: "array", items: { type: "string" }, additionalProperties: false }).items.type, "STRING");
  const out = parseReply("gemini", { candidates: [{ content: { parts: [{ text: JSON.stringify(OBJ) }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 2 } });
  assert.deepEqual(out.usage, { input: 9, output: 5 });
});

test("completeJSON falls back when json_schema is rejected, and parses fenced JSON", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.response_format?.type || "plain");
    if (body.response_format?.type === "json_schema") return resp(400, { error: { message: "response_format json_schema is not supported" } });
    return resp(200, { choices: [{ message: { content: "```json\n" + JSON.stringify(OBJ) + "\n```" } }], usage: { prompt_tokens: 11, completion_tokens: 4 } });
  };
  const out = await completeJSON({ provider: { kind: "openai", baseUrl: "https://x/v1", apiKey: "k" }, ...args, fetchImpl });
  assert.deepEqual(calls, ["json_schema", "json_object"]);
  assert.equal(out.mode, "json_object");
  assert.deepEqual(out.object, OBJ);
  assert.deepEqual(out.usage, { input: 11, output: 4 });
});

test("completeJSON surfaces an auth error instead of falling back", async () => {
  const fetchImpl = async () => resp(401, { error: { message: "bad key" } });
  await assert.rejects(() => completeJSON({ provider: { kind: "openai", baseUrl: "https://x/v1" }, ...args, fetchImpl }), /401.*bad key/);
});
