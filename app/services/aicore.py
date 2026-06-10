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


def _make_url(endpoint: str) -> str:
    base_url = os.environ["AICORE_BASE_URL"].rstrip("/")
    deployment_id = os.environ["LLM_DEPLOYMENT_ID"].strip()
    return f"{base_url}/inference/deployments/{deployment_id}/{endpoint}"


def _make_headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "AI-Resource-Group": os.environ.get("AICORE_RESOURCE_GROUP", "default"),
        "Content-Type": "application/json",
    }


async def _stream_segment(url: str, headers: dict, payload: dict):
    """
    Streams one API call. Yields text strings for content, then one final
    dict {"stop_reason": str, "chars": int} to signal completion.
    """
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if not resp.is_success:
                body = await resp.aread()
                logger.error("AI Core streaming error %s: %s", resp.status_code, body)
                raise ValueError(f"AI Core returned status {resp.status_code}")

            buffer = ""
            chars = 0
            stop_reason = "end_turn"

            async for chunk in resp.aiter_bytes():
                buffer += chunk.decode("utf-8", errors="replace")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line or not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        break
                    try:
                        event = json.loads(data_str)
                        etype = event.get("type")
                        if etype == "content_block_delta":
                            text = event.get("delta", {}).get("text", "")
                            if text:
                                chars += len(text)
                                yield text
                        elif etype == "message_delta":
                            stop_reason = event.get("delta", {}).get("stop_reason") or stop_reason
                    except json.JSONDecodeError:
                        continue

    yield {"stop_reason": stop_reason, "chars": chars}


async def _stream_with_continuations(
    system: str,
    user_content,
    max_tokens: int,
    max_continuations: int,
):
    """
    Streams the LLM response, transparently continuing when stop_reason is
    'max_tokens'. Each continuation appends the previous assistant turn and
    asks the model to pick up exactly where it stopped.
    """
    messages = [{"role": "user", "content": user_content}]
    total_chars = 0

    for attempt in range(max_continuations + 1):
        token = await _get_token()
        url = _make_url("invoke-with-response-stream")
        headers = _make_headers(token)
        payload = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
        }

        resource_group = os.environ.get("AICORE_RESOURCE_GROUP", "default")
        logger.info("POST %s  resource-group=%s  attempt=%d", url, resource_group, attempt)

        segment_text = ""
        stop_reason = "end_turn"

        async for item in _stream_segment(url, headers, payload):
            if isinstance(item, dict):
                stop_reason = item["stop_reason"]
                total_chars += item["chars"]
            else:
                segment_text += item
                yield item

        if stop_reason != "max_tokens":
            logger.info("Streaming complete: %d chars total, stop_reason=%s", total_chars, stop_reason)
            break

        if attempt >= max_continuations:
            logger.warning(
                "Reached max_continuations=%d at %d chars — output may be incomplete",
                max_continuations, total_chars,
            )
            break

        logger.info(
            "stop_reason=max_tokens at %d chars — starting continuation %d/%d",
            total_chars, attempt + 1, max_continuations,
        )
        messages.append({"role": "assistant", "content": segment_text})
        messages.append({
            "role": "user",
            "content": (
                "Continue exactly from where you stopped. "
                "Do not repeat any text already written. "
                "Resume mid-sentence if needed."
            ),
        })


async def chat_complete(
    system: str,
    user_content,
    stream: bool = False,
    max_tokens: int = 4096,
    max_continuations: int = 0,
):
    """
    Calls the Claude deployment on SAP AI Core.

    stream=True  → returns an async generator yielding text chunks.
                   Set max_continuations > 0 to auto-continue on max_tokens.
    stream=False → returns the full response text as a string.
    """
    if stream:
        return _stream_with_continuations(system, user_content, max_tokens, max_continuations)

    # Non-streaming path
    token = await _get_token()
    url = _make_url("invoke")
    headers = _make_headers(token)
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user_content}],
    }

    resource_group = os.environ.get("AICORE_RESOURCE_GROUP", "default")
    logger.info("POST %s  resource-group=%s  stream=False", url, resource_group)

    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        resp = await client.post(url, json=payload, headers=headers)

    if not resp.is_success:
        logger.error("AI Core error %s: %s", resp.status_code, resp.text)
        raise ValueError(f"AI Core returned status {resp.status_code}")

    result = resp.json()["content"][0]["text"]
    logger.info("Response received (%d chars)", len(result))
    return result
