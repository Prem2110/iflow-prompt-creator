"""
Resolve SAP AI Core credentials from a BTP Destination at CF runtime.
"""

import json
import logging
import os
import httpx

logger = logging.getLogger(__name__)


def resolve_aicore_from_destination(destination_name: str | None) -> bool:
    if not destination_name:
        return False

    vcap_raw = os.getenv("VCAP_SERVICES")
    if not vcap_raw:
        logger.debug("VCAP_SERVICES not set — skipping destination resolver")
        return False

    try:
        vcap = json.loads(vcap_raw)
    except json.JSONDecodeError:
        logger.error("Failed to parse VCAP_SERVICES JSON")
        return False

    dest_services = vcap.get("destination", [])
    if not dest_services:
        logger.warning("destination-service not found in VCAP_SERVICES")
        return False

    svc_creds = dest_services[0]["credentials"]

    try:
        with httpx.Client(timeout=30) as client:
            token_resp = client.post(
                f"{svc_creds['url']}/oauth/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": svc_creds["clientid"],
                    "client_secret": svc_creds["clientsecret"],
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            token_resp.raise_for_status()
            bearer = token_resp.json()["access_token"]

            dest_resp = client.get(
                f"{svc_creds['uri']}/destination-configuration/v1/destinations/{destination_name}",
                headers={"Authorization": f"Bearer {bearer}"},
            )
            dest_resp.raise_for_status()
            dest_data = dest_resp.json()

    except httpx.HTTPStatusError as exc:
        logger.error("Destination HTTP error '%s': %s — %s",
            destination_name, exc.response.status_code, exc.response.text[:300])
        return False
    except Exception as exc:
        logger.error("Failed to fetch destination '%s': %s", destination_name, exc)
        return False

    cfg = dest_data.get("destinationConfiguration", {})

    base_url = cfg.get("URL", "").rstrip("/")
    if base_url and not base_url.endswith("/v2"):
        base_url += "/v2"

    client_id     = cfg.get("clientId", cfg.get("Client ID", ""))
    client_secret = cfg.get("clientSecret", cfg.get("Client Secret", ""))

    token_service_url = cfg.get("tokenServiceURL", cfg.get("TokenServiceURL", ""))
    auth_url = (
        token_service_url.removesuffix("/oauth/token")
        if token_service_url.endswith("/oauth/token")
        else token_service_url
    )

    if not all([base_url, client_id, client_secret, auth_url]):
        logger.error("Destination '%s' missing required fields — check BTP cockpit.",
            destination_name)
        return False

    os.environ["AICORE_BASE_URL"]      = base_url
    os.environ["AICORE_CLIENT_ID"]     = client_id
    os.environ["AICORE_CLIENT_SECRET"] = client_secret
    os.environ["AICORE_AUTH_URL"]      = auth_url

    logger.info("AI Core credentials resolved from destination '%s'", destination_name)
    return True
