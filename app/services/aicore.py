import asyncio
import json
import logging
import os
import time

import httpx

logger = logging.getLogger(__name__)

_token_cache: dict = {"token": None, "expires_at": 0}
_token_lock = asyncio.Lock()

LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "120"))


async def _get_token() -> str:
    if _token_cache["token"] and time.time() < _token_cache["expires_at"] - 30:
        return _token_cache["token"]

    async with _token_lock:
        # Double-check after acquiring lock
        if _token_cache["token"] and time.time() < _token_cache["expires_at"] - 30:
            return _token_cache["token"]

        token_url = f"{os.environ['AICORE_AUTH_URL']}/oauth/token"
        logger.info("Fetching new SAP AI Core OAuth token")
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                token_url,
                data={"grant_type": "client_credentials"},
                auth=(os.environ["AICORE_CLIENT_ID"], os.environ["AICORE_CLIENT_SECRET"]),
            )
            resp.raise_for_status()
            data = resp.json()

        _token_cache["token"] = data["access_token"]
        _token_cache["expires_at"] = time.time() + data.get("expires_in", 1800)
        logger.info("Token acquired, expires in %ds", data.get("expires_in", 1800))
        return _token_cache["token"]


async def chat_complete(system: str, user_content, stream: bool = False):
    """
    Calls the Claude deployment on SAP AI Core using the Anthropic Messages API format.
    The endpoint is /invoke for non-streaming and /invoke with stream=true for streaming.

    user_content can be a plain string or a list of Anthropic content blocks.

    If stream=True, returns an async generator yielding text chunks (SSE data).
    If stream=False, returns the full response text.
    """
    token = await _get_token()
    base_url = os.environ["AICORE_BASE_URL"].rstrip("/")
    deployment_id = os.environ["LLM_DEPLOYMENT_ID"].strip()
    resource_group = os.environ.get("AICORE_RESOURCE_GROUP", "default")

    endpoint = "invoke-with-response-stream" if stream else "invoke"
    url = f"{base_url}/inference/deployments/{deployment_id}/{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "AI-Resource-Group": resource_group,
        "Content-Type": "application/json",
    }
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 4096,
        "system": system,
        "messages": [
            {"role": "user", "content": user_content},
        ],
    }

    logger.info("POST %s  resource-group=%s  stream=%s", url, resource_group, stream)

    if stream:
        return _stream_chat(url, headers, payload)

    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        resp = await client.post(url, json=payload, headers=headers)

    if not resp.is_success:
        logger.error("AI Core error %s: %s", resp.status_code, resp.text)
        raise ValueError(f"AI Core returned status {resp.status_code}")

    result = resp.json()["content"][0]["text"]
    logger.info("Response received (%d chars)", len(result))
    return result


async def _stream_chat(url: str, headers: dict, payload: dict):
    """Stream SSE responses from the AI Core /invoke endpoint."""
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if not resp.is_success:
                body = await resp.aread()
                logger.error("AI Core streaming error %s: %s", resp.status_code, body)
                raise ValueError(f"AI Core returned status {resp.status_code}")

            buffer = ""
            chars_streamed = 0
            async for chunk in resp.aiter_bytes():
                buffer += chunk.decode("utf-8", errors="replace")
                # Anthropic SSE format: data: {"type":"content_block_delta","delta":{"text":"..."}}
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line or not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        return
                    try:
                        event = json.loads(data_str)
                        if event.get("type") == "content_block_delta":
                            delta = event.get("delta", {})
                            text = delta.get("text", "")
                            if text:
                                chars_streamed += len(text)
                                yield text
                    except json.JSONDecodeError:
                        continue
            logger.info("Streaming complete: %d chars", chars_streamed)
