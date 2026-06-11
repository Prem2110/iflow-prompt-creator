import { useState } from "react";
import ExportMenu from "./ExportMenu.jsx";
import styles from "./InstructionsOutput.module.css";

function isTableRow(trimmed) {
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;
}

function isSeparatorRow(trimmed) {
  return /^\|[\s\-:|]+\|$/.test(trimmed);
}

function parseTableRow(line) {
  return line.trim().slice(1, -1).split("|").map((c) => c.trim());
}

function renderContent(text) {
  const lines = text.split("\n");
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Markdown table: header row followed immediately by separator row
    if (isTableRow(trimmed) && i + 1 < lines.length && isSeparatorRow(lines[i + 1].trim())) {
      const tableStart = i;
      const tableLines = [];
      while (i < lines.length && isTableRow(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const [headerLine, , ...dataLines] = tableLines;
      const headers = parseTableRow(headerLine);
      const rows = dataLines.filter((l) => !isSeparatorRow(l)).map(parseTableRow);
      elements.push(
        <div key={`tbl-${tableStart}`} className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>{headers.map((h, j) => <th key={j}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, j) => (
                <tr key={j}>{row.map((cell, k) => <td key={k}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (line.startsWith("#### ")) {
      elements.push(<p key={i} className={styles.h4}>{line.slice(5)}</p>);
    } else if (line.startsWith("### ")) {
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
    } else if (trimmed === "") {
      elements.push(<div key={i} className={styles.spacer} />);
    } else {
      elements.push(<p key={i} className={styles.para}>{line}</p>);
    }

    i++;
  }

  return elements;
}

export default function InstructionsOutput({ instructions, loading = false, label = "SAP CPI Manual Build Guide", exportFilename = "iflow-instructions" }) {
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
          <span className={styles.label}>{label}</span>
          <span className={styles.charCount}>{instructions.length.toLocaleString()} chars</span>
        </div>
        <div className={styles.toolbarRight}>
          <button
            className={`${styles.copyBtn} ${copied ? styles.copied : ""}`}
            onClick={handleCopy}
          >
            {copied ? "✓ Copied!" : "Copy"}
          </button>
          <ExportMenu content={instructions} filename={exportFilename} loading={loading} />
        </div>
      </div>
      <div className={`${styles.body} ${loading ? styles.streaming : ""}`}>
        {renderContent(instructions)}
        {loading && <span className={styles.cursor}>▋</span>}
      </div>
    </div>
  );
}
