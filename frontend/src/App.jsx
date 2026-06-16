import { useEffect, useRef, useState } from "react";
import {
  Sun, Moon, ChevronUp, ChevronDown, HelpCircle, History,
  Zap, ClipboardList, FileText, Search,
  X, RotateCcw, MessageSquare, ThumbsUp, ThumbsDown, Star,
} from "lucide-react";
import FileUpload from "./components/FileUpload.jsx";
import PromptOutput from "./components/PromptOutput.jsx";
import InstructionsOutput from "./components/InstructionsOutput.jsx";
import ProgressSteps from "./components/ProgressSteps.jsx";
import HelpModal from "./components/HelpModal.jsx";
import Toast from "./components/Toast.jsx";
import FlowDiscovery from "./components/FlowDiscovery.jsx";
import MultiPromptOutput from "./components/MultiPromptOutput.jsx";
import Chat from "./components/Chat.jsx";
import FlowDetail from "./components/FlowDetail.jsx";
import { useToast } from "./hooks/useToast.js";
import sierraLogo from "./assets/logosierra.png";
import styles from "./App.module.css";

const HISTORY_KEY = "orbit-history";
const MAX_HISTORY = 5;
const DARK_KEY    = "orbit-dark";

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
  const [files,         setFiles]         = useState([]);
  const [steps,         setSteps]         = useState([]);
  const [showHelp,      setShowHelp]      = useState(false);
  const [showHistory,   setShowHistory]   = useState(false);

  const [prompt,        setPrompt]        = useState("");
  const [instructions,  setInstructions]  = useState("");
  const [summary,       setSummary]       = useState("");
  const [activeTab,     setActiveTab]     = useState("prompt");

  const [timestamps, setTimestamps] = useState({ prompt: null, instructions: null, summary: null });
  const [feedback,   setFeedback]   = useState({ prompt: null, instructions: null, summary: null });

  const [warning,      setWarning]      = useState("");
  const [loading,      setLoading]      = useState(false);
  const [loadingMode,  setLoadingMode]  = useState(null);
  const [error,        setError]        = useState("");
  const abortRef = useRef(null);

  const [discoveredFlows,   setDiscoveredFlows]   = useState([]);
  const [selectedFlowIds,   setSelectedFlowIds]   = useState(new Set());
  const [multiPrompts,      setMultiPrompts]      = useState({});
  const [discoverLoading,   setDiscoverLoading]   = useState(false);
  const [generatingFlowId,  setGeneratingFlowId]  = useState(null);
  const [multiLoading,      setMultiLoading]      = useState(false);

  const [chatSessionId,       setChatSessionId]       = useState(null);
  const [showFeedback,        setShowFeedback]        = useState(false);
  const [selectedFlowDetail,  setSelectedFlowDetail]  = useState(null);
  const [chatOpen,            setChatOpen]            = useState(false);
  const [chatFlow,            setChatFlow]            = useState(null);

  const [history, setHistory] = useState(loadHistory);
  const [dark,    setDark]    = useState(() => localStorage.getItem(DARK_KEY) !== "false");

  const { toasts, toast, remove: removeToast } = useToast();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem(DARK_KEY, dark);
  }, [dark]);

  useEffect(() => { setChatSessionId(null); }, [files]);

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

    setLoading(true); setError(""); setSteps([]); setWarning(""); setter("");

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
      let buffer = "", finalResult = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.status === "step")      { upsertStep(event.key, "active", event.message); if (event.key === "retry") setter(""); }
          else if (event.status === "step_done") { upsertStep(event.key, "done", event.message); }
          else if (event.status === "chunk") { setter((prev) => { finalResult = prev + event.text; return finalResult; }); }
          else if (event.status === "error") { setError(event.message); setLoading(false); setLoadingMode(null); setSteps((p) => p.map((s) => s.state === "active" ? { ...s, state: "error" } : s)); controller.abort(); return; }
          else if (event.status === "done") {
            finalResult = event.prompt || finalResult;
            setter(finalResult); setWarning(event.warning || ""); setLoading(false); setLoadingMode(null);
            const ts = now();
            setTimestamps((prev) => ({ ...prev, [mode]: ts }));
            if (finalResult) {
              setHistory((prev) => saveHistory({ mode, ts, files: files.map((f) => f.name), preview: finalResult.slice(0, 160), content: finalResult }, prev));
            }
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      setError(err.message);
    } finally {
      setLoading(false); setLoadingMode(null); abortRef.current = null;
    }
  }

  async function handleGenerate() {
    if (files.length === 0) return;
    setActiveTab("prompt"); setLoadingMode("prompt");
    await streamFrom("/api/generate-prompt", "prompt", setPrompt);
  }
  async function handleInstructions() {
    if (files.length === 0) return;
    setActiveTab("instructions"); setLoadingMode("instructions");
    await streamFrom("/api/generate-instructions", "instructions", setInstructions);
  }
  async function handleSummary() {
    if (files.length === 0) return;
    setActiveTab("summary"); setLoadingMode("summary");
    await streamFrom("/api/summarize", "summary", setSummary);
  }

  async function handleDiscover() {
    if (files.length === 0) return;
    setDiscoverLoading(true); setDiscoveredFlows([]); setSelectedFlowIds(new Set()); setMultiPrompts({}); setError(""); setSteps([]); setActiveTab("discover");
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    try {
      const res = await fetch("/api/discover-flows", { method: "POST", body: form });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || `HTTP ${res.status}`); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.status === "step")      upsertStep(event.key, "active", event.message);
          else if (event.status === "step_done") upsertStep(event.key, "done", event.message);
          else if (event.status === "error") { setError(event.message); return; }
          else if (event.status === "done") {
            setDiscoveredFlows(event.flows || []);
            setSelectedFlowIds(new Set((event.flows || []).map((f) => f.id)));
            setActiveTab("discover");
          }
        }
      }
    } catch (err) { setError(err.message); }
    finally { setDiscoverLoading(false); }
  }

  async function handleGenerateSelected() {
    const selected = discoveredFlows.filter((f) => selectedFlowIds.has(f.id));
    if (selected.length === 0) return;
    setMultiLoading(true); setActiveTab("multiflow"); setError("");

    for (const flow of selected) {
      setGeneratingFlowId(flow.id);
      setMultiPrompts((prev) => ({ ...prev, [flow.id]: "" }));
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      form.append("flow_json", JSON.stringify(flow));
      try {
        const res = await fetch("/api/generate-flow-prompt", { method: "POST", body: form });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || `HTTP ${res.status}`); }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", flowResult = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n"); buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6));
            if (event.status === "chunk") { flowResult += event.text; setMultiPrompts((prev) => ({ ...prev, [flow.id]: flowResult })); }
            else if (event.status === "done") { flowResult = event.prompt || flowResult; setMultiPrompts((prev) => ({ ...prev, [flow.id]: flowResult })); }
            else if (event.status === "error") setError(event.message);
          }
        }
      } catch (err) { if (err.name !== "AbortError") setError(err.message); }
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
    setChatSessionId(null); setSelectedFlowDetail(null);
  }

  function handleFeedback(tab, value) {
    setFeedback((prev) => ({ ...prev, [tab]: value }));
    toast(value === "up" ? "Thanks for the positive feedback!" : "Thanks — we'll use this to improve.", "info");
  }

  function restoreFromHistory(entry) {
    if (entry.mode === "prompt")       { setPrompt(entry.content);       setActiveTab("prompt"); }
    if (entry.mode === "instructions") { setInstructions(entry.content); setActiveTab("instructions"); }
    if (entry.mode === "summary")      { setSummary(entry.content);      setActiveTab("summary"); }
    setTimestamps((prev) => ({ ...prev, [entry.mode]: entry.ts }));
    setShowHistory(false);
    toast("Restored from history", "info");
  }

  const hasOutput     = prompt || instructions || summary || Object.keys(multiPrompts).length > 0 || multiLoading || discoverLoading || discoveredFlows.length > 0 || files.length > 0;
  const isGenerating  = loading && loadingMode === "prompt";
  const isInstructing = loading && loadingMode === "instructions";
  const isSummarising = loading && loadingMode === "summary";

  const outputTabs = [
    { key: "prompt",       label: "Prompt",       content: prompt,       ts: timestamps.prompt },
    { key: "instructions", label: "Instructions", content: instructions, ts: timestamps.instructions },
    { key: "summary",      label: "Summary",      content: summary,      ts: timestamps.summary },
    ...(discoveredFlows.length > 0 || discoverLoading
      ? [{ key: "discover", label: `Discover${discoveredFlows.length > 0 ? ` (${discoveredFlows.length})` : ""}`, content: discoveredFlows.length > 0 ? "has" : "", ts: null }]
      : []),
    ...(Object.keys(multiPrompts).length > 0 || multiLoading
      ? [{ key: "multiflow", label: `Multi-Flow${Object.keys(multiPrompts).length > 0 ? ` (${Object.keys(multiPrompts).length})` : ""}`, content: "has", ts: null }]
      : []),
  ];

  const retryHandlers = { prompt: handleGenerate, instructions: handleInstructions, summary: handleSummary };
  const spinningMap   = { prompt: isGenerating,   instructions: isInstructing,       summary: isSummarising };

  return (
    <div className={styles.shell}>
      <Toast toasts={toasts} remove={removeToast} />
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {/* ── Feedback modal ── */}
      {showFeedback && (
        <div className={styles.feedbackOverlay} onClick={() => setShowFeedback(false)}>
          <div className={styles.feedbackModal} onClick={e => e.stopPropagation()}>
            <div className={styles.feedbackModalHeader}>
              <span className={styles.feedbackModalTitle}><Star size={14} /> Share Your Feedback</span>
              <button className={styles.feedbackModalClose} onClick={() => setShowFeedback(false)}><X size={16} /></button>
            </div>
            <div className={styles.feedbackModalBody}>
              <iframe
                title="Feedback Form"
                width="640"
                height="480"
                src="https://forms.office.com/Pages/ResponsePage.aspx?id=H9ClqaHkR0yrua6lD1K4SWE6YV2elzdDh6vx5d7OajFUQVFBT004SjlBVUJBUTI1MVBFWDcwRDRYUy4u&embed=true"
                frameBorder="0"
                marginWidth="0"
                marginHeight="0"
                style={{ border: "none", display: "block", width: "100%", height: "480px" }}
                allowFullScreen
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Top bar ── */}
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <img src={sierraLogo} alt="Sierra Digital" className={styles.sierraLogo} />
          <div className={styles.brandSep} />
          <div className={styles.brandBlock}>
            <span className={styles.brandName}>Orbit</span>
            <span className={styles.brandSub}>Prompt Generator</span>
          </div>
        </div>
        <div className={styles.topbarRight}>
          {history.length > 0 && (
            <button className={styles.historyBtn} onClick={() => setShowHistory((v) => !v)}>
              <History size={13} /> History {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
          {files.length > 0 && (
            <button
              className={`${styles.chatToggleBtn} ${chatOpen ? styles.chatToggleBtnActive : ""}`}
              onClick={() => { setChatOpen(v => !v); if (!chatOpen) setChatFlow(null); }}
              title="Toggle chat"
            >
              <MessageSquare size={13} />
              Chat
              {chatSessionId && <span className={styles.chatActiveDot} />}
            </button>
          )}
          <button className={styles.iconBtn} onClick={() => setDark((d) => !d)} title="Toggle theme">
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className={styles.iconBtn} onClick={() => setShowHelp(true)} title="Help">
            <HelpCircle size={15} />
          </button>
        </div>
      </header>

      {/* ── Workspace ── */}
      <div className={styles.workspace}>

        {/* ── Sidebar ── */}
        <aside className={styles.sidebar}>
          {/* Upload */}
          <div className={styles.sideSection}>
            <div className={styles.sideSectionLabel}>Documents</div>
            <FileUpload files={files} onChange={setFiles} disabled={loading} />
          </div>

          {/* Actions */}
          <div className={styles.sideSection}>
            <div className={styles.sideSectionLabel}>Generate</div>
            <div className={styles.actionsList}>
              <button
                className={`${styles.actionBtn} ${isGenerating ? styles.actionBtnActive : styles.actionBtnPrimary}`}
                onClick={handleGenerate}
                disabled={files.length === 0 || loading}
              >
                <span className={styles.actionIcon}><Zap size={14} /></span>
                <span className={styles.actionLabel}>
                  Generate Prompt
                  {isGenerating && <span className={styles.actionSub}>Generating…</span>}
                </span>
                {isGenerating && <span className={styles.spinner} />}
              </button>

              <button
                className={`${styles.actionBtn} ${isInstructing ? styles.actionBtnActive : ""}`}
                onClick={handleInstructions}
                disabled={files.length === 0 || loading}
              >
                <span className={styles.actionIcon}><ClipboardList size={14} /></span>
                <span className={styles.actionLabel}>
                  Manual Instructions
                  {isInstructing && <span className={styles.actionSub}>Building guide…</span>}
                </span>
                {isInstructing && <span className={styles.spinner} />}
              </button>

              <button
                className={`${styles.actionBtn} ${isSummarising ? styles.actionBtnActive : ""}`}
                onClick={handleSummary}
                disabled={files.length === 0 || loading}
              >
                <span className={styles.actionIcon}><FileText size={14} /></span>
                <span className={styles.actionLabel}>
                  Summarize
                  {isSummarising && <span className={styles.actionSub}>Summarising…</span>}
                </span>
                {isSummarising && <span className={styles.spinner} />}
              </button>

              <button
                className={`${styles.actionBtn} ${discoverLoading ? styles.actionBtnActive : ""}`}
                onClick={handleDiscover}
                disabled={files.length === 0 || loading || discoverLoading}
              >
                <span className={styles.actionIcon}><Search size={14} /></span>
                <span className={styles.actionLabel}>
                  Discover Flows
                  {discoverLoading && <span className={styles.actionSub}>Discovering…</span>}
                </span>
                {discoverLoading && <span className={styles.spinner} />}
              </button>
            </div>

            {(files.length > 0 || hasOutput) && (
              <button className={styles.resetBtn} onClick={handleReset} disabled={loading && !abortRef.current}>
                {loading ? <><X size={12} /> Cancel</> : <><RotateCcw size={12} /> Reset</>}
              </button>
            )}
          </div>

          {/* Sidebar status: error + progress */}
          {error && <div className={styles.sideError}>{error}</div>}
          {steps.length > 0 && (
            <div className={styles.sideStatus}>
              <ProgressSteps steps={steps} />
            </div>
          )}

          {/* Feedback — pinned to sidebar bottom */}
          <div className={styles.sideFooter}>
            <button className={styles.feedbackSideBtn} onClick={() => setShowFeedback(true)}>
              <Star size={13} /> Give Feedback
            </button>
          </div>

        </aside>

        {/* ── Main panel ── */}
        <div className={styles.panel}>

          {/* History */}
          {showHistory && history.length > 0 && (
            <div className={styles.historyPanel}>
              <div className={styles.historyHeader}>
                <span className={styles.historyTitle}>Session History</span>
                <button className={styles.clearBtn} onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]); setShowHistory(false); }}>
                  Clear
                </button>
              </div>
              <div className={styles.historyList}>
                {history.map((h, i) => (
                  <div key={i} className={styles.historyItem} onClick={() => restoreFromHistory(h)}>
                    <div className={styles.historyMeta}>
                      <span className={`${styles.historyMode} ${styles[`mode_${h.mode}`]}`}>{h.mode}</span>
                      <span className={styles.historyTs}>{h.ts}</span>
                    </div>
                    <div className={styles.historyFiles}>{h.files.join(", ")}</div>
                    <p className={styles.historyPreview}>{h.preview}…</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasOutput ? (
            <>
              {/* Tabs bar */}
              <div className={styles.tabsBar}>
                {outputTabs.map(({ key, label, ts, content }) => (
                  <button
                    key={key}
                    className={`${styles.tab} ${activeTab === key ? styles.activeTab : ""}`}
                    onClick={() => setActiveTab(key)}
                  >
                    {label}
                    {content && <span className={styles.tabDot} />}
                    {ts && <span className={styles.tabTs}>{ts}</span>}
                  </button>
                ))}
              </div>

              {/* Tab action bar — only for output tabs, not chat/multiflow */}
              {activeTab !== "chat" && activeTab !== "multiflow" && retryHandlers[activeTab] && (
                <div className={styles.tabActionsBar}>
                  <div className={styles.tabActionLeft}>
                    <button
                      className={styles.btnRetry}
                      disabled={loading}
                      onClick={() => {
                        const hasContent = { prompt, instructions, summary };
                        if (hasContent[activeTab] && !window.confirm("Replace the current output?")) return;
                        retryHandlers[activeTab]();
                      }}
                    >
                      {spinningMap[activeTab]
                        ? <><span className={styles.spinner} /> Regenerating…</>
                        : <><RotateCcw size={13} /> Retry</>}
                    </button>
                  </div>
                  <div className={styles.feedbackRow}>
                    <button
                      className={`${styles.feedbackBtn} ${feedback[activeTab] === "up" ? styles.feedbackActive : ""}`}
                      onClick={() => handleFeedback(activeTab, "up")}
                    ><ThumbsUp size={13} /></button>
                    <button
                      className={`${styles.feedbackBtn} ${feedback[activeTab] === "down" ? styles.feedbackActive : ""}`}
                      onClick={() => handleFeedback(activeTab, "down")}
                    ><ThumbsDown size={13} /></button>
                  </div>
                </div>
              )}

              {/* Disclaimer */}
              {activeTab !== "chat" && (
                <div className={styles.disclaimer}>
                  <span className={styles.disclaimerIcon}>i</span>
                  Content is generated from your uploaded documents. Always review before use.
                </div>
              )}

              {/* Content */}
              <div className={styles.content}>
                {activeTab === "prompt" && (prompt
                  ? <>
                      {warning && <div className={styles.warningBanner}><strong>Review needed:</strong> {warning}</div>}
                      <PromptOutput prompt={prompt} loading={isGenerating} toast={toast} />
                    </>
                  : <EmptyTab icon={<Zap size={30} />} title="No prompt yet"
                      hint="Click Generate Prompt to create a ready-to-use SAP CPI iFlow configuration prompt."
                      onAction={handleGenerate} actionLabel="Generate Prompt" disabled={files.length === 0 || loading} />
                )}

                {activeTab === "instructions" && (instructions
                  ? <InstructionsOutput instructions={instructions} loading={isInstructing} toast={toast} />
                  : <EmptyTab icon={<ClipboardList size={30} />} title="No instructions yet"
                      hint="Click Manual Instructions for a step-by-step guide with Groovy scripts and Postman tests."
                      onAction={handleInstructions} actionLabel="Generate Instructions" disabled={files.length === 0 || loading} />
                )}

                {activeTab === "summary" && (summary
                  ? <InstructionsOutput instructions={summary} loading={isSummarising} label="iFlow Summary" exportFilename="iflow-summary" toast={toast} />
                  : <EmptyTab icon={<FileText size={30} />} title="No summary yet"
                      hint="Click Summarize for a concise overview — purpose, topology, adapters, and key config."
                      onAction={handleSummary} actionLabel="Summarize" disabled={files.length === 0 || loading} />
                )}

                {activeTab === "discover" && (
                  selectedFlowDetail ? (
                    <FlowDetail
                      flow={selectedFlowDetail}
                      files={files}
                      onBack={() => { setSelectedFlowDetail(null); setChatFlow(null); }}
                      toast={toast}
                      onOpenChat={(flow) => { setChatFlow(flow); setChatOpen(true); }}
                    />
                  ) : discoveredFlows.length > 0 ? (
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
                      onViewDetail={(flow) => setSelectedFlowDetail(flow)}
                      generatingFlowId={generatingFlowId}
                      loading={multiLoading}
                    />
                  ) : (
                    <EmptyTab icon={<Search size={30} />} title={discoverLoading ? "Discovering flows…" : "No flows discovered"}
                      hint={discoverLoading ? "Analysing your documents for integration flows." : "Click Discover Flows to extract iFlow definitions from your documents."}
                      onAction={discoverLoading ? undefined : handleDiscover}
                      actionLabel="Discover Flows"
                      disabled={files.length === 0 || discoverLoading} />
                  )
                )}

                {activeTab === "multiflow" && (
                  <MultiPromptOutput
                    flows={discoveredFlows}
                    prompts={multiPrompts}
                    generatingFlowId={generatingFlowId}
                    loading={multiLoading}
                    toast={toast}
                  />
                )}

              </div>
            </>
          ) : (
            <div className={styles.welcome}>
              <div className={styles.welcomeRing} />
              <div className={styles.welcomeTitle}>Orbit Prompt Generator</div>
              <p className={styles.welcomeHint}>
                Upload your integration documents on the left, then generate a CPI iFlow prompt,
                manual guide, summary — or chat directly with your documents.
              </p>
            </div>
          )}
        </div>

        {/* ── Chat drawer ── */}
        <div className={`${styles.chatDrawer} ${chatOpen ? styles.chatDrawerOpen : ""}`}>
          <div className={styles.drawerHeader}>
            <div className={styles.drawerTitle}>
              <MessageSquare size={13} />
              {chatFlow ? chatFlow.name : "Document Chat"}
            </div>
            {chatFlow && (
              <button className={styles.drawerClearFlow} onClick={() => setChatFlow(null)} title="Clear flow context">
                ✕ flow
              </button>
            )}
            <button className={styles.drawerCloseBtn} onClick={() => setChatOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <div className={styles.drawerBody}>
            <Chat
              files={files}
              sessionId={chatSessionId}
              onSessionReady={(id) => setChatSessionId(id)}
              toast={toast}
              flowContext={chatFlow}
            />
          </div>
        </div>

      </div>
    </div>
  );
}
