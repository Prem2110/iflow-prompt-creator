"""
SAP Business Accelerator Hub enrichment.

Extracts SAP product/system signals from document text, queries the Hub API
for matching Integration packages, and returns a compact reference block that
is injected into the LLM prompt context.
"""
import logging
import os
import re
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_HUB_BASE = "https://api.sap.com/odata/1.0/catalog.svc"
_HUB_TIMEOUT = 10

# Known SAP products and systems to look for in document text
_SAP_SIGNALS = [
    "SAP SuccessFactors", "SuccessFactors",
    "SAP S/4HANA", "S/4HANA", "S4HANA",
    "SAP ECC", "SAP ERP",
    "SAP Ariba", "Ariba",
    "SAP Concur", "Concur",
    "SAP Fieldglass", "Fieldglass",
    "SAP BTP", "SAP HANA",
    "SAP Commerce",
    "SAP IBP", "SAP APO",
    "SAP MDG", "Master Data Governance",
    "SAP Logistics Business Network",
    "SAP Business One",
    "SAP Business ByDesign",
    "SAP CPQ",
    "IFS Cloud", "IFS",
]

_SIGNAL_RE = re.compile(
    r'\b(' + '|'.join(re.escape(s) for s in _SAP_SIGNALS) + r')\b',
    re.IGNORECASE,
)


def _extract_signals(text: str) -> list[str]:
    """Return up to 5 unique SAP signals found in text, longest first (most specific)."""
    found: set[str] = set()
    for m in _SIGNAL_RE.finditer(text):
        raw = m.group(1)
        for signal in _SAP_SIGNALS:
            if signal.lower() == raw.lower():
                found.add(signal)
                break
    return sorted(found, key=len, reverse=True)[:5]


def _strip_html(html: str) -> str:
    text = re.sub(r'<[^>]+>', ' ', html or '')
    return re.sub(r'\s+', ' ', text).strip()


async def _query_packages(signal: str, api_key: str) -> list[dict]:
    """Query Hub for Integration packages whose DisplayName contains the signal."""
    # substringof works correctly when used alone; Category filter applied in Python
    filter_expr = f"substringof('{signal}',DisplayName)%20eq%20true"
    url = (
        f"{_HUB_BASE}/ContentPackages"
        f"?$filter={filter_expr}"
        f"&$top=8"
        f"&$select=TechnicalName,DisplayName,ShortText,Description,Products,Category"
        f"&$format=json"
    )
    try:
        async with httpx.AsyncClient(timeout=_HUB_TIMEOUT) as client:
            resp = await client.get(url, headers={"APIKey": api_key})
        if not resp.is_success:
            logger.warning("Hub API %d for signal '%s'", resp.status_code, signal)
            return []
        results = resp.json().get("d", {}).get("results", [])
        return [r for r in results if r.get("Category") == "Integration"]
    except Exception as exc:
        logger.warning("Hub query failed for '%s': %s", signal, exc)
        return []


def _format_reference(packages: list[dict], signals: list[str]) -> str:
    lines = [
        "=== SAP Business Accelerator Hub Reference ===",
        f"Relevant pre-built integration packages found for: {', '.join(signals)}",
        "Use these as reference patterns when generating the output:",
        "",
    ]
    for i, pkg in enumerate(packages, 1):
        name = pkg.get("DisplayName", "")
        body = pkg.get("ShortText") or _strip_html(pkg.get("Description", ""))
        products = pkg.get("Products", "") or ""
        lines.append(f"{i}. {name}")
        if body:
            lines.append(f"   {body[:220]}")
        if products:
            lines.append(f"   Products: {products}")
        lines.append("")
    lines.append("=== End SAP Business Accelerator Hub Reference ===")
    return "\n".join(lines)


async def enrich_from_hub(extracted_text: str) -> Optional[str]:
    """
    Main entry point. Extracts signals, queries the Hub, returns a reference
    block string ready to be prepended to the LLM user content.
    Returns None if the API key is not set or no relevant packages are found.
    """
    api_key = os.environ.get("SAP_HUB_API_KEY", "").strip()
    if not api_key:
        return None

    signals = _extract_signals(extracted_text)
    if not signals:
        logger.info("Hub: no SAP signals found in documents")
        return None

    logger.info("Hub: signals detected — %s", signals)

    seen: set[str] = set()
    packages: list[dict] = []

    for signal in signals:
        for pkg in await _query_packages(signal, api_key):
            tech = pkg.get("TechnicalName", "")
            if tech and tech not in seen:
                seen.add(tech)
                packages.append(pkg)

    if not packages:
        logger.info("Hub: no Integration packages found for %s", signals)
        return None

    packages = packages[:6]
    logger.info("Hub: injecting %d packages as reference context", len(packages))
    return _format_reference(packages, signals)
