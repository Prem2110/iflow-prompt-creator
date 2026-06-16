import json
import logging
from typing import AsyncGenerator

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.aicore import chat_complete, chat_complete_messages
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


_VISION_SYSTEM = (
    "You are an expert SAP CPI / IFS Cloud integration document analyst. "
    "Carefully examine this image and extract ALL of the following that are visible:\n"
    "- Integration flow names and identifiers (iFlow names, flow IDs)\n"
    "- Source and target systems (SAP, IFS Cloud, middleware, external apps)\n"
    "- Message/protocol types (IDoc, REST, SOAP, OData, XML, JSON, RFC, JDBC, SFTP, etc.)\n"
    "- API endpoints, URLs, and connection parameters\n"
    "- Process steps and their sequence / order\n"
    "- Business objects / documents (Purchase Order, Sales Order, Material, Invoice, etc.)\n"
    "- Error handling or exception flows\n"
    "- Conditions, filters, decision points, and mappings\n"
    "- ALL visible text labels, field names, identifiers, and codes — reproduce them verbatim.\n\n"
    "Structure your response as a detailed list. If specific iFlow or integration flow names are "
    "visible, list each one explicitly. Be exhaustive — your output is the only way this diagram "
    "can be searched and queried."
)


async def _describe_image(item: dict) -> dict:
    """Call Claude Vision on one image item and return a text item with the description."""
    content = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": item["mime"], "data": item["b64"]},
        },
        {"type": "text", "text": "Describe this diagram or page in full detail."},
    ]
    description = await chat_complete(
        system=_VISION_SYSTEM,
        user_content=content,
        stream=False,
        max_tokens=1024,
    )
    return {
        "kind": "text",
        "name": item["name"],
        "content": f"[Visual content from: {item['name']}]\n{description}",
    }


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

    yield _event("step", key="extract", message=f"Extracting content from {len(files)} file(s)…")
    try:
        extracted = [item for f, data in file_data for item in await extract(f, data, text_only=False)]
        n_text  = sum(1 for e in extracted if e["kind"] == "text")
        n_image = sum(1 for e in extracted if e["kind"] == "image")
        yield _event("step_done", key="extract", message=f"Extracted {n_text} text + {n_image} image item(s)")
    except Exception as exc:
        yield _event("error", message=f"Extraction failed: {exc}")
        return

    # Describe image pages with Claude Vision so they become searchable text
    image_items = [e for e in extracted if e["kind"] == "image"]
    if image_items:
        yield _event("step", key="vision", message=f"Analysing {len(image_items)} diagram page(s) with Vision…")
        try:
            described = []
            for img in image_items:
                described.append(await _describe_image(img))
            # Replace image items with their text descriptions
            extracted = [e for e in extracted if e["kind"] == "text"] + described
            # Build a snippet of the first description for user feedback
            first_desc = described[0]["content"] if described else ""
            # Strip the "[Visual content from: ...]" prefix line for the snippet
            lines = [l for l in first_desc.split("\n") if l.strip() and not l.startswith("[Visual content")]
            snippet = (" — " + lines[0][:80] + "…") if lines else ""
            yield _event("step_done", key="vision", message=f"Described {len(image_items)} diagram page(s){snippet}")
        except Exception as exc:
            logger.error("Vision description failed: %s", exc, exc_info=True)
            yield _event("error", message=f"Vision description failed: {exc}")
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


@router.get("/debug-embedding")
async def debug_embedding():
    """Try both body variants (with/without model field) and report which works."""
    import os, httpx
    from app.services.aicore import _get_token
    base = os.environ["AICORE_BASE_URL"].rstrip("/")
    dep  = os.environ["EMBEDDING_DEPLOYMENT_ID"].strip()
    model_name = os.environ.get("EMBEDDING_MODEL_NAME", "text-embedding-3-large")
    resource_group = os.environ.get("EMBEDDING_RESOURCE_GROUP") or os.environ.get("AICORE_RESOURCE_GROUP", "default")
    url = f"{base}/inference/deployments/{dep}/embeddings"
    token = await _get_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "AI-Resource-Group": resource_group,
        "Content-Type": "application/json",
    }
    results = {}
    async with httpx.AsyncClient(timeout=15) as client:
        for label, body in [
            ("with_model", {"input": ["hello world"], "model": model_name}),
            ("without_model", {"input": ["hello world"]}),
            ("inputs_key", {"inputs": ["hello world"]}),
        ]:
            try:
                r = await client.post(url, json=body, headers=headers)
                results[label] = {"status": r.status_code, "body": r.text[:300], "ai-external-failure": r.headers.get("ai-external-failure")}
            except Exception as e:
                results[label] = {"error": str(e)}
    return {"url": url, "resource_group": resource_group, "results": results}


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

You are in a MULTI-TURN conversation. The full conversation history is included in the \
messages below — always use it to understand follow-up questions, resolve pronouns like \
"that flow", "the one you mentioned", "point 3", etc. Never forget what was said earlier.

The user has uploaded documents that have been extracted and indexed. \
The relevant excerpts are provided in the DOCUMENT CONTEXT section below. \
Some excerpts may come from Vision-based descriptions of diagram images. \
Use ALL information in the context AND the conversation history to answer as specifically \
as possible.

For each fact you take from the documents, cite the source in square brackets, \
e.g. [Source: A&D_Integration_Spec.pdf]. \
If the document excerpts do not contain the specific detail asked, say what IS available \
and supplement with [General SAP Knowledge] where helpful. \
Be concise and practical — your audience is an experienced CPI developer.

--- DOCUMENT CONTEXT ---
{context}
--- END CONTEXT ---"""


def _build_search_query(req: ChatRequest) -> str:
    """
    Combine the current message with recent assistant replies so that follow-up
    questions like 'tell me more about that' retrieve relevant document chunks.
    We extract text from the last 4 messages (2 turns) of history.
    """
    parts = [req.message]
    # Walk backwards through history, pick assistant then user turns (last 2 exchanges)
    for msg in reversed(req.messages[-4:]):
        content = msg.get("content", "")
        if isinstance(content, str) and content.strip():
            parts.append(content)
    # Join and cap length so TF-IDF doesn't get a wall of text
    combined = " ".join(parts)
    return combined[:1200]


async def _stream_chat(req: ChatRequest) -> AsyncGenerator[str, None]:
    session = get_session(req.session_id)
    if session is None:
        yield _event("error", message="Session not found. Please re-index your documents.")
        return

    # Retrieve top-K relevant chunks — enrich query with recent conversation history
    # so follow-up questions find the right document sections
    search_query = _build_search_query(req)
    results = session.search(search_query)
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
