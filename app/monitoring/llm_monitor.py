"""
LLM usage monitor — fire-and-forget POST to the monitoring service.

Hooks:
  log_llm_invoke(response_data)  — call after every direct LLM HTTP call  (l_invoke)
  log_agent_invoke(result)       — call after every agent invocation       (a_invoke)

Both functions return immediately. The actual POST runs in a daemon thread so
it never delays the main request/streaming flow. Failures are logged as warnings,
never raised.

Required .env vars:
  LLM_USAGE_MONITOR_BASE_URL      — service base URL (skip silently if unset)
  LLM_USAGE_MONITOR_APP_ID        — app_id query param
  LLM_USAGE_MONITOR_MODEL_NAME    — model_name query param
  LLM_USAGE_MONITOR_API_KEY       — Bearer token
  LLM_USAGE_MONITOR_CALL_TYPE_L_INVOKE  — defaults to "l_invoke"
  LLM_USAGE_MONITOR_CALL_TYPE_A_INVOKE  — defaults to "a_invoke"
"""

import json
import logging
import os
import threading

logger = logging.getLogger(__name__)

# Read once at import time; module reloads pick up changes automatically on hot-reload.
_BASE_URL   = os.environ.get("LLM_USAGE_MONITOR_BASE_URL", "").rstrip("/")
_APP_ID     = os.environ.get("LLM_USAGE_MONITOR_APP_ID", "")
_MODEL_NAME = os.environ.get("LLM_USAGE_MONITOR_MODEL_NAME", "")
_API_KEY    = os.environ.get("LLM_USAGE_MONITOR_API_KEY", "")
_TYPE_L     = os.environ.get("LLM_USAGE_MONITOR_CALL_TYPE_L_INVOKE", "l_invoke")
_TYPE_A     = os.environ.get("LLM_USAGE_MONITOR_CALL_TYPE_A_INVOKE", "a_invoke")


def _post(call_type: str, metadata: str) -> None:
    """Synchronous POST — runs inside a daemon thread, never raises."""
    if not _BASE_URL:
        return
    try:
        import requests  # lazy import so startup isn't slowed if requests is absent
        url = f"{_BASE_URL}/log-metadata/"
        resp = requests.post(
            url,
            params={
                "app_id":      _APP_ID,
                "call_type":   call_type,
                "model_name":  _MODEL_NAME,
            },
            headers={"Authorization": f"Bearer {_API_KEY}"},
            json={"metadata": metadata},
            timeout=10,
        )
        if not resp.ok:
            logger.warning(
                "LLM monitor POST failed [%s %s]: %s",
                call_type, resp.status_code, resp.text[:300],
            )
        else:
            logger.debug("LLM monitor POST ok [%s] — %d bytes", call_type, len(metadata))
    except Exception as exc:
        logger.warning("LLM monitor POST error [%s]: %s", call_type, exc)


def _fire(call_type: str, metadata: str) -> None:
    """Spawn a daemon thread for the POST so the caller is never blocked."""
    if not _BASE_URL:
        return
    t = threading.Thread(target=_post, args=(call_type, metadata), daemon=True)
    t.start()


def _to_ai_message_dict(response_data: dict) -> dict:
    """
    Shape a raw SAP AI Core API response (or streaming summary dict) into the
    LangChain AIMessage.model_dump() structure that the monitor service validates.

    Required top-level fields the service checks:
      content, type, model_name, usage_metadata, response_metadata,
      additional_kwargs, tool_calls, invalid_tool_calls
    """
    # Normalise different shapes coming from streaming vs non-streaming
    usage = response_data.get("usage", {})
    input_tok  = usage.get("input_tokens",  0)
    output_tok = usage.get("output_tokens", 0)

    # Non-streaming response has content as a list of blocks
    raw_content = response_data.get("content", "")
    if isinstance(raw_content, list):
        content_str = " ".join(
            block.get("text", "") for block in raw_content if isinstance(block, dict)
        )
    else:
        content_str = str(raw_content)

    model_name = response_data.get("model", _MODEL_NAME) or _MODEL_NAME

    return {
        "content":           content_str,
        "type":              "ai",
        "model_name":        model_name,
        "id":                response_data.get("id", ""),
        "example":           False,
        "tool_calls":        [],
        "invalid_tool_calls": [],
        "additional_kwargs": {},
        "response_metadata": {
            "model_name":  model_name,
            "stop_reason": response_data.get("stop_reason", ""),
            "stream":      response_data.get("stream", False),
            "continuation_attempt": response_data.get("continuation_attempt", 0),
        },
        "usage_metadata": {
            "input_tokens":  input_tok,
            "output_tokens": output_tok,
            "total_tokens":  input_tok + output_tok,
        },
    }


def log_llm_invoke(response_data: dict) -> None:
    """
    Log a direct LLM call (l_invoke).
    Accepts the raw SAP AI Core API response dict and converts it to the
    LangChain AIMessage shape the monitor service expects.
    """
    try:
        shaped   = _to_ai_message_dict(response_data)
        metadata = json.dumps(shaped, default=str)
    except Exception as exc:
        logger.warning("LLM monitor serialisation error: %s", exc)
        metadata = str(response_data)
    _fire(_TYPE_L, metadata)


def log_agent_invoke(result) -> None:
    """
    Log an agent invocation (a_invoke).
    Pass the agent result object directly.
    Uses lc_dumps if langchain_core is available, otherwise json.dumps.
    """
    try:
        try:
            from langchain_core.load import dumps as lc_dumps
            metadata = lc_dumps(result)
        except ImportError:
            metadata = json.dumps(result, default=str)
    except Exception as exc:
        logger.warning("LLM monitor agent serialisation error: %s", exc)
        metadata = str(result)
    _fire(_TYPE_A, metadata)
