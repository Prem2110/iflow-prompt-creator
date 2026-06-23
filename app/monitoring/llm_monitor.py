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

import httpx

logger = logging.getLogger(__name__)

# Env vars are read at call time (not import time) so that CF cf set-env changes
# take effect on restart without requiring a full redeploy.

def _cfg():
    """Return monitor config from environment, read fresh on every call."""
    return {
        "base_url":   os.environ.get("LLM_USAGE_MONITOR_BASE_URL", "").rstrip("/"),
        "app_id":     os.environ.get("LLM_USAGE_MONITOR_APP_ID", ""),
        "model_name": os.environ.get("LLM_USAGE_MONITOR_MODEL_NAME", ""),
        "api_key":    os.environ.get("LLM_USAGE_MONITOR_API_KEY", ""),
    }


def _post(call_type: str, payload: dict) -> None:
    """Synchronous POST — runs inside a daemon thread, never raises."""
    cfg = _cfg()
    if not cfg["base_url"]:
        logger.debug("LLM monitor: BASE_URL not set — skipping %s", call_type)
        return
    try:
        url = f"{cfg['base_url']}/log-metadata/"
        logger.info("LLM monitor → POST %s  call_type=%s  app_id=%s", url, call_type, cfg["app_id"])
        resp = httpx.post(
            url,
            params={
                "app_id":      cfg["app_id"],
                "call_type":   call_type,
                "model_name":  cfg["model_name"],
            },
            headers={"Authorization": f"Bearer {cfg['api_key']}"},
            json={"metadata": json.dumps(payload)},
            timeout=10,
            follow_redirects=True,
        )
        if not resp.is_success:
            logger.warning(
                "LLM monitor POST failed [%s %s]: %s",
                call_type, resp.status_code, resp.text[:500],
            )
        else:
            logger.info("LLM monitor POST ok [%s] status=%s", call_type, resp.status_code)
    except Exception as exc:
        logger.warning("LLM monitor POST error [%s]: %s", call_type, exc)


def _fire(call_type: str, payload: dict) -> None:
    """Spawn a daemon thread for the POST so the caller is never blocked."""
    if not os.environ.get("LLM_USAGE_MONITOR_BASE_URL", ""):
        return
    logger.info("LLM monitor: firing %s", call_type)
    t = threading.Thread(target=_post, args=(call_type, payload), daemon=True)
    t.start()


def probe() -> None:
    """
    Synchronous connectivity check — call once at startup to surface config
    problems early. Sends a minimal ping payload to the monitor.
    """
    cfg = _cfg()
    if not cfg["base_url"]:
        logger.warning("LLM monitor: disabled (LLM_USAGE_MONITOR_BASE_URL not set)")
        return
    logger.info("LLM monitor: probing %s/log-metadata/ …", cfg["base_url"])
    _post("probe", {"content": "startup-probe", "type": "ai", "model_name": cfg["model_name"],
                    "tool_calls": [], "invalid_tool_calls": [], "additional_kwargs": {},
                    "response_metadata": {}, "usage_metadata": {"input_tokens": 0,
                    "output_tokens": 0, "total_tokens": 0}})


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

    _default_model = os.environ.get("LLM_USAGE_MONITOR_MODEL_NAME", "")
    model_name = response_data.get("model", _default_model) or _default_model

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
        payload = _to_ai_message_dict(response_data)
    except Exception as exc:
        logger.warning("LLM monitor serialisation error: %s", exc)
        payload = {"raw": str(response_data)}
    _fire(os.environ.get("LLM_USAGE_MONITOR_CALL_TYPE_L_INVOKE", "l_invoke"), payload)


def log_agent_invoke(result) -> None:
    """
    Log an agent invocation (a_invoke).
    Pass the agent result object directly.
    Uses lc_dumps if langchain_core is available, otherwise json.dumps.
    """
    try:
        try:
            from langchain_core.load import dumps as lc_dumps
            import json as _json
            payload = _json.loads(lc_dumps(result))
        except (ImportError, Exception):
            payload = json.loads(json.dumps(result, default=str))
    except Exception as exc:
        logger.warning("LLM monitor agent serialisation error: %s", exc)
        payload = {"raw": str(result)}
    _fire(os.environ.get("LLM_USAGE_MONITOR_CALL_TYPE_A_INVOKE", "a_invoke"), payload)
