import { useEffect, useRef, useState, useCallback } from "react";
import styles from "./Chat.module.css";

export default function Chat({ files, sessionId, onSessionReady, toast }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexedFiles, setIndexedFiles] = useState([]);
  const [error, setError] = useState("");
  const bottomRef = useRef(null);
  const indexingRef = useRef(false);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleIndex = useCallback(async () => {
    if (files.length === 0 || indexingRef.current) return;
    indexingRef.current = true;
    setIndexing(true);
    setError("");
    setMessages([]);

    const form = new FormData();
    files.forEach((f) => form.append("files", f));

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
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.status === "done") {
            onSessionReady(event.session_id);
            setIndexedFiles(event.files || []);
            toast?.("Documents indexed — ready to chat!", "success");
          } else if (event.status === "error") {
            setError(event.message);
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIndexing(false);
      indexingRef.current = false;
    }
  }, [files, onSessionReady, toast]);

  // Auto-index when files change and sessionId is cleared
  useEffect(() => {
    if (files.length > 0 && !sessionId && !indexingRef.current) {
      handleIndex();
    }
  }, [files, sessionId, handleIndex]);

  async function handleSend() {
    if (!input.trim() || !sessionId || sending) return;

    const userMsg = { role: "user", content: input.trim() };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setSending(true);
    setError("");

    // Add placeholder assistant message for streaming
    setMessages([...history, { role: "assistant", content: "", sources: [], streaming: true }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          messages: messages.filter((m) => !m.streaming).map(({ role, content }) => ({ role, content })),
          message: userMsg.content,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let sources = [];

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
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = { role: "assistant", content: assistantText, sources, streaming: true };
              return next;
            });
          } else if (event.status === "done") {
            sources = event.sources || [];
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = { role: "assistant", content: assistantText, sources, streaming: false };
              return next;
            });
          } else if (event.status === "error") {
            setError(event.message);
            setMessages((prev) => prev.slice(0, -1));
          }
        }
      }
    } catch (err) {
      setError(err.message);
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const isReady = !!sessionId && !indexing;

  return (
    <div className={styles.container}>
      {/* Status bar */}
      <div className={styles.statusBar}>
        {indexing ? (
          <span className={styles.statusIndexing}><span className={styles.spinner} /> Indexing documents…</span>
        ) : sessionId ? (
          <span className={styles.statusReady}>
            <span className={styles.readyDot} /> {indexedFiles.length} document{indexedFiles.length !== 1 ? "s" : ""} indexed
            <button className={styles.reindexBtn} onClick={handleIndex} title="Re-index documents">&#8635;</button>
          </span>
        ) : (
          <span className={styles.statusEmpty}>No documents indexed yet</span>
        )}
      </div>

      {/* Messages */}
      <div className={styles.messages}>
        {messages.length === 0 && isReady && (
          <div className={styles.emptyChat}>
            <p className={styles.emptyChatTitle}>Ask anything about your documents</p>
            <p className={styles.emptyChatHint}>e.g. "What APIs are used in this integration?" or "Which flows need CSRF handling?"</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`${styles.msg} ${msg.role === "user" ? styles.msgUser : styles.msgAssistant}`}>
            <div className={styles.bubble}>
              {msg.content}
              {msg.role === "assistant" && msg.streaming && <span className={styles.cursor}>&#9611;</span>}
            </div>
            {msg.role === "assistant" && msg.sources?.length > 0 && (
              <div className={styles.sources}>
                {msg.sources.map((s, j) => (
                  <span key={j} className={styles.sourceChip}>{s}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {error && <div className={styles.chatError}>{error}</div>}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          placeholder={isReady ? "Ask a question about your documents…" : "Waiting for documents to be indexed…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isReady || sending}
          rows={2}
        />
        <button
          className={styles.sendBtn}
          onClick={handleSend}
          disabled={!isReady || !input.trim() || sending}
        >
          {sending ? <span className={styles.spinner} /> : "Send"}
        </button>
      </div>
    </div>
  );
}
