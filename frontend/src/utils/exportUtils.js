function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportTxt(content, filename) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  triggerDownload(blob, filename + ".txt");
}

function isTableRow(line) {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 2;
}
function isSeparator(line) {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}
function parseRow(line) {
  return line.trim().slice(1, -1).split("|").map((c) => c.trim());
}

export async function exportDocx(content, filename) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } =
    await import("docx");

  const lines = content.split("\n");
  const children = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (isTableRow(trimmed) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && isTableRow(lines[i].trim())) {
        tableLines.push(lines[i]);
        i++;
      }
      const [headerLine, , ...dataLines] = tableLines;
      const headers = parseRow(headerLine);
      const rows = dataLines.filter((l) => !isSeparator(l)).map(parseRow);
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              tableHeader: true,
              children: headers.map(
                (h) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
                  })
              ),
            }),
            ...rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (cell) => new TableCell({ children: [new Paragraph(cell)] })
                  ),
                })
            ),
          ],
        })
      );
      children.push(new Paragraph(""));
      continue;
    }

    if (trimmed.startsWith("#### ") || trimmed.startsWith("### ")) {
      children.push(new Paragraph({ text: trimmed.replace(/^#{3,4}\s/, ""), heading: HeadingLevel.HEADING_3 }));
    } else if (trimmed.startsWith("## ")) {
      children.push(new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (trimmed.startsWith("# ")) {
      children.push(new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (/^\d+\.\s/.test(trimmed)) {
      children.push(new Paragraph({ text: trimmed, numbering: { reference: "numbering", level: 0 } }));
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      children.push(new Paragraph({ text: trimmed.slice(2), bullet: { level: 0 } }));
    } else if (trimmed === "") {
      children.push(new Paragraph(""));
    } else {
      children.push(new Paragraph(trimmed));
    }

    i++;
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, filename + ".docx");
}

export async function exportPdf(content, filename) {
  const { jsPDF } = await import("jspdf");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageH = doc.internal.pageSize.getHeight();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 18;
  const maxW = pageW - margin * 2;
  let y = margin + 4;

  function checkPage(needed = 8) {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin + 4;
    }
  }

  function addWrapped(text, size, style, indent = 0) {
    doc.setFontSize(size);
    doc.setFont("helvetica", style);
    const parts = doc.splitTextToSize(text, maxW - indent);
    const lineH = size * 0.38 + 1.2;
    checkPage(parts.length * lineH + 2);
    doc.text(parts, margin + indent, y);
    y += parts.length * lineH;
  }

  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (isTableRow(trimmed) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && isTableRow(lines[i].trim())) {
        tableLines.push(lines[i]);
        i++;
      }
      const [headerLine, , ...dataLines] = tableLines;
      const headers = parseRow(headerLine);
      const dataRows = dataLines.filter((l) => !isSeparator(l)).map(parseRow);
      const colW = maxW / Math.max(headers.length, 1);
      const rowH = 7;

      checkPage((dataRows.length + 1) * rowH + 4);

      doc.setFillColor(241, 245, 249);
      doc.rect(margin, y - 5, maxW, rowH, "F");
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(15, 23, 42);
      headers.forEach((h, j) => {
        doc.text(h.substring(0, 22), margin + j * colW + 2, y);
      });
      y += rowH;

      doc.setFont("helvetica", "normal");
      doc.setTextColor(71, 85, 105);
      dataRows.forEach((row, ri) => {
        checkPage(rowH);
        if (ri % 2 === 0) {
          doc.setFillColor(248, 250, 252);
          doc.rect(margin, y - 5, maxW, rowH, "F");
        }
        doc.setFontSize(8);
        row.forEach((cell, j) => {
          doc.text(cell.substring(0, 28), margin + j * colW + 2, y);
        });
        y += rowH;
      });

      doc.setTextColor(0, 0, 0);
      y += 3;
      continue;
    }

    if (trimmed.startsWith("#### ") || trimmed.startsWith("### ")) {
      y += 3;
      addWrapped(trimmed.replace(/^#{3,4}\s/, ""), 11, "bold");
      y += 2;
    } else if (trimmed.startsWith("## ")) {
      y += 5;
      addWrapped(trimmed.slice(3), 14, "bold");
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, y + 1, margin + maxW, y + 1);
      y += 4;
    } else if (trimmed.startsWith("# ")) {
      y += 5;
      addWrapped(trimmed.slice(2), 17, "bold");
      y += 3;
    } else if (/^\d+\.\s/.test(trimmed)) {
      addWrapped(trimmed, 10, "normal", 5);
      y += 1;
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      addWrapped("• " + trimmed.slice(2), 10, "normal", 4);
      y += 1;
    } else if (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4) {
      addWrapped(trimmed.slice(2, -2), 10, "bold");
      y += 1;
    } else if (trimmed === "") {
      y += 3;
    } else {
      addWrapped(trimmed, 10, "normal");
      y += 1;
    }

    i++;
  }

  doc.save(filename + ".pdf");
}
