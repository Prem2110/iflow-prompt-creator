import { useState, useMemo } from "react";
import ExportMenu from "./ExportMenu.jsx";
import styles from "./InstructionsOutput.module.css";

// ── Code block ────────────────────────────────────────────────────────────────

const LANG_LABELS = {
  groovy: "Groovy", gsh: "Groovy", java: "Java",
  xml: "XML", xslt: "XSLT", xsd: "XSD",
  json: "JSON", yaml: "YAML", yml: "YAML",
  js: "JavaScript", javascript: "JavaScript",
  bash: "Bash", sh: "Shell", curl: "cURL",
  sql: "SQL", python: "Python", py: "Python",
  jsonata: "JSONata", xpath: "XPath",
  csv: "CSV", txt: "Text", text: "Text",
};

function CodeBlock({ lang, code, toast }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast?.("Code copied!", "success");
  }
  const label = LANG_LABELS[lang?.toLowerCase()] || lang || "Code";
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span className={styles.codeLang}>{label}</span>
        <button className={`${styles.codeCopyBtn} ${copied ? styles.codeCopied : ""}`} onClick={handleCopy}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre className={styles.codeBody}><code>{code}</code></pre>
    </div>
  );
}

// ── Inline rendering ──────────────────────────────────────────────────────────

function highlight(text, query) {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) =>
    p.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className={styles.searchMark}>{p}</mark>
      : p
  );
}

function renderInline(text, query) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i} className={styles.inlineCode}>{part.slice(1, -1)}</code>;
    }
    return <span key={i}>{highlight(part, query)}</span>;
  });
}

// ── Table helpers ─────────────────────────────────────────────────────────────

function isTableRow(t) { return t.startsWith("|") && t.endsWith("|") && t.length > 2; }
function isSeparatorRow(t) { return /^\|[\s\-:|]+\|$/.test(t); }
function parseTableRow(line) { return line.trim().slice(1, -1).split("|").map((c) => c.trim()); }

// ── Section (collapsible ##) ──────────────────────────────────────────────────

function Section({ title, children, query }) {
  const [open, setOpen] = useState(true);
  const titleHit = query && title.toLowerCase().includes(query.toLowerCase());
  return (
    <div className={`${styles.section} ${titleHit ? styles.sectionHit : ""}`}>
      <button className={styles.sectionToggle} onClick={() => setOpen((v) => !v)}>
        <span className={styles.sectionArrow}>{open ? "▾" : "▸"}</span>
        <span className={styles.sectionTitle}>{highlight(title, query)}</span>
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

// ── Main renderer ─────────────────────────────────────────────────────────────

function renderContent(text, query, toast) {
  const lines = text.split("\n");
  const topLevel = []; // array of { heading, elements[] }
  let current = { heading: null, elements: [] };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // New ## section — start collapsible group
    if (line.startsWith("## ")) {
      if (current.heading !== null || current.elements.length) topLevel.push(current);
      current = { heading: line.slice(3), elements: [] };
      i++; continue;
    }

    // Fenced code block
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      current.elements.push(
        <CodeBlock key={`code-${i}`} lang={lang} code={codeLines.join("\n")} toast={toast} />
      );
      continue;
    }

    // Markdown table
    if (isTableRow(trimmed) && i + 1 < lines.length && isSeparatorRow(lines[i + 1].trim())) {
      const ts = i;
      const tableLines = [];
      while (i < lines.length && isTableRow(lines[i].trim())) { tableLines.push(lines[i].trim()); i++; }
      const [headerLine, , ...dataLines] = tableLines;
      const headers = parseTableRow(headerLine);
      const rows = dataLines.filter((l) => !isSeparatorRow(l)).map(parseTableRow);
      current.elements.push(
        <div key={`tbl-${ts}`} className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead><tr>{headers.map((h, j) => <th key={j}>{renderInline(h, query)}</th>)}</tr></thead>
            <tbody>{rows.map((row, j) => (
              <tr key={j}>{row.map((cell, k) => <td key={k}>{renderInline(cell, query)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      );
      continue;
    }

    if (line.startsWith("#### ")) {
      current.elements.push(<p key={i} className={styles.h4}>{renderInline(line.slice(5), query)}</p>);
    } else if (line.startsWith("### ")) {
      current.elements.push(<h4 key={i} className={styles.h4}>{renderInline(line.slice(4), query)}</h4>);
    } else if (line.startsWith("# ")) {
      current.elements.push(<h2 key={i} className={styles.h2}>{renderInline(line.slice(2), query)}</h2>);
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)$/);
      current.elements.push(
        <div key={i} className={styles.numberedItem}>
          <span className={styles.num}>{match[1]}.</span>
          <span>{renderInline(match[2], query)}</span>
        </div>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      current.elements.push(
        <div key={i} className={styles.bulletItem}>
          <span className={styles.bullet}>•</span>
          <span>{renderInline(line.slice(2), query)}</span>
        </div>
      );
    } else if (/^\*\*(.+)\*\*$/.test(trimmed)) {
      current.elements.push(<p key={i} className={styles.bold}>{renderInline(trimmed.slice(2, -2), query)}</p>);
    } else if (trimmed === "") {
      current.elements.push(<div key={i} className={styles.spacer} />);
    } else {
      current.elements.push(<p key={i} className={styles.para}>{renderInline(line, query)}</p>);
    }
    i++;
  }
  topLevel.push(current);

  return topLevel.map((block, idx) =>
    block.heading
      ? <Section key={idx} title={block.heading} query={query}>{block.elements}</Section>
      : <div key={idx}>{block.elements}</div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InstructionsOutput({
  instructions,
  loading = false,
  label = "SAP CPI Manual Build Guide",
  exportFilename = "iflow-instructions",
  toast,
}) {
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState("");

  async function handleCopy() {
    await navigator.clipboard.writeText(instructions);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast?.("Copied to clipboard!", "success");
  }

  const words = useMemo(
    () => (instructions.trim() ? instructions.trim().split(/\s+/).length : 0),
    [instructions]
  );

  const matchCount = useMemo(() => {
    if (!query) return 0;
    return (instructions.match(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
  }, [instructions, query]);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.label}>{label}</span>
          <span className={styles.charCount}>{instructions.length.toLocaleString()} chars · {words.toLocaleString()} words</span>
        </div>
        <div className={styles.toolbarRight}>
          <button className={`${styles.copyBtn} ${copied ? styles.copied : ""}`} onClick={handleCopy}>
            {copied ? "✓ Copied!" : "Copy all"}
          </button>
          <ExportMenu content={instructions} filename={exportFilename} loading={loading} toast={toast} />
        </div>
      </div>

      {/* Search bar */}
      <div className={styles.searchBar}>
        <span className={styles.searchIcon}>🔍</span>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search in output…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <span className={styles.searchCount}>
            {matchCount > 0 ? `${matchCount} match${matchCount !== 1 ? "es" : ""}` : "No matches"}
          </span>
        )}
        {query && (
          <button className={styles.searchClear} onClick={() => setQuery("")}>✕</button>
        )}
      </div>

      <div className={`${styles.body} ${loading ? styles.streaming : ""}`}>
        {renderContent(instructions, query, toast)}
        {loading && <span className={styles.cursor}>▋</span>}
      </div>
    </div>
  );
}
