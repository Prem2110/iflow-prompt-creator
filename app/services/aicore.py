import logging
import os
import time

import httpx

logger = logging.getLogger(__name__)

_token_cache: dict = {"token": None, "expires_at": 0}


async def _get_token() -> str:
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


async def chat_complete(system: str, user_content) -> str:
    """
    Calls the Claude deployment on SAP AI Core using the Anthropic Messages API format.
    The endpoint is /invoke (not /chat/completions).
    user_content can be a plain string or a list of Anthropic content blocks.
    """
    token = await _get_token()
    base_url = os.environ["AICORE_BASE_URL"].rstrip("/")
    deployment_id = os.environ["LLM_DEPLOYMENT_ID"].strip()
    resource_group = os.environ.get("AICORE_RESOURCE_GROUP", "default")

    url = f"{base_url}/inference/deployments/{deployment_id}/invoke"
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

    logger.info("POST %s  resource-group=%s", url, resource_group)
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload, headers=headers)

    if not resp.is_success:
        logger.error("AI Core error %s: %s", resp.status_code, resp.text)
        raise ValueError(f"AI Core {resp.status_code}: {resp.text}")

    result = resp.json()["content"][0]["text"]
    logger.info("Response received (%d chars)", len(result))
    return result
