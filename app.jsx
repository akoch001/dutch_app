const { useState, useEffect, useRef, useCallback } = React;

// ── Utilities ─────────────────────────────────────────────────────────────────
function normalize(str) { return (str || "").toLowerCase().trim().replace(/\s+/g, " "); }

// ── Item progress stats (per word/sentence, persisted for spaced repetition) ──
const STATS_KEY = "dutch-item-stats-v1";
function statsLoad() { try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; } catch { return {}; } }
function statsSave(stats) { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) { console.error("save failed", e); } }
function recordAttempt(id, wasRight) {
  const stats = statsLoad();
  const cur = stats[id] || { seen: 0, wrong: 0 };
  stats[id] = { seen: cur.seen + 1, wrong: cur.wrong + (wasRight ? 0 : 1), lastSeen: Date.now() };
  statsSave(stats);
}

const vocabId = (c) => `vocab:${c.nl}→${c.en}`;
const verbSentId = (it) => `verbSent:${it.verb}|${it.tense}|${it.subject}|${it.template}`;
const exprSentId = (it) => `exprSent:${it.sentence}|${it.answer}`;

// Picks `count` items at random, weighting towards items never seen before and
// items that have been answered wrong more often — so practice sessions surface
// unfamiliar / shaky material more than things you already know well.
function weightedPick(items, idFn, count) {
  const stats = statsLoad();
  const pool = items.map(item => {
    const st = stats[idFn(item)];
    const seen = st?.seen || 0;
    const wrong = st?.wrong || 0;
    const weight = seen === 0 ? 3 : 1 + (wrong / seen) * 3;
    return { item, weight };
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
  const strip = s => s.replace(/^(de|het|een) /, "").replace(/\s*\(.*?\)/g, "").replace(/\.{2,}$/, "").trim();
  const variants = [c, strip(c), c.replace(/\.{2,}$/, "").trim()];
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
        return <span key={i} style={{ color: ok ? "#0f9d91" : "#c94a3a", borderBottom: ok ? "none" : "2px solid #c94a3a" }}>{ch || (i < c.length ? "_" : "")}</span>;
      })}</div>
      <div style={{ color: "#b86d1e", fontSize: 15, marginTop: 4 }}>{correct}</div>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const s = {
  screen: { minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea 0%,#ebe5dc 50%,#e2dbd2 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", fontFamily: "system-ui,sans-serif" },
  label: { fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#b86d1e", fontWeight: 600 },
  backBtn: { background: "none", border: "none", color: "#6b6560", fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", padding: 0 },
  chapterBtn: { width: "100%", maxWidth: 340, padding: "18px 22px", marginBottom: 12, background: "rgba(255,255,255,0.75)", border: "1px solid rgba(184,109,30,0.15)", borderRadius: 16, color: "#1c1917", fontSize: 16, fontWeight: 500, cursor: "pointer", textAlign: "left", fontFamily: "'DM Sans',sans-serif" },
  allBtn: { width: "100%", maxWidth: 340, padding: "20px 24px", marginTop: 6, background: "linear-gradient(135deg,rgba(184,109,30,0.15),rgba(184,109,30,0.05))", border: "1px solid rgba(184,109,30,0.3)", borderRadius: 16, color: "#b86d1e", fontSize: 16, fontWeight: 600, cursor: "pointer", textAlign: "left", fontFamily: "'DM Sans',sans-serif" },
  wrongBtn: { padding: "14px 28px", background: "rgba(201,74,58,0.1)", border: "1px solid rgba(201,74,58,0.25)", borderRadius: 12, color: "#c94a3a", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" },
  rightBtn: { padding: "14px 28px", background: "rgba(15,157,145,0.1)", border: "1px solid rgba(15,157,145,0.25)", borderRadius: 12, color: "#0f9d91", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" },
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(28,25,23,0.55)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={onClose}>
      <div style={{ background: "#f5f0ea", borderRadius: 20, padding: 28, width: "100%", maxWidth: 420, boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1c1917", fontFamily: "'Playfair Display',serif" }}>Progress backup</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "#a09890", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {!mode && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button onClick={() => setMode("save")} style={{ padding: "14px 18px", background: "rgba(184,109,30,0.08)", border: "1px solid rgba(184,109,30,0.25)", borderRadius: 14, textAlign: "left", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
              <div style={{ fontWeight: 600, color: "#b86d1e", fontSize: 15 }}>💾 Save progress</div>
              <div style={{ color: "#6b6560", fontSize: 13, marginTop: 3 }}>Copy your data and email it to yourself</div>
            </button>
            <button onClick={() => setMode("load")} style={{ padding: "14px 18px", background: "rgba(43,108,176,0.06)", border: "1px solid rgba(43,108,176,0.2)", borderRadius: 14, textAlign: "left", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
              <div style={{ fontWeight: 600, color: "#2b6cb0", fontSize: 15 }}>📥 Load progress</div>
              <div style={{ color: "#6b6560", fontSize: 13, marginTop: 3 }}>Paste a backup to restore your data</div>
            </button>
          </div>
        )}

        {mode === "save" && (
          <div>
            <textarea readOnly value={snapshot} style={{ width: "100%", boxSizing: "border-box", height: 180, padding: "10px 12px", fontSize: 11, fontFamily: "monospace", background: "rgba(255,255,255,0.85)", border: "1px solid rgba(184,109,30,0.2)", borderRadius: 10, color: "#6b6560", resize: "none", outline: "none" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={copyToClipboard} style={{ flex: 1, padding: "12px", borderRadius: 12, background: copied ? "rgba(15,157,145,0.12)" : "rgba(184,109,30,0.1)", border: `1px solid ${copied ? "rgba(15,157,145,0.3)" : "rgba(184,109,30,0.25)"}`, color: copied ? "#0f9d91" : "#b86d1e", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{copied ? "✓ Copied!" : "Copy"}</button>
              <button onClick={openMailto} style={{ flex: 1, padding: "12px", borderRadius: 12, background: "rgba(43,108,176,0.08)", border: "1px solid rgba(43,108,176,0.2)", color: "#2b6cb0", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Email me →</button>
            </div>
            <p style={{ fontSize: 12, color: "#a09890", marginTop: 10, textAlign: "center" }}>Copy first, then hit "Email me" and paste into the email body.</p>
            <button onClick={() => setMode(null)} style={{ ...s.backBtn, marginTop: 8, display: "block" }}>← Back</button>
          </div>
        )}

        {mode === "load" && (
          <div>
            {done
              ? <div style={{ textAlign: "center", color: "#0f9d91", fontSize: 15, fontWeight: 600, padding: "20px 0" }}>✓ Restored! Reloading…</div>
              : <>
                  <p style={{ fontSize: 14, color: "#6b6560", marginBottom: 12 }}>Paste your backup JSON below, then tap Restore.</p>
                  <textarea value={paste} onChange={e => setPaste(e.target.value)} placeholder='{"dutch-week-tracker-v3": {...}}' style={{ width: "100%", boxSizing: "border-box", height: 180, padding: "10px 12px", fontSize: 11, fontFamily: "monospace", background: "rgba(255,255,255,0.85)", border: "1px solid rgba(43,108,176,0.2)", borderRadius: 10, color: "#1c1917", resize: "none", outline: "none" }} />
                  <button onClick={restore} disabled={!paste.trim()} style={{ width: "100%", marginTop: 12, padding: "13px", borderRadius: 12, background: paste.trim() ? "rgba(43,108,176,0.12)" : "rgba(0,0,0,0.04)", border: `1px solid ${paste.trim() ? "rgba(43,108,176,0.3)" : "rgba(0,0,0,0.08)"}`, color: paste.trim() ? "#2b6cb0" : "#a09890", fontWeight: 600, fontSize: 15, cursor: paste.trim() ? "pointer" : "default", fontFamily: "'DM Sans',sans-serif" }}>Restore</button>
                  <button onClick={() => setMode(null)} style={{ ...s.backBtn, marginTop: 12, display: "block" }}>← Back</button>
                </>
            }
          </div>
        )}
      </div>
    </div>
  );
}

// ── Home ──────────────────────────────────────────────────────────────────────
function Home({ allVocab, allVerbs, allExpressions, nuances, onVocab, onVerbs, onExpressions, onNuances, onTracker }) {
  const [showProgress, setShowProgress] = useState(false);
  return (
    <div style={s.screen}>
      {showProgress && <ProgressModal onClose={() => setShowProgress(false)} />}
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <div style={s.label}>Nederlands</div>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "#1c1917", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Practicing Dutch</h1>
      </div>
      <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 12 }}>
        <button onClick={onVocab} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(43,108,176,0.1),rgba(43,108,176,0.04))", border: "1px solid rgba(43,108,176,0.2)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>📖</span>
          <div>
            <div style={{ color: "#2b6cb0", fontWeight: 600, fontSize: 16 }}>Woordenlijst</div>
            <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>{allVocab.length} woorden · browse & oefenen</div>
          </div>
        </button>
        <button onClick={onVerbs} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(107,70,193,0.1),rgba(107,70,193,0.04))", border: "1px solid rgba(107,70,193,0.25)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>⚡</span>
          <div>
            <div style={{ color: "#6b46c1", fontWeight: 600, fontSize: 16 }}>Werkwoorden</div>
            <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>{allVerbs.length} verbs · presens, imperf., perf.</div>
          </div>
        </button>
        <button onClick={onExpressions} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(42,122,101,0.1),rgba(42,122,101,0.04))", border: "1px solid rgba(42,122,101,0.2)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>💬</span>
          <div>
            <div style={{ color: "#2a7a65", fontWeight: 600, fontSize: 16 }}>Uitdrukkingen</div>
            <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>{allExpressions.length} expressions · browse & practice</div>
          </div>
        </button>
        <button onClick={onNuances} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(146,96,10,0.1),rgba(146,96,10,0.04))", border: "1px solid rgba(146,96,10,0.2)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>🔍</span>
          <div>
            <div style={{ color: "#92600a", fontWeight: 600, fontSize: 16 }}>Nuances</div>
            <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>{nuances.length} topics · confusables & grammar notes</div>
          </div>
        </button>
        <button onClick={onTracker} style={{ padding: "16px 20px", background: "linear-gradient(135deg,rgba(224,112,26,0.1),rgba(224,112,26,0.04))", border: "1px solid rgba(224,112,26,0.2)", borderRadius: 16, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
          <span style={{ fontSize: 24 }}>📅</span>
          <div>
            <div style={{ color: "#e0701a", fontWeight: 600, fontSize: 16 }}>Deze week</div>
            <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>Mon–Sun study tracker · tick & persist</div>
          </div>
        </button>
        <button onClick={() => setShowProgress(true)} style={{ padding: "11px 18px", background: "transparent", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
          <span style={{ fontSize: 15 }}>💾</span>
          <span style={{ color: "#6b6560", fontSize: 13 }}>Save / load progress</span>
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
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea 0%,#ebe5dc 50%,#e2dbd2 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 24px 100px", position: "relative" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Menu</button>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ ...s.label, color: "#2b6cb0" }}>Woordenlijst</div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: "#1c1917", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Vocabulary</h2>
      </div>
      <button onClick={onGlossary} style={{ ...s.chapterBtn, borderColor: "rgba(43,108,176,0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>📖</span>
        <div>
          <div style={{ color: "#1c1917", fontWeight: 600, fontSize: 17 }}>Bestuderen</div>
          <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>{allVocab.length} woorden · search & browse</div>
        </div>
      </button>
      <div style={{ width: "100%", maxWidth: 340, height: 1, background: "rgba(0,0,0,0.05)", margin: "20px 0 16px" }} />
      <div style={{ width: "100%", maxWidth: 340, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#6b6560", fontWeight: 600 }}>Oefenen</div>
        <button onClick={selectAll} style={{ background: "none", border: "none", color: "#b86d1e", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>{allSelected ? "Deselecteer alles" : "Selecteer alles"}</button>
      </div>
      {chapters.map((ch, i) => {
        const active = selected.has(ch);
        return (
          <button key={ch} onClick={() => toggle(ch)} style={{ ...s.chapterBtn, borderColor: active ? "rgba(184,109,30,0.4)" : "rgba(184,109,30,0.15)", background: active ? "rgba(184,109,30,0.08)" : "rgba(255,255,255,0.75)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11, color: "#b86d1e", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>Hoofdstuk {i + 1}</div>
              <div style={{ color: "#1c1917" }}>{ch.split("–")[1]?.trim()}</div>
              <div style={{ fontSize: 13, color: "#6b6560", marginTop: 4 }}>{vocab[ch].length} woorden</div>
            </div>
            <div style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${active ? "#b86d1e" : "rgba(0,0,0,0.15)"}`, background: active ? "#b86d1e" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {active && <span style={{ color: "#f5f0ea", fontSize: 13, fontWeight: 700 }}>✓</span>}
            </div>
          </button>
        );
      })}
      {selected.size > 0 && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 24px", background: "linear-gradient(0deg,#f5f0ea 60%,transparent)", display: "flex", justifyContent: "center" }}>
          <button onClick={() => onPractice(combinedDeck, selected.size === chapters.length ? "Alle woorden" : `${selected.size} hoofdstuk${selected.size > 1 ? "ken" : ""}`)} style={{ width: "100%", maxWidth: 340, padding: "16px", borderRadius: 14, background: "linear-gradient(135deg,rgba(184,109,30,0.25),rgba(184,109,30,0.1))", border: "1px solid rgba(184,109,30,0.4)", color: "#b86d1e", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            Start oefenen · {combinedCount} woorden →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Glossary ──────────────────────────────────────────────────────────────────
function Glossary({ onBack, vocab, allVocab, chapters }) {
  const [search, setSearch] = useState("");
  const [activeChapter, setActiveChapter] = useState("all");
  const [sortDir, setSortDir] = useState("asc");
  const src = activeChapter === "all" ? allVocab : (vocab[activeChapter] || []);
  const q = normalize(search);
  const sorted = [...src.filter(w => !q || normalize(w.nl).includes(q) || normalize(w.en).includes(q))]
    .sort((a, b) => normalize(a.nl).localeCompare(normalize(b.nl)) * (sortDir === "asc" ? 1 : -1));
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea 0%,#ebe5dc 50%,#e2dbd2 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,#f5f0ea,#ebe5dc)", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Menu</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={s.label}>Woordenlijst</div></div>
          <button onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")} style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(184,109,30,0.15)", borderRadius: 8, color: "#b86d1e", fontSize: 12, padding: "6px 10px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>A–Z {sortDir === "asc" ? "↑" : "↓"}</button>
        </div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 10, scrollbarWidth: "none" }}>
          {["all", ...chapters].map((ch, i) => {
            const active = activeChapter === ch;
            return <button key={ch} onClick={() => setActiveChapter(ch)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(184,109,30,0.15)" : "rgba(255,255,255,0.75)", border: active ? "1px solid rgba(184,109,30,0.4)" : "1px solid rgba(0,0,0,0.06)", color: active ? "#b86d1e" : "#6b6560" }}>{ch === "all" ? "Alles" : `H${i}`}</button>;
          })}
        </div>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#a09890", fontSize: 15 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken..." style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px 12px 38px", background: "rgba(255,255,255,0.85)", border: "1px solid rgba(184,109,30,0.15)", borderRadius: 12, color: "#1c1917", fontSize: 15, outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "#b86d1e" }} />
        </div>
        <div style={{ fontSize: 12, color: "#a09890", paddingBottom: 8 }}>{sorted.length} woorden</div>
      </div>
      <div style={{ flex: 1, padding: "0 20px 32px" }}>
        {sorted.map((w, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "13px 0", borderBottom: "1px solid rgba(255,255,255,0.85)", gap: 12 }}>
            <span style={{ color: "#1c1917", fontSize: 15, fontWeight: 500, flex: "0 0 auto", maxWidth: "50%" }}>{w.nl}</span>
            <span style={{ color: "#6b6560", fontSize: 14, textAlign: "right", flex: 1 }}>{w.en}</span>
          </div>
        ))}
        {sorted.length === 0 && <div style={{ textAlign: "center", color: "#a09890", marginTop: 60, fontSize: 15 }}>Geen resultaten</div>}
      </div>
    </div>
  );
}

// ── Verbs home ────────────────────────────────────────────────────────────────
function VerbsHome({ onBack, onStudy, onTest, allVerbs }) {
  return (
    <div style={{ ...s.screen, position: "relative" }}>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Menu</button>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ ...s.label, color: "#6b46c1" }}>Werkwoorden</div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: "#1c1917", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Verbs</h2>
        <div style={{ color: "#6b6560", fontSize: 13, marginTop: 6 }}>Presens · Imperfectum · Perfectum</div>
      </div>
      <button onClick={onStudy} style={{ ...s.chapterBtn, borderColor: "rgba(107,70,193,0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>📚</span>
        <div>
          <div style={{ color: "#1c1917", fontWeight: 600, fontSize: 17 }}>Bestuderen</div>
          <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>{allVerbs.length} verbs · conjugation table</div>
        </div>
      </button>
      <button onClick={onTest} style={{ ...s.chapterBtn, borderColor: "rgba(107,70,193,0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>🎯</span>
        <div>
          <div style={{ color: "#1c1917", fontWeight: 600, fontSize: 17 }}>Testen</div>
          <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>Fill the gap · with or without context</div>
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
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea,#ebe5dc 50%,#e2dbd2)", fontFamily: "system-ui,sans-serif" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,#f5f0ea,#ebe5dc)", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Verbs</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={{ ...s.label, color: "#6b46c1" }}>Bestuderen</div></div>
          <div style={{ width: 60 }} />
        </div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 10, scrollbarWidth: "none" }}>
          {verbGroupNames.map(g => {
            const active = g === activeGroup;
            return <button key={g} onClick={() => setActiveGroup(g)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(107,70,193,0.18)" : "rgba(255,255,255,0.75)", border: active ? "1px solid rgba(107,70,193,0.45)" : "1px solid rgba(0,0,0,0.06)", color: active ? "#6b46c1" : "#6b6560" }}>{g}</button>;
          })}
        </div>
        <div style={{ position: "relative", marginBottom: 12 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#a09890", fontSize: 15 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken..." style={{ width: "100%", boxSizing: "border-box", padding: "11px 14px 11px 38px", background: "rgba(255,255,255,0.85)", border: "1px solid rgba(107,70,193,0.18)", borderRadius: 12, color: "#1c1917", fontSize: 14, outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "#6b46c1" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 0.9fr 1.2fr", gap: 6, padding: "10px 4px", borderBottom: "1px solid rgba(107,70,193,0.15)", fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: "#6b46c1", fontWeight: 600 }}>
          <span>Infinitief / EN</span><span>Presens</span><span>Imperf.</span><span>Perfectum</span>
        </div>
      </div>
      <div style={{ padding: "0 20px 40px" }}>
        {filtered.map((v, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 0.9fr 1.2fr", gap: 6, padding: "12px 4px", borderBottom: "1px solid rgba(255,255,255,0.75)", fontSize: 12, alignItems: "start", lineHeight: 1.4 }}>
            <span><div style={{ color: "#1c1917", fontWeight: 600, fontSize: 13 }}>{v.inf}</div><div style={{ color: "#6b6560", fontSize: 10, marginTop: 2 }}>{v.en}</div></span>
            <span style={{ color: "#2b6cb0" }}><div>{v.presIk || "—"}</div><div style={{ fontSize: 10, color: "#9a9490" }}>{v.presJijHij || ""}</div><div style={{ fontSize: 10, color: "#9a9490" }}>{v.presWij || ""}</div></span>
            <span style={{ color: "#6b6560" }}><div>{v.impSg}</div><div style={{ fontSize: 10, color: "#9a9490" }}>{v.impPl}</div></span>
            <span style={{ color: "#b86d1e" }}><div style={{ fontSize: 9, color: "#6b6560", textTransform: "uppercase", letterSpacing: 1 }}>{v.aux}</div><div>{v.vd}</div></span>
          </div>
        ))}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "#a09890", marginTop: 60, fontSize: 15 }}>Geen resultaten</div>}
      </div>
    </div>
  );
}

// ── Verb test setup ───────────────────────────────────────────────────────────
function VerbTestSetup({ onBack, onStart, verbGroupNames }) {
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
        <div style={{ ...s.label, color: "#6b46c1" }}>Testen</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Choose your challenge</h2>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#6b6560", fontWeight: 600, marginBottom: 10 }}>Tijden</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[{ k: "presens", label: "Presens" }, { k: "imperfectum", label: "Imperf." }, { k: "perfectum", label: "Perfectum" }].map(t => (
            <button key={t.k} onClick={() => toggleTense(t.k)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: tenses[t.k] ? "rgba(107,70,193,0.15)" : "rgba(255,255,255,0.75)", border: tenses[t.k] ? "1px solid rgba(107,70,193,0.5)" : "1px solid rgba(0,0,0,0.07)", color: tenses[t.k] ? "#6b46c1" : "#6b6560" }}>{t.label}</button>
          ))}
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#6b6560", fontWeight: 600, marginBottom: 10 }}>Hoofdstukken</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {verbGroupNames.map(g => {
            const label = g.split(/\s/)[0];
            const active = selectedGroups.has(g);
            return <button key={g} onClick={() => toggleGroup(g)} style={{ padding: "8px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(107,70,193,0.15)" : "rgba(255,255,255,0.75)", border: active ? "1px solid rgba(107,70,193,0.5)" : "1px solid rgba(0,0,0,0.07)", color: active ? "#6b46c1" : "#6b6560" }} title={g}>{label}</button>;
          })}
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#6b6560", fontWeight: 600, marginBottom: 10 }}>Modus</div>
        {[{ id: "context", icon: "📝", name: "Met context", desc: "Read the sentence, fill in the verb" }, { id: "nocontext", icon: "⚡", name: "Zonder context", desc: "Just verb + tense → type the form" }].map(m => (
          <button key={m.id} onClick={() => setMode(m.id)} style={{ width: "100%", marginBottom: 8, padding: "14px 16px", borderRadius: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textAlign: "left", background: mode === m.id ? "rgba(107,70,193,0.15)" : "rgba(255,255,255,0.75)", border: mode === m.id ? "1px solid rgba(107,70,193,0.5)" : "1px solid rgba(0,0,0,0.07)", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 20 }}>{m.icon}</span>
            <div>
              <div style={{ color: mode === m.id ? "#6b46c1" : "#1c1917", fontWeight: 600, fontSize: 14 }}>{m.name}</div>
              <div style={{ color: "#6b6560", fontSize: 11, marginTop: 2 }}>{m.desc}</div>
            </div>
          </button>
        ))}
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 24 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#6b6560", fontWeight: 600, marginBottom: 10 }}>Aantal vragen</div>
        <div style={{ display: "flex", gap: 8 }}>
          {[10, 15, 25].map(n => (
            <button key={n} onClick={() => setCount(n)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: count === n ? "rgba(107,70,193,0.15)" : "rgba(255,255,255,0.75)", border: count === n ? "1px solid rgba(107,70,193,0.5)" : "1px solid rgba(0,0,0,0.07)", color: count === n ? "#6b46c1" : "#6b6560" }}>{n}</button>
          ))}
        </div>
      </div>
      <button onClick={() => onStart(mode, count, Object.keys(tenses).filter(t => tenses[t]), [...selectedGroups])} style={{ width: "100%", maxWidth: 340, padding: "16px", borderRadius: 14, background: "linear-gradient(135deg,rgba(107,70,193,0.25),rgba(107,70,193,0.1))", border: "1px solid rgba(107,70,193,0.4)", color: "#6b46c1", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Start →</button>
    </div>
  );
}

// ── Verb test ─────────────────────────────────────────────────────────────────
function VerbTest({ items, mode, onComplete, onBack }) {
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(null);
  const [score, setScore] = useState({ right: 0, wrong: 0, wrongs: [] });
  const inputRef = useRef(null);
  const current = items[index];
  useEffect(() => { setInput(""); setStatus(null); setTimeout(() => inputRef.current?.focus(), 80); }, [index]);
  if (!current) return null;
  const submit = () => { if (!input.trim()) return; setStatus(checkAnswer(input, current.answer)); };
  const advance = () => {
    const wasRight = status === "exact" || status === "close";
    recordAttempt(verbSentId(current), wasRight);
    const newScore = { right: score.right + (wasRight ? 1 : 0), wrong: score.wrong + (wasRight ? 0 : 1), wrongs: wasRight ? score.wrongs : [...score.wrongs, current] };
    setScore(newScore);
    if (index >= items.length - 1) onComplete(newScore);
    else setIndex(i => i + 1);
  };
  const handleKey = e => { if (e.key === "Enter") { if (status) advance(); else submit(); } };
  const pct = (index / items.length) * 100;
  const parts = current.template.split("{}");
  let display;
  if (mode === "context") {
    display = (
      <>
        <div style={s.label}>Vul in</div>
        <div style={{ fontSize: 18, color: "#1c1917", lineHeight: 1.6, marginTop: 12, fontFamily: "'Playfair Display',serif" }}>
          {parts.map((p, i) => (
            <span key={i}>{p}{i < parts.length - 1 && <span style={{ color: "#6b46c1", fontWeight: 700, borderBottom: "2px dashed #6b46c1", padding: "0 12px" }}>____</span>}</span>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "#6b6560", marginTop: 14, fontStyle: "italic" }}>{current.hint}</div>
        <div style={{ fontSize: 11, color: "#6b46c1", marginTop: 10, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>{current.verb} · {current.tense}{current.split ? " · split form" : ""}</div>
      </>
    );
  } else {
    display = (
      <>
        <div style={s.label}>Verb · tense</div>
        <div style={{ fontSize: 30, fontWeight: 700, color: "#1c1917", marginTop: 12, fontFamily: "'Playfair Display',serif" }}>{current.verb}</div>
        <div style={{ fontSize: 14, color: "#6b46c1", marginTop: 8, fontWeight: 600 }}>{current.subject} · {current.tense === "perfectum" ? "perfectum (aux + vd)" : current.tense}</div>
        <div style={{ fontSize: 12, color: "#6b6560", marginTop: 14, fontStyle: "italic" }}>{current.hint}</div>
      </>
    );
  }
  const sc = status === "exact" ? "#0f9d91" : status === "close" ? "#b86d1e" : "#c94a3a";
  const sm = status === "exact" ? "Precies goed! 🎉" : status === "close" ? "Bijna goed!" : "Niet helemaal...";
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea,#ebe5dc 50%,#e2dbd2)", fontFamily: "system-ui,sans-serif", position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px 40px" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(255,255,255,0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#6b46c1,#8c6dff)", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 18, left: 18 }}>← Test menu</button>
      <div style={{ position: "absolute", top: 18, right: 18, fontSize: 12, color: "#6b6560" }}>{index + 1} / {items.length} · <span style={{ color: "#0f9d91" }}>✓ {score.right}</span> <span style={{ color: "#c94a3a" }}>✗ {score.wrong}</span></div>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ background: "rgba(255,255,255,0.75)", border: "1px solid rgba(107,70,193,0.18)", borderRadius: 20, padding: "28px 24px", textAlign: "center", marginBottom: 18 }}>{display}</div>
        {!status && (
          <div style={{ position: "relative" }}>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder={current.split ? "type both parts" : "type the verb form..."} style={{ width: "100%", boxSizing: "border-box", padding: "16px 60px 16px 18px", fontSize: 17, background: "rgba(255,255,255,0.85)", border: "1px solid rgba(107,70,193,0.25)", borderRadius: 14, color: "#1c1917", outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "#6b46c1" }} />
            <button onClick={submit} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "rgba(107,70,193,0.18)", border: "1px solid rgba(107,70,193,0.35)", borderRadius: 8, color: "#6b46c1", padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>↵</button>
          </div>
        )}
        {!status && <button onClick={() => setStatus("wrong")} style={{ marginTop: 12, width: "100%", background: "none", border: "1px solid rgba(0,0,0,0.05)", borderRadius: 12, color: "#a09890", fontSize: 13, padding: "10px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Toon antwoord</button>}
        {status && (
          <>
            <div style={{ background: `rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.08)`, border: `1px solid rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.25)`, borderRadius: 16, padding: "20px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: sc, marginBottom: 14, letterSpacing: 1 }}>{sm}</div>
              <DiffDisplay typed={input} correct={current.answer} />
            </div>
            <button onClick={advance} style={{ marginTop: 14, width: "100%", background: "linear-gradient(135deg,rgba(107,70,193,0.2),rgba(107,70,193,0.08))", border: "1px solid rgba(107,70,193,0.35)", borderRadius: 14, color: "#6b46c1", fontSize: 16, fontWeight: 600, padding: "15px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{index >= items.length - 1 ? "Klaar →" : "Volgende →"}</button>
          </>
        )}
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
      <div style={{ fontSize: 64, fontWeight: 700, fontFamily: "'Playfair Display',serif", color: pct >= 80 ? "#0f9d91" : pct >= 50 ? "#b86d1e" : "#c94a3a", marginBottom: 8 }}>{pct}%</div>
      <div style={{ color: "#6b6560", fontSize: 15, marginBottom: 8 }}>{score.right} goed · {score.wrong} fout</div>
      <div style={{ color: "#1c1917", fontSize: 20, fontWeight: 600, marginBottom: 32, fontFamily: "'Playfair Display',serif" }}>{pct >= 90 ? "Uitstekend!" : pct >= 70 ? "Goed bezig!" : pct >= 50 ? "Ga zo door!" : "Blijf oefenen!"}</div>
      {score.wrongs.length > 0 && (
        <div style={{ width: "100%", maxWidth: 360, marginBottom: 22, background: "rgba(255,255,255,0.65)", border: "1px solid rgba(201,74,58,0.15)", borderRadius: 16, padding: "16px 20px", maxHeight: 240, overflowY: "auto" }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#c94a3a", marginBottom: 10, fontWeight: 600 }}>Nog te leren</div>
          {score.wrongs.map((w, i) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: i < score.wrongs.length - 1 ? "1px solid rgba(255,255,255,0.75)" : "none", fontSize: 13 }}>
              <div style={{ color: "#1c1917" }}>{w.verb} → <span style={{ color: "#b86d1e" }}>{w.answer}</span></div>
              <div style={{ color: "#6b6560", fontSize: 11, marginTop: 2 }}>{w.hint}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 340 }}>
        {score.wrongs.length > 0 && <button onClick={() => onRetry(score.wrongs)} style={{ ...s.wrongBtn, width: "100%" }}>Oefen fouten opnieuw</button>}
        <button onClick={onRestart} style={s.chapterBtn}>Opnieuw</button>
        <button onClick={onHome} style={{ ...s.chapterBtn, color: "#6b6560", border: "1px solid rgba(0,0,0,0.07)" }}>← Terug naar menu</button>
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
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>{title}</h2>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#6b6560", fontWeight: 600, marginBottom: 12 }}>Aantal per sessie</div>
        <div style={{ display: "flex", gap: 8 }}>
          {chunkOptions.map(n => (
            <button key={n} onClick={() => setChunk(n)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: chunk === n ? "rgba(184,109,30,0.15)" : "rgba(255,255,255,0.75)", border: chunk === n ? "1px solid rgba(184,109,30,0.5)" : "1px solid rgba(0,0,0,0.07)", color: chunk === n ? "#b86d1e" : "#6b6560" }}>{n}</button>
          ))}
          <button onClick={() => setChunk(total)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: chunk === total ? "rgba(184,109,30,0.15)" : "rgba(255,255,255,0.75)", border: chunk === total ? "1px solid rgba(184,109,30,0.5)" : "1px solid rgba(0,0,0,0.07)", color: chunk === total ? "#b86d1e" : "#6b6560" }}>Alles<br /><span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>{total}</span></button>
        </div>
      </div>
      {[{ id: "flip", icon: "🃏", name: "Flashcards", desc: "Tap to flip · swipe to navigate" }, { id: "type", icon: "⌨️", name: "Typen", desc: "See English, type the Dutch" }].map(m => (
        <button key={m.id} onClick={() => onSelect(m.id, chunk)} style={{ ...s.chapterBtn, display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 28 }}>{m.icon}</span>
          <div>
            <div style={{ color: "#1c1917", fontWeight: 600, fontSize: 17 }}>{m.name}</div>
            <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>{m.desc} · <span style={{ color: "#b86d1e" }}>{chunk === total ? "alle" : chunk} woorden</span></div>
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
  const pct = total > 0 ? ((known + unknown) / total) * 100 : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: "20px", position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(255,255,255,0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#b86d1e,#c94a3a)", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <div style={{ position: "absolute", bottom: 24, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 20, fontSize: 13, color: "#6b6560" }}>
        <span>{index + 1} / {total}</span>
        {(known > 0 || unknown > 0) && <><span style={{ color: "#0f9d91" }}>✓ {known}</span><span style={{ color: "#c94a3a" }}>✗ {unknown}</span></>}
      </div>
      <div onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE} onClick={() => { if (!('ontouchstart' in window)) onFlip(); }} style={{ width: "100%", maxWidth: 360, minHeight: 240, cursor: "pointer", transform: `translateX(${swipeX}px)`, transition: swipeX === 0 ? "transform 0.3s" : "none", userSelect: "none" }}>
        <div style={{ width: "100%", minHeight: 240, background: flipped ? "linear-gradient(145deg,rgba(184,109,30,0.08),rgba(184,109,30,0.02))" : "rgba(255,255,255,0.75)", border: `1px solid ${flipped ? "rgba(184,109,30,0.2)" : "rgba(184,109,30,0.12)"}`, borderRadius: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 28px", boxSizing: "border-box", transition: "background 0.3s, border-color 0.3s" }}>
          {!flipped
            ? <><div style={s.label}>Nederlands</div><div style={{ fontSize: card.nl.length > 25 ? 22 : 28, fontWeight: 600, color: "#1c1917", textAlign: "center", lineHeight: 1.4, fontFamily: "'Playfair Display',serif", marginTop: 12 }}>{card.nl}</div><div style={{ fontSize: 12, color: "#a09890", marginTop: 24 }}>tap to reveal</div></>
            : <><div style={s.label}>Nederlands</div><div style={{ fontSize: 18, color: "#6b6560", textAlign: "center", marginBottom: 16 }}>{card.nl}</div><div style={{ width: 40, height: 1, background: "rgba(184,109,30,0.3)", marginBottom: 16 }} /><div style={{ ...s.label, color: "#b86d1e" }}>English</div><div style={{ fontSize: card.en.length > 30 ? 20 : 24, fontWeight: 600, color: "#1c1917", textAlign: "center", lineHeight: 1.4, fontFamily: "'Playfair Display',serif", marginTop: 10 }}>{card.en}</div></>
          }
        </div>
      </div>
      {flipped
        ? <div style={{ display: "flex", gap: 16, marginTop: 32 }}><button onClick={e => { e.stopPropagation(); onNext("unknown"); }} style={s.wrongBtn}>Nog niet</button><button onClick={e => { e.stopPropagation(); onNext("known"); }} style={s.rightBtn}>Ken ik ✓</button></div>
        : <div style={{ marginTop: 32, fontSize: 13, color: "#a09890" }}>← swipe →</div>
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
  const handleKey = e => { if (e.key === "Enter") { if (status) advance(); else submit(); } };
  const pct = total > 0 ? ((known + unknown) / total) * 100 : 0;
  const sc = status === "exact" ? "#0f9d91" : status === "close" ? "#b86d1e" : "#c94a3a";
  const sm = status === "exact" ? "Precies goed! 🎉" : status === "close" ? "Bijna! (Kleine afwijking geaccepteerd)" : "Niet helemaal...";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "20px", position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(255,255,255,0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#b86d1e,#c94a3a)", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <div style={{ position: "absolute", bottom: 24, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 20, fontSize: 13, color: "#6b6560" }}>
        <span>{index + 1} / {total}</span>
        {(known > 0 || unknown > 0) && <><span style={{ color: "#0f9d91" }}>✓ {known}</span><span style={{ color: "#c94a3a" }}>✗ {unknown}</span></>}
      </div>
      <div style={{ width: "100%", maxWidth: 380, marginTop: 40 }}>
        <div style={{ background: "rgba(255,255,255,0.75)", border: "1px solid rgba(184,109,30,0.12)", borderRadius: 20, padding: "32px 28px", textAlign: "center", marginBottom: 20 }}>
          <div style={s.label}>English</div>
          <div style={{ fontSize: card.en.length > 35 ? 20 : 24, fontWeight: 600, color: "#1c1917", lineHeight: 1.4, fontFamily: "'Playfair Display',serif", marginTop: 10 }}>{card.en}</div>
          <div style={{ fontSize: 13, color: "#6b6560", marginTop: 16 }}>Type het Nederlandse woord</div>
        </div>
        {!status && (
          <div style={{ position: "relative" }}>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder="typ hier..." style={{ width: "100%", boxSizing: "border-box", padding: "18px 60px 18px 20px", fontSize: 20, background: "rgba(255,255,255,0.85)", border: "1px solid rgba(184,109,30,0.2)", borderRadius: 14, color: "#1c1917", outline: "none", fontFamily: "system-ui,sans-serif", caretColor: "#b86d1e" }} />
            <button onClick={submit} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "rgba(184,109,30,0.15)", border: "1px solid rgba(184,109,30,0.3)", borderRadius: 8, color: "#b86d1e", padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "system-ui,sans-serif", fontWeight: 600 }}>↵</button>
          </div>
        )}
        {status && (
          <div style={{ background: `rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.08)`, border: `1px solid rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.25)`, borderRadius: 16, padding: "24px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: sc, marginBottom: 16, letterSpacing: 1 }}>{sm}</div>
            <DiffDisplay typed={input} correct={card.nl} />
          </div>
        )}
        {!status && <button onClick={() => setStatus("wrong")} style={{ marginTop: 14, width: "100%", background: "none", border: "1px solid rgba(0,0,0,0.05)", borderRadius: 12, color: "#a09890", fontSize: 14, padding: "12px", cursor: "pointer", fontFamily: "system-ui,sans-serif" }}>Toon antwoord</button>}
        {status && <button onClick={advance} style={{ marginTop: 16, width: "100%", background: "linear-gradient(135deg,rgba(184,109,30,0.2),rgba(184,109,30,0.08))", border: "1px solid rgba(184,109,30,0.3)", borderRadius: 14, color: "#b86d1e", fontSize: 16, fontWeight: 600, padding: "16px", cursor: "pointer", fontFamily: "system-ui,sans-serif" }}>Volgende →</button>}
      </div>
    </div>
  );
}

// ── Results ───────────────────────────────────────────────────────────────────
function Results({ known, unknown, onRestart, onHome, onRetry }) {
  const total = known.length + unknown.length, pct = total > 0 ? Math.round((known.length / total) * 100) : 0;
  return (
    <div style={s.screen}>
      <div style={{ fontSize: 64, fontWeight: 700, fontFamily: "'Playfair Display',serif", color: pct >= 80 ? "#0f9d91" : pct >= 50 ? "#b86d1e" : "#c94a3a", marginBottom: 8 }}>{pct}%</div>
      <div style={{ color: "#6b6560", fontSize: 15, marginBottom: 8 }}>{known.length} goed · {unknown.length} fout</div>
      <div style={{ color: "#1c1917", fontSize: 20, fontWeight: 600, marginBottom: 40, fontFamily: "'Playfair Display',serif" }}>{pct >= 90 ? "Uitstekend!" : pct >= 70 ? "Goed bezig!" : pct >= 50 ? "Ga zo door!" : "Blijf oefenen!"}</div>
      {unknown.length > 0 && (
        <div style={{ width: "100%", maxWidth: 340, marginBottom: 24, background: "rgba(255,255,255,0.65)", border: "1px solid rgba(201,74,58,0.15)", borderRadius: 16, padding: "16px 20px", maxHeight: 200, overflowY: "auto" }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#c94a3a", marginBottom: 12, fontWeight: 600 }}>Nog te leren</div>
          {unknown.map((card, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < unknown.length - 1 ? "1px solid rgba(255,255,255,0.75)" : "none", fontSize: 14 }}>
              <span style={{ color: "#1c1917" }}>{card.nl}</span>
              <span style={{ color: "#6b6560", marginLeft: 12 }}>{card.en}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 340 }}>
        {unknown.length > 0 && <button onClick={onRetry} style={{ ...s.wrongBtn, width: "100%" }}>Oefen fouten opnieuw</button>}
        <button onClick={onRestart} style={s.chapterBtn}>Opnieuw shufflen</button>
        <button onClick={onHome} style={{ ...s.chapterBtn, color: "#6b6560", border: "1px solid rgba(0,0,0,0.07)" }}>← Terug naar menu</button>
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
        <div style={{ ...s.label, color: "#2a7a65" }}>Uitdrukkingen</div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: "#1c1917", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Expressions</h2>
        <div style={{ color: "#6b6560", fontSize: 13, marginTop: 6 }}>Begrip · Bevestigen · Eens zijn · Nuance · meer</div>
      </div>
      <button onClick={onBrowse} style={{ ...s.chapterBtn, borderColor: "rgba(42,122,101,0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>📚</span>
        <div>
          <div style={{ color: "#1c1917", fontWeight: 600, fontSize: 17 }}>Bestuderen</div>
          <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>{allExpressions.length} expressions · browse by category</div>
        </div>
      </button>
      <button onClick={onTest} style={{ ...s.chapterBtn, borderColor: "rgba(42,122,101,0.25)", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 26 }}>🎯</span>
        <div>
          <div style={{ color: "#1c1917", fontWeight: 600, fontSize: 17 }}>Oefenen</div>
          <div style={{ color: "#6b6560", fontSize: 13, marginTop: 2 }}>Fill in the blank · conversation context</div>
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
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea 0%,#ebe5dc 50%,#e2dbd2 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,#f5f0ea,#ebe5dc)", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Uitdrukkingen</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={{ ...s.label, color: "#2a7a65" }}>Bestuderen</div></div>
          <div style={{ width: 60 }} />
        </div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 10, scrollbarWidth: "none" }}>
          {["all", ...categories].map(cat => {
            const active = activeCategory === cat;
            return <button key={cat} onClick={() => setActiveCategory(cat)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: active ? "rgba(42,122,101,0.15)" : "rgba(255,255,255,0.75)", border: active ? "1px solid rgba(42,122,101,0.4)" : "1px solid rgba(0,0,0,0.06)", color: active ? "#2a7a65" : "#6b6560" }}>{cat === "all" ? "Alles" : cat}</button>;
          })}
        </div>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#a09890", fontSize: 15 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken..." style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px 12px 38px", background: "rgba(255,255,255,0.85)", border: "1px solid rgba(42,122,101,0.15)", borderRadius: 12, color: "#1c1917", fontSize: 15, outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "#2a7a65" }} />
        </div>
        <div style={{ fontSize: 12, color: "#a09890", paddingBottom: 8 }}>{filtered.length} uitdrukkingen</div>
      </div>
      <div style={{ flex: 1, padding: "0 20px 32px" }}>
        {filtered.map((e, i) => (
          <div key={i} style={{ padding: "14px 0", borderBottom: "1px solid rgba(255,255,255,0.85)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <span style={{ color: "#1c1917", fontSize: 15, fontWeight: 500 }}>{e.nl}</span>
              <span style={{ color: "#6b6560", fontSize: 14, textAlign: "right", flex: 1 }}>{e.en}</span>
            </div>
            {e.note && <div style={{ color: "#a09890", fontSize: 12, marginTop: 4, fontStyle: "italic" }}>{e.note}</div>}
          </div>
        ))}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "#a09890", marginTop: 60, fontSize: 15 }}>Geen resultaten</div>}
      </div>
    </div>
  );
}

// ── Expressions test setup ─────────────────────────────────────────────────────
function ExpressionsTestSetup({ onBack, onStart, categories }) {
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
        <div style={{ ...s.label, color: "#2a7a65" }}>Oefenen</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", fontFamily: "'Playfair Display',serif", marginTop: 8 }}>Choose your challenge</h2>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#6b6560", fontWeight: 600, marginBottom: 10 }}>Categorieën</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {categories.map(cat => (
            <button key={cat} onClick={() => toggleCat(cat)} style={{ padding: "8px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: selectedCats.has(cat) ? "rgba(42,122,101,0.15)" : "rgba(255,255,255,0.75)", border: selectedCats.has(cat) ? "1px solid rgba(42,122,101,0.5)" : "1px solid rgba(0,0,0,0.07)", color: selectedCats.has(cat) ? "#2a7a65" : "#6b6560" }}>{cat}</button>
          ))}
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: 340, marginBottom: 24 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: "#6b6560", fontWeight: 600, marginBottom: 10 }}>Aantal vragen</div>
        <div style={{ display: "flex", gap: 8 }}>
          {[10, 15, 25].map(n => (
            <button key={n} onClick={() => setCount(n)} style={{ flex: 1, padding: "10px 0", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", background: count === n ? "rgba(42,122,101,0.15)" : "rgba(255,255,255,0.75)", border: count === n ? "1px solid rgba(42,122,101,0.5)" : "1px solid rgba(0,0,0,0.07)", color: count === n ? "#2a7a65" : "#6b6560" }}>{n}</button>
          ))}
        </div>
      </div>
      <button onClick={() => onStart(count, [...selectedCats])} style={{ width: "100%", maxWidth: 340, padding: "16px", borderRadius: 14, background: "linear-gradient(135deg,rgba(42,122,101,0.25),rgba(42,122,101,0.1))", border: "1px solid rgba(42,122,101,0.4)", color: "#2a7a65", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Start →</button>
    </div>
  );
}

// ── Expression test ────────────────────────────────────────────────────────────
function ExpressionTest({ items, onComplete, onBack }) {
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(null);
  const [score, setScore] = useState({ right: 0, wrong: 0, wrongs: [] });
  const inputRef = useRef(null);
  const current = items[index];
  useEffect(() => { setInput(""); setStatus(null); setTimeout(() => inputRef.current?.focus(), 80); }, [index]);
  if (!current) return null;
  const submit = () => { if (!input.trim()) return; setStatus(checkAnswer(input, current.answer)); };
  const advance = () => {
    const wasRight = status === "exact" || status === "close";
    recordAttempt(exprSentId(current), wasRight);
    const newScore = { right: score.right + (wasRight ? 1 : 0), wrong: score.wrong + (wasRight ? 0 : 1), wrongs: wasRight ? score.wrongs : [...score.wrongs, current] };
    setScore(newScore);
    if (index >= items.length - 1) onComplete(newScore);
    else setIndex(i => i + 1);
  };
  const handleKey = e => { if (e.key === "Enter") { if (status) advance(); else submit(); } };
  const pct = (index / items.length) * 100;
  const parts = current.sentence.split("___");
  const sc = status === "exact" ? "#0f9d91" : status === "close" ? "#b86d1e" : "#c94a3a";
  const sm = status === "exact" ? "Precies goed! 🎉" : status === "close" ? "Bijna goed!" : "Niet helemaal...";
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea,#ebe5dc 50%,#e2dbd2)", fontFamily: "system-ui,sans-serif", position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px 40px" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "rgba(255,255,255,0.85)" }}><div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#2a7a65,#0f9d91)", transition: "width 0.4s", borderRadius: "0 2px 2px 0" }} /></div>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 18, left: 18 }}>← Test menu</button>
      <div style={{ position: "absolute", top: 18, right: 18, fontSize: 12, color: "#6b6560" }}>{index + 1} / {items.length} · <span style={{ color: "#0f9d91" }}>✓ {score.right}</span> <span style={{ color: "#c94a3a" }}>✗ {score.wrong}</span></div>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ background: "rgba(255,255,255,0.75)", border: "1px solid rgba(42,122,101,0.18)", borderRadius: 20, padding: "28px 24px", textAlign: "center", marginBottom: 18 }}>
          <div style={s.label}>Vul in</div>
          <div style={{ fontSize: 18, color: "#1c1917", lineHeight: 1.7, marginTop: 12, fontFamily: "'Playfair Display',serif" }}>
            {parts.map((p, i) => (
              <span key={i}>{p}{i < parts.length - 1 && <span style={{ color: "#2a7a65", fontWeight: 700, borderBottom: "2px dashed #2a7a65", padding: "0 12px" }}>____</span>}</span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "#6b6560", marginTop: 14, fontStyle: "italic" }}>{current.hint}</div>
        </div>
        {!status && (
          <div style={{ position: "relative" }}>
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder="type the expression..." style={{ width: "100%", boxSizing: "border-box", padding: "16px 60px 16px 18px", fontSize: 17, background: "rgba(255,255,255,0.85)", border: "1px solid rgba(42,122,101,0.25)", borderRadius: 14, color: "#1c1917", outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "#2a7a65" }} />
            <button onClick={submit} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "rgba(42,122,101,0.18)", border: "1px solid rgba(42,122,101,0.35)", borderRadius: 8, color: "#2a7a65", padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>↵</button>
          </div>
        )}
        {!status && <button onClick={() => setStatus("wrong")} style={{ marginTop: 12, width: "100%", background: "none", border: "1px solid rgba(0,0,0,0.05)", borderRadius: 12, color: "#a09890", fontSize: 13, padding: "10px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Toon antwoord</button>}
        {status && (
          <>
            <div style={{ background: `rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.08)`, border: `1px solid rgba(${status === "exact" ? "78,205,196" : status === "close" ? "244,162,97" : "231,111,81"},0.25)`, borderRadius: 16, padding: "20px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: sc, marginBottom: 14, letterSpacing: 1 }}>{sm}</div>
              <DiffDisplay typed={input} correct={current.answer} />
            </div>
            <button onClick={advance} style={{ marginTop: 14, width: "100%", background: "linear-gradient(135deg,rgba(42,122,101,0.2),rgba(42,122,101,0.08))", border: "1px solid rgba(42,122,101,0.35)", borderRadius: 14, color: "#2a7a65", fontSize: 16, fontWeight: 600, padding: "15px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{index >= items.length - 1 ? "Klaar →" : "Volgende →"}</button>
          </>
        )}
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
      <div style={{ fontSize: 64, fontWeight: 700, fontFamily: "'Playfair Display',serif", color: pct >= 80 ? "#0f9d91" : pct >= 50 ? "#b86d1e" : "#c94a3a", marginBottom: 8 }}>{pct}%</div>
      <div style={{ color: "#6b6560", fontSize: 15, marginBottom: 8 }}>{score.right} goed · {score.wrong} fout</div>
      <div style={{ color: "#1c1917", fontSize: 20, fontWeight: 600, marginBottom: 32, fontFamily: "'Playfair Display',serif" }}>{pct >= 90 ? "Uitstekend!" : pct >= 70 ? "Goed bezig!" : pct >= 50 ? "Ga zo door!" : "Blijf oefenen!"}</div>
      {score.wrongs.length > 0 && (
        <div style={{ width: "100%", maxWidth: 360, marginBottom: 22, background: "rgba(255,255,255,0.65)", border: "1px solid rgba(201,74,58,0.15)", borderRadius: 16, padding: "16px 20px", maxHeight: 240, overflowY: "auto" }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#c94a3a", marginBottom: 10, fontWeight: 600 }}>Nog te leren</div>
          {score.wrongs.map((w, i) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: i < score.wrongs.length - 1 ? "1px solid rgba(255,255,255,0.75)" : "none", fontSize: 13 }}>
              <div style={{ color: "#b86d1e" }}>{w.answer}</div>
              <div style={{ color: "#6b6560", fontSize: 11, marginTop: 2 }}>{w.hint}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 340 }}>
        {score.wrongs.length > 0 && <button onClick={() => onRetry(score.wrongs)} style={{ ...s.wrongBtn, width: "100%" }}>Oefen fouten opnieuw</button>}
        <button onClick={onRestart} style={s.chapterBtn}>Opnieuw</button>
        <button onClick={onHome} style={{ ...s.chapterBtn, color: "#6b6560", border: "1px solid rgba(0,0,0,0.07)" }}>← Terug naar menu</button>
      </div>
    </div>
  );
}

// ── Nuances browse ─────────────────────────────────────────────────────────────
function NuancesBrowse({ onBack, nuances }) {
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState("");
  const q = normalize(search);
  const filtered = nuances.filter(n => !q || normalize(n.topic).includes(q) || normalize(n.rule).includes(q));
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea 0%,#ebe5dc 50%,#e2dbd2 100%)", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, background: "linear-gradient(160deg,#f5f0ea,#ebe5dc)", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={s.backBtn}>← Menu</button>
          <div style={{ flex: 1, textAlign: "center" }}><div style={{ ...s.label, color: "#92600a" }}>Nuances</div></div>
          <div style={{ width: 48 }} />
        </div>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#a09890", fontSize: 15 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken..." style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px 12px 38px", background: "rgba(255,255,255,0.85)", border: "1px solid rgba(146,96,10,0.15)", borderRadius: 12, color: "#1c1917", fontSize: 15, outline: "none", fontFamily: "'DM Sans',sans-serif", caretColor: "#92600a" }} />
        </div>
        <div style={{ fontSize: 12, color: "#a09890", paddingBottom: 8 }}>{filtered.length} topics</div>
      </div>
      <div style={{ flex: 1, padding: "0 20px 40px" }}>
        {filtered.map((n, i) => {
          const open = expanded === n.id;
          return (
            <div key={n.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.85)" }}>
              <button onClick={() => setExpanded(open ? null : n.id)} style={{ width: "100%", background: "none", border: "none", padding: "16px 0", textAlign: "left", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div>
                  <div style={{ color: "#1c1917", fontSize: 15, fontWeight: 600 }}>{n.topic}</div>
                  <div style={{ color: "#6b6560", fontSize: 13, marginTop: 4, lineHeight: 1.4 }}>{n.rule}</div>
                </div>
                <span style={{ color: "#92600a", fontSize: 18, flexShrink: 0, marginTop: 2 }}>{open ? "▲" : "▼"}</span>
              </button>
              {open && (
                <div style={{ paddingBottom: 20 }}>
                  <div style={{ overflowX: "auto", marginBottom: 16 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr>
                          {["Nederlands", "English", "Note"].map(h => (
                            <td key={h} style={{ padding: "8px 10px", borderBottom: "1px solid rgba(146,96,10,0.2)", color: "#92600a", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>{h}</td>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {n.examples.map((ex, j) => (
                          <tr key={j} style={{ background: j % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                            <td style={{ padding: "9px 10px", color: "#1c1917", verticalAlign: "top", fontStyle: "italic" }}>{ex.nl}</td>
                            <td style={{ padding: "9px 10px", color: "#6b6560", verticalAlign: "top" }}>{ex.en}</td>
                            <td style={{ padding: "9px 10px", color: "#a09890", verticalAlign: "top", fontSize: 12 }}>{ex.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {n.tips.length > 0 && (
                    <div style={{ background: "rgba(146,96,10,0.05)", border: "1px solid rgba(146,96,10,0.12)", borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
                      <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "#92600a", fontWeight: 600, marginBottom: 8 }}>Tips</div>
                      {n.tips.map((tip, j) => (
                        <div key={j} style={{ color: "#6b6560", fontSize: 13, lineHeight: 1.5, marginBottom: j < n.tips.length - 1 ? 6 : 0 }}>· {tip}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "#a09890", marginTop: 60, fontSize: 15 }}>Geen resultaten</div>}
      </div>
    </div>
  );
}

// ── Week Tracker ──────────────────────────────────────────────────────────────
const TRACKER_KEY = "dutch-week-tracker-v3";
const trackerLoad = () => { try { return JSON.parse(localStorage.getItem(TRACKER_KEY)) || {}; } catch { return {}; } };
const trackerSave = (s) => { try { localStorage.setItem(TRACKER_KEY, JSON.stringify(s)); } catch(e) { console.error("save failed", e); } };

const trackerAccent = "#e0701a";
const trackerInk = "#211c16";
const trackerBlue = "#3a6b66";

function WeekTracker({ weekPlan, onBack }) {
  const [checks, setChecks] = useState(() => trackerLoad().checks || {});
  const [mounted, setMounted] = useState(false);
  const WEEK = weekPlan.days;

  useEffect(() => { const t = setTimeout(() => setMounted(true), 30); return () => clearTimeout(t); }, []);
  useEffect(() => { trackerSave({ checks }); }, [checks]);

  const toggle = (id) => setChecks((c) => ({ ...c, [id]: !c[id] }));
  const resetWeek = () => { if (window.confirm("Nieuwe week — clear all checks?")) setChecks({}); };

  let reqTotal = 0, reqDone = 0;
  WEEK.forEach((d, di) => d.tasks.forEach((t, ti) => {
    if (!t.opt) { reqTotal++; if (checks[`${di}|${ti}`]) reqDone++; }
  }));
  const pct = reqTotal ? Math.round((reqDone / reqTotal) * 100) : 0;

  return (
    <div style={{ background: "#f5f0ea", color: trackerInk, minHeight: "100vh", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,800&family=Spectral:wght@300;400;500&display=swap');
        .tr-fr{font-family:'Fraunces',Georgia,serif}
        .tr-sp{font-family:'Spectral',Georgia,serif}
        .tr-rise{opacity:0;transform:translateY(10px);animation:tr-rise .5s forwards}
        @keyframes tr-rise{to{opacity:1;transform:none}}
      `}</style>
      <button onClick={onBack} style={{ ...s.backBtn, position: "absolute", top: 20, left: 20 }}>← Menu</button>

      <div className="tr-sp" style={{ maxWidth: 720, margin: "0 auto", padding: "56px 22px 64px" }}>
        <div className={mounted ? "tr-rise" : ""}>
          <div style={{ fontSize: 12, letterSpacing: 3, textTransform: "uppercase", color: trackerAccent, fontWeight: 500 }}>Mijn Nederlandse week · B1</div>
          <h1 className="tr-fr" style={{ fontSize: 40, lineHeight: 1.05, fontWeight: 800, margin: "8px 0 6px", letterSpacing: -0.5 }}>Deze week</h1>
          <p style={{ margin: 0, color: "#6b6256", fontSize: 16, maxWidth: 540 }}>Stacked onto the gym, lunch and break gaps — weekends kept light. Do what the day says and tick it.</p>
        </div>

        <div className={mounted ? "tr-rise" : ""} style={{ animationDelay: "80ms", marginTop: 24, padding: "16px 18px", background: "rgba(255,255,255,0.75)", border: "1px solid rgba(184,109,30,0.15)", borderRadius: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#6b6256", marginBottom: 8 }}>
            <span>Week progress</span>
            <span><strong style={{ color: trackerInk }}>{reqDone}</strong> / {reqTotal} · {pct}%</span>
          </div>
          <div style={{ height: 9, background: "#ece3d2", borderRadius: 99, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: trackerAccent, transition: "width .4s ease" }} />
          </div>
          <p style={{ margin: "9px 0 0", fontSize: 12, color: "#a09890" }}>Bad week? The floor is daily vocab + the gym podcast. Hit those and you held the line.</p>
        </div>

        <div style={{ marginTop: 22, display: "grid", gap: 13 }}>
          {WEEK.map((d, di) => {
            const reqs = d.tasks.filter((t) => !t.opt);
            const dayDone = reqs.length > 0 && reqs.every((t) => checks[`${di}|${d.tasks.indexOf(t)}`]);
            const isLesson = d.tasks.some((t) => t.tag === "Les");
            return (
              <div key={di} className={mounted ? "tr-rise" : ""} style={{ animationDelay: `${130 + di * 45}ms`, background: "rgba(255,255,255,0.75)", border: `1px solid ${isLesson ? "#cfe0dd" : "rgba(184,109,30,0.15)"}`, borderLeft: `3px solid ${isLesson ? trackerBlue : trackerAccent}`, borderRadius: 12, padding: "15px 18px", opacity: dayDone ? 0.7 : 1 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 11 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                    <span className="tr-fr" style={{ fontSize: 21, fontWeight: 800 }}>{d.day}</span>
                    <span style={{ fontSize: 12, letterSpacing: 0.5, color: isLesson ? trackerBlue : "#9a8f7d" }}>{d.note}</span>
                  </div>
                  {dayDone && <span style={{ fontSize: 12, color: trackerAccent }}>✓ af</span>}
                </div>
                <div style={{ display: "grid", gap: 9 }}>
                  {d.tasks.map((t, ti) => {
                    const id = `${di}|${ti}`; const on = !!checks[id];
                    const tagColor = t.tag === "Les" ? trackerBlue : "#b3a892";
                    const tagBorder = t.tag === "Les" ? "#cfe0dd" : "rgba(184,109,30,0.15)";
                    return (
                      <button key={ti} onClick={() => toggle(id)} style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", background: "transparent", border: "none", cursor: "pointer", padding: "1px 0", width: "100%" }}>
                        <span style={{ flexShrink: 0, width: 19, height: 19, borderRadius: 3, border: `1.5px solid ${on ? trackerAccent : (t.opt ? "#d8cdb6" : "#cabfa8")}`, background: on ? trackerAccent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 12, fontWeight: 700 }}>{on ? "✓" : ""}</span>
                        <span style={{ flex: 1, fontSize: 15, color: on ? "#9a8f7d" : (t.opt ? "#8a8275" : trackerInk), textDecoration: on ? "line-through" : "none", fontStyle: t.opt ? "italic" : "normal" }}>{t.label}</span>
                        <span style={{ flexShrink: 0, fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: tagColor, border: `1px solid ${tagBorder}`, borderRadius: 99, padding: "2px 8px" }}>{t.tag}{t.mins ? ` · ${t.mins}m` : ""}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className={mounted ? "tr-rise" : ""} style={{ animationDelay: "520ms", marginTop: 22, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: "#9a8f7d", maxWidth: 440 }}>Subtitles always in Dutch. End of July: check in, then we open <em>Nederlands op niveau</em> for B1 → B2.</p>
          <button onClick={resetWeek} style={{ fontSize: 13, color: trackerAccent, background: "transparent", border: `1px solid ${trackerAccent}`, borderRadius: 99, padding: "7px 16px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Nieuwe week</button>
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [appData, setAppData] = useState(null);
  const [screen, setScreen] = useState("home");
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

  useEffect(() => {
    Promise.all([
      fetch("./data/vocab.json").then(r => r.json()),
      fetch("./data/verbs.json").then(r => r.json()),
      fetch("./data/verb_sentences.json").then(r => r.json()),
      fetch("./data/expressions.json").then(r => r.json()),
      fetch("./data/expression_sentences.json").then(r => r.json()),
      fetch("./data/nuances.json").then(r => r.json()),
      fetch("./data/week_plan.json").then(r => r.json()),
    ]).then(([vocab, verbs, sentences, expressions, exprSentences, nuances, weekPlan]) => {
      const chapters = Object.keys(vocab);
      const allVocab = Object.values(vocab).flat();
      const coreVerbs = verbs.core || [];
      const chapVerbs = Object.fromEntries(Object.entries(verbs).filter(([k]) => k !== "core"));
      const allVerbsRaw = [...coreVerbs, ...Object.values(chapVerbs).flat()];
      const allVerbs = Array.from(new Map(allVerbsRaw.map(v => [v.inf, v])).values());
      const verbGroups = { "Kern werkwoorden": coreVerbs, ...chapVerbs };
      const verbGroupNames = Object.keys(verbGroups);
      const exprCategories = [...new Set(expressions.map(e => e.category))];
      setAppData({ vocab, chapters, allVocab, allVerbs, verbGroups, verbGroupNames, sentences, expressions, exprSentences, exprCategories, nuances, weekPlan });
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

  const handleNext = useCallback((result) => {
    recordAttempt(vocabId(cards[idx]), result === "known");
    if (result === "known") setKnown(k => [...k, cards[idx]]);
    if (result === "unknown") setUnknown(u => [...u, cards[idx]]);
    if (idx >= cards.length - 1) setTimeout(() => setScreen("results"), 100);
    else { setIdx(i => i + 1); setFlipped(false); }
  }, [idx, cards]);

  const handlePrev = useCallback(() => {
    if (idx > 0) { setIdx(i => i - 1); setFlipped(false); }
  }, [idx]);

  if (!appData) {
    return (
      <div style={{ minHeight: "100vh", background: "#f5f0ea", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#6b6560", fontFamily: "system-ui", fontSize: 16 }}>Laden…</div>
      </div>
    );
  }

  const { vocab, chapters, allVocab, allVerbs, verbGroups, verbGroupNames, sentences, expressions, exprSentences, exprCategories, nuances, weekPlan } = appData;

  const startVerbTest = (testMode, count, selectedTenses, selectedGroups) => {
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

  const handlePractice = (deck, title) => { setPracticePool(deck); setPracticeTitle(title); setScreen("mode"); };
  const handleMode = (m, size) => { setChunkSize(size); startDeck(practicePool, m, size); };

  const cardsScreen = (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f5f0ea 0%,#ebe5dc 50%,#e2dbd2 100%)", fontFamily: "system-ui,sans-serif", position: "relative" }}>
      <button onClick={() => setScreen("vocabHome")} style={{ ...s.backBtn, position: "absolute", top: 18, left: 18, zIndex: 10 }}>← Menu</button>
      <button onClick={() => setScreen("glossary")} style={{ position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 10, background: "rgba(43,108,176,0.08)", border: "1px solid rgba(43,108,176,0.2)", borderRadius: 8, color: "#2b6cb0", fontSize: 12, padding: "6px 12px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>📖 Lijst</button>
      <button onClick={() => startDeck(practicePool, mode === "flip" ? "type" : "flip", chunkSize)} style={{ position: "absolute", top: 14, right: 16, zIndex: 10, background: "rgba(0,0,0,0.05)", border: "1px solid rgba(184,109,30,0.15)", borderRadius: 8, color: "#b86d1e", fontSize: 12, padding: "6px 12px", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>{mode === "flip" ? "⌨️ Typen" : "🃏 Kaarten"}</button>
      {mode === "flip"
        ? <Flashcard card={cards[idx]} flipped={flipped} onFlip={() => setFlipped(f => !f)} onNext={handleNext} onPrev={handlePrev} index={idx} total={cards.length} known={known.length} unknown={unknown.length} />
        : <TypingCard card={cards[idx]} index={idx} total={cards.length} known={known.length} unknown={unknown.length} onNext={handleNext} />
      }
    </div>
  );

  return (
    <>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}body{background:#f5f0ea;font-family:system-ui,sans-serif}input::placeholder{color:#a09890}::-webkit-scrollbar{display:none}input{color:#1c1917}`}</style>
      {screen === "home" && <Home allVocab={allVocab} allVerbs={allVerbs} allExpressions={expressions} nuances={nuances} onVocab={() => setScreen("vocabHome")} onVerbs={() => setScreen("verbs")} onExpressions={() => setScreen("expressions")} onNuances={() => setScreen("nuances")} onTracker={() => setScreen("tracker")} />}
      {screen === "tracker" && <WeekTracker weekPlan={weekPlan} onBack={() => setScreen("home")} />}
      {screen === "nuances" && <NuancesBrowse nuances={nuances} onBack={() => setScreen("home")} />}
      {screen === "vocabHome" && <VocabHome chapters={chapters} vocab={vocab} allVocab={allVocab} onBack={() => setScreen("home")} onGlossary={() => setScreen("glossary")} onPractice={handlePractice} />}
      {screen === "glossary" && <Glossary vocab={vocab} allVocab={allVocab} chapters={chapters} onBack={() => setScreen("vocabHome")} />}
      {screen === "verbs" && <VerbsHome allVerbs={allVerbs} onBack={() => setScreen("home")} onStudy={() => setScreen("verbStudy")} onTest={() => setScreen("verbTestSetup")} />}
      {screen === "verbStudy" && <VerbStudy verbGroups={verbGroups} verbGroupNames={verbGroupNames} onBack={() => setScreen("verbs")} />}
      {screen === "verbTestSetup" && <VerbTestSetup onBack={() => setScreen("verbs")} onStart={startVerbTest} verbGroupNames={verbGroupNames} />}
      {screen === "verbTest" && <VerbTest items={verbTestItems} mode={verbTestMode} onBack={() => setScreen("verbTestSetup")} onComplete={scr => { setVerbScore(scr); setScreen("verbResults"); }} />}
      {screen === "verbResults" && verbScore && <VerbResults score={verbScore} onRestart={() => startVerbTest(verbTestMode, verbTestItems.length, verbTestTenses, verbTestGroups)} onRetry={wrongs => { setVerbTestItems(wrongs); setVerbScore(null); setScreen("verbTest"); }} onHome={() => setScreen("verbs")} />}
      {screen === "expressions" && <ExpressionsHome allExpressions={expressions} onBack={() => setScreen("home")} onBrowse={() => setScreen("exprBrowse")} onTest={() => setScreen("exprTestSetup")} />}
      {screen === "exprBrowse" && <ExpressionsBrowse expressions={expressions} categories={exprCategories} onBack={() => setScreen("expressions")} />}
      {screen === "exprTestSetup" && <ExpressionsTestSetup categories={exprCategories} onBack={() => setScreen("expressions")} onStart={startExpressionTest} />}
      {screen === "exprTest" && <ExpressionTest items={exprTestItems} onBack={() => setScreen("exprTestSetup")} onComplete={scr => { setExprScore(scr); setScreen("exprResults"); }} />}
      {screen === "exprResults" && exprScore && <ExpressionResults score={exprScore} onRestart={() => startExpressionTest(exprTestItems.length, exprTestCats)} onRetry={wrongs => { setExprTestItems(wrongs); setExprScore(null); setScreen("exprTest"); }} onHome={() => setScreen("expressions")} />}
      {screen === "mode" && <ModeSelect title={practiceTitle} total={practicePool.length} onSelect={handleMode} onBack={() => setScreen("vocabHome")} />}
      {screen === "cards" && cards.length > 0 && cardsScreen}
      {screen === "results" && <Results known={known} unknown={unknown} onRestart={() => startDeck(practicePool, mode, chunkSize)} onHome={() => setScreen("vocabHome")} onRetry={() => startDeck(unknown, mode, unknown.length)} />}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
