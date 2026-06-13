import { useEffect, useRef, useState } from "react";
import styles from "./FileUpload.module.css";

const ACCEPTED = ".pdf,.docx,.doc,.pptx,.xlsx,.xls,.csv,.txt,.json,.yaml,.yml,.xml,.wsdl,.png,.jpg,.jpeg,.webp,.gif";
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function ext(name) { return name.split(".").pop().toLowerCase(); }

function typeClass(name) {
  const e = ext(name);
  if (e === "pdf") return styles.typePdf;
  if (["doc", "docx"].includes(e)) return styles.typeDoc;
  if (e === "pptx") return styles.typePptx;
  if (["xlsx", "xls"].includes(e)) return styles.typeXlsx;
  if (e === "csv") return styles.typeCsv;
  if (e === "txt") return styles.typeTxt;
  if (IMAGE_EXTS.has(e)) return styles.typeImage;
  return styles.typeDefault;
}

function iconFor(name) {
  const e = ext(name);
  if (e === "pdf") return null; // uses PDF badge
  if (["doc", "docx"].includes(e)) return "📝";
  if (e === "pptx") return "📊";
  if (["xlsx", "xls", "csv"].includes(e)) return "📋";
  if (e === "txt") return "🗒️";
  if (IMAGE_EXTS.has(e)) return null; // uses thumbnail
  return "📎";
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FileThumbnail({ file }) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    if (!IMAGE_EXTS.has(ext(file.name))) return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (IMAGE_EXTS.has(ext(file.name)) && src) {
    return <img src={src} alt="" className={styles.thumb} />;
  }
  if (ext(file.name) === "pdf") {
    return <span className={styles.pdfBadge}>PDF</span>;
  }
  const icon = iconFor(file.name);
  return <span className={styles.fileIconInner}>{icon || "📎"}</span>;
}

export default function FileUpload({ files, onChange, disabled = false }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function addFiles(incoming) {
    if (disabled) return;
    const merged = [...files];
    Array.from(incoming).forEach((f) => {
      if (!merged.find((x) => x.name === f.name && x.size === f.size)) merged.push(f);
    });
    onChange(merged);
  }

  function removeFile(index) { onChange(files.filter((_, i) => i !== index)); }
  function onDrop(e) { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }
  function onDragOver(e) { e.preventDefault(); setDragging(true); }

  return (
    <div>
      <div
        className={[styles.dropzone, dragging ? styles.dragging : "", disabled ? styles.disabledZone : ""].join(" ")}
        onDrop={disabled ? undefined : onDrop}
        onDragOver={disabled ? undefined : onDragOver}
        onDragLeave={() => setDragging(false)}
        onClick={() => !disabled && inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" multiple accept={ACCEPTED} className={styles.hiddenInput}
          onChange={(e) => addFiles(e.target.files)} />
        <div className={styles.dropContent}>
          <div className={styles.dropIcon}>
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p className={styles.dropText}>Drag &amp; drop files here, or <span className={styles.browse}>browse</span></p>
          <p className={styles.dropHint}>PDF · DOCX · PPTX · XLSX · CSV · TXT · JSON · YAML · XML · WSDL · PNG · JPG — multiple files</p>
        </div>
      </div>

      {files.length > 0 && (
        <ul className={styles.fileList}>
          {files.map((f, i) => (
            <li key={i} className={`${styles.fileItem} ${typeClass(f.name)}`}>
              <div className={styles.fileThumbWrap}>
                <FileThumbnail file={f} />
              </div>
              <div className={styles.fileMeta}>
                <span className={styles.fileName}>{f.name}</span>
                <span className={styles.fileSize}>{sizeLabel(f.size)}</span>
              </div>
              <button className={styles.removeBtn} onClick={() => removeFile(i)}
                title="Remove" aria-label={`Remove ${f.name}`}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
