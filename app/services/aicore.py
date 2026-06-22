import asyncio
import json
import logging
import os
import time

import httpx

from app.monitoring.llm_monitor import log_llm_invoke

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
    sentinel dict:
      {
        "stop_reason": str,
        "chars": int,
        "input_tokens": int,
        "output_tokens": int,
        "model": str,
      }
    Used by _stream_with_continuations to drive the monitor and continuation logic.
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
            input_tokens = 0
            output_tokens = 0
            model_id = ""

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

                        if etype == "message_start":
                            msg = event.get("message", {})
                            model_id = msg.get("model", "")
                            usage = msg.get("usage", {})
                            input_tokens = usage.get("input_tokens", 0)

                        elif etype == "content_block_delta":
                            text = event.get("delta", {}).get("text", "")
                            if text:
                                chars += len(text)
                                yield text

                        elif etype == "message_delta":
                            stop_reason = event.get("delta", {}).get("stop_reason") or stop_reason
                            output_tokens = event.get("usage", {}).get("output_tokens", 0)

                    except json.JSONDecodeError:
                        continue

    yield {
        "stop_reason":    stop_reason,
        "chars":          chars,
        "input_tokens":   input_tokens,
        "output_tokens":  output_tokens,
        "model":          model_id,
    }


async def _stream_with_continuations(
    system: str,
    user_content,
    max_tokens: int,
    max_continuations: int,
):
    """
    Streams the LLM response, transparently continuing when stop_reason is
    'max_tokens'. After each segment the monitor is called fire-and-forget.
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
        sentinel: dict = {}

        async for item in _stream_segment(url, headers, payload):
            if isinstance(item, dict):
                sentinel = item
            else:
                segment_text += item
                total_chars += len(item)
                yield item

        stop_reason   = sentinel.get("stop_reason", "end_turn")
        input_tokens  = sentinel.get("input_tokens", 0)
        output_tokens = sentinel.get("output_tokens", 0)
        model_id      = sentinel.get("model", os.environ.get("LLM_DEPLOYMENT_ID", ""))

        # ── Monitor: log this segment as an l_invoke ──────────────────────────
        log_llm_invoke({
            "role":    "assistant",
            "content": [{"type": "text", "text": segment_text}],
            "model":   model_id,
            "stop_reason": stop_reason,
            "usage":   {"input_tokens": input_tokens, "output_tokens": output_tokens},
            "stream":  True,
            "continuation_attempt": attempt,
        })

        if stop_reason != "max_tokens":
            logger.info(
                "Streaming complete: %d chars total, stop_reason=%s, tokens=%d+%d",
                total_chars, stop_reason, input_tokens, output_tokens,
            )
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

    # ── Non-streaming path ────────────────────────────────────────────────────
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

    response_data = resp.json()
    result = response_data["content"][0]["text"]
    logger.info("Response received (%d chars)", len(result))

    # ── Monitor: log the full API response ───────────────────────────────────
    log_llm_invoke({**response_data, "stream": False})

    return result


async def chat_complete_messages(
    system: str,
    messages: list[dict],
    stream: bool = False,
    max_tokens: int = 2048,
):
    """
    Like chat_complete but accepts a pre-built messages array for multi-turn chat.

    stream=True  → returns an async generator yielding text chunks.
    stream=False → returns the full response text as a string.
    """
    if stream:
        async def _gen():
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
            logger.info("chat_complete_messages POST %s  resource-group=%s  stream=True", url, resource_group)

            segment_text = ""
            model_id = ""
            input_tokens = 0
            output_tokens = 0
            stop_reason = "end_turn"

            async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    if not resp.is_success:
                        body = await resp.aread()
                        raise ValueError(f"AI Core returned {resp.status_code}: {body}")
                    buffer = ""
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
                                if etype == "message_start":
                                    msg = event.get("message", {})
                                    model_id = msg.get("model", "")
                                    input_tokens = msg.get("usage", {}).get("input_tokens", 0)
                                elif etype == "content_block_delta":
                                    text = event.get("delta", {}).get("text", "")
                                    if text:
                                        segment_text += text
                                        yield text
                                elif etype == "message_delta":
                                    stop_reason = event.get("delta", {}).get("stop_reason") or stop_reason
                                    output_tokens = event.get("usage", {}).get("output_tokens", 0)
                            except json.JSONDecodeError:
                                continue

            log_llm_invoke({
                "role":    "assistant",
                "content": [{"type": "text", "text": segment_text}],
                "model":   model_id,
                "stop_reason": stop_reason,
                "usage":   {"input_tokens": input_tokens, "output_tokens": output_tokens},
                "stream":  True,
            })

        return _gen()

    # ── Non-streaming path ────────────────────────────────────────────────────
    token = await _get_token()
    url = _make_url("invoke")
    headers = _make_headers(token)
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    }
    resource_group = os.environ.get("AICORE_RESOURCE_GROUP", "default")
    logger.info("chat_complete_messages POST %s  resource-group=%s  stream=False", url, resource_group)
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        resp = await client.post(url, json=payload, headers=headers)
    if not resp.is_success:
        logger.error("AI Core error %s: %s", resp.status_code, resp.text)
        raise ValueError(f"AI Core returned {resp.status_code}")
    return resp.json()["content"][0]["text"]
