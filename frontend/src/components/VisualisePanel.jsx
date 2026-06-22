import { useEffect, useRef, useState, useCallback } from "react";
import {
  ArrowLeft, GitBranch, Maximize2, Minimize2, RefreshCw,
  ChevronLeft, MousePointer2,
  Loader2, AlertCircle, Expand, Download,
} from "lucide-react";
import { badgeStyle } from "./dirBadge.js";
import styles from "./VisualisePanel.module.css";

// ── bpmn-js + auto-layout lazy loaders ────────────────────────────────────────

let _BpmnViewer = null;
async function getBpmnViewer() {
  if (_BpmnViewer) return _BpmnViewer;
  const { default: BV } = await import("bpmn-js/lib/NavigatedViewer");
  await import("bpmn-js/dist/assets/diagram-js.css");
  await import("bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css");
  _BpmnViewer = BV;
  return BV;
}

function cleanXml(raw) {
  return raw.trim()
    .replace(/^```(?:xml)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

// Scale all coordinate/size attributes in the BPMNDiagram section so elements
// are large enough for labels. bpmn-auto-layout hardcodes tasks at 100×80px
// which is too small — scaling by 1.6 gives 160×128px tasks with room to breathe.
function scaleBpmnDiagram(xml, factor) {
  const marker = "<bpmndi:BPMNDiagram";
  const start = xml.indexOf(marker);
  if (start === -1) return xml;
  const head = xml.slice(0, start);
  const diagram = xml.slice(start).replace(
    /(x|y|width|height)="([\d.]+)"/g,
    (_, attr, val) => `${attr}="${Math.round(parseFloat(val) * factor)}"`
  );
  return head + diagram;
}

async function applyAutoLayout(xml) {
  const { layoutProcess } = await import("bpmn-auto-layout");
  const laid = await layoutProcess(xml);
  return scaleBpmnDiagram(laid, 1.6);
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

// Clickable BPMN element types for step-detail drill-down
const CLICKABLE_TYPES = new Set([
  "bpmn:Task", "bpmn:UserTask", "bpmn:ServiceTask", "bpmn:ScriptTask",
  "bpmn:SendTask", "bpmn:ReceiveTask", "bpmn:BusinessRuleTask",
  "bpmn:ExclusiveGateway", "bpmn:ParallelGateway", "bpmn:InclusiveGateway",
  "bpmn:SubProcess", "bpmn:CallActivity",
  "bpmn:StartEvent", "bpmn:EndEvent", "bpmn:BoundaryEvent",
  "bpmn:IntermediateCatchEvent", "bpmn:IntermediateThrowEvent",
]);

// ── Component ─────────────────────────────────────────────────────────────────

export default function VisualisePanel({ flow, files, onClose }) {
  // Mirror the global app theme (data-theme on <html>)
  const [isDark, setIsDark] = useState(() => document.documentElement.dataset.theme !== "light");
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.dataset.theme !== "light")
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Diagram canvas background
  const [diagBg, setDiagBg] = useState(() => localStorage.getItem(BG_KEY) || "#0c0f1a");
  useEffect(() => { localStorage.setItem(BG_KEY, diagBg); }, [diagBg]);

  // Diagram state
  const [bpmnXml,        setBpmnXml]        = useState("");
  const [diagramLoading, setDiagramLoading] = useState(true);
  const [diagramError,   setDiagramError]   = useState("");
  const [fullscreen,     setFullscreen]     = useState(false);
  const [zoomPct,        setZoomPct]        = useState(100);
  const [fsZoomPct,      setFsZoomPct]      = useState(100);
  const abortDiagRef = useRef(null);

  // bpmn-js viewer refs
  const mainContainerRef = useRef(null);
  const mainViewerRef    = useRef(null);
  const fsContainerRef   = useRef(null);
  const fsViewerRef      = useRef(null);

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
  const tabRef = useRef("overview");
  useEffect(() => { tabRef.current = tab; }, [tab]);

  // ── Generate diagram ────────────────────────────────────────────────────────

  async function genDiagram() {
    if (abortDiagRef.current) abortDiagRef.current.abort();
    const ctrl = new AbortController(); abortDiagRef.current = ctrl;
    setDiagramLoading(true); setBpmnXml(""); setDiagramError("");
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
      const rawXml = cleanXml(result);
      try {
        const laidXml = await applyAutoLayout(rawXml);
        setBpmnXml(laidXml);
      } catch (e) {
        setDiagramError(`Layout error: ${e.message}`);
        setDiagramLoading(false);
      }
    } catch (e) {
      if (e.name !== "AbortError") { setDiagramError(e.message); setDiagramLoading(false); }
    }
  }

  // ── bpmn-js viewer init ─────────────────────────────────────────────────────

  async function initViewer(containerEl, viewerRef, xml, onZoom, isMain, isCancelled) {
    if (viewerRef.current) { viewerRef.current.destroy(); viewerRef.current = null; }
    if (!containerEl || !xml) return;
    try {
      const BpmnViewer = await getBpmnViewer();
      if (isCancelled()) return;
      const viewer = new BpmnViewer({ container: containerEl });
      viewerRef.current = viewer;

      viewer.get("eventBus").on("canvas.viewbox.changed", () => {
        const z = viewer.get("canvas").zoom();
        onZoom(Math.round(z * 100));
      });

      if (isMain) {
        viewer.get("eventBus").on("element.click", (event) => {
          const el = event.element;
          const bo = el.businessObject;
          if (!bo?.name || !CLICKABLE_TYPES.has(el.type)) return;
          setPrevTab(tabRef.current);
          setSelNode({ id: el.id, label: bo.name });
          stS.reset();
          stS.run("/api/generate-step-detail", files, flow, { node_label: bo.name });
        });
      }

      await viewer.importXML(xml);
      if (isCancelled()) { viewer.destroy(); viewerRef.current = null; return; }
      viewer.get("canvas").zoom("fit-viewport");
      if (isMain) setDiagramLoading(false);
    } catch (e) {
      if (!isCancelled() && isMain) { setDiagramError(`Render error: ${e.message}`); setDiagramLoading(false); }
    }
  }

  // ── Viewer lifecycle effects ────────────────────────────────────────────────

  useEffect(() => {
    if (!bpmnXml || !mainContainerRef.current) return;
    let cancelled = false;
    initViewer(mainContainerRef.current, mainViewerRef, bpmnXml, setZoomPct, true, () => cancelled);
    return () => {
      cancelled = true;
      if (mainViewerRef.current) { mainViewerRef.current.destroy(); mainViewerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpmnXml]);

  useEffect(() => {
    if (!fullscreen || !bpmnXml) return;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (!fsContainerRef.current || cancelled) return;
      initViewer(fsContainerRef.current, fsViewerRef, bpmnXml, setFsZoomPct, false, () => cancelled);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      if (fsViewerRef.current) { fsViewerRef.current.destroy(); fsViewerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, bpmnXml]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mainViewerRef.current) mainViewerRef.current.destroy();
      if (fsViewerRef.current) fsViewerRef.current.destroy();
    };
  }, []);

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

  // ── Viewer controls ─────────────────────────────────────────────────────────

  function fitView()   { mainViewerRef.current?.get("canvas").zoom("fit-viewport"); }
  function resetZoom() { mainViewerRef.current?.get("canvas").zoom(1); }
  function fsFit()     { fsViewerRef.current?.get("canvas").zoom("fit-viewport"); }

  async function downloadAsPng() {
    if (!mainViewerRef.current) return;
    try {
      const { svg } = await mainViewerRef.current.saveSVG();
      const blob = new Blob([svg], { type: "image/svg+xml" });
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
    } catch (e) { console.error("Download failed", e); }
  }

  const isBusy = diagramLoading || (!bpmnXml && !diagramError);
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
          <button className={styles.ctrlBtn} onClick={fitView}    title="Fit to screen"><Maximize2 size={13}/> Fit</button>
          <button className={styles.ctrlBtn} onClick={resetZoom}  title="Reset zoom">  <Minimize2 size={13}/> Reset</button>
          <button className={`${styles.ctrlBtn} ${styles.ctrlRegen}`} onClick={genDiagram} disabled={isBusy} title="Regenerate">
            <RefreshCw size={13} className={isBusy ? styles.spin : ""}/>
            {isBusy ? "Generating…" : "Regenerate"}
          </button>
          <button className={`${styles.ctrlBtn} ${styles.ctrlDl}`} onClick={downloadAsPng} disabled={!bpmnXml} title="Download diagram as PNG">
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
          {/* Loading bar while streaming */}
          {diagramLoading && <div className={styles.loadBar}/>}

          {/* Loading / error overlay */}
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

          {/* bpmn-js renders into this container */}
          <div ref={mainContainerRef} className={styles.bpmnCanvas}/>

          {/* Expand to fullscreen button */}
          {bpmnXml && !diagramError && (
            <button className={styles.expandBtn} onClick={() => setFullscreen(true)} title="View fullscreen">
              <Expand size={14}/>
            </button>
          )}

          {bpmnXml && !diagramError && (
            <div className={styles.diagHint}><MousePointer2 size={11}/> Drag to pan · Scroll to zoom · Click element for details</div>
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
              <button className={styles.fsFitBtn} onClick={fsFit}>Fit</button>
              <button className={styles.fsClose} onClick={() => setFullscreen(false)}>✕</button>
            </div>
            <div
              className={styles.fsDiagWrap}
              style={{ backgroundColor: diagBg, backgroundImage: getDotGrid(diagBg), backgroundSize: "20px 20px" }}
            >
              <div ref={fsContainerRef} className={styles.bpmnCanvas}/>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
