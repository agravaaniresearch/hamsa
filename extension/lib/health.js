// Extension health: how much work Hamsa does, measured from Hamsa's own side, cheaply.
// Counters live in memory and are saved with the next batched IndexedDB write (key "health"); nothing
// polls, nothing is timed that would not run anyway. Firefox's own CPU and memory are not visible to an
// extension: about:processes is the check for the whole browser.
//
// Status: Slow if any LIMITS.slow line is crossed, Watch if any LIMITS.watch line is, else Healthy.
export const LIMITS = {
  watch: { pageMs: 300, writesPerHour: 60, requestsPerDay: 600 },
  slow: { pageMs: 800, writesPerHour: 240, requestsPerDay: 2000 },
};
const KEEP_PAGES = 50, DAY = 864e5;

export function emptyHealth(now = Date.now()) {
  return { v: 1, since: now, pages: [], writes: { local: [], idb: [] }, net: {}, wakes: [], lastWake: now };
}

const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const recent = (times, ms, now) => times.filter((t) => now - t < ms);

export function notePage(h, { kind, ms, bg = 0 }, now = Date.now()) {
  h.pages.unshift({ kind, ms: Math.round(ms), bg: Math.round(bg), at: now });
  h.pages.length = Math.min(h.pages.length, KEEP_PAGES);
}
export function noteWrite(h, area, bytes, now = Date.now()) {
  const list = h.writes[area] || (h.writes[area] = []);
  list.unshift([now, bytes]);
  while (list.length && now - list[list.length - 1][0] > DAY) list.pop();
}
export function noteRequest(h, host, ok, now = Date.now()) {
  const n = h.net[host] || (h.net[host] = { day: now, n: 0, fail: 0 });
  if (now - n.day > DAY) { n.day = now; n.n = 0; n.fail = 0; }
  n.n++;
  if (!ok) n.fail++;
}
export function noteWake(h, now = Date.now()) {
  h.wakes.unshift(now);
  h.wakes = recent(h.wakes, DAY, now);
  h.lastWake = now;
}

// The report the settings page shows. causes: what crossed a line, with the switch that fixes it.
export function report(h, { storage = {} } = {}, now = Date.now()) {
  const pages = h.pages.filter((p) => now - p.at < 7 * DAY);
  const ms = pages.map((p) => p.ms);
  const writesHour = Object.fromEntries(Object.entries(h.writes).map(([a, l]) => [a, l.filter(([t]) => now - t < 3600e3).length]));
  const bytesHour = Object.fromEntries(Object.entries(h.writes).map(([a, l]) => [a, l.filter(([t]) => now - t < 3600e3).reduce((s, [, b]) => s + b, 0)]));
  const net = Object.fromEntries(Object.entries(h.net).filter(([, n]) => now - n.day < DAY).map(([k, n]) => [k, { n: n.n, fail: n.fail }]));
  const out = {
    pages: { count: pages.length, medianMs: median(ms), worstMs: ms.length ? Math.max(...ms) : 0, last: pages.slice(0, 10) },
    writesHour, bytesHour, net, wakesDay: recent(h.wakes, DAY, now).length, storage, since: h.since,
  };
  const causes = [];
  const level = (lim) => {
    const c = [];
    if (out.pages.medianMs > lim.pageMs) c.push({ what: `Hamsa's work per page is ${out.pages.medianMs} ms (median)`, fix: "Turn off link previews or author karma, or read fewer front pages." });
    for (const [a, n] of Object.entries(writesHour)) if (n > lim.writesPerHour) c.push({ what: `${n} writes to ${a === "idb" ? "IndexedDB" : "storage"} in the last hour`, fix: "Turn off the reading log if you do not use the digest." });
    for (const [host, x] of Object.entries(net)) if (x.n > lim.requestsPerDay) c.push({ what: `${x.n} requests to ${host} today`, fix: host.includes("firebase") ? "Turn off author karma." : host.includes("algolia") ? "Turn off HN history." : "Turn off link previews." });
    return c;
  };
  const slow = level(LIMITS.slow), watch = level(LIMITS.watch);
  out.status = slow.length ? "slow" : watch.length ? "watch" : "healthy";
  out.causes = slow.length ? slow : watch;
  return out;
}
