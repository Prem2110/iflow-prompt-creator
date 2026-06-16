import logging
import uuid
from dataclasses import dataclass

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

logger = logging.getLogger(__name__)

MAX_CHUNK = 700   # target chars per chunk
OVERLAP   = 80    # overlap chars between chunks
TOP_K     = 6     # chunks to retrieve per query


@dataclass
class Chunk:
    text: str
    source: str  # filename


class _Session:
    def __init__(self, chunks: list[Chunk], vectorizer: TfidfVectorizer, matrix: np.ndarray):
        self.chunks     = chunks
        self.vectorizer = vectorizer
        self.matrix     = matrix  # (n_chunks, n_features) sparse

    def search(self, query: str) -> list[tuple[Chunk, float]]:
        q_vec   = self.vectorizer.transform([query])
        scores  = cosine_similarity(q_vec, self.matrix)[0]
        top_idx = np.argsort(scores)[::-1][:TOP_K]
        # Always return top-K even if score is 0 — generic questions still need context
        return [(self.chunks[i], float(scores[i])) for i in top_idx]


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
    chunks: list[Chunk] = []
    for item in extracted:
        if item["kind"] != "text":
            continue
        name = item.get("name", "document")
        chunks.extend(_chunk_text(item["content"], source=name))

    if not chunks:
        raise ValueError("No text content found in uploaded files to index.")

    logger.info("Chunked %d text chunks from %d items", len(chunks), len(extracted))

    vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        min_df=1,
        max_features=25_000,
        sublinear_tf=True,
    )
    matrix = vectorizer.fit_transform([c.text for c in chunks])

    session_id = str(uuid.uuid4())
    _sessions[session_id] = _Session(chunks=chunks, vectorizer=vectorizer, matrix=matrix)
    logger.info("Session %s: %d chunks, vocab %d", session_id, len(chunks), len(vectorizer.vocabulary_))
    return session_id
