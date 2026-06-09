import styles from "./ProgressSteps.module.css";

const STEP_ORDER = ["extract", "auth", "generate", "validate", "retry"];

const ICONS = {
  pending: null,
  active:  "spinner",
  done:    "✓",
  error:   "✕",
};

export default function ProgressSteps({ steps }) {
  return (
    <ul className={styles.list}>
      {steps.map((step) => (
        <li key={step.key} className={`${styles.item} ${styles[step.state]}`}>
          <span className={styles.icon}>
            {step.state === "active" ? (
              <span className={styles.spinner} />
            ) : step.state === "done" ? (
              "✓"
            ) : step.state === "error" ? (
              "✕"
            ) : (
              <span className={styles.dot} />
            )}
          </span>
          <span className={styles.message}>{step.message}</span>
        </li>
      ))}
    </ul>
  );
}
