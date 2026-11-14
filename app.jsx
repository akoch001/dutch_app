const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Utilities ─────────────────────────────────────────────────────────────────
function normalize(str) { return (str || "").toLowerCase().trim().replace(/…/g, "...").replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim(); }

function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// setTimeout that is cancelled if the component goes away first (e.g. you tap
// "Menu" during the short pause after a correct answer).
function useLater() { const t = useRef(); useEffect(() => () => clearTimeout(t.current), []); return (fn, ms) => { t.current = setTimeout(fn, ms); }; }

// Once an answer is showing, the text input is gone, so Enter has to be caught
// on the window. Assign the action to the returned ref. Registered a tick late
// so the Enter that submitted the answer doesn't also skip the feedback.
function useEnterToAdvance(active) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return;
    // preventDefault: if a button still has focus, Enter must not also click it.
    const onKey = e => { if (e.key === "Enter") { e.preventDefault(); ref.current?.(); } };
    const t = setTimeout(() => window.addEventListener("keydown", onKey), 0);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey); };
  }, [active]);
  return ref;
}

// ── Speech (browser's built-in Dutch voice; absent on some devices) ───────────
const canSpeak = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
function speak(text) {
  if (!canSpeak) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[()]/g, "").replace(/\s*\/\s*/g, ", ").replace(/\.{2,}|…/g, " ").trim());
  u.lang = "nl-NL"; u.rate = 0.9;
  const voice = speechSynthesis.getVoices().find(v => v.lang.replace("_", "-").toLowerCase().startsWith("nl"));
  if (voice) u.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function SpeakBtn({ text }) {
  if (!canSpeak) return null;
  const stop = e => e.stopPropagation();
  return <button aria-label="Luister" onClick={e => { e.stopPropagation(); speak(text); }} onTouchStart={stop} onTouchEnd={stop} style={{ width: 38, height: 38, borderRadius: "50%", background: "rgba(var(--accent-rgb),0.1)", border: "1px solid rgba(var(--accent-rgb),0.25)", fontSize: 16, cursor: "pointer" }}>🔊</button>;
}

// Dutch text in a list that can be tapped to hear it.
function Say({ text, children }) {
  if (!canSpeak) return children ?? text;
  return <span role="button" onClick={e => { e.stopPropagation(); speak(text); }} style={{ cursor: "pointer" }}>{children ?? text} <span style={{ fontSize: "0.75em", opacity: 0.4 }}>🔊</span></span>;
}

// ── Item progress stats (per word/sentence, persisted for spaced repetition) ──
const STATS_KEY = "dutch-item-stats-v1";
function statsLoad() { try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; } catch { return {}; } }
function statsSave(stats) { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) { console.error("save failed", e); } }
function recordAttempt(id, wasRight) {
  const stats = statsLoad();
  const cur = stats[id] || { seen: 0, wrong: 0 };
  stats[id] = { seen: cur.seen + 1, wrong: cur.wrong + (wasRight ? 0 : 1), streak: wasRight ? (cur.streak || 0) + 1 : 0, lastSeen: Date.now() };
  statsSave(stats);
  const daily = dailyLoad(), k = dayKey();
  daily[k] = (daily[k] || 0) + 1;
  try { localStorage.setItem(DAILY_KEY, JSON.stringify(daily)); } catch (e) { console.error("save failed", e); }
}

// ── Daily activity (items practised per local calendar day → streak) ─────────
const DAILY_KEY = "dutch-daily-v1";
function dayKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function dailyLoad() { try { return JSON.parse(localStorage.getItem(DAILY_KEY)) || {}; } catch { return {}; } }
// Consecutive practised days ending today. Today not practised yet doesn't
// break the streak — it only breaks once a whole day has been missed.
function getStreak(daily, now = new Date()) {
  const d = new Date(now);
  if (!daily[dayKey(d)]) d.setDate(d.getDate() - 1);
  let n = 0;
  while (daily[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

const vocabId = (c) => `vocab:${c.nl}→${c.en}`;
const verbSentId = (it) => `verbSent:${it.verb}|${it.tense}|${it.subject}|${it.template}`;
const exprSentId = (it) => `exprSent:${it.sentence}|${it.answer}`;

// A word counts as "learned" once it's been practised at least twice and
// answered right at least two times out of three.
const isKnown = (st) => !!st && st.seen >= 2 && st.wrong / st.seen <= 1 / 3;
const isShaky = (st) => !!st && st.seen >= 1 && st.wrong / st.seen > 1 / 3;

// Quick round: up to half the cards are words you've been getting wrong, the
// rest follow the usual new-and-shaky weighting.
function quickPick(items, count) {
  const stats = statsLoad();
  const shaky = weightedPick(items.filter(c => isShaky(stats[vocabId(c)])), vocabId, Math.ceil(count / 2));
  const taken = new Set(shaky.map(vocabId));
  return shuffle([...shaky, ...weightedPick(items.filter(c => !taken.has(vocabId(c))), vocabId, count - shaky.length)]);
}

// ── Multiple-choice options for the sentence tests ───────────────────────────
const AUX_SWAP = { heb: "ben", ben: "heb", hebt: "bent", bent: "hebt", heeft: "is", is: "heeft", hebben: "zijn", zijn: "hebben" };
// Wrong options are other forms of the same verb first (wrong tense, wrong
// person, wrong auxiliary) because that is the confusion being trained; other
// verbs only fill up the list if there aren't enough.
function verbOptions(item, sentences, allVerbs) {
  const v = allVerbs.find(x => x.inf === item.verb);
  const [aux, ...rest] = item.answer.split(" ");
  const sameVerb = [
    ...(item.tense === "perfectum" && AUX_SWAP[aux] ? [[AUX_SWAP[aux], ...rest].join(" ")] : []),
    ...sentences.filter(x => x.verb === item.verb).map(x => x.answer),
    ...(v ? [v.presIk, v.presJijHij, v.presWij, v.impSg, v.impPl] : []),
  ];
  const fill = sentences.filter(x => x.verb !== item.verb && x.tense === item.tense).map(x => x.answer);
  const seen = new Set([normalize(item.answer)]), wrong = [];
  for (const c of [...shuffle(sameVerb), ...shuffle(fill)]) {
    if (wrong.length === 3) break;
    if (!c || seen.has(normalize(c))) continue;
    seen.add(normalize(c)); wrong.push(c);
  }
  return shuffle([item.answer, ...wrong]);
}
// Wrong options come from other categories: expressions in the same category
// are often near-synonyms that would fit the sentence just as well.
function exprOptions(item, expressions) {
  const cat = expressions.find(e => e.nl === item.answer)?.category;
  const others = [...new Set(expressions.filter(e => e.nl !== item.answer && e.category !== cat).map(e => e.nl))];
  return shuffle([item.answer, ...shuffle(others).slice(0, 3)]);
}

// Spaced repetition. Every right answer in a row pushes an item's next review
// further out (1 day, 3 days, a week, ...); a wrong answer makes it due again
// straight away. Until an item is due it is rarely picked, so sessions go to
// new words and words that are about to be forgotten instead of ones you just
// got right. (6 hours of slack so "tomorrow morning" counts as a day later.)
const HOUR = 3600000;
const REVIEW_AFTER = [0, 1, 3, 7, 14, 30].map(days => Math.max(0, days * 24 - 6) * HOUR);
function itemWeight(st, now = Date.now()) {
  if (!st || !st.seen) return 3;
  const wait = REVIEW_AFTER[Math.min(st.streak || 0, REVIEW_AFTER.length - 1)];
  if (now - (st.lastSeen || 0) < wait) return 0.1;
  return 1 + (st.wrong / st.seen) * 3;
}

// Picks `count` items at random, weighted by itemWeight: never-seen items and
// due items you often get wrong come up most.
function weightedPick(items, idFn, count) {
  const stats = statsLoad();
  const pool = items.map(item => {
    return { item, weight: itemWeight(stats[idFn(item)]) };
  });
  const picked = [];
  while (picked.length < count && pool.length) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * total, i = 0;
    while (i < pool.length - 1 && r > pool[i].weight) { r -= pool[i].weight; i++; }
    picked.push(pool.splice(i, 1)[0].item);
  }
  return picked;
}
function checkAnswer(typed, correct) {
  const t = normalize(typed), c = normalize(correct);
  if (t === c) return "exact";
  const stripEllipsis = s => s.replace(/\.{2,}/g, "").replace(/\s+/g, " ").trim();
  const strip = s => stripEllipsis(s.replace(/^(de|het|een) /, "").replace(/\s*\(.*?\)/g, ""));
  const variants = [c, strip(c), stripEllipsis(c)];
  if (variants.some(v => t === v)) return "close";
  return "wrong";
}

function DiffDisplay({ typed, correct }) {
  const t = normalize(typed), c = normalize(correct);
  const maxLen = Math.max(t.length, c.length);
  return (
    <div style={{ fontFamily: "monospace", fontSize: 18, lineHeight: 2, textAlign: "center" }}>
      <div>{Array.from({ length: maxLen }).map((_, i) => {
        const ch = t[i] || "", ok = ch === (c[i] || "");
        return <span key={i} style={{ color: ok ? "var(--green)" : "var(--red)", borderBottom: ok ? "none" : "2px solid var(--red)" }}>{ch || (i < c.length ? "_" : "")}</span>;
      })}</div>
      <div style={{ color: "var(--accent)", fontSize: 15, marginTop: 4 }}>{correct}</div>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const s = {
  screen: { minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 50%,var(--bg3) 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", fontFamily: "system-ui,sans-serif" },
  label: { fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--accent)", fontWeight: 600 },
  backBtn: { background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", padding: 0 },
  chapterBtn: { width: "100%", maxWidth: 340, padding: "18px 22px", marginBottom: 12, background: "rgba(var(--surface-rgb),0.75)", border: "1px solid rgba(var(--accent-rgb),0.15)", borderRadius: 16, color: "var(--text)", fontSize: 16, fontWeight: 500, cursor: "pointer", textAlign: "left", fontFamily: "'DM Sans',sans-serif" },
  allBtn: { width: "100%", maxWidth: 340, padding: "20px 24px", marginTop: 6, background: "linear-gradient(135deg,rgba(var(--accent-rgb),0.15),rgba(var(--accent-rgb),0.05))", border: "1px solid rgba(var(--accent-rgb),0.3)", borderRadius: 16, color: "var(--accent)", fontSize: 16, fontWeight: 600, cursor: "pointer", textAlign: "left", fontFamily: "'DM Sans',sans-serif" },
  wrongBtn: { padding: "14px 28px", background: "rgba(var(--red-rgb),0.1)", border: "1px solid rgba(var(--red-rgb),0.25)", borderRadius: 12, color: "var(--red)", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" },
  rightBtn: { padding: "14px 28px", background: "rgba(var(--green-rgb),0.1)", border: "1px solid rgba(var(--green-rgb),0.25)", borderRadius: 12, color: "var(--green)", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" },
};

// ── Progress save / load ───────────────────────────────────────────────────────
const BACKUP_EMAIL = "adamwyldekoch@gmail.com";

function getSnapshot() {
  const snap = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("dutch-")) {
      try { snap[k] = JSON.parse(localStorage.getItem(k)); }
      catch { snap[k] = localStorage.getItem(k); }
    }
  }
  return JSON.stringify(snap, null, 2);
}

function ProgressModal({ onClose }) {
  const [mode, setMode] = useState(null);
  const [paste, setPaste] = useState("");
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(false);
  const snapshot = mode === "save" ? getSnapshot() : null;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(snapshot).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const openMailto = () => {
    const sub = encodeURIComponent("Dutch app progress backup");
    const body = encodeURIComponent(snapshot);
    window.open(`mailto:${BACKUP_EMAIL}?subject=${sub}&body=${body}`);
  };

  const restore = () => {
    try {
      const parsed = JSON.parse(paste);
      Object.entries(parsed).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
      setDone(true);
      setTimeout(() => window.location.reload(), 1200);
    } catch { alert("Couldn't parse that — make sure you pasted the full JSON."); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(var(--overlay-rgb),0.55)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={onClose}>
      <div style={{ background: "var(--bg1)", borderRadius: 20, padding: 28, width: "100%", maxWidth: 420, boxShadow: "0 8px 40px rgba(var(--ink-rgb),0.18)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif" }}>Progress backup</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--faint)", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {!mode && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button onClick={() => setMode("save")} style={{ padding: "14px 18px", background: "rgba(var(--accent-rgb),0.08)", border: "1px solid rgba(var(--accent-rgb),0.25)", borderRadius: 14, textAlign: "left", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
              <div style={{ fontWeight: 600, color: "var(--accent)", fontSize: 15 }}>💾 Save progress</div>
              <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 3 }}>Copy your data and email it to yourself</div>
            </button>
            <button onClick={() => setMode("load")} style={{ padding: "14px 18px", background: "rgba(var(--blue-rgb),0.06)", border: "1px solid rgba(var(--blue-rgb),0.2)", borderRadius: 14, textAlign: "left", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
              <div style={{ fontWeight: 600, color: "var(--blue)", fontSize: 15 }}>📥 Load progress</div>
              <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 3 }}>Paste a backup to restore your data</div>
            </button>
          </div>
        )}

        {mode === "save" && (
          <div>
            <textarea readOnly value={snapshot} style={{ width: "100%", boxSizing: "border-box", height: 180, padding: "10px 12px", fontSize: 11, fontFamily: "monospace", background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--accent-rgb),0.2)", borderRadius: 10, color: "var(--muted)", resize: "none", outline: "none" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={copyToClipboard} style={{ flex: 1, padding: "12px", borderRadius: 12, background: copied ? "rgba(var(--green-rgb),0.12)" : "rgba(var(--accent-rgb),0.1)", border: `1px solid ${copied ? "rgba(var(--green-rgb),0.3)" : "rgba(var(--accent-rgb),0.25)"}`, color: copied ? "var(--green)" : "var(--accent)", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{copied ? "✓ Copied!" : "Copy"}</button>
              <button onClick={openMailto} style={{ flex: 1, padding: "12px", borderRadius: 12, background: "rgba(var(--blue-rgb),0.08)", border: "1px solid rgba(var(--blue-rgb),0.2)", color: "var(--blue)", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Email me →</button>
            </div>
            <p style={{ fontSize: 12, color: "var(--faint)", marginTop: 10, textAlign: "center" }}>Copy first, then hit "Email me" and paste into the email body.</p>
            <button onClick={() => setMode(null)} style={{ ...s.backBtn, marginTop: 8, display: "block" }}>← Back</button>
          </div>
        )}

        {mode === "load" && (
          <div>
            {done
              ? <div style={{ textAlign: "center", color: "var(--green)", fontSize: 15, fontWeight: 600, padding: "20px 0" }}>✓ Restored! Reloading…</div>
              : <>
                  <p style={{ fontSize: 14, color: "var(--muted)", marginBottom: 12 }}>Paste your backup JSON below, then tap Restore.</p>
                  <textarea value={paste} onChange={e => setPaste(e.target.value)} placeholder='{"dutch-week-tracker-v3": {...}}' style={{ width: "100%", boxSizing: "border-box", height: 180, padding: "10px 12px", fontSize: 11, fontFamily: "monospace", background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--blue-rgb),0.2)", borderRadius: 10, color: "var(--text)", resize: "none", outline: "none" }} />
                  <button onClick={restore} disabled={!paste.trim()} style={{ width: "100%", marginTop: 12, padding: "13px", borderRadius: 12, background: paste.trim() ? "rgba(var(--blue-rgb),0.12)" : "rgba(var(--ink-rgb),0.04)", border: `1px solid ${paste.trim() ? "rgba(var(--blue-rgb),0.3)" : "rgba(var(--ink-rgb),0.08)"}`, color: paste.trim() ? "var(--blue)" : "var(--faint)", fontWeight: 600, fontSize: 15, cursor: paste.trim() ? "pointer" : "default", fontFamily: "'DM Sans',sans-serif" }}>Restore</button>
                  <button onClick={() => setMode(null)} style={{ ...s.backBtn, marginTop: 12, display: "block" }}>← Back</button>
                </>
            }
          </div>
        )}
      </div>
    </div>
  );
}

// ── Streak strip / celebration ────────────────────────────────────────────────
const DAILY_GOAL = 30;
const RING = 2 * Math.PI * 18;
function StreakStrip() {
  const daily = dailyLoad();
  const streak = getStreak(daily);
  const today = daily[dayKey()] || 0;
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return { label: "ZMDWDVZ"[d.getDay()], done: !!daily[dayKey(d)], isToday: i === 6 }; });
  return (
    <div style={{ width: "100%", maxWidth: 340, marginBottom: 16, padding: "14px 18px", background: "rgba(var(--surface-rgb),0.75)", border: "1px solid rgba(var(--accent-rgb),0.15)", borderRadius: 16, fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text)" }}>{streak > 0 ? "🔥" : "💤"} {streak} <span style={{ fontSize: 13, fontWeight: 500, color: "var(--muted)" }}>{streak === 1 ? "dag" : "dagen"} op rij</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "right", lineHeight: 1.35 }}>vandaag<br />doel {DAILY_GOAL}</div>
          <svg width="46" height="46" viewBox="0 0 46 46" role="img" aria-label={`${today} van ${DAILY_GOAL} vandaag`}>
            <circle cx="23" cy="23" r="18" fill="none" strokeWidth="4" style={{ stroke: "rgba(var(--ink-rgb),0.08)" }} />
            <circle cx="23" cy="23" r="18" fill="none" strokeWidth="4" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - Math.min(1, today / DAILY_GOAL))} transform="rotate(-90 23 23)" style={{ stroke: today >= DAILY_GOAL ? "var(--green)" : "var(--accent)", transition: "stroke-dashoffset 0.6s" }} />
            <text x="23" y="27.5" textAnchor="middle" fontSize="13" fontWeight="700" style={{ fill: "var(--text)" }}>{today}</text>
          </svg>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        {days.map((d, i) => (
          <div key={i} style={{ width: 30, height: 30, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: d.done ? "var(--accent)" : "rgba(var(--ink-rgb),0.05)", color: d.done ? "var(--bg1)" : "var(--faint)", border: d.isToday ? "2px solid rgba(var(--accent-rgb),0.6)" : "2px solid transparent" }}>{d.label}</div>
        ))}
      </div>
    </div>
  );
}

function CountUp({ to }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf; const t0 = performance.now();
    const tick = t => { const p = Math.min(1, (t - t0) / 700); setN(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return n;
}

function Confetti() {
  const pieces = useRef(Array.from({ length: 40 }, (_, i) => ({ x: Math.random() * 100, d: Math.random() * 0.6, t: 1.8 + Math.random() * 1.6, w: 6 + Math.random() * 6, c: ["var(--accent)", "var(--green)", "var(--red)", "var(--purple)", "var(--blue)"][i % 5] }))).current;
  return (
    <div aria-hidden="true" style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 50 }}>
      {pieces.map((p, i) => <span key={i} className="confetti" style={{ left: `${p.x}%`, width: p.w, height: p.w * 1.6, background: p.c, animationDelay: `${p.d}s`, animationDuration: `${p.t}s` }} />)}
    </div>
  );
}

// ── Home ──────────────────────────────────────────────────────────────────────
function Home({ allVocab, allVerbs, allExpressions, nuances, podcastEpisodes, onVocab, onVerbs, onExpressions, onNuances, onPodcast, onQuick, onQuickVerbs }) {
  const [showProgress, setShowProgress] = useState(false);
  return (
    <div style={{ ...s.screen, paddingBottom: 80 }}>
      {showProgress && <ProgressModal onClose={() => setShowProgress(false)} />}
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={s.label}>Nederlands</div>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>B1 → B2</h1>
      </div>
      <StreakStrip />
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 16 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }}>🚀 Snelle ronde · 15 vragen · kiezen</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onQuick} style={{ ...s.allBtn, width: "auto", flex: 1, marginTop: 0, padding: "14px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 22 }}>📖</div>
            <div style={{ fontWeight: 700, fontSize: 15, marginTop: 4 }}>Woorden</div>
            <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 2, fontWeight: 400 }}>nieuw & lastig eerst</div>
          </button>
          <button onClick={onQuickVerbs} style={{ ...s.allBtn, width: "auto", flex: 1, marginTop: 0, padding: "14px 12px", textAlign: "center", background: "linear-gradient(135deg,rgba(var(--purple-rgb),0.15),rgba(var(--purple-rgb),0.05))", border: "1px solid rgba(var(--purple-rgb),0.3)", color: "var(--purple)" }}>
            <div style={{ fontSize: 22 }}>⚡</div>
            <div style={{ fontWeight: 700, fontSize: 15, marginTop: 4 }}>Werkwoorden</div>
            <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 2, fontWeight: 400 }}>presens · imperf. · perf.</div>
          </button>
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 12 }}>
        <button onClick={onVocab} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(var(--blue-rgb),0.1),rgba(var(--blue-rgb),0.04))", border: "1px solid rgba(var(--blue-rgb),0.2)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>📖</span>
          <div>
            <div style={{ color: "var(--blue)", fontWeight: 600, fontSize: 16 }}>Woordenlijst</div>
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{allVocab.length} woorden · browse & oefenen</div>
          </div>
        </button>
        <button onClick={onVerbs} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(var(--purple-rgb),0.1),rgba(var(--purple-rgb),0.04))", border: "1px solid rgba(var(--purple-rgb),0.25)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>⚡</span>
          <div>
            <div style={{ color: "var(--purple)", fontWeight: 600, fontSize: 16 }}>Werkwoorden</div>
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{allVerbs.length} verbs · presens, imperf., perf.</div>
          </div>
        </button>
        <button onClick={onExpressions} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(var(--teal-rgb),0.1),rgba(var(--teal-rgb),0.04))", border: "1px solid rgba(var(--teal-rgb),0.2)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>💬</span>
          <div>
            <div style={{ color: "var(--teal)", fontWeight: 600, fontSize: 16 }}>Uitdrukkingen</div>
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{allExpressions.length} expressions · browse & practice</div>
          </div>
        </button>
        <button onClick={onNuances} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(var(--amber-rgb),0.1),rgba(var(--amber-rgb),0.04))", border: "1px solid rgba(var(--amber-rgb),0.2)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>🔍</span>
          <div>
            <div style={{ color: "var(--amber)", fontWeight: 600, fontSize: 16 }}>Nuances</div>
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{nuances.length} topics · confusables & grammar notes</div>
          </div>
        </button>
        <button onClick={onPodcast} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(var(--podcast-rgb),0.1),rgba(var(--podcast-rgb),0.04))", border: "1px solid rgba(var(--podcast-rgb),0.2)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>🎙️</span>
          <div>
            <div style={{ color: PODCAST_ACCENT, fontWeight: 600, fontSize: 16 }}>Een Beetje Nederlands</div>
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{podcastEpisodes.length} {podcastEpisodes.length === 1 ? "aflevering" : "afleveringen"} · woorden & zinnen</div>
          </div>
        </button>
        <button onClick={() => setShowProgress(true)} style={{ padding: "11px 18px", background: "transparent", border: "1px solid rgba(var(--ink-rgb),0.08)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
          <span style={{ fontSize: 15 }}>💾</span>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>Save / load progress</span>
        </button>
      </div>
    </div>
  );
}

// ── Vocab home ─────────────────────────────────────────────────────────────────
function VocabHome({ onBack, onGlossary, onPractice, chapters, vocab, allVocab }) {
  const [selected, setSelected] = useState(new Set());
  const toggle = ch => setSelected(prev => { const next = new Set(prev); next.has(ch) ? next.delete(ch) : next.add(ch); return next; });
  const selectAll = () => setSelected(prev => prev.size === chapters.length ? new Set() : new Set(chapters));
  const combinedCount = selected.size === 0 ? 0 : [...selected].reduce((n, ch) => n + (vocab[ch]?.length ?? 0), 0);
  const combinedDeck = [...selected].flatMap(ch => vocab[ch] || []);
  const allSelected = selected.size === chapters.length;
  const stats = statsLoad();
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 50%,var(--bg3) 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 24px 100px", position: "relative" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Menu</button>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ ...s.label, color: "var(--blue)" }}>Woordenlijst</div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Vocabulary</h2>
      </div>
      <button onClick={onGlossary} style={{ ...s.chapterBtn, borderColor: "rgba(var(--blue-rgb),0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>📖</span>
        <div>
          <div style={{ color: "var(--text)", fontWeight: 600, fontSize: 17 }}>Bestuderen</div>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{allVocab.length} woorden · search & browse</div>
        </div>
      </button>
      <div style={{ width: "100%", maxWidth: 340, height: 1, background: "rgba(var(--ink-rgb),0.05)", margin: "20px 0 16px" }} />
      <div style={{ width: "100%", maxWidth: 340, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600 }}>Oefenen</div>
        <button onClick={selectAll} style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>{allSelected ? "Deselecteer alles" : "Selecteer alles"}</button>
      </div>
      {chapters.map((ch, i) => {
        const active = selected.has(ch);
        const learned = vocab[ch].filter(c => isKnown(stats[vocabId(c)])).length;
        return (
          <button key={ch} onClick={() => toggle(ch)} style={{ ...s.chapterBtn, borderColor: active ? "rgba(var(--accent-rgb),0.4)" : "rgba(var(--accent-rgb),0.15)", background: active ? "rgba(var(--accent-rgb),0.08)" : "rgba(var(--surface-rgb),0.75)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ flex: 1, marginRight: 16 }}>
              <div style={{ fontSize: 11, color: "var(--accent)", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>Hoofdstuk {i + 1}</div>
              <div style={{ color: "var(--text)" }}>{ch.split("–")[1]?.trim()}</div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>{vocab[ch].length} woorden · <span style={{ color: learned > 0 ? "var(--green)" : "var(--muted)" }}>{learned} geleerd</span></div>
              <div style={{ height: 4, borderRadius: 2, background: "rgba(var(--ink-rgb),0.07)", marginTop: 8, overflow: "hidden" }}><div style={{ height: "100%", width: `${(learned / vocab[ch].length) * 100}%`, background: "var(--green)", borderRadius: 2 }} /></div>
            </div>
            <div style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${active ? "var(--accent)" : "rgba(var(--ink-rgb),0.15)"}`, background: active ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {active && <span style={{ color: "var(--bg1)", fontSize: 13, fontWeight: 700 }}>✓</span>}
            </div>
          </button>
        );
      })}
      {selected.size > 0 && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 76px 16px 24px", background: "linear-gradient(0deg,var(--bg1) 60%,transparent)", display: "flex", justifyContent: "center" }}>
          <button onClick={() => onPractice(combinedDeck, selected.size === chapters.length ? "Alle woorden" : `${selected.size} hoofdstuk${selected.size > 1 ? "ken" : ""}`)} style={{ width: "100%", maxWidth: 340, padding: "16px", borderRadius: 14, background: "linear-gradient(135deg,rgba(var(--accent-rgb),0.25),rgba(var(--accent-rgb),0.1))", border: "1px solid rgba(var(--accent-rgb),0.4)", color: "var(--accent)", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            Start oefenen · {combinedCount} woorden →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Glossary ──────────────────────────────────────────────────────────────────
const WORD_STATUS = {
  new: { label: "Nieuw", color: "var(--faint)" },
  shaky: { label: "Lastig", color: "var(--red)" },
  busy: { label: "Bezig", color: "var(--accent)" },
  known: { label: "Geleerd", color: "var(--green)" },
};
const wordStatus = (st) => !st || !st.seen ? "new" : isKnown(st) ? "known" : isShaky(st) ? "shaky" : "busy";

function Glossary({ onBack, onPractice, vocab, allVocab, chapters }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const stats = useMemo(statsLoad, []);
  const statusOf = w => wordStatus(stats[vocabId(w)]);
  const [activeChapter, setActiveChapter] = useState("all");
  const [sortDir, setSortDir] = useState("asc");
  const src = activeChapter === "all" ? allVocab : (vocab[activeChapter] || []);
  const q = normalize(search);
  const sorted = [...src.filter(w => (statusFilter === "all" || statusOf(w) === statusFilter) && (!q || normalize(w.nl).includes(q) || normalize(w.en).includes(q)))]
    .sort((a, b) => normalize(a.nl).localeCompare(normalize(b.nl)) * (sortDir === "asc" ? 1 : -1));
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 50%,var(--bg3) 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,var(--bg1),var(--bg2))", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Menu</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={s.label}>Woordenlijst</div></div>
          <button onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")} style={{ background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--accent-rgb),0.15)", borderRadius: 8, color: "var(--accent)", fontSize: 12, padding: "6px 10px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>A–Z {sortDir === "asc" ? "↑" : "↓"}</button>
        </div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 10, scrollbarWidth: "none" }}>
          {["all", ...chapters].map((ch, i) => {
            const active = activeChapter === ch;
            return <button key={ch} onClick={() => setActiveChapter(ch)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(var(--accent-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: active ? "1px solid rgba(var(--accent-rgb),0.4)" : "1px solid rgba(var(--ink-rgb),0.06)", color: active ? "var(--accent)" : "var(--muted)" }}>{ch === "all" ? "Alles" : `H${i}`}</button>;
          })}
        </div>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--faint)", fontSize: 15 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken..." style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px 12px 38px", background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--accent-rgb),0.15)", borderRadius: 12, color: "var(--text)", fontSize: 15, outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "var(--accent)" }} />
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {[["all", { label: "Alle" }], ...Object.entries(WORD_STATUS)].map(([k, v]) => {
            const active = statusFilter === k;
            return <button key={k} onClick={() => setStatusFilter(k)} style={{ flex: 1, padding: "7px 0", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(var(--accent-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: active ? "1px solid rgba(var(--accent-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", color: active ? "var(--accent)" : "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>{v.color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: v.color }} />}{v.label}</button>;
          })}
        </div>
        <div style={{ fontSize: 12, color: "var(--faint)", paddingBottom: 8 }}>{sorted.length} woorden</div>
      </div>
      <div style={{ flex: 1, padding: `0 20px ${statusFilter !== "all" && sorted.length > 0 ? 100 : 32}px` }}>
        {sorted.map((w, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "13px 0", borderBottom: "1px solid rgba(var(--surface-rgb),0.85)", gap: 12 }}>
            <span style={{ color: "var(--text)", fontSize: 15, fontWeight: 500, flex: "0 0 auto", maxWidth: "50%" }}><span title={WORD_STATUS[statusOf(w)].label} style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: WORD_STATUS[statusOf(w)].color, marginRight: 8, verticalAlign: "middle" }} /><Say text={w.nl} /></span>
            <span style={{ color: "var(--muted)", fontSize: 14, textAlign: "right", flex: 1 }}>{w.en}</span>
          </div>
        ))}
        {sorted.length === 0 && <div style={{ textAlign: "center", color: "var(--faint)", marginTop: 60, fontSize: 15 }}>Geen resultaten</div>}
      </div>
      {statusFilter !== "all" && sorted.length > 0 && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 76px 16px 24px", background: "linear-gradient(0deg,var(--bg1) 60%,transparent)", display: "flex", justifyContent: "center" }}>
          <button onClick={() => onPractice(sorted, `${WORD_STATUS[statusFilter].label} · ${sorted.length} woorden`)} style={{ width: "100%", maxWidth: 340, padding: "16px", borderRadius: 14, background: "linear-gradient(135deg,rgba(var(--accent-rgb),0.25),rgba(var(--accent-rgb),0.1))", border: "1px solid rgba(var(--accent-rgb),0.4)", color: "var(--accent)", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{sorted.length === 1 ? "Oefen dit woord →" : `Oefen deze ${sorted.length} woorden →`}</button>
        </div>
      )}
    </div>
  );
}

// ── Verbs home ────────────────────────────────────────────────────────────────
function VerbsHome({ onBack, onStudy, onTest, allVerbs }) {
  return (
    <div style={{ ...s.screen, position: "relative" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Menu</button>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ ...s.label, color: "var(--purple)" }}>Werkwoorden</div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Verbs</h2>
        <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 6 }}>Presens · Imperfectum · Perfectum</div>
      </div>
      <button onClick={onStudy} style={{ ...s.chapterBtn, borderColor: "rgba(var(--purple-rgb),0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>📚</span>
        <div>
          <div style={{ color: "var(--text)", fontWeight: 600, fontSize: 17 }}>Bestuderen</div>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{allVerbs.length} verbs · conjugation table</div>
        </div>
      </button>
      <button onClick={onTest} style={{ ...s.chapterBtn, borderColor: "rgba(var(--purple-rgb),0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>🎯</span>
        <div>
          <div style={{ color: "var(--text)", fontWeight: 600, fontSize: 17 }}>Testen</div>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>Fill the gap · with or without context</div>
        </div>
      </button>
    </div>
  );
}

// ── Verb study ────────────────────────────────────────────────────────────────
function VerbStudy({ onBack, verbGroups, verbGroupNames }) {
  const [activeGroup, setActiveGroup] = useState(verbGroupNames[0]);
  const [search, setSearch] = useState("");
  const list = verbGroups[activeGroup] || [];
  const q = normalize(search);
  const filtered = q ? list.filter(v => normalize(v.inf).includes(q) || normalize(v.en).includes(q) || normalize(v.impSg).includes(q) || normalize(v.vd).includes(q) || normalize(v.presIk || "").includes(q)) : list;
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1),var(--bg2) 50%,var(--bg3))", fontFamily: "system-ui,sans-serif" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,var(--bg1),var(--bg2))", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Verbs</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={{ ...s.label, color: "var(--purple)" }}>Bestuderen</div></div>
          <div style={{ width: 60 }} />
        </div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 10, scrollbarWidth: "none" }}>
          {verbGroupNames.map(g => {
            const active = g === activeGroup;
            return <button key={g} onClick={() => setActiveGroup(g)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(var(--purple-rgb),0.18)" : "rgba(var(--surface-rgb),0.75)", border: active ? "1px solid rgba(var(--purple-rgb),0.45)" : "1px solid rgba(var(--ink-rgb),0.06)", color: active ? "var(--purple)" : "var(--muted)" }}>{g}</button>;
          })}
        </div>
        <div style={{ position: "relative", marginBottom: 12 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--faint)", fontSize: 15 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken..." style={{ width: "100%", boxSizing: "border-box", padding: "11px 14px 11px 38px", background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--purple-rgb),0.18)", borderRadius: 12, color: "var(--text)", fontSize: 14, outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "var(--purple)" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 0.9fr 1.2fr", gap: 6, padding: "10px 4px", borderBottom: "1px solid rgba(var(--purple-rgb),0.15)", fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--purple)", fontWeight: 600 }}>
          <span>Infinitief / EN</span><span>Presens</span><span>Imperf.</span><span>Perfectum</span>
        </div>
      </div>
      <div style={{ padding: "0 20px 40px" }}>
        {filtered.map((v, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 0.9fr 1.2fr", gap: 6, padding: "12px 4px", borderBottom: "1px solid rgba(var(--surface-rgb),0.75)", fontSize: 12, alignItems: "start", lineHeight: 1.4 }}>
            <span><div style={{ color: "var(--text)", fontWeight: 600, fontSize: 13 }}><Say text={`${v.inf}, ${v.impSg}, ${v.vd}`}>{v.inf}</Say></div><div style={{ color: "var(--muted)", fontSize: 10, marginTop: 2 }}>{v.en}</div></span>
            <span style={{ color: "var(--blue)" }}><div>{v.presIk || "—"}</div><div style={{ fontSize: 10, color: "var(--faint)" }}>{v.presJijHij || ""}</div><div style={{ fontSize: 10, color: "var(--faint)" }}>{v.presWij || ""}</div></span>
            <span style={{ color: "var(--muted)" }}><div>{v.impSg}</div><div style={{ fontSize: 10, color: "var(--faint)" }}>{v.impPl}</div></span>
            <span style={{ color: "var(--accent)" }}><div style={{ fontSize: 9, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>{v.aux}</div><div>{v.vd}</div></span>
          </div>
        ))}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "var(--faint)", marginTop: 60, fontSize: 15 }}>Geen resultaten</div>}
      </div>
    </div>
  );
}

// Shown after answering in the sentence tests: what the word/expression means.
function Explain({ info, accent }) {
  if (!info) return null;
  return (
    <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 12, background: `rgba(var(--${accent}-rgb),0.06)`, border: `1px solid rgba(var(--${accent}-rgb),0.15)`, textAlign: "left", fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{info.head}</div>
      {info.body && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>{info.body}</div>}
    </div>
  );
}

// ── Typen / Kiezen switch for the sentence tests ─────────────────────────────
function InputModeToggle({ mc, onMc, accent }) {
  return (
    <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
      <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 10 }}>Antwoorden</div>
      <div style={{ display: "flex", gap: 8 }}>
        {[{ v: false, label: "⌨️ Typen" }, { v: true, label: "👆 Kiezen" }].map(o => (
          <button key={o.label} onClick={() => onMc(o.v)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: mc === o.v ? `rgba(var(--${accent}-rgb),0.15)` : "rgba(var(--surface-rgb),0.75)", border: mc === o.v ? `1px solid rgba(var(--${accent}-rgb),0.5)` : "1px solid rgba(var(--ink-rgb),0.07)", color: mc === o.v ? `var(--${accent})` : "var(--muted)" }}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

// ── Verb test setup ───────────────────────────────────────────────────────────
function VerbTestSetup({ onBack, onStart, verbGroupNames, mc, onMc }) {
  const [mode, setMode] = useState("context");
  const [count, setCount] = useState(15);
  const [tenses, setTenses] = useState({ presens: true, imperfectum: true, perfectum: true });
  const [selectedGroups, setSelectedGroups] = useState(() => new Set(verbGroupNames));
  const toggleTense = t => {
    const next = { ...tenses, [t]: !tenses[t] };
    if (!Object.values(next).some(v => v)) return;
    setTenses(next);
  };
  const toggleGroup = g => {
    setSelectedGroups(prev => {
      if (prev.has(g) && prev.size === 1) return prev;
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      return next;
    });
  };
  return (
    <div style={{ ...s.screen, position: "relative", padding: "60px 24px 32px" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Verbs</button>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ ...s.label, color: "var(--purple)" }}>Testen</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Choose your challenge</h2>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 10 }}>Tijden</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[{ k: "presens", label: "Presens" }, { k: "imperfectum", label: "Imperf." }, { k: "perfectum", label: "Perfectum" }].map(t => (
            <button key={t.k} onClick={() => toggleTense(t.k)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: tenses[t.k] ? "rgba(var(--purple-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: tenses[t.k] ? "1px solid rgba(var(--purple-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", color: tenses[t.k] ? "var(--purple)" : "var(--muted)" }}>{t.label}</button>
          ))}
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 10 }}>Hoofdstukken</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {verbGroupNames.map(g => {
            const label = g.split(/\s/)[0];
            const active = selectedGroups.has(g);
            return <button key={g} onClick={() => toggleGroup(g)} style={{ padding: "8px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(var(--purple-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: active ? "1px solid rgba(var(--purple-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", color: active ? "var(--purple)" : "var(--muted)" }} title={g}>{label}</button>;
          })}
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 10 }}>Modus</div>
        {[{ id: "context", icon: "📝", name: "Met context", desc: "Read the sentence, fill in the verb" }, { id: "nocontext", icon: "⚡", name: "Zonder context", desc: "Just verb + tense → type the form" }].map(m => (
          <button key={m.id} onClick={() => setMode(m.id)} style={{ width: "100%", marginBottom: 8, padding: "14px 16px", borderRadius: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left", background: mode === m.id ? "rgba(var(--purple-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: mode === m.id ? "1px solid rgba(var(--purple-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 20 }}>{m.icon}</span>
            <div>
              <div style={{ color: mode === m.id ? "var(--purple)" : "var(--text)", fontWeight: 600, fontSize: 14 }}>{m.name}</div>
              <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{m.desc}</div>
            </div>
          </button>
        ))}
      </div>
      <InputModeToggle mc={mc} onMc={onMc} accent="purple" />
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 24 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 10 }}>Aantal vragen</div>
        <div style={{ display: "flex", gap: 8 }}>
          {[10, 15, 25].map(n => (
            <button key={n} onClick={() => setCount(n)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: count === n ? "rgba(var(--purple-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: count === n ? "1px solid rgba(var(--purple-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", color: count === n ? "var(--purple)" : "var(--muted)" }}>{n}</button>
          ))}
        </div>
      </div>
      <button onClick={() => onStart(mode, count, Object.keys(tenses).filter(t => tenses[t]), [...selectedGroups])} style={{ width: "100%", maxWidth: 340, padding: "16px", borderRadius: 14, background: "linear-gradient(135deg,rgba(var(--purple-rgb),0.25),rgba(var(--purple-rgb),0.1))", border: "1px solid rgba(var(--purple-rgb),0.4)", color: "var(--purple)", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Start →</button>
    </div>
  );
}

// ── Verb test ─────────────────────────────────────────────────────────────────
function VerbTest({ items, mode, onComplete, onBack, backLabel = "← Test menu", inputMode, optionsFor, explain }) {
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(null);
  const [score, setScore] = useState({ right: 0, wrong: 0, wrongs: [] });
  const inputRef = useRef(null);
  // Missed items are put back a few places further on until answered right;
  // the score counts first tries only.
  const [queue, setQueue] = useState(items);
  const current = queue[index];
  const typing = inputMode !== "mc";
  const [pickState, setPickState] = useState(null);
  const picked = pickState && pickState.index === index ? pickState.opt : null;
  const options = useMemo(() => (!typing && current ? optionsFor(current) : []), [current, typing]);
  const answered = typing ? !!status : picked !== null;
  const pickedWrong = picked !== null && picked !== current?.answer;
  const later = useLater();
  const enterRef = useEnterToAdvance(typing ? !!status : pickedWrong);
  useEffect(() => { setInput(""); setStatus(null); setTimeout(() => inputRef.current?.focus(), 80); }, [index]);
  if (!current) {
    if (queue.length === 0) return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, padding: "60px 24px", fontFamily: "'DM Sans',sans-serif" }}>
        <div style={{ fontSize: 16, color: "var(--muted)", textAlign: "center", lineHeight: 1.6 }}>Geen oefenzinnen beschikbaar voor de geselecteerde groepen en tijden.</div>
        <button onClick={onBack} style={{ padding: "12px 28px", borderRadius: 12, background: "rgba(var(--purple-rgb),0.1)", border: "1px solid rgba(var(--purple-rgb),0.3)", color: "var(--purple)", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>← Terug</button>
      </div>
    );
    return null;
  }
  const submit = () => { if (!input.trim()) return; setStatus(checkAnswer(input, current.answer)); };
  const advance = (forced) => {
    const wasRight = typeof forced === "boolean" ? forced : status === "exact" || status === "close";
    recordAttempt(verbSentId(current), wasRight);
    const newScore = score.wrongs.includes(current) ? score : { right: score.right + (wasRight ? 1 : 0), wrong: score.wrong + (wasRight ? 0 : 1), wrongs: wasRight ? score.wrongs : [...score.wrongs, current] };
    setScore(newScore);
    let q = queue;
    if (!wasRight) { q = [...queue]; q.splice(Math.min(index + 4, q.length), 0, current); setQueue(q); }
    if (index >= q.length - 1) onComplete(newScore);
    else setIndex(i => i + 1);
  };
  enterRef.current = () => advance(typing ? undefined : false);
  const pick = opt => {
    if (picked !== null) return;
    setPickState({ index, opt });
    if (opt === current.answer) later(() => advance(true), 700);
  };
  const handleKey = e => { if (e.key === "Enter") { if (status) advance(); else submit(); } };
  const pct = (index / queue.length) * 100;
  const parts = current.template.split("{}");
  // Split verbs have two gaps: first word in the first gap, the rest in the second.
  const words = current.answer.split(" ");
  const fill = i => parts.length <= 2 ? current.answer : i === 0 ? words[0] : words.slice(1).join(" ");
  const sentence = parts.map((p, i) => p + (i < parts.length - 1 ? fill(i) : "")).join("");
  const hear = canSpeak && <div style={{ marginTop: 12, height: 38, visibility: answered ? "visible" : "hidden" }}><SpeakBtn text={sentence} /></div>;
  let display;
  if (mode === "context") {
    display = (
      <>
        <div style={s.label}>Vul in</div>
        <div style={{ fontSize: 18, color: "var(--text)", lineHeight: 1.6, marginTop: 12, fontFamily: "'Playfair Display',serif" }}>
          {parts.map((p, i) => (
            <span key={i}>{p}{i < parts.length - 1 && (answered ? <span style={{ color: "var(--green)", fontWeight: 700 }}>{fill(i)}</span> : <span style={{ color: "var(--purple)", fontWeight: 700, borderBottom: "2px dashed var(--purple)", padding: "0 12px" }}>____</span>)}</span>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 14, fontStyle: "italic" }}>{current.hint}</div>
        <div style={{ fontSize: 11, color: "var(--purple)", marginTop: 10, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>{current.verb} · {current.tense}{current.split ? " · split form" : ""}</div>
        {hear}
      </>
    );
  } else {
    display = (
      <>
        <div style={s.label}>Verb · tense</div>
        <div style={{ fontSize: 30, fontWeight: 700, color: "var(--text)", marginTop: 12, fontFamily: "'Playfair Display',serif" }}>{current.verb}</div>
        <div style={{ fontSize: 14, color: "var(--purple)", marginTop: 8, fontWeight: 600 }}>{current.subject} · {current.tense === "perfectum" ? "perfectum (aux + vd)" : current.tense}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 14, fontStyle: "italic" }}>{current.hint}</div>
        {hear}
      </>
    );
  }
  const sc = status === "exact" ? "var(--green)" : status === "close" ? "var(--accent)" : "var(--red)";
  const sm = status === "exact" ? "Precies goed! 🎉" : status === "close" ? "Bijna goed!" : "Niet helemaal...";
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1),var(--bg2) 50%,var(--bg3))", fontFamily: "system-ui,sans-serif", position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px 40px" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(var(--surface-rgb),0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,var(--purple),var(--purple2))", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 18, left: 18 }}>{backLabel}</button>
      <div style={{ position: "absolute", top: 18, right: 18, fontSize: 12, color: "var(--muted)" }}>{index + 1} / {queue.length} · <span style={{ color: "var(--green)" }}>✓ {score.right}</span> <span style={{ color: "var(--red)" }}>✗ {score.wrong}</span></div>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div key={`q-${index}`} className="card-in" style={{ background: "rgba(var(--surface-rgb),0.75)", border: "1px solid rgba(var(--purple-rgb),0.18)", borderRadius: 20, padding: "28px 24px", textAlign: "center", marginBottom: 18 }}>{display}</div>
        {!typing && (
          <>
            <OptionButtons key={index} options={options} answer={current.answer} picked={picked} onPick={pick} accent="purple" />
            <button onClick={() => advance(false)} disabled={!pickedWrong} style={{ visibility: pickedWrong ? "visible" : "hidden", marginTop: 4, width: "100%", background: "linear-gradient(135deg,rgba(var(--purple-rgb),0.2),rgba(var(--purple-rgb),0.08))", border: "1px solid rgba(var(--purple-rgb),0.35)", borderRadius: 14, color: "var(--purple)", fontSize: 16, fontWeight: 600, padding: "15px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Volgende →</button>
          </>
        )}
        {typing && !status && (
          <div style={{ position: "relative" }}>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder={current.split ? "type both parts" : "type the verb form..."} style={{ width: "100%", boxSizing: "border-box", padding: "16px 60px 16px 18px", fontSize: 17, background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--purple-rgb),0.25)", borderRadius: 14, color: "var(--text)", outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "var(--purple)" }} />
            <button onClick={submit} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "rgba(var(--purple-rgb),0.18)", border: "1px solid rgba(var(--purple-rgb),0.35)", borderRadius: 8, color: "var(--purple)", padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>↵</button>
          </div>
        )}
        {typing && !status && <button onClick={() => setStatus("wrong")} style={{ marginTop: 12, width: "100%", background: "none", border: "1px solid rgba(var(--ink-rgb),0.05)", borderRadius: 12, color: "var(--faint)", fontSize: 13, padding: "10px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Toon antwoord</button>}
        {typing && status && (
          <>
            <div style={{ background: `rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.08)`, border: `1px solid rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.25)`, borderRadius: 16, padding: "20px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: sc, marginBottom: 14, letterSpacing: 1 }}>{sm}</div>
              <DiffDisplay typed={input} correct={current.answer} />
            </div>
            <button onClick={advance} style={{ marginTop: 14, width: "100%", background: "linear-gradient(135deg,rgba(var(--purple-rgb),0.2),rgba(var(--purple-rgb),0.08))", border: "1px solid rgba(var(--purple-rgb),0.35)", borderRadius: 14, color: "var(--purple)", fontSize: 16, fontWeight: 600, padding: "15px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{index >= queue.length - 1 && status !== "wrong" ? "Klaar →" : "Volgende →"}</button>
          </>
        )}
        {answered && <Explain info={explain(current)} accent="purple" />}
      </div>
    </div>
  );
}

// ── Verb results ──────────────────────────────────────────────────────────────
function VerbResults({ score, onRestart, onRetry, onHome }) {
  const total = score.right + score.wrong;
  const pct = total > 0 ? Math.round((score.right / total) * 100) : 0;
  return (
    <div style={s.screen}>
      <div style={{ fontSize: 64, fontWeight: 700, fontFamily: "'Playfair Display',serif", color: pct >= 80 ? "var(--green)" : pct >= 50 ? "var(--accent)" : "var(--red)", marginBottom: 8 }}><CountUp to={pct} />%{pct >= 80 && <Confetti />}</div>
      <div style={{ color: "var(--muted)", fontSize: 15, marginBottom: 8 }}>{score.right} goed · {score.wrong} fout</div>
      <div style={{ color: "var(--text)", fontSize: 20, fontWeight: 600, marginBottom: 32, fontFamily: "'Playfair Display',serif" }}>{pct >= 90 ? "Uitstekend!" : pct >= 70 ? "Goed bezig!" : pct >= 50 ? "Ga zo door!" : "Blijf oefenen!"}</div>
      {score.wrongs.length > 0 && (
        <div style={{ width: "100%", maxWidth: 360, marginBottom: 22, background: "rgba(var(--surface-rgb),0.65)", border: "1px solid rgba(var(--red-rgb),0.15)", borderRadius: 16, padding: "16px 20px", maxHeight: 240, overflowY: "auto" }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "var(--red)", marginBottom: 10, fontWeight: 600 }}>Nog te leren</div>
          {score.wrongs.map((w, i) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: i < score.wrongs.length - 1 ? "1px solid rgba(var(--surface-rgb),0.75)" : "none", fontSize: 13 }}>
              <div style={{ color: "var(--text)" }}>{w.verb} → <span style={{ color: "var(--accent)" }}>{w.answer}</span></div>
              <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{w.hint}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 340 }}>
        {score.wrongs.length > 0 && <button onClick={() => onRetry(score.wrongs)} style={{ ...s.wrongBtn, width: "100%" }}>Oefen fouten opnieuw</button>}
        <button onClick={onRestart} style={s.chapterBtn}>Opnieuw</button>
        <button onClick={onHome} style={{ ...s.chapterBtn, color: "var(--muted)", border: "1px solid rgba(var(--ink-rgb),0.07)" }}>← Terug naar menu</button>
      </div>
    </div>
  );
}

// ── Mode select ───────────────────────────────────────────────────────────────
function ModeSelect({ title, total, onSelect, onBack }) {
  const chunkOptions = [10, 20, 30].filter(n => n < total);
  const [chunk, setChunk] = useState(20);
  return (
    <div style={{ ...s.screen, position: "relative" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Terug</button>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={s.label}>Kies een modus</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>{title}</h2>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 12 }}>Aantal per sessie</div>
        <div style={{ display: "flex", gap: 8 }}>
          {chunkOptions.map(n => (
            <button key={n} onClick={() => setChunk(n)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: chunk === n ? "rgba(var(--accent-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: chunk === n ? "1px solid rgba(var(--accent-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", color: chunk === n ? "var(--accent)" : "var(--muted)" }}>{n}</button>
          ))}
          <button onClick={() => setChunk(total)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: chunk === total ? "rgba(var(--accent-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: chunk === total ? "1px solid rgba(var(--accent-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", color: chunk === total ? "var(--accent)" : "var(--muted)" }}>Alles<br /><span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>{total}</span></button>
        </div>
      </div>
      {[{ id: "flip", icon: "🃏", name: "Flashcards", desc: "Tap to flip · swipe to navigate" }, { id: "mc", icon: "👆", name: "Kiezen", desc: "See English, tap the Dutch (4 options)" }, { id: "type", icon: "⌨️", name: "Typen", desc: "See English, type the Dutch" }].map(m => (
        <button key={m.id} onClick={() => onSelect(m.id, chunk)} style={{ ...s.chapterBtn, display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 28 }}>{m.icon}</span>
          <div>
            <div style={{ color: "var(--text)", fontWeight: 600, fontSize: 17 }}>{m.name}</div>
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{m.desc} · <span style={{ color: "var(--accent)" }}>{chunk === total ? "alle" : chunk} woorden</span></div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Flashcard ─────────────────────────────────────────────────────────────────
function Flashcard({ card, flipped, onFlip, onNext, onPrev, index, total, known, unknown }) {
  const touchRef = useRef({ x: 0, y: 0 });
  const [swipeX, setSwipeX] = useState(0);
  const onTS = e => { touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; setSwipeX(0); };
  const onTM = e => setSwipeX((e.touches[0].clientX - touchRef.current.x) * 0.4);
  const onTE = e => {
    const dx = e.changedTouches[0].clientX - touchRef.current.x, dy = Math.abs(e.changedTouches[0].clientY - touchRef.current.y), dt = Date.now() - touchRef.current.t;
    if (Math.abs(dx) > 60 && dy < 100) { dx > 0 ? onPrev() : onNext(); }
    else if (Math.abs(dx) < 10 && dt < 300) onFlip();
    setSwipeX(0);
  };
  const pct = total > 0 ? (index / total) * 100 : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "20px", position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(var(--surface-rgb),0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,var(--accent),var(--red))", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <div style={{ position: "absolute", bottom: 24, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 20, fontSize: 13, color: "var(--muted)" }}>
        <span>{index + 1} / {total}</span>
        {(known > 0 || unknown > 0) && <><span style={{ color: "var(--green)" }}>✓ {known}</span><span style={{ color: "var(--red)" }}>✗ {unknown}</span></>}
      </div>
      <div key={index} className="card-in" onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE} onClick={() => { if (!('ontouchstart' in window)) onFlip(); }} style={{ width: "100%", maxWidth: 360, minHeight: 240, cursor: "pointer", transform: `translateX(${swipeX}px)`, transition: swipeX === 0 ? "transform 0.3s" : "none", userSelect: "none" }}>
        <div key={flipped ? "back" : "front"} className={flipped ? "flip-in" : undefined} style={{ width: "100%", minHeight: 240, background: flipped ? "linear-gradient(145deg,rgba(var(--accent-rgb),0.08),rgba(var(--accent-rgb),0.02))" : "rgba(var(--surface-rgb),0.75)", border: `1px solid ${flipped ? "rgba(var(--accent-rgb),0.2)" : "rgba(var(--accent-rgb),0.12)"}`, borderRadius: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 28px", boxSizing: "border-box", transition: "background 0.3s, border-color 0.3s" }}>
          {!flipped
            ? <><div style={s.label}>Nederlands</div><div style={{ fontSize: card.nl.length > 25 ? 22 : 28, fontWeight: 600, color: "var(--text)", textAlign: "center", lineHeight: 1.4, fontFamily: "'Playfair Display',serif", marginTop: 12 }}>{card.nl}</div><div style={{ marginTop: 16 }}><SpeakBtn text={card.nl} /></div><div style={{ fontSize: 12, color: "var(--faint)", marginTop: 16 }}>tap to reveal</div></>
            : <><div style={s.label}>Nederlands</div><div style={{ fontSize: 18, color: "var(--muted)", textAlign: "center", marginBottom: 16 }}>{card.nl}</div><div style={{ width: 40, height: 1, background: "rgba(var(--accent-rgb),0.3)", marginBottom: 16 }} /><div style={{ ...s.label, color: "var(--accent)" }}>English</div><div style={{ fontSize: card.en.length > 30 ? 20 : 24, fontWeight: 600, color: "var(--text)", textAlign: "center", lineHeight: 1.4, fontFamily: "'Playfair Display',serif", marginTop: 10 }}>{card.en}</div>{card.note && <div style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", lineHeight: 1.5, marginTop: 14, fontStyle: "italic" }}>{card.note}</div>}<div style={{ marginTop: 16 }}><SpeakBtn text={card.nl} /></div></>
          }
        </div>
      </div>
      {flipped
        ? <div style={{ display: "flex", gap: 16, marginTop: 32 }}><button onClick={e => { e.stopPropagation(); onNext("unknown"); }} style={s.wrongBtn}>Nog niet</button><button onClick={e => { e.stopPropagation(); onNext("known"); }} style={s.rightBtn}>Ken ik ✓</button></div>
        : <div style={{ marginTop: 32, fontSize: 13, color: "var(--faint)" }}>← swipe →</div>
      }
    </div>
  );
}

// ── Typing card ───────────────────────────────────────────────────────────────
function TypingCard({ card, index, total, known, unknown, onNext }) {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => { setInput(""); setStatus(null); setTimeout(() => inputRef.current?.focus(), 80); }, [index]);
  const submit = () => { if (!input.trim()) return; setStatus(checkAnswer(input, card.nl)); };
  const advance = () => onNext(status === "wrong" ? "unknown" : "known");
  const enterRef = useEnterToAdvance(!!status);
  enterRef.current = advance;
  const handleKey = e => { if (e.key === "Enter") { if (status) advance(); else submit(); } };
  const pct = total > 0 ? (index / total) * 100 : 0;
  const sc = status === "exact" ? "var(--green)" : status === "close" ? "var(--accent)" : "var(--red)";
  const sm = status === "exact" ? "Precies goed! 🎉" : status === "close" ? "Bijna! (Kleine afwijking geaccepteerd)" : "Niet helemaal...";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "20px", position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(var(--surface-rgb),0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,var(--accent),var(--red))", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <div style={{ position: "absolute", bottom: 24, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 20, fontSize: 13, color: "var(--muted)" }}>
        <span>{index + 1} / {total}</span>
        {(known > 0 || unknown > 0) && <><span style={{ color: "var(--green)" }}>✓ {known}</span><span style={{ color: "var(--red)" }}>✗ {unknown}</span></>}
      </div>
      <div style={{ width: "100%", maxWidth: 380, marginTop: 40 }}>
        <div key={index} className="card-in" style={{ background: "rgba(var(--surface-rgb),0.75)", border: "1px solid rgba(var(--accent-rgb),0.12)", borderRadius: 20, padding: "32px 28px", textAlign: "center", marginBottom: 20 }}>
          <div style={s.label}>English</div>
          <div style={{ fontSize: card.en.length > 35 ? 20 : 24, fontWeight: 600, color: "var(--text)", lineHeight: 1.4, fontFamily: "'Playfair Display',serif", marginTop: 10 }}>{card.en}</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 16 }}>Type het Nederlandse woord</div>
        </div>
        {!status && (
          <div style={{ position: "relative" }}>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder="typ hier..." style={{ width: "100%", boxSizing: "border-box", padding: "18px 60px 18px 20px", fontSize: 20, background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--accent-rgb),0.2)", borderRadius: 14, color: "var(--text)", outline: "none", fontFamily: "system-ui,sans-serif", caretColor: "var(--accent)" }} />
            <button onClick={submit} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "rgba(var(--accent-rgb),0.15)", border: "1px solid rgba(var(--accent-rgb),0.3)", borderRadius: 8, color: "var(--accent)", padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "system-ui,sans-serif", fontWeight: 600 }}>↵</button>
          </div>
        )}
        {status && (
          <div style={{ background: `rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.08)`, border: `1px solid rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.25)`, borderRadius: 16, padding: "24px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: sc, marginBottom: 16, letterSpacing: 1 }}>{sm}</div>
            <DiffDisplay typed={input} correct={card.nl} />
            <div style={{ marginTop: 12 }}><SpeakBtn text={card.nl} /></div>
          </div>
        )}
        {!status && <button onClick={() => setStatus("wrong")} style={{ marginTop: 14, width: "100%", background: "none", border: "1px solid rgba(var(--ink-rgb),0.05)", borderRadius: 12, color: "var(--faint)", fontSize: 14, padding: "12px", cursor: "pointer", fontFamily: "system-ui,sans-serif" }}>Toon antwoord</button>}
        {status && <button onClick={advance} style={{ marginTop: 16, width: "100%", background: "linear-gradient(135deg,rgba(var(--accent-rgb),0.2),rgba(var(--accent-rgb),0.08))", border: "1px solid rgba(var(--accent-rgb),0.3)", borderRadius: 14, color: "var(--accent)", fontSize: 16, fontWeight: 600, padding: "16px", cursor: "pointer", fontFamily: "system-ui,sans-serif" }}>Volgende →</button>}
      </div>
    </div>
  );
}

// ── Multiple choice ───────────────────────────────────────────────────────────
// Shared answer buttons for vocab Kiezen and the verb / expression tests.
// `picked` is null until an option is chosen; keys 1-4 also work.
function OptionButtons({ options, answer, picked, onPick, accent = "accent" }) {
  useEffect(() => {
    const onKey = e => { const n = parseInt(e.key, 10); if (picked === null && n >= 1 && n <= options.length) onPick(options[n - 1]); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return options.map((opt, i) => {
    const base = { width: "100%", padding: "16px 18px", marginBottom: 10, borderRadius: 14, fontSize: opt.length > 28 ? 15 : 17, fontWeight: 500, textAlign: "left", cursor: picked === null ? "pointer" : "default", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", gap: 12, transition: "background 0.2s, border-color 0.2s, opacity 0.2s", background: "rgba(var(--surface-rgb),0.8)", border: `1px solid rgba(var(--${accent}-rgb),0.15)`, color: "var(--text)" };
    const st = picked === null ? base
      : opt === answer ? { ...base, background: "rgba(var(--green-rgb),0.12)", border: "1px solid rgba(var(--green-rgb),0.5)", color: "var(--green)", fontWeight: 600 }
      : opt === picked ? { ...base, background: "rgba(var(--red-rgb),0.1)", border: "1px solid rgba(var(--red-rgb),0.45)", color: "var(--red)" }
      : { ...base, opacity: 0.45 };
    return (
      <button key={opt} onClick={() => onPick(opt)} className={picked === null ? "card-in" : opt === answer ? "pop" : opt === picked ? "shake" : undefined} style={{ ...st, animationDelay: picked === null ? `${60 + i * 45}ms` : undefined }}>
        <span style={{ width: 24, height: 24, flexShrink: 0, borderRadius: 7, background: `rgba(var(--${accent}-rgb),0.08)`, color: `var(--${accent})`, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
        <span>{opt}</span>
      </button>
    );
  });
}

// Middle ground between flashcards and typing: recognise the translation among
// 4 options. Distractors come from the same deck so they're plausible.
function ChoiceCard({ card, pool, index, total, known, unknown, onNext }) {
  const [reverse, setReverse] = useState(() => localStorage.getItem("dutch-mc-reverse") === "1");
  const [pickState, setPickState] = useState(null);
  const [q, a] = reverse ? ["nl", "en"] : ["en", "nl"];
  const picked = pickState && pickState.index === index && pickState.reverse === reverse ? pickState.opt : null;
  const options = useMemo(() => {
    const others = [...new Set(pool.filter(c => c.nl !== card.nl && c.en !== card.en).map(c => c[a]))];
    return shuffle([card[a], ...shuffle(others).slice(0, 3)]);
  }, [index, card, reverse]);
  const later = useLater();
  const wrong = picked !== null && picked !== card[a];
  const pick = opt => {
    if (picked !== null) return;
    setPickState({ index, reverse, opt });
    if (opt === card[a]) later(() => onNext("known"), 700);
  };
  const enterRef = useEnterToAdvance(wrong);
  enterRef.current = () => onNext("unknown");
  const swap = () => { localStorage.setItem("dutch-mc-reverse", reverse ? "0" : "1"); setReverse(r => !r); };
  const pct = total > 0 ? (index / total) * 100 : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "20px", position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(var(--surface-rgb),0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,var(--accent),var(--red))", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <div style={{ position: "absolute", bottom: 24, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 20, fontSize: 13, color: "var(--muted)" }}>
        <span>{index + 1} / {total}</span>
        {(known > 0 || unknown > 0) && <><span style={{ color: "var(--green)" }}>✓ {known}</span><span style={{ color: "var(--red)" }}>✗ {unknown}</span></>}
      </div>
      <div style={{ width: "100%", maxWidth: 380, marginTop: 40 }}>
        <div key={`q-${index}-${reverse}`} className="card-in" style={{ background: "rgba(var(--surface-rgb),0.75)", border: "1px solid rgba(var(--accent-rgb),0.12)", borderRadius: 20, padding: "22px 24px", textAlign: "center", marginBottom: 20 }}>
          <button onClick={swap} aria-label="Wissel richting" style={{ ...s.label, letterSpacing: 2, background: "none", border: "1px solid rgba(var(--accent-rgb),0.25)", borderRadius: 20, padding: "5px 12px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{reverse ? "Nederlands → English" : "English → Nederlands"} ⇄</button>
          <div style={{ fontSize: card[q].length > 35 ? 20 : 24, fontWeight: 600, color: "var(--text)", lineHeight: 1.4, fontFamily: "'Playfair Display',serif", marginTop: 14 }}>{card[q]}</div>
          {canSpeak && <div style={{ marginTop: 12, height: 38, visibility: reverse || picked !== null ? "visible" : "hidden" }}><SpeakBtn text={card.nl} /></div>}
        </div>
        <OptionButtons key={`o-${index}-${reverse}`} options={options} answer={card[a]} picked={picked} onPick={pick} />
        <button onClick={() => onNext("unknown")} disabled={!wrong} style={{ visibility: wrong ? "visible" : "hidden", marginTop: 6, width: "100%", background: "linear-gradient(135deg,rgba(var(--accent-rgb),0.2),rgba(var(--accent-rgb),0.08))", border: "1px solid rgba(var(--accent-rgb),0.3)", borderRadius: 14, color: "var(--accent)", fontSize: 16, fontWeight: 600, padding: "16px", cursor: "pointer", fontFamily: "system-ui,sans-serif" }}>Volgende →</button>
      </div>
    </div>
  );
}

// ── Results ───────────────────────────────────────────────────────────────────
function Results({ known, unknown, onRestart, onHome, onRetry }) {
  const total = known.length + unknown.length, pct = total > 0 ? Math.round((known.length / total) * 100) : 0;
  return (
    <div style={s.screen}>
      <div style={{ fontSize: 64, fontWeight: 700, fontFamily: "'Playfair Display',serif", color: pct >= 80 ? "var(--green)" : pct >= 50 ? "var(--accent)" : "var(--red)", marginBottom: 8 }}><CountUp to={pct} />%{pct >= 80 && <Confetti />}</div>
      <div style={{ color: "var(--muted)", fontSize: 15, marginBottom: 8 }}>{known.length} goed · {unknown.length} fout</div>
      <div style={{ color: "var(--text)", fontSize: 20, fontWeight: 600, marginBottom: 40, fontFamily: "'Playfair Display',serif" }}>{pct >= 90 ? "Uitstekend!" : pct >= 70 ? "Goed bezig!" : pct >= 50 ? "Ga zo door!" : "Blijf oefenen!"}</div>
      {unknown.length > 0 && (
        <div style={{ width: "100%", maxWidth: 340, marginBottom: 24, background: "rgba(var(--surface-rgb),0.65)", border: "1px solid rgba(var(--red-rgb),0.15)", borderRadius: 16, padding: "16px 20px", maxHeight: 200, overflowY: "auto" }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "var(--red)", marginBottom: 12, fontWeight: 600 }}>Nog te leren</div>
          {unknown.map((card, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < unknown.length - 1 ? "1px solid rgba(var(--surface-rgb),0.75)" : "none", fontSize: 14 }}>
              <span style={{ color: "var(--text)" }}>{card.nl}</span>
              <span style={{ color: "var(--muted)", marginLeft: 12 }}>{card.en}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 340 }}>
        {unknown.length > 0 && <button onClick={onRetry} style={{ ...s.wrongBtn, width: "100%" }}>Oefen fouten opnieuw</button>}
        <button onClick={onRestart} style={s.chapterBtn}>Opnieuw shufflen</button>
        <button onClick={onHome} style={{ ...s.chapterBtn, color: "var(--muted)", border: "1px solid rgba(var(--ink-rgb),0.07)" }}>← Terug naar menu</button>
      </div>
    </div>
  );
}

// ── Expressions home ──────────────────────────────────────────────────────────
function ExpressionsHome({ onBack, onBrowse, onTest, allExpressions }) {
  return (
    <div style={{ ...s.screen, position: "relative" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Menu</button>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ ...s.label, color: "var(--teal)" }}>Uitdrukkingen</div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Expressions</h2>
        <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 6 }}>Begrip · Bevestigen · Eens zijn · Nuance · meer</div>
      </div>
      <button onClick={onBrowse} style={{ ...s.chapterBtn, borderColor: "rgba(var(--teal-rgb),0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>📚</span>
        <div>
          <div style={{ color: "var(--text)", fontWeight: 600, fontSize: 17 }}>Bestuderen</div>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>{allExpressions.length} expressions · browse by category</div>
        </div>
      </button>
      <button onClick={onTest} style={{ ...s.chapterBtn, borderColor: "rgba(var(--teal-rgb),0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>🎯</span>
        <div>
          <div style={{ color: "var(--text)", fontWeight: 600, fontSize: 17 }}>Oefenen</div>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>Fill in the blank · conversation context</div>
        </div>
      </button>
    </div>
  );
}

// ── Expressions browse ─────────────────────────────────────────────────────────
function ExpressionsBrowse({ onBack, expressions, categories }) {
  const [activeCategory, setActiveCategory] = useState("all");
  const [search, setSearch] = useState("");
  const src = activeCategory === "all" ? expressions : expressions.filter(e => e.category === activeCategory);
  const q = normalize(search);
  const filtered = src.filter(e => !q || normalize(e.nl).includes(q) || normalize(e.en).includes(q));
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 50%,var(--bg3) 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,var(--bg1),var(--bg2))", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Uitdrukkingen</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={{ ...s.label, color: "var(--teal)" }}>Bestuderen</div></div>
          <div style={{ width: 60 }} />
        </div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 10, scrollbarWidth: "none" }}>
          {["all", ...categories].map(cat => {
            const active = activeCategory === cat;
            return <button key={cat} onClick={() => setActiveCategory(cat)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(var(--teal-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: active ? "1px solid rgba(var(--teal-rgb),0.4)" : "1px solid rgba(var(--ink-rgb),0.06)", color: active ? "var(--teal)" : "var(--muted)" }}>{cat === "all" ? "Alles" : cat}</button>;
          })}
        </div>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--faint)", fontSize: 15 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken..." style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px 12px 38px", background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--teal-rgb),0.15)", borderRadius: 12, color: "var(--text)", fontSize: 15, outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "var(--teal)" }} />
        </div>
        <div style={{ fontSize: 12, color: "var(--faint)", paddingBottom: 8 }}>{filtered.length} uitdrukkingen</div>
      </div>
      <div style={{ flex: 1, padding: "0 20px 32px" }}>
        {filtered.map((e, i) => (
          <div key={i} style={{ padding: "14px 0", borderBottom: "1px solid rgba(var(--surface-rgb),0.85)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <span style={{ color: "var(--text)", fontSize: 15, fontWeight: 500 }}><Say text={e.nl} /></span>
              <span style={{ color: "var(--muted)", fontSize: 14, textAlign: "right", flex: 1 }}>{e.en}</span>
            </div>
            {e.note && <div style={{ color: "var(--faint)", fontSize: 12, marginTop: 4, fontStyle: "italic" }}>{e.note}</div>}
          </div>
        ))}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "var(--faint)", marginTop: 60, fontSize: 15 }}>Geen resultaten</div>}
      </div>
    </div>
  );
}

// ── Expressions test setup ─────────────────────────────────────────────────────
function ExpressionsTestSetup({ onBack, onStart, categories, mc, onMc }) {
  const [selectedCats, setSelectedCats] = useState(() => new Set(categories));
  const [count, setCount] = useState(15);
  const toggleCat = cat => {
    setSelectedCats(prev => {
      if (prev.has(cat) && prev.size === 1) return prev;
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  };
  return (
    <div style={{ ...s.screen, position: "relative", padding: "60px 24px 32px" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Uitdrukkingen</button>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ ...s.label, color: "var(--teal)" }}>Oefenen</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Choose your challenge</h2>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 10 }}>Categorieën</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {categories.map(cat => (
            <button key={cat} onClick={() => toggleCat(cat)} style={{ padding: "8px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: selectedCats.has(cat) ? "rgba(var(--teal-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: selectedCats.has(cat) ? "1px solid rgba(var(--teal-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", color: selectedCats.has(cat) ? "var(--teal)" : "var(--muted)" }}>{cat}</button>
          ))}
        </div>
      </div>
      <InputModeToggle mc={mc} onMc={onMc} accent="teal" />
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 24 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600, marginBottom: 10 }}>Aantal vragen</div>
        <div style={{ display: "flex", gap: 8 }}>
          {[10, 15, 25].map(n => (
            <button key={n} onClick={() => setCount(n)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: count === n ? "rgba(var(--teal-rgb),0.15)" : "rgba(var(--surface-rgb),0.75)", border: count === n ? "1px solid rgba(var(--teal-rgb),0.5)" : "1px solid rgba(var(--ink-rgb),0.07)", color: count === n ? "var(--teal)" : "var(--muted)" }}>{n}</button>
          ))}
        </div>
      </div>
      <button onClick={() => onStart(count, [...selectedCats])} style={{ width: "100%", maxWidth: 340, padding: "16px", borderRadius: 14, background: "linear-gradient(135deg,rgba(var(--teal-rgb),0.25),rgba(var(--teal-rgb),0.1))", border: "1px solid rgba(var(--teal-rgb),0.4)", color: "var(--teal)", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Start →</button>
    </div>
  );
}

// ── Expression test ────────────────────────────────────────────────────────────
function ExpressionTest({ items, onComplete, onBack, inputMode, optionsFor, explain }) {
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(null);
  const [score, setScore] = useState({ right: 0, wrong: 0, wrongs: [] });
  const inputRef = useRef(null);
  // Missed items are put back a few places further on until answered right;
  // the score counts first tries only.
  const [queue, setQueue] = useState(items);
  const current = queue[index];
  const typing = inputMode !== "mc";
  const [pickState, setPickState] = useState(null);
  const picked = pickState && pickState.index === index ? pickState.opt : null;
  const options = useMemo(() => (!typing && current ? optionsFor(current) : []), [current, typing]);
  const answered = typing ? !!status : picked !== null;
  const pickedWrong = picked !== null && picked !== current?.answer;
  const later = useLater();
  const enterRef = useEnterToAdvance(typing ? !!status : pickedWrong);
  useEffect(() => { setInput(""); setStatus(null); setTimeout(() => inputRef.current?.focus(), 80); }, [index]);
  if (!current) return null;
  const submit = () => { if (!input.trim()) return; setStatus(checkAnswer(input, current.answer)); };
  const advance = (forced) => {
    const wasRight = typeof forced === "boolean" ? forced : status === "exact" || status === "close";
    recordAttempt(exprSentId(current), wasRight);
    const newScore = score.wrongs.includes(current) ? score : { right: score.right + (wasRight ? 1 : 0), wrong: score.wrong + (wasRight ? 0 : 1), wrongs: wasRight ? score.wrongs : [...score.wrongs, current] };
    setScore(newScore);
    let q = queue;
    if (!wasRight) { q = [...queue]; q.splice(Math.min(index + 4, q.length), 0, current); setQueue(q); }
    if (index >= q.length - 1) onComplete(newScore);
    else setIndex(i => i + 1);
  };
  enterRef.current = () => advance(typing ? undefined : false);
  const pick = opt => {
    if (picked !== null) return;
    setPickState({ index, opt });
    if (opt === current.answer) later(() => advance(true), 700);
  };
  const handleKey = e => { if (e.key === "Enter") { if (status) advance(); else submit(); } };
  const pct = (index / queue.length) * 100;
  const parts = current.sentence.split("___");
  const fill = () => current.answer;
  const sentence = parts.join(current.answer);
  const sc = status === "exact" ? "var(--green)" : status === "close" ? "var(--accent)" : "var(--red)";
  const sm = status === "exact" ? "Precies goed! 🎉" : status === "close" ? "Bijna goed!" : "Niet helemaal...";
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1),var(--bg2) 50%,var(--bg3))", fontFamily: "system-ui,sans-serif", position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px 40px" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(var(--surface-rgb),0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,var(--teal),var(--green))", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 18, left: 18 }}>← Test menu</button>
      <div style={{ position: "absolute", top: 18, right: 18, fontSize: 12, color: "var(--muted)" }}>{index + 1} / {queue.length} · <span style={{ color: "var(--green)" }}>✓ {score.right}</span> <span style={{ color: "var(--red)" }}>✗ {score.wrong}</span></div>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div key={`q-${index}`} className="card-in" style={{ background: "rgba(var(--surface-rgb),0.75)", border: "1px solid rgba(var(--teal-rgb),0.18)", borderRadius: 20, padding: "28px 24px", textAlign: "center", marginBottom: 18 }}>
          <div style={s.label}>Vul in</div>
          <div style={{ fontSize: 18, color: "var(--text)", lineHeight: 1.7, marginTop: 12, fontFamily: "'Playfair Display',serif" }}>
            {parts.map((p, i) => (
              <span key={i}>{p}{i < parts.length - 1 && (answered ? <span style={{ color: "var(--green)", fontWeight: 700 }}>{fill(i)}</span> : <span style={{ color: "var(--teal)", fontWeight: 700, borderBottom: "2px dashed var(--teal)", padding: "0 12px" }}>____</span>)}</span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 14, fontStyle: "italic" }}>{current.hint}</div>
          {canSpeak && <div style={{ marginTop: 12, height: 38, visibility: answered ? "visible" : "hidden" }}><SpeakBtn text={sentence} /></div>}
        </div>
        {!typing && (
          <>
            <OptionButtons key={index} options={options} answer={current.answer} picked={picked} onPick={pick} accent="teal" />
            <button onClick={() => advance(false)} disabled={!pickedWrong} style={{ visibility: pickedWrong ? "visible" : "hidden", marginTop: 4, width: "100%", background: "linear-gradient(135deg,rgba(var(--teal-rgb),0.2),rgba(var(--teal-rgb),0.08))", border: "1px solid rgba(var(--teal-rgb),0.35)", borderRadius: 14, color: "var(--teal)", fontSize: 16, fontWeight: 600, padding: "15px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Volgende →</button>
          </>
        )}
        {typing && !status && (
          <div style={{ position: "relative" }}>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder="type the expression..." style={{ width: "100%", boxSizing: "border-box", padding: "16px 60px 16px 18px", fontSize: 17, background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--teal-rgb),0.25)", borderRadius: 14, color: "var(--text)", outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "var(--teal)" }} />
            <button onClick={submit} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "rgba(var(--teal-rgb),0.18)", border: "1px solid rgba(var(--teal-rgb),0.35)", borderRadius: 8, color: "var(--teal)", padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>↵</button>
          </div>
        )}
        {typing && !status && <button onClick={() => setStatus("wrong")} style={{ marginTop: 12, width: "100%", background: "none", border: "1px solid rgba(var(--ink-rgb),0.05)", borderRadius: 12, color: "var(--faint)", fontSize: 13, padding: "10px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Toon antwoord</button>}
        {typing && status && (
          <>
            <div style={{ background: `rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.08)`, border: `1px solid rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.25)`, borderRadius: 16, padding: "20px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: sc, marginBottom: 14, letterSpacing: 1 }}>{sm}</div>
              <DiffDisplay typed={input} correct={current.answer} />
            </div>
            <button onClick={advance} style={{ marginTop: 14, width: "100%", background: "linear-gradient(135deg,rgba(var(--teal-rgb),0.2),rgba(var(--teal-rgb),0.08))", border: "1px solid rgba(var(--teal-rgb),0.35)", borderRadius: 14, color: "var(--teal)", fontSize: 16, fontWeight: 600, padding: "15px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{index >= queue.length - 1 && status !== "wrong" ? "Klaar →" : "Volgende →"}</button>
          </>
        )}
        {answered && <Explain info={explain(current)} accent="teal" />}
      </div>
    </div>
  );
}

// ── Expression results ─────────────────────────────────────────────────────────
function ExpressionResults({ score, onRestart, onRetry, onHome }) {
  const total = score.right + score.wrong;
  const pct = total > 0 ? Math.round((score.right / total) * 100) : 0;
  return (
    <div style={s.screen}>
      <div style={{ fontSize: 64, fontWeight: 700, fontFamily: "'Playfair Display',serif", color: pct >= 80 ? "var(--green)" : pct >= 50 ? "var(--accent)" : "var(--red)", marginBottom: 8 }}><CountUp to={pct} />%{pct >= 80 && <Confetti />}</div>
      <div style={{ color: "var(--muted)", fontSize: 15, marginBottom: 8 }}>{score.right} goed · {score.wrong} fout</div>
      <div style={{ color: "var(--text)", fontSize: 20, fontWeight: 600, marginBottom: 32, fontFamily: "'Playfair Display',serif" }}>{pct >= 90 ? "Uitstekend!" : pct >= 70 ? "Goed bezig!" : pct >= 50 ? "Ga zo door!" : "Blijf oefenen!"}</div>
      {score.wrongs.length > 0 && (
        <div style={{ width: "100%", maxWidth: 360, marginBottom: 22, background: "rgba(var(--surface-rgb),0.65)", border: "1px solid rgba(var(--red-rgb),0.15)", borderRadius: 16, padding: "16px 20px", maxHeight: 240, overflowY: "auto" }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "var(--red)", marginBottom: 10, fontWeight: 600 }}>Nog te leren</div>
          {score.wrongs.map((w, i) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: i < score.wrongs.length - 1 ? "1px solid rgba(var(--surface-rgb),0.75)" : "none", fontSize: 13 }}>
              <div style={{ color: "var(--accent)" }}>{w.answer}</div>
              <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{w.hint}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 340 }}>
        {score.wrongs.length > 0 && <button onClick={() => onRetry(score.wrongs)} style={{ ...s.wrongBtn, width: "100%" }}>Oefen fouten opnieuw</button>}
        <button onClick={onRestart} style={s.chapterBtn}>Opnieuw</button>
        <button onClick={onHome} style={{ ...s.chapterBtn, color: "var(--muted)", border: "1px solid rgba(var(--ink-rgb),0.07)" }}>← Terug naar menu</button>
      </div>
    </div>
  );
}

// ── Nuances browse ─────────────────────────────────────────────────────────────
function NuancesBrowse({ onBack, onPractice, nuances }) {
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState("");
  const q = normalize(search);
  const filtered = nuances.filter(n => !q || normalize(n.topic).includes(q) || normalize(n.rule).includes(q));
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 50%,var(--bg3) 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,var(--bg1),var(--bg2))", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Menu</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={{ ...s.label, color: "var(--amber)" }}>Nuances</div></div>
          <button onClick={onPractice} style={{ background: "rgba(var(--amber-rgb),0.1)", border: "1px solid rgba(var(--amber-rgb),0.3)", borderRadius: 8, color: "var(--amber)", fontSize: 12, fontWeight: 600, padding: "6px 10px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>🎯 Oefen</button>
        </div>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--faint)", fontSize: 15 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken..." style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px 12px 38px", background: "rgba(var(--surface-rgb),0.85)", border: "1px solid rgba(var(--amber-rgb),0.15)", borderRadius: 12, color: "var(--text)", fontSize: 15, outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "var(--amber)" }} />
        </div>
        <div style={{ fontSize: 12, color: "var(--faint)", paddingBottom: 8 }}>{filtered.length} topics</div>
      </div>
      <div style={{ flex: 1, padding: "0 20px 40px" }}>
        {filtered.map((n, i) => {
          const open = expanded === n.id;
          return (
            <div key={n.id} style={{ borderBottom: "1px solid rgba(var(--surface-rgb),0.85)" }}>
              <button onClick={() => setExpanded(open ? null : n.id)} style={{ width: "100%", background: "none", border: "none", padding: "16px 0", textAlign: "left", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div>
                  <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 600 }}>{n.topic}</div>
                  <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4, lineHeight: 1.4 }}>{n.rule}</div>
                </div>
                <span style={{ color: "var(--amber)", fontSize: 18, flexShrink: 0, marginTop: 2 }}>{open ? "▲" : "▼"}</span>
              </button>
              {open && (
                <div style={{ paddingBottom: 20 }}>
                  <div style={{ overflowX: "auto", marginBottom: 16 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr>
                          {["Nederlands", "English", "Note"].map(h => (
                            <td key={h} style={{ padding: "8px 10px", borderBottom: "1px solid rgba(var(--amber-rgb),0.2)", color: "var(--amber)", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>{h}</td>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {n.examples.map((ex, j) => (
                          <tr key={j} style={{ background: j % 2 === 0 ? "rgba(var(--surface-rgb),0.02)" : "transparent" }}>
                            <td style={{ padding: "9px 10px", color: "var(--text)", verticalAlign: "top", fontStyle: "italic" }}><Say text={ex.nl} /></td>
                            <td style={{ padding: "9px 10px", color: "var(--muted)", verticalAlign: "top" }}>{ex.en}</td>
                            <td style={{ padding: "9px 10px", color: "var(--faint)", verticalAlign: "top", fontSize: 12 }}>{ex.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {n.tips.length > 0 && (
                    <div style={{ background: "rgba(var(--amber-rgb),0.05)", border: "1px solid rgba(var(--amber-rgb),0.12)", borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
                      <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--amber)", fontWeight: 600, marginBottom: 8 }}>Tips</div>
                      {n.tips.map((tip, j) => (
                        <div key={j} style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.5, marginBottom: j < n.tips.length - 1 ? 6 : 0 }}>· {tip}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "var(--faint)", marginTop: 60, fontSize: 15 }}>Geen resultaten</div>}
      </div>
    </div>
  );
}

// ── Podcast home ───────────────────────────────────────────────────────────────
const PODCAST_ACCENT = "var(--podcast)";

function PodcastHome({ episodes, onBack, onBrowse, onPractice }) {
  const totalWords = ep => ep.sections.reduce((n, s) => n + s.words.length, 0);
  return (
    <div style={{ ...s.screen, position: "relative" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Menu</button>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ ...s.label, color: PODCAST_ACCENT }}>Podcast</div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Een Beetje Nederlands</h2>
        <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 6 }}>Woorden & uitdrukkingen per aflevering</div>
      </div>
      {episodes.map(ep => (
        <div key={ep.id} style={{ width: "100%", maxWidth: 340, marginBottom: 14, background: "rgba(var(--surface-rgb),0.75)", border: `1px solid rgba(var(--podcast-rgb),0.2)`, borderRadius: 16, padding: "18px 20px" }}>
          <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 17, fontFamily: "'Playfair Display',serif", marginBottom: 4 }}>{ep.title}</div>
          <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 14, lineHeight: 1.4 }}>{ep.description}</div>
          <div style={{ color: "var(--faint)", fontSize: 12, marginBottom: 14 }}>{totalWords(ep)} woorden · {ep.sections.length} secties</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => onBrowse(ep)} style={{ flex: 1, padding: "11px", borderRadius: 10, background: `rgba(var(--podcast-rgb),0.07)`, border: `1px solid rgba(var(--podcast-rgb),0.18)`, color: PODCAST_ACCENT, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>📖 Lees</button>
            <button onClick={() => onPractice(ep)} style={{ flex: 1, padding: "11px", borderRadius: 10, background: `rgba(var(--podcast-rgb),0.13)`, border: `1px solid rgba(var(--podcast-rgb),0.3)`, color: PODCAST_ACCENT, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>🎯 Oefen</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Episode browse ──────────────────────────────────────────────────────────────
function EpisodeBrowse({ episode, onBack }) {
  const [expanded, setExpanded] = useState(() => new Set([0]));
  const toggle = i => setExpanded(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 50%,var(--bg3) 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,var(--bg1),var(--bg2))", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Podcast</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={{ ...s.label, color: PODCAST_ACCENT }}>{episode.title}</div></div>
          <div style={{ width: 60 }} />
        </div>
      </div>
      <div style={{ flex: 1, padding: "0 16px 40px" }}>
        {episode.sections.map((sec, i) => {
          const open = expanded.has(i);
          return (
            <div key={i} style={{ marginBottom: 8 }}>
              <button onClick={() => toggle(i)} style={{ width: "100%", background: open ? `rgba(var(--podcast-rgb),0.09)` : "rgba(var(--surface-rgb),0.65)", border: `1px solid rgba(var(--podcast-rgb),0.15)`, borderRadius: open ? "12px 12px 0 0" : 12, padding: "13px 16px", textAlign: "left", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "'DM Sans',sans-serif" }}>
                <span style={{ color: "var(--text)", fontWeight: 600, fontSize: 14 }}>{sec.title}</span>
                <span style={{ color: PODCAST_ACCENT, fontSize: 12 }}>{sec.words.length} · {open ? "▲" : "▼"}</span>
              </button>
              {open && (
                <div style={{ background: "rgba(var(--surface-rgb),0.55)", border: `1px solid rgba(var(--podcast-rgb),0.12)`, borderTop: "none", borderRadius: "0 0 12px 12px" }}>
                  {sec.words.map((w, j) => (
                    <div key={j} style={{ padding: "12px 16px", borderBottom: j < sec.words.length - 1 ? "1px solid rgba(var(--surface-rgb),0.85)" : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: w.note ? 5 : 0 }}>
                        <span style={{ color: "var(--text)", fontSize: 14, fontWeight: 500, flex: "0 0 auto", maxWidth: "55%" }}><Say text={w.nl} /></span>
                        <span style={{ color: "var(--muted)", fontSize: 13, textAlign: "right" }}>{w.en}</span>
                      </div>
                      {w.note && <div style={{ color: "var(--faint)", fontSize: 12, fontStyle: "italic", lineHeight: 1.5, marginTop: 3 }}>{w.note}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [appData, setAppData] = useState(null);
  const [screen, setScreen] = useState("home");
  const [darkMode, setDarkMode] = useState(() => { const v = localStorage.getItem("dutch-dark-mode"); return v === null ? window.matchMedia("(prefers-color-scheme: dark)").matches : v === "1"; });
  const [mode, setMode] = useState("flip");
  const [cards, setCards] = useState([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState([]);
  const [unknown, setUnknown] = useState([]);
  const [chunkSize, setChunkSize] = useState(20);
  const [verbTestItems, setVerbTestItems] = useState([]);
  const [verbTestMode, setVerbTestMode] = useState("context");
  const [verbTestTenses, setVerbTestTenses] = useState(["presens", "imperfectum", "perfectum"]);
  const [verbTestGroups, setVerbTestGroups] = useState([]);
  const [verbScore, setVerbScore] = useState(null);
  const [exprTestItems, setExprTestItems] = useState([]);
  const [exprTestCats, setExprTestCats] = useState([]);
  const [exprScore, setExprScore] = useState(null);
  const [practicePool, setPracticePool] = useState([]);
  const [practiceTitle, setPracticeTitle] = useState("");
  const [practiceSource, setPracticeSource] = useState("vocabHome");
  const [podcastEpisode, setPodcastEpisode] = useState(null);
  const [quickVerbs, setQuickVerbs] = useState(false);
  const [testMc, setTestMc] = useState(() => localStorage.getItem("dutch-test-mc") === "1");
  useEffect(() => { localStorage.setItem("dutch-test-mc", testMc ? "1" : "0"); }, [testMc]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", darkMode ? "#14110e" : "#f5f0ea");
    localStorage.setItem("dutch-dark-mode", darkMode ? "1" : "0");
  }, [darkMode]);

  useEffect(() => {
    Promise.all([
      fetch("./data/vocab.json").then(r => r.json()),
      fetch("./data/verbs.json").then(r => r.json()),
      fetch("./data/verb_sentences.json").then(r => r.json()),
      fetch("./data/expressions.json").then(r => r.json()),
      fetch("./data/expression_sentences.json").then(r => r.json()),
      fetch("./data/nuances.json").then(r => r.json()),
      fetch("./data/podcast.json").then(r => r.json()),
    ]).then(([vocab, verbs, sentences, expressions, exprSentences, nuances, podcast]) => {
      const chapters = Object.keys(vocab);
      const allVocab = Object.values(vocab).flat();
      const coreVerbs = verbs.core || [];
      const chapVerbs = Object.fromEntries(Object.entries(verbs).filter(([k]) => k !== "core"));
      const allVerbsRaw = [...coreVerbs, ...Object.values(chapVerbs).flat()];
      const allVerbs = Array.from(new Map(allVerbsRaw.map(v => [v.inf, v])).values());
      const verbGroups = { "Kern werkwoorden": coreVerbs, ...chapVerbs };
      const verbGroupNames = Object.keys(verbGroups);
      const exprCategories = [...new Set(expressions.map(e => e.category))];
      const podcastEpisodes = podcast.episodes || [];
      setAppData({ vocab, chapters, allVocab, allVerbs, verbGroups, verbGroupNames, sentences, expressions, exprSentences, exprCategories, nuances, podcastEpisodes });
    }).catch(err => {
      console.error("Failed to load data:", err);
      setAppData({ vocab: {}, chapters: [], allVocab: [], allVerbs: [], verbGroups: {}, verbGroupNames: [], sentences: [], expressions: [], exprSentences: [], exprCategories: [], nuances: [] });
    });
  }, []);

  const startDeck = useCallback((deck, m, size) => {
    const sz = size !== undefined ? size : chunkSize;
    const picked = weightedPick(deck, vocabId, sz);
    setCards(picked); setIdx(0); setFlipped(false); setKnown([]); setUnknown([]);
    setMode(m); setScreen("cards");
  }, [chunkSize]);

  // The score counts first tries only. A missed card is put back a few cards
  // further on and keeps coming back until it's answered right; those repeat
  // attempts feed the per-word stats but not the session score. Swiping past a
  // flashcard without judging it (no result) records nothing.
  const handleNext = useCallback((result) => {
    const card = cards[idx];
    if (result) recordAttempt(vocabId(card), result === "known");
    const isRepeat = unknown.includes(card);
    if (result === "known" && !isRepeat) setKnown(k => [...k, card]);
    if (result === "unknown" && !isRepeat) setUnknown(u => [...u, card]);
    let deck = cards;
    if (result === "unknown") { deck = [...cards]; deck.splice(Math.min(idx + 4, deck.length), 0, card); setCards(deck); }
    if (idx >= deck.length - 1) setTimeout(() => setScreen("results"), 100);
    else { setIdx(i => i + 1); setFlipped(false); }
  }, [idx, cards, unknown]);

  const handlePrev = useCallback(() => {
    if (idx > 0) { setIdx(i => i - 1); setFlipped(false); }
  }, [idx]);

  if (!appData) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--muted)", fontFamily: "system-ui", fontSize: 16 }}>Laden…</div>
      </div>
    );
  }

  const { vocab, chapters, allVocab, allVerbs, verbGroups, verbGroupNames, sentences, expressions, exprSentences, exprCategories, nuances, podcastEpisodes } = appData;

  // `quick` = started from the home screen's Snelle ronde: always multiple
  // choice, and back / done return to the home screen instead of the setup.
  const startVerbTest = (testMode, count, selectedTenses, selectedGroups, quick = false) => {
    setQuickVerbs(quick);
    const groups = selectedGroups || verbGroupNames;
    const verbSet = new Set(groups.flatMap(g => (verbGroups[g] || []).map(v => v.inf)));
    const pool = sentences.filter(snt => selectedTenses.includes(snt.tense) && verbSet.has(snt.verb));
    const items = weightedPick(pool, verbSentId, count);
    setVerbTestItems(items);
    setVerbTestMode(testMode);
    setVerbTestTenses(selectedTenses);
    setVerbTestGroups(groups);
    setVerbScore(null);
    setScreen("verbTest");
  };

  const startExpressionTest = (count, selectedCats) => {
    const catSet = new Set(selectedCats);
    const exprSet = new Set(expressions.filter(e => catSet.has(e.category)).map(e => e.nl));
    const pool = exprSentences.filter(s => exprSet.has(s.answer));
    setExprTestItems(weightedPick(pool, exprSentId, count));
    setExprTestCats(selectedCats);
    setExprScore(null);
    setScreen("exprTest");
  };

  const handlePractice = (deck, title, source = "vocabHome") => { setPracticePool(deck); setPracticeTitle(title); setPracticeSource(source); setScreen("mode"); };
  const startQuick = () => {
    setPracticePool(allVocab); setPracticeTitle("Snelle ronde"); setPracticeSource("home"); setChunkSize(15);
    startDeck(quickPick(allVocab, 15), "mc", 15);
  };
  const startQuickVerbs = () => startVerbTest("context", 15, ["presens", "imperfectum", "perfectum"], verbGroupNames, true);
  const handleMode = (m, size) => { setChunkSize(size); startDeck(practicePool, m, size); };

  const nextMode = { flip: "mc", mc: "type", type: "flip" }[mode];
  const cardsScreen = (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 50%,var(--bg3) 100%)", fontFamily: "system-ui,sans-serif", position: "relative" }}>
      <button onClick={() => setScreen(practiceSource)} style={{ ...s.backBtn, position: "absolute", top: 18, left: 18, zIndex: 10 }}>← Menu</button>
      <button onClick={() => setScreen("glossary")} style={{ position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 10, background: "rgba(var(--blue-rgb),0.08)", border: "1px solid rgba(var(--blue-rgb),0.2)", borderRadius: 8, color: "var(--blue)", fontSize: 12, padding: "6px 12px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>📖 Lijst</button>
      <button onClick={() => startDeck(practicePool, nextMode, chunkSize)} style={{ position: "absolute", top: 14, right: 16, zIndex: 10, background: "rgba(var(--ink-rgb),0.05)", border: "1px solid rgba(var(--accent-rgb),0.15)", borderRadius: 8, color: "var(--accent)", fontSize: 12, padding: "6px 12px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{{ flip: "🃏 Kaarten", mc: "👆 Kiezen", type: "⌨️ Typen" }[nextMode]}</button>
      {mode === "flip" && <Flashcard card={cards[idx]} flipped={flipped} onFlip={() => setFlipped(f => !f)} onNext={handleNext} onPrev={handlePrev} index={idx} total={cards.length} known={known.length} unknown={unknown.length} />}
      {mode === "mc" && <ChoiceCard card={cards[idx]} pool={practicePool.length >= 4 ? practicePool : allVocab} index={idx} total={cards.length} known={known.length} unknown={unknown.length} onNext={handleNext} />}
      {mode === "type" && <TypingCard card={cards[idx]} index={idx} total={cards.length} known={known.length} unknown={unknown.length} onNext={handleNext} />}
    </div>
  );

  return (
    <>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg1);font-family:system-ui,sans-serif}input::placeholder{color:var(--faint)}::-webkit-scrollbar{display:none}input{color:var(--text)}`}</style>
      <button onClick={() => setDarkMode(d => !d)} style={{ position: "fixed", bottom: 20, right: 20, zIndex: 9999, width: 44, height: 44, borderRadius: "50%", border: "1px solid rgba(var(--ink-rgb),0.12)", background: "rgba(var(--surface-rgb),0.85)", fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(8px)", boxShadow: "0 2px 12px rgba(var(--ink-rgb),0.1)" }}>{darkMode ? "☀️" : "🌙"}</button>
      <div key={screen} className="screen-in">
      {screen === "home" && <Home allVocab={allVocab} allVerbs={allVerbs} allExpressions={expressions} nuances={nuances} podcastEpisodes={podcastEpisodes} onVocab={() => setScreen("vocabHome")} onVerbs={() => setScreen("verbs")} onExpressions={() => setScreen("expressions")} onNuances={() => setScreen("nuances")} onPodcast={() => setScreen("podcast")} onQuick={startQuick} onQuickVerbs={startQuickVerbs} />}
      {screen === "podcast" && <PodcastHome episodes={podcastEpisodes} onBack={() => setScreen("home")} onBrowse={ep => { setPodcastEpisode(ep); setScreen("podcastBrowse"); }} onPractice={ep => { const deck = ep.sections.flatMap(s => s.words); handlePractice(deck, ep.title, "podcast"); }} />}
      {screen === "podcastBrowse" && podcastEpisode && <EpisodeBrowse episode={podcastEpisode} onBack={() => setScreen("podcast")} />}
      {screen === "nuances" && <NuancesBrowse nuances={nuances} onBack={() => setScreen("home")} onPractice={() => handlePractice(nuances.flatMap(n => n.examples), "Nuances · voorbeeldzinnen", "nuances")} />}
      {screen === "vocabHome" && <VocabHome chapters={chapters} vocab={vocab} allVocab={allVocab} onBack={() => setScreen("home")} onGlossary={() => setScreen("glossary")} onPractice={handlePractice} />}
      {screen === "glossary" && <Glossary vocab={vocab} allVocab={allVocab} chapters={chapters} onBack={() => setScreen("vocabHome")} onPractice={(deck, title) => handlePractice(deck, title, "glossary")} />}
      {screen === "verbs" && <VerbsHome allVerbs={allVerbs} onBack={() => setScreen("home")} onStudy={() => setScreen("verbStudy")} onTest={() => setScreen("verbTestSetup")} />}
      {screen === "verbStudy" && <VerbStudy verbGroups={verbGroups} verbGroupNames={verbGroupNames} onBack={() => setScreen("verbs")} />}
      {screen === "verbTestSetup" && <VerbTestSetup onBack={() => setScreen("verbs")} onStart={startVerbTest} verbGroupNames={verbGroupNames} mc={testMc} onMc={setTestMc} />}
      {screen === "verbTest" && <VerbTest items={verbTestItems} mode={verbTestMode} inputMode={quickVerbs || testMc ? "mc" : "type"} optionsFor={it => verbOptions(it, sentences, allVerbs)} explain={it => { const v = allVerbs.find(x => x.inf === it.verb); return v && { head: `${v.inf} · ${v.en}`, body: `${v.presIk || v.inf} – ${v.impSg} – ${v.vd} (${v.aux})` }; }} onBack={() => setScreen(quickVerbs ? "home" : "verbTestSetup")} backLabel={quickVerbs ? "← Menu" : undefined} onComplete={scr => { setVerbScore(scr); setScreen("verbResults"); }} />}
      {screen === "verbResults" && verbScore && <VerbResults score={verbScore} onRestart={() => startVerbTest(verbTestMode, verbTestItems.length, verbTestTenses, verbTestGroups, quickVerbs)} onRetry={wrongs => { setVerbTestItems(wrongs); setVerbScore(null); setScreen("verbTest"); }} onHome={() => setScreen(quickVerbs ? "home" : "verbs")} />}
      {screen === "expressions" && <ExpressionsHome allExpressions={expressions} onBack={() => setScreen("home")} onBrowse={() => setScreen("exprBrowse")} onTest={() => setScreen("exprTestSetup")} />}
      {screen === "exprBrowse" && <ExpressionsBrowse expressions={expressions} categories={exprCategories} onBack={() => setScreen("expressions")} />}
      {screen === "exprTestSetup" && <ExpressionsTestSetup categories={exprCategories} onBack={() => setScreen("expressions")} onStart={startExpressionTest} mc={testMc} onMc={setTestMc} />}
      {screen === "exprTest" && <ExpressionTest items={exprTestItems} inputMode={testMc ? "mc" : "type"} optionsFor={it => exprOptions(it, expressions)} explain={it => { const e = expressions.find(x => x.nl === it.answer); return e && { head: `${e.nl} = ${e.en}`, body: e.note }; }} onBack={() => setScreen("exprTestSetup")} onComplete={scr => { setExprScore(scr); setScreen("exprResults"); }} />}
      {screen === "exprResults" && exprScore && <ExpressionResults score={exprScore} onRestart={() => startExpressionTest(exprTestItems.length, exprTestCats)} onRetry={wrongs => { setExprTestItems(wrongs); setExprScore(null); setScreen("exprTest"); }} onHome={() => setScreen("expressions")} />}
      {screen === "mode" && <ModeSelect title={practiceTitle} total={practicePool.length} onSelect={handleMode} onBack={() => setScreen(practiceSource)} />}
      {screen === "cards" && cards.length > 0 && cardsScreen}
      {screen === "results" && <Results known={known} unknown={unknown} onRestart={() => startDeck(practicePool, mode, chunkSize)} onHome={() => setScreen(practiceSource)} onRetry={() => startDeck(unknown, mode, unknown.length)} />}
      </div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
