import { useRef, useState } from "react";
import styles from "./FileUpload.module.css";

const ACCEPTED = ".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.webp";

export default function FileUpload({ files, onChange, disabled = false }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function addFiles(incoming) {
    if (disabled) return;
    const merged = [...files];
    Array.from(incoming).forEach((f) => {
      if (!merged.find((x) => x.name === f.name && x.size === f.size)) {
        merged.push(f);
      }
    });
    onChange(merged);
  }

  function removeFile(index) {
    onChange(files.filter((_, i) => i !== index));
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }

  function onDragOver(e) {
    e.preventDefault();
    setDragging(true);
  }

  const iconFor = (name) => {
    const ext = name.split(".").pop().toLowerCase();
    if (ext === "pdf") return "📄";
    if (["doc", "docx"].includes(ext)) return "📝";
    if (ext === "txt") return "🗒️";
    return "🖼️";
  };

  const sizeLabel = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div>
      <div
        className={`${styles.dropzone} ${dragging ? styles.dragging : ""} ${disabled ? styles.disabledZone : ""}`}
        onDrop={disabled ? undefined : onDrop}
        onDragOver={disabled ? undefined : onDragOver}
        onDragLeave={() => setDragging(false)}
        onClick={() => !disabled && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED}
          className={styles.hiddenInput}
          onChange={(e) => addFiles(e.target.files)}
        />
        <div className={styles.dropContent}>
          <span className={styles.dropIcon}>📂</span>
          <p className={styles.dropText}>
            Drag &amp; drop files here, or <span className={styles.browse}>browse</span>
          </p>
          <p className={styles.dropHint}>PDF, DOCX, TXT, PNG, JPG — multiple files supported</p>
        </div>
      </div>

      {files.length > 0 && (
        <ul className={styles.fileList}>
          {files.map((f, i) => (
            <li key={i} className={styles.fileItem}>
              <span className={styles.fileIcon}>{iconFor(f.name)}</span>
              <span className={styles.fileName}>{f.name}</span>
              <span className={styles.fileSize}>{sizeLabel(f.size)}</span>
              <button
                className={styles.removeBtn}
                onClick={() => removeFile(i)}
                title="Remove"
                aria-label={`Remove ${f.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
