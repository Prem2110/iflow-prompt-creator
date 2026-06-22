import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import {
  ArrowLeft, GitBranch, Maximize2, Minimize2, RefreshCw,
  LayoutGrid, AlignLeft, ChevronLeft, MousePointer2,
  Loader2, AlertCircle, Sun, Moon, Expand, Download,
} from "lucide-react";
import { badgeStyle } from "./dirBadge.js";
import styles from "./VisualisePanel.module.css";

// ── Mermaid singleton ─────────────────────────────────────────────────────────

let _mermaid = null;
async function getMermaid() {
  if (_mermaid) return _mermaid;
  const m = await import("mermaid").then(mod => mod.default);
  m.initialize({
    startOnLoad: false, theme: "base",
    themeVariables: {
      primaryColor: "#1e3f72",
      primaryTextColor: "#d4dce8",
      primaryBorderColor: "#4a9eff", lineColor: "#4a9eff",
      secondaryColor: "#162c4a",     tertiaryColor: "#111a28",
      mainBkg: "transparent",        nodeBorder: "#4a9eff",
      clusterBkg: "#111a28",         clusterBorder: "rgba(74,158,255,0.25)",
      titleColor: "#8fa2b6",         edgeLabelBackground: "rgba(12,15,26,0.85)",
      fontFamily: "Lexend, sans-serif",
    },
  });
  _mermaid = m;
  return _mermaid;
}

function cleanSyntax(raw) {
  return raw.trim().replace(/^```(?:mermaid)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

// Prepare the Mermaid SVG for display:
//  • Only the OPENING <svg …> tag is modified — child elements (foreignObject,
//    rect, text) keep their width/height attrs so labels don't break.
//  • background + max-width are stripped from the opening-tag style so the
//    diagArea CSS background colour shows through.
//  • Explicit pixel dimensions are set from the viewBox for reliable fit maths.
function processSvg(svgHtml) {
  const vbMatch = svgHtml.match(/viewBox="([^"]+)"/i);
  if (!vbMatch) return svgHtml;
  const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
  const vw = parts[2]; const vh = parts[3];
  if (!vw || !vh || vw <= 0 || vh <= 0) return svgHtml;

  return svgHtml.replace(/<svg[^>]+>/, (tag) => {
    // Strip width/height attrs from the opening tag only
    let t = tag
      .replace(/\s+width="[^"]*"/gi, "")
      .replace(/\s+height="[^"]*"/gi, "");
    // Strip background + max-width from inline style
    t = t.replace(/(style=")([^"]*)(")/, (_m, a, s, b) => {
      const clean = s
        .replace(/max-width\s*:\s*[^;]+;?\s*/gi, "")
        .replace(/background(?:-color)?\s*:\s*[^;]+;?\s*/gi, "")
        .trim().replace(/^;+|;+$/g, "").trim();
      return `${a}${clean}${b}`;
    });
    // Insert explicit pixel dimensions so the SVG has a known natural size
    return t.replace("<svg", `<svg width="${vw}" height="${vh}"`);
  });
}

// ── SSE streaming hook ────────────────────────────────────────────────────────

function useStream() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  const run = useCallback(async (endpoint, files, flow, extra = {}) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setText(""); setError("");
    const form = new FormData();
    files.forEach(f => form.append("files", f));
    form.append("flow_json", JSON.stringify(flow));
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    try {
      const res = await fetch(endpoint, { method: "POST", body: form, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const ln of lines) {
          if (!ln.startsWith("data: ")) continue;
          const ev = JSON.parse(ln.slice(6));
          if (ev.status === "chunk") setText(t => t + ev.text);
          else if (ev.status === "done" && ev.prompt) setText(ev.prompt);
          else if (ev.status === "error") setError(ev.message);
        }
      }
    } catch (e) { if (e.name !== "AbortError") setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const reset = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setText(""); setError(""); setLoading(false);
  }, []);

  return { text, loading, error, run, reset };
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function ri(text) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i}>{p.slice(2,-2)}</strong>;
    if (p.startsWith("*")  && p.endsWith("*")  && p.length > 2) return <em key={i}>{p.slice(1,-1)}</em>;
    if (p.startsWith("`")  && p.endsWith("`")  && p.length > 2) return <code key={i} className={styles.ic}>{p.slice(1,-1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

function isTR(t) { return t.startsWith("|") && t.endsWith("|") && t.length > 2; }
function isSep(t) { return /^\|[\s\-:|]+\|$/.test(t); }
function parseRow(l) { return l.trim().slice(1,-1).split("|").map(c=>c.trim()); }

function MD({ text, loading }) {
  if (!text && loading) return <div className={styles.rpLoading}><Loader2 size={16} className={styles.spin}/> Generating…</div>;
  if (!text) return null;
  const lines = text.split("\n"); const els = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i]; const t = line.trim();
    if (t.startsWith("```")) {
      const lang = t.slice(3).trim(); const code = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i++; }
      i++;
      els.push(<pre key={`c${i}`} className={styles.codeBlock}>{lang && <span className={styles.codeLang}>{lang}</span>}<code>{code.join("\n")}</code></pre>);
      continue;
    }
    if (isTR(t) && i+1 < lines.length && isSep(lines[i+1].trim())) {
      const ts=i; const tl=[]; while (i<lines.length && isTR(lines[i].trim())) { tl.push(lines[i].trim()); i++; }
      const [hdr,,...rows] = tl; const hdrs=parseRow(hdr);
      els.push(<div key={`t${ts}`} className={styles.tableWrap}><table className={styles.table}><thead><tr>{hdrs.map((h,j)=><th key={j}>{ri(h)}</th>)}</tr></thead><tbody>{rows.filter(r=>!isSep(r)).map((r,j)=><tr key={j}>{parseRow(r).map((c,k)=><td key={k}>{ri(c)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (t.startsWith("## "))        els.push(<h3 key={i} className={styles.h2}>{ri(t.slice(3))}</h3>);
    else if (t.startsWith("### "))  els.push(<h4 key={i} className={styles.h3}>{ri(t.slice(4))}</h4>);
    else if (t.startsWith("#### ")) els.push(<h5 key={i} className={styles.h4}>{ri(t.slice(5))}</h5>);
    else if (t.startsWith("- [ ] ")) els.push(<label key={i} className={styles.checkItem}><input type="checkbox" disabled/><span>{ri(t.slice(6))}</span></label>);
    else if (/^- \[[xX]\] /.test(t)) els.push(<label key={i} className={styles.checkItem}><input type="checkbox" disabled defaultChecked/><span>{ri(t.slice(6))}</span></label>);
    else if (t.startsWith("- ")||t.startsWith("* ")) els.push(<div key={i} className={styles.bullet}><span className={styles.dot}>•</span><span>{ri(t.slice(2))}</span></div>);
    else if (/^\d+\.\s/.test(t)) { const m=t.match(/^(\d+)\.\s(.*)$/); els.push(<div key={i} className={styles.numbered}><span className={styles.num}>{m[1]}.</span><span>{ri(m[2])}</span></div>); }
    else if (t==="---") els.push(<hr key={i} className={styles.hr}/>);
    else if (t==="") els.push(<div key={i} className={styles.spacer}/>);
    else els.push(<p key={i} className={styles.para}>{ri(t)}</p>);
    i++;
  }
  return <div className={styles.markdownBody}>{els}{loading && <span className={styles.cursor}>▋</span>}</div>;
}

// ── Tab configs ───────────────────────────────────────────────────────────────

const TABS = [
  { key: "overview",  label: "Overview",      ep: "/api/generate-visualise-overview" },
  { key: "mappings",  label: "Field Mappings", ep: "/api/generate-field-mappings" },
  { key: "checklist", label: "Checklist",      ep: "/api/generate-config-checklist" },
  { key: "failures",  label: "Failure Modes",  ep: "/api/generate-failure-modes" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function VisualisePanel({ flow, files, onClose }) {
  // Panel-local dark/light toggle — does NOT touch the global app theme
  const [isDark, setIsDark] = useState(true);
  function toggleTheme() { setIsDark(n => !n); }

  // Diagram — raw SVG from Mermaid, display SVG with processed dimensions
  const [diagramSyntax, setDiagramSyntax] = useState("");
  const [svg,           setSvg]           = useState(""); // raw from Mermaid
  const [displaySvg,    setDisplaySvg]    = useState(""); // processed (explicit dims)
  const [diagramLoading, setDiagramLoading] = useState(true);
  const [diagramError,   setDiagramError]   = useState("");
  const [direction,      setDirection]      = useState("LR");
  const [fullscreen,     setFullscreen]     = useState(false);
  const renderIdRef   = useRef(0);
  const abortDiagRef  = useRef(null);

  // Zoom / pan
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const txRef  = useRef({ scale: 1, x: 0, y: 0 });
  const drag   = useRef({ on: false, sx: 0, sy: 0, ox: 0, oy: 0 });
  const ctnRef = useRef(null);
  const svgRef = useRef(null);

  // Right panel
  const [tab,      setTab]     = useState("overview");
  const [tabDone,  setTabDone] = useState({});
  const ovS = useStream(); const mpS = useStream();
  const ckS = useStream(); const flS = useStream();
  const stS = useStream();
  const streamOf = { overview: ovS, mappings: mpS, checklist: ckS, failures: flS };

  // Node / step detail
  const [selNode, setSelNode]   = useState(null);
  const [prevTab, setPrevTab]   = useState("overview");
  const syntaxRef = useRef("");
  useEffect(() => { syntaxRef.current = diagramSyntax; }, [diagramSyntax]);
  const tabRef = useRef("overview");
  useEffect(() => { tabRef.current = tab; }, [tab]);

  // ── Generate diagram ────────────────────────────────────────────────────────

  async function genDiagram() {
    if (abortDiagRef.current) abortDiagRef.current.abort();
    const ctrl = new AbortController(); abortDiagRef.current = ctrl;
    setDiagramLoading(true); setDiagramSyntax(""); setSvg(""); setDisplaySvg(""); setDiagramError("");
    const form = new FormData();
    files.forEach(f => form.append("files", f));
    form.append("flow_json", JSON.stringify(flow));
    try {
      const res = await fetch("/api/generate-flow-diagram", { method: "POST", body: form, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = "", result = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const ln of lines) {
          if (!ln.startsWith("data: ")) continue;
          const ev = JSON.parse(ln.slice(6));
          if (ev.status === "chunk") result += ev.text;
          else if (ev.status === "done" && ev.prompt) result = ev.prompt;
          else if (ev.status === "error") { setDiagramError(ev.message); setDiagramLoading(false); return; }
        }
      }
      setDiagramSyntax(result);
    } catch (e) {
      if (e.name !== "AbortError") { setDiagramError(e.message); setDiagramLoading(false); }
    }
    // diagramLoading stays true until Mermaid rendering finishes (set in the render effect)
  }

  // ── Mermaid render ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!diagramSyntax) { setSvg(""); setDisplaySvg(""); return; }
    let cancelled = false;
    const syntax = direction === "TD"
      ? cleanSyntax(diagramSyntax).replace(/^flowchart\s+LR/m, "flowchart TD")
      : cleanSyntax(diagramSyntax).replace(/^flowchart\s+TD/m, "flowchart LR");
    renderIdRef.current += 1;
    const id = `vp-render-${renderIdRef.current}`;
    getMermaid().then(async mermaid => {
      if (cancelled) return;
      try {
        const { svg: out } = await mermaid.render(id, syntax);
        if (!cancelled) {
          setSvg(out);
          setDisplaySvg(processSvg(out));
          setDiagramLoading(false);
        }
      } catch (e) {
        if (!cancelled) { setDiagramError(`Render error: ${e.message}`); setDiagramLoading(false); }
      }
    });
    return () => { cancelled = true; };
  }, [diagramSyntax, direction]);

  // ── Auto-fit using viewBox.baseVal (fires before paint) ────────────────────

  useLayoutEffect(() => {
    if (!displaySvg || !svgRef.current || !ctnRef.current) return;
    const svgEl = svgRef.current.querySelector("svg");
    if (!svgEl) return;
    const vb = svgEl.viewBox?.baseVal;
    const sw = vb?.width || 0;
    const sh = vb?.height || 0;
    const cw = ctnRef.current.clientWidth;
    const ch = ctnRef.current.clientHeight;
    if (!sw || !sh || !cw || !ch) return;
    const PAD = 40;
    const scale = Math.min((cw - PAD) / sw, (ch - PAD) / sh);
    const next = { scale, x: (cw - sw * scale) / 2, y: (ch - sh * scale) / 2 };
    txRef.current = next;
    setTransform(next);
  }, [displaySvg]);

  // ── Node click handlers (after SVG is in DOM) ───────────────────────────────

  useEffect(() => {
    if (!displaySvg || !svgRef.current) return;
    const nodes = Array.from(svgRef.current.querySelectorAll(".node"));
    nodes.forEach(n => { n.style.cursor = "pointer"; });
    const handlers = nodes.map(node => {
      const h = () => {
        const label =
          node.querySelector(".nodeLabel")?.textContent?.trim() ||
          node.querySelector("foreignObject span")?.textContent?.trim() ||
          node.querySelector("text")?.textContent?.trim() ||
          node.id.replace(/^flowchart-/,"").replace(/-\d+$/,"").replace(/_/g," ");
        if (!label) return;
        setPrevTab(tabRef.current);
        setSelNode({ id: node.id, label });
        stS.reset();
        stS.run("/api/generate-step-detail", files, flow, {
          node_label: label,
          diagram_syntax: cleanSyntax(syntaxRef.current),
        });
      };
      node.addEventListener("click", h);
      return { node, h };
    });
    return () => handlers.forEach(({ node, h }) => node.removeEventListener("click", h));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displaySvg]);

  // ── Tab generation ──────────────────────────────────────────────────────────

  function genTab(key) {
    const cfg = TABS.find(t => t.key === key);
    if (!cfg) return;
    streamOf[key].run(cfg.ep, files, flow);
    setTabDone(d => ({ ...d, [key]: true }));
  }

  useEffect(() => {
    genDiagram();
    genTab("overview");
    setTabDone({ overview: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchTab(key) {
    setTab(key); setSelNode(null);
    if (!tabDone[key]) genTab(key);
  }

  // ── Zoom / pan ──────────────────────────────────────────────────────────────

  function onWheel(e) {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 0.88;
    setTransform(t => { const n = { ...t, scale: Math.max(0.05, Math.min(10, t.scale * f)) }; txRef.current = n; return n; });
  }
  function onMD(e) {
    if (e.button !== 0) return; e.preventDefault();
    drag.current = { on: true, sx: e.clientX, sy: e.clientY, ox: txRef.current.x, oy: txRef.current.y };
  }
  function onMM(e) {
    if (!drag.current.on) return;
    setTransform(t => { const n = { ...t, x: drag.current.ox + (e.clientX - drag.current.sx), y: drag.current.oy + (e.clientY - drag.current.sy) }; txRef.current = n; return n; });
  }
  function onMU() { drag.current.on = false; }

  function downloadAsPng() {
    if (!svgRef.current) return;
    const liveSvg = svgRef.current.querySelector("svg");
    if (!liveSvg) return;

    // Clone so mutations don't affect the displayed diagram
    const clone = liveSvg.cloneNode(true);

    // The CSS module styles (fill: #1e3f72 !important on .node rect, etc.) only
    // apply in the browser DOM — not when the SVG is drawn to a canvas. Fix: read
    // the browser-computed (CSS-overridden) fill/stroke from the live elements and
    // bake them as inline styles into the clone so the canvas sees the correct colors.
    const SHAPE_TAGS = new Set(["rect","ellipse","circle","polygon","polyline","path","line","text","tspan"]);
    const liveAll  = liveSvg.querySelectorAll("*");
    const cloneAll = clone.querySelectorAll("*");
    liveAll.forEach((liveEl, i) => {
      const cloneEl = cloneAll[i];
      if (!cloneEl || !SHAPE_TAGS.has(liveEl.tagName.toLowerCase())) return;
      const cs = window.getComputedStyle(liveEl);
      const fill = cs.getPropertyValue("fill");
      const stroke = cs.getPropertyValue("stroke");
      const sw = cs.getPropertyValue("stroke-width");
      if (fill !== "") cloneEl.style.setProperty("fill", fill);
      if (stroke !== "") cloneEl.style.setProperty("stroke", stroke);
      if (sw !== "") cloneEl.style.setProperty("stroke-width", sw);
    });

    // Browsers block canvas.toDataURL() when the SVG contains <foreignObject>.
    // Replace each one with a plain SVG <text> element at the same centre point.
    clone.querySelectorAll("foreignObject").forEach(fo => {
      const text = (fo.textContent || "").replace(/\s+/g, " ").trim();
      const x = parseFloat(fo.getAttribute("x") || "0") + parseFloat(fo.getAttribute("width") || "0") / 2;
      const y = parseFloat(fo.getAttribute("y") || "0") + parseFloat(fo.getAttribute("height") || "0") / 2;
      if (!text) { fo.remove(); return; }
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", String(x));
      t.setAttribute("y", String(y));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dominant-baseline", "central");
      t.setAttribute("fill", "#d4dce8");
      t.setAttribute("font-size", "13");
      t.setAttribute("font-family", "Lexend, Arial, sans-serif");
      t.textContent = text;
      fo.parentNode?.replaceChild(t, fo);
    });

    const vb = liveSvg.viewBox?.baseVal;
    const w = vb?.width || 1200;
    const h = vb?.height || 600;
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale; canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#0c0f1a";
    ctx.fillRect(0, 0, w, h);

    const serialized = new XMLSerializer().serializeToString(clone);
    const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, w, h);
      const a = document.createElement("a");
      a.download = `${flow.name}-iflow.png`;
      a.href = canvas.toDataURL("image/png");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
    img.onerror = () => {
      const blob = new Blob([serialized], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.download = `${flow.name}-iflow.svg`;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };
    img.src = encoded;
  }

  function fitFromDom() {
    if (!svgRef.current || !ctnRef.current) return;
    const svgEl = svgRef.current.querySelector("svg");
    if (!svgEl) return;
    const vb = svgEl.viewBox?.baseVal;
    const sw = vb?.width || 0; const sh = vb?.height || 0;
    const cw = ctnRef.current.clientWidth; const ch = ctnRef.current.clientHeight;
    if (!sw || !sh || !cw || !ch) return;
    const PAD = 40;
    const scale = Math.min((cw - PAD) / sw, (ch - PAD) / sh);
    const n = { scale, x: (cw - sw * scale) / 2, y: (ch - sh * scale) / 2 };
    txRef.current = n; setTransform(n);
  }
  function resetZoom() { const n = { scale:1, x:0, y:0 }; txRef.current=n; setTransform(n); }
  function toggleDir()  { setDirection(d => d === "LR" ? "TD" : "LR"); }

  const isBusy = diagramLoading || (!displaySvg && !diagramError);
  const activeStream = selNode ? stS : (streamOf[tab] || ovS);

  return (
    <div className={`${styles.panel} ${isDark ? styles.panelDark : styles.panelLight}`}>

      {/* Header */}
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onClose}><ArrowLeft size={14}/> Back to flows</button>
        <div className={styles.headerCenter}>
          <GitBranch size={14} className={styles.headerIcon}/>
          <span className={styles.flowName}>{flow.name}</span>
          <span className={styles.dirBadge} style={badgeStyle(flow.direction)}>{flow.direction}</span>
        </div>
        <div className={styles.headerControls}>
          <button className={`${styles.ctrlBtn} ${direction==="TD"?styles.ctrlActive:""}`} onClick={toggleDir} title="Toggle layout">
            {direction==="LR" ? <LayoutGrid size={13}/> : <AlignLeft size={13}/>}
            {direction==="LR" ? "Top-Down" : "Left-Right"}
          </button>
          <button className={styles.ctrlBtn} onClick={fitFromDom}  title="Fit to screen"><Maximize2 size={13}/> Fit</button>
          <button className={styles.ctrlBtn} onClick={resetZoom}   title="Reset zoom">  <Minimize2 size={13}/> Reset</button>
          <button className={`${styles.ctrlBtn} ${styles.ctrlRegen}`} onClick={genDiagram} disabled={isBusy} title="Regenerate">
            <RefreshCw size={13} className={isBusy ? styles.spin : ""}/>
            {isBusy ? "Generating…" : "Regenerate"}
          </button>
          <button className={`${styles.ctrlBtn} ${styles.ctrlDl}`} onClick={downloadAsPng} disabled={!displaySvg} title="Download diagram as PNG">
            <Download size={13}/> PNG
          </button>
          <span className={styles.zoomPct}>{Math.round(transform.scale * 100)}%</span>
          <div className={styles.ctrlDiv}/>
          <button className={styles.themeBtn} onClick={toggleTheme} title={isDark ? "Switch to light mode" : "Switch to dark mode"}>
            {isDark ? <Sun size={14}/> : <Moon size={14}/>}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className={styles.body}>

        {/* ── Left: diagram canvas ── */}
        <div className={styles.diagArea} ref={ctnRef}
          style={{ background: "#0c0f1a" }}
          onWheel={onWheel} onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onMU}>

          {/* Animated top bar while streaming */}
          {diagramLoading && <div className={styles.loadBar}/>}

          {/* Loading / error spinner */}
          {isBusy && (
            <div className={styles.stateBox}>
              <Loader2 size={32} className={styles.spin} style={{ color: "#4a9eff" }}/>
              <span className={styles.stateText}>
                {diagramLoading ? "Generating iFlow diagram…" : "Rendering diagram…"}
              </span>
            </div>
          )}
          {!isBusy && diagramError && (
            <div className={styles.stateBox}>
              <AlertCircle size={26} style={{ color: "var(--error)" }}/>
              <span className={styles.stateText} style={{ color: "var(--error)" }}>{diagramError}</span>
            </div>
          )}

          {/* SVG — always in DOM, React owns content via dangerouslySetInnerHTML */}
          <div
            ref={svgRef}
            className={styles.diagInner}
            style={{ transform: `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})` }}
            dangerouslySetInnerHTML={{ __html: displaySvg }}
          />

          {/* Expand to fullscreen button */}
          {displaySvg && (
            <button className={styles.expandBtn} onClick={() => setFullscreen(true)} title="View fullscreen">
              <Expand size={14}/>
            </button>
          )}

          {displaySvg && <div className={styles.diagHint}><MousePointer2 size={11}/> Drag to pan · Scroll to zoom · Click node for details</div>}
        </div>

        {/* ── Right: context panel ── */}
        <div className={styles.rightPanel}>
          <div className={styles.tabBar}>
            {selNode ? (
              <button className={styles.stepBack} onClick={() => setSelNode(null)}>
                <ChevronLeft size={13}/> {prevTab.charAt(0).toUpperCase()+prevTab.slice(1)}
              </button>
            ) : TABS.map(({ key, label }) => (
              <button key={key}
                className={`${styles.rtab} ${tab===key?styles.rtabActive:""}`}
                onClick={() => switchTab(key)}>
                {label}{tabDone[key] && <span className={styles.tabDot}/>}
              </button>
            ))}
          </div>
          <div className={styles.rightContent}>
            {selNode ? (
              <div className={styles.stepWrap}>
                <div className={styles.stepHdr}>
                  <GitBranch size={13} className={styles.stepIcon}/>
                  <span className={styles.stepLbl}>{selNode.label}</span>
                </div>
                {stS.error && <div className={styles.rpErr}><AlertCircle size={14}/> {stS.error}</div>}
                <MD text={stS.text} loading={stS.loading}/>
              </div>
            ) : (
              <>
                {activeStream.error && <div className={styles.rpErr}><AlertCircle size={14}/> {activeStream.error}</div>}
                {!activeStream.text && activeStream.loading && <div className={styles.rpLoading}><Loader2 size={16} className={styles.spin}/> Generating…</div>}
                {!activeStream.text && !activeStream.loading && !activeStream.error && (
                  <div className={styles.rpEmpty}><p>Click a tab to generate content</p></div>
                )}
                <MD text={activeStream.text} loading={activeStream.loading}/>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Fullscreen overlay ── */}
      {fullscreen && (
        <div className={styles.fsOverlay} onClick={() => setFullscreen(false)}>
          <div className={styles.fsBox} onClick={e => e.stopPropagation()}>
            <button className={styles.fsClose} onClick={() => setFullscreen(false)}>✕</button>
            <div className={styles.fsDiagram} dangerouslySetInnerHTML={{ __html: displaySvg }}/>
          </div>
        </div>
      )}
    </div>
  );
}
