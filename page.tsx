"use client";

import {
  useEffect, useRef, useState, useCallback, KeyboardEvent
} from "react";
import styles from "./page.module.css";

// ── Types ──────────────────────────────────────────────────────────────────
type Status = "idle" | "listening" | "thinking" | "speaking" | "error";
type Turn = { role: "user" | "assistant"; content: string; ts: number };
type Session = { id: string; name: string; turns: Turn[] };
type Settings = {
  apiKey: string;
  rate: number;
  pitch: number;
  lang: string;
  voiceURI: string;
  theme: "dark" | "light";
};

const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  rate: 1.05,
  pitch: 1.0,
  lang: "en-US",
  voiceURI: "",
  theme: "dark",
};

const LANGS = [
  { label: "English (US)", value: "en-US" },
  { label: "English (UK)", value: "en-GB" },
  { label: "Spanish", value: "es-ES" },
  { label: "French", value: "fr-FR" },
  { label: "German", value: "de-DE" },
  { label: "Portuguese", value: "pt-BR" },
  { label: "Hindi", value: "hi-IN" },
];

function uid() { return Math.random().toString(36).slice(2, 9); }
function ts() { return Date.now(); }
function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Quick offline commands ─────────────────────────────────────────────────
function tryOffline(text: string): string | null {
  const t = text.toLowerCase().trim();
  if (/(what('?s| is) the time|current time|time (is it|now))/.test(t))
    return `It's ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
  if (/(what('?s| is) the date|today('?s| is) date|what day)/.test(t))
    return `Today is ${new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;
  if (/^(how much is |calculate |what is |what'?s )?(\d[\d\s\+\-\*\/\(\)\.\^%]+)$/.test(t)) {
    try {
      // Safe eval using Function — only arithmetic
      const expr = t.replace(/[^0-9+\-*/(). %]/g, "");
      if (expr.length > 2) {
        // eslint-disable-next-line no-new-func
        const result = new Function(`"use strict"; return (${expr})`)();
        if (typeof result === "number" && isFinite(result))
          return `That's ${result}.`;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ── App ────────────────────────────────────────────────────────────────────
export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [liveText, setLiveText] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [supported, setSupported] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [copied, setCopied] = useState<number | null>(null);
  const [bars, setBars] = useState<number[]>(Array(32).fill(2));
  const [speakingBar, setSpeakingBar] = useState(0);

  const recognitionRef = useRef<any>(null);
  const handlerRef = useRef<(text: string) => void>(() => {});
  const logEndRef = useRef<HTMLDivElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const sessionNameEditRef = useRef<HTMLInputElement>(null);
  const [editingName, setEditingName] = useState(false);

  // ── Active session helper ────────────────────────────────────────────────
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const updateSession = useCallback((id: string, updater: (s: Session) => Session) => {
    setSessions((prev) => prev.map((s) => s.id === id ? updater(s) : s));
  }, []);

  // ── Persist to localStorage ─────────────────────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem("jarvis_settings");
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
      const rawSess = localStorage.getItem("jarvis_sessions");
      if (rawSess) {
        const parsed: Session[] = JSON.parse(rawSess);
        if (parsed.length > 0) {
          setSessions(parsed);
          setActiveSessionId(parsed[0].id);
          return;
        }
      }
    } catch { /* ignore */ }
    const first: Session = { id: uid(), name: "Session 1", turns: [] };
    setSessions([first]);
    setActiveSessionId(first.id);
  }, []);

  useEffect(() => {
    if (sessions.length === 0) return;
    localStorage.setItem("jarvis_sessions", JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem("jarvis_settings", JSON.stringify(settings));
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings]);

  // ── Voices list ──────────────────────────────────────────────────────────
  useEffect(() => {
    function load() {
      const v = window.speechSynthesis.getVoices();
      if (v.length) setVoices(v);
    }
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }, []);

  // ── Audio visualizer ────────────────────────────────────────────────────
  const startVisualizer = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        setBars(Array.from(data.slice(0, 32)).map((v) => Math.max(2, (v / 255) * 60)));
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* mic denied, skip visualizer */ }
  }, []);

  const stopVisualizer = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    setBars(Array(32).fill(2));
  }, []);

  // ── Speaking animation ───────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "speaking") { setSpeakingBar(0); return; }
    const interval = setInterval(() => {
      setBars(Array(32).fill(0).map(() => Math.random() * 40 + 4));
      setSpeakingBar((b) => (b + 1) % 32);
    }, 80);
    return () => clearInterval(interval);
  }, [status]);

  // ── Speech Recognition setup ────────────────────────────────────────────
  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR || !("speechSynthesis" in window)) { setSupported(false); return; }

    const r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = settings.lang;

    r.onresult = (e: any) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        e.results[i].isFinal ? (final += t) : (interim += t);
      }
      if (interim) setLiveText(interim);
      if (final) { setLiveText(""); handlerRef.current(final.trim()); }
    };
    r.onerror = (e: any) => {
      stopVisualizer();
      if (e.error === "no-speech" || e.error === "aborted") { setStatus("idle"); return; }
      setErrorMsg(`Mic error: ${e.error}. Make sure you've allowed microphone access.`);
      setStatus("error");
    };
    r.onend = () => {
      stopVisualizer();
      setStatus((s) => s === "listening" ? "idle" : s);
    };
    recognitionRef.current = r;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.lang]);

  // ── TTS ──────────────────────────────────────────────────────────────────
  const speak = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = settings.rate;
      u.pitch = settings.pitch;
      u.lang = settings.lang;
      if (settings.voiceURI) {
        const v = voices.find((v) => v.voiceURI === settings.voiceURI);
        if (v) u.voice = v;
      }
      u.onend = () => resolve();
      u.onerror = () => resolve();
      setStatus("speaking");
      window.speechSynthesis.speak(u);
    });
  }, [settings, voices]);

  // ── Handle command ───────────────────────────────────────────────────────
  const handleCommand = useCallback(async (text: string) => {
    if (!text || !activeSessionId) { setStatus("idle"); return; }

    // Special: clear session
    if (/(forget|clear|reset).*(conversation|history|session)/.test(text.toLowerCase())) {
      updateSession(activeSessionId, (s) => ({ ...s, turns: [] }));
      await speak("Done, I've cleared our conversation.");
      setStatus("idle");
      return;
    }

    const userTurn: Turn = { role: "user", content: text, ts: ts() };
    updateSession(activeSessionId, (s) => ({ ...s, turns: [...s.turns, userTurn] }));
    setStatus("thinking");
    setErrorMsg("");

    // Try offline first (time, date, quick maths)
    const offline = tryOffline(text);
    if (offline) {
      const asTurn: Turn = { role: "assistant", content: offline, ts: ts() };
      updateSession(activeSessionId, (s) => ({ ...s, turns: [...s.turns, asTurn] }));
      await speak(offline);
      setStatus("idle");
      return;
    }

    try {
      const history = activeSession?.turns.slice(-30) ?? [];
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history,
          ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Request failed");

      const reply = data.reply || "I didn't catch a response.";
      const asTurn: Turn = { role: "assistant", content: reply, ts: ts() };
      updateSession(activeSessionId, (s) => ({ ...s, turns: [...s.turns, asTurn] }));
      await speak(reply);
      setStatus("idle");
    } catch (err: any) {
      setErrorMsg(err.message || "Something went wrong.");
      setStatus("error");
    }
  }, [activeSessionId, activeSession, settings.apiKey, speak, updateSession]);

  useEffect(() => { handlerRef.current = handleCommand; }, [handleCommand]);

  // ── Scroll log to bottom ─────────────────────────────────────────────────
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.turns, liveText]);

  // ── Mic toggle ───────────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (!recognitionRef.current) return;
    window.speechSynthesis.cancel();
    setErrorMsg("");
    setStatus("listening");
    startVisualizer();
    try { recognitionRef.current.lang = settings.lang; recognitionRef.current.start(); }
    catch { /* already started */ }
  }, [settings.lang, startVisualizer]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    stopVisualizer();
    setStatus("idle");
  }, [stopVisualizer]);

  // ── Keyboard shortcut: Space to toggle mic ───────────────────────────────
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (showSettings) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (status === "listening") stopListening();
        else if (status === "idle") startListening();
      }
      if (e.code === "Escape") {
        if (status === "listening") stopListening();
        setShowSettings(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, showSettings, startListening, stopListening]);

  // ── Sessions management ──────────────────────────────────────────────────
  const newSession = useCallback(() => {
    const s: Session = { id: uid(), name: `Session ${sessions.length + 1}`, turns: [] };
    setSessions((prev) => [s, ...prev]);
    setActiveSessionId(s.id);
  }, [sessions.length]);

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (next.length === 0) {
        const fresh: Session = { id: uid(), name: "Session 1", turns: [] };
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (id === activeSessionId) setActiveSessionId(next[0].id);
      return next;
    });
  }, [activeSessionId]);

  // ── Export transcript ────────────────────────────────────────────────────
  const exportSession = useCallback(() => {
    if (!activeSession) return;
    const lines = activeSession.turns.map(
      (t) => `[${fmtTime(t.ts)}] ${t.role === "user" ? "You" : "Jarvis"}: ${t.content}`
    );
    const blob = new Blob([lines.join("\n\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${activeSession.name}.txt`; a.click();
    URL.revokeObjectURL(url);
  }, [activeSession]);

  // ── Copy reply ───────────────────────────────────────────────────────────
  const copyTurn = useCallback((idx: number, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(idx);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  // ── Replay a reply with TTS ──────────────────────────────────────────────
  const replayTurn = useCallback(async (content: string) => {
    if (status !== "idle") return;
    await speak(content);
    setStatus("idle");
  }, [status, speak]);

  // ── Waveform color ───────────────────────────────────────────────────────
  const waveColor =
    status === "listening" ? "var(--signal)" :
    status === "thinking" ? "var(--thinking)" :
    status === "speaking" ? "var(--speaking)" :
    status === "error" ? "var(--error)" :
    "var(--text-muted)";

  const orbClass = `${styles.orb} ${styles[status]}`;

  return (
    <div className={styles.shell}>

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <span className={styles.logo}>JARVIS</span>
          <button className={styles.iconBtn} onClick={() => setShowSettings(true)} title="Settings">
            ⚙
          </button>
        </div>

        <button className={styles.newSessionBtn} onClick={newSession}>
          + New session
        </button>

        <div className={styles.sessionList}>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`${styles.sessionItem} ${s.id === activeSessionId ? styles.sessionActive : ""}`}
              onClick={() => setActiveSessionId(s.id)}
            >
              <span className={styles.sessionName}>{s.name}</span>
              <span className={styles.sessionMeta}>{s.turns.length} turns</span>
              {sessions.length > 1 && (
                <button
                  className={styles.sessionDelete}
                  onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                  title="Delete session"
                >×</button>
              )}
            </div>
          ))}
        </div>

        <div className={styles.sidebarFooter}>
          <button className={styles.themeToggle} onClick={() =>
            setSettings((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }))
          }>
            {settings.theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}
          </button>
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────────────── */}
      <main className={styles.main}>

        {/* Session header */}
        <div className={styles.sessionHeader}>
          {editingName ? (
            <input
              ref={sessionNameEditRef}
              className={styles.sessionNameInput}
              defaultValue={activeSession?.name}
              onBlur={(e) => {
                if (activeSessionId) updateSession(activeSessionId, (s) => ({ ...s, name: e.target.value || s.name }));
                setEditingName(false);
              }}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              autoFocus
            />
          ) : (
            <h1 className={styles.sessionTitle} onClick={() => setEditingName(true)} title="Click to rename">
              {activeSession?.name ?? "Jarvis"}
            </h1>
          )}
          <div className={styles.sessionActions}>
            {(activeSession?.turns.length ?? 0) > 0 && (
              <>
                <button className={styles.actionBtn} onClick={exportSession} title="Export transcript">
                  ↓ Export
                </button>
                <button className={styles.actionBtn} onClick={() =>
                  updateSession(activeSessionId, (s) => ({ ...s, turns: [] }))
                } title="Clear conversation">
                  Clear
                </button>
              </>
            )}
          </div>
        </div>

        {/* Conversation log */}
        <div className={styles.log}>
          {!supported && (
            <div className={styles.unsupported}>
              Your browser doesn't support voice input. Please use Chrome or Edge.
            </div>
          )}

          {(activeSession?.turns.length ?? 0) === 0 && supported && (
            <div className={styles.emptyState}>
              <div className={styles.emptyOrb} />
              <p>Press <kbd>Space</kbd> or click the mic to start talking.</p>
              <div className={styles.suggestions}>
                {["What time is it?", "Tell me a fun fact", "What's 15% of 340?", "How do I learn faster?"].map((s) => (
                  <button key={s} className={styles.suggestionChip} onClick={() => handleCommand(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeSession?.turns.map((turn, i) => (
            <div key={i} className={`${styles.turn} ${styles[turn.role]}`}>
              <div className={styles.turnMeta}>
                <span className={styles.turnRole}>{turn.role === "user" ? "You" : "Jarvis"}</span>
                <span className={styles.turnTime}>{fmtTime(turn.ts)}</span>
              </div>
              <p className={styles.turnContent}>{turn.content}</p>
              <div className={styles.turnActions}>
                <button className={styles.microBtn} onClick={() => copyTurn(i, turn.content)}>
                  {copied === i ? "✓ Copied" : "Copy"}
                </button>
                {turn.role === "assistant" && (
                  <button className={styles.microBtn} onClick={() => replayTurn(turn.content)}>
                    ▶ Replay
                  </button>
                )}
              </div>
            </div>
          ))}

          {liveText && (
            <div className={`${styles.turn} ${styles.user} ${styles.live}`}>
              <div className={styles.turnMeta}>
                <span className={styles.turnRole}>You</span>
                <span className={styles.turnTime}>live</span>
              </div>
              <p className={styles.turnContent}>{liveText}</p>
            </div>
          )}

          {status === "thinking" && (
            <div className={`${styles.turn} ${styles.assistant}`}>
              <div className={styles.turnMeta}>
                <span className={styles.turnRole}>Jarvis</span>
              </div>
              <div className={styles.thinking}>
                <span /><span /><span />
              </div>
            </div>
          )}

          <div ref={logEndRef} />
        </div>

        {/* Waveform + mic button */}
        <div className={styles.controls}>
          <div className={styles.waveform}>
            {bars.map((h, i) => (
              <div
                key={i}
                className={styles.bar}
                style={{ height: `${h}px`, background: waveColor, opacity: status === "idle" ? 0.25 : 0.85 }}
              />
            ))}
          </div>

          <div className={styles.micRow}>
            <button
              className={`${styles.micBtn} ${styles[status]}`}
              onClick={status === "listening" ? stopListening : startListening}
              disabled={status === "thinking" || status === "speaking" || !supported}
              title={status === "listening" ? "Stop (Space)" : "Start talking (Space)"}
            >
              <span className={styles.micIcon}>
                {status === "listening" ? "■" : status === "thinking" ? "…" : status === "speaking" ? "♪" : "●"}
              </span>
            </button>
          </div>

          <div className={styles.statusBar}>
            <span className={`${styles.statusDot} ${styles[status]}`} />
            <span className={styles.statusText}>
              {status === "idle" && "Ready — press Space or tap to talk"}
              {status === "listening" && (liveText || "Listening...")}
              {status === "thinking" && "Thinking..."}
              {status === "speaking" && "Speaking..."}
              {status === "error" && errorMsg}
            </span>
          </div>
        </div>
      </main>

      {/* ── Settings panel ───────────────────────────────────────────── */}
      {showSettings && (
        <div className={styles.settingsOverlay} onClick={() => setShowSettings(false)}>
          <div className={styles.settingsPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.settingsHeader}>
              <h2>Settings</h2>
              <button className={styles.iconBtn} onClick={() => setShowSettings(false)}>✕</button>
            </div>

            <label className={styles.settingRow}>
              <span>Anthropic API Key</span>
              <input
                type="password"
                className={styles.settingInput}
                placeholder="sk-ant-... (overrides server key)"
                value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
              />
            </label>

            <label className={styles.settingRow}>
              <span>Language / Accent</span>
              <select
                className={styles.settingInput}
                value={settings.lang}
                onChange={(e) => setSettings((s) => ({ ...s, lang: e.target.value }))}
              >
                {LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </label>

            <label className={styles.settingRow}>
              <span>Voice</span>
              <select
                className={styles.settingInput}
                value={settings.voiceURI}
                onChange={(e) => setSettings((s) => ({ ...s, voiceURI: e.target.value }))}
              >
                <option value="">System default</option>
                {voices.filter((v) => v.lang.startsWith(settings.lang.split("-")[0])).map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>
                ))}
              </select>
            </label>

            <label className={styles.settingRow}>
              <span>Speech speed — {settings.rate.toFixed(2)}×</span>
              <input type="range" min={0.5} max={2} step={0.05}
                value={settings.rate}
                onChange={(e) => setSettings((s) => ({ ...s, rate: parseFloat(e.target.value) }))}
              />
            </label>

            <label className={styles.settingRow}>
              <span>Pitch — {settings.pitch.toFixed(2)}</span>
              <input type="range" min={0.5} max={2} step={0.05}
                value={settings.pitch}
                onChange={(e) => setSettings((s) => ({ ...s, pitch: parseFloat(e.target.value) }))}
              />
            </label>

            <p className={styles.settingNote}>
              Settings are saved automatically to this browser.
              The API key is stored locally only — never sent anywhere except the /api/chat route.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
