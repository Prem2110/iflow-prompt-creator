import { useEffect, useRef, useState, useCallback } from "react";
import {
  ArrowLeft, GitBranch, Maximize2, Minimize2, RefreshCw,
  LayoutGrid, AlignLeft, ChevronLeft, MousePointer2,
  Loader2, AlertCircle, Sun, Moon,
} from "lucide-react";
import { badgeStyle } from "./dirBadge.js";
import styles from "./VisualisePanel.module.css";

// ── Mermaid singleton ─────────────────────────────────────────────────────────

let _mermaid = null;
async function getMermaid() {
  if (_mermaid) return _mermaid;
  const m = await import("mermaid");
  m.default.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: {
      primaryColor:        "#1a3050",
      primaryTextColor:    "#d4dce8",
      primaryBorderColor:  "#4a7ab5",
      lineColor:           "#6a8098",
      secondaryColor:      "#111a28",
      tertiaryColor:       "#0c0f1a",
      mainBkg:             "#0c0f1a",
      nodeBorder:          "#4a7ab5",
      clusterBkg:          "#111a28",
      clusterBorder:       "rgba(74,122,181,0.25)",
      titleColor:          "#8fa2b6",
      edgeLabelBackground: "#111a28",
      fontFamily:          "Lexend, sans-serif",
    },
  });
  _mermaid = m.default;
  return _mermaid;
}

function cleanSyntax(raw) {
  return raw.trim().replace(/^```(?:mermaid)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

// ── SSE streaming hook ────────────────────────────────────────────────────────

function useStream() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  const run = useCallback(async (endpoint, files, flow, extraFields = {}) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true); setText(""); setError("");
    const form = new FormData();
    files.forEach(f => form.append("files", f));
    form.append("flow_json", JSON.stringify(flow));
    for (const [k, v] of Object.entries(extraFields)) form.append(k, v);

    try {
      const res = await fetch(endpoint, { method: "POST", body: form, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.status === "chunk") setText(t => t + ev.text);
          else if (ev.status === "done" && ev.prompt) setText(ev.prompt);
          else if (ev.status === "error") setError(ev.message);
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setText(""); setError(""); setLoading(false);
  }, []);

  return { text, loading, error, run, reset };
}

// ── Markdown renderer (lightweight, no deps) ──────────────────────────────────

function isTableRow(t) { return t.startsWith("|") && t.endsWith("|") && t.length > 2; }
function isSepRow(t) { return /^\|[\s\-:|]+\|$/.test(t); }
function parseRow(l) { return l.trim().slice(1, -1).split("|").map(c => c.trim()); }

function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
      return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("*") && p.endsWith("*") && p.length > 2)
      return <em key={i}>{p.slice(1, -1)}</em>;
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2)
      return <code key={i} className={styles.inlineCode}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

function MarkdownContent({ text, loading }) {
  if (!text && loading) return <div className={styles.rpLoading}><Loader2 size={16} className={styles.spin} /> Generating…</div>;
  if (!text) return null;

  const lines = text.split("\n");
  const els = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (t.startsWith("```")) {
      const lang = t.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i++; }
      i++;
      els.push(
        <pre key={`c${i}`} className={styles.codeBlock}>
          {lang && <span className={styles.codeLang}>{lang}</span>}
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (isTableRow(t) && i + 1 < lines.length && isSepRow(lines[i + 1].trim())) {
      const tstart = i;
      const tlines = [];
      while (i < lines.length && isTableRow(lines[i].trim())) { tlines.push(lines[i].trim()); i++; }
      const [hdr, , ...rows] = tlines;
      const hdrs = parseRow(hdr);
      els.push(
        <div key={`t${tstart}`} className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr>{hdrs.map((h, j) => <th key={j}>{renderInline(h)}</th>)}</tr></thead>
            <tbody>
              {rows.filter(r => !isSepRow(r)).map((r, j) => (
                <tr key={j}>{parseRow(r).map((c, k) => <td key={k}>{renderInline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (t.startsWith("## "))       els.push(<h3 key={i} className={styles.h2}>{renderInline(t.slice(3))}</h3>);
    else if (t.startsWith("### ")) els.push(<h4 key={i} className={styles.h3}>{renderInline(t.slice(4))}</h4>);
    else if (t.startsWith("#### "))els.push(<h5 key={i} className={styles.h4}>{renderInline(t.slice(5))}</h5>);
    else if (t.startsWith("- [ ] "))els.push(<label key={i} className={styles.checkItem}><input type="checkbox" disabled /><span>{renderInline(t.slice(6))}</span></label>);
    else if (t.startsWith("- [x] ") || t.startsWith("- [X] "))els.push(<label key={i} className={styles.checkItem}><input type="checkbox" disabled defaultChecked /><span>{renderInline(t.slice(6))}</span></label>);
    else if (t.startsWith("- ") || t.startsWith("* "))els.push(<div key={i} className={styles.bullet}><span className={styles.dot}>•</span><span>{renderInline(t.slice(2))}</span></div>);
    else if (/^\d+\.\s/.test(t)) {
      const m = t.match(/^(\d+)\.\s(.*)$/);
      els.push(<div key={i} className={styles.numbered}><span className={styles.num}>{m[1]}.</span><span>{renderInline(m[2])}</span></div>);
    } else if (t === "---") els.push(<hr key={i} className={styles.hr} />);
    else if (t === "") els.push(<div key={i} className={styles.spacer} />);
    else els.push(<p key={i} className={styles.para}>{renderInline(t)}</p>);

    i++;
  }

  return (
    <div className={styles.markdownBody}>
      {els}
      {loading && <span className={styles.cursor}>▋</span>}
    </div>
  );
}

// ── Right panel tab configs ───────────────────────────────────────────────────

const RIGHT_TABS = [
  { key: "overview",  label: "Overview",     endpoint: "/api/generate-visualise-overview" },
  { key: "mappings",  label: "Field Mappings", endpoint: "/api/generate-field-mappings" },
  { key: "checklist", label: "Checklist",    endpoint: "/api/generate-config-checklist" },
  { key: "failures",  label: "Failure Modes", endpoint: "/api/generate-failure-modes" },
];

// ── Main component ────────────────────────────────────────────────────────────

export default function VisualisePanel({ flow, files, onClose, toast }) {
  // Theme
  const [isDark, setIsDark] = useState(() => document.documentElement.getAttribute("data-theme") !== "light");
  function toggleTheme() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    localStorage.setItem("orbit-dark", next);
  }

  // Diagram state — start loading=true because we generate on mount
  const [diagramSyntax, setDiagramSyntax] = useState("");
  const [diagramSvg, setDiagramSvg] = useState("");
  const [diagramLoading, setDiagramLoading] = useState(true);
  const [diagramError, setDiagramError] = useState("");
  const [direction, setDirection] = useState("LR"); // LR | TD
  const renderIdRef = useRef(0);
  const diagramAbortRef = useRef(null);

  // Zoom / pan
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  useEffect(() => { transformRef.current = transform; }, [transform]);
  const drag = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const containerRef = useRef(null);
  const diagramRef = useRef(null);

  // Right panel
  const [activeTab, setActiveTab] = useState("overview");
  const [tabDone, setTabDone] = useState({});   // { overview: true, ... }
  const overviewStream  = useStream();
  const mappingsStream  = useStream();
  const checklistStream = useStream();
  const failuresStream  = useStream();
  const stepStream      = useStream();

  const streams = { overview: overviewStream, mappings: mappingsStream, checklist: checklistStream, failures: failuresStream };

  // Node click
  const [selectedNode, setSelectedNode] = useState(null);
  const [prevTab, setPrevTab] = useState("overview");

  // ── Generate diagram ────────────────────────────────────────────────────────

  async function generateDiagram() {
    if (diagramAbortRef.current) diagramAbortRef.current.abort();
    const ctrl = new AbortController();
    diagramAbortRef.current = ctrl;

    setDiagramLoading(true); setDiagramSyntax(""); setDiagramSvg(""); setDiagramError("");
    const form = new FormData();
    files.forEach(f => form.append("files", f));
    form.append("flow_json", JSON.stringify(flow));

    try {
      const res = await fetch("/api/generate-flow-diagram", { method: "POST", body: form, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", result = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.status === "chunk") result += ev.text;
          else if (ev.status === "done" && ev.prompt) result = ev.prompt;
          else if (ev.status === "error") setDiagramError(ev.message);
        }
      }
      setDiagramSyntax(result);
    } catch (err) {
      if (err.name !== "AbortError") setDiagramError(err.message);
    } finally {
      setDiagramLoading(false);
    }
  }

  // ── Generate tab content ────────────────────────────────────────────────────

  function generateTab(key) {
    const cfg = RIGHT_TABS.find(t => t.key === key);
    if (!cfg) return;
    streams[key].run(cfg.endpoint, files, flow);
    setTabDone(d => ({ ...d, [key]: true }));
  }

  // Auto-generate diagram + overview on mount
  useEffect(() => {
    generateDiagram();
    generateTab("overview");
    setTabDone({ overview: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render SVG when syntax changes or direction changes
  useEffect(() => {
    if (!diagramSyntax) return;
    let cancelled = false;
    const syntax = direction === "TD"
      ? cleanSyntax(diagramSyntax).replace(/^flowchart\s+LR/m, "flowchart TD")
      : cleanSyntax(diagramSyntax).replace(/^flowchart\s+TD/m, "flowchart LR");

    renderIdRef.current += 1;
    const id = `vp-mermaid-${renderIdRef.current}`;
    getMermaid().then(async mermaid => {
      if (cancelled) return;
      try {
        const { svg } = await mermaid.render(id, syntax);
        if (!cancelled) setDiagramSvg(svg);
      } catch (err) {
        if (!cancelled) setDiagramError(`Render error: ${err.message}`);
      }
    });
    return () => { cancelled = true; };
  }, [diagramSyntax, direction]);

  // Attach node click handlers after SVG renders
  useEffect(() => {
    if (!diagramSvg || !diagramRef.current) return;
    const nodes = diagramRef.current.querySelectorAll(".node");
    const handlers = [];
    nodes.forEach(node => {
      node.style.cursor = "pointer";
      const handler = () => {
        const label =
          node.querySelector(".nodeLabel")?.textContent?.trim() ||
          node.querySelector("foreignObject span")?.textContent?.trim() ||
          node.querySelector("text")?.textContent?.trim() ||
          node.id.replace(/^flowchart-/, "").replace(/-\d+$/, "").replace(/_/g, " ");
        if (!label) return;
        setPrevTab(activeTab);
        setSelectedNode({ id: node.id, label });
        stepStream.reset();
        stepStream.run("/api/generate-step-detail", files, flow, {
          node_label: label,
          diagram_syntax: cleanSyntax(diagramSyntax),
        });
      };
      node.addEventListener("click", handler);
      handlers.push({ node, handler });
    });
    return () => handlers.forEach(({ node, handler }) => node.removeEventListener("click", handler));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramSvg]);

  // ── Tab switching ───────────────────────────────────────────────────────────

  function switchTab(key) {
    setActiveTab(key);
    setSelectedNode(null);
    if (!tabDone[key]) generateTab(key);
  }

  // ── Zoom / pan handlers ─────────────────────────────────────────────────────

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.88;
    setTransform(t => ({ ...t, scale: Math.max(0.1, Math.min(6, t.scale * factor)) }));
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = {
      active: true,
      startX: e.clientX, startY: e.clientY,
      originX: transformRef.current.x, originY: transformRef.current.y,
    };
  }

  function onMouseMove(e) {
    if (!drag.current.active) return;
    setTransform(t => ({
      ...t,
      x: drag.current.originX + (e.clientX - drag.current.startX),
      y: drag.current.originY + (e.clientY - drag.current.startY),
    }));
  }

  function onMouseUp() { drag.current.active = false; }

  function fitToScreen() {
    if (!containerRef.current || !diagramRef.current) return;
    const svgEl = diagramRef.current.querySelector("svg");
    if (!svgEl) return;

    const cr = containerRef.current.getBoundingClientRect();
    const cw = cr.width;
    const ch = cr.height;
    if (!cw || !ch) return;

    // Prefer viewBox (Mermaid always sets this), then explicit attrs, then rendered size
    let sw = 0, sh = 0;
    const vb = svgEl.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) { sw = vb.width; sh = vb.height; }
    if (!sw || !sh) {
      const wa = svgEl.getAttribute("width");
      const ha = svgEl.getAttribute("height");
      if (wa && !wa.includes("%")) sw = parseFloat(wa);
      if (ha && !ha.includes("%")) sh = parseFloat(ha);
    }
    if (!sw || !sh) {
      const sr = svgEl.getBoundingClientRect();
      sw = sr.width; sh = sr.height;
    }
    if (!sw || !sh) return;

    const pad = 40;
    const scale = Math.min((cw - pad) / sw, (ch - pad) / sh);
    setTransform({ scale, x: (cw - sw * scale) / 2, y: (ch - sh * scale) / 2 });
  }

  // Auto-fit whenever a new SVG is rendered
  useEffect(() => {
    if (!diagramSvg) return;
    requestAnimationFrame(() => requestAnimationFrame(() => fitToScreen()));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramSvg]);

  function resetZoom() { setTransform({ scale: 1, x: 0, y: 0 }); }

  function toggleDirection() {
    setDirection(d => d === "LR" ? "TD" : "LR");
  }

  // ── Active right panel stream ───────────────────────────────────────────────

  const activeStream = selectedNode ? stepStream : (streams[activeTab] || overviewStream);

  return (
    <div className={styles.panel}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onClose}>
          <ArrowLeft size={14} /> Back to flows
        </button>

        <div className={styles.headerCenter}>
          <GitBranch size={14} className={styles.headerIcon} />
          <span className={styles.flowName}>{flow.name}</span>
          <span className={styles.dirBadge} style={badgeStyle(flow.direction)}>{flow.direction}</span>
        </div>

        <div className={styles.headerControls}>
          <button
            className={`${styles.ctrlBtn} ${direction === "TD" ? styles.ctrlBtnActive : ""}`}
            onClick={toggleDirection}
            title={direction === "LR" ? "Switch to top-down layout" : "Switch to left-right layout"}
          >
            {direction === "LR" ? <LayoutGrid size={13} /> : <AlignLeft size={13} />}
            {direction === "LR" ? "Top-Down" : "Left-Right"}
          </button>
          <button className={styles.ctrlBtn} onClick={fitToScreen} title="Fit diagram to screen">
            <Maximize2 size={13} /> Fit
          </button>
          <button className={styles.ctrlBtn} onClick={resetZoom} title="Reset zoom">
            <Minimize2 size={13} /> Reset
          </button>
          <button
            className={`${styles.ctrlBtn} ${styles.ctrlBtnRegen}`}
            onClick={generateDiagram}
            disabled={diagramLoading}
            title="Regenerate diagram"
          >
            <RefreshCw size={13} className={diagramLoading ? styles.spin : ""} />
            {diagramLoading ? "Generating…" : "Regenerate"}
          </button>
          <span className={styles.zoomPct}>{Math.round(transform.scale * 100)}%</span>
          <div className={styles.ctrlDivider} />
          <button
            className={`${styles.ctrlBtn} ${styles.ctrlBtnTheme}`}
            onClick={toggleTheme}
            title={isDark ? "Switch to light theme" : "Switch to dark theme"}
          >
            {isDark ? <Sun size={13} /> : <Moon size={13} />}
          </button>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className={styles.body}>

        {/* Left: diagram canvas */}
        <div
          className={styles.diagramArea}
          ref={containerRef}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        >
          {diagramLoading && (
            <div className={styles.diagramState}>
              <Loader2 size={22} className={styles.spin} />
              <span>Generating diagram…</span>
            </div>
          )}
          {!diagramLoading && diagramError && (
            <div className={styles.diagramState}>
              <AlertCircle size={20} className={styles.errorIcon} />
              <span>{diagramError}</span>
            </div>
          )}
          {!diagramLoading && !diagramSvg && !diagramError && (
            <div className={styles.diagramState}>
              <GitBranch size={28} strokeWidth={1.4} className={styles.emptyIcon} />
              <span>No diagram yet</span>
            </div>
          )}

          {diagramSvg && (
            <div
              className={styles.diagramInner}
              style={{ transform: `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})` }}
              ref={diagramRef}
              dangerouslySetInnerHTML={{ __html: diagramSvg }}
            />
          )}

          {diagramSvg && (
            <div className={styles.diagramHint}>
              <MousePointer2 size={11} /> Click any node for details
            </div>
          )}
        </div>

        {/* Right: context panel */}
        <div className={styles.rightPanel}>

          {/* Tab bar */}
          <div className={styles.tabBar}>
            {selectedNode ? (
              <button className={styles.stepBackBtn} onClick={() => setSelectedNode(null)}>
                <ChevronLeft size={13} /> {prevTab.charAt(0).toUpperCase() + prevTab.slice(1)}
              </button>
            ) : (
              RIGHT_TABS.map(({ key, label }) => (
                <button
                  key={key}
                  className={`${styles.tab} ${activeTab === key ? styles.tabActive : ""}`}
                  onClick={() => switchTab(key)}
                >
                  {label}
                  {tabDone[key] && <span className={styles.tabDot} />}
                </button>
              ))
            )}
          </div>

          {/* Content */}
          <div className={styles.rightContent}>
            {selectedNode ? (
              <div className={styles.stepDetailWrap}>
                <div className={styles.stepDetailHeader}>
                  <GitBranch size={13} className={styles.stepIcon} />
                  <span className={styles.stepLabel}>{selectedNode.label}</span>
                </div>
                {stepStream.error && (
                  <div className={styles.rpError}><AlertCircle size={14} /> {stepStream.error}</div>
                )}
                <MarkdownContent text={stepStream.text} loading={stepStream.loading} />
              </div>
            ) : (
              <>
                {activeStream.error && (
                  <div className={styles.rpError}><AlertCircle size={14} /> {activeStream.error}</div>
                )}
                {!activeStream.text && activeStream.loading && (
                  <div className={styles.rpLoading}><Loader2 size={16} className={styles.spin} /> Generating…</div>
                )}
                {!activeStream.text && !activeStream.loading && !activeStream.error && (
                  <div className={styles.rpEmpty}>
                    <p>Click a tab to generate content</p>
                  </div>
                )}
                <MarkdownContent text={activeStream.text} loading={activeStream.loading} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
