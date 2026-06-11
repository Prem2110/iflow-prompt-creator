import { useRef, useState } from "react";
import FileUpload from "./components/FileUpload.jsx";
import PromptOutput from "./components/PromptOutput.jsx";
import InstructionsOutput from "./components/InstructionsOutput.jsx";
import ProgressSteps from "./components/ProgressSteps.jsx";
import HelpModal from "./components/HelpModal.jsx";
import sierraLogo from "./assets/logosierra.png";
import styles from "./App.module.css";

export default function App() {
  const [files, setFiles] = useState([]);
  const [steps, setSteps] = useState([]);
  const [showHelp, setShowHelp] = useState(false);

  const [prompt, setPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [summary, setSummary] = useState("");
  const [activeTab, setActiveTab] = useState("prompt");

  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState(null); // "prompt" | "instructions" | "summary"
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  function upsertStep(key, state, message) {
    setSteps((prev) => {
      const exists = prev.find((s) => s.key === key);
      if (exists) return prev.map((s) => (s.key === key ? { ...s, state, message } : s));
      return [...prev, { key, state, message }];
    });
  }

  async function streamFrom(endpoint, onDone) {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError("");
    setSteps([]);
    setWarning("");

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
            if (event.key === "retry") onDone(""); // clear on retry
          } else if (event.status === "step_done") {
            upsertStep(event.key, "done", event.message);
          } else if (event.status === "chunk") {
            onDone((prev) => prev + event.text);
          } else if (event.status === "error") {
            setError(event.message);
            setLoading(false);
            setLoadingMode(null);
            setSteps((prev) => prev.map((s) => (s.state === "active" ? { ...s, state: "error" } : s)));
            controller.abort();
            return;
          } else if (event.status === "done") {
            onDone(event.prompt || "");
            setWarning(event.warning || "");
            setLoading(false);
            setLoadingMode(null);
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
    setPrompt("");
    await streamFrom("/api/generate-prompt", setPrompt);
  }

  async function handleInstructions() {
    if (files.length === 0) return;
    setActiveTab("instructions");
    setLoadingMode("instructions");
    setInstructions("");
    await streamFrom("/api/generate-instructions", setInstructions);
  }

  async function handleSummary() {
    if (files.length === 0) return;
    setActiveTab("summary");
    setLoadingMode("summary");
    setSummary("");
    await streamFrom("/api/summarize", setSummary);
  }

  function handleReset() {
    if (abortRef.current) abortRef.current.abort();
    setFiles([]);
    setSteps([]);
    setPrompt("");
    setInstructions("");
    setSummary("");
    setWarning("");
    setError("");
    setLoading(false);
    setLoadingMode(null);
    setActiveTab("prompt");
  }

  const hasOutput = prompt || instructions || summary;
  const isGenerating = loading && loadingMode === "prompt";
  const isInstructing = loading && loadingMode === "instructions";
  const isSummarising = loading && loadingMode === "summary";

  return (
    <div className={styles.page}>
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
            <span className={styles.badge}>
              <span className={styles.badgeDot} />
              Powered by SAP AI Core · Claude
            </span>
            <button
              className={styles.helpBtn}
              onClick={() => setShowHelp(true)}
              title="How to use this app"
              aria-label="Open help"
            >
              Help
            </button>
          </div>
        </div>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⚡</span>
          <span className={styles.logoText}>Orbit Prompt Generator</span>
        </div>
        <p className={styles.subtitle}>
          Upload documents or screenshots → get a ready-to-use SAP CPI iFlow prompt or manual build guide
        </p>
      </header>

      <main className={styles.main}>
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.stepNum}>1</span>
            Upload Files
          </h2>
          <FileUpload files={files} onChange={setFiles} disabled={loading} />

          <div className={styles.actions}>
            <button
              className={styles.btnPrimary}
              onClick={handleGenerate}
              disabled={files.length === 0 || loading}
              title="Generate a ready-to-use SAP CPI iFlow configuration prompt from your uploaded files"
            >
              {isGenerating
                ? <><span className={styles.spinner} /> Generating…</>
                : "Generate Prompt"}
            </button>
            <button
              className={styles.btnSecondary}
              onClick={handleInstructions}
              disabled={files.length === 0 || loading}
              title="Generate a step-by-step manual build guide with scripts and Postman testing instructions"
            >
              {isInstructing
                ? <><span className={styles.spinner} /> Building guide…</>
                : "Instructions"}
            </button>
            <button
              className={styles.btnTertiary}
              onClick={handleSummary}
              disabled={files.length === 0 || loading}
              title="Get a concise overview of the iFlow — purpose, topology, adapters, and key configuration"
            >
              {isSummarising
                ? <><span className={styles.spinnerTeal} /> Summarising…</>
                : "Summarize"}
            </button>
            {(files.length > 0 || hasOutput) && (
              <button className={styles.btnGhost} onClick={handleReset} disabled={loading && !abortRef.current}>
                {loading ? "Cancel" : "Reset"}
              </button>
            )}
          </div>

          {error && <p className={styles.error} role="alert">{error}</p>}
          {steps.length > 0 && <ProgressSteps steps={steps} />}
        </section>

        {hasOutput && (
          <section className={styles.card}>
            <div className={styles.tabsRow}>
              <div className={styles.tabs}>
                <button
                  className={`${styles.tab} ${activeTab === "prompt" ? styles.activeTab : ""}`}
                  onClick={() => setActiveTab("prompt")}
                >
                  Prompt
                </button>
                <button
                  className={`${styles.tab} ${activeTab === "instructions" ? styles.activeTab : ""}`}
                  onClick={() => setActiveTab("instructions")}
                >
                  Instructions
                </button>
                <button
                  className={`${styles.tab} ${activeTab === "summary" ? styles.activeTab : ""}`}
                  onClick={() => setActiveTab("summary")}
                >
                  Summary
                </button>
              </div>
              <div className={styles.tabActions}>
                {activeTab === "prompt" && (
                  <button className={styles.btnRetry} onClick={handleGenerate} disabled={loading}>
                    {isGenerating ? <><span className={styles.spinner} /> Regenerating…</> : "↺ Retry"}
                  </button>
                )}
                {activeTab === "instructions" && (
                  <button className={styles.btnRetry} onClick={handleInstructions} disabled={loading}>
                    {isInstructing ? <><span className={styles.spinner} /> Regenerating…</> : "↺ Retry"}
                  </button>
                )}
                {activeTab === "summary" && (
                  <button className={styles.btnRetry} onClick={handleSummary} disabled={loading}>
                    {isSummarising ? <><span className={styles.spinner} /> Regenerating…</> : "↺ Retry"}
                  </button>
                )}
              </div>
            </div>

            <div className={styles.disclaimer}>
              <span className={styles.disclaimerIcon}>i</span>
              Content is generated entirely based on the documents you uploaded. Always review before use.
            </div>

            {activeTab === "prompt" && prompt && (
              <>
                {warning && <div className={styles.warning} role="alert"><strong>Review needed:</strong> {warning}</div>}
                <PromptOutput prompt={prompt} loading={isGenerating} />
              </>
            )}
            {activeTab === "prompt" && !prompt && (
              <div className={styles.tabPlaceholder}>
                <p>Click <strong>Generate Prompt</strong> to create the iFlow configuration prompt.</p>
              </div>
            )}

            {activeTab === "instructions" && instructions && (
              <InstructionsOutput instructions={instructions} loading={isInstructing} />
            )}
            {activeTab === "instructions" && !instructions && (
              <div className={styles.tabPlaceholder}>
                <p>Click <strong>Instructions</strong> to generate the step-by-step manual build guide + Postman testing.</p>
              </div>
            )}

            {activeTab === "summary" && summary && (
              <InstructionsOutput instructions={summary} loading={isSummarising} label="iFlow Summary" exportFilename="iflow-summary" />
            )}
            {activeTab === "summary" && !summary && (
              <div className={styles.tabPlaceholder}>
                <p>Click <strong>Summarize</strong> to get a concise overview of the iFlow — purpose, topology, adapters, and key config.</p>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
