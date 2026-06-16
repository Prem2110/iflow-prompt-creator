import { Check, X } from "lucide-react";
import styles from "./ProgressSteps.module.css";

export default function ProgressSteps({ steps }) {
  return (
    <ul className={styles.list}>
      {steps.map((step) => (
        <li key={step.key} className={`${styles.item} ${styles[step.state]}`}>
          <span className={styles.icon}>
            {step.state === "active" ? (
              <span className={styles.spinner} />
            ) : step.state === "done" ? (
              <Check size={11} strokeWidth={2.5} />
            ) : step.state === "error" ? (
              <X size={11} strokeWidth={2.5} />
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
