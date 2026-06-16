import { useEffect } from "react";
import { FileText, Image, Files, RefreshCw, Clock, X, HelpCircle } from "lucide-react";
import styles from "./HelpModal.module.css";

const STEPS = [
  {
    num: "1",
    title: "Upload your files",
    body: "Drag and drop files onto the upload area, or click to browse. You can upload multiple files at once — the AI reads all of them together.",
    note: "Supported: PDF, DOCX, PPTX, XLSX, CSV, TXT, JSON, YAML, XML, WSDL, PNG, JPG",
  },
  {
    num: "2",
    title: "Choose what to generate",
    body: "Pick one of the three actions depending on what you need:",
    actions: [
      { label: "Generate Prompt", color: "indigo", desc: "Structured iFlow configuration prompt — topology, adapter settings, component config. Paste directly into your iFlow builder." },
      { label: "Instructions", color: "indigo", desc: "Complete manual build guide with exact SAP CPI UI steps, full Groovy / XSLT / JSONata scripts, and Postman + cURL testing instructions." },
      { label: "Summarize", color: "teal", desc: "Concise overview — iFlow purpose, topology diagram, adapters used, key configuration, and gotchas." },
    ],
  },
  {
    num: "3",
    title: "Review and export",
    body: "Switch between the Prompt, Instructions, and Summary tabs at any time. Use the Copy button to copy to clipboard, or Export to download as TXT, Word (.docx), or PDF.",
  },
];

const TIPS = [
  "The more detail in your uploaded files, the more accurate the output.",
  "Upload API specs (Swagger/OpenAPI JSON/YAML or WSDL) to get adapter settings pre-filled from the spec.",
  "If the output is incomplete, click the ↺ Retry button on the active tab — it will regenerate.",
  "You can upload a mix of documents and screenshots in a single request.",
  "All three outputs are independent — you can generate all three from the same upload.",
];

const LIMITS = [
  { icon: FileText, label: "Max file size", value: "20 MB per file" },
  { icon: Image, label: "Diagram PDFs", value: "Rendered as images automatically when text is sparse (< 1,200 chars/page). Claude reads the full visual — swimlanes, arrows, decision points." },
  { icon: Files, label: "PDF image pages cap", value: "First 10 pages rendered; remaining pages are skipped to control token usage." },
  { icon: RefreshCw, label: "Instructions auto-continuation", value: "Large iFlows that hit the token limit are automatically continued — up to 3 extra calls to complete the full guide." },
  { icon: Clock, label: "LLM timeout", value: "120 seconds per request (configurable on the server)." },
];

export default function HelpModal({ onClose }) {
  useEffect(() => {
    function handleKey(e) {
      if (e.key === "Escape") onClose();
    }
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
