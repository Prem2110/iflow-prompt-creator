import json
import logging
import os

import httpx
import numpy as np

from app.services.aicore import _get_token

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 3072  # text-embedding-3-large


def _make_embedding_url() -> str:
    base = os.environ["AICORE_BASE_URL"].rstrip("/")
    dep  = os.environ["EMBEDDING_DEPLOYMENT_ID"].strip()
    return f"{base}/inference/deployments/{dep}/embeddings"


async def embed_texts(texts: list[str]) -> np.ndarray:
    """Embed a list of texts. Returns float32 array shape (len(texts), EMBEDDING_DIM), L2-normalised."""
    if not texts:
        return np.empty((0, EMBEDDING_DIM), dtype=np.float32)

    token = await _get_token()
    url   = _make_embedding_url()
    headers = {
        "Authorization": f"Bearer {token}",
        "AI-Resource-Group": os.environ.get("AICORE_RESOURCE_GROUP", "default"),
        "Content-Type": "application/json",
    }
    body = {
        "input": texts,
        "model": os.environ.get("EMBEDDING_MODEL_NAME", "text-embedding-3-large"),
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, json=body, headers=headers)

    if not resp.is_success:
        logger.error("Embedding API error %s: %s", resp.status_code, resp.text)
        raise ValueError(f"Embedding API returned {resp.status_code}: {resp.text}")

    data = resp.json()
    sorted_items = sorted(data["data"], key=lambda x: x["index"])
    matrix = np.array([item["embedding"] for item in sorted_items], dtype=np.float32)

    # L2-normalise so inner-product == cosine similarity
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    matrix /= norms

    logger.info("Embedded %d texts, shape %s", len(texts), matrix.shape)
    return matrix
