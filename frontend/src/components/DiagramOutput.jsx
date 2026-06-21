import { useEffect, useRef, useState } from "react";
import { Copy, Check, Download, GitBranch, Maximize2, X } from "lucide-react";
import styles from "./DiagramOutput.module.css";

// Mermaid diagram background — always use this dark surface so the SVG looks
// the same whether the app is in light or dark theme.
const DIAGRAM_BG = "#0c0f1a";

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
      mainBkg:             DIAGRAM_BG,
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
  return raw
    .trim()
    .replace(/^```(?:mermaid)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

// ── Fullscreen lightbox ───────────────────────────────────────────────────────

function Lightbox({ svg, onClose }) {
  useEffect(() => {
    function handleKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.overlayContent} onClick={e => e.stopPropagation()}>
        <button className={styles.overlayClose} onClick={onClose} title="Close (Esc)">
          <X size={18} />
        </button>
        <div
          className={styles.overlayDiagram}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DiagramOutput({ diagram, loading, toast }) {
  const [svg, setSvg]               = useState("");
  const [renderError, setRenderError] = useState("");
  const [copied, setCopied]         = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const renderIdRef                 = useRef(0);

  const syntax = cleanSyntax(diagram);

  useEffect(() => {
    if (loading || !syntax) {
      setSvg("");
      setRenderError("");
      return;
    }

    let cancelled = false;
    renderIdRef.current += 1;
    const id = `mermaid-render-${renderIdRef.current}`;

    getMermaid().then(async mermaid => {
      if (cancelled) return;
      try {
        const { svg: rendered } = await mermaid.render(id, syntax);
        if (!cancelled) { setSvg(rendered); setRenderError(""); }
      } catch (err) {
        if (!cancelled) { setRenderError(err.message || "Failed to render diagram"); setSvg(""); }
      }
    });

    return () => { cancelled = true; };
  }, [syntax, loading]);

  async function handleCopy() {
    await navigator.clipboard.writeText(syntax);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast?.("Mermaid syntax copied!", "success");
  }

  function handleDownload() {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "iflow-diagram.svg"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className={styles.container}>
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <GitBranch size={13} className={styles.icon} />
            <span className={styles.label}>iFlow Diagram</span>
            {syntax && !loading && !renderError && (
              <span className={styles.hint}>Mermaid flowchart</span>
            )}
          </div>
          <div className={styles.toolbarRight}>
            {svg && (
              <button
                className={`${styles.actionBtn} ${styles.expandBtn}`}
                onClick={() => setFullscreen(true)}
                title="View full screen"
              >
                <Maximize2 size={12} /> Expand
              </button>
            )}
            <button
              className={`${styles.actionBtn} ${copied ? styles.copied : ""}`}
              onClick={handleCopy}
              disabled={!syntax || loading}
              title="Copy Mermaid syntax"
            >
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy syntax</>}
            </button>
            {svg && (
              <button className={`${styles.actionBtn} ${styles.exportBtn}`} onClick={handleDownload} title="Export as SVG">
                <Download size={12} /> Export SVG
              </button>
            )}
          </div>
        </div>

        <div className={styles.body}>
          {loading && (
            <div className={styles.loading}>
              <span className={styles.spinner} />
              <span>Generating diagram…</span>
            </div>
          )}

          {!loading && !syntax && (
            <div className={styles.empty}>
              <GitBranch size={28} strokeWidth={1.4} className={styles.emptyIcon} />
              <p className={styles.emptyTitle}>No diagram yet</p>
            </div>
          )}

          {!loading && syntax && renderError && (
            <div className={styles.errorWrap}>
              <p className={styles.errorTitle}>Render error — raw Mermaid syntax:</p>
              <pre className={styles.rawSyntax}>{syntax}</pre>
            </div>
          )}

          {!loading && svg && !renderError && (
            <div className={styles.diagram} dangerouslySetInnerHTML={{ __html: svg }} />
          )}
        </div>
      </div>

      {fullscreen && <Lightbox svg={svg} onClose={() => setFullscreen(false)} />}
    </>
  );
}
