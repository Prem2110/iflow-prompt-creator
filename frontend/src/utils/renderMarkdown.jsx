/**
 * Shared markdown bubble renderer.
 *
 * Usage:
 *   import { makeRenderBubble } from "../utils/renderMarkdown.jsx";
 *   const renderBubble = makeRenderBubble(styles);
 *
 * Required CSS module classes (see Chat.module.css / FlowDetail.module.css):
 *   bubblePara, bubbleCode, codeBlock, codeLang,
 *   mdTable, mdHr, mdH1, mdH2, mdH3,
 *   mdBlockquote, mdUl, mdOl, mdLi, cursor
 */

function isTableRow(line) { return line.trim().startsWith("|") && line.trim().endsWith("|"); }
function isSeparator(line) { return /^\|[\s\-:|]+\|$/.test(line.trim()); }
function parseRow(line)    { return line.trim().slice(1, -1).split("|").map(c => c.trim()); }

export function makeRenderBubble(styles) {
  function renderInline(text) {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
      if (p.startsWith("`")  && p.endsWith("`")  && p.length > 2)
        return <code key={i} className={styles.bubbleCode}>{p.slice(1, -1)}</code>;
      return p;
    });
  }

  return function renderBubble(text, streaming) {
    const lines = text.split("\n");
    const els = [];
    let i = 0;

    while (i < lines.length) {
      const line    = lines[i];
      const trimmed = line.trim();

      // ── Fenced code block ──────────────────────────────────────────────
      if (trimmed.startsWith("```")) {
        const lang = trimmed.slice(3).trim();
        i++;
        const codeLines = [];
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // skip closing ```
        els.push(
          <pre key={`code-${i}`} className={styles.codeBlock}>
            {lang && <span className={styles.codeLang}>{lang}</span>}
            <code>{codeLines.join("\n")}</code>
          </pre>
        );
        continue;
      }

      // ── Markdown table ─────────────────────────────────────────────────
      if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
        const headers = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) { rows.push(parseRow(lines[i])); i++; }
        els.push(
          <table key={`tbl-${i}`} className={styles.mdTable}>
            <thead>
              <tr>{headers.map((h, j) => <th key={j}>{renderInline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, j) => (
                <tr key={j}>{row.map((cell, k) => <td key={k}>{renderInline(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        );
        continue;
      }

      // ── Horizontal rule ────────────────────────────────────────────────
      if (/^[-*_]{3,}$/.test(trimmed)) {
        els.push(<hr key={`hr-${i}`} className={styles.mdHr} />);
        i++;
        continue;
      }

      // ── Headings ───────────────────────────────────────────────────────
      const h3 = trimmed.match(/^### (.+)/);
      const h2 = trimmed.match(/^## (.+)/);
      const h1 = trimmed.match(/^# (.+)/);
      if (h3) { els.push(<h3 key={i} className={styles.mdH3}>{renderInline(h3[1])}</h3>); i++; continue; }
      if (h2) { els.push(<h2 key={i} className={styles.mdH2}>{renderInline(h2[1])}</h2>); i++; continue; }
      if (h1) { els.push(<h1 key={i} className={styles.mdH1}>{renderInline(h1[1])}</h1>); i++; continue; }

      // ── Blockquote ─────────────────────────────────────────────────────
      if (trimmed.startsWith(">")) {
        const quoteLines = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().slice(1).trim());
          i++;
        }
        els.push(
          <blockquote key={`bq-${i}`} className={styles.mdBlockquote}>
            {quoteLines.map((l, j) => <p key={j}>{renderInline(l)}</p>)}
          </blockquote>
        );
        continue;
      }

      // ── Unordered list ─────────────────────────────────────────────────
      if (/^[-*+] /.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^[-*+] /.test(lines[i].trim())) {
          items.push(lines[i].trim().slice(2));
          i++;
        }
        els.push(
          <ul key={`ul-${i}`} className={styles.mdUl}>
            {items.map((item, j) => <li key={j} className={styles.mdLi}>{renderInline(item)}</li>)}
          </ul>
        );
        continue;
      }

      // ── Ordered list ───────────────────────────────────────────────────
      if (/^\d+\. /.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\d+\. /.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^\d+\. /, ""));
          i++;
        }
        els.push(
          <ol key={`ol-${i}`} className={styles.mdOl}>
            {items.map((item, j) => <li key={j} className={styles.mdLi}>{renderInline(item)}</li>)}
          </ol>
        );
        continue;
      }

      // ── Blank line ─────────────────────────────────────────────────────
      if (!trimmed) { i++; continue; }

      // ── Paragraph ──────────────────────────────────────────────────────
      els.push(<p key={i} className={styles.bubblePara}>{renderInline(line)}</p>);
      i++;
    }

    if (streaming) els.push(<span key="cur" className={styles.cursor}>▋</span>);
    return els;
  };
}
