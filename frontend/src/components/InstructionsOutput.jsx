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
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
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
function isHorizontalRule(t) { return /^(-{3,}|\*{3,}|_{3,})$/.test(t); }
function isXmlLine(t) { return /^<\/?[A-Za-z][\w:-]*[\s>]/.test(t) || t.startsWith("<?xml") || t.startsWith("<!--"); }

// ── Section (collapsible ##) with copy button ─────────────────────────────────

function Section({ title, rawText, children, query, defaultOpen, toast }) {
  const [open, setOpen] = useState(defaultOpen !== false);
  const [copied, setCopied] = useState(false);

  async function handleCopy(e) {
    e.stopPropagation();
    await navigator.clipboard.writeText(`## ${title}\n${rawText}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast?.("Section copied!", "success");
  }

  const titleHit = query && title.toLowerCase().includes(query.toLowerCase());

  return (
    <div className={`${styles.section} ${titleHit ? styles.sectionHit : ""}`}>
      <div className={styles.sectionHeader}>
        <button className={styles.sectionToggle} onClick={() => setOpen((v) => !v)}>
          <span className={styles.sectionArrow}>{open ? "▾" : "▸"}</span>
          <span className={styles.sectionTitle}>{highlight(title, query)}</span>
        </button>
        <button
          className={`${styles.sectionCopyBtn} ${copied ? styles.sectionCopied : ""}`}
          onClick={handleCopy}
          title="Copy this section"
        >
          {copied ? "✓" : "Copy"}
        </button>
      </div>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

// ── Split text into sections then render ──────────────────────────────────────

function splitSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = { heading: null, rawLines: [] };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current.heading !== null || current.rawLines.length > 0) sections.push(current);
      current = { heading: line.slice(3), rawLines: [] };
    } else {
      current.rawLines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function renderLines(lines, query, toast) {
  const elements = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip horizontal rules — sections already provide visual separation
    if (isHorizontalRule(trimmed)) { i++; continue; }

    // Auto-detect bare XML blocks (LLM forgot to fence them)
    if (isXmlLine(trimmed)) {
      const start = i;
      const codeLines = [];
      while (i < lines.length && (isXmlLine(lines[i].trim()) || lines[i].trim() === "")) {
        codeLines.push(lines[i]);
        i++;
      }
      // Only treat as a code block if it's at least 2 lines (avoid single inline tags)
      if (codeLines.length >= 2) {
        elements.push(<CodeBlock key={`xml-${start}`} lang="xml" code={codeLines.join("\n").trimEnd()} toast={toast} />);
        continue;
      }
      // Single-line XML — fall through to normal rendering
      i = start;
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
      elements.push(<CodeBlock key={`code-${i}`} lang={lang} code={codeLines.join("\n")} toast={toast} />);
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
      elements.push(
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
      elements.push(<p key={i} className={styles.h4}>{renderInline(line.slice(5), query)}</p>);
    } else if (line.startsWith("### ")) {
      elements.push(<h4 key={i} className={styles.h4}>{renderInline(line.slice(4), query)}</h4>);
    } else if (line.startsWith("# ")) {
      elements.push(<h2 key={i} className={styles.h2}>{renderInline(line.slice(2), query)}</h2>);
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)$/);
      elements.push(
        <div key={i} className={styles.numberedItem}>
          <span className={styles.num}>{match[1]}.</span>
          <span>{renderInline(match[2], query)}</span>
        </div>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <div key={i} className={styles.bulletItem}>
          <span className={styles.bullet}>•</span>
          <span>{renderInline(line.slice(2), query)}</span>
        </div>
      );
    } else if (/^\*\*(.+)\*\*$/.test(trimmed)) {
      elements.push(<p key={i} className={styles.bold}>{renderInline(trimmed.slice(2, -2), query)}</p>);
    } else if (trimmed === "") {
      elements.push(<div key={i} className={styles.spacer} />);
    } else {
      elements.push(<p key={i} className={styles.para}>{renderInline(line, query)}</p>);
    }
    i++;
  }
  return elements;
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
  const [openGen, setOpenGen] = useState({ v: 0, open: true }); // v = generation key

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
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (instructions.match(new RegExp(escaped, "gi")) || []).length;
  }, [instructions, query]);

  const sections = useMemo(() => splitSections(instructions), [instructions]);

  return (
    <div className={styles.container}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.label}>{label}</span>
          <span className={styles.charCount}>
            {instructions.length.toLocaleString()} chars · {words.toLocaleString()} words
            {sections.filter(s => s.heading).length > 0 && ` · ${sections.filter(s => s.heading).length} sections`}
          </span>
        </div>
        <div className={styles.toolbarRight}>
          <button
            className={styles.collapseBtn}
            onClick={() => setOpenGen({ v: openGen.v + 1, open: false })}
            title="Collapse all sections"
          >Collapse all</button>
          <button
            className={styles.collapseBtn}
            onClick={() => setOpenGen({ v: openGen.v + 1, open: true })}
            title="Expand all sections"
          >Expand all</button>
          <button className={`${styles.copyBtn} ${copied ? styles.copied : ""}`} onClick={handleCopy}>
            {copied ? "✓ Copied!" : "Copy all"}
          </button>
          <ExportMenu content={instructions} filename={exportFilename} loading={loading} toast={toast} />
        </div>
      </div>

      {/* Search bar */}
      <div className={styles.searchBar}>
        <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
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

      {/* Body */}
      <div className={`${styles.body} ${loading ? styles.streaming : ""}`}>
        {sections.map((sec, idx) =>
          sec.heading ? (
            <Section
              key={`${idx}-${openGen.v}`}
              title={sec.heading}
              rawText={sec.rawLines.join("\n")}
              query={query}
              defaultOpen={openGen.open}
              toast={toast}
            >
              {renderLines(sec.rawLines, query, toast)}
            </Section>
          ) : (
            <div key={idx}>{renderLines(sec.rawLines, query, toast)}</div>
          )
        )}
        {loading && <span className={styles.cursor}>▋</span>}
      </div>
    </div>
  );
}
