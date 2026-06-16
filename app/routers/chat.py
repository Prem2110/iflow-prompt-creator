import json
import logging
from typing import AsyncGenerator

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.aicore import chat_complete_messages
from app.services.embedder import embed_texts
from app.services.extractor import extract
from app.services.vectorstore import build_session, get_session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

_MAX_FILE_SIZE = 20 * 1024 * 1024
_ALLOWED_EXTENSIONS = {
    ".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".xls",
    ".csv", ".txt", ".json", ".yaml", ".yml", ".xml",
    ".wsdl", ".png", ".jpg", ".jpeg", ".webp", ".gif",
}


def _event(status: str, **kwargs) -> str:
    return f"data: {json.dumps({'status': status, **kwargs})}\n\n"


# ── /api/index ────────────────────────────────────────────────────────────────

async def _stream_index(files: list[UploadFile]) -> AsyncGenerator[str, None]:
    for f in files:
        ext = "." + (f.filename or "").rsplit(".", 1)[-1].lower()
        if ext not in _ALLOWED_EXTENSIONS:
            yield _event("error", message=f"Unsupported file type '{ext}' for '{f.filename}'")
            return

    file_data: list[tuple[UploadFile, bytes]] = []
    for f in files:
        data = await f.read()
        if len(data) > _MAX_FILE_SIZE:
            yield _event("error", message=f"'{f.filename}' exceeds 20 MB limit")
            return
        file_data.append((f, data))

    yield _event("step", key="extract", message=f"Extracting text from {len(files)} file(s)…")
    try:
        extracted = [item for f, data in file_data for item in await extract(f, data)]
        n_text = sum(1 for e in extracted if e["kind"] == "text")
        yield _event("step_done", key="extract", message=f"Extracted text from {n_text} item(s)")
    except Exception as exc:
        yield _event("error", message=f"Extraction failed: {exc}")
        return

    yield _event("step", key="embed", message="Chunking and embedding documents…")
    try:
        session_id = await build_session(extracted)
        yield _event("step_done", key="embed", message="Documents indexed and ready for chat")
    except Exception as exc:
        logger.error("Indexing failed: %s", exc, exc_info=True)
        yield _event("error", message=f"Indexing failed: {exc}")
        return

    file_names = [f.filename for f, _ in file_data]
    yield _event("done", session_id=session_id, files=file_names)


@router.post("/index")
async def index_documents(files: list[UploadFile] = File(...)):
    logger.info("Index request — %d file(s): %s", len(files), [f.filename for f in files])
    return StreamingResponse(
        _stream_index(files),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── /api/chat ─────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    session_id: str
    messages: list[dict]   # [{role, content}, ...]
    message: str


_CHAT_SYSTEM_TMPL = """\
You are an expert SAP CPI and IFS Cloud integration assistant helping a CPI developer \
understand their uploaded integration documents.

Answer questions based primarily on the document excerpts provided below. \
For each fact you take from the documents, cite the source file in square brackets, \
e.g. [Source: A&D_Integration_Spec.pdf]. \
If a question requires general SAP CPI / IFS expertise beyond what the documents state, \
answer from your own knowledge and label it [General SAP Knowledge]. \
Be concise and practical — your audience is an experienced CPI developer.

--- DOCUMENT CONTEXT ---
{context}
--- END CONTEXT ---"""


async def _stream_chat(req: ChatRequest) -> AsyncGenerator[str, None]:
    session = get_session(req.session_id)
    if session is None:
        yield _event("error", message="Session not found. Please re-index your documents.")
        return

    # Embed the user's question
    try:
        query_vec = await embed_texts([req.message])
    except Exception as exc:
        yield _event("error", message=f"Embedding failed: {exc}")
        return

    # Retrieve top-K relevant chunks
    results = session.search(query_vec)
    sources = list(dict.fromkeys(c.source for c, _ in results))  # unique, ordered

    context_parts = [f"[Source: {c.source}]\n{c.text}" for c, _ in results]
    context = "\n\n---\n\n".join(context_parts)

    system = _CHAT_SYSTEM_TMPL.format(context=context)

    # Build messages: history + new user message
    messages_for_llm = list(req.messages) + [{"role": "user", "content": req.message}]

    try:
        gen = await chat_complete_messages(system, messages_for_llm, stream=True, max_tokens=2048)
        async for text in gen:
            yield _event("chunk", text=text)
    except Exception as exc:
        logger.error("Chat LLM call failed: %s", exc, exc_info=True)
        yield _event("error", message=f"LLM call failed: {exc}")
        return

    yield _event("done", sources=sources)


@router.post("/chat")
async def chat_endpoint(req: ChatRequest):
    logger.info("Chat request — session: %s, message: %.60s…", req.session_id, req.message)
    return StreamingResponse(
        _stream_chat(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
