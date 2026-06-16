import { ArrowRight } from "lucide-react";
import styles from "./FlowDiscovery.module.css";
import { badgeStyle } from "./dirBadge.js";

export default function FlowDiscovery({
  flows,
  selectedIds,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onGenerate,
  generatingFlowId,
  loading,
}) {
  const selectedCount = selectedIds.size;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>
            <span className={styles.titleCount}>{flows.length}</span> integration interfaces found
          </span>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.selectBtn} onClick={onSelectAll} disabled={loading}>Select all</button>
          <button className={styles.selectBtn} onClick={onDeselectAll} disabled={loading}>Deselect all</button>
          <button
            className={styles.generateBtn}
            disabled={selectedCount === 0 || loading}
            onClick={onGenerate}
          >
            {loading
              ? <><span className={styles.spinner} /> Generating&hellip;</>
              : `Generate selected (${selectedCount})`}
          </button>
        </div>
      </div>

      <div className={styles.list}>
        {flows.map((flow) => {
          const isSelected = selectedIds.has(flow.id);
          const isGenerating = generatingFlowId === flow.id;
          return (
            <div
              key={flow.id}
              className={`${styles.item} ${isSelected ? styles.itemSelected : ""} ${isGenerating ? styles.itemGenerating : ""}`}
              onClick={() => !loading && onToggle(flow.id)}
            >
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={isSelected}
                onChange={() => onToggle(flow.id)}
                onClick={(e) => e.stopPropagation()}
                disabled={loading}
              />
              <div className={styles.flowInfo}>
                <div className={styles.flowNameRow}>
                  <span className={styles.flowName}>{flow.name}</span>
                  <span className={styles.dirBadge} style={badgeStyle(flow.direction)}>
                    {flow.direction}
                  </span>
                  {isGenerating && <span className={styles.generatingBadge}>Generating&hellip;</span>}
                </div>
                <div className={styles.flowMeta}>
                  <span className={styles.metaChip}>{flow.source_entity || flow.source_system}</span>
                  <span className={styles.metaArrow}><ArrowRight size={11} /></span>
                  <span className={styles.metaChip}>{flow.target_api}</span>
                </div>
                <p className={styles.flowDesc}>{flow.description}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
