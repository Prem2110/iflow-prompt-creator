import { useEffect, useRef, useState, useCallback } from "react";
import { MessageSquare, Send, Check, X, Paperclip, ChevronRight } from "lucide-react";
import { makeRenderBubble } from "../utils/renderMarkdown.jsx";
import styles from "./Chat.module.css";

const renderBubble = makeRenderBubble(styles);

// ── Step indicator ────────────────────────────────────────────────────────────

function StepRow({ step }) {
  return (
    <div className={`${styles.indexStep} ${styles[step.state]}`}>
      {step.state === "active" ? (
        <span className={styles.stepSpinner} />
      ) : step.state === "done" ? (
        <Check size={10} className={styles.stepCheck} strokeWidth={2.5} />
      ) : step.state === "error" ? (
        <X size={10} className={styles.stepX} strokeWidth={2.5} />
      ) : (
        <span className={styles.stepDot} />
      )}
      <span>{step.message}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Chat({ files, sessionId, onSessionReady, toast, flowContext, onAddFiles }) {
  const [messages,     setMessages]     = useState([]);
  const [input,        setInput]        = useState("");
  const [sending,      setSending]      = useState(false);
  const [indexing,     setIndexing]     = useState(false);
  const [indexSteps,   setIndexSteps]   = useState([]);
  const [indexedFiles, setIndexedFiles] = useState([]);
  const [extraFiles,   setExtraFiles]   = useState([]);
  const [error,        setError]        = useState("");
  const [statusOpen,   setStatusOpen]   = useState(false);
  const bottomRef    = useRef(null);
  const indexingRef  = useRef(false);
  const addFileRef   = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (indexing) setStatusOpen(true);
  }, [indexing]);

  function upsertStep(key, state, message) {
    setIndexSteps(prev => {
      const exists = prev.find(s => s.key === key);
      if (exists) return prev.map(s => s.key === key ? { ...s, state, message } : s);
      return [...prev, { key, state, message }];
    });
  }

  const handleIndex = useCallback(async (filesToIndex, keepMessages = false) => {
    if (filesToIndex.length === 0 || indexingRef.current) return;
    indexingRef.current = true;
    setIndexing(true);
    setIndexSteps([]);
    setError("");
    if (!keepMessages) setMessages([]);

    const form = new FormData();
    filesToIndex.forEach(f => form.append("files", f));

    try {
      const res = await fetch("/api/index", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader  = res.body.getReader();
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
          if (event.status === "step")           upsertStep(event.key, "active", event.message);
          else if (event.status === "step_done") upsertStep(event.key, "done", event.message);
          else if (event.status === "done") {
            onSessionReady(event.session_id);
            setIndexedFiles(event.files || []);
            toast?.(keepMessages ? "Context updated with new files!" : "Documents indexed — ready to chat!", "success");
          } else if (event.status === "error") {
            setError(event.message);
            setIndexSteps(prev => prev.map(s => s.state === "active" ? { ...s, state: "error" } : s));
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIndexing(false);
      indexingRef.current = false;
    }
  }, [onSessionReady, toast]);

  useEffect(() => {
    if (files.length > 0 && !sessionId && !indexingRef.current) handleIndex(files, false);
  }, [files, sessionId, handleIndex]);

  async function handleAddFiles(e) {
    const newFiles = Array.from(e.target.files);
    if (!newFiles.length) return;
    e.target.value = "";
    onAddFiles?.(newFiles);
    const merged = [...files, ...extraFiles, ...newFiles];
    setExtraFiles(prev => [...prev, ...newFiles]);
    setMessages(prev => [
      ...prev,
      { role: "system", content: `Added ${newFiles.length} file${newFiles.length > 1 ? "s" : ""}: ${newFiles.map(f => f.name).join(", ")}` },
    ]);
    await handleIndex(merged, true);
  }

  async function handleSend() {
    if (!input.trim() || !sessionId || sending) return;
    const displayText = input.trim();
    const apiText = flowContext
      ? `[Regarding iFlow: "${flowContext.name}" | ${flowContext.direction} | ${flowContext.source_system || flowContext.source_entity} → ${flowContext.target_api || flowContext.target_system}]\n\n${displayText}`
      : displayText;

    const userMsg = { role: "user", content: displayText };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setSending(true);
    setError("");
    setMessages([...history, { role: "assistant", content: "", sources: [], streaming: true }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          messages: messages.filter(m => !m.streaming).map(({ role, content }) => ({ role, content })),
          message: apiText,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", assistantText = "", sources = [];

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
            assistantText += event.text;
            setMessages(prev => {
              const next = [...prev];
              next[next.length - 1] = { role: "assistant", content: assistantText, sources, streaming: true };
              return next;
            });
          } else if (event.status === "done") {
            sources = event.sources || [];
            setMessages(prev => {
              const next = [...prev];
              next[next.length - 1] = { role: "assistant", content: assistantText, sources, streaming: false };
              return next;
            });
          } else if (event.status === "error") {
            setError(event.message);
            setMessages(prev => prev.slice(0, -1));
          }
        }
      }
    } catch (err) {
      setError(err.message);
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  const isReady = !!sessionId && !indexing;

  return (
    <div className={styles.container}>
      {/* Status bar */}
      <div className={styles.statusBar}>
        {/* Ribbon — always visible, click to expand */}
        <div className={styles.statusRibbon} onClick={() => setStatusOpen(v => !v)}>
          <ChevronRight size={10} className={`${styles.ribbonChevron} ${statusOpen ? styles.ribbonChevronOpen : ""}`} />
          {indexing ? (
            <>
              <span className={styles.spinnerSm} />
              <span className={styles.ribbonText}>Indexing…</span>
            </>
          ) : sessionId ? (
            <>
              <span className={styles.readyDotSm} />
              <span className={styles.ribbonText}>{indexedFiles.length} doc{indexedFiles.length !== 1 ? "s" : ""} indexed</span>
            </>
          ) : (
            <span className={styles.ribbonText}>No documents indexed</span>
          )}
          {flowContext && isReady && (
            <span className={styles.ribbonFlowChip}>{flowContext.name}</span>
          )}
        </div>

        {/* Collapsible details */}
        {statusOpen && (
          <div className={styles.statusDetails}>
            <div className={styles.statusBarRow}>
              {indexing ? (
                <span className={styles.statusIndexing}>
                  <span className={styles.spinner} /> Indexing documents…
                </span>
              ) : sessionId ? (
                <span className={styles.statusReady}>
                  <span className={styles.readyDot} />
                  {indexedFiles.length} document{indexedFiles.length !== 1 ? "s" : ""} indexed
                  <label className={styles.addFilesBtn} title="Add more files to context">
                    <Paperclip size={10} /> Add files
                    <input
                      ref={addFileRef}
                      type="file"
                      multiple
                      hidden
                      onChange={handleAddFiles}
                      accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.json,.yaml,.yml,.xml,.wsdl,.png,.jpg,.jpeg"
                    />
                  </label>
                  <button className={styles.reindexBtn} onClick={e => { e.stopPropagation(); handleIndex([...files, ...extraFiles], true); }} title="Re-index documents">&#8635;</button>
                </span>
              ) : (
                <span className={styles.statusEmpty}>No documents indexed yet</span>
              )}
            </div>

            {flowContext && isReady && (
              <div className={styles.statusBarRow}>
                <span className={styles.flowContextChip}>Flow: {flowContext.name}</span>
              </div>
            )}

            {indexSteps.length > 0 && (
              <div className={styles.indexSteps}>
                {indexSteps.map(step => <StepRow key={step.key} step={step} />)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className={styles.messages}>
        {messages.length === 0 && isReady && (
          <div className={styles.emptyChat}>
            <div className={styles.emptyChatIcon}><MessageSquare size={32} strokeWidth={1.5} /></div>
            <p className={styles.emptyChatTitle}>Ask anything about your documents</p>
            <p className={styles.emptyChatHint}>e.g. "What APIs are used in this integration?" or "Which flows need CSRF handling?"</p>
          </div>
        )}
        {messages.map((msg, i) => (
          msg.role === "system" ? (
            <div key={i} className={styles.systemMsg}>
              <Paperclip size={10} /> {msg.content}
            </div>
          ) : (
            <div key={i} className={`${styles.msg} ${msg.role === "user" ? styles.msgUser : styles.msgAssistant}`}>
              <div className={styles.bubble}>
                {msg.role === "user"
                  ? msg.content
                  : renderBubble(msg.content, msg.streaming)}
              </div>
              {msg.role === "assistant" && msg.sources?.length > 0 && (
                <div className={styles.sources}>
                  {msg.sources.map((s, j) => <span key={j} className={styles.sourceChip}>{s}</span>)}
                </div>
              )}
            </div>
          )
        ))}
        {error && <div className={styles.chatError}>{error}</div>}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          placeholder={isReady
            ? flowContext
              ? `Ask about ${flowContext.name}…`
              : "Ask a question about your documents…"
            : "Waiting for documents to be indexed…"}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isReady || sending}
          rows={2}
        />
        <button
          className={styles.sendBtn}
          onClick={handleSend}
          disabled={!isReady || !input.trim() || sending}
        >
          {sending ? <span className={styles.spinner} /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
}
