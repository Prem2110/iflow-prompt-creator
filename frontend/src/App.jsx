import { useEffect, useRef, useState } from "react";
import FileUpload from "./components/FileUpload.jsx";
import PromptOutput from "./components/PromptOutput.jsx";
import InstructionsOutput from "./components/InstructionsOutput.jsx";
import ProgressSteps from "./components/ProgressSteps.jsx";
import HelpModal from "./components/HelpModal.jsx";
import Toast from "./components/Toast.jsx";
import FlowDiscovery from "./components/FlowDiscovery.jsx";
import MultiPromptOutput from "./components/MultiPromptOutput.jsx";
import { useToast } from "./hooks/useToast.js";
import sierraLogo from "./assets/logosierra.png";
import styles from "./App.module.css";

const HISTORY_KEY = "orbit-history";
const MAX_HISTORY = 5;
const DARK_KEY = "orbit-dark";

function now() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; }
}

function saveHistory(entry, prev) {
  const next = [entry, ...prev].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

// ── Empty state placeholders ───────────────────────────────────────────────────

function EmptyTab({ icon, title, hint, onAction, actionLabel, disabled }) {
  return (
    <div className={styles.emptyTab}>
      <div className={styles.emptyIcon}>{icon}</div>
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyHint}>{hint}</p>
      {onAction && (
        <button className={styles.emptyAction} onClick={onAction} disabled={disabled}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [steps, setSteps] = useState([]);
  const [showHelp, setShowHelp] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [prompt, setPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [summary, setSummary] = useState("");
  const [activeTab, setActiveTab] = useState("prompt");

  const [timestamps, setTimestamps] = useState({ prompt: null, instructions: null, summary: null });
  const [feedback, setFeedback] = useState({ prompt: null, instructions: null, summary: null });

  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState(null);
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  const [discoveredFlows, setDiscoveredFlows] = useState([]);
  const [selectedFlowIds, setSelectedFlowIds] = useState(new Set());
  const [multiPrompts, setMultiPrompts] = useState({});
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [generatingFlowId, setGeneratingFlowId] = useState(null);
  const [multiLoading, setMultiLoading] = useState(false);

  const [history, setHistory] = useState(loadHistory);
  const [dark, setDark] = useState(() => localStorage.getItem(DARK_KEY) === "true");

  const { toasts, toast, remove: removeToast } = useToast();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem(DARK_KEY, dark);
  }, [dark]);

  function upsertStep(key, state, message) {
    setSteps((prev) => {
      const exists = prev.find((s) => s.key === key);
      if (exists) return prev.map((s) => (s.key === key ? { ...s, state, message } : s));
      return [...prev, { key, state, message }];
    });
  }

  async function streamFrom(endpoint, mode, setter) {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError("");
    setSteps([]);
    setWarning("");
    setter("");

    const form = new FormData();
    files.forEach((f) => form.append("files", f));

    try {
      const res = await fetch(endpoint, { method: "POST", body: form, signal: controller.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));

          if (event.status === "step") {
            upsertStep(event.key, "active", event.message);
            if (event.key === "retry") setter("");
          } else if (event.status === "step_done") {
            upsertStep(event.key, "done", event.message);
          } else if (event.status === "chunk") {
            setter((prev) => { finalResult = prev + event.text; return finalResult; });
          } else if (event.status === "error") {
            setError(event.message);
            setLoading(false);
            setLoadingMode(null);
            setSteps((prev) => prev.map((s) => (s.state === "active" ? { ...s, state: "error" } : s)));
            controller.abort();
            return;
          } else if (event.status === "done") {
            finalResult = event.prompt || finalResult;
            setter(finalResult);
            setWarning(event.warning || "");
            setLoading(false);
            setLoadingMode(null);
            const ts = now();
            setTimestamps((prev) => ({ ...prev, [mode]: ts }));
            // Save to session history
            if (finalResult) {
              setHistory((prev) => saveHistory({
                mode,
                ts,
                files: files.map((f) => f.name),
                preview: finalResult.slice(0, 160),
                content: finalResult,
              }, prev));
            }
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMode(null);
      abortRef.current = null;
    }
  }

  async function handleGenerate() {
    if (files.length === 0) return;
    setActiveTab("prompt");
    setLoadingMode("prompt");
    await streamFrom("/api/generate-prompt", "prompt", setPrompt);
  }

  async function handleInstructions() {
    if (files.length === 0) return;
    setActiveTab("instructions");
    setLoadingMode("instructions");
    await streamFrom("/api/generate-instructions", "instructions", setInstructions);
  }

  async function handleSummary() {
    if (files.length === 0) return;
    setActiveTab("summary");
    setLoadingMode("summary");
    await streamFrom("/api/summarize", "summary", setSummary);
  }

  async function handleDiscover() {
    if (files.length === 0) return;
    setDiscoverLoading(true);
    setDiscoveredFlows([]);
    setSelectedFlowIds(new Set());
    setMultiPrompts({});
    setError("");
    setSteps([]);

    const form = new FormData();
    files.forEach((f) => form.append("files", f));

    try {
      const res = await fetch("/api/discover-flows", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.status === "step") upsertStep(event.key, "active", event.message);
          else if (event.status === "step_done") upsertStep(event.key, "done", event.message);
          else if (event.status === "error") { setError(event.message); return; }
          else if (event.status === "done") {
            setDiscoveredFlows(event.flows || []);
            setSelectedFlowIds(new Set((event.flows || []).map((f) => f.id)));
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setDiscoverLoading(false);
    }
  }

  async function handleGenerateSelected() {
    const selected = discoveredFlows.filter((f) => selectedFlowIds.has(f.id));
    if (selected.length === 0) return;
    setMultiLoading(true);
    setActiveTab("multiflow");
    setError("");

    for (const flow of selected) {
      setGeneratingFlowId(flow.id);
      setMultiPrompts((prev) => ({ ...prev, [flow.id]: "" }));

      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      form.append("flow_json", JSON.stringify(flow));

      try {
        const res = await fetch("/api/generate-flow-prompt", { method: "POST", body: form });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.detail || `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let flowResult = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6));
            if (event.status === "chunk") {
              flowResult += event.text;
              setMultiPrompts((prev) => ({ ...prev, [flow.id]: flowResult }));
            } else if (event.status === "done") {
              flowResult = event.prompt || flowResult;
              setMultiPrompts((prev) => ({ ...prev, [flow.id]: flowResult }));
            } else if (event.status === "error") {
              setError(event.message);
            }
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") setError(err.message);
      }
      setGeneratingFlowId(null);
    }
    setMultiLoading(false);
  }

  function handleReset() {
    if (abortRef.current) abortRef.current.abort();
    setFiles([]); setSteps([]); setPrompt(""); setInstructions(""); setSummary("");
    setWarning(""); setError(""); setLoading(false); setLoadingMode(null);
    setActiveTab("prompt");
    setTimestamps({ prompt: null, instructions: null, summary: null });
    setFeedback({ prompt: null, instructions: null, summary: null });
    setDiscoveredFlows([]); setSelectedFlowIds(new Set()); setMultiPrompts({});
    setDiscoverLoading(false); setGeneratingFlowId(null); setMultiLoading(false);
  }

  function handleFeedback(tab, value) {
    setFeedback((prev) => ({ ...prev, [tab]: value }));
    toast(value === "up" ? "Thanks for the positive feedback!" : "Thanks — we'll use this to improve.", "info");
  }

  function restoreFromHistory(entry) {
    if (entry.mode === "prompt") { setPrompt(entry.content); setActiveTab("prompt"); }
    if (entry.mode === "instructions") { setInstructions(entry.content); setActiveTab("instructions"); }
    if (entry.mode === "summary") { setSummary(entry.content); setActiveTab("summary"); }
    setTimestamps((prev) => ({ ...prev, [entry.mode]: entry.ts }));
    setShowHistory(false);
    toast("Restored from history", "info");
  }

  const hasOutput = prompt || instructions || summary || Object.keys(multiPrompts).length > 0 || multiLoading;
  const isGenerating = loading && loadingMode === "prompt";
  const isInstructing = loading && loadingMode === "instructions";
  const isSummarising = loading && loadingMode === "summary";

  const modeTabs = [
    { key: "prompt", label: "Prompt", content: prompt, ts: timestamps.prompt },
    { key: "instructions", label: "Manual Instructions", content: instructions, ts: timestamps.instructions },
    { key: "summary", label: "Summary", content: summary, ts: timestamps.summary },
    ...(Object.keys(multiPrompts).length > 0 || multiLoading ? [{
      key: "multiflow",
      label: `Multi-Flow${Object.keys(multiPrompts).length > 0 ? ` (${Object.keys(multiPrompts).length})` : ""}`,
      content: Object.keys(multiPrompts).length > 0 ? "has" : "",
      ts: null,
    }] : []),
  ];

  return (
    <div className={styles.page}>
      <Toast toasts={toasts} remove={removeToast} />
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      <div className={styles.orbs} aria-hidden="true">
        <div className={`${styles.orb} ${styles.orb1}`} />
        <div className={`${styles.orb} ${styles.orb2}`} />
        <div className={`${styles.orb} ${styles.orb3}`} />
      </div>

      <header className={styles.header}>
        <div className={styles.topBar}>
          <img src={sierraLogo} alt="Sierra Digital" className={styles.sierraLogo} />
          <div className={styles.topBarRight}>
            {history.length > 0 && (
              <button className={styles.historyBtn} onClick={() => setShowHistory((v) => !v)} title="Session history">
                History {showHistory ? "▴" : "▾"}
              </button>
            )}
            <button className={styles.darkBtn} onClick={() => setDark((d) => !d)} title="Toggle dark mode">
              {dark ? "☀" : "☾"}
            </button>
            <button className={styles.helpBtn} onClick={() => setShowHelp(true)} title="How to use this app">
              Help
            </button>
          </div>
        </div>
        <div className={styles.logo}>
          <span className={styles.logoText}>Orbit Prompt Generator</span>
        </div>
        <p className={styles.subtitle}>
          Upload documents or screenshots → get a ready-to-use SAP CPI iFlow prompt or manual build guide
        </p>
      </header>

      <main className={styles.main}>
        {/* History panel */}
        {showHistory && history.length > 0 && (
          <section className={`${styles.card} ${styles.historyCard}`}>
            <div className={styles.historyHeader}>
              <span className={styles.sectionTitle}><span className={styles.stepNum}>H</span> Session History</span>
              <button className={styles.btnGhost} onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]); setShowHistory(false); }}>Clear</button>
            </div>
            <div className={styles.historyList}>
              {history.map((h, i) => (
                <div key={i} className={styles.historyItem} onClick={() => restoreFromHistory(h)}>
                  <div className={styles.historyMeta}>
                    <span className={`${styles.historyMode} ${styles[`mode_${h.mode}`]}`}>{h.mode}</span>
                    <span className={styles.historyTs}>{h.ts}</span>
                    <span className={styles.historyFiles}>{h.files.join(", ")}</span>
                  </div>
                  <p className={styles.historyPreview}>{h.preview}…</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className={styles.card}>
          <h2 className={styles.sectionTitle}><span className={styles.stepNum}>1</span>Upload Files</h2>
          <FileUpload files={files} onChange={setFiles} disabled={loading} />

          <div className={styles.actions}>
            <button className={styles.btnPrimary} onClick={handleGenerate}
              disabled={files.length === 0 || loading}
              title="Generate a ready-to-use SAP CPI iFlow configuration prompt">
              {isGenerating ? <><span className={styles.spinner} /> Generating&hellip;</> : "Generate Prompt"}
            </button>
            <button className={styles.btnSecondary} onClick={handleInstructions}
              disabled={files.length === 0 || loading}
              title="Generate a step-by-step manual build guide with scripts and Postman testing">
              {isInstructing ? <><span className={styles.spinner} /> Building guide&hellip;</> : "Manual Instructions"}
            </button>
            <button className={styles.btnTertiary} onClick={handleSummary}
              disabled={files.length === 0 || loading}
              title="Get a concise overview of the iFlow">
              {isSummarising ? <><span className={styles.spinnerTeal} /> Summarising&hellip;</> : "Summarize"}
            </button>
            <button className={styles.btnDiscover} onClick={handleDiscover}
              disabled={files.length === 0 || loading || discoverLoading}
              title="Detect all integration interfaces in the uploaded document">
              {discoverLoading ? <><span className={styles.spinner} /> Discovering&hellip;</> : "Discover Flows"}
            </button>
            {(files.length > 0 || hasOutput) && (
              <button className={styles.btnGhost} onClick={handleReset} disabled={loading && !abortRef.current}>
                {loading ? "Cancel" : "Reset"}
              </button>
            )}
          </div>

          {error && <p className={styles.error} role="alert">{error}</p>}
          {steps.length > 0 && <ProgressSteps steps={steps} />}

          {discoveredFlows.length > 0 && (
            <FlowDiscovery
              flows={discoveredFlows}
              selectedIds={selectedFlowIds}
              onToggle={(id) => setSelectedFlowIds((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
              })}
              onSelectAll={() => setSelectedFlowIds(new Set(discoveredFlows.map((f) => f.id)))}
              onDeselectAll={() => setSelectedFlowIds(new Set())}
              onGenerate={handleGenerateSelected}
              generatingFlowId={generatingFlowId}
              loading={multiLoading}
            />
          )}
        </section>

        {hasOutput && (
          <section className={styles.card}>
            <div className={styles.tabsRow}>
              <div className={styles.tabs}>
                {modeTabs.map(({ key, label, ts, content }) => (
                  <button key={key}
                    className={`${styles.tab} ${activeTab === key ? styles.activeTab : ""}`}
                    onClick={() => setActiveTab(key)}>
                    {label}
                    {content && <span className={styles.tabDot} />}
                    {ts && <span className={styles.tabTs}>{ts}</span>}
                  </button>
                ))}
              </div>
              <div className={styles.tabActions}>
                {modeTabs.map(({ key }) => {
                  const handlers = { prompt: handleGenerate, instructions: handleInstructions, summary: handleSummary };
                  const spinning = { prompt: isGenerating, instructions: isInstructing, summary: isSummarising };
                  if (activeTab !== key) return null;
                  if (key === "multiflow") return null;
                  return (
                    <div key={key} className={styles.tabActionsInner}>
                      <button className={styles.btnRetry} disabled={loading} onClick={() => {
                        const hasContent = { prompt, instructions, summary };
                        if (hasContent[key] && !window.confirm("This will replace the current output. Continue?")) return;
                        handlers[key]();
                      }}>
                        {spinning[key] ? <><span className={styles.spinner} /> Regenerating&hellip;</> : "↺ Retry"}
                      </button>
                      {/* Feedback */}
                      <div className={styles.feedbackRow}>
                        <button
                          className={`${styles.feedbackBtn} ${feedback[key] === "up" ? styles.feedbackActive : ""}`}
                          onClick={() => handleFeedback(key, "up")} title="Good output">👍</button>
                        <button
                          className={`${styles.feedbackBtn} ${feedback[key] === "down" ? styles.feedbackActive : ""}`}
                          onClick={() => handleFeedback(key, "down")} title="Poor output">👎</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={styles.disclaimer}>
              <span className={styles.disclaimerIcon}>i</span>
              Content is generated entirely based on the documents you uploaded. Always review before use.
            </div>

            {/* Prompt tab */}
            {activeTab === "prompt" && (prompt
              ? <>
                  {warning && <div className={styles.warning} role="alert"><strong>Review needed:</strong> {warning}</div>}
                  <PromptOutput prompt={prompt} loading={isGenerating} toast={toast} />
                </>
              : <EmptyTab icon="⚡" title="No prompt yet"
                  hint="Click Generate Prompt to create a ready-to-use SAP CPI iFlow configuration prompt from your uploaded files."
                  onAction={handleGenerate} actionLabel="Generate Prompt" disabled={files.length === 0 || loading} />
            )}

            {/* Instructions tab */}
            {activeTab === "instructions" && (instructions
              ? <InstructionsOutput instructions={instructions} loading={isInstructing} toast={toast} />
              : <EmptyTab icon="📋" title="No instructions yet"
                  hint="Click Manual Instructions to get a full step-by-step build guide with Groovy scripts, XSLT mappings, and Postman testing."
                  onAction={handleInstructions} actionLabel="Generate Manual Instructions" disabled={files.length === 0 || loading} />
            )}

            {/* Summary tab */}
            {activeTab === "summary" && (summary
              ? <InstructionsOutput instructions={summary} loading={isSummarising} label="iFlow Summary" exportFilename="iflow-summary" toast={toast} />
              : <EmptyTab icon="📄" title="No summary yet"
                  hint="Click Summarize to get a concise overview — iFlow purpose, topology, adapters, and key configuration."
                  onAction={handleSummary} actionLabel="Summarize" disabled={files.length === 0 || loading} />
            )}

            {/* Multi-flow tab */}
            {activeTab === "multiflow" && (
              <MultiPromptOutput
                flows={discoveredFlows}
                prompts={multiPrompts}
                generatingFlowId={generatingFlowId}
                loading={multiLoading}
                toast={toast}
              />
            )}
          </section>
        )}
      </main>
    </div>
  );
}
