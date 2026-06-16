import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Zap, ClipboardList, FileText, MessageSquare, RotateCcw, ArrowRight, Send, Check, PanelLeftOpen, PanelLeftClose } from "lucide-react";
import PromptOutput from "./PromptOutput.jsx";
import InstructionsOutput from "./InstructionsOutput.jsx";
import { badgeStyle } from "./dirBadge.js";
import { makeRenderBubble } from "../utils/renderMarkdown.jsx";
import styles from "./FlowDetail.module.css";

const renderBubble = makeRenderBubble(styles);

const GEN_MODES = [
  { key: "prompt",       label: "Prompt",       Icon: Zap,           endpoint: "/api/generate-flow-prompt" },
  { key: "instructions", label: "Instructions", Icon: ClipboardList, endpoint: "/api/generate-flow-instructions" },
  { key: "summary",      label: "Summary",      Icon: FileText,      endpoint: "/api/generate-flow-summary" },
];

export default function FlowDetail({ flow, files, onBack, toast, sessionId, onSessionReady }) {
  const [activeMode,    setActiveMode]    = useState("prompt");
  const [outputs,       setOutputs]       = useState({ prompt: "", instructions: "", summary: "" });
  const [loading,       setLoading]       = useState(false);
  const [loadingMode,   setLoadingMode]   = useState(null);
  const [error,         setError]         = useState("");
  const [leftCollapsed, setLeftCollapsed] = useState(true);

  const [chatMessages,  setChatMessages]  = useState([]);
  const [chatInput,     setChatInput]     = useState("");
  const [chatSending,   setChatSending]   = useState(false);
  const [chatIndexing,  setChatIndexing]  = useState(false);
  const [chatIndexStep, setChatIndexStep] = useState("");
  const [chatError,     setChatError]     = useState("");
  const chatBottomRef = useRef(null);
  const indexingRef   = useRef(false);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Auto-index on mount (chat panel is always visible)
  const handleIndex = useCallback(async () => {
    if (files.length === 0 || indexingRef.current) return;
    indexingRef.current = true;
    setChatIndexing(true);
    setChatIndexStep("Indexing documents…");
    setChatError("");

    const form = new FormData();
    files.forEach(f => form.append("files", f));

    try {
      const res = await fetch("/api/index", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
          if (event.status === "step")           setChatIndexStep(event.message);
          else if (event.status === "step_done") setChatIndexStep(event.message);
          else if (event.status === "done") {
            onSessionReady?.(event.session_id);
            setChatIndexStep("");
          } else if (event.status === "error") {
            setChatError(event.message);
          }
        }
      }
    } catch (err) {
      setChatError(err.message);
    } finally {
      setChatIndexing(false);
      indexingRef.current = false;
    }
  }, [files, onSessionReady]);

  useEffect(() => {
    if (!sessionId && !indexingRef.current && files.length > 0) handleIndex();
  }, [sessionId, handleIndex, files.length]);

  // ── Generation ───────────────────────────────────────────────────────────

  async function generate(mode) {
    if (loading) return;
    setLeftCollapsed(false); // auto-expand on generate
    setLoading(true); setLoadingMode(mode); setActiveMode(mode);
    setError(""); setOutputs(prev => ({ ...prev, [mode]: "" }));

    const { endpoint } = GEN_MODES.find(m => m.key === mode);
    const form = new FormData();
    files.forEach(f => form.append("files", f));
    form.append("flow_json", JSON.stringify(flow));

    try {
      const res = await fetch(endpoint, { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
          if (event.status === "chunk") setOutputs(prev => ({ ...prev, [mode]: prev[mode] + event.text }));
          else if (event.status === "done") {
            if (event.prompt) setOutputs(prev => ({ ...prev, [mode]: event.prompt }));
            toast?.(`${GEN_MODES.find(m => m.key === mode).label} ready!`, "success");
          } else if (event.status === "error") setError(event.message);
        }
      }
    } catch (err) { setError(err.message); }
    finally { setLoading(false); setLoadingMode(null); }
  }

  // ── Chat ─────────────────────────────────────────────────────────────────

  async function handleChatSend() {
    if (!chatInput.trim() || !sessionId || chatSending) return;
    const displayText = chatInput.trim();
    const apiMessage  = `[Regarding iFlow: "${flow.name}" | ${flow.direction} | ${flow.source_system || flow.source_entity} → ${flow.target_api || flow.target_system}]\n\n${displayText}`;

    const history = [...chatMessages, { role: "user", content: displayText }];
    setChatMessages([...history, { role: "assistant", content: "", streaming: true }]);
    setChatInput(""); setChatSending(true); setChatError("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          messages: chatMessages.filter(m => !m.streaming).map(({ role, content }) => ({ role, content })),
          message: apiMessage,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", assistantText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.status === "chunk") {
            assistantText += event.text;
            setChatMessages(prev => { const n=[...prev]; n[n.length-1]={role:"assistant",content:assistantText,streaming:true}; return n; });
          } else if (event.status === "done") {
            setChatMessages(prev => { const n=[...prev]; n[n.length-1]={role:"assistant",content:assistantText,streaming:false}; return n; });
          } else if (event.status === "error") {
            setChatError(event.message);
            setChatMessages(prev => prev.slice(0, -1));
          }
        }
      }
    } catch (err) {
      setChatError(err.message);
      setChatMessages(prev => prev.slice(0, -1));
    } finally { setChatSending(false); }
  }

  function handleChatKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSend(); }
  }

  const currentMode   = GEN_MODES.find(m => m.key === activeMode) ?? GEN_MODES[0];
  const currentOutput = outputs[activeMode] ?? "";
  const isGenerating  = loading && loadingMode === activeMode;
  const chatReady     = !!sessionId && !chatIndexing;

  return (
    <div className={styles.container}>

      {/* ── Full-width header ── */}
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onBack}>
          <ArrowLeft size={13} /> Back to flows
        </button>
        <div className={styles.flowHeader}>
          <span className={styles.flowName}>{flow.name}</span>
          <span className={styles.dirBadge} style={badgeStyle(flow.direction)}>{flow.direction}</span>
        </div>
        <div className={styles.flowMeta}>
          <div className={styles.flowSystems}>
            <span className={styles.sysChip}>{flow.source_system || flow.source_entity}</span>
            <ArrowRight size={11} className={styles.sysArrow} />
            <span className={styles.sysChip}>{flow.target_api || flow.target_system}</span>
          </div>
          {flow.description && <p className={styles.flowDesc}>{flow.description}</p>}
        </div>
      </div>

      {/* ── Split body: left = generation, right = chat ── */}
      <div className={styles.splitBody}>

        {/* ── LEFT: generation tabs + output ── */}
        <div className={`${styles.leftPane} ${leftCollapsed ? styles.leftPaneCollapsed : ""}`}>
          <div className={styles.toolbar}>
            <div className={styles.modeTabs}>
              {GEN_MODES.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  className={`${styles.modeTab} ${activeMode === key ? styles.modeTabActive : ""}`}
                  onClick={() => setActiveMode(key)}
                >
                  <Icon size={12} /> {label}
                  {outputs[key] && <span className={styles.tabDot} />}
                </button>
              ))}
            </div>
            <button
              className={`${styles.generateBtn} ${isGenerating ? styles.generateBtnBusy : ""}`}
              onClick={() => generate(activeMode)}
              disabled={loading}
            >
              {isGenerating
                ? <><span className={styles.spinner} /> Generating…</>
                : <><RotateCcw size={12} /> {currentOutput ? "Regenerate" : `Generate ${currentMode.label}`}</>}
            </button>
          </div>

          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.output}>
            {currentOutput ? (
              activeMode === "prompt"
                ? <PromptOutput prompt={currentOutput} loading={isGenerating} toast={toast} />
                : <InstructionsOutput
                    instructions={currentOutput}
                    loading={isGenerating}
                    label={activeMode === "summary" ? "iFlow Summary" : "Manual Instructions"}
                    exportFilename={`${flow.name}-${activeMode}`}
                    toast={toast}
                  />
            ) : (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}><currentMode.Icon size={28} strokeWidth={1.4} /></div>
                <p className={styles.emptyTitle}>
                  {isGenerating ? `Generating ${currentMode.label}…` : `No ${currentMode.label.toLowerCase()} yet`}
                </p>
                {!isGenerating && (
                  <p className={styles.emptyHint}>
                    Click <strong>Generate {currentMode.label}</strong> to create it for <strong>{flow.name}</strong>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: persistent chat panel ── */}
        <div className={styles.rightPane}>
          <div className={styles.chatHeader}>
            <button
              className={styles.panelToggleBtn}
              onClick={() => setLeftCollapsed(v => !v)}
              title={leftCollapsed ? "Show generation panel" : "Hide generation panel"}
            >
              {leftCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
            </button>
            <MessageSquare size={13} />
            <span>Chat about this flow</span>
            {chatReady && <span className={styles.chatReadyDot} />}
          </div>

          <div className={styles.chatStatus}>
            {chatIndexing ? (
              <span className={styles.chatStatusIndexing}><span className={styles.spinner} /> {chatIndexStep || "Indexing…"}</span>
            ) : sessionId ? (
              <span className={styles.chatStatusReady}><Check size={10} strokeWidth={2.5} /> Ready</span>
            ) : (
              <span className={styles.chatStatusEmpty}>Preparing…</span>
            )}
          </div>

          <div className={styles.chatMessages}>
            {chatMessages.length === 0 && chatReady && (
              <div className={styles.chatEmpty}>
                <MessageSquare size={22} strokeWidth={1.4} className={styles.chatEmptyIcon} />
                <p className={styles.chatEmptyTitle}>Ask anything about this iFlow</p>
                <p className={styles.chatEmptyHint}>e.g. "What adapter is used?" or "Explain the mapping logic"</p>
              </div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`${styles.chatMsg} ${msg.role === "user" ? styles.chatMsgUser : styles.chatMsgAssistant}`}>
                <div className={styles.chatBubble}>
                  {msg.role === "user" ? msg.content : renderBubble(msg.content, msg.streaming)}
                </div>
              </div>
            ))}
            {chatError && <div className={styles.chatErrorMsg}>{chatError}</div>}
            <div ref={chatBottomRef} />
          </div>

          <div className={styles.chatInputRow}>
            <textarea
              className={styles.chatInput}
              placeholder={chatReady ? `Ask about ${flow.name}…` : "Indexing documents…"}
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={handleChatKey}
              disabled={!chatReady || chatSending}
              rows={2}
            />
            <button
              className={styles.chatSendBtn}
              onClick={handleChatSend}
              disabled={!chatReady || !chatInput.trim() || chatSending}
            >
              {chatSending ? <span className={styles.spinner} /> : <Send size={14} />}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
