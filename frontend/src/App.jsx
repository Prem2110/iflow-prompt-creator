import { useState } from "react";
import FileUpload from "./components/FileUpload.jsx";
import PromptOutput from "./components/PromptOutput.jsx";
import ProgressSteps from "./components/ProgressSteps.jsx";
import styles from "./App.module.css";

export default function App() {
  const [files, setFiles] = useState([]);
  const [steps, setSteps] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function upsertStep(key, state, message) {
    setSteps((prev) => {
      const exists = prev.find((s) => s.key === key);
      if (exists) {
        return prev.map((s) => (s.key === key ? { ...s, state, message } : s));
      }
      return [...prev, { key, state, message }];
    });
  }

  async function handleGenerate() {
    if (files.length === 0) return;
    setLoading(true);
    setError("");
    setPrompt("");
    setWarning("");
    setSteps([]);

    const form = new FormData();
    files.forEach((f) => form.append("files", f));

    try {
      const res = await fetch("/api/generate-prompt", { method: "POST", body: form });
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
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));

          if (event.status === "step") {
            upsertStep(event.key, "active", event.message);
          } else if (event.status === "step_done") {
            upsertStep(event.key, "done", event.message);
          } else if (event.status === "error") {
            setError(event.message);
            setLoading(false);
            setSteps((prev) =>
              prev.map((s) => (s.state === "active" ? { ...s, state: "error" } : s))
            );
          } else if (event.status === "done") {
            setPrompt(event.prompt);
            setWarning(event.warning || "");
            setLoading(false);
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setFiles([]);
    setSteps([]);
    setPrompt("");
    setWarning("");
    setError("");
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⚡</span>
          <span>IFS Prompt Generator</span>
        </div>
        <p className={styles.subtitle}>
          Upload documents or screenshots → get a ready-to-use SAP CPI iFlow prompt
        </p>
      </header>

      <main className={styles.main}>
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>1. Upload Files</h2>
          <FileUpload files={files} onChange={setFiles} disabled={loading} />

          <div className={styles.actions}>
            <button
              className={styles.btnPrimary}
              onClick={handleGenerate}
              disabled={files.length === 0 || loading}
            >
              {loading
                ? <><span className={styles.spinner} /> Generating…</>
                : "Generate Prompt"}
            </button>
            {(files.length > 0 || prompt) && !loading && (
              <button className={styles.btnGhost} onClick={handleReset}>
                Reset
              </button>
            )}
          </div>

          {error && <p className={styles.error}>{error}</p>}

          {steps.length > 0 && <ProgressSteps steps={steps} />}
        </section>

        {prompt && (
          <section className={styles.card}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>2. Generated Prompt</h2>
              <button
                className={styles.btnRetry}
                onClick={handleGenerate}
                disabled={loading}
                title="Regenerate prompt from the same files"
              >
                {loading
                  ? <><span className={styles.spinner} /> Regenerating…</>
                  : "↺ Retry"}
              </button>
            </div>
            {warning && (
              <div className={styles.warning}>
                <strong>Review needed:</strong> {warning}
              </div>
            )}
            <PromptOutput prompt={prompt} />
          </section>
        )}
      </main>
    </div>
  );
}
