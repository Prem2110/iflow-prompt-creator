import { useState } from "react";
import styles from "./PromptOutput.module.css";

export default function PromptOutput({ prompt }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.label}>SAP CPI iFlow Prompt</span>
        <button className={styles.copyBtn} onClick={handleCopy}>
          {copied ? "✓ Copied!" : "Copy"}
        </button>
      </div>
      <pre className={styles.output}>{prompt}</pre>
    </div>
  );
}
