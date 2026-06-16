import logging
import uuid
from dataclasses import dataclass

import faiss
import numpy as np

from app.services.embedder import EMBEDDING_DIM

logger = logging.getLogger(__name__)

EMBED_BATCH = 64   # texts per embedding API call
MAX_CHUNK   = 700  # target chars per chunk
OVERLAP     = 80   # overlap chars between chunks
TOP_K       = 5    # chunks to retrieve per query


@dataclass
class Chunk:
    text: str
    source: str  # filename


class _Session:
    def __init__(self, chunks: list[Chunk], index: faiss.IndexFlatIP):
        self.chunks = chunks
        self.index  = index

    def search(self, query_vec: np.ndarray) -> list[tuple[Chunk, float]]:
        """query_vec: shape (1, DIM), L2-normalised. Returns [(chunk, score)]."""
        scores, indices = self.index.search(query_vec, TOP_K)
        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx >= 0:
                results.append((self.chunks[idx], float(score)))
        return results


# ── In-memory store (session_id → _Session) ───────────────────────────────────

_sessions: dict[str, _Session] = {}


def get_session(session_id: str) -> _Session | None:
    return _sessions.get(session_id)


def drop_session(session_id: str) -> None:
    _sessions.pop(session_id, None)


# ── Chunking ──────────────────────────────────────────────────────────────────

def _chunk_text(text: str, source: str) -> list[Chunk]:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[Chunk] = []
    buf = ""

    for para in paragraphs:
        if len(buf) + len(para) + 2 <= MAX_CHUNK:
            buf = (buf + "\n\n" + para).strip() if buf else para
        else:
            if buf:
                chunks.append(Chunk(text=buf, source=source))
                buf = buf[-OVERLAP:] + "\n\n" + para
            else:
                # paragraph itself is large — split by sentence
                for sent in para.replace(". ", ".|").split("|"):
                    sent = sent.strip()
                    if not sent:
                        continue
                    if len(buf) + len(sent) + 2 <= MAX_CHUNK:
                        buf = (buf + " " + sent).strip() if buf else sent
                    else:
                        if buf:
                            chunks.append(Chunk(text=buf, source=source))
                        buf = sent
    if buf:
        chunks.append(Chunk(text=buf, source=source))

    return chunks


# ── Build a session from extracted items ──────────────────────────────────────

async def build_session(extracted: list[dict]) -> str:
    """
    extracted: list of {"kind": "text"|"image", "name": str, "content": str, ...}
    Returns a new session_id.
    """
    from app.services.embedder import embed_texts  # local import avoids circular

    chunks: list[Chunk] = []
    for item in extracted:
        if item["kind"] != "text":
            continue
        name = item.get("name", "document")
        chunks.extend(_chunk_text(item["content"], source=name))

    if not chunks:
        raise ValueError("No text content found in uploaded files to index.")

    logger.info("Chunked %d text chunks from %d items", len(chunks), len(extracted))

    # Embed in batches
    all_vecs: list[np.ndarray] = []
    for start in range(0, len(chunks), EMBED_BATCH):
        batch = chunks[start : start + EMBED_BATCH]
        vecs  = await embed_texts([c.text for c in batch])
        all_vecs.append(vecs)

    matrix = np.vstack(all_vecs).astype(np.float32)

    # Build FAISS index (inner product on normalised vectors = cosine)
    index = faiss.IndexFlatIP(EMBEDDING_DIM)
    index.add(matrix)

    session_id = str(uuid.uuid4())
    _sessions[session_id] = _Session(chunks=chunks, index=index)
    logger.info("Session %s created with %d chunks, index size %d", session_id, len(chunks), index.ntotal)
    return session_id
