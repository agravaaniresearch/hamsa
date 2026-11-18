import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";

// Kshira palette, as in the add-on.
const C = { milk: "#f3f5ef", card: "#fbfcf9", ink: "#1d2620", muted: "#5e6a62", lotus: "#a8326a", leaf: "#36692c", turmeric: "#c9a43c", silt: "#a9b4aa", pond: "#111714", pondText: "#e3eae2", lotusDark: "#f28db9" };
const fonts = `
@font-face { font-family: Lit; font-weight: 600; src: url(${staticFile("literata-latin-600-normal.woff2")}) format("woff2"); }
@font-face { font-family: Int; font-weight: 400; src: url(${staticFile("inter-latin-400-normal.woff2")}) format("woff2"); }
@font-face { font-family: Int; font-weight: 600; src: url(${staticFile("inter-latin-600-normal.woff2")}) format("woff2"); }
@font-face { font-family: Mono; src: url(${staticFile("ibm-plex-mono-latin-400-normal.woff2")}) format("woff2"); }`;

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const rise = (f, start = 0, dur = 18) => ({
  opacity: interpolate(f, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  transform: `translateY(${interpolate(f, [start, start + dur], [24, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease })}px)`,
});

function Swan({ size = 120, color = C.ink, beak = C.lotus }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <path d="M40 14c-6 0-9 5-7 11l4 10c2 6-2 11-10 11H12c3 8 11 12 21 12 13 0 21-8 21-18 0-8-5-13-11-16l-3-6c-1-2 0-4 2-4h2" stroke={color} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M42 12l8 2-8 2z" fill={beak} />
      <circle cx="40" cy="14.5" r="1.6" fill={color} />
    </svg>
  );
}

function Title() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.milk, justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 28 }}>
      <div style={rise(f, 0)}><Swan size={150} /></div>
      <div style={{ ...rise(f, 8), fontFamily: "Lit", fontWeight: 600, fontSize: 120, color: C.ink, letterSpacing: -2 }}>Hamsa 0.7</div>
      <div style={{ ...rise(f, 18), fontFamily: "Int", fontSize: 40, color: C.muted }}>The conversations inside a thread, one at a time</div>
      <div style={{ ...rise(f, 26), width: interpolate(f, [26, 70], [0, 520], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }), height: 6, borderRadius: 3, background: C.lotus }} />
    </AbsoluteFill>
  );
}

function Principles() {
  const f = useCurrentFrame();
  const lines = [["Rules first, model last.", "Cleaning, relevance and ranking run in your browser, free."], ["Nothing is deleted.", "Every story and comment lands in a bucket, with its reason."], ["A score never travels alone.", "Tap it and every signal shows its points."]];
  return (
    <AbsoluteFill style={{ background: C.milk, padding: "0 220px", justifyContent: "center", gap: 54 }}>
      {lines.map(([a, b], i) => (
        <div key={a} style={rise(f, i * 14)}>
          <div style={{ fontFamily: "Lit", fontWeight: 600, fontSize: 72, color: C.ink }}>{a}</div>
          <div style={{ fontFamily: "Int", fontSize: 38, color: C.muted, marginTop: 8 }}>{b}</div>
        </div>
      ))}
    </AbsoluteFill>
  );
}

// A screenshot that drifts slowly (zoom and pan), with a caption that rises in.
function Shot({ src, caption, dark = false, from = [1, 0, 0], to = [1.12, -40, -60] }) {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = interpolate(f, [0, durationInFrames], [0, 1], { easing: Easing.inOut(Easing.quad) });
  const s = from[0] + (to[0] - from[0]) * t, x = from[1] + (to[1] - from[1]) * t, y = from[2] + (to[2] - from[2]) * t;
  return (
    <AbsoluteFill style={{ background: dark ? C.pond : C.milk }}>
      <AbsoluteFill style={{ padding: "70px 120px 190px" }}>
        <div style={{ width: "100%", height: "100%", overflow: "hidden", borderRadius: 22, boxShadow: dark ? "0 0 0 2px #2c3830" : "0 30px 80px -30px rgba(29,38,32,.45)" }}>
          <Img src={staticFile(src)} style={{ width: "100%", transform: `translate(${x}px, ${y}px) scale(${s})`, transformOrigin: "top left" }} />
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 120, right: 120, bottom: 64, ...rise(f, 10), fontFamily: "Int", fontWeight: 600, fontSize: 46, color: dark ? C.pondText : C.ink }}>{caption}</div>
    </AbsoluteFill>
  );
}

function Heat() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: f - 10, fps, config: { damping: 200 }, durationInFrames: 50 });
  const score = 0.87 * p;
  return (
    <AbsoluteFill style={{ background: C.milk, justifyContent: "center", padding: "0 220px", gap: 46 }}>
      <div style={{ ...rise(f, 0), fontFamily: "Lit", fontWeight: 600, fontSize: 70, color: C.ink }}>Every score on one strip</div>
      <div style={{ position: "relative", height: 40, borderRadius: 20, background: `linear-gradient(90deg, ${C.silt} 0%, ${C.turmeric} 38%, #6f9a3a 62%, #2f6a2a 100%)` }}>
        <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, left: `${score * 100}%`, background: "#dce2d7", borderRadius: "0 20px 20px 0" }} />
        <div style={{ position: "absolute", top: -14, bottom: -14, left: "55%", width: 6, borderRadius: 3, background: C.ink, opacity: 0.6 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "Int", fontSize: 36, color: C.muted }}>
        <span>silt: toss</span><span style={{ color: C.ink }}>tick: your keep line</span><span>leaf: keep</span>
      </div>
      <div style={{ fontFamily: "Mono", fontSize: 64, color: C.ink }}>{score.toFixed(2)}</div>
    </AbsoluteFill>
  );
}

function Lighter() {
  const f = useCurrentFrame();
  const rows = [["CPU on a 689-comment thread", "4.0 s", "2.4 s"], ["Scoring 600 comments", "1,008 ms", "131 ms"], ["Karma requests per thread", "200", "60"], ["One thumbs-up writes", "the whole graph", "a few hundred bytes"]];
  return (
    <AbsoluteFill style={{ background: C.pond, justifyContent: "center", padding: "0 200px", gap: 40 }}>
      <div style={{ ...rise(f, 0), fontFamily: "Lit", fontWeight: 600, fontSize: 72, color: C.pondText }}>Lighter, with identical scores</div>
      {rows.map(([label, a, b], i) => (
        <div key={label} style={{ ...rise(f, 10 + i * 10), display: "flex", alignItems: "baseline", gap: 30, fontFamily: "Int", fontSize: 42, color: "#9daaa1" }}>
          <span style={{ flex: 1 }}>{label}</span>
          <span style={{ textDecoration: "line-through", textDecorationColor: C.lotusDark }}>{a}</span>
          <span style={{ fontWeight: 600, color: "#a6dc8a", minWidth: 360, textAlign: "right" }}>{b}</span>
        </div>
      ))}
    </AbsoluteFill>
  );
}

function Features() {
  const f = useCurrentFrame();
  const items = [["Logs you in to HN", "Your password stays in this browser. A wrong one or a captcha stops it."], ["Updates itself", "Signed builds arrive through updates.json, checked by hash."], ["Thumbs now teach", "A like moves the tags that fired; clearing it takes that back."], ["Interests fade slowly", "A one-year half-life, never below half weight."]];
  return (
    <AbsoluteFill style={{ background: C.milk, justifyContent: "center", padding: "0 200px", gap: 44 }}>
      {items.map(([a, b], i) => (
        <div key={a} style={{ ...rise(f, i * 10), display: "flex", gap: 34, alignItems: "baseline" }}>
          <div style={{ width: 18, height: 18, borderRadius: 9, background: i % 2 ? C.leaf : C.lotus, flex: "none", transform: "translateY(-6px)" }} />
          <div>
            <div style={{ fontFamily: "Lit", fontWeight: 600, fontSize: 60, color: C.ink }}>{a}</div>
            <div style={{ fontFamily: "Int", fontSize: 36, color: C.muted, marginTop: 4 }}>{b}</div>
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
}

function Close() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.milk, justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 30 }}>
      <div style={rise(f, 0)}><Swan size={120} /></div>
      <div style={{ ...rise(f, 6), fontFamily: "Lit", fontWeight: 600, fontSize: 66, color: C.ink, textAlign: "center" }}>Rules you can read. Nothing deleted. Your keys.</div>
      <div style={{ ...rise(f, 14), fontFamily: "Mono", fontSize: 38, color: C.lotus }}>github.com/agravaaniresearch/hamsa</div>
      <div style={{ ...rise(f, 22), fontFamily: "Int", fontSize: 26, color: C.muted }}>Screens use synthetic interests and saved HN pages, for illustration only.</div>
    </AbsoluteFill>
  );
}

const T = 18; // transition length in frames
function Surface() {
  const f = useCurrentFrame();
  const rows = [["Health", "Work per page, writes, requests per site: Healthy, Watch or Slow, with the fix"], ["Lightest mode", "Previews, karma and history off, and their permissions given back"], ["Removed", "GitHub gist backup and its token, browser history, front-page karma requests"], ["HN history", "Off until you switch it on; two cached requests per thread at most"]];
  return (
    <AbsoluteFill style={{ background: C.pond, justifyContent: "center", padding: "0 200px", gap: 40 }}>
      <div style={{ ...rise(f, 0), fontFamily: "Lit", fontWeight: 600, fontSize: 70, color: C.pondText }}>Light in a production browser</div>
      {rows.map(([a, b], i) => (
        <div key={a} style={{ ...rise(f, 10 + i * 10), display: "flex", gap: 30, alignItems: "baseline", fontFamily: "Int", fontSize: 38 }}>
          <span style={{ color: "#a6dc8a", fontWeight: 600, minWidth: 320 }}>{a}</span><span style={{ color: "#9daaa1" }}>{b}</span>
        </div>
      ))}
    </AbsoluteFill>
  );
}

export const SCENES = [[Title, 120], ["strands", 180], ["reader", 180], [Surface, 180], [Principles, 150], [Heat, 120], [Close, 120]];
export const DURATION = SCENES.reduce((a, [, d]) => a + d, 0) - T * (SCENES.length - 1);

const SHOTS = {
  strands: { src: "strands.png", caption: "Strands: each conversation in the thread, by kind and colour.", dark: true, to: [1.08, -20, -40] },
  reader: { src: "reader.png", caption: "Open one: three separate branches on sandboxing, read in thread order.", to: [1.12, -40, -160] },
  front: { src: "front.png", caption: "Discover leads: stories you would not have found, by HN's own signals." },
  thread: { src: "thread.png", caption: "689 comments, 147 sent to a model. Every cut names its rule.", to: [1.15, -60, -260] },
  dark: { src: "thread-dark.png", caption: "Pond: the dark theme. No blue anywhere.", dark: true },
  wide: { src: "front-wide.png", caption: "Full width: the front page in columns on an ultrawide screen.", to: [1.05, -30, -20] },
};

export const Video = () => (
  <AbsoluteFill style={{ background: C.milk }}>
    <style>{fonts}</style>
    <TransitionSeries>
      {SCENES.flatMap(([S, d], i) => {
        const el = typeof S === "string" ? <Shot {...SHOTS[S]} /> : <S />;
        const out = [<TransitionSeries.Sequence key={`s${i}`} durationInFrames={d}>{el}</TransitionSeries.Sequence>];
        if (i < SCENES.length - 1) out.push(<TransitionSeries.Transition key={`t${i}`} presentation={i % 3 === 1 ? slide({ direction: "from-right" }) : fade()} timing={linearTiming({ durationInFrames: T })} />);
        return out;
      })}
    </TransitionSeries>
  </AbsoluteFill>
);
