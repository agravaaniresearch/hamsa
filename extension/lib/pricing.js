// Price table in USD per million tokens (input, output). Matched by the first pattern that fits the model id.
// Verify against each provider's pricing page; the options page lets you override any row.
export const FX_DEFAULT = 95; // INR per USD

export const PRICES = [
  { match: /deepseek.*(flash|v4)/i, in: 0.3, out: 1.2, note: "DeepSeek Flash, peak rate" },
  { match: /deepseek.*pro/i, in: 1.32, out: 3.96, note: "DeepSeek Pro, peak rate" },
  { match: /grok-?4.*fast|grok.*4\.1/i, in: 0.2, out: 0.5 },
  { match: /grok.*4\.7/i, in: 2, out: 6 },
  { match: /grok/i, in: 1.25, out: 2.5 },
  { match: /haiku/i, in: 0.1, out: 0.5, note: "up to 100K prompt tokens" },
  { match: /sonnet/i, in: 2, out: 10 },
  { match: /gemini.*flash-?lite/i, in: 0.1, out: 0.4 },
  { match: /gemini.*2\.5.*flash/i, in: 0.3, out: 2.5 },
  { match: /gemini.*3\.8.*flash/i, in: 0.75, out: 3.75 },
  { match: /gemini.*pro/i, in: 2, out: 12 },
  { match: /ollama|lm-?studio|localhost|local/i, in: 0, out: 0, note: "local" },
];

export function priceFor(model, overrides = {}) {
  if (overrides[model]) return overrides[model];
  return PRICES.find((p) => p.match.test(model)) || null;
}

// { usd, inr, known }. Output tokens are the cap we ask for, so this is an upper bound.
export function estimateCost(model, inputTokens, outputTokens, { fx = FX_DEFAULT, overrides = {}, baseUrl = "" } = {}) {
  const local = /localhost|127\.0\.0\.1/.test(baseUrl);
  const p = local ? { in: 0, out: 0 } : priceFor(model, overrides);
  if (!p) return { known: false, usd: null, inr: null };
  const usd = (inputTokens * p.in + outputTokens * p.out) / 1e6;
  return { known: true, usd, inr: usd * fx };
}

export const fmtInr = (c) => (!c.known ? "price unknown" : c.inr === 0 ? "free (local)" : c.inr < 0.1 ? "under Rs 0.1" : `Rs ${c.inr < 10 ? c.inr.toFixed(1) : Math.round(c.inr)}`);
