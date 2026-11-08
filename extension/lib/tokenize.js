// Crude, dependency-free tokeniser. Good enough for keyword relevance; the model
// layer, not this file, is where nuance comes from.
const STOP = new Set(`the and for are but not you all can had her was one our out has have his how its may new now old see two way who did get got
let say she too use that this with from they will would there their what about which when your than then them these those been being were
into over such only also just like more most much many some any other very even still while where because could should might must does doing done
make made well back after before again against between both each few here itself myself off once own same so through under until up down
why yes no nor or if as at by in is it of on to be do an am he me my we us thing things really actually basically probably maybe people
said says going gone want wants need needs think thinks thought know knows known look looks looking come comes came take takes took
another saying time https http www com org html`.split(/\s+/));

function stem(w) {
  if (w.length <= 5) return w;
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'ies', 'ied', 'ers', 'er', 'ed', 'es', 'ly', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) {
      const base = w.slice(0, -suf.length);
      return /([bdgmnprt])\1$/.test(base) ? base.slice(0, -1) : base; // planning -> plan, not plann
    }
  }
  return w;
}

export function tokenize(text) {
  const clean = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ')
    .replace(/n['’]t\b/g, '').replace(/['’](s|re|ve|ll|d|m)\b/g, '');
  return (clean.match(/[a-z][a-z0-9+#-]{2,}/g) || []).filter((w) => !STOP.has(w)).map(stem);
}
