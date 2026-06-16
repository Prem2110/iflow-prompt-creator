import { useEffect } from "react";
import { FileText, Image, Files, RefreshCw, Clock, X, HelpCircle, MessageSquare, Layers, LayoutPanelLeft } from "lucide-react";
import styles from "./HelpModal.module.css";

const STEPS = [
  {
    num: "1",
    title: "Upload your files",
    body: "Drag and drop files onto the upload area, or click to browse. Upload multiple files at once — the AI reads all of them together.",
    note: "Supported: PDF, DOCX, PPTX, XLSX, CSV, TXT, JSON, YAML, XML, WSDL, PNG, JPG",
  },
  {
    num: "2",
    title: "Discover iFlows",
    body: "Click Discover Flows to let the AI scan your documents and automatically extract every integration flow it finds — name, direction, source/target systems, and a description. Each iFlow appears as a card.",
    actions: [
      { label: "Open a flow card",   color: "teal",  desc: "Opens a detail view with generation and a chat panel scoped to that specific iFlow. Ask questions, generate a Prompt, Instructions, or Summary for just that flow." },
      { label: "Select + Generate",  color: "indigo", desc: "Tick multiple flow cards and click Generate Selected to produce a configuration prompt for each chosen flow in one batch — collected in the Multi-Flow tab." },
    ],
  },
  {
    num: "3",
    title: "Choose what to generate",
    body: "Use the action buttons to instantly generate one of three outputs across all your uploaded documents:",
    actions: [
      { label: "Generate Prompt", color: "indigo", desc: "Structured iFlow configuration prompt — topology, adapter settings, component config. Paste directly into your iFlow builder." },
      { label: "Instructions",    color: "indigo", desc: "Complete manual build guide with exact SAP CPI UI steps, full Groovy / XSLT / JSONata scripts, and Postman + cURL testing commands." },
      { label: "Summarize",       color: "teal",   desc: "Concise overview — iFlow purpose, topology diagram, adapters used, key configuration decisions, and gotchas." },
    ],
  },
  {
    num: "4",
    title: "Review and export",
    body: "Switch between the Prompt, Instructions, and Summary tabs at any time. Copy to clipboard with one click, or export as TXT, Word (.docx), or PDF.",
  },
];

const FEATURES = [
  {
    Icon: LayoutPanelLeft,
    title: "Per-iFlow detail view",
    desc: "Inside any discovered flow card, generate a Prompt, Instructions, or Summary scoped exclusively to that iFlow. The chat panel auto-indexes your documents so you can ask targeted questions immediately.",
  },
  {
    Icon: MessageSquare,
    title: "Document Chat",
    desc: "Click Chat (top-right) to ask free-form questions across all uploaded documents. The AI uses RAG to find the most relevant sections before answering. Add extra files mid-conversation to enrich the context.",
  },
  {
    Icon: Layers,
    title: "Multi-Flow tab",
    desc: "Results from Generate Selected are collected here — one block per iFlow, in the order they were generated. Copy or export the entire batch at once.",
  },
];

const TIPS = [
  "The more detail in your uploaded files, the more accurate the output — include API specs, mapping docs, and architecture diagrams together.",
  "Upload Swagger/OpenAPI JSON/YAML or WSDL files to have adapter settings pre-filled from the spec.",
  "In the per-iFlow chat panel, ask things like \"What adapter is used?\" or \"Explain the error handling\" — answers are scoped to that specific flow.",
  "If the Chat tab has already indexed your documents, opening a flow detail view reuses the same index automatically (no re-indexing).",
  "All three outputs (Prompt, Instructions, Summary) are independent — you can generate all three from the same upload without uploading again.",
  "If output seems truncated, click the ↺ Regenerate button on the active tab to retry.",
  "You can upload a mix of text documents and screenshots/diagrams in a single request.",
];

const LIMITS = [
  { icon: FileText,   label: "Max file size",                value: "20 MB per file" },
  { icon: Image,      label: "Diagram PDFs",                 value: "Rendered as images automatically when text is sparse (< 1,200 chars/page). Claude reads the full visual — swimlanes, arrows, decision points." },
  { icon: Files,      label: "PDF image pages cap",          value: "First 10 pages rendered as images; remaining pages skipped to control token usage." },
  { icon: RefreshCw,  label: "Instructions auto-continuation", value: "Large iFlows that hit the token limit are automatically continued — up to 3 extra calls to complete the full guide." },
  { icon: Clock,      label: "LLM timeout",                  value: "120 seconds per request (configurable on the server)." },
];

export default function HelpModal({ onClose }) {
  useEffect(() => {
    function handleKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="How to use Orbit Prompt Generator">
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerIcon}><HelpCircle size={18} /></span>
            <h2 className={styles.title}>How to use Orbit Prompt Generator</h2>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close help"><X size={16} /></button>
        </div>

        <div className={styles.body}>

          {/* Steps */}
          <div className={styles.steps}>
            {STEPS.map((step) => (
              <div key={step.num} className={styles.step}>
                <div className={styles.stepNum}>{step.num}</div>
                <div className={styles.stepContent}>
                  <h3 className={styles.stepTitle}>{step.title}</h3>
                  <p className={styles.stepBody}>{step.body}</p>
                  {step.note && <p className={styles.stepNote}>{step.note}</p>}
                  {step.actions && (
                    <div className={styles.actionList}>
                      {step.actions.map((a) => (
                        <div key={a.label} className={styles.actionItem}>
                          <span className={`${styles.actionBadge} ${styles[`badge_${a.color}`]}`}>{a.label}</span>
                          <span className={styles.actionDesc}>{a.desc}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Features */}
          <div className={styles.featuresBox}>
            <h3 className={styles.featuresTitle}>More features</h3>
            <div className={styles.featureGrid}>
              {FEATURES.map(({ Icon, title, desc }) => (
                <div key={title} className={styles.featureCard}>
                  <div className={styles.featureIcon}><Icon size={15} /></div>
                  <div>
                    <p className={styles.featureTitle}>{title}</p>
                    <p className={styles.featureDesc}>{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Tips */}
          <div className={styles.tipsBox}>
            <h3 className={styles.tipsTitle}>Tips</h3>
            <ul className={styles.tipsList}>
              {TIPS.map((tip, i) => (
                <li key={i} className={styles.tipItem}>
                  <span className={styles.tipDot} />
                  {tip}
                </li>
              ))}
            </ul>
          </div>

          {/* Limits */}
          <div className={styles.limitsBox}>
            <h3 className={styles.limitsTitle}>Limits &amp; Behaviour</h3>
            <div className={styles.limitsList}>
              {LIMITS.map((l) => (
                <div key={l.label} className={styles.limitItem}>
                  <span className={styles.limitIcon}><l.icon size={15} /></span>
                  <div className={styles.limitText}>
                    <span className={styles.limitLabel}>{l.label}</span>
                    <span className={styles.limitValue}>{l.value}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Powered by */}
          <div className={styles.poweredBy}>
            <div className={styles.poweredByLeft}>
              <span className={styles.poweredByLabel}>Powered by</span>
              <span className={styles.poweredByName}>SAP AI Core · Claude</span>
            </div>
            <p className={styles.poweredByDesc}>
              All AI generation runs on SAP AI Core using Anthropic's Claude model hosted in a secure, enterprise-grade environment. No data is stored or used for model training.
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}
