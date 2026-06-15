import { useState } from "react";
import PromptOutput from "./PromptOutput.jsx";
import styles from "./MultiPromptOutput.module.css";
import { badgeStyle } from "./dirBadge.js";

function FlowCard({ flow, prompt, isGenerating, toast }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`${styles.card} ${isGenerating ? styles.cardGenerating : ""}`}>
      <div className={styles.cardHeader} onClick={() => setOpen((v) => !v)}>
        <span className={styles.arrow}>{open ? "▾" : "▸"}</span>
        <span className={styles.flowName}>{flow.name}</span>
        <span className={styles.dirBadge} style={badgeStyle(flow.direction)}>{flow.direction}</span>
        {isGenerating && <span className={styles.generatingLabel}>Generating&hellip;</span>}
        <span className={styles.apiLabel}>{flow.target_api}</span>
      </div>
      {open && (
        <div className={styles.cardBody}>
          {prompt ? (
            <PromptOutput prompt={prompt} loading={isGenerating} toast={toast} />
          ) : isGenerating ? (
            <div className={styles.waitMsg}>
              <span className={styles.spinner} /> Building iFlow prompt&hellip;
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function MultiPromptOutput({ flows, prompts, generatingFlowId, loading, toast }) {
  const visibleFlows = flows.filter((f) => prompts[f.id] !== undefined || generatingFlowId === f.id);
  const doneCount = Object.values(prompts).filter(Boolean).length;

  if (visibleFlows.length === 0 && !loading) return (
    <div className={styles.empty}>
      <p>No prompts generated yet. Select interfaces from the list above and click Generate selected.</p>
    </div>
  );

  return (
    <div className={styles.container}>
      <p className={styles.summary}>
        {loading
          ? `Generating ${visibleFlows.length} of ${flows.filter((f) => prompts[f.id] !== undefined || generatingFlowId === f.id).length} iFlow prompts…`
          : `${doneCount} iFlow prompt${doneCount !== 1 ? "s" : ""} generated`}
      </p>
      <div className={styles.cards}>
        {visibleFlows.map((flow) => (
          <FlowCard
            key={flow.id}
            flow={flow}
            prompt={prompts[flow.id] || ""}
            isGenerating={generatingFlowId === flow.id}
            toast={toast}
          />
        ))}
      </div>
    </div>
  );
}
