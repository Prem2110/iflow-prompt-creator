import { useState } from "react";
import { ArrowLeft, Zap, ClipboardList, FileText, MessageSquare, RotateCcw, ArrowRight, GitBranch } from "lucide-react";
import PromptOutput from "./PromptOutput.jsx";
import InstructionsOutput from "./InstructionsOutput.jsx";
import DiagramOutput from "./DiagramOutput.jsx";
import { badgeStyle } from "./dirBadge.js";
import styles from "./FlowDetail.module.css";

const GEN_MODES = [
  { key: "prompt",       label: "Prompt",       Icon: Zap,           endpoint: "/api/generate-flow-prompt" },
  { key: "instructions", label: "Instructions", Icon: ClipboardList, endpoint: "/api/generate-flow-instructions" },
  { key: "summary",      label: "Summary",      Icon: FileText,      endpoint: "/api/generate-flow-summary" },
  { key: "diagram",      label: "Visualise",    Icon: GitBranch,     endpoint: "/api/generate-flow-diagram" },
];

export default function FlowDetail({ flow, files, onBack, toast, onOpenChat }) {
  const [activeMode,  setActiveMode]  = useState("prompt");
  const [outputs,     setOutputs]     = useState({ prompt: "", instructions: "", summary: "", diagram: "" });
  const [loading,     setLoading]     = useState(false);
  const [loadingMode, setLoadingMode] = useState(null);
  const [error,       setError]       = useState("");

  async function generate(mode) {
    if (loading) return;
    setLoading(true); setLoadingMode(mode); setActiveMode(mode);
    setError(""); setOutputs(prev => ({ ...prev, [mode]: "" }));

    const { endpoint } = GEN_MODES.find(m => m.key === mode);
    const form = new FormData();
    files.forEach(f => form.append("files", f));
    form.append("flow_json", JSON.stringify(flow));

    try {
      const res = await fetch(endpoint, { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.status === "chunk") setOutputs(prev => ({ ...prev, [mode]: prev[mode] + event.text }));
          else if (event.status === "done") {
            if (event.prompt) setOutputs(prev => ({ ...prev, [mode]: event.prompt }));
            toast?.(`${GEN_MODES.find(m => m.key === mode).label} ready!`, "success");
          } else if (event.status === "error") setError(event.message);
        }
      }
    } catch (err) { setError(err.message); }
    finally { setLoading(false); setLoadingMode(null); }
  }

  const currentMode   = GEN_MODES.find(m => m.key === activeMode) ?? GEN_MODES[0];
  const currentOutput = outputs[activeMode] ?? "";
  const isGenerating  = loading && loadingMode === activeMode;

  return (
    <div className={styles.container}>

      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onBack}>
          <ArrowLeft size={13} /> Back to flows
        </button>
        <div className={styles.flowHeader}>
          <span className={styles.flowName}>{flow.name}</span>
          <span className={styles.dirBadge} style={badgeStyle(flow.direction)}>{flow.direction}</span>
        </div>
        <div className={styles.flowMeta}>
          <div className={styles.flowSystems}>
            <span className={styles.sysChip}>{flow.source_system || flow.source_entity}</span>
            <ArrowRight size={11} className={styles.sysArrow} />
            <span className={styles.sysChip}>{flow.target_api || flow.target_system}</span>
          </div>
          {flow.description && <p className={styles.flowDesc}>{flow.description}</p>}
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.modeTabs}>
          {GEN_MODES.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`${styles.modeTab} ${activeMode === key ? styles.modeTabActive : ""}`}
              onClick={() => setActiveMode(key)}
            >
              <Icon size={12} /> {label}
              {outputs[key] && <span className={styles.tabDot} />}
            </button>
          ))}
        </div>
        <div className={styles.toolbarRight}>
          <button className={styles.chatFlowBtn} onClick={() => onOpenChat?.(flow)}>
            <MessageSquare size={12} /> Chat about this flow
          </button>
          <button
            className={`${styles.generateBtn} ${isGenerating ? styles.generateBtnBusy : ""}`}
            onClick={() => generate(activeMode)}
            disabled={loading}
          >
            {isGenerating
              ? <><span className={styles.spinner} /> Generating…</>
              : <><RotateCcw size={12} /> {currentOutput ? "Regenerate" : `Generate ${currentMode.label}`}</>}
          </button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.output}>
        {currentOutput ? (
          activeMode === "prompt"
            ? <PromptOutput prompt={currentOutput} loading={isGenerating} toast={toast} />
            : activeMode === "diagram"
            ? <DiagramOutput diagram={currentOutput} loading={isGenerating} toast={toast} />
            : <InstructionsOutput
                instructions={currentOutput}
                loading={isGenerating}
                label={activeMode === "summary" ? "iFlow Summary" : "Manual Instructions"}
                exportFilename={`${flow.name}-${activeMode}`}
                toast={toast}
              />
        ) : (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}><currentMode.Icon size={28} strokeWidth={1.4} /></div>
            <p className={styles.emptyTitle}>
              {isGenerating ? `Generating ${currentMode.label}…` : `No ${currentMode.label.toLowerCase()} yet`}
            </p>
            {!isGenerating && (
              <p className={styles.emptyHint}>
                Click <strong>Generate {currentMode.label}</strong> to create it for <strong>{flow.name}</strong>
              </p>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
