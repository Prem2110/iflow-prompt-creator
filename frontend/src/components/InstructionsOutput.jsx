import { useState } from "react";
import styles from "./InstructionsOutput.module.css";

function renderContent(text) {
  const lines = text.split("\n");
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("### ")) {
      elements.push(<h4 key={i} className={styles.h4}>{line.slice(4)}</h4>);
    } else if (line.startsWith("## ")) {
      elements.push(<h3 key={i} className={styles.h3}>{line.slice(3)}</h3>);
    } else if (line.startsWith("# ")) {
      elements.push(<h2 key={i} className={styles.h2}>{line.slice(2)}</h2>);
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)$/);
      elements.push(
        <div key={i} className={styles.numberedItem}>
          <span className={styles.num}>{match[1]}.</span>
          <span>{match[2]}</span>
        </div>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <div key={i} className={styles.bulletItem}>
          <span className={styles.bullet}>•</span>
          <span>{line.slice(2)}</span>
        </div>
      );
    } else if (line.startsWith("**") && line.endsWith("**") && line.length > 4) {
      elements.push(<p key={i} className={styles.bold}>{line.slice(2, -2)}</p>);
    } else if (line.trim() === "") {
      elements.push(<div key={i} className={styles.spacer} />);
    } else {
      elements.push(<p key={i} className={styles.para}>{line}</p>);
    }

    i++;
  }

  return elements;
}

export default function InstructionsOutput({ instructions, loading = false }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(instructions);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.label}>SAP CPI Manual Build Guide</span>
          <span className={styles.charCount}>{instructions.length.toLocaleString()} chars</span>
        </div>
        <button
          className={`${styles.copyBtn} ${copied ? styles.copied : ""}`}
          onClick={handleCopy}
        >
          {copied ? "✓ Copied!" : "Copy"}
        </button>
      </div>
      <div className={`${styles.body} ${loading ? styles.streaming : ""}`}>
        {renderContent(instructions)}
        {loading && <span className={styles.cursor}>▋</span>}
      </div>
    </div>
  );
}
