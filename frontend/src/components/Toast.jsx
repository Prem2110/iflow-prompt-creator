import { useEffect } from "react";
import styles from "./Toast.module.css";

export default function Toast({ toasts, remove }) {
  return (
    <div className={styles.container} aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} remove={remove} />
      ))}
    </div>
  );
}

function ToastItem({ toast, remove }) {
  useEffect(() => {
    const timer = setTimeout(() => remove(toast.id), toast.duration ?? 3000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, remove]);

  return (
    <div className={`${styles.toast} ${styles[toast.type ?? "success"]}`}>
      <span className={styles.icon}>
        {toast.type === "error" ? "✕" : toast.type === "info" ? "ℹ" : "✓"}
      </span>
      <span className={styles.message}>{toast.message}</span>
      <button className={styles.close} onClick={() => remove(toast.id)}>✕</button>
    </div>
  );
}
