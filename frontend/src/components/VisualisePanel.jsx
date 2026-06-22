import { useEffect, useRef, useState, useCallback } from "react";
import {
  ArrowLeft, GitBranch, Maximize2, Minimize2, RefreshCw,
  ChevronLeft, MousePointer2,
  Loader2, AlertCircle, Expand, Download,
} from "lucide-react";
import { badgeStyle } from "./dirBadge.js";
import styles from "./VisualisePanel.module.css";

// ── Mermaid lazy loader ───────────────────────────────────────────────────────

let _mermaid = null;
async function getMermaid() {
  if (_mermaid) return _mermaid;
  const m = await import("mermaid");
  _mermaid = m.default;
  _mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "loose",
    flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis" },
    fontSize: 14,
  });
  return _mermaid;
}

function cleanSyntax(raw) {
  return raw.trim()
    .replace(/^```(?:mermaid)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

async function renderMermaid(syntax, containerId) {
  const m = await getMermaid();
  const { svg } = await m.render(containerId, syntax);
  return svg;
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

// ── Background presets ────────────────────────────────────────────────────────

const BG_PRESETS = [
  { id: "void",  color: "#060606", label: "Void"  },
  { id: "navy",  color: "#0c0f1a", label: "Navy"  },
  { id: "dusk",  color: "#131929", label: "Dusk"  },
  { id: "cloud", color: "#eef1f8", label: "Cloud" },
  { id: "white", color: "#ffffff", label: "White" },
];
function getDotGrid(color) {
  const r = parseInt(color.slice(1, 3), 16) || 0;
  const g = parseInt(color.slice(3, 5), 16) || 0;
  const b = parseInt(color.slice(5, 7), 16) || 0;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const dot = lum > 0.35 ? "rgba(30,50,120,0.22)" : "rgba(255,255,255,0.22)";
  return `radial-gradient(circle, ${dot} 1.5px, transparent 1.5px)`;
}
const BG_KEY = "orbit-diag-bg";

// ── Tab configs ───────────────────────────────────────────────────────────────

const TABS = [
  { key: "overview",  label: "Overview",      ep: "/api/generate-visualise-overview" },
  { key: "mappings",  label: "Field Mappings", ep: "/api/generate-field-mappings" },
  { key: "checklist", label: "Checklist",      ep: "/api/generate-config-checklist" },
  { key: "failures",  label: "Failure Modes",  ep: "/api/generate-failure-modes" },
];

// ── SVG pan/zoom helper ───────────────────────────────────────────────────────

function usePanZoom(svgWrapRef) {
  const stateRef = useRef({ scale: 1, tx: 0, ty: 0, dragging: false, sx: 0, sy: 0 });

  const applyTransform = useCallback(() => {
    const el = svgWrapRef.current?.querySelector("svg");
    if (!el) return;
    const { scale, tx, ty } = stateRef.current;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    el.style.transformOrigin = "0 0";
  }, [svgWrapRef]);

  const getZoomPct = useCallback(() => Math.round(stateRef.current.scale * 100), []);

  const fitToContainer = useCallback(() => {
    const wrap = svgWrapRef.current;
    const svg  = wrap?.querySelector("svg");
    if (!wrap || !svg) return;
    const sw = svg.viewBox.baseVal.width  || svg.getBoundingClientRect().width;
    const sh = svg.viewBox.baseVal.height || svg.getBoundingClientRect().height;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    if (!sw || !sh) return;
    const scale = Math.min(cw / sw, ch / sh) * 0.9;
    stateRef.current.scale = scale;
    stateRef.current.tx = (cw - sw * scale) / 2;
    stateRef.current.ty = (ch - sh * scale) / 2;
    applyTransform();
    return Math.round(scale * 100);
  }, [svgWrapRef, applyTransform]);

  const resetZoom = useCallback(() => {
    stateRef.current = { ...stateRef.current, scale: 1, tx: 0, ty: 0 };
    applyTransform();
  }, [applyTransform]);

  const attachHandlers = useCallback((onZoomChange) => {
    const wrap = svgWrapRef.current;
    if (!wrap) return () => {};

    function onWheel(e) {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const delta = e.deltaY < 0 ? 1.1 : 0.91;
      const s = stateRef.current;
      const ns = Math.max(0.1, Math.min(5, s.scale * delta));
      s.tx = mx - (mx - s.tx) * (ns / s.scale);
      s.ty = my - (my - s.ty) * (ns / s.scale);
      s.scale = ns;
      applyTransform();
      onZoomChange(Math.round(ns * 100));
    }

    function onMouseDown(e) {
      if (e.button !== 0) return;
      const s = stateRef.current;
      s.dragging = true; s.sx = e.clientX - s.tx; s.sy = e.clientY - s.ty;
      wrap.style.cursor = "grabbing";
    }
    function onMouseMove(e) {
      const s = stateRef.current;
      if (!s.dragging) return;
      s.tx = e.clientX - s.sx; s.ty = e.clientY - s.sy;
      applyTransform();
    }
    function onMouseUp() {
      stateRef.current.dragging = false;
      wrap.style.cursor = "grab";
    }

    wrap.addEventListener("wheel", onWheel, { passive: false });
    wrap.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    wrap.style.cursor = "grab";

    return () => {
      wrap.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [svgWrapRef, applyTransform]);

  return { fitToContainer, resetZoom, attachHandlers, getZoomPct };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function VisualisePanel({ flow, files, onClose }) {
  const [isDark, setIsDark] = useState(() => document.documentElement.dataset.theme !== "light");
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.dataset.theme !== "light")
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  const [diagBg, setDiagBg] = useState(() => localStorage.getItem(BG_KEY) || "#0c0f1a");
  useEffect(() => { localStorage.setItem(BG_KEY, diagBg); }, [diagBg]);

  // Diagram state
  const [displaySvg,     setDisplaySvg]     = useState("");
  const [fsSvg,          setFsSvg]          = useState("");
  const [diagramLoading, setDiagramLoading] = useState(true);
  const [diagramError,   setDiagramError]   = useState("");
  const [fullscreen,     setFullscreen]     = useState(false);
  const [zoomPct,        setZoomPct]        = useState(100);
  const [fsZoomPct,      setFsZoomPct]      = useState(100);
  const abortDiagRef = useRef(null);

  // Pan/zoom refs
  const mainWrapRef = useRef(null);
  const fsWrapRef   = useRef(null);
  const mainPZ = usePanZoom(mainWrapRef);
  const fsPZ   = usePanZoom(fsWrapRef);

  // Right panel
  const [tab,      setTab]     = useState("overview");
  const [tabDone,  setTabDone] = useState({});
  const ovS = useStream(); const mpS = useStream();
  const ckS = useStream(); const flS = useStream();
  const stS = useStream();
  const streamOf = { overview: ovS, mappings: mpS, checklist: ckS, failures: flS };

  const [selNode, setSelNode] = useState(null);
  const [prevTab, setPrevTab] = useState("overview");
  const tabRef = useRef("overview");
  useEffect(() => { tabRef.current = tab; }, [tab]);

  // ── Generate diagram ────────────────────────────────────────────────────────

  async function genDiagram() {
    if (abortDiagRef.current) abortDiagRef.current.abort();
    const ctrl = new AbortController(); abortDiagRef.current = ctrl;
    setDiagramLoading(true); setDisplaySvg(""); setFsSvg(""); setDiagramError("");
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
      const syntax = cleanSyntax(result);
      try {
        const svg = await renderMermaid(syntax, `mm-main-${Date.now()}`);
        setDisplaySvg(svg);
        setFsSvg(svg);
        setDiagramLoading(false);
      } catch (e) {
        setDiagramError(`Diagram render error: ${e.message}`);
        setDiagramLoading(false);
      }
    } catch (e) {
      if (e.name !== "AbortError") { setDiagramError(e.message); setDiagramLoading(false); }
    }
  }

  // ── Fit diagram after SVG injected ─────────────────────────────────────────

  useEffect(() => {
    if (!displaySvg || !mainWrapRef.current) return;
    // Wait one frame for DOM to paint the injected SVG
    const id = requestAnimationFrame(() => {
      const pct = mainPZ.fitToContainer();
      if (pct) setZoomPct(pct);
      mainPZ.attachHandlers(setZoomPct);
    });
    return () => cancelAnimationFrame(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displaySvg]);

  useEffect(() => {
    if (!fullscreen || !fsSvg || !fsWrapRef.current) return;
    const id = requestAnimationFrame(() => {
      const pct = fsPZ.fitToContainer();
      if (pct) setFsZoomPct(pct);
      fsPZ.attachHandlers(setFsZoomPct);
    });
    return () => cancelAnimationFrame(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, fsSvg]);

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

  // ── Download ────────────────────────────────────────────────────────────────

  function downloadAsPng() {
    if (!displaySvg) return;
    const blob = new Blob([displaySvg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const w = img.naturalWidth || 1200;
      const h = img.naturalHeight || 600;
      const canvas = document.createElement("canvas");
      canvas.width = w * scale; canvas.height = h * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.fillStyle = diagBg;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const a = document.createElement("a");
      a.download = `${flow.name}-iflow.png`;
      a.href = canvas.toDataURL("image/png");
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      const a = document.createElement("a");
      a.download = `${flow.name}-iflow.svg`;
      a.href = url;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    };
    img.src = url;
  }

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
          <button className={styles.ctrlBtn} onClick={() => { const p = mainPZ.fitToContainer(); if (p) setZoomPct(p); }} title="Fit to screen"><Maximize2 size={13}/> Fit</button>
          <button className={styles.ctrlBtn} onClick={() => { mainPZ.resetZoom(); setZoomPct(100); }} title="Reset zoom"><Minimize2 size={13}/> Reset</button>
          <button className={`${styles.ctrlBtn} ${styles.ctrlRegen}`} onClick={genDiagram} disabled={isBusy} title="Regenerate">
            <RefreshCw size={13} className={isBusy ? styles.spin : ""}/>
            {isBusy ? "Generating…" : "Regenerate"}
          </button>
          <button className={`${styles.ctrlBtn} ${styles.ctrlDl}`} onClick={downloadAsPng} disabled={!displaySvg} title="Download diagram as PNG">
            <Download size={13}/> PNG
          </button>
          <div className={styles.ctrlDiv}/>
          <div className={styles.bgSwatches}>
            {BG_PRESETS.map(p => (
              <button
                key={p.id}
                className={`${styles.bgSwatch} ${diagBg === p.color ? styles.bgSwatchActive : ""}`}
                style={{ background: p.color }}
                onClick={() => setDiagBg(p.color)}
                title={p.label}
              />
            ))}
          </div>
          <span className={styles.zoomPct}>{zoomPct}%</span>
        </div>
      </div>

      {/* Body */}
      <div className={styles.body}>

        {/* ── Left: diagram canvas ── */}
        <div
          className={styles.diagArea}
          style={{ backgroundColor: diagBg, backgroundImage: getDotGrid(diagBg), backgroundSize: "20px 20px" }}
        >
          {diagramLoading && <div className={styles.loadBar}/>}

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

          {/* Mermaid SVG pan/zoom container */}
          <div
            ref={mainWrapRef}
            className={styles.diagInner}
            dangerouslySetInnerHTML={displaySvg ? { __html: displaySvg } : undefined}
          />

          {displaySvg && !diagramError && (
            <button className={styles.expandBtn} onClick={() => setFullscreen(true)} title="View fullscreen">
              <Expand size={14}/>
            </button>
          )}

          {displaySvg && !diagramError && (
            <div className={styles.diagHint}><MousePointer2 size={11}/> Drag to pan · Scroll to zoom</div>
          )}
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
            <div className={styles.fsHeader}>
              <span className={styles.fsZoom}>{fsZoomPct}%</span>
              <button className={styles.fsFitBtn} onClick={() => { const p = fsPZ.fitToContainer(); if (p) setFsZoomPct(p); }}>Fit</button>
              <button className={styles.fsClose} onClick={() => setFullscreen(false)}>✕</button>
            </div>
            <div
              className={styles.fsDiagWrap}
              style={{ backgroundColor: diagBg, backgroundImage: getDotGrid(diagBg), backgroundSize: "20px 20px" }}
            >
              <div
                ref={fsWrapRef}
                className={styles.fsDiagInner}
                dangerouslySetInnerHTML={fsSvg ? { __html: fsSvg } : undefined}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
