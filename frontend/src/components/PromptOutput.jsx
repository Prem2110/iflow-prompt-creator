import { useState } from "react";
import { Copy, Check } from "lucide-react";
import ExportMenu from "./ExportMenu.jsx";
import styles from "./PromptOutput.module.css";

export default function PromptOutput({ prompt, loading = false, toast }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast?.("Copied to clipboard!", "success");
  }

  const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.label}>SAP CPI iFlow Prompt</span>
          <span className={styles.charCount}>{prompt.length.toLocaleString()} chars · {words.toLocaleString()} words</span>
        </div>
        <div className={styles.toolbarRight}>
          <button className={`${styles.copyBtn} ${copied ? styles.copied : ""}`} onClick={handleCopy}>
            {copied ? <><Check size={13} /> Copied!</> : <><Copy size={13} /> Copy</>}
          </button>
          <ExportMenu content={prompt} filename="iflow-prompt" loading={loading} toast={toast} />
        </div>
      </div>
      <pre className={`${styles.output} ${loading ? styles.streaming : ""}`}>{prompt}</pre>
    </div>
  );
}
