import base64
import io
from pathlib import Path

from fastapi import UploadFile

_MIME_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


async def extract(file: UploadFile) -> dict:
    """
    Returns one of:
      {"kind": "text", "name": str, "content": str}
      {"kind": "image", "name": str, "mime": str, "b64": str}
    """
    data = await file.read()
    suffix = Path(file.filename or "").suffix.lower()

    if suffix == ".pdf":
        return {"kind": "text", "name": file.filename, "content": _pdf(data)}
    if suffix in (".docx", ".doc"):
        return {"kind": "text", "name": file.filename, "content": _docx(data)}
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
