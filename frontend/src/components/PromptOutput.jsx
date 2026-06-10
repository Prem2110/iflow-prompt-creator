import { useState } from "react";
import styles from "./PromptOutput.module.css";

export default function PromptOutput({ prompt, loading = false }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.label}>SAP CPI iFlow Prompt</span>
          <span className={styles.charCount}>{prompt.length.toLocaleString()} chars</span>
        </div>
        <button
          className={`${styles.copyBtn} ${copied ? styles.copied : ""}`}
          onClick={handleCopy}
        >
          {copied ? "✓ Copied!" : "Copy"}
        </button>
      </div>
      <pre className={`${styles.output} ${loading ? styles.streaming : ""}`}>{prompt}</pre>
    </div>
  );
}
