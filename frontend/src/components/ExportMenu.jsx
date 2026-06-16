import { useEffect, useRef, useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import { exportTxt, exportDocx, exportPdf } from "../utils/exportUtils";
import styles from "./ExportMenu.module.css";

export default function ExportMenu({ content, filename, loading = false, toast }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  async function handle(format) {
    setOpen(false);
    setExporting(format);
    try {
      if (format === "txt") exportTxt(content, filename);
      else if (format === "docx") await exportDocx(content, filename);
      else if (format === "pdf") await exportPdf(content, filename);
      const label = format === "docx" ? "Word document" : format.toUpperCase();
      toast?.(`Exported as ${label}`, "success");
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        disabled={!content || loading || !!exporting}
        title="Export the generated content as a file"
      >
        {exporting ? "Exporting…" : <><Download size={13} /> Export <ChevronDown size={11} /></>}
      </button>
      {open && (
        <div className={styles.menu}>
          <button className={styles.item} onClick={() => handle("txt")}>
            <span className={styles.fmt}>TXT</span> Plain text
          </button>
          <button className={styles.item} onClick={() => handle("docx")}>
            <span className={`${styles.fmt} ${styles.fmtDocx}`}>DOC</span> Word document
          </button>
          <button className={styles.item} onClick={() => handle("pdf")}>
            <span className={`${styles.fmt} ${styles.fmtPdf}`}>PDF</span> PDF file
          </button>
        </div>
      )}
    </div>
  );
}
