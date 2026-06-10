import base64
import csv
import io
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_MIME_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


async def extract(file, data: bytes) -> dict:
    """
    Returns one of:
      {"kind": "text", "name": str, "content": str}
      {"kind": "image", "name": str, "mime": str, "b64": str}
    """
    suffix = Path(file.filename or "").suffix.lower()
    logger.info("Extracting %s (%d bytes)", file.filename, len(data))

    if suffix == ".pdf":
        return {"kind": "text", "name": file.filename, "content": _pdf(data)}
    if suffix in (".docx", ".doc"):
        return {"kind": "text", "name": file.filename, "content": _docx(data)}
    if suffix == ".pptx":
        return {"kind": "text", "name": file.filename, "content": _pptx(data)}
    if suffix in (".xlsx", ".xls"):
        return {"kind": "text", "name": file.filename, "content": _xlsx(data)}
    if suffix == ".csv":
        return {"kind": "text", "name": file.filename, "content": _csv(data)}
    if suffix == ".txt":
        return {"kind": "text", "name": file.filename, "content": data.decode("utf-8", errors="replace")}
    if suffix in _MIME_MAP:
        return {
            "kind": "image",
            "name": file.filename,
            "mime": _MIME_MAP[suffix],
            "b64": base64.b64encode(data).decode(),
        }

    # Fallback: try utf-8 text
    logger.warning("Unknown extension '%s' for '%s', falling back to plain text", suffix, file.filename)
    return {"kind": "text", "name": file.filename, "content": data.decode("utf-8", errors="replace")}


def _pdf(data: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n".join(pages)


def _docx(data: bytes) -> str:
    from docx import Document
    doc = Document(io.BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs)


def _pptx(data: bytes) -> str:
    from pptx import Presentation
    prs = Presentation(io.BytesIO(data))
    lines = []
    for slide in prs.slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    text = para.text.strip()
                    if text:
                        lines.append(text)
    return "\n".join(lines)


def _xlsx(data: bytes) -> str:
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    lines = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        lines.append(f"=== Sheet: {sheet_name} ===")
        for row in ws.iter_rows(values_only=True):
            row_text = " | ".join(str(c) if c is not None else "" for c in row)
            if row_text.strip():
                lines.append(row_text)
    return "\n".join(lines)


def _csv(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    lines = []
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        lines.append(", ".join(row))
    return "\n".join(lines)
